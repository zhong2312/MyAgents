# Sidecar 冷启动性能架构

> 本文记录 Sidecar 冷启动的当前执行顺序和性能约束。具体耗时受机器、Runtime 与 MCP 配置影响，应以启动日志中的计时点为准，不把历史本机数据作为性能合同。
> 核心思路：**尽快开始监听 → 延后非必要初始化 → MCP 按需加载**。

## 总览

冷启动路径上有四个降延迟杠杆：

1. **Rust 侧 health check 探测节奏** — 让 Rust 尽早检测到 Sidecar listen
2. **Node `main()` 重排序** — listen 前只做极轻量操作，重活在 listen 后跑
3. **Tab fast-path** — Tab session 跳过 MCP 磁盘扫描
4. **Tier 2 懒加载** — Settings UI / OpenAI bridge / 大模块按需 import

## Rust 侧启动时序 (`src-tauri/src/sidecar/*`)

`src-tauri/src/sidecar.rs` 现在是 facade。冷启动路径的真实 owner：

- `sidecar/session_lifecycle.rs`：session sidecar ensure、spawn 后 health/readiness 等待
- `sidecar/instances.rs`：global/tab sidecar spawn 与 monitor
- `sidecar/health.rs`：`wait_for_health`、`wait_for_readiness`、`check_sidecar_http_health`
- `sidecar/spawn.rs`：Node/script 定位、路径 normalize、spawn diagnostic

- TCP health check 指数退避 50→500ms（前 5 次累计 1.25s 覆盖常见冷启动窗口），代替固定 500ms 轮询
- 删除了 `spawn` 后的 50ms guard sleep —— `try_wait()` 本就非阻塞，crash 检测已由 health loop 的 alive_check（每 20 次）承担

## Node Sidecar `main()` 重排序 (`src/server/index.ts`)

**监听端口前只做轻量操作：**
- `ensureAgentDir`
- `initLogger`
- `setSidecarPort`
- `createBridgeHandler`

**`honoServe` 随后绑定 `127.0.0.1:port`**，让 Rust 尽早完成 health check。

**监听端口后，再根据进程角色执行延迟初始化：**
- Global：应用级 retention / migration cleanup、OAuth proactive scheduler
- Common：skill seed、plugin dir setup、socks bridge
- Session：OAuth revision observer、`initializeAgent`、external runtime restore、boot banner

因此 Global 不会为了 Settings 或 Provider 一次性操作创建虚假的当前 Session，也不会启动持久 Query 或恢复 Runtime；Session 进程也不会重复运行应用级 retention timer 和 migration scan。Skill seed 仍是可重复执行的共享初始化：更新后第一个启动的进程可能是 Session，它在接收 turn 前必须能够看到必需的 bundled skills，不能依赖另一个进程已经完成初始化。

`DeferredInitState` 是路由级就绪权威：`sidecar-composition.ts` 会在调用 handler 或解析请求体前拒绝未知路由和角色不匹配的路由；其余允许的路由除 `/health`、`/refs/:id` 外，由 route gate 读取状态机，未就绪时返回结构化 503。`/health/live`、`/health/ready`、`/health/functional` 分别表达存活、就绪和功能状态；初始化失败只写入这一状态机，不再维护第二条 Promise 失败通道。稳定运行后，这些检查都只是内存判断。Browser/Vite 的单进程开发模式由 `start_dev.sh --dev-union` 显式启用；生产环境只有 Rust 传入的 `global|session` 两种角色。详见 `pit_of_success.md` 的「DeferredInitState」节。

**`warmupShellPath()` 异步化：** interactive `zsh -i -l` 的 PATH 检测从同步 `execSync` 改成异步 `execFile`，防止阻塞事件循环 → starve TCP accept。

## Tab fast-path

`initializeAgent` 对 Tab session 传 `resolveWorkspaceConfig(..., { includeMcp: false })`，跳过 MCP 磁盘扫描。

