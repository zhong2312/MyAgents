# 实验门控与功能入口诊断

使用场景：功能入口、设置项、Runtime、CLI 工具注册表或 Team Space 看不到。

先读 `/myagents-docs/references/settings-safety.md`。实验功能不可见通常是正常门控；只有满足门控后仍不出现才进入 Bug 诊断。

## 总原则

- 实验室开关需要用户在可见 UI 中主动开启，不通过 config 或内部 store 绕过。
- 区分“当前构建不包含能力”“实验开关关闭”“现场 readiness 不满足”“入口 render 异常”。
- 开关打开后，涉及 prompt/Skill/Runtime discovery 的能力可能需要新消息或新 Session；导航入口应按各自产品契约出现。

## 更多 Agent Runtime

- 设置：设置 → 关于&反馈 → 实验室 → 更多 Agent Runtime
- 字段：`multiAgentRuntime`，默认关闭
- 只门控 `runtimeSource=system-cli`；`codex-sub` 由 Provider readiness 管理

```bash
myagents runtime list --json
myagents agent show <agent-id> --json
rg -n "multiAgentRuntime|runtimeSource|managed-provider|codex-sub" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -120
```

## CLI 工具注册表

- 设置：设置 → 关于&反馈 → 实验室 → CLI 工具注册表
- 字段：`cliToolRegistryEnabled`，默认关闭
- 关闭时用户 CLI Tool 与 `tool-creator` 不注入；稳定内置 `myagents` CLI 不受影响

```bash
myagents tool --help
```

若关闭，help 只显示开启指引属于正常行为。开启后当前 Session 仍看不到工具描述时，再核对 Session 刷新边界和 tool registry sync。

## Team Space

Team Space 有两层可用性：

1. 当前 Tauri 构建必须包含 Space capability；不包含时设置会显示不可用原因。
2. 用户需在 设置 → 关于&反馈 → 实验室 打开 Team Space（字段 `teamSpaceEnabled`，默认关闭）。

```bash
myagents space list --json
rg -n "\\[space\\]|Team Space|space_build_capability|teamSpaceEnabled|not enabled in this build|requires a Tauri build" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -160
```

- build capability 不可用：这是发行构建能力边界，不应写 config 强开。
- capability 与开关均满足但标题栏/页面仍不出现：转 `frontend-render.md`。
- 入口出现但登录、数据或操作失败：转 `cloud-space.md`。

## 回答与验证

说明具体是哪一层门控、UI 入口和正常生效时机。如果用户当前目标可用稳定能力完成，可以给替代路径，但不要擅自开启实验功能。用户手动开启后，从原入口验证；仅看到字段变为 true 不算 UI 已恢复。
