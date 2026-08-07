# 代理配置说明

## 概述

MyAgents 支持统一的应用代理配置，并按请求 owner 分成两个独立维度：非 Provider-owned 的“通用网络请求”基线，以及逐个模型 Provider 的专属路径。代理配置存储在 `~/.myagents/config.json` 中，由应用的独立「设置 → 网络代理」子页管理；页面只编辑配置，热传播与运行时 owner 不依赖该页面是否挂载。

---

## 🔧 配置文件格式

**路径**: `~/.myagents/config.json`

```json
{
  "proxySettings": {
    "enabled": true,
    "protocol": "http",
    "host": "127.0.0.1",
    "port": 7890,
    "scope": {
      "mode": "custom",
      "generalRequests": false,
      "providerIds": ["deepseek", "openrouter"]
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | boolean | ✅ | false | 是否启用代理 |
| `protocol` | string | ❌ | "http" | 代理协议：`http` 或 `socks5` |
| `host` | string | ❌ | "127.0.0.1" | 代理服务器地址 |
| `port` | number | ❌ | 7890 | 代理服务器端口 _// 默认值: proxy_config.rs:7_ |
| `scope` | object | ❌ | `{ "mode": "all" }` | 适用范围：`all` 或 `custom + generalRequests + providerIds` |

`scope.mode = "all"` 隐含 `generalRequests=true` 且所有 Provider 被选择。custom 中：

- `generalRequests` 控制更新、Space、Analytics、IM、Plugin Bridge、MCP/工具下载等既有 generic owner 是否使用 MyAgents 应用代理；
- `providerIds` 控制 MyAgents 是否主动给对应模型 Provider-owned 请求/子进程应用代理；
- 未选择的 owner 都是“继承系统网络”，不是强制直连；系统代理、VPN 或 TUN 仍可自然生效；
- localhost 永远由 `local_http` / `NO_PROXY` 绕过代理；IPv6 loopback 的合法环境变量 token 是 `::1`，不要写 URL authority 形式的 `[::1]`，部分客户端会把后者当成非法 CIDR/host 并拒绝整份列表。合并继承值或单 MCP override 时会丢弃精确的遗留 `[::1]` token，再补入合法 `::1`。

旧 custom 配置缺少 `generalRequests` 时按 `true` 解释，保持升级前“通用请求固定使用应用代理”的行为。显式带新字段的 custom 允许空 `providerIds`，也允许 `generalRequests=false + providerIds=[]` 的零范围；不得回退成 `all`。

---

## 🌐 代理应用范围

### ✅ 使用代理的场景

1. **通用请求与通用子进程基线**
   - 更新、Space、Analytics、IM、Plugin Bridge、MCP/工具联网与其它 generic owner；
   - **Rust 实现**：`build_client_with_proxy` / `apply_to_subprocess`，两者都读取 `read_proxy_settings_for_general_requests()`；
   - **Node 实现**：Sidecar `process.env` 只表达 general baseline；`cancellableFetch()` / `fetchWithGeneralProxy()` 每次请求从 `proxy-state` 取得单一、可回收的 package-pinned undici `GeneralRequestDispatcher`。general 被选中时 dispatcher 读取 app-proxy overlay，未选中时读取 Rust 覆盖前的 immutable inherited snapshot；它按请求协议选择 `HTTP_PROXY` / `HTTPS_PROXY`、支持 `ALL_PROXY` fallback，并用统一 `NO_PROXY` matcher 决定直连。所选 baseline 没有 proxy env 时使用显式 direct `Agent`，仍自然保留 TUN/VPN 等系统路由；
   - Rust 真正覆盖为应用代理时写入 `MYAGENTS_PROXY_INJECTED=1` 与覆盖前的 `MYAGENTS_PROXY_INHERITED_ENV_JSON`，供 Node 恢复 inherited baseline。general 未选择时不写注入标记，Sidecar 直接从自身启动环境捕获 inherited baseline。

2. **Provider-owned 请求 / 子进程**
   - Builtin SDK / OpenAI Bridge / provider probe / Managed Codex 等具备 provider owner 的路径按 `proxySettings.scope` 决策。
   - Builtin Anthropic subscription 的 provider owner 是 `anthropic-sub`：MyAgents 只按 scope 注入/恢复代理 env，不接管 Claude Code native 的 OAuth credential 读取/刷新。
   - **Rust 实现**: `build_client_with_proxy_for_provider` / `build_blocking_client_with_proxy_for_provider` / `apply_to_subprocess_for_provider`
   - **Node 实现**: `src/server/proxy-state.ts::applyProviderProxyPolicyToEnv` / `getProxyForProviderUrl`
   - 未选 provider：不注入 MyAgents proxy，恢复 Rust 注入前的 proxy env baseline，并保留 localhost `NO_PROXY` 保护。

3. **Rust Updater / Managed Codex Runtime 下载**
   - 检查更新 (`download.myagents.io/update/*.json`)
   - 下载更新包 (`download.myagents.io/releases/`)
   - **实现**: `src-tauri/src/updater.rs` + `proxy_config.rs`

   Managed Codex 的登录检查 / Runtime 子进程仍按 `codex-sub` provider scope 走代理；Runtime manifest / artifact 下载归 general。下载器先尊重 general / inherited 网络路径；manifest + signature 与 artifact 的每次完整 request/body future 都由 async deadline 包住，首选路径 90 秒硬墙钟到期即取消该次传输（持续有少量字节流入也不会续期）。网络、size、SHA-256 或 minisign 任一失败后，仅对已严格验证 host/path 的 `download.myagents.io` 直连重试。直连 client 禁止 redirect，结果仍必须通过 size + SHA-256 + minisign + 平台签名全链路校验，不是通用的 proxy bypass。

   Runtime 安装锁用 pid + process start time 识别 owner；活 owner 不受锁龄影响，前一 App 进程在下载中退出时，死 owner 经过 5 秒宽限即可被下一次启动回收，不会留下 30 分钟的假“下载中”。取得安装锁后会先清理该 runtime root 下遗留的 `.download-*` 临时目录，再创建本次唯一 staging 目录，避免反复退出积累大文件。

4. **LiteLLM 模型数据缓存**
   - 拉取模型上下文窗口数据 (`raw.githubusercontent.com/BerriAI/litellm/.../model_prices_and_context_window.json`)
   - 启动条件检查 + 24h interval，ETag/If-None-Match 增量
   - **实现**: `src-tauri/src/litellm_cache.rs`（`build_client_with_proxy`）

5. **其他外部资源**
   - 下载二维码等 CDN 资源

### ❌ 不使用代理的场景

**所有 localhost 通信自动排除代理**：
- Rust → Node.js Sidecar (`127.0.0.1:31415+`) _// base/range 常量仍由 `src-tauri/src/sidecar.rs` facade 导出，分配逻辑在 `sidecar/manager.rs`_
- Tauri IPC (`http://ipc.localhost`)
- 内部进程间通信

排除列表：`localhost`, `127.0.0.1`, `::1`

---

## 🛠️ 技术实现

### 架构图

```
┌──────────────────────────────────────────────────────────┐
│                  MyAgents Application                     │
├──────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────────────┐          ┌──────────────────┐       │
│  │  Rust Updater   │          │  Node.js Sidecar     │       │
│  │  (CDN 访问)     │          │  (SDK 访问 API)  │       │
│  └────────┬────────┘          └────────┬─────────┘       │
│           │                             │                  │
│           │ 读取配置                     │ 环境变量注入     │
│           ▼                             ▼                  │
│  ┌──────────────────────────────────────────────┐         │
│  │        ~/.myagents/config.json               │         │
│  │  { proxySettings: { enabled, host, port } }  │         │
│  └──────────────────────────────────────────────┘         │
│           │                             │                  │
│           │ 使用用户代理                 │ 使用用户代理     │
│           ▼                             ▼                  │
│  ┌─────────────────┐          ┌──────────────────┐       │
│  │  Clash / V2Ray  │          │  Clash / V2Ray   │       │
│  │  127.0.0.1:7890 │          │  127.0.0.1:7890  │       │
│  └────────┬────────┘          └────────┬─────────┘       │
│           │                             │                  │
└───────────┼─────────────────────────────┼──────────────────┘
            │                             │
            ▼                             ▼
    download.myagents.io          api.anthropic.com
```

### 代码实现

#### 1. 共享配置读取 (`proxy_config.rs`)

```rust
pub fn read_proxy_settings() -> Option<ProxySettings> {
    // 从 ~/.myagents/config.json 读取
    // 仅当 enabled=true 时返回
}

pub fn build_client_with_proxy(builder: ClientBuilder) -> Client {
    if let Some(settings) = read_proxy_settings_for_general_requests() {
        // 使用用户配置的代理，但排除 localhost
        builder.proxy(Proxy::all(url)?.no_proxy(...))
    } else {
        // 继承系统网络行为（reqwest 默认代理检测：env vars + macOS 系统代理）
        builder
    }
}

pub fn build_client_with_proxy_for_provider(
    builder: ClientBuilder,
    provider_id: &str,
) -> Client {
    // 仅当 provider_id 命中 proxySettings.scope 时注入 MyAgents proxy；
    // 否则继承系统网络行为。
}
```

`read_proxy_settings()` 只表示“应用代理总开关有效”，不能改成 general-aware；Provider helper 需要在 `generalRequests=false` 时仍为选中的 Provider 取得应用代理。通用 decision 统一走 `proxy_enabled_for_general_requests()` / `read_proxy_settings_for_general_requests()`。

#### 2. 子进程代理注入 (`proxy_config::apply_to_subprocess`)

```rust
if let Some(proxy_settings) = read_proxy_settings_for_general_requests() {
    cmd.env("HTTP_PROXY", proxy_url);
    cmd.env("HTTPS_PROXY", proxy_url);
    cmd.env("http_proxy", proxy_url);  // lower-case for stacks that only read those
    cmd.env("https_proxy", proxy_url);
    cmd.env("NO_PROXY", "localhost,...");
    cmd.env("no_proxy", "localhost,...");

    // Issue #194 — `ALL_PROXY` (curl-style "use proxy for everything") takes
    // precedence over HTTP_PROXY/HTTPS_PROXY in many HTTP stacks (reqwest,
    // openssl, curl). If the launching shell exported `ALL_PROXY` it would
    // shadow the proxy we inject above. Strip both casings unconditionally.
    cmd.env_remove("ALL_PROXY");
    cmd.env_remove("all_proxy");

    cmd.env("MYAGENTS_PROXY_INJECTED", "1"); // TypeScript 端区分显式注入 vs 系统继承
    cmd.env("MYAGENTS_PROXY_INHERITED_ENV_JSON", "..."); // 注入前 proxy env baseline
} else {
    // 继承系统网络行为，并把 localhost 合并进已有 NO_PROXY。
    // 注意：未配 MyAgents proxy 时 **不** 剥离继承的 `ALL_PROXY`——
    // "未配置 = 继承系统" 的设计语义包含 system 层的 `ALL_PROXY` 设置。
    // 用户视角的对应入口是 Settings → 网络代理 关闭开关。
    cmd.env("NO_PROXY", "<inherited entries>,localhost,...");
    cmd.env("no_proxy", "<inherited entries>,localhost,...");
}
```

Provider-owned 子进程必须使用 `apply_to_subprocess_for_provider(&mut cmd, provider_id)`。它只在 provider 命中 scope 时注入 MyAgents proxy；未命中时继承系统网络行为，并把 localhost 条目合并进已有 `NO_PROXY`。

Node Sidecar 内的 provider-owned 请求不得直接读 `process.env.HTTP_PROXY`：

```ts
applyProviderProxyPolicyToEnv(env, providerId);     // SDK / runtime subprocess env
getProxyForProviderUrl(providerId, upstreamUrl);   // fetch / undici ProxyAgent
```

#### 2.1 外部 Runtime 的 `envPolicy` override（PRD 0.2.16）

`apply_to_subprocess` 给 Rust spawn 的通用子进程（Sidecar general baseline、Plugin Bridge、tray helpers 等）设定基线。外部 AI Runtime（Claude Code CLI / Codex / Gemini）在 Sidecar 进程内再 spawn 时，可以由用户在 Agent 设置里选 `runtimeConfig.envPolicy.proxy` 进一步覆盖：

| 字面量 | 行为 | 适用场景 |
|--------|------|---------|
| `'myagents'`（默认） | 保留 Sidecar 当前 general process env；general 被选中时是 MyAgents 应用代理，未选中时是 inherited baseline | 由 MyAgents 通用范围管理 Runtime 环境 |
| `'terminal'` | 剥掉继承的 proxy var，恢复用户 interactive shell 在 `~/.zshrc` / `~/.bashrc` 里 export 的（Sidecar 启动时 `shell.ts::warmupShellPath` 抓的 8 个 var）；语义 = "等同于在你电脑的终端里手动启动这个 CLI" | 用户终端能访问的 endpoint 在 MyAgents 里访问不到；Clash TUN / VPN 用户（shell 通常无 proxy export，结果是无 proxy 注入） |

实现在 `src/server/runtimes/env-utils.ts::augmentedProcessEnv(policy)`，未知字面量 fallback 到 `'myagents'`（防御纵深）。disk 上的 envPolicy 必须通过 `env-utils.resolveAgentEnvPolicy(workspacePath)` 读取——它做 proxy 字面量校验并对未知值 warn-log，**禁止**裸 cast。

> 0.2.16 dev 阶段曾有第三档 `'direct'`（无条件剥 proxy），dogfooding 反馈选项太多后于 release 前移除。Terminal 档已覆盖原 `'direct'` 的核心 use case（TUN/VPN 用户 shell 没 proxy → terminal 模式结果就是无 proxy 注入）。存量 `'direct'` 在校验白名单里 fallback 到 `'myagents'`。

诊断面板（`RuntimeDiagnosticsBanner`）展示实际生效的 `RuntimeEffectiveEnv`，让用户直接看到 envPolicy 决定的 proxy var 落在 Runtime 子进程的具体值。详见 `tech_docs/multi_agent_runtime.md` 「Runtime 诊断 + envPolicy」节。

#### 3. Rust Updater (`updater.rs`)

```rust
let builder = reqwest::Client::builder()
    .user_agent("MyAgents-Updater/0.1.7")
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

#### 4. Rust SSE Proxy (`sse_proxy.rs`)

```rust
// 访问 localhost，强制禁用代理
let client = reqwest::Client::builder()
    .no_proxy()  // 确保直连 localhost
    .build()?;
```

---

## 🔍 常见问题

### Q1: 为什么配置了代理后，localhost 还是连不上？

**A**: 不应该发生！MyAgents 已自动排除 localhost。如果遇到此问题：
1. 检查 `NO_PROXY` 环境变量是否被覆盖
2. 查看日志是否有代理相关错误

### Q2: 代理配置不生效怎么办？

**A**: 检查步骤：
1. 确认 `~/.myagents/config.json` 中 `enabled: true`
2. Settings 修改会热传播到活跃 Sidecar；普通短请求在下一次请求时生效。Rust IM / Plugin Bridge 的重连由 `config_store` 协调：Channel model-work gate 覆盖普通 enqueue、回复 terminal finalizer、heartbeat 与 cron hand-off，关闭入口后再次复核空闲边界，再复用标准 Channel stop/start lifecycle 从磁盘配置重建。显式命令、启动恢复、健康监控、Channel 热配置同步与代理重连共用同一个 keyed lifecycle lock；start/replacement 取得锁后才读取磁盘权威配置。pending cron 复用同一个 Rust queue `Arc`，replacement runner 从首项开始补发定向高优先级 wake，后续按整个 queue 的下一 target 级联；router 与 Sidecar owner 不复制。连续修改由单一 reconciliation mutex + generation fence 收敛到最新配置，零运行实例的代际也必须排队 waiter。切换窗口内到达的普通消息会收到稍后重试提示。已打开 PTY 不会被终止，只有新 Terminal 使用新策略
3. 查看日志：
   ```
   [proxy_config] owner=general path=myagents-proxy
   ```

### Q3: 支持哪些代理协议？

**A**: 目前支持：
- ✅ HTTP 代理 (`http://`)
- ✅ HTTPS 代理 (`https://`)
- ✅ SOCKS5 代理 (`socks5://`) - 通过 `protocol: "socks5"` 配置

### Q4: 可以使用系统代理吗？

**A**:
- **总开关开启且当前 owner 被范围选中** → 使用应用配置的代理
- **总开关关闭，或 custom 中当前 owner 未选中** → 继承系统网络行为（与其他软件一致）

禁用时，应用不会主动干预网络代理设置，行为与普通软件一致：如果系统开了全局代理/TUN 模式，流量会走代理；如果系统没有代理，则直连。Localhost 通信始终直连（由 `local_http` 模块保障）。

---

## 🐛 调试

### 查看代理日志

**Rust 日志** (`~/.myagents/logs/unified-*.log`):
```
[proxy_config] owner=general path=myagents-proxy
[proxy_config] owner=general path=inherited
[proxy_config] owner=provider providerId=anthropic-sub path=myagents-proxy
```

**Node.js Sidecar 日志**:
```bash
# 设置环境变量后查看
HTTP_PROXY=http://127.0.0.1:7890 bun src/server/index.ts
```

### 测试代理连通性

```bash
# 测试代理是否可用
curl -x http://127.0.0.1:7890 https://api.anthropic.com/v1/messages

# 测试 CDN 访问
curl -x http://127.0.0.1:7890 https://download.myagents.io/update/darwin-aarch64.json
```

---

## 📝 开发注意事项

### 添加新的外部 HTTP 请求

如果需要添加新的外部 HTTP 请求，请使用 `proxy_config::build_client_with_proxy`：

```rust
use crate::proxy_config;

let builder = reqwest::Client::builder()
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

### localhost 请求

访问 localhost 时**必须**禁用代理：

```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 强制禁用代理
    .build()?;
```

> 实践中 MUST 用 `crate::local_http::*` 连 localhost，自动注入 `.no_proxy()`。详见 `pit_of_success.md` 的「local_http」节。

---

## 代理使用场景完整列表

| 组件 | 代理来源 | 特殊处理 |
|------|---------|---------|
| Rust generic reqwest | `read_proxy_settings_for_general_requests()` | `local_http` 仍内置 `.no_proxy()` |
| Node.js Sidecar general baseline | inherited snapshot 或 app-proxy overlay | 子进程看 `process.env`；进程内 fetch 走 `fetchWithGeneralProxy()`，显式 dispatcher 在两个 baseline 间选择并在切换后关闭旧连接池 |
| Provider-owned SDK/runtime/fetch | Provider selection | Rust/Node provider-aware helper |
| OpenAI Bridge subprocess | **代理变量被剥离** | SDK→Bridge 是 loopback；Bridge→upstream 由 `getProxyForProviderUrl(providerId, url)` 按 Provider owner 选择 overlay / inherited |
| Plugin Bridge | Rust `apply_proxy_env()` + Node `initializeProxyStateFromCurrentSettings({providerOwnedConsumers:false})` | 加载社区插件前安装 package-pinned global fetch/dispatcher；跟随 general；SOCKS5 在 Bridge 进程内建本地 HTTP bridge；变化后沿 Channel lifecycle 重启 |
| Updater / Managed Runtime 下载 | Rust reqwest / updater builder | 跟随 general；既有安全直连 fallback 不扩张 |

### SOCKS5 桥接机制

MyAgents 的 app-proxy overlay 通过 HTTP-to-SOCKS5 bridge 兼容 SDK/子进程。Sidecar 从完整 `currentProxySettings` 初始化 bridge，而不是从 general `process.env` 反推；overlay 保存 bridge HTTP URL，general 与 Provider 再独立选择 overlay 或 inherited baseline。因此 `generalRequests=false + Provider selected` 仍会启动 bridge，但不会把 bridge URL 写入 general process env。bridge 使用一个稳定 listener：仅切 general scope 时，已选 Provider 继续得到同一个 bridge URL；代理 endpoint 更新后，新 CONNECT 使用新目标，已经建立的 tunnel 自然排空。没有任何 app-proxy consumer 时停止接收新连接且不 force-close 活跃 tunnel；generation fence 丢弃过期 callback。

### Node 三基线不变量

`src/server/proxy-state.ts` 同时维护：

1. immutable `inheritedProxySnapshot`：MyAgents 覆盖前的系统/父进程 proxy env；
2. app-proxy overlay：当前应用代理 URL，SOCKS5 时为 bridge URL；
3. `process.env`：当前 general owner 实际使用的 baseline。

Provider selected 时直接复制 overlay，excluded 时直接复制 inherited；禁止再从 `process.env` 反推 Provider overlay。`getProviderProxyScopeKey()` 只包含 Provider 自己的有效路径，general-only 变化不重启 builtin / managed-provider；system CLI 的 `envPolicy.proxy='myagents'` 继续跟随 process/general key。

Node 进程内的 generic HTTP 调用必须走 `fetchWithGeneralProxy()`（需要 deadline 时走 `cancellableFetch()`），不能假设 global fetch 会消费 `HTTP_PROXY`。helper 显式选择 app overlay 或 inherited snapshot；所选 baseline 没有 proxy env 时使用显式 direct `Agent`。Plugin Bridge 是例外入口：社区插件无法强制改用 helper，因此 Bridge 在加载插件前把 package-pinned fetch 和同一 general dispatcher 安装为进程 global。Skills 安装器的 GitHub source 是产品构造的 `codeload.github.com` URL，在每跳 public-address 校验后使用完整 general dispatcher（app overlay 或 inherited baseline）；任意用户提供的 raw ZIP URL 继续使用 DNS-pinned direct dispatcher，避免代理侧重新解析重新打开 DNS rebinding / SSRF 窗口。raw ZIP 是显式安全例外，既不使用 app overlay，也不消费 inherited env proxy；这不是按域名扩展产品 scope。

### Owner 分类与不透明进程边界

这里的“通用 / Provider”是已有 helper、进程与请求 owner 的分类，不是按域名识别每个网络包。MyAgents 自己直接拥有的 generic 请求遵守 general；Builtin SDK、Managed Codex 等明确 Provider-owned 进程遵守 Provider 选择。若 SDK/Runtime 没有逐请求代理 API，同一不透明 Provider 进程内部代发的 remote MCP、connector、shell/tool 流量无法再次拆分，本期不增加 egress relay，也不宣称覆盖 WebView/系统浏览器网络栈。

### OpenAI Bridge 代理剥离

当供应商使用 OpenAI 协议时，SDK subprocess 的 `ANTHROPIC_BASE_URL` 指向 sidecar loopback。此时**必须剥离所有代理变量**，否则 SDK 的 `fetchOptions.proxy` 会将 loopback 请求路由到系统代理（→ 超时/502）。Bridge handler 解析 bridge token 得到 `providerId` 后，通过 Provider-aware overlay / inherited 决策访问上游 API，不能读取 general `process.env` 代替 Provider owner。
