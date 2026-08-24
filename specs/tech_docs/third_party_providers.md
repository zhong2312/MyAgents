# 第三方 LLM 供应商集成指南

本文档总结了在 MyAgents 中集成第三方 LLM 供应商（DeepSeek、智谱、Moonshot、MiniMax 等）的关键技术经验。

---

## 核心原理

Claude Agent SDK 支持通过环境变量配置第三方 API：

| 环境变量 | 作用 |
|----------|------|
| `ANTHROPIC_BASE_URL` | API 端点地址 |
| `ANTHROPIC_AUTH_TOKEN` | API 认证令牌 |
| `ANTHROPIC_API_KEY` | API 密钥（SDK 可能使用此变量）|
| `ANTHROPIC_MODEL` | 默认模型 ID |

---

## 关键经验

### 1. 环境变量必须同时设置两个 Key 变量

SDK 不同版本可能使用不同的环境变量名，建议同时设置：

```typescript
env.ANTHROPIC_AUTH_TOKEN = apiKey;
env.ANTHROPIC_API_KEY = apiKey;
```

### 2. 切换回官方订阅时必须清除环境变量

问题：切换到第三方后再切回 Anthropic 订阅，如果 `ANTHROPIC_BASE_URL` 仍存在，请求会发到错误的端点。

解决：显式删除环境变量：

```typescript
if (currentProviderEnv?.baseUrl) {
  env.ANTHROPIC_BASE_URL = currentProviderEnv.baseUrl;
} else {
  delete env.ANTHROPIC_BASE_URL; // 关键！
}
```

### 2.1 Anthropic 订阅的 OAuth owner 是 Claude Code native

`anthropic-sub` 不由 MyAgents 读取、刷新或写回 OAuth token。Claude Code native 自己读取本机官方 credential store（macOS Keychain `Claude Code-credentials`，Linux/Windows `~/.claude/.credentials.json`），这正是独立 `claude` CLI 登录后 MyAgents 应能直接复用的能力。

`buildClaudeSessionEnv()` 必须按 provider 分流：

- `providerId === 'anthropic-sub'`：删除/不设置 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`，让 native Claude Code 自主管理 OAuth。
- 其它 API provider：继续设置 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`，阻止 `~/.claude.json` / settings-sourced provider env（cc-switch、Claude Code Router 等）静默劫持 MyAgents 的 provider 路由。

不要给 **Anthropic 订阅** query 传 `getOAuthToken`，也不要为 `anthropic-sub` 新增 MyAgents 私有 token adapter；否则会和本机 Claude Code CLI/桌面端抢 OAuth refresh / Keychain 生命周期。

### 2.2 Grok 订阅的 OAuth owner 是 Rust 应用单例

`xai-sub` 与 `anthropic-sub` 都是 subscription ProviderRoute，但它们不是同一种 credential policy：

- `anthropic-sub`：`sdk-native`，Claude Code native 自己拥有凭据，materialize 为 `'subscription'` sentinel。
- `xai-sub`：`host-managed-oauth`，Rust `GrokAuthManager` 是 canonical grant、refresh rotation、quarantine 与 logout 的唯一 owner；materialize 为 builtin OpenAI Responses `ProviderEnv`，其中只有非 secret 的 `credentialSource:{kind:'managed-oauth',providerId:'xai-sub'}`。
- `codex-sub`：`runtime-managed`，由 Managed Codex Runtime 执行，不进入 builtin ProviderEnv。

Grok bearer 的边界：

1. Rust 独立存储 `~/.myagents/credentials/grok-oauth.json`，用文件锁、fresh-read、原子替换与平台权限加固管理 rotating refresh token。
2. Sidecar 不缓存 bearer。Bridge 的 async registry resolver 在每次上游请求前，经 localhost Management API 获取当前 access token；请求带进程出生时注入的 `MYAGENTS_SIDECAR_ID` 与 `X-MyAgents-Sidecar-Generation`，Rust 只接受当前 live Sidecar process identity。该身份同时覆盖 canonical Global 与 Session Sidecar，不能用可变的 Product Session id 代替。
3. Bridge 遇到首个 401 才请求一次强制 refresh，并以字节等价的 request body 重试；第二个 401 quarantine 对应 credential version。403/429 只记录 entitlement/rate 状态，绝不 refresh 或删除 grant。
4. renderer 只调用 Tauri auth/model commands，永远拿不到 bearer。模型目录复用 `ModelManagementPanel`，由宿主 `discoveryAction` 调 Rust `/v1/models`，再进入共享 OpenAI model-list parser。
5. OAuth 成功不等于“已验证”。Global Sidecar 的 one-shot 验证使用带 expected grant lineage 的 `verification` bearer purpose；只有 builtin SDK 经现有 Responses Bridge 收到 terminal success 后，Tauri verification owner 才按同一 lineage 提交 `providerVerifyStatus[xai-sub]=valid`。它不创建 Product Session，也不借用 Session Sidecar；普通 Bridge 2xx 不写验证状态，`execution` purpose 只允许已 valid（或既有 valid 后的 rate/network 临时态）的 grant。

