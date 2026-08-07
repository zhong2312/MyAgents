# Tool Attachment 一等公民管道

> AI 运行时（Codex / 未来 Gemini / CC / builtin）产出的富媒体（图片为主，预留音频/PDF）走同一条
> `UnifiedEvent.tool_result.attachments[]` 通道，前端用单一 `ToolAttachmentGallery` 组件渲染。
>
> 引入版本：v0.2.15。本期接入 Codex Runtime；builtin SDK / Gemini / CC 接入留 v0.2.16+。
>
> 设计 PRD：`specs/prd/prd_0.2.15_codex_tool_outputs_normalization.md`（本地存档，未入 git）。

---

## 1. 为什么需要

老路径"按工具名前缀分发到专门组件 + tool result 文本写 filePath 字符串再前端正则解析"只为内置
`mcp__gemini-image__*` 单点写。Codex 接入 OpenAI 官方 `image_generation`（不叫 `mcp__gemini-image__*`）
后图片完全不渲染——`codex.ts::parseNotification` 在 `imageGeneration` 完成事件上只读了
`revisedPrompt/status`，把真正的 `result`（base64 图片字节）和 `savedPath`（Codex v0.117+ 自动落盘的
绝对路径）丢了。同类问题在 `mcpToolCall.result.content[]` 含 MCP `image` ContentBlock、
`dynamicToolCall.contentItems[]` 含 `inputImage{imageUrl}` 路径也存在。

归一化要解决：

- 任意 runtime、任意工具产图，**前端组件改样式不需要改后端**
- 大图（base64 ≥ 数 MB）**不进 SSE / IPC JSON**（CLAUDE.md 红线：>256KB payload 走引用而非内联）
- 异步落盘**不阻塞** SSE 流（同 turn 多图不出现 head-of-line block）
- session resume / sidecar restart 后历史回放图片**仍能渲染**

---

## 2. 数据流

