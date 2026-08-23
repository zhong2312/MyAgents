# Claude Agent SDK Custom Tools Guide

> 技术文档：如何在 MyAgents 中使用 Claude Agent SDK 创建自定义 MCP 工具

## 概述

Claude Agent SDK 提供了 `createSdkMcpServer` 和 `tool` 函数，允许开发者创建内置的 MCP（Model Context Protocol）服务器，为 AI Agent 提供自定义工具能力。与外部 MCP 服务器不同，这些工具直接在应用进程内运行，无需启动额外的子进程。

这些 SDK wrapper 只属于 builtin Runtime。`runtime:'codex' + runtimeSource:'managed-provider'`
不会把 `createSdkMcpServer()` wrapper 当成跨 Runtime 协议，而是由
`managed-codex/extensions/host-dispatcher.ts` 通过标准 MCP `Client + InMemoryTransport`
连接 wrapper 内的同一 `McpServer` business handler，并把结果归一成 runtime-neutral
text/image/audio，再由 Codex adapter 映射到 `thread/start.dynamicTools` / 反向
`item/tool/call` wire。业务 handler 可复用，SDK wrapper 本身仍只属于 builtin 集成面。

## 当前工具清单

当前注册表包含用户可启用的 `gemini-image`、`edge-tts`，以及仅由受控
小说工作台会话装配的 `novel-workbench` SDK 适配器；IM Bridge 还会按渠道动态
创建自己的 SDK MCP。历史上的 `cron-tools`、`im-cron`、`im-media` 已在
0.2.11 退役，能力统一由 `myagents` CLI 提供，不能重新注册成 SDK MCP。

| MCP Server | Tool Name | 完整调用名 | 文件 | 注册条件 |
|------------|-----------|-----------|------|---------|
| `gemini-image` | image tools | `mcp__gemini-image__*` | `src/server/tools/gemini-image-tool.ts` | 用户启用 |
| `edge-tts` | speech tools | `mcp__edge-tts__*` | `src/server/tools/edge-tts-tool.ts` | 用户启用 |
| `novel-workbench` | 小说工作台内置业务工具 | `mcp__novel-workbench__*` | `src/server/tools/novel-workbench-tool.ts` | 工作台受控会话自动装配 |
| IM Bridge dynamic server | channel tools | 动态 | `src/server/tools/im-bridge-tools.ts` | 对应 IM Bridge 渠道启用 |

### 产品语义边界

`novel-workbench` 在产品层属于 MyAgents 小说工作台内置工具，不是用户 MCP。它不进入设置页、不允许用户开关，也不存在面向用户的 MCP 连接状态。这里的 `createSdkMcpServer()` 和 `mcp__` 前缀只是 Claude Agent SDK 接收进程内自定义工具的传输适配。模型提示、工具卡和错误文案必须使用“小说工作台内置工具”及具体业务动作，禁止要求用户检查 MCP 设置或恢复 MCP 连接。

### 工具注册位置

静态内置工具由 `src/server/tools/builtin-mcp-meta.ts` 登记轻量 META，
`buildSdkMcpServers()` 只在真正需要时通过 registry 加载实例。SDK 与 zod 必须留在
各工具 factory 的动态 import 内，不能在模块顶层 value-import。

```typescript
registerBuiltinMcpMeta({
  id: 'example-tool',
  load: async () => {
    const module = await import('./example-tool');
    return { server: await module.createExampleServer() };
  },
});
```

---

## 已退役：exit_cron_task MCP

`exit_cron_task` 不再是 SDK MCP。Task 执行时仍使用
`src/server/tools/cron-tools.ts` 保存最小的 per-session Task 上下文，但模型出口是
`myagents task exit --reason ...`（`cron exit` 保留兼容）。该命令只记录当前 Turn 的退出请求，不直接修改
Task 状态。

### 基本信息

| 属性 | 值 |
|------|---|
| **入口** | `myagents task exit --reason ...` |
| **文件** | `src/server/tools/cron-tools.ts` |
| **可用场景** | 仅在定时任务执行期间，且任务创建者启用了"允许 AI 退出" |