### 3. API Key 存储与读取

- **存储位置**: `apiKeys[provider.id]`（通过 useConfig 获取）
- **常见错误**: 误用 `provider.apiKey`（始终为 undefined）
- **正确做法**: 

```typescript
const { apiKeys } = useConfig();
const apiKey = apiKeys[currentProvider.id];
```

### 4. Provider 配置结构

```typescript
interface Provider {
  id: string;
  name: string;
  config: {
    baseUrl?: string;  // 第三方 API 端点
  };
  models: ModelEntity[];
  primaryModel: string;
}
```

---

## 预设供应商 BaseURL

| 供应商 | BaseURL | 类型 | 备注 |
|--------|---------|------|------|
| DeepSeek | `https://api.deepseek.com/anthropic` | 模型官方 | Anthropic 兼容 |
| Moonshot | `https://api.moonshot.cn/anthropic` | 模型官方 | Anthropic 兼容 |
| 智谱 AI | `https://open.bigmodel.cn/api/anthropic` | 模型官方 | Anthropic 兼容 |
| MiniMax | `https://api.minimaxi.com/anthropic` | 模型官方 | Anthropic 兼容 |
| 火山方舟 Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | 云服务商 | 字节跳动 |
| 火山方舟 API调用 | `https://ark.cn-beijing.volces.com/api/compatible` | 云服务商 | 字节跳动 |
| 硅基流动 | `https://api.siliconflow.cn/` | 云服务商 | authType: api_key |
| ZenMux | `https://zenmux.ai/api/anthropic` | 云服务商 | 多模型聚合路由 |
| OpenRouter | `https://openrouter.ai/api` | 云服务商 | authType: auth_token_clear_api_key |

> **注意**：所有供应商使用 Anthropic 兼容端点。不同供应商 `authType` 可能不同，详见 `types.ts` 中的 `PRESET_PROVIDERS`。

