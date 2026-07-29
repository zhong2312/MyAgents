# MyAgents 自动更新系统

## 设计理念

采用类似 Chrome/VSCode 的**静默更新**机制：
- 用户无需选择是否更新
- 无下载进度显示
- 更新完全在后台静默完成
- 仅在更新就绪后显示「重启更新」按钮

## 架构概览

```
应用启动 → 延迟 60s → 静默检查更新
                         ↓
                   有新版本? → emit updater:download-started (UI 隐藏按钮)
                         ↓
                   后台下载 (macOS/Linux: 在内存替换；Windows: 写 pending 字节到磁盘)
                         ↓
                   成功 → emit updater:ready-to-restart (UI 显示新版本「重启更新」按钮)
                   失败 → emit updater:download-failed (UI 恢复显示前一版本按钮)
                         ↓
                   用户点击 → macOS/Linux: cmd_shutdown_for_update → relaunch
                            → Windows: install_pending_update 内部完成 verified-clean handoff → Update::install(bytes)
                   或
                   下次启动 → 自动应用 pending 更新 (Windows 走启动期对话框)
```

**平台路径差异：**

| 平台 | 下载阶段 | 安装阶段 |
|------|---------|---------|
| macOS | `download_and_install` 内存中替换 .app 字节 | `relaunch` 直接生效 |
| Linux | `download_and_install` 在原地覆盖 AppImage | `relaunch` 直接生效 |
| Windows | `save_pending_update_to_disk` 写入 NSIS installer 字节 | `install_pending_update` 在 Rust 侧进入 update-quiesce gate，停 IM/Agent/Terminal/Browser/Sidecar，验证进程与关键文件锁清零后再 `Update::install(bytes)`；启动时若发现 pending 字节会弹对话框引导用户安装；安装阶段上游 updater 会在 `%TEMP%` 留下 `MyAgents-<version>-updater-*` 派生目录，由启动期 GC 清理 |

## 技术实现

### Rust 侧

| 文件 | 说明 |
|------|------|
| `src-tauri/Cargo.toml` | 添加 `tauri-plugin-updater` 和 `tauri-plugin-process` |
| `src-tauri/tauri.conf.json` | updater 配置、endpoints、pubkey |
| `src-tauri/capabilities/default.json` | updater 权限 |
| `src-tauri/src/updater.rs` | 静默检查、下载、重启命令 |
| `src-tauri/src/lib.rs` | 插件注册、启动时触发检查 |

### 前端侧

| 文件 | 说明 |
|------|------|
| `src/renderer/hooks/useUpdater.ts` | 监听 download-started / download-failed / ready-to-restart 三事件、维护 `preparing` 互斥标志、提供 `restartAndUpdate()` |
| `src/renderer/components/CustomTitleBar.tsx` | 顶栏「重启更新」按钮（`preparing` 时隐藏） |
| `src/renderer/pages/Settings.tsx` → `pages/settings/SettingsPage.tsx` | 设置页同款按钮；旧路径是 re-export facade |
| `src/renderer/App.tsx` | Windows 启动期 pending 更新对话框（在 `useUpdater.checkPendingUpdate()` 之上） |

### 核心流程

```typescript
// Rust 侧 (updater.rs)
check_update_on_startup()
  → sleep(60s)                            // 早于这之前用户的首次操作还没落
  → check_and_download_silently()
    → updater.check() → Update 对象 (含 version)
    → emit("updater:download-started", { version })   // UI 互斥锁：隐藏按钮
    → 下载阶段 (平台路径差异见上表)
    → 成功 → cache_update(update) + emit("updater:ready-to-restart", { version })
       失败 → emit("updater:download-failed", { version })  // UI 恢复前一版本按钮

// 前端侧 (useUpdater.ts)
listen("updater:download-started") → setPreparing(true)
listen("updater:download-failed")  → setPreparing(false)
listen("updater:ready-to-restart") → setUpdateReady(true) + setPreparing(false)
restartAndUpdate()
  → macOS/Linux: cmd_shutdown_for_update → relaunch()
  → Windows: install_pending_update()  // Rust 内部完成 update-quiesce + verified-clean + Update::install(bytes)
```