### AI 看到的 Description

```
End the current scheduled task. Call this tool when:
1. The task's goal has been fully achieved and no further executions are needed
2. You determine that continuing the task would be pointless or counterproductive
3. An unrecoverable error makes the task impossible to complete

The reason you provide will be displayed to the user in a notification.

IMPORTANT: This tool can only be used during scheduled task execution, and only if the task creator
has enabled "Allow AI to exit".
```

### 参数 Schema

| 参数 | 类型 | 必填 | 约束 | 描述 |
|------|------|------|------|------|
| `reason` | `string` | 是 | `min(1).max(500)` | A clear explanation of why the task should end. This will be shown to the user. |

### 上下文管理

使用 `Map<sessionId, CronTaskContext>` 管理，支持多任务并发隔离：

```typescript
setCronTaskContext(taskId, canExit, sessionId?)  // 任务执行前设置
clearCronTaskContext(sessionId?)                  // 任务 terminal cleanup 后清理（turn-lifecycle owner 自动调用）
```

### 执行流程

```
AI 调用 myagents task exit --reason ...
  → 验证 cronContext.taskId 存在
  → 验证 cronContext.canExit = true
  → Sidecar 记录当前 Session 的 exit request
  → /cron/execute-sync 在 Turn 结束时消费 request
  → Rust Task scheduler 在唯一终态事务中提交 Done
```

---

## 已退役：im-cron MCP

历史能力说明，仅用于理解旧会话和日志；当前 IM 定时任务调用
canonical `myagents task` CLI，最终写入 TaskStore；`myagents cron` 仅保留兼容。

### 基本信息

| 属性 | 值 |
|------|---|
| **Server** | `im-cron` |
| **Tool Name** | `cron` |
| **完整调用名** | `mcp__im-cron__cron` |
| **文件** | `src/server/tools/im-cron-tool.ts` |
| **可用场景** | IM Bot 会话中（Telegram / 飞书） |

### AI 看到的 Description

```
Create, list, update, remove, or manually trigger scheduled tasks.

Use this tool when the user wants to:
- Set a reminder ("remind me in 30 minutes")
- Create a recurring check ("check email every hour")
- Schedule a one-time task ("at 3pm, send me the weather")
- List/update/delete existing scheduled tasks
- View execution history of a task ("runs")
- Check overall task statistics ("status")
- Manually trigger a heartbeat check ("wake")

Schedules can be:
- "at": One-shot at a specific ISO-8601 datetime
- "every": Recurring at fixed intervals (minimum 5 minutes)
- "cron": Standard cron expression with optional timezone

The task runs independently in a new AI session. Results are delivered to this chat.
```

### 参数 Schema

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `action` | `enum` | 是 | `'list' \| 'add' \| 'update' \| 'remove' \| 'run' \| 'runs' \| 'status' \| 'wake'` — Action to perform |
| `job` | `object` | `add` 时必填 | 任务定义对象（见下方子字段） |
| `job.name` | `string` | 否 | Human-readable task name |
| `job.schedule` | `discriminatedUnion` | 是 | 调度类型，三选一（见下方 Schedule 定义） |
| `job.message` | `string` | 是 | The prompt/instruction for the AI to execute |
| `job.sessionTarget` | `enum` | 否 | `'new_session' \| 'single_session'` — Whether to create a new session each time (default) or reuse one |
| `taskId` | `string` | `update/remove/run/runs` 时必填 | Task ID |
| `patch` | `object` | `update` 时必填 | Fields to update. Use top-level keys, NOT nested inside "job". |
| `patch.name` | `string` | 否 | New task name |
| `patch.message` | `string` | 否 | New prompt/instruction text |
| `patch.schedule` | `schedule` | 否 | New schedule |
| `patch.intervalMinutes` | `number` | 否 | `min(5)` — New interval in minutes |
| `limit` | `number` | 否 | Max records to return (for "runs", default 20, max 100) |
| `text` | `string` | 否 | Optional text to inject as system event (for "wake") |