**为什么 Tab 不需要 self-resolve MCP：**
- Tab 的 MCP 由前端 `/api/mcp/set` 下发
- self-resolve 不仅做白工，还会触发 fingerprint 差异 → abort → 30s 重启循环

**其它优化：** `getSessionMetadata` 从 3 次合并成 1 次 memo。

## External Runtime pre-warm：process ready ≠ MCP ready

Codex / Gemini 的 persistent runtime 预热和 Sidecar HTTP readiness 是两层不同契约。Sidecar `/health/ready` 只说明 Node owner 可接请求；external `startSession()` 返回才说明该 runtime 能接首轮 turn。

Managed Codex 又多一层：`initialize` 完成后 app-server 已存活，但 MyAgents 通过进程参数注入的 MCP 仍异步启动。`CodexRuntime.startSession()` 在发起 `thread/start|resume` 的 native startup boundary 建立 10 秒 absolute soft pre-warm window，并给每个 injected MCP 写入同预算派生的 Codex 原生 `startup_timeout_sec`，避免 MyAgents barrier 之后再叠 Codex 默认隐藏等待。`ready / failed / cancelled / timeout` 都会结束本 Runtime Session 唯一一次观察；非 ready 状态记录 degraded 后继续首 turn，当前 Runtime Session 不自动 reload / retry，新 Session 才重新尝试。这个 owner 不包含 Codex 用户目录自有配置；只有 process exit、thread/RPC failure 仍是 Runtime startup failure。

MCP definition 在到达 runtime 前也必须保持可执行：`mcpServerArgs[id]` 是附加参数，不得替换 preset 的 package/base argv。否则该 server 会在当前 Runtime Session 的一次预热窗口后 terminal degraded，基础 turn 虽可继续，但对应工具在该 Session 内不可用。

## "AI 启动中" UI 状态判据：`sdkControlReady` ≠ `system_init`

Claude Agent SDK 有**两个**完全不同含义的"准备好"信号，老代码混用了它们导致 UI 误标。

| 信号 | 来源 | 真实语义 | 时机 |
|------|------|---------|------|
| `Query.initializationResult()` | SDK 内部 `subtype:"initialize"` control_request 的 response | **subprocess 控制面 ready**：control request 可用、commands/agents 等初始化信息已返回；**不保证每个 MCP 已 connected** | spawn 后 ~300ms-3s |
| streamed `system_init` (`type:"system",subtype:"init"`) | `QueryEngine.submitMessage()` 在 `fetchSystemPromptParts → processUserInput → recordTranscript → loadAllPlugins` 之后 yield（claude-code:`src/QueryEngine.ts:540`）| **per-turn metadata**：当前 turn 用到的 model / tools / mcp_servers / session_id / permissionMode | 第一条 user message 触发 turn 的中后段 |

SDK 0.3 的 MCP 连接是非阻塞的：`initializationResult()` 已 resolve 或 streamed `system_init` 已列出某个 server 时，该 server 仍可能是 `pending`、`failed`、`needs-auth` 或 `disabled`。因此二者都不能作为 MCP ready 判据。Query / MCP map 创建时建立一次 10 秒 absolute deadline；所有 Desktop、IM 与 injected queue item 在公共 `messageGenerator()` dispatch seam 只消费剩余预算。`pending` 才等待；失败、鉴权、disabled、missing、status error 或 timeout 都把该 generation 标为 degraded 并继续基础 AI turn。结果在 owner 上 one-shot settle，连续会话不会每轮重读 / 重计时。

**UI 状态机对应**：
- `sessionState === 'starting'` → "AI 启动中（首次启动可能较慢）" hint —— **subprocess 还没 ready 才该显示这个**
- `sessionState === 'running'` → 普通"思考中…" loading —— subprocess ready 后 turn 执行期间显示

