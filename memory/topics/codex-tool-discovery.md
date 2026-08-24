# Codex tool discovery

## 当前 Session 的 effective tool surface

- `functions.exec` 内的 `ALL_TOOLS` 是当前 Session 可发现 nested tools 的权威目录，条目至少包含 `name` 和 `description`；对应工具通过 `tools.<name>(args)` 调用。
- 系统提示中完整展开的 tool declarations 可能只是子集。未展开的 deferred nested tools 仍可能已经在当前 Session 可用，因此不能用“静态声明中出现的工具”代表完整清单。
- 回答“当前上下文注入了哪些工具”时，先枚举 `ALL_TOOLS`，再按 namespace 分类：`mcp__*` / `myagents__mcp__*` 是 MCP 业务工具，`view_image` 等是原生工具，`mcp__codex_apps__*` 属于 App/Connector 暴露的 MCP surface。通用 MCP resource API 应与具体 Server 的业务工具分开计数。
- `myagents mcp list` 回答的是配置层 desired state，不等于既有 Session 固化的 effective tool snapshot；UI 开关也不能单独证明模型本轮实际可调用的 surface。

## 交互经验

- 用户明确问“你上下文里有什么”时，保持问题在执行层，不主动转成产品能力介绍或配置审计。若第一次依据不足，先查当前 tool registry，再给数量与分类。