### 关键不变量

- **cache=disk 一致性**: `LATEST_UPDATE` 内存缓存与磁盘 pending 字节版本必须始终一致。`cache_update()` 只能在以下三个时机调用：①latest-wins 跳过同版本下载、②Windows 检测 disk 已有相同版本短路、③Windows `save_pending_update_to_disk()` 成功之后。**不可**在 `updater.check()` 之后无条件调用——会出现"内存指 v_NEW 但磁盘还是 v_OLD"的窗口期，导致用户在替换中点击破坏 v_OLD 字节。
- **UI 互斥**: `preparing=true` 期间所有「重启更新」入口必须隐藏（顶栏 / Settings / Windows 启动对话框）。下载替换的临界区不允许用户点击。
- **clear_pending_update_from_disk()** 必须同步 reset `DOWNLOADED_VERSION` 和 `LATEST_UPDATE`，否则 stale latest-wins 决策会用旧缓存填回空磁盘。
- **Windows updater temp GC**: `%TEMP%/MyAgents-<version>-updater-*` 是 Tauri 上游安装阶段的派生目录，不是 MyAgents 的 pending 更新权威状态。启动期只按"目录名精确匹配 + 普通目录 + 超过 24h"清理这些派生目录；不按当前版本保留，也不读取/修改 `~/.myagents/pending_update.*`。
- **Windows installer handoff 必须 verified-clean**: 用户点击安装后，Rust 先进入 update-quiesce gate：新的 Sidecar / Plugin Bridge / IM Channel / Terminal / Browser creation 必须先拿 shared permit，installer handoff 拿 exclusive permit 并等待已在途 creation 归零，避免“检查通过后又 spawn”。随后按 owner graceful shutdown IM/Agent/Terminal/Browser；Terminal owner 必须 kill 后 bounded wait，残留 shell PID 走 `UPDATE_TERMINALS_STILL_RUNNING` 阻断。最后用 `process_cleanup` 反复 kill + re-scan `--myagents-sidecar`、SDK/MCP、bundled Node，以及 `exe/cmdline` 指向当前 install/resource root 的进程；kill 后残留 descendant PID 也必须继续显式验证。只有进程扫描清零且关键文件（`nodejs/node.exe`、`claude-agent-sdk/claude.exe`、`server-dist.js`、`plugin-bridge-dist.mjs`、`tsx-runtime` loader）Windows 独占打开 probe 通过，才允许调用 `Update::install(bytes)`；关键 probe path 缺失/不可解析走 `UPDATE_LOCK_PROBE_UNAVAILABLE` fail-closed。残留进程或文件锁必须在 MyAgents UI 内失败并保留 pending 更新包，禁止进入 NSIS 的 Abort/Retry/Ignore 分叉。

### 更新检查策略

- **启动时检查**: 应用启动后延迟 **60 秒**（避开冷启动重负载 + 用户首次操作），再 best-effort 清理过期 Windows updater 临时目录并检查更新
- **定时检查**: 前端每 **30 分钟** 触发一次 `cmd_check_and_download_silently`（`CHECK_INTERVAL_MS` 常量）；即便已有 pending 更新仍会查询，latest-wins 协议保证更新版本会被替换（v_NEW 替换 cached v_OLD 不需要用户重启）
- **完全静默**: 检查/下载阶段对用户无感；只在 ready-to-restart 时才出现按钮

---

## CI/CD 配置

### GitHub Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加:

| Secret | 说明 | 获取方式 |
|--------|------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 签名私钥 | `cat ~/.tauri/myagents.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码 | 生成密钥时设置的密码 |
| `R2_ACCESS_KEY_ID` | R2 Access Key ID | Cloudflare R2 API Token |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Access Key | Cloudflare R2 API Token |
| `R2_ACCOUNT_ID` | Cloudflare Account ID | Dashboard URL 中的 ID |

### 生成签名密钥

```bash
cd /path/to/hermitcrab
npx tauri signer generate -w ~/.tauri/myagents.key
```

生成的公钥需要更新到 `tauri.conf.json` 的 `plugins.updater.pubkey` 字段。

---

## Cloudflare R2 配置

### 1. 创建 Bucket

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单 → **R2 Object Storage**
3. **Create bucket** → 名称: `myagents-releases`

### 2. 创建 API Token

1. R2 页面 → **Manage R2 API Tokens**
2. **Create API token**
3. 配置:
   - Token name: `myagents-release`
   - Permissions: **Object Read & Write**
   - Specify bucket: `myagents-releases`
4. 复制 Access Key ID 和 Secret Access Key

### 3. 配置公开访问

**方式一: 自定义域名 (推荐)**

1. Bucket Settings → Public access → **Connect Domain**
2. 输入: `download.myagents.io`
3. 在 DNS 添加 CNAME 记录指向 R2

**方式二: R2.dev 子域名**

1. Public access → 启用 **R2.dev subdomain**
2. 修改 `tauri.conf.json` 中的 endpoint URL

### 4. 获取 Account ID

- Dashboard 右上角头像 → Account Home
- URL 格式: `https://dash.cloudflare.com/{ACCOUNT_ID}`

---

## R2 目录结构 (自动创建)

```
myagents-releases/
├── update/
│   ├── darwin-aarch64.json    # Apple Silicon 更新清单 (Tauri Updater)
│   ├── darwin-x86_64.json     # Intel Mac 更新清单 (Tauri Updater)
│   └── latest.json            # 网站下载页 API
└── releases/
    └── v{VERSION}/
        ├── MyAgents_{VERSION}_aarch64.app.tar.gz  # Updater 用
        ├── MyAgents_{VERSION}_x64.app.tar.gz      # Updater 用
        ├── MyAgents_{VERSION}_aarch64.dmg         # 网站下载用
        └── MyAgents_{VERSION}_x64.dmg             # 网站下载用
```

> 目录由 GitHub Actions 自动创建，无需手动操作。

---

## 发布新版本

### 方式一: Git Tag 触发

**触发规则**: `v` 开头的 tag 会自动触发构建

| Tag | 是否触发 |
|-----|---------|
| `v0.1.0` | ✓ |
| `v0.2.0` | ✓ |
| `v1.0.0-beta` | ✓ |
| `0.2.0` | ✗ (没有 v 前缀) |
| `release-0.2.0` | ✗ |

```bash
# 1. 以 package.json 为版本源；npm version hook 同步 lockfile、Tauri 与 Cargo 版本
npm version 0.2.0 --no-git-tag-version
cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 >/dev/null

# 2. 只暂存本次发布涉及的文件并提交（显式列出实际文件）
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
git commit -m "chore: release v0.2.0" -m "Prepare the tracked version metadata and changelog for the v0.2.0 release."

# 3. 打 tag（必须 v 开头）
git tag v0.2.0

# 4. 推送代码和 tag
git push origin main --tags
```

推送 tag 后，GitHub Actions 自动开始构建。

### 方式二: 手动触发

1. GitHub 仓库 → **Actions** → **Release**
2. **Run workflow**
3. 输入版本号 (如 `0.2.0`)
4. 点击运行

---

## 验证发布

### 1. 检查 GitHub Release

- 应有 Draft release 包含 DMG 文件

### 2. 检查 R2 文件

```bash
# 检查更新清单
curl https://download.myagents.io/update/darwin-aarch64.json
```

预期返回:
```json
{
  "version": "0.2.0",
  "notes": "MyAgents v0.2.0",
  "pub_date": "2026-01-23T14:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://download.myagents.io/releases/v0.2.0/MyAgents_0.2.0_aarch64.app.tar.gz"
    }
  }
}
```

### 3. 本地测试更新

