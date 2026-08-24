# Bundled Node.js 运行时架构

> v0.2.0 之前是 Bun — `bundled_bun.md`（已并入此文）。Bun 迁移到 Node.js v24 的决策与链路见 `specs/prd/prd_0.2.0_node_runtime_migration.md`（gitignore，本地文件）。

## 概述

MyAgents 将 Node.js v24 运行时打包到应用内，实现**单一 runtime、零外部依赖**分发。用户无需安装 Node.js 即可运行所有功能（Sidecar、Plugin Bridge、MCP Server、社区 npm 包、`myagents` CLI）。

## 二进制获取方式

Node.js v24 官方二进制通过 `scripts/download_nodejs.sh` / `.ps1` 从 nodejs.org 下载：

```bash
./setup.sh  # 首次 clone 自动调用；build_dev.sh / build_macos.sh / build_windows.ps1 / build_linux.sh 也会幂等调用
```

- **版本变量**：`NODE_VERSION` 在 `scripts/download_nodejs.sh` 顶部定义
- **打包位置**：`src-tauri/resources/nodejs/`（Tauri staging 目录，已加入 `.gitignore`）
- **缓存位置**：`src-tauri/resources/nodejs-cache/<platform>-<arch>-v<version>/`（按平台 / 架构 / 版本隔离，已加入 `.gitignore`）
- **ABI 保护**：脚本先检查对应架构缓存；`resources/nodejs/` 只在构建某个 target 前从缓存同步。`build_dev.sh` 启动时用 `file(1)` 验证 binary 架构匹配 host，避免 macOS 双架构 release 构建后留下 x64 staging 影响 arm64 dev 构建

### 支持的平台

| 平台 | Node.js 二进制路径（打包后） |
|---|---|
| macOS ARM (M1/M2/...) | `MyAgents.app/Contents/Resources/nodejs/bin/node` |
| macOS Intel | 同上（区分 triple 由 DMG target 决定） |
| Windows x86_64 | `resources\nodejs\node.exe` |
| Linux x86_64 (glibc) | AppImage / deb 里的 `resources/nodejs/bin/node` |

### Claude Agent SDK native binary（独立进程，非我们的 Node）

SDK 自 0.2.113+ 以 `bun build --compile` 的 native binary 形式分发（SDK team 内嵌 Bun runtime，约 213 MB）。我们不共享 SDK 子进程的 Bun runtime 或 MyAgents Node 进程内状态，只通过 stdio NDJSON 通信。例外是 Claude Code 自己的外部状态：builtin `anthropic-sub` 会按 native 默认规则读取本机官方 OAuth credential store（macOS Keychain / `~/.claude/.credentials.json`），MyAgents 不通过 `CLAUDE_CONFIG_DIR` 改写这套位置，也不接管 OAuth token 生命周期。

| 文件 | 平台 | 来源 |
|---|---|---|
| `resources/claude-agent-sdk/claude` | macOS / Linux | `@anthropic-ai/claude-agent-sdk-<triple>/claude` |
| `resources/claude-agent-sdk/claude.exe` | Windows | 同上 |

构建脚本按 `per-target` loop 从 `node_modules/@anthropic-ai/claude-agent-sdk-<triple>/` 拷贝并 codesign（macOS）。

### SDK native child 确定性启动拒绝

`EPERM`、`EACCES`、`ENOEXEC` 表示操作系统在 executable launch 边界拒绝 SDK native child；它们不同于 Provider、网络或模型错误。所有生产 builtin `query()` 必须经 `src/server/utils/sdk-child-launch-guard.ts::createGuardedSdkQuery()`：