---

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│ Chat.tsx                                                     │
│  - 用户选择 provider/model                                  │
│  - 新写入路径持久化 ProviderRoute: {providerId, model}      │
│  - 不持久化 apiKey/baseUrl/modelAliases                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /chat/send
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ session-engine/builtin-adapter.ts                            │
│  - 校验 ProviderRoute 与本次 model 一致                     │
│  - 调 admin-config materialize ProviderEnv                  │
│  - sdk-native subscription → 'subscription' sentinel          │
│  - host-managed subscription → managed ProviderEnv            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ agent-session.ts                                             │
│  - 存储运行时 currentProviderEnv（非持久身份）              │
│  - buildClaudeSessionEnv() 设置环境变量                      │
│  - anthropic-sub 跳过 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST   │
│  - xai-sub / API provider 保持 host-managed env sealing      │
│  - SDK query() 使用这些环境变量                             │
└─────────────────────────────────────────────────────────────┘
```

### ProviderRoute vs ProviderEnv

- `ProviderEnv` 只在 `src/server/provider-types.ts` 定义。它属于 Server 的 Provider 模块，不由 builtin Session facade 或 Renderer 定义。
- `ProviderRoute` 是会话持久身份，只保存 provider/model：`{kind:'provider', providerId, model}` 或 `{kind:'subscription', providerId:'anthropic-sub'|'xai-sub', model}`。
- `ProviderEnv` 是请求运行时派生物，包含 `baseUrl`、`apiKey`、`authType`、`modelAliases` 或非 secret `credentialSource`；只能从当前配置即时 materialize，不能作为新会话身份写回 `sessions.json`。`credentialSource` 是 owner 引用，不是 bearer 快照。
- `providerEnvJson` 只读兼容旧数据：没有 `providerRoute` 的历史 session 才允许 fallback 读取。新写入路径必须写 `providerRoute`，并省略/清空 `providerEnvJson`。
- `model + configSnapshotAt` 旧 session 缺 provider 时，只在“声明该 model 且本地有凭据/账号证据”的 provider 中修复。API provider 看非空 API key；Anthropic subscription 看 valid 状态、`accountEmail` 或 `verifiedAt` 任一存在。多个候选或没有候选时，不猜默认 provider，要求用户在模型选择器重新选择。

### OpenAI Bridge prompt cache affinity

OpenAI-protocol providers use the bridge as the only request-shape owner for both egress formats: `upstreamFormat:'responses'` and Chat Completions (`upstreamFormat:'chat_completions'` / default). Active builtin sessions attach anonymous cache affinity via `agent-session.ts::resolveActiveSessionUpstreamConfig()`:

- active session：`cacheAffinity: { sessionId, promptCacheKeyMode:'session' }`，由 `openai-bridge/prompt-cache.ts` hash 成 protocol-scoped `prompt_cache_key`（`myagents:responses:<hash>` / `myagents:chat_completions:<hash>`），不包含 raw `sessionId`、workspace path、apiKey、baseUrl、prompt 内容。
- one-shot bridge（provider verify / title / supported-model probing / vision 等）：不设置 `cacheAffinity`，避免短生命周期调用污染 chat session cache routing。
- SDK request 中的 `cache_control` 是 breakpoint source intent；Bridge 只在 active session 把它投影到目标协议明确支持的 content part。Responses 的 system blocks 使用无状态 `developer` message + `input_text` parts，Chat 使用 structured system content。Responses 支持 `input_text` / `input_image`；Chat 支持 `text` / `image_url`，因此历史 assistant text 与 tool-result text 也可原样投影。tool definitions、Responses function outputs / assistant outputs 等不支持该 target field 的位置不伪造 marker 或补充消息，继续依赖 provider 的 implicit caching。
- implicit caching 始终是默认机制：不发送 `prompt_cache_options.mode:'explicit'`。显式 breakpoint 只是 source marker 的局部投影，不从消息长度、role 或工具形态推断。
- `prompt_cache_key` 与 explicit breakpoint 是两个独立 compatibility capability。`openai-bridge/handler.ts` 只在 400/422 且错误精确指向对应字段或 breakpoint 必需 request shape 时，各自去掉对应能力并最多重试一次；重试从原始 Anthropic request 重新翻译。downgrade 只保存在当前 bridge token 的 registry entry，token 注销即释放，不写 provider 配置或持久化 capability matrix。
- 默认不发送 `store:true`、`previous_response_id`、`conversation`、`prompt_cache_retention`。这些属于 provider capability / 数据保留语义，不是缓存命中率修复的默认路径。
- 错误日志和 SDK/UI 透出的 upstream error body 必须先脱敏：不得输出 `myagents:responses:<hash>` / `myagents:chat_completions:<hash>`、apiKey、raw session id 或被上游回显的 request body / prompt。

### OpenAI Bridge timeout ownership

Bridge 只拥有“等待 upstream response headers”的连接建立上限，配置字段为
`BridgeConfig.upstreamHeadersTimeoutMs`（默认 5 分钟）。headers 到达后立即清除该 timer；它不限制
Chat Completions / Responses 的流式 response body 生命周期。

流式 body 不能用“最近有没有字节”代理 turn 活性。推理模型在服务端合法长思考时可能超过 60 秒不输出
任何字节；Bridge 没有 suspension、交互和 SDK turn 状态，不能据此 abort。真正永久无 SDK event 的 turn
由 builtin Session 的 suspension-aware 10 分钟 `InactivityWatchdog` 收口。

Bridge 在流式阶段只保留三种终止权：下游明确取消、真实 transport EOF/error、协议终态。Chat 以
`[DONE]`，Responses 以 `response.completed` / `response.failed` 结束下游并释放仍 linger 的 upstream
socket，不等待 TCP EOF。禁止重新增加 stream byte-idle timer、用户可配置 body timeout 或伪 heartbeat。

### Runtime-backed Provider（Managed Codex）

`codex-sub` 是 Provider 列表中的订阅型入口，但它不 materialize 为 Claude Agent SDK 的 `ProviderEnv`。它的 `Provider.execution.kind === 'runtime-backed'`，选择后会生成 `RuntimeBackedProviderIdentity { providerId:'codex-sub', runtime:'codex', runtimeSource:'managed-provider', model }`，由 Sidecar 以 Codex Runtime 执行。

边界规则：

- Chat session birth 保存 runtime projection：`runtime:'codex'` + `runtimeSource:'managed-provider'` + `providerExecutionIdentity`；Task/Cron 执行 override 保存 `runtimeConfig.source:'managed-provider'` + 选中的 Codex model。这样 Rust spawn Sidecar 时能注入 `MYAGENTS_RUNTIME=codex` 与 runtime source。
- IM / Agent Channel session birth 只保存 runtime identity：`runtime:'codex'` + `runtimeSource:'managed-provider'`。model / provider / permission / MCP 继续每条消息 live resolve 当前 Agent 配置；session drift、heartbeat、`/model` 命令唤醒 Sidecar 时必须比较并传递完整 identity。
- Agent/Channel 默认值保存用户的 Provider 选择：`providerId:'codex-sub'` + model，`runtime` 仍保持 `builtin`，且不得把 `runtimeConfig.source/model` 写进 Agent 默认配置。否则 Codex 订阅会和用户手动安装的 Codex CLI runtime 混成同一种身份。
- `codex-sub` 的可见性由 `managedCodexProviderDevGate` 控制；可选择性还要求 managed runtime 已安装到要求版本、managed Codex auth 有效（`chatgpt` 或兼容的 `access-token`），并且 provider 未被 `disabledProviderIds` 禁用。
- 进入 runtime-backed family 后，历史边界是 `runtime-backed:codex-sub`，不与 builtin Anthropic / third-party Provider transcript 互相 resume。

---

## 调试技巧

查看后端日志确认环境变量是否正确设置：

```
[env] ANTHROPIC_BASE_URL set to: https://open.bigmodel.cn/api/anthropic
[env] ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set from provider config
[agent] starting query with model: glm-4.7
```

订阅路径应看到：

```
[env] CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST skipped for Anthropic subscription
[env] ANTHROPIC_BASE_URL cleared (using Anthropic default)
[env] ANTHROPIC_AUTH_TOKEN cleared (using default auth)
```

如果看到 `apiKeySource: "none"`，说明 API Key 未正确传递。

---

## ⚠️ 关键陷阱：会话中途切换供应商

### 问题

环境变量（`ANTHROPIC_BASE_URL`）在 SDK 子进程启动时设置，**无法在运行时更新**。如果用户在会话中途切换供应商：

1. `currentProviderEnv` 更新 ✅
2. 正在运行的 SDK 进程仍使用旧的 baseUrl ❌
3. API 请求发往错误的端点 → 报错"模型不存在"

### 解决方案

检测供应商变化时，**终止当前 SDK 会话并重启**。重启后是否 resume 旧 SDK transcript 由 `canResumeAcrossProviderBoundary(...)` 统一判断：

```typescript
if (providerChanged && querySession) {
  const crossesProviderHistoryBoundary = !canResumeAcrossProviderBoundary(
    toProviderHistoryEnv(currentProviderEnv, currentModel),
    toProviderHistoryEnv(providerEnv, nextModel),
  );
  currentProviderEnv = providerEnv;
  abortPersistentSession();  // 统一中止：设置标志 + 唤醒 generator 门控 + interrupt

  // 等待旧会话完全终止，避免竞态条件
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  if (crossesProviderHistoryBoundary) {
    await resetForProviderHistoryBoundary(); // Product A 不变；持久化 fresh sdkSessionId=S2
  }

  // schedulePreWarm() 会在 finally 中自动触发
}
```

### 注意事项

- **应用层 session 保留**：Product `sessionId`、messages、cursor、title/config 与 Sidecar owner 全部不变
- **SDK 层 session 重建**：只把同一 Product Session 的 `sdkSessionId` 换成 S2，随后精确 create/resume S2
- **跨回合状态清理**：`streamIndexToToolId`、`toolResultIndexToId`、`childToolToParent` 由 `builtin-session/turn-lifecycle.ts` 的 terminal cleanup 触发清理（`agent-session.ts` 只组装清理回调）
- **统一中止**：所有需要终止 session 的场景必须使用 `abortPersistentSession()`，它同时唤醒 generator 的 Promise 门控并调用 `interrupt()`

---

## ⚠️ 关键陷阱：Provider 历史边界与 Resume

### 问题

Anthropic 官方 API 会在 thinking block 中嵌入签名，resume session 时校验签名。普通第三方供应商（DeepSeek、GLM 等）默认进入 portable protocol family：provider env 变化仍会重启 SDK subprocess，但重启后可以 resume 旧 transcript，保留用户在同一会话中切换模型 / provider 的工作流。

从第三方供应商切换到 Anthropic 官方后 resume session 会报错：`Invalid signature in thinking block`
如果未来确认某个 provider / model / endpoint 无法 replay 其他历史，才把它加入 `src/shared/providerHistory.ts::ISOLATED_PROVIDER_HISTORY_KEYS`。进入或离开 isolated entry 时，前端提示“将重置模型上下文”，后端只 fresh SDK execution identity；Product Session 与可见历史仍保持不变。isolated entries 之间不能共享 SDK transcript。

### Resume 规则

| From | To | Resume | 原因 |
|------|-----|--------|------|
| 三方 portable | Anthropic 官方 | ❌ fresh SDK identity | Anthropic signed history 边界不同 |
| Anthropic 官方 | 三方 portable | ❌ fresh SDK identity | Anthropic signed history 边界不同 |
| 三方 portable A | 三方 portable B | ✅ resume | 保留同一会话内切换 GLM / DeepSeek 等普通三方模型的工作流 |
| Anthropic-protocol 三方 | OpenAI-bridge 三方 | ✅ resume | SDK transcript 仍是 Anthropic 形态；OpenAI bridge 只在请求边界翻译 |
| 任意 non-isolated | isolated entry | ❌ fresh SDK identity | 已知该 entry 不支持跨边界 replay |
| isolated entry A | isolated entry B | ❌ fresh SDK identity | isolated entries 不互串 SDK transcript |
| Anthropic 订阅 | Anthropic API Key | ✅ resume | 签名兼容 |

### 区分标准

```typescript
// Provider history identity:
// - no baseUrl, or https://api.anthropic.com = Anthropic signed family
// - ordinary third-party providers share `third-party` across apiProtocol
// - entries listed in ISOLATED_PROVIDER_HISTORY_KEYS get an `isolated:*`
//   identity that also includes provider/model/endpoint context
//
// ISOLATED_PROVIDER_HISTORY_KEYS is intentionally empty initially.
// Add exact keys only after a concrete incompatibility is confirmed:
// - provider:<providerId>
// - model:<modelId>
// - endpoint:<apiProtocol>:<normalizedBaseUrl>
```

---

## ⚠️ 关键陷阱：不能把所有 subscription 都当成空 providerEnv

### 原则

- 会话配置状态里，`currentProviderEnv = undefined`：只表示 builtin Anthropic 订阅（官方默认 endpoint + Claude Code native OAuth store）。
- `providerEnv = { baseUrl, apiKey }`：普通第三方 API。
- `providerEnv = { baseUrl, credentialSource:{kind:'managed-oauth',...} }`：host-managed subscription；静态对象不含 token。

不要再在调用点用 `provider.type !== 'subscription'` 猜 materialization。统一把 `ProviderRoute` 交给 `session-engine` / `materializeProviderRouteEnv()`；只有 `anthropic-sub` 返回 sentinel：

```typescript
const resolved = route.kind === 'subscription' && route.providerId === SUBSCRIPTION_PROVIDER_ID
  ? 'subscription'
  : await materializeProviderRouteEnv(route);