```
                            ┌─────────────────────────────┐
                            │ Codex CLI (app-server)       │
                            │ item/completed:              │
                            │   imageGeneration            │
                            │   { result: <b64>,           │
                            │     savedPath: <abs path>,   │
                            │     revisedPrompt: ... }     │
                            └────────────┬─────────────────┘
                                         │ JSON-RPC notification
                                         ▼
           ┌─────────────────────────────────────────────────────┐
           │ codex.ts::parseNotification (Sidecar)               │
           │                                                     │
           │  scheduleAttachmentSave(source, ctx, asyncEmit)     │
           │  ├── makePlaceholderAttachment → pendingId          │
           │  └── trackInFlightSave(promise)                     │
           │      └── saveToolAttachment(...)  (async)           │
           │          ├── base64: 落盘到 ~/.myagents/generated/  │
           │          │       tool-attachments/<sid>/<tid>/      │
           │          ├── externalPath: 零拷贝引用 + register     │
           │          └── url: cancellableFetch (https-only) +   │
           │                  落盘                                │
           │                                                     │
           │  return UnifiedEvent.tool_result {                  │
           │    content: revisedPrompt,                          │
           │    attachments: [placeholder]   ← refPath: '',      │
           │  }                                  pendingId        │
           └──────────────┬──────────────────────────────────────┘
                          │ UnifiedEvent
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ external-session.ts::handleUnifiedEvent          │
           │   case 'tool_result':                            │
           │     broadcast 'chat:tool-result-start/complete'  │
           │       payload includes attachments[]             │
           │     PersistContentBlock.tool.attachments = [...] │
           │   case 'tool_attachment_update':                 │
           │     patch matching pendingId in attachments[]    │
           │     broadcast 'chat:tool-attachment-update'      │
           │     (content state owned by content-blocks.ts)   │
           │                                                  │
           │ persistTurnResult():                             │
           │   await awaitInFlightSaves() ← drains async      │
           │   JSON.stringify(content-blocks snapshot) → 写盘 │
           └──────────────┬───────────────────────────────────┘
                          │ SSE
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ TabProvider.tsx                                  │
           │   case 'chat:tool-result-start/complete':        │
           │     mergeAttachmentsByPendingId(existing, in)    │
           │     → 不覆盖已 patched 的 entry                  │
           │   case 'chat:tool-attachment-update':            │
           │     replace by pendingId in streamingMessage     │
           │                                                  │
           │ history hydration:                               │
           │   PersistContentBlock → ContentBlock[] →         │
           │   ToolUseSimple.attachments transparent          │
           └──────────────┬───────────────────────────────────┘
                          │ React state
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ Message.tsx (per-BlockGroup hoist, PRD 0.2.30)  │
           │   for each BlockGroup:                           │
           │     groupAttachments = group's top-level         │
           │                        tool.attachments ?? []    │
           │   → render: {blockGroup tool rows}               │
           │             {groupAttachments.length &&          │
           │                <ToolAttachmentGallery/>}         │
           │   (hoisted OUT of the collapsible ToolUse body   │
           │    so the card is a standalone, always-visible   │
           │    in-flow card regardless of fold state)        │
           │                                                  │
           │ ToolAttachmentGallery → ToolImageAttachment      │
           │   useAttachmentUrl(attachment, sessionId)        │
           │     state: pending | loading | ready | error     │
           │     ready:   <img src={resolved attachment URL}> │
           │     pending: loading skeleton                    │
           │     error:   "⚠️ Image failed: <code>"            │
           └──────────────┬───────────────────────────────────┘
                          │ HTTP GET
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ Sidecar /api/attachment/tool/<sid>/<tid>/<file>  │
           │   1. Sanity check (no ../, no control chars)     │
           │   2. lookupExternalAttachment(sid, tid, file)    │
           │      hit → Codex savedPath (zero-copy)           │
           │   3. miss → trusted root <gen>/<sid>/<tid>/<file>│
           │   4. validateExternalReadPathNode (blacklist)    │
           │   5. fileResponse with CORS + cache-control      │
           └──────────────────────────────────────────────────┘
```

---

## 3. 核心类型

`src/shared/types/tool-attachment.ts`：

```typescript
export interface ToolAttachment {
  kind: 'image' | 'audio' | 'pdf' | 'file';
  mimeType: string;
  /** 相对路径形态 `/api/attachment/tool/<sid>/<tid>/<file>`。
   *  前端运行时解析为 app-owned attachment protocol；不存绝对 URL。 */
  refPath: string;
  /** 落盘绝对路径（trusted-root 副本），仅 sessionOwner sidecar 写。渲染/重启走它。 */
  savedPath?: string;
  /** 原始产物路径（PRD 0.2.31）。工具实际写出的原始文件 + 卡片 meta 展示的路径。
   *  「在文件管理器中显示 / 用默认应用打开」优先用它（让"看到的"="打开的"）；
   *  因可能在非 home 盘的 workspace 下，open 调用须带 workspace 前缀。仅 builtin 媒体设置。 */
  sourcePath?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  /** 4KB 硬上限 — 防 unbounded 入侵 SSE 256KB 红线。 */
  caption?: string;
  producedBy?: string;
  /** Placeholder 占位 ID — 异步落盘期间先 emit 占位 attachment，
   *  落盘完成后通过 chat:tool-attachment-update 替换。 */
  pendingId?: string;
}
```

UnifiedEvent 扩展：

```typescript
| { kind: 'tool_result';
    toolUseId, content, isError, metadata,
    attachments?: ToolAttachment[];                 // 新增
  }
| { kind: 'tool_attachment_update';                 // 新增
    toolUseId; pendingId; attachment: ToolAttachment;
  }
```

---

## 4. 安全模型

落盘和路径校验有 5 层防护：