1. 构建旧版本 (如 v0.1.0)
2. 发布新版本到 R2 (如 v0.2.0)
3. 运行旧版本
4. 等待启动期检查触发（当前为 60 秒）后，顶栏应出现「重启更新」按钮

---

## 用户体验流程

```
┌─────────────────────────────────────────────────────────────┐
│  用户正常使用应用                                            │
│                                                             │
│  (后台静默: 检查更新 → 发现新版本 → 下载完成)                  │
│                                                             │
│  顶栏出现按钮:  [🔄 重启更新]  [⚙️]                          │
│                                                             │
│  用户可以:                                                   │
│  • 点击按钮 → 立即重启并更新                                  │
│  • 忽略按钮 → 下次启动时自动应用更新                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 文件格式

### Tauri Updater 清单 (darwin-aarch64.json / darwin-x86_64.json)

供客户端自动更新使用：

```json
{
  "version": "0.2.0",
  "notes": "MyAgents v0.2.0",
  "pub_date": "2026-01-23T14:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "base64编码的签名",
      "url": "https://download.myagents.io/releases/v0.2.0/MyAgents_0.2.0_aarch64.app.tar.gz"
    }
  }
}
```

### 网站下载 API (latest.json)

供官网下载页面使用：

```json
{
  "version": "0.2.0",
  "pub_date": "2026-01-23T14:00:00Z",
  "release_notes": "MyAgents v0.2.0",
  "downloads": {
    "mac_arm64": {
      "name": "Apple Silicon",
      "url": "https://download.myagents.io/releases/v0.2.0/MyAgents_0.2.0_aarch64.dmg"
    },
    "mac_intel": {
      "name": "Intel Mac",
      "url": "https://download.myagents.io/releases/v0.2.0/MyAgents_0.2.0_x64.dmg"
    }
  }
}
```

**网站前端示例**:

```typescript
// 获取最新版本信息
const res = await fetch('https://download.myagents.io/update/latest.json');
const data = await res.json();

// 显示版本号
console.log(`最新版本: v${data.version}`);

// 根据用户设备选择下载链接
const isMacARM = /* 检测 Apple Silicon */;
const downloadUrl = isMacARM
  ? data.downloads.mac_arm64.url
  : data.downloads.mac_intel.url;
```

---

## 故障排查

### 更新检查失败

1. 检查网络是否能访问 `download.myagents.io`
2. 检查 CSP 配置是否允许该域名
3. 查看 Rust 日志 `[Updater]` 前缀

### 签名验证失败

1. 确认 `tauri.conf.json` 中的 pubkey 正确
2. 确认 CI 使用的私钥与 pubkey 匹配
3. 检查 .sig 文件是否正确上传

### 「重启更新」按钮不显示

1. 检查 Console 是否有 `Event received: updater:ready-to-restart` 日志
2. 检查 Rust 日志 `[Updater]` 是否有 `Emitting 'updater:ready-to-restart' event` 行
3. 如果按钮一闪即消，看是不是又触发了 `updater:download-started` —— 新版本正在替换旧版本字节，等下载完成会再显示

### 点击「重启更新」无效（Windows）

1. 看 Rust 日志里 `install_pending_update called`、`Update shutdown gate acquired`、`Shutdown for update complete`、`Update file-lock probe passed` 是否连续出现；Windows 不走 `cmd_shutdown_for_update → relaunch` 路径
2. 如果返回 `UPDATE_PROCESSES_STILL_RUNNING` / `UPDATE_TERMINALS_STILL_RUNNING` / `UPDATE_FILES_STILL_LOCKED` / `UPDATE_LOCK_PROBE_UNAVAILABLE`，说明 Rust 在进入 NSIS 前主动阻断，pending 更新包会保留，用户稍后重试或重启 Windows 后再安装
3. 网络异常导致 `tauri-plugin-updater::check()` flaky 时 `Update::install(bytes)` 会失败 —— 现在前端会把 outcome 走 toast 反馈给用户（详见 `CustomTitleBar` 的错误处理）
4. 检查 `~/.myagents/updater_pending/` 是否有 pending 字节文件残留