**Schedule 类型**（`discriminatedUnion('kind')`）：

| kind | 字段 | 示例 |
|------|------|------|
| `at` | `at: string` (ISO-8601) | `"2024-12-01T14:30:00+08:00"` |
| `every` | `minutes: number` (min 5) | `30` |
| `cron` | `expr: string`, `tz?: string` | `"0 9 * * *"`, `"Asia/Shanghai"` |

### 上下文管理

```typescript
setImCronContext({ botId, chatId, platform, workspacePath, model?, permissionMode?, providerEnv? })
// 每次 IM 消息到达时在 index.ts 的 /api/im/enqueue handler 中设置
```

### 执行流程

```
AI 调用 cron(action, ...)
  → Node.js handler (im-cron-tool.ts)
  → fetch http://127.0.0.1:{MANAGEMENT_PORT}/api/cron/{action}
  → Rust Management API handler (management_api.rs)
  → Cron compatibility facade → TaskStore / TaskSchedulerController
  → 返回结果给 AI
```

---

## 已退役：im-media MCP

历史能力说明，仅用于理解旧会话和日志；当前媒体发送统一调用
`myagents im send-media` CLI。

### 基本信息

| 属性 | 值 |
|------|---|
| **Server** | `im-media` |
| **Tool Name** | `send_media` |
| **完整调用名** | `mcp__im-media__send_media` |
| **文件** | `src/server/tools/im-media-tool.ts` |
| **可用场景** | IM Bot 会话中（Telegram / 飞书） |

### AI 看到的 Description

```
Send a file (image, document, audio, video, archive) to the current IM chat.

Use this tool when the user asks you to:
- Send a file, image, screenshot, or document to the chat
- Share a generated file (CSV, PDF, chart image, etc.)
- Upload and deliver media content

The file must exist on disk. Write it first with file tools, then call send_media.

Supported formats:
- Images: jpg, jpeg, png, gif, webp, bmp, svg (sent as native photo, max 10 MB)
- Documents: pdf, doc/docx, xls/xlsx, ppt/pptx, csv, json, xml, html, txt
- Media: mp4, mp3, ogg, wav, avi, mov, mkv
- Archives: zip, rar, 7z, tar, gz
- Files over 10 MB (images) or 50 MB (other) will be rejected.

Do NOT use this tool for intermediate work files — only for files the user explicitly wants to receive.
```

### 参数 Schema

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `file_path` | `string` | 是 | Absolute path to the file on disk |
| `caption` | `string` | 否 | Optional caption/description to send with the file |

### 上下文管理

```typescript
setImMediaContext({ botId, chatId, platform })
// 每次 IM 消息到达时在 index.ts 的 /api/im/enqueue handler 中设置（紧随 setImCronContext 之后）
```

### 执行流程

```
AI 调用 send_media(file_path, caption?)
  → Node.js handler (im-media-tool.ts)
  → POST http://127.0.0.1:{MANAGEMENT_PORT}/api/im/send-media
  → Rust handler (management_api.rs)
    → get adapter from ManagedImBots[botId]
    → tokio::fs::read(file_path)
    → MediaType::from_extension(ext) 判断类型
    → Image: adapter.send_photo() (max 10 MB)
    → File: adapter.send_file() (max 50 MB)
    → NonMedia: 返回错误
  → HTTP 200 { ok, fileName, fileSize }
  → AI 收到工具执行结果，告知用户发送成功/失败
```

### 文件类型映射

| MediaType | 扩展名 | 大小限制 | 发送方式 |
|-----------|--------|---------|---------|
| `Image` | jpg, jpeg, png, gif, webp, bmp, svg | 10 MB | `adapter.send_photo()` — 平台原生图片 |
| `File` | pdf, doc/docx, xls/xlsx, ppt/pptx, mp4, mp3, ogg, wav, avi, mov, mkv, zip, rar, 7z, tar, gz, csv, json, xml, html, txt | 50 MB | `adapter.send_file()` — 平台原生文件 |
| `NonMedia` | 其他（如 .py, .rs, .ts 等代码文件） | — | 拒绝发送，返回错误 |