| 层 | 位置 | 防的攻击 |
|---|---|---|
| Node path-safety 黑名单 | `src/server/utils/path-safety.ts::validateExternalReadPathNode` | `/etc/passwd`、`~/.ssh/id_rsa` 等系统/凭据路径；Managed Codex 仅精确保护 `auth.json` |
| Canonicalize symlinks（读侧） | 同上，`canonicalizeSymlinks:true` | `~/.codex/evil.png → /etc/passwd` symlink 逃逸 |
| 拒绝 symlink leaf | `lstatSync.isSymbolicLink()` | 防范 fs.realpath 行为漂移 |
| Positive allow-list | `tool-attachments.ts::isAllowedExternalAttachmentPrefix` | 拒绝引用 `~/Documents/secrets.docx` 等"既不在黑名单也不该读"的路径；只允许 `~/.codex/` `~/.myagents/` `~/Documents/` `~/Desktop/` `~/Downloads/` 及子目录 |
| Trusted root（写侧） | `validateTrustedAttachmentRoot` | 禁止把 base64 落盘写到 attachment root 之外 |

URL 下载额外防 SSRF：

- 限定 `https:` scheme；`http:` / `file:` / 自定义 scheme 拒绝
- 拒绝 `localhost` / `127.0.0.1` / `0.0.0.0` / `::1`
- 拒绝 RFC 1918 私网（`10/8`、`192.168/16`、`172.16/12`）
- 拒绝 `169.254/16` 链路本地（AWS/GCP/Azure metadata service）
- 拒绝 IPv6 ULA / link-local（`fc00:` / `fd*:` / `fe80:`）
- `redirect: 'error'` — 拒绝跨 scheme/host 跳转
- DNS 解析后校验 + undici dispatcher 钉死已验证 IP（关闭 DNS-rebinding TOCTOU）
- `withAbortSignal`（parentSignal + 30s timeout）
- 流式读取 + 累计上限：Content-Length 可选（chunked 编码），`arrayBuffer()` 会让
  恶意端点在尺寸检查前无界分配——按 chunk 累计超过 25MB 即 `reader.cancel()`

**cancellableFetch 豁免（刻意为之，勿"修"回去）**：`downloadAndSaveUrl` 用的是
undici 自有 `fetch` + `withAbortSignal`，**不是**红线表里的 `cancellableFetch`。
原因：DNS 钉死需要传 per-request `dispatcher`（undici `Agent`），`cancellableFetch`
的签名带不进去；且 repo 的 undici@8 `Agent` 混用 Node 内建 fetch 会抛
`invalid onRequestStart method`。超时/取消语义经 `withAbortSignal` 组合后与
`cancellableFetch` 等价。后续 lint 收紧或 review 如果把它替换回
`cancellableFetch`，会静默丢掉 SSRF 钉死——这正是这段记录存在的原因。

错误暴露面：`makeErrorAttachment(ctx, err, pendingId)` 把 throw 映射到固定 enum
（`too_large` / `rejected_path` / `not_found` / `fetch_failed` / `unsupported_url` /
`decode_failed` / `unknown`），refPath 形如 `error://<code>`。**raw error.message
不进 SSE / 不写 SessionStore**——绝对路径 / `~/.codex/sessions/<id>` 等敏感信息只
留在 server log。

---

## 5. 异步落盘 & Placeholder 生命周期

`scheduleAttachmentSave` 是 fire-and-forget — 落盘走 await 但不阻塞 `parseNotification` 返回：

1. parseNotification 同步返回 `tool_result` event，attachments = `[placeholder]`
2. external-session 立即 broadcast `chat:tool-result-start/complete`，渲染器显示 loading 骨架
3. 异步落盘成功 → `asyncEmit({ kind:'tool_attachment_update', pendingId, attachment: real })`
4. external-session 通过 `external-session/content-blocks.ts` 更新 content blocks 中匹配 pendingId 的 entry，broadcast SSE update
5. TabProvider 在 streamingMessage 中按 pendingId 替换占位 → 骨架变成图片

