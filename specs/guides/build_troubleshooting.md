# 构建问题排查指南

## 目录

1. [Windows 构建脚本常见问题](#windows-构建脚本常见问题)
2. [macOS Claude SDK native binary 签名失败](#macos-claude-sdk-native-binary-签名失败)
3. [macOS dev 构建后 SDK spawn -88 / app 体积异常变小](#macos-dev-构建后-sdk-spawn--88--app-体积异常变小)
4. [macOS esbuild native binary 架构不匹配](#macos-esbuild-native-binary-架构不匹配)
5. [CSP 配置错误](#csp-配置错误)
6. [Rust toolchain / rustfmt 漂移](#rust-toolchain--rustfmt-漂移)
7. [Resources 缓存问题](#resources-缓存问题)
8. [代理配置问题](#代理配置问题)

---

## Windows 构建脚本常见问题

### 问题：构建后 CSP 错误仍然存在

**症状**：
```
Fetch API cannot load http://ipc.localhost/plugin...
Refused to connect because it violates the document's Content Security Policy
```

**根本原因**：

早期构建脚本存在两个严重 BUG（修复后保留为已知陷阱说明）：

#### Bug 1: 缺少 resources 目录清理

**问题**：
- 构建脚本只清理了 `bundle` 目录
- 未清理 `src-tauri/target/{arch}/{profile}/resources` 目录
- Tauri 在 resources 目录缓存了 `tauri.conf.json` 等配置文件
- 即使源文件更新，构建仍使用旧缓存

**修复**（commit a23cdf3）：
```powershell
# 清理 resources 目录确保配置重新读取
$resourcesDir = "src-tauri\target\x86_64-pc-windows-msvc\release\resources"
if (Test-Path $resourcesDir) {
    Remove-Item $resourcesDir -Recurse -Force
}
```

#### Bug 2: 错误的 CSP 覆盖

**问题**：
- `build_windows.ps1` 第 153 行强制覆盖 CSP 为旧版本
- 覆盖的 CSP 缺少关键指令：
  - ❌ `asset:` 协议
  - ❌ `http://ipc.localhost` （Windows Tauri IPC 必需，由 `connect-src` 放行）
  - ❌ `https://download.myagents.io`

**修复**（commit a23cdf3）：
- 移除错误的 CSP 覆盖逻辑
- 改为验证 CSP 配置完整性
- 检查关键部分，如果缺失则警告用户

**验证方法**：

```powershell
# 检查构建脚本版本
git log --oneline build_windows.ps1 | head -1
# 应显示 a23cdf3 或更新的 commit

# 清理构建
Remove-Item src-tauri\target\x86_64-pc-windows-msvc\release -Recurse -Force

# 重新构建
.\build_windows.ps1
```

---

## macOS Claude SDK native binary 签名失败

### 问题：x86_64 阶段 `claude` 报 `main executable failed strict validation`

**症状**：

```
━━━ 构建目标: x86_64-apple-darwin ━━━
  拷贝 Claude native binary (darwin-x64)...
src-tauri/resources/claude-agent-sdk/claude: main executable failed strict validation
    ✗ claude 签名失败
```

**根本原因**：

`build_macos.sh` 会按 target 从
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-{arm64,x64}/claude`
拷贝 SDK native binary。早期脚本只检查 `claude` 文件是否存在；如果某次
跨架构 npm 安装被中断或留下半截目录，后续构建会复用坏文件。

典型坏状态：

```bash
ls -lh node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude
# 只有十几 MB；正常约 215 MB

ls node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/package.json
# 不存在

otool -l node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude | grep "past end of file"
# load command 指向文件末尾之后
```

这种半截 Mach-O 仍可能通过 `file` / `lipo` 的架构判断，但 `codesign`
会在严格校验阶段失败。

**修复**：

当前 `build_macos.sh` 已在构建前校验本次 target 需要的 darwin SDK 包
（Both 模式会校验 arm64 + x64）：

- `package.json` 存在，且 package name / version 符合 `package.json` 的 pin
- `claude` Mach-O 架构匹配目标
- `otool -l` 没有 `(past end of file)`

发现损坏后会自动删除对应目录，并用 `npm install --force --no-save ...`
重新安装目标架构包。`--force` 是必要的：npm 10+ direct install
非 host CPU 的 platform package 时，即使带 `--os=darwin --cpu=x64`，
仍会按 host CPU 抛 `EBADPLATFORM`。

手动修复旧 checkout：

```bash
SDK_VERSION=$(node -p "require('./package.json').optionalDependencies['@anthropic-ai/claude-agent-sdk-darwin-x64']")
rm -rf node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64
npm install --force --no-save --no-audit --no-fund --ignore-scripts \
  --os=darwin --cpu=x64 \
  @anthropic-ai/claude-agent-sdk-darwin-x64@"$SDK_VERSION"
```

版本号必须与项目 `package.json` 中的 optional dependency 保持一致。

---

## macOS dev 构建后 SDK spawn -88 / app 体积异常变小

**症状**：

```text
[sdk] Claude native binary resolved via node_modules ...
[agent] session error: spawn Unknown system error -88
```

同时 `./build_dev.sh` 产出的 `.app` 明显变小。例如 Claude SDK 正常
darwin-arm64 解包后二进制约 221 MB，但坏状态下可能只有 50 多 MB。

**根本原因**：

`@anthropic-ai/claude-agent-sdk-darwin-*` 是 npm optional dependency。
如果 `npm install` / 升级过程被中断，npm 可能留下半截目录：`claude`
文件存在，但 `package.json` 缺失，Mach-O load command 指向文件末尾之后。

典型验证：

```bash
otool -l node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude | grep "past end of file"
```

这种文件会被 macOS 直接拒绝执行，Node 侧表现为 opaque 的
`spawn Unknown system error -88`。

**修复**：

当前 macOS `setup.sh` 和 `build_dev.sh` 都会调用：

```bash
./scripts/ensure_claude_sdk_package.sh
```

Windows `setup_windows.ps1` 和 `build_windows.ps1` 会调用：

```powershell
.\scripts\ensure_claude_sdk_package.ps1 -Arch x64
```

这些脚本会校验：

- platform package 的 `package.json` 名称 / 版本与 `package.json` pin 一致
- Mach-O 架构匹配 host / target
- macOS：`otool -l` 不含 `past end of file`，upstream code signature 可通过 `codesign --verify --strict`
- Windows：PE section 不指向文件末尾之后，Authenticode signature 为 `Valid`

发现损坏会用临时目录重新安装目标 platform package，再复制回
`node_modules/@anthropic-ai/`，避免继续把半截二进制打进 dev app。

---

## macOS esbuild native binary 架构不匹配

### 问题：重新运行 `build_macos.sh` 时 `@esbuild/darwin-x64` / `darwin-arm64` 报错

**症状**：

```
Error:
You installed esbuild for another platform than the one you're currently using.

Specifically the "@esbuild/darwin-x64" package is present but this platform
needs the "@esbuild/darwin-arm64" package instead.
```

**根本原因**：

`esbuild` 与 Claude SDK native binary 都通过 npm optionalDependencies 提供
platform-specific 包。npm 的 optional dependency reify 是按当前
`--os` / `--cpu` 过滤的，不适合在同一个根 `node_modules` 里反复切换架构。

典型触发链路：

1. Both 模式构建 x64 阶段发现 `@anthropic-ai/claude-agent-sdk-darwin-x64`
   损坏或缺失。
2. 旧版脚本在项目根目录执行 `npm install --os=darwin --cpu=x64 ...`
   修 Claude SDK。
3. npm 顺手把根 `node_modules` 的 native optional 包切到 x64，其中包括
   `@esbuild/darwin-x64`。
4. 下一次重新运行脚本时，host Node 是 arm64，`npm run build:server`
   先加载 esbuild，于是报需要 `@esbuild/darwin-arm64`。

**快速修复当前 checkout**：

```bash
ESBUILD_VERSION=$(node -p "require('./node_modules/esbuild/package.json').version")
npm install --no-save --no-audit --no-fund --ignore-scripts \
  --os=darwin --cpu="$(node -p "process.arch")" \
  "@esbuild/darwin-$(node -p "process.arch")@$ESBUILD_VERSION"
```

当前 `build_macos.sh` 已在 Step 5 前自动校验并修复 host Node 对应的
esbuild native binary；Claude SDK 的跨架构补包也改为临时目录安装后复制目标
package，避免再次污染根 `node_modules`。

---

## CSP 配置错误

### Windows Tauri IPC 需要特殊 CSP

**背景**：
- Windows Tauri v2 使用 `http://ipc.localhost` 进行 IPC 通信（走 Fetch API）
- CSP 中 `default-src` 和 `connect-src` 都必须包含 `http://ipc.localhost`。
  注意：管 fetch/XHR/WebSocket 的标准指令是 `connect-src`；曾经配过的
  `fetch-src` 是非标准指令，WebKit / WebView2 都忽略它（只在 console 报
  "Unrecognized"），已移除——真正放行 IPC 的一直是 `connect-src`。

**正确配置**（`tauri.conf.json`）：
```json
{
  "app": {
    "security": {
      "csp": "default-src 'self' ipc: tauri: asset: http://ipc.localhost; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ipc: tauri: asset: http://ipc.localhost http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https://download.myagents.io; img-src 'self' data: blob: asset: https://download.myagents.io;"
    }
  }
}
```

**关键部分**：
- `default-src`: 包含 `http://ipc.localhost`
- `connect-src`: **必须**包含 `http://ipc.localhost`（Windows Tauri IPC 走 Fetch API，由 connect-src 放行），并含 localhost 和 WebSocket 支持
- `img-src`: 支持 data URL 和 CDN 资源

**验证 CSP 配置**：

```powershell
# 检查 tauri.conf.json 中的 CSP
$conf = Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json
$csp = $conf.app.security.csp

# 验证关键部分
$requiredParts = @("http://ipc.localhost", "asset:", "connect-src", "https://download.myagents.io")
foreach ($part in $requiredParts) {
    if ($csp -notlike "*$part*") {
        Write-Host "缺少: $part" -ForegroundColor Red
    }
}
```

---

## Rust toolchain / rustfmt 漂移

**症状**：
- 未改 Rust 逻辑，却出现几十个 `src-tauri/src/**/*.rs` 文件的 diff
- diff 主要是 import 排序、宏参数换行、`let Some(...) else` 展开、trailing comma 等格式变化

**根本原因**：

Rust 格式化结果由 `rustfmt` 版本决定。仓库根目录的 `rust-toolchain.toml` 固定实际开发/CI toolchain；如果本机没有通过 rustup 进入仓库、或 IDE 使用了系统 Rust，就可能跑出不同格式。

`setup.sh` / `setup_windows.ps1` 和各平台 build 脚本都会调用 `scripts/ensure_rust_toolchain.*`：
- 从 `rust-toolchain.toml` 读取 channel 和 components（当前为 `1.92.0` + `rustfmt` / `clippy`）
- 显式安装对应 component
- 平台 build 额外安装目标 target（Windows 为 `x86_64-pc-windows-msvc`）
- Windows setup 会刷新当前 PowerShell 的 PATH；如果 winget 只报告 Rustup 包已安装但 `rustup.exe` 仍不可用，会兜底下载官方 `rustup-init.exe`，验证/补齐 `~/.cargo/bin/rustup.exe`

如果 Windows 上 setup 后 build 仍报 `can't find crate for core`、`target may not be installed`、`component 'rustfmt' is unavailable/not installed` 等 Rust 缺失类错误，先手动运行：

```powershell
.\scripts\ensure_rust_toolchain.ps1 -Targets x86_64-pc-windows-msvc
```

macOS / Linux：

```bash
./scripts/ensure_rust_toolchain.sh
```

**验证方法**：

```bash
rustup show active-toolchain
rustfmt --version
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

`rustup show active-toolchain` 应显示被仓库 `rust-toolchain.toml` override。升级 Rust 时必须同时改 `rust-toolchain.toml` 和 CI toolchain，并把 `cargo fmt` 产生的机械 diff 单独提交。

---

## Resources 缓存问题

### 问题：macOS Intel 构建提示缺少 ONNX Runtime 源码构建工具

ONNX Runtime 1.28 没有提供 macOS x64 预编译包，因此 `x86_64-apple-darwin` 的冷构建需要 Git、Python 3.8+、CMake 3.28+ 与 Apple Clang。`build_macos.sh` 会在 TypeScript/App 构建和 ONNX Runtime 源码下载前检查；直接运行 prepare 命令也会在 cache miss 后、文档资源网络动作前执行同一检查。固定 Rust toolchain 仍会先由现有 owner 准备，因为它既是 App 构建依赖，也是 prepared fingerprint 的输入。

常见修复：

```bash
xcode-select --install
brew install cmake python
cmake --version
python3 --version
```

构建脚本不会自动安装系统包。已经完整验证的 prepared cache 可以继续离线复用，不要求本机保留源码构建工具；失败前已经下载的 source cache 也会保留，安装缺失工具后直接重跑即可。

### 问题：每次构建都重新下载或签名文档转换资源

文档 Worker、OCR 模型、ONNX Runtime 与 PDFium 由统一入口准备：

```bash
npm run prepare:document-processing
```

原始下载和完整 prepared bundle 会持久缓存在 `src-tauri/resources/document-processing-cache/`，不受 `npm run clean` 删除 `src-tauri/target` 的影响。只要 App 版本、target、锁文件、相关 Rust 源码/toolchain 与签名配置都没有变化，重复 setup/dev/release build 应直接报告 `already ready`，不会再次下载、展开、编译或签名。提升 App 版本会产生新的 prepared fingerprint，但仍会复用已校验的内容寻址下载；首次升级还会自动迁移旧的 `src-tauri/target/document-processing-cache` 中校验有效的原始文件。

验证机器是否具备完整离线缓存：

```bash
npm run prepare:document-processing -- --offline
```

离线模式出现 `Offline prepared document bundle cache miss` 说明当前 target/fingerprint 的完整整包从未成功准备；联网重新运行一次即可。缓存文件损坏时不会被静默复用；联网模式会重新准备，离线模式会明确失败。不要手动把 cache 目录复制进 `document-processing/v1`，后者只是 prepare owner 原子发布给 Tauri 的当前投影。

### 问题：配置更新后构建仍使用旧配置

**原因**：
- Tauri 在 `target/{arch}/{profile}/resources/` 缓存配置文件
- 常规清理（`cargo clean` 或删除 `bundle`）不会清理此目录

**解决方案**：

手动清理 resources 目录：
```powershell
# Debug 构建
Remove-Item src-tauri/target/x86_64-pc-windows-msvc/debug/resources -Recurse -Force

# Release 构建
Remove-Item src-tauri/target/x86_64-pc-windows-msvc/release/resources -Recurse -Force
```

或使用构建脚本（已自动处理）：
```powershell
.\build_windows.ps1  # 自动清理 release/resources
.\build_dev_win.ps1  # 默认快速 Debug exe，自动清理 debug/resources
.\build_dev_win.ps1 -BundleNsis  # 需要验证安装器时，额外清理 debug/bundle 并打 Debug NSIS
```

---

## 代理配置问题

### localhost 连接失败

**症状**：
```
[proxy] Request failed: error sending request for url (http://127.0.0.1:31415/...)
```

**原因**：
- reqwest 默认使用系统代理（如 Clash: 127.0.0.1:7890）
- Windows 系统代理未正确处理 localhost 排除
- localhost 请求被发送到代理，连接失败

**解决方案**：

所有 localhost 请求强制禁用代理（详见 `pit_of_success.md` 的 `local_http` 节）：
```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 禁用所有代理（包括系统代理）
    .build()?;
```

**详见**：[proxy_config.md](../tech_docs/proxy_config.md)

---

## 最佳实践

### 构建前检查清单

- [ ] 版本号已同步（`package.json`, `tauri.conf.json`, `Cargo.toml`）
- [ ] Rust toolchain/components/target 已由 `scripts/ensure_rust_toolchain.*` 准备
- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] CSP 配置完整（`connect-src` 包含 `http://ipc.localhost`）
- [ ] 清理旧的 resources 缓存
- [ ] 杀死残留进程（node sidecar, MyAgents）

### 构建后验证

- [ ] 安装包大小正常（~150MB）
- [ ] 安装并启动成功
- [ ] 开发者工具无 CSP 错误
- [ ] Sidecar 连接正常
- [ ] 二维码等资源加载正常

---

## 相关文档

- [Windows 构建指南](../guides/windows_build_guide.md)
- [代理配置](../tech_docs/proxy_config.md)
- [Windows 平台指南](./windows.md)