```

后端检测订阅切换：

```typescript
// 从 API 模式切换到订阅模式
const switchingToAnthropicSubscription = resolved === 'subscription' && currentProviderEnv;
```

### One-shot SDK 子进程

`verifySubscription()`、Anthropic 辅助登录、标题生成、官方 vision 这类 one-shot 调用不属于“切换当前会话 provider”。它们调用 `buildClaudeSessionEnv()` 时不能靠裸 `undefined` 表达订阅身份，因为该函数会把 `providerEnv === undefined` 解释为“沿用当前 active session 的 `configState.currentProviderEnv`”。如果用户当前会话选中第三方 API provider，裸 `undefined` 可能错误继承 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`，或丢失 subscription provider identity。

one-shot 订阅路径必须显式传官方订阅 provider identity：

```typescript
const officialSubscriptionProvider: ProviderEnv = { providerId: SUBSCRIPTION_PROVIDER_ID };
const env = buildClaudeSessionEnv(officialSubscriptionProvider, undefined, {
  providerId: SUBSCRIPTION_PROVIDER_ID,
});
```

这既能清理第三方 provider env，又能触发 `anthropic-sub` 的 native OAuth owner 分支（跳过 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`）。

---

## ⚠️ 关键陷阱：智谱 GLM-4.7 的 server_tool_use

### 背景

智谱 GLM-4.7 支持服务端工具调用（如 `webReader`、`analyze_image`），返回 `server_tool_use` 类型的内容块，与 Claude 的 `tool_use`（客户端工具）不同：

| 类型 | 执行位置 | 示例工具 |
|------|----------|----------|
| `tool_use` | 客户端（本地 Sidecar） | MCP 服务器工具 |
| `server_tool_use` | 服务端（API 提供商） | webReader, analyze_image |

### 问题 1：input 是 JSON 字符串

智谱返回的 `server_tool_use.input` 是 **JSON 字符串**，而非对象：

```json
{
  "type": "server_tool_use",
  "input": "{\"url\": \"https://example.com\", \"type\": \"markdown\"}"
}
```

**解决方案**：

```typescript
let parsedInput: Record<string, unknown> = {};
if (typeof serverToolBlock.input === 'string') {
  try {
    parsedInput = JSON.parse(serverToolBlock.input);
  } catch {
    parsedInput = { raw: serverToolBlock.input };
  }
} else {
  parsedInput = serverToolBlock.input || {};
}
```

### 问题 2：装饰性文本包裹

智谱会在 `server_tool_use` 前后插入装饰性文本块，如果不过滤会显示为普通内容：

```
🌐 Z.ai Built-in Tool: mcp__web_reader__webReader
**Input:**
```json
{"url": "https://example.com", "type": "markdown"}
```
Executing on server side...
```

以及结果包裹：

```
**Output:** webReader_result_summary:[{"title":"..."}]
```

**解决方案**：在后端 `agent-session.ts` 中过滤这类文本：

```typescript
// 检测并过滤装饰性工具文本
function checkDecorativeToolText(text: string): { filtered: boolean; reason?: string } {
  if (!text || text.length < 50 || text.length > 5000) {
    return { filtered: false };
  }
  const trimmed = text.trim();

  // Pattern 1: 智谱 tool invocation wrapper - requires ALL markers
  const hasZaiToolMarker = trimmed.includes('Z.ai Built-in Tool:');
  const hasInputMarker = trimmed.includes('**Input:**');
  const hasJsonBlock = trimmed.includes('```json') || trimmed.includes('Executing on server');
  if (hasZaiToolMarker && hasInputMarker && hasJsonBlock) {
    return { filtered: true, reason: 'zhipu-tool-invocation-wrapper' };
  }

  // Pattern 2: 智谱 tool output wrapper - requires ALL markers
  if (trimmed.startsWith('**Output:**') && trimmed.includes('_result_summary:')) {
    const hasJsonContent = trimmed.includes('[{') || trimmed.includes('{"');
    if (hasJsonContent) {
      return { filtered: true, reason: 'zhipu-tool-output-wrapper' };
    }
  }

  return { filtered: false };
}
```

**注意事项**：
- 使用**多条件匹配**，避免误伤正常内容
- 添加长度限制（50-5000 字符），进一步降低误判风险
- 记录过滤日志，便于调试

---

## 自定义供应商

用户可通过 Settings 或 Admin API 添加自定义 OpenAI 兼容供应商。自定义供应商配置持久化到 `~/.myagents/providers/{id}.json`。

### modelAliases 默认值

自定义供应商如果没有主动设置 modelAliases，`getEffectiveModelAliases()` 和 `resolveProviderEnv()` 会用 `primaryModel` 或第一个可用模型作为 fable/sonnet/opus/haiku 的 fallback，防止子 Agent 发送 raw `claude-*` 到三方 API。