- Tauri `runtime_launch_guard.rs` 按 executable canonical path + metadata hash 持有应用级 circuit；一个 Sidecar 的拒绝对所有 Global / Session Sidecar 生效，external runtime 不进入该 circuit。
- 首次拒绝后每分钟最多放行一个 half-open probe。probe 是 Rust-owned lease，即使 Sidecar 退出或 settlement 丢失也会自动到期。
- admission epoch 随 settlement 返回；旧 `ready` 不得清除更新的 failure epoch。只有 `initializationResult()` 成功才算 control plane ready。
- executable identity 在应用更新/重装后变化，旧 circuit 自动失效。普通 Provider / network failure 只释放本次 admission，不打开 circuit。
- circuit 是 best-effort 重试保护，不拥有 SDK 启动权。只有 Rust 显式返回携带 `EPERM` / `EACCES` / `ENOEXEC` 的 circuit denial 才能阻止本次启动；Sidecar identity 缺失/过期、Management transport 异常或响应畸形都必须跳过 circuit 并继续调用 SDK。Session 业务 ID 重绑时保留进程出生时注入的不可变 management identity。
- Desktop 与 IM 显示可操作的更新/重装提示；内部 epoch/circuit 标记不得泄漏到用户错误文本。

## 应用结构

```
MyAgents.app/
└── Contents/
    ├── MacOS/
    │   └── app                        # Rust 主程序
    └── Resources/
        ├── nodejs/bin/node            # 内置 Node.js v24 (mac/linux)
        ├── nodejs/bin/npm             # bundled npm
        ├── nodejs/bin/npx             # bundled npx
        ├── server-dist.js             # Sidecar 打包产物（esbuild bundle）
        ├── plugin-bridge-dist.mjs     # Plugin Bridge 打包产物
        ├── plugin-bridge-sdk-shim/    # OpenClaw SDK shim（ESM, v2026.4.24+）
        ├── claude-agent-sdk/          # SDK native binary（独立运行时）
        └── cli/myagents.cjs           # myagents CLI（esbuild CommonJS bundle）

~/.myagents/bin/{myagents,myagents.cmd} 只是一对由 Rust 生成的薄启动器：它们回到当前
MyAgents executable，再由 `src-tauri/src/cli.rs` 同时定位上面的 bundled Node 与 CLI bundle。
HOME 不保存 CLI 业务脚本，也不使用系统 Node fallback；bundle 资源缺失会在 Sidecar
admission 前 fail closed。

```

## 运行时路径工具 (`src/server/utils/runtime.ts`)

统一的运行时路径检测工具，确保所有功能都能使用内置 Node.js，无需外部依赖。

### 核心函数

```typescript
// 运行时脚本目录（运行时计算，避开 esbuild 编译时硬编码）
getScriptDir(): string

// bundled Node.js 二进制（resources/nodejs/bin/node[.exe]）
getBundledNodePath(): string | null
getBundledNodeDir(): string | null   // 含 node / npm / npx 的目录

// 包管理器 — 一律返回 npm
getPackageManagerPath(): { command, installArgs, type: 'npm' }

// 系统 Node.js 目录（用户安装的 node/npm，优先级高于 bundled）
getSystemNodeDirs(): string[]
```

### PATH 注入（`buildClaudeSessionEnv`）

SDK 子进程（AI Bash 工具）看到的 PATH 优先级：
1. `~/.myagents/bin`（官方 `myagents` launcher + Tool Registry shims）
2. 用户系统安装的 Node.js 目录（`getSystemNodeDirs()`）—— 用户自己维护，npm 更可靠
3. bundled Node.js 目录（`resources/nodejs/bin`）—— fallback
4. `~/.myagents/npm-global/bin`（MyAgents-localized npm installs / legacy AI-installed CLIs）
5. 系统 PATH

规则：产品保留的 `myagents` 必须先命中官方 launcher；Node 的内部选择策略仍是**系统优先，bundled 兜底**，需要确定 bundled Node 的 MyAgents 自身入口继续使用绝对 locator，不靠 PATH。也就是说，CLI shadow 修复不改变系统 Node / bundled Node 的相对策略。

注意：SDK shell env **不设置** `npm_config_prefix` / `NPM_CONFIG_PREFIX` / `PREFIX`。
nvm 会在 shell 初始化时检测这些变量并输出兼容性警告。需要固定 npm 全局安装落点的
skill 必须用命令级 env（例如 `npm_config_prefix="$MYAGENTS_NPM_GLOBAL_PREFIX" npm install -g ...`）。

### Task command Detector