**关键守卫**：`persistTurnResult` 进入即 `await awaitInFlightSaves()`，保证所有 in-flight
落盘完成后再 `JSON.stringify(content-blocks snapshot)` 写盘——避免"placeholder 飞越 turn boundary
落到磁盘永远 stranded"。session resume 时反查 PersistContentBlock attachments，调
`rebuildAttachmentRegistryFromBlocks` 把 Codex savedPath 重新 register 进 in-process map。

历史兼容边界：旧版宽泛 Managed Codex 路径黑名单已经持久化出的
`error://rejected_path` 附件只含错误码，不含 `savedPath`，resume 时会被注册表重建跳过。
因此收紧黑名单不会让这些旧卡片自动恢复；需要重新执行图片生成。新生成的图片会按
`savedPath` 注册为 `/api/attachment/tool/...` URL。

---

## 6. 前端归一化原则

`Message.tsx` 在每个 BlockGroup 渲染**之后**外挂统一 `ToolAttachmentGallery`，attachments 从该
group 顶层 tool 的 `tool.attachments` 拉取（PRD 0.2.30）：

```tsx
{blockGroupToolRows}                                            // BashTool / EditTool / ...
{groupAttachments.length > 0 &&                                 // group 顶层 tool.attachments
  <ToolAttachmentGallery attachments={groupAttachments}/>}      // 自动渲染 image/audio/...
```

**为什么外挂在 Message.tsx 而非 ToolUse.tsx**（PRD 0.2.30 bug 修复 e46748b9）：早期版本把
Gallery 渲染在 `ToolUse` 内部，而 `ToolUse` 只在 `ProcessRow` 展开体里挂载——于是工具行折叠时
卡片完全不可见、展开时只是缩进在工具窗口里，从来不是会话流里的独立卡片。现把 Gallery 上提到
`Message.tsx`，按 BlockGroup 渲染，成为折叠状态无关的、始终可见的 in-flow 卡片。

子 Agent（Task）的媒体附件挂在 `subagentCalls[]` 上、由 `TaskTool` 渲染，是另一条路径——顶层
hoist 只拉 group 顶层 `tool.attachments`，不会重复渲染子 Agent 媒体。

> 历史注记：曾有 `TOOLS_THAT_OWN_GALLERY_PREFIXES = ['mcp__gemini-image__']` 兜底规则（老
> GeminiImageTool 自渲染图片、外层跳过防双渲）。builtin runtime 接入后 GeminiImageTool 已走
> attachments，该 prefix 列表与配套 `ownsGallery()` 守卫**已整体删除**。

`mergeAttachmentsByPendingId` 防 `chat:tool-result-complete` 重发覆盖已 patched 的 entry —
identity key 是 `pendingId || refPath`，若 existing 已 resolved（refPath 非空 + 无 pendingId），
保留 existing，不接受 incoming placeholder 覆盖。

---

## 7. 多 Sidecar 边界

attachment endpoint `/api/attachment/tool/...` 注册在每个 Sidecar 的 HTTP server 上。Sidecar
Owner 模型决定 attachments 由 sessionOwner sidecar 持有：

| Owner | attachment 写入位置 |
|---|---|
| Tab session | Chat Tab Sidecar 的 trusted root + 内存 registry |
| IM Bot session | IM Bot Sidecar 的 trusted root + 内存 registry |
| Cron / Background | 各自 owner Sidecar |
| 已有 Session 创建 / revive Sidecar | 启动时通过 SessionStore 反查 attachments，调 `rebuildAttachmentRegistryFromBlocks` 重 register |

**out-of-scope（本期不支持）**：A Sidecar 上的 renderer 跨进程 fetch B Sidecar 持有的
attachment。任何触发这种路径的入口视为 bug。

---

## 8. Codex Runtime parseNotification 改造矩阵

基于 Codex v0.128 `codex app-server generate-ts` 生成的 schema（`/tmp/codex-schema/v2/`），
本期补齐 9 个长期被丢弃的字段：