---

## 核心 API

### Runtime 暴露边界

| Runtime | 进程内 MCP 暴露方式 | 权限与生命周期 |
|---|---|---|
| builtin Claude Agent SDK | `createSdkMcpServer` / `tool` → `Options.mcpServers` | SDK `canUseTool`、hooks 与 Query generation |
| Managed Codex | 标准 MCP in-memory client → Host dispatcher → dynamic tool | 既有 external permission UI；call/turn/process generation 的 AbortSignal、timeout 与 exactly-once 结算 |
| system-cli external Runtime | 不注入 MyAgents in-process MCP | 由用户自己的 Runtime 配置持有 |

Managed Codex Host catalog 在 native thread 出生时冻结；同 fingerprint 才允许 resume，目录变化要求新建 Product Session。Dispatcher 的 `dispose()` 必须随 process stop/reset/crash 释放连接，旧 generation 的晚到 call 不得执行。新增工具仍先在现有 builtin registry 或 IM Bridge owner 中实现业务 handler，不得在 Codex adapter 复制一份实现。

### 1. createSdkMcpServer

创建一个内置的 MCP 服务器实例。

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

const myServer = createSdkMcpServer({
  name: 'my-tools',          // 服务器名称（用于工具命名）
  version: '1.0.0',          // 版本号
  tools: [                   // 工具定义数组
    // ... tool() 定义
  ]
});
```

### 2. tool() 函数

定义单个工具的 helper 函数，提供类型安全的参数验证。

```typescript
import { z } from 'zod/v4';  // 必须使用 zod/v4

tool(
  'tool_name',               // 工具名称（snake_case）
  'Tool description',        // 工具描述（告诉 AI 何时使用）
  {                          // Zod schema 定义输入参数
    param1: z.string().describe('参数说明'),
    param2: z.number().optional()
  },
  async (args) => {          // 工具处理函数
    // args 的类型由 schema 推断
    return {
      content: [{
        type: 'text',
        text: '工具执行结果'
      }]
    };
  }
)
```

## 工具返回格式

工具处理函数必须返回符合 MCP `CallToolResult` 格式的对象：

```typescript
type CallToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;  // 可选：标记为错误响应
};
```

### 成功响应示例

```typescript
return {
  content: [{
    type: 'text',
    text: '操作成功完成'
  }]
};
```

### 错误响应示例

```typescript
return {
  content: [{
    type: 'text',
    text: 'Error: 操作失败的原因'
  }],
  isError: true
};
```

## 工具命名约定

当工具注册到 SDK 后，其完整名称遵循以下格式：

```
mcp__{server-name}__{tool-name}
```

例如：服务器名 `my-tools`、工具名 `my_action` 对应
`mcp__my-tools__my_action`。

这个命名格式用于：
- `allowedTools` 配置
- `canUseTool` 回调中的工具名判断
- 日志和调试

## 集成到 Agent Session

### 1. 创建工具服务器文件

在 `src/server/tools/` 目录下创建工具定义文件：

```typescript
// src/server/tools/my-tools.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

export const myToolsServer = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [
    tool(
      'my_action',
      '执行自定义操作',
      { input: z.string() },
      async (args) => {
        // 实现逻辑
        return { content: [{ type: 'text', text: `处理: ${args.input}` }] };
      }
    )
  ]
});
```

### 2. 在 agent-session.ts 中注册

```typescript
// agent-session.ts
import { myToolsServer } from './tools/my-tools';