老代码用 `setSessionState(systemInitInfo ? 'running' : 'starting')` —— 用 per-turn metadata 当作 subprocess-ready 信号。后果：pre-warm 完成后用户发的第一条慢消息（典型例子：`/context` 命令做 14 个本地 turn 统计 token，可达 44 秒）整段 turn 都被标成 "AI 启动中"，让用户以为 sidecar 卡死。

**正确判据**（`agent-session.ts` 中所有启动/入队状态转换点都用同一条件）：

```typescript
setSessionState((systemInitInfo || sdkControlReady) ? 'running' : 'starting');
```

`sdkControlReady` 是模块级布尔，由 `startStreamingSession()` spawn 完 `query()` 后**fire-and-forget** `querySession.initializationResult()` 触发：promise resolve 时设为 true。它只服务 UI 的“控制面已启动”提示，不拥有 MCP pre-warm outcome。所有 session 重置点（`resetSession` / `switchToSession` / 第三方 → Anthropic 切换 / `initializeAgent`）必须**同时**清 `systemInitInfo` 和 `sdkControlReady`。

**为什么 fire-and-forget 而不是 `await initializationResult()`**：技术上 await 不会死锁（SDK 内部的 `readMessages()` 在 F9 构造时就开始独立 pump 消息进 `pendingControlResponses`，不依赖外层 for-await），但 await 会让 `startStreamingSession` 的整个执行序列化在 control 面初始化之后 —— 没必要。`sdkControlReady` 是纯 UI 副信号，不需要阻塞主流程。

**Promise 身份校验**：`querySession.initializationResult()` resolve 前如果发生 abort + 新 pre-warm（querySession 被替换），旧 promise 可能仍 resolve（buffer 里已经有 response 了）。所以 `.then` handler 必须 capture `localQuery` 并检查 `querySession === localQuery`，否则会污染下一个 session 的 `sdkControlReady`。

**`system_init` 身份权限**：每个 Query launch 同时捕获 Product Session id 与实际传给 SDK 的 expected session id；`lifecycle.ts` 持有可同步撤销的 authority。abort 在 interrupt / generator wakeup 前 revoke，Query replacement 也 revoke，并清除旧 Query 的 buffered control state；旧 Query 此后的 streamed event（含 retraction/result）全部丢弃。pre-warm buffered `system_init` 连同原 authority 保存。只有 authority 仍属于当前 Query、Product binding 未越界且事件 `session_id` 精确匹配 expected id，才允许 materialize/update metadata；pending adoption 还要在持有存储锁的 commit point 复核 authority。pending id 可 adoption；legacy/non-UUID Product id 保持自身 binding，只记录不同的 SDK id。迟到或未知 identity 不得清 transcript cursor或触发 real→real migration。

**非 pre-warm 冷启动的额外 fast-path**：用户在没有 pre-warm 的情况下直接发第一条消息，`enqueueUserMessage` 会设 state=`'starting'`。`initializationResult` 的 resolve handler 看到 `sessionState === 'starting'` 时主动转 `'running'`（约 3-5s 后），不必等到第一个 turn 末尾的 streamed `system_init` 才转。否则 /context 这类慢首 turn 会让"AI 启动中"挂 44 秒。

**为什么不切到 SDK 的 `startup()` / `WarmQuery` API**：MyAgents 的「pre-warm 即最终 session」架构（CLAUDE.md「Pre-warm 机制」段）让 `querySession` 是单一对象贯穿生命周期，`setMcpServers` / `setAgents` / `setSessionModel` / `abortPersistentSession` 全部 close-over 它。WarmQuery 模式要求 pre-warm 期间 `querySession` 是 WarmQuery、第一条消息时换成 Query，会波及几十处调用点。`startup()` 内部其实就是 spawn + `await initializationResult()`，我们直接展开调更轻。

## Tier 2 懒加载

### 大模块改为 `await import()`

| 模块 | 触发条件 |
|------|---------|
| `admin-api` | 首次处理 `/api/admin/*` 请求 |
| `openai-bridge` | 首次使用 OpenAI 兼容 Provider |
| `adm-zip` | 首次执行需要 ZIP 读写的操作 |