| Codex item.type | 修复内容 |
|---|---|
| `imageGeneration` | 优先 savedPath（零拷贝引用），fallback `result` base64 落盘；Managed `CODEX_HOME` 仅精确保护 `auth.json`，生成图路径可正常注册为 attachment URL |
| `mcpToolCall` | `result.content[]` 走 MCP ContentBlock union（text / image / audio / resource_link）；attachments 收集图片/音频 |
| `dynamicToolCall` | `contentItems[]` 处理 `inputImage{imageUrl}`；namespace / durationMs 透出 |
| `webSearch` | `action` union 全分支（search/openPage/findInPage/other），多 query 显示 |
| `commandExecution` | `commandActions[]`（已 parse 的 read/listFiles/search）+ source 透传 |
| `fileChange` | `status`（inProgress/completed/failed/declined）显式标 `declined`/`failed` 为 isError |
| `collabAgentToolCall` | 多 agent 协作工具卡（之前 default silent drop） |
| `plan` | started → thinking_start，delta 通过 `item/plan/delta` 走 thinking 渲染 |
| `enteredReviewMode` / `exitedReviewMode` / `hookPrompt` | 透出为 log 事件 |

内层 default 分支加 `console.warn` — Codex 升级新增 item 类型时不再 silent drop。

---

## 9. 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/types/tool-attachment.ts` | 类型 + 上限常量 |
| `src/server/runtimes/tool-attachments.ts` | `saveToolAttachment` 三入口 + in-flight tracker + external-path registry |
| `src/server/utils/path-safety.ts` | Node 镜像 Rust validate_file_path 黑名单 |
| `src/server/runtimes/codex.ts` | parseNotification 9 case 改造 + scheduleAttachmentSave |
| `src/server/runtimes/external-session.ts` | tool_result / tool_attachment_update event shell；session resume 重 register |
| `src/server/runtimes/external-session/content-blocks.ts` | tool_result attachments 的 streaming content state 与 pendingId patch target |
| `src/server/index.ts` | `/api/attachment/tool/<sid>/<tid>/<file>` endpoint |
| `src/renderer/utils/myagentsProtocol.ts` | Tauri custom-protocol URL 形态：macOS/Linux = `myagents://...`；Windows/WebView2 = `http://myagents.localhost/...` |
| `src/renderer/utils/toolAttachment.ts` | `useAttachmentUrl` hook + `resolveToolAttachmentUrl` |
| `src/renderer/components/tools/ToolAttachmentGallery.tsx` | 归一化容器 |
| `src/renderer/components/tools/ToolImageAttachment.tsx` | 单张图片渲染 + placeholder / error 状态 |
| `src/renderer/components/tools/ToolAudioAttachment.tsx` | 单条音频卡片播放器 + meta + 「更多」菜单（reveal / open-with-default，走 `sourcePath` + `useFileAction` workspace） |
| `src/renderer/components/Message.tsx` | per-BlockGroup Gallery 外挂（PRD 0.2.30，从 ToolUse 上提） |
| `src/renderer/context/TabProvider.tsx` | SSE 事件处理 + `mergeAttachmentsByPendingId` |

---

## 10. 后续 Phase（v0.2.16+）