Activation Trigger 的 command Detector 是 Rust Task harness 启动的受管子进程，不是 SDK Bash。为保证 AI 生成的 JavaScript 感知器零外部依赖，Detector 的 bare `node` / `node.exe` **固定**解析到 MyAgents bundled Node.js v24；这与上面 AI shell 的“系统优先、bundled 兜底”是两个不同入口。其他 bare executable 走 `system_binary::find()`，绝对路径直接校验；结构化 args 原样传递，不经 shell 拼接。

Detector 在 `env_clear()` 后只恢复本地命令所需的 OS home/user/temp/system 基线、证书、通用代理变量和增强后的 `PATH`，并固定设置 UTF-8 locale、`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`。它不继承 Provider API key、Session credential、`MYAGENTS_*` 控制端口或任意启动 shell 变量；需要业务 credential 的脚本必须自己从明确的外部安全来源读取，不能依赖 MyAgents 进程环境的偶然泄漏。

## MCP / 社区 npm 包的执行

### 外部 stdio MCP（用户装 `@notionhq/notion-mcp-server` 等）

`utils/mcp-command.ts::resolveNpxMcpInvocation()` 是 npx MCP 启动命令的唯一解释器，由 builtin Claude、managed Codex 和 MCP enable warmup 共用：
- `command: 'npx'` → 解析为 **系统 npx** → bundled npx → runtime sibling npx（fallback），始终补 `-y`；macOS/Linux 输出绝对 npx 路径，Windows 输出同一完整 Node distribution 的绝对 `node.exe`，并把绝对 `node_modules/npm/bin/npx-cli.js` 放在 argv 首位，禁止把 `.cmd` shim 交给 Codex 原生 spawn
- MyAgents-owned preset 使用 `shared/mcpPackages.ts` 的精确 package spec；旧配置里的已知 `@latest` 在 runtime boundary 归一化，避免每次进程启动重新查询 registry
- `mcpServerArgs[id]` 只存用户附加参数，必须追加到 preset/package 基础参数之后，不能替换整段 argv
- 通过 `process_cmd::new()` spawn（Windows 自动 `CREATE_NO_WINDOW`）
- 环境变量通过 `proxy_config::apply_to_subprocess` 注入 `NO_PROXY` 保护 localhost

### 内置 in-process MCP（懒加载）

当前 user-toggleable `gemini-image` / `edge-tts` 通过 `src/server/tools/builtin-mcp-meta.ts` 的 META 登记 + `createXxxServer()` 工厂懒加载，**不在** Sidecar 冷启动时创建；历史 `cron-tools` / `im-cron` / `im-media` 已迁移到 `myagents` CLI。runtime-dynamic `im-bridge-tools` 由独立的 context-injected surface owner 懒初始化，不进入 META registry。见 `pit_of_success.md §Builtin MCP 懒加载架构`。

## 生产构建流程

`build_macos.sh` / `build_windows.ps1` / `build_linux.sh` 自动执行：

1. **TypeScript 类型检查**：`npm run typecheck`
2. **服务端打包**：esbuild bundle `src/server/index.ts` → `server-dist.js`
3. **Plugin Bridge 打包**：esbuild bundle `src/server/plugin-bridge/index.ts` → `plugin-bridge-dist.mjs`
4. **CLI 打包**：esbuild bundle `src/cli/myagents.ts` → `resources/cli/myagents.cjs`；扩展名固定 CommonJS 语义，不受安装目录上层 `package.json` 影响
5. **SDK native binary**：按 target triple 拷贝 + codesign
6. **Tauri 构建**：`npm run tauri:build -- --target <triple>`

`src-tauri/resources/` 是当前构建的 staging，不是跨构建缓存。构建脚本必须在
Tauri 读取前完整替换自己负责的目录：macOS release 在每个 target loop 内分别
生成 Node、Sharp、TSX 和 Claude 资源，其中 Sharp / Claude 的 Mach-O 会显式
校验为目标架构；
`build_dev.sh` 则清空 production-only 的 Sharp / TSX，仅留下 bundler 占位符，
同时按 host 架构重新生成 Node 与 Claude。目录存在或 `.dev-placeholder` 都不能
代表目录内容属于当前构建。

v0.2.0 之前这些步骤用 `bun build` + `bun install` — 完全切到 Node.js 生态后，lockfile 从 `bun.lock` 迁到 `package-lock.json`。