只在用户真正触发对应功能时才 parse。

### Builtin MCP 懒加载架构

当前两个 user-toggleable in-process MCP（`gemini-image` / `edge-tts`）通过 `src/server/tools/builtin-mcp-meta.ts` 集中登记 META，运行时按需 `getBuiltinMcpInstance(id)` 加载。历史 `cron-tools` / `im-cron` / `im-media` 已迁移到 `myagents` CLI；runtime-dynamic `im-bridge-tools` 走独立的 context-injected surface owner，不进入该 registry。

- 首次加载付 100-400ms（SDK + zod）
- 后续 0ms 缓存
- 失败自动 evict 防 poisoned cache
- ESLint `@typescript-eslint/no-restricted-imports` 规则（作用域 `src/server/tools/*.ts`）结构性禁止顶层 value-import SDK/zod

详见 `pit_of_success.md` 的「Builtin MCP 懒加载架构」节。

### Settings UI 的 MCP 列表

从**静态** `PRESET_MCP_SERVERS`（权威定义在 `src/shared/config-types.ts`，renderer 通过 `src/renderer/config/types.ts` barrel 读取）获取——与运行时 META 解耦。META 在 Sidecar 启动时只登记轻量 factory；本次 Sidecar 生命周期内从未启用或测试的 builtin 不会加载 tool module，也不会创建重型 INSTANCE。

## 排查冷启动退化的 checklist

如果某次改动后 Tab 打开变慢，按下面顺序排查：

1. **是否给 `src/server/tools/*.ts` 顶层加了 SDK/zod value import？** —— ESLint 应该会拦下，但旧代码可能漏。
2. **是否在 listen 之前加了同步重活？** —— grep `index.ts main()` 的 listen 前代码段。
3. **是否新加了路由不走 deferred-init gate？** —— 除 `/health/*` 和 `/refs/:id` 外都应走 gate。
4. **是否 Tab session 误开启了 MCP self-resolve？** —— 检查 `initializeAgent` 的 `includeMcp` 参数。
5. **是否新加了 `console.log` 在 hot path 而 logger 未 buffered？** —— `UnifiedLogger` 是 in-memory bounded queue，但极高频日志仍可能拖慢。
6. **是否第一条用户消息整段都被标成「AI 启动中」？** —— 先确认 `sdkControlReady` 是否在 pre-warm spawn 后被 `initializationResult()` 设为 true（grep `[agent] SDK control plane ready in`）。再核对所有 session 重置点同时清 `systemInitInfo` 和 `sdkControlReady`。详见上方「`sdkControlReady` ≠ `system_init`」节。
7. **External `prewarm_done` 是否记录 MCP terminal summary？** —— Managed Codex 的 `managed MCP pre-warm terminal outcome=ready|degraded` 在 `thread/start|resume` RPC 成功返回后结算；outcome 使用 thread boundary 建立的原 10 秒 absolute deadline，因此 thread RPC 卡顿时日志可能晚于 10 秒出现。RPC 失败属于 Runtime failure，不会伪造 summary；degraded 后同一 Runtime Session 不应出现 reload / 第二次 barrier。
8. **同一 Codex pid/thread 的每轮首响仍固定慢约 30 秒？** —— 检查 MyAgents injected server 的最终 launch config 是否带 `startup_timeout_sec=10`，并确认 preset package/base argv 没被 `mcpServerArgs` 覆盖；不要先假设进程发生了重启。

## 与其他文档的关系

- 启动期 readiness 状态机 → `pit_of_success.md` 的 DeferredInitState 节
- Builtin MCP 懒加载完整规范 → `pit_of_success.md` 的对应节
- 内置 Node.js 路径与 PATH 注入 → `bundled_node.md`
- 整体启动时序在系统中的位置 → `ARCHITECTURE.md` 的 Sidecar Manager 与通信模式节