- **P5（部分完成，PRD 0.2.30）— builtin 媒体接入**：内置 `edge-tts`（音频）/ `gemini-image`（图片）
  的产物已走 attachments。实现走**结果文本里的 `filePath`** 而非 SDK `content[]` image ContentBlock：
  `agent-session.ts::attachBuiltinMediaIfAny` 在顶层 `chat:tool-result-complete` 处调
  `runtimes/builtin-media-attachments.ts`（纯解析 `parseBuiltinMediaToolResult` + base64-copy 进
  trusted root），attachments 进 broadcast + 持久化到 `ToolUseState.attachments`。前端新增
  `ToolAudioAttachment`（卡片式播放器 + meta + 「更多」菜单 reveal/open-with-default）；
  `ToolAttachmentGallery` 补 `audio` case；`EdgeTtsTool`/`GeminiImageTool` 改 attachment-aware
  （有 attachments → 卡内只留 meta+路径，媒体交 gallery 在对话流就地露出；无 attachments → 旧内嵌渲染
  legacy fallback）；`TOOLS_THAT_OWN_GALLERY_PREFIXES` 已清空。
  - **P5 完成（#293 / 0.2.33）— SDK 通用 `content[]` image ContentBlock 归一化**：任意 builtin 工具
    （Playwright / computer-use 截图、产图类 MCP）的 `tool_result.content[]` 图片块（MCP `ImageContent`
    base64 / Anthropic source 块 / data-URL / file ref / 远程 url）由纯函数
    `utils/tool-result-attachments.ts::extractToolResultRenderParts` 提取为 attachment source，
    `runtimes/builtin-media-attachments.ts::saveExtractedToolResultAttachments` 落盘（与文件路径型媒体
    共用 `attachBuiltinMediaIfAny` 统一入口）；剩余文本里所有 base64-ish payload 脱敏为
    `[N bytes omitted]` — **session JSONL / SSE 从此只携带 path 引用，绝不进图片字节**（此前非
    Playwright 产图工具的 base64 会整段灌进 JSONL）。AI 侧 SDK transcript 不受影响（模型仍看得到图）。
    **存储位置**：base64 图片写进统一的工作区目录 `<workspace>/myagents_files/<工具名>/`（不同工具各自
    一个文件夹，沿用 edge-tts / gemini-image 的 `myagents_files/` 约定，首写自动 gitignore），作为
    `sourcePath`（工具卡「在 Finder 显示 / 打开」指向它）；同时保留一份 trusted-root 副本
    （`~/.myagents/generated/tool-attachments/<sid>/<tid>/`）作 `savedPath` 供重启后稳定渲染——
    即「工作区原件 + trusted 服务副本」双写，与 gemini-image 同构。无工作区（IM/cron）回退
    `~/.myagents/generated/<工具名>/`。`externalPath` / `url` 源保留各自 allow-list / SSRF 守卫的原位置。
    新增 `ToolAttachment.presentation: 'artifact' | 'process'`（仅 'process' 显式写入，缺省=artifact，
    老数据无需迁移）：artifact=交付物，Message.tsx 对话流内可见卡片（0.2.30 行为不变）；
    process=过程产物（`classifyToolAttachmentPresentation`：`mcp__playwright__*` / `mcp__computer-use__*` /
    `mcp__cuse__*` 前缀或工具名含 screenshot），渲染进 ProcessRow 展开体、折叠条显示图片角标——
    重度浏览任务几十张截图不再刷屏对话流。Playwright 结果**文本**照旧剥成哨兵。
  - **仍未做**：子 Agent 调用媒体工具的接入——subagent tool_result 的图片块会被**提取后丢弃**
    （不灌 base64 进 subagentCalls，文本里留 `[N image attachment(s) omitted]` 痕迹，
    `appendOmittedImageNote`），但尚未落盘成 attachment / 渲染进 TaskTool；PDF/file 渲染器（仍占位卡）。
    另注：脱敏覆盖的是**结构化字段**里的 base64（data/base64/b64_json/data-URL/长 base64 串），
    `text` 块的内文与纯字符串结果原样透传——MCP 服务器把 base64 塞进 text 正文属于罕见病态形态，
    未在防护面内。
- **Gemini / CC Runtime tool image**：协议层就位，对应 Runtime parseNotification 改造接入
- **IM Bot 媒体下发**：tool_result 转发链路消费 attachments，把图片送达 Telegram / 飞书 / 微信
- **GC / size limits**：session 软删除时清理 `~/.myagents/generated/tool-attachments/<sid>/`；
  per-session attachment 上限（500）+ oldest-first 淘汰
- **Node ↔ Rust 黑名单同步测试**：PRD 7.2 承诺的 cross-check 测试（防 Rust 改了 Node 没跟）
