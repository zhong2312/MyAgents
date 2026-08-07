# Windows 平台适配指南

## 概述

本文档总结了 MyAgents Windows 平台适配的关键技术点和最佳实践，包含路径处理、进程管理、环境变量、CSP 配置等方面的经验。

---

## 🗂️ 路径处理

### 跨平台路径工具

**核心原则**：
- 使用 Tauri `path` 插件获取系统目录
- 使用 Node.js `path.join()` 拼接路径（自动处理分隔符）
- 避免硬编码路径分隔符（`/` 或 `\`）

**示例**：
```typescript
import { join } from 'path';
import { homeDir, tempDir } from '@tauri-apps/api/path';

// ✅ 正确
const configPath = join(await homeDir(), '.myagents', 'config.json');
const tempPath = join(await tempDir(), 'myagents-cache');

// ❌ 错误
const configPath = `${homeDir}/.myagents/config.json`;  // Linux 路径
const tempPath = `${homeDir}\\.myagents\\config.json`;  // Windows 路径
```

### 环境变量

**跨平台环境变量**：
```typescript
// src/server/utils/platform.ts
export function getPlatformPaths() {
  const isWin = process.platform === 'win32';

  return {
    home: isWin
      ? (process.env.USERPROFILE || 'C:\\Users\\Default')
      : (process.env.HOME || '/home/user'),
    temp: isWin
      ? (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp')
      : (process.env.TMPDIR || '/tmp'),
  };
}
```

**常用环境变量对照**：

| 用途 | Windows | macOS/Linux |
|------|---------|-------------|
| 用户主目录 | `USERPROFILE` | `HOME` |
| 临时目录 | `TEMP` / `TMP` | `TMPDIR` |
| 应用数据 | `APPDATA` | `~/.config` |
| 路径分隔符 | `;` | `:` |

### SDK Shell 输出编码

Claude Agent SDK 的 Bash 工具输出最终会以 UTF-8 字符串进入 MyAgents session JSONL / SSE。Windows 上不少子进程会默认按系统 ANSI/OEM code page（如 CP936/GBK）写 stdout/stderr；一旦 SDK 按 UTF-8 解码成字符串，后续在 renderer 或 SessionStore 已无法可靠恢复原始字节。

`src/server/agent-session.ts::buildClaudeSessionEnv()` 因此在 Windows SDK subprocess env 中统一设置 `LANG=C.UTF-8`、`LC_ALL=C.UTF-8`、`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`LESSCHARSET=utf-8`。同时写入 MyAgents 管理的 `BASH_ENV` prelude；只要 SDK 使用 Git Bash（无论来自 `CLAUDE_CODE_GIT_BASH_PATH` 还是 PATH fallback），Bash 命令启动前都会执行 `chcp.com 65001`。PowerShell 会忽略 `BASH_ENV`。不要使用 `CLAUDE_CODE_SHELL_PREFIX` 注入 inline shell 片段：SDK 将它当作包装命令而不是 source prelude。也不要把这个逻辑挪到 tool_result 渲染或历史恢复层；那里拿到的已经是 SDK 字符串，不是可逆字节流。

---

## 🔧 进程管理

### Node.js 运行时路径

**Windows 查找顺序**（`src/server/utils/runtime.ts::getBundledNodePath()`）：
1. Bundled Node.js（`Contents\resources\nodejs\node.exe`，构建时从 nodejs.org 下载）
2. 用户系统 Node.js（通过 `getSystemNodeDirs()` 扫描 `Program Files\nodejs` / `%USERPROFILE%\AppData\Roaming\npm` 等）
3. 系统 PATH（`node.exe` / `npm.cmd` / `npx.cmd`）

**macOS / Linux 查找顺序**：
1. Bundled Node.js（`Contents/Resources/nodejs/bin/node`）
2. 系统 Node.js（`/opt/homebrew/bin/node` / `/usr/local/bin/node` / nvm / fnm / volta / asdf / mise）
3. 系统 PATH

**PATH 注入策略**：SDK 子进程（AI Bash 工具）实际看到的 PATH 优先**系统**，其次 bundled —— 用户自己维护的 Node 往往比我们 bundle 的版本新，npm 也更可靠（见 `buildClaudeSessionEnv`）。详见 `bundled_node.md`。

Task command Detector 不经过 SDK shell：bare `node` / `node.exe` 固定解析到 bundled Node.js v24，其他 bare executable 走 `system_binary::find()`；`executable + args + cwd` 分开传递，不经 `cmd /c` 或字符串重拼。Rust 进入进程边界前对绝对路径使用现有 external-path normalize，不能把 Windows verbatim/长路径前缀直接泄漏给 Node。

### 进程清理

进程清理分成两种不能互换的 authority：

1. **Live lifecycle**：Sidecar / Plugin Bridge 使用 `process_cmd::spawn_tree()` 创建。Windows child 先以 `CREATE_SUSPENDED` 创建，绑定配置了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，再恢复初始线程；owner 持有 `ChildTree`，stop / Drop 直接终止 Job 内所有后代。`CREATE_NO_WINDOW` child 没有可靠的 console signal，不能增加无实际作用的等待步骤。应用退出时的创建入口关闭与登记等待是跨平台规则，统一见 `pit_of_success.md` 的 `process_cmd` 小节。正常退出不得扫描全机 argv。
2. **Recovery**：只有 prior instance 已确定死亡后的启动恢复，以及 updater 的 residual / protected-root / file-lock 验证，才使用 `sysinfo` 枚举。它处理 crash 后已经没有 live handle 的遗留进程，不是正常 shutdown 的 fallback。

**Windows recovery**（`sysinfo` 原生枚举，避免旧 PowerShell/WMI 冷启动开销）：
```rust
// src-tauri/src/sidecar/cleanup.rs -> src-tauri/src/process_cleanup.rs
let report = crate::process_cleanup::kill_stale_processes(STARTUP_CLEANUP_PATTERNS);
```

**macOS/Linux**（同样走 `sysinfo` native process enumeration，不再 shell out 到 `pgrep`）：
```rust
// src-tauri/src/process_cleanup.rs
pub fn kill_stale_processes(patterns: &[ProcessPattern]) -> CleanupReport;
```

> **关键**：普通短生命周期子进程 spawn 仍 MUST 使用 `process_cmd::new()`（Windows CREATE_NO_WINDOW）；会创建后代的长生命周期进程 MUST 再用 `spawn_tree()`。外部 binary 解析继续走 `system_binary::find()`（PATH 补充）。禁止裸 `std::process::Command::new()`，也禁止把 stale cleanup 扩展到正常退出；recovery 扫描统一由 `process_cleanup::kill_stale_processes()` owner，调用方不要再写 ad-hoc PowerShell / `pgrep`。

Activation Trigger 的 Detector 也属于 Live lifecycle：每次 invocation 保留自己的 Job Object，timeout、stdout 超限、Task Stop/Delete 和 App shutdown 都终止同一棵树；不能只 kill 根 PID。harness 先 `env_clear()`，再恢复 Windows system/home/temp、证书、通用代理、增强 PATH 与 `LANG/LC_ALL/PYTHONUTF8/PYTHONIOENCODING` 规范 baseline，不继承 Provider credential 或 `MYAGENTS_*` 端口。它以 UTF-8 JSON 写 stdin，并把 stdout 当严格 UTF-8 协议解析；任意仍输出本地代码页字节的脚本会得到可诊断的 protocol failure，而不是静默替换字符或激活 AI。

---

## 🌐 CSP 配置

### Windows Tauri IPC 特殊要求

**关键点**：
- Windows Tauri v2 使用 `http://ipc.localhost` 协议
- IPC 调用使用 **Fetch API**
- `default-src` 和 `connect-src` 都必须包含 `http://ipc.localhost`
- `connect-src` 是管 fetch / XHR / WebSocket 的**标准** CSP 指令——IPC 的 Fetch 由它放行。
  曾配过的 `fetch-src` 是**非标准**指令，WebKit 与 WebView2（Chromium）都不认、直接忽略（只在 console 报 `Unrecognized Content-Security-Policy directive 'fetch-src'`），已移除。

**正确配置**：
```json
{
  "app": {
    "security": {
      "csp": "default-src 'self' ipc: tauri: asset: http://ipc.localhost; connect-src 'self' ipc: tauri: asset: http://ipc.localhost http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https://download.myagents.io; ..."
    }
  }
}
```

**常见错误**：
```
❌ connect-src 缺少 http://ipc.localhost（IPC Fetch 被 CSP 拦截）
❌ 误以为要用 fetch-src（非标准、引擎忽略；真正生效的是 connect-src）
```

**详见**：[build_troubleshooting.md#CSP配置错误](../guides/build_troubleshooting.md#csp-配置错误)

---

## 🔌 代理配置

### localhost 排除

**问题**：
- reqwest 默认使用系统代理
- Windows 系统代理（如 Clash）未正确处理 localhost 排除
- 导致 localhost 请求失败

**解决方案**：

所有 localhost 请求强制禁用代理：
```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 禁用所有代理（包括系统代理）
    .build()?;
```

外部请求使用应用内代理配置：
```rust
use crate::proxy_config;

let builder = reqwest::Client::builder()
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

**详见**：[proxy_config.md](../tech_docs/proxy_config.md)

---

## 📦 构建脚本

### 关键清理步骤

**必须清理的目录**：
1. `dist/` - 前端构建产物
2. `src-tauri/target/{arch}/{profile}/bundle/` - Tauri 安装包
3. `src-tauri/target/{arch}/{profile}/resources/` - **缓存的配置文件**（最容易被忽略）

**resources 目录的重要性**：
- Tauri 在此目录缓存 `tauri.conf.json` 等配置文件
- 如果不清理，配置更新后构建仍使用旧缓存
- 导致 CSP 等配置修改不生效

**正确的清理脚本**（`build_windows.ps1` 发布构建）：
```powershell
# 杀死残留 MyAgents 进程
Get-Process | Where-Object { $_.ProcessName -eq "MyAgents" } | Stop-Process -Force

# 清理构建产物
Remove-Item dist -Recurse -Force
Remove-Item src-tauri\target\x86_64-pc-windows-msvc\release\bundle -Recurse -Force

# CRITICAL: 清理 resources 缓存
Remove-Item src-tauri\target\x86_64-pc-windows-msvc\release\resources -Recurse -Force
```

**快速 debug 构建**：

```powershell
.\build_dev_win.ps1
```

默认只生成 `src-tauri\target\x86_64-pc-windows-msvc\debug\myagents.exe`，不打 NSIS，便于 Windows 真机快速验证功能。脚本仍会清理 `debug\resources`，避免 Tauri 复用旧配置；需要验证安装器时使用：

```powershell
.\build_dev_win.ps1 -BundleNsis
```

**详见**：[build_troubleshooting.md](../guides/build_troubleshooting.md)

---

## 🚀 发布流程

### Windows 发布检查清单

**构建前**：
- [ ] 版本号同步（`package.json`, `tauri.conf.json`, `Cargo.toml`）
- [ ] TypeScript 类型检查通过
- [ ] `.env` 文件包含 `TAURI_SIGNING_PRIVATE_KEY`
- [ ] Rust 工具链已安装目标 `x86_64-pc-windows-msvc`

**构建**：
```powershell
.\build_windows.ps1
```

**产物验证**：
- [ ] NSIS 安装包（~150MB）
- [ ] 便携版 ZIP（~150MB）
- [ ] Updater 签名文件（`.sig`）

**发布**：
```powershell
.\publish_windows.ps1
```

**发布验证**：
- [ ] R2 上传成功（NSIS, ZIP, SIG）
- [ ] `latest_win.json` 生成正确
- [ ] 版本号、下载链接、签名正确

**详见**：[windows_build_guide.md](../guides/windows_build_guide.md)

---

## Pit-of-Success 进程管理模块

### process_cmd (`src-tauri/src/process_cmd.rs`)

所有 Rust 层子进程 MUST 通过 `crate::process_cmd::new()` 创建，以统一应用 Windows `CREATE_NO_WINDOW`。会派生后代的长生命周期进程还 MUST 使用 `crate::process_cmd::spawn_tree()` 并保留返回的 `ChildTree`。完整跨平台不变量、例外和禁止项只在 [`pit_of_success.md`](pit_of_success.md#process_cmd) 维护，本节只记录 Windows 的 Job Object 行为。

### system_binary (`src-tauri/src/system_binary.rs`)

Tauri GUI 应用从 Finder/Explorer 启动时不继承 shell PATH（无 homebrew、无用户 PATH）。`system_binary::find(binary_name)` 自动补充常见路径（`/opt/homebrew/bin`、`/usr/local/bin`、`C:\Program Files\nodejs` 等），确保系统工具（npm、git、node、systemd-inhibit 等）可被发现。

### `cmd_fsync_path` Windows-specific quirks (`src-tauri/src/config_io.rs`)

跨平台 fsync 在 Windows 上有两类需要专门处理的失败：

1. **`FlushFileBuffers` 要求 `GENERIC_WRITE`**：Unix 下 `fsync(2)` 接受只读 fd，但 Windows 的等价 API 要求写权限，否则 `os error 5 (拒绝访问)`。`opts_for_fsync()` 在 Windows 上加 `.write(true)`，Unix 上保持只读以避免不必要的写权限请求。
2. **AV / search-indexer transient share violation**：Defender 实时扫描、OneDrive 同步、Backblaze 索引器在我们刚写完文件之后会瞬间用 `FILE_SHARE_NONE` 打开它，让我们的后续打开返回 `ERROR_SHARING_VIOLATION (32)` 或偶发的 `ERROR_ACCESS_DENIED (5)`。失败窗口是 ms 级，配置 25/50/100ms 退避循环（4 次尝试），透明跳过这段。

`fsync_parent_dir` 在 Windows 上是 no-op：`FlushFileBuffers` 对目录句柄是 documented no-op，且需要 `FILE_FLAG_BACKUP_SEMANTICS` 才能拿到目录句柄。NTFS 自身的 journaling 提供等价的 crash-consistency 保证。

## Plugin 安装 Fallback 链

三级 fallback 确保社区插件安装成功：

```
1. 系统 npm（system_binary::find("npm")）
   └─ 失败 →
2. 内置 npm（bundled Node.js + npm-cli.js）
   └─ NODE_OPTIONS=--no-experimental-require-module（Windows Node.js v24 CJS/ESM 修复）
```

生产构建与 setup 脚本统一依赖 bundled Node.js + npm。

安装后流程：
1. `npm install` → 安装插件及其依赖
2. **依赖修复**：`npm install --ignore-scripts --omit=peer`
3. **SDK Shim 安装**（最后一步，last-write-wins）：覆盖 `node_modules/openclaw/` 为自定义 shim
4. **Bridge 启动前 shim 完整性检查**：解析 `package.json` version 字段，检测损坏自动修复

---

## ⚠️ Windows 依赖项

### Git for Windows（必需）

**为什么需要**：Claude Agent SDK 在 Windows 上需要 Git Bash 来执行 shell 命令。

**自动安装**：NSIS 安装程序内置 Git for Windows，自动检测并安装（无需网络）。

**构建要求**：构建前需将 Git 安装包放置在 `src-tauri/nsis/Git-Installer.exe`

**手动安装**：https://git-scm.com/downloads/win

**环境变量**：若 Git 已安装但不在 PATH 中，可设置：
```powershell
$env:CLAUDE_CODE_GIT_BASH_PATH="C:\Program Files\Git\bin\bash.exe"
```

### 排查 `exit code 1` 错误

1. **检查日志**：查找 `[sdk-stderr]` 输出
2. **常见原因**：`requires git-bash` 表示缺少 Git
3. **解决方案**：安装 Git for Windows 或设置 `CLAUDE_CODE_GIT_BASH_PATH`

**详见**：[bundled_node.md](../tech_docs/bundled_node.md) 中的 Windows Git 依赖说明

---

## 📚 相关文档

- [Windows 构建指南](../guides/windows_build_guide.md)
- [构建问题排查](../guides/build_troubleshooting.md)
- [代理配置](../tech_docs/proxy_config.md)
- [自动更新](../tech_docs/auto_update.md)