function buildSdkMcpServers(): Record<string, SdkMcpServerConfig | typeof myToolsServer> {
  const result: Record<string, SdkMcpServerConfig | typeof myToolsServer> = {};

  // 条件性添加工具服务器
  if (shouldEnableMyTools) {
    result['my-tools'] = myToolsServer;
  }

  // 其他 MCP 服务器配置...

  return result;
}
```

### 3. 传递给 query() 函数

```typescript
querySession = query({
  prompt: messageGenerator(),
  options: {
    mcpServers: buildSdkMcpServers(),
    // 其他选项...
  }
});
```

## 上下文管理模式

确有 Turn-scoped 上下文的动态工具可以使用**模块级变量 + setter/getter** 模式，
但上下文必须随 queue item 在 promotion 时绑定、terminal 时清理，不能在请求入队时
提前覆盖当前 Turn：

```typescript
// 模块级状态
let context: SomeContext | null = null;

export function setContext(ctx: SomeContext): void { context = ctx; }
export function getContext(): SomeContext | null { return context; }
export function clearContext(): void { context = null; }
```

历史 `cron-tools` / `im-cron` / `im-media` 的请求级单例模式已经退役；不要把它们
作为新工具的架构样板。

## 工具权限控制

### 使用 canUseTool 回调

可以通过 `canUseTool` 回调精细控制工具权限：

```typescript
canUseTool: async (toolName, input, options) => {
  // 检查是否是 MCP 工具
  if (toolName.startsWith('mcp__')) {
    // 提取服务器名和工具名
    const parts = toolName.split('__');
    const serverName = parts[1];
    const actualToolName = parts[2];

    // 自定义权限逻辑
    if (serverName === 'my-tools' && !isFeatureEnabled) {
      return { behavior: 'deny', message: '功能未启用' };
    }
  }

  return { behavior: 'allow', updatedInput: input };
}
```

### 使用 allowedTools 配置

在 query options 中指定允许的工具：

```typescript
query({
  options: {
    allowedTools: [
      'mcp__my-tools__my_action',         // 允许特定工具
      'mcp__my-tools__*',                  // 允许服务器下所有工具
    ]
  }
});
```

## 最佳实践

### 1. 工具描述要清晰

工具描述是 AI 决定是否使用该工具的关键信息：

```typescript
tool(
  'my_tool',
  `简明扼要的功能描述。

何时使用此工具：
1. 场景一
2. 场景二

注意事项：
- 限制条件
- 前置要求`,
  // ...
)
```

### 2. 参数验证要严格

使用 Zod 的验证能力确保输入合法：

```typescript
{
  url: z.string().url().describe('必须是有效的 URL'),
  count: z.number().int().min(1).max(100),
  mode: z.enum(['fast', 'slow']).default('fast')
}
```

### 3. 错误处理要友好

```typescript
async (args) => {
  try {
    const result = await doSomething(args);
    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return {
      content: [{ type: 'text', text: `操作失败: ${message}` }],
      isError: true
    };
  }
}
```

### 4. 状态管理要安全

如果工具需要访问外部状态，使用模块级变量或注入依赖：

```typescript
// 模块级状态
let state: SomeState | null = null;

export function setState(newState: SomeState) {
  state = newState;
}

// 工具内使用
async (args) => {
  if (!state) {
    return { content: [{ type: 'text', text: 'Error: 状态未初始化' }], isError: true };
  }
  // 使用 state...
}
```

## 调试技巧

1. **查看工具注册日志**：`buildSdkMcpServers` 会输出 `[agent] Added xxx MCP server` 日志
2. **检查工具调用**：在 `canUseTool` 回调中记录工具调用
3. **验证参数**：在工具处理函数开头记录收到的参数
4. **SSE 事件跟踪**：监听 `chat:tool-use` 事件查看工具调用详情
5. **内置工具调试**：查看 `~/.myagents/logs/unified-{today}.log`，搜索对应 MCP server id

## 相关文档

- [Claude Agent SDK 官方文档](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [MCP 协议规范](https://modelcontextprotocol.io)
- [Zod v4 文档](https://zod.dev)
- [IM Bot 集成架构](./im_integration_architecture.md)
- [代理配置](./proxy_config.md)