## 运行时检测

### Rust 侧 (`sidecar/spawn.rs` / `sidecar/session_lifecycle.rs` / `im/bridge.rs`)

`sidecar.rs` 是 facade；Node 定位与路径 normalize 在 `src-tauri/src/sidecar/spawn.rs`，session/global sidecar spawn owner 在 `sidecar/session_lifecycle.rs` / `sidecar/instances.rs`，Plugin Bridge spawn 在 `src-tauri/src/im/bridge.rs`。这些路径按 platform triple 定位 bundled Node.js；spawn `.ts` 脚本时自动注入 `--import tsx/esm`。

详见 `specs/ARCHITECTURE.md §Node.js v24 打包策略`。

### TypeScript 侧 (`runtime.ts`)

`getBundledNodePath()` + `getScriptDir()` 组合：
- 生产：`.../Contents/Resources/nodejs/bin/node`
- 开发：`<project>/src-tauri/resources/nodejs/bin/node`

## 调试

**开发模式**：
```bash
./build_dev.sh                 # 构建 debug app（带 DevTools）
./start_dev.sh                 # 浏览器 + 本地 Node Sidecar
```

**统一日志标签**：
- `[NODE]` / `[node-out]` / `[node-err]` — Node.js Sidecar 输出（v0.2.0 后）
- 历史上 `[bun-out]` / `[bun-err]` 标签在少量 Rust 日志宏里保留（向后兼容），新日志统一 `[NODE]`

## 常见问题

| 问题 | 原因 | 解决方案 |
|---|---|---|
| `ERR_DLOPEN_FAILED` (better-sqlite3) | native addon 按不同 Node ABI 编译 | `setup.sh` / `build_dev.sh` 用 bundled Node 的 PATH 跑 `npm rebuild`（已自动做） |
| Sidecar 立即退出 (exit code 1) | 依赖解析失败 | 检查 `server-dist.js` 打包是否成功 |
| 120s 超时 | health check 失败 | 查看 `[NODE]` 日志定位根因 |
| MCP 安装失败 | 包管理器未找到 | 确认 `getPackageManagerPath()` 返回 npm（固定 npm） |
| `Claude Code process exited with code 1` (Windows) | 缺少 Git for Windows | NSIS 安装程序内置 Git；或设 `CLAUDE_CODE_GIT_BASH_PATH` 环境变量 |
| `Claude Code process exited with code 3221226505` / `0xC0000409` (Windows) | SDK 自带 `claude.exe` 是 native binary；可能受系统组件、DLL 环境或上游 binary 兼容性影响 | 提示 `Claude Agent SDK 启动失败（exit code ...），请检查运行环境。` |
| npm v11.9.0 minizlib CJS bug (Windows) | bundled npm 与 Windows 某些文件锁冲突 | `setup_windows.ps1` / `build_windows.ps1` 自动升级到 latest npm |

### Windows Git 依赖说明

Claude Agent SDK 在 Windows 上需要 Git Bash 执行 shell 命令。

- **自动安装**：NSIS 安装程序内置 Git for Windows 2.52.0
- **手动安装**：https://git-scm.com/downloads/win
- **环境变量**：`CLAUDE_CODE_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe`
- **构建**：Git 安装包需放置在 `src-tauri/nsis/Git-Installer.exe`

## 注意事项

1. **开发者首次 clone** → 运行 `./setup.sh`（自动下载 Node.js + `npm install` + `npm rebuild` 本机 native addons）
2. **最终用户** → 零依赖（Node.js v24 已内置）
3. **CI/CD** → 构建前运行 `setup.sh`，或缓存 `src-tauri/resources/nodejs-cache/`；`src-tauri/resources/nodejs/` 只是当前 target 的 staging 目录
4. **生产构建** → 必须 `./build_macos.sh` / `./build_windows.ps1` / `./build_linux.sh`，裸 `cargo tauri build` 会漏掉 esbuild 步骤（但 `tauri.conf.json::beforeBuildCommand` 已兜底链上 `npm run build:server && build:bridge && build:cli`）
5. **MCP 功能** → 完全使用内置 Node.js 生态，用户无需安装任何依赖
