# MyAgents CLI validation

## 2026-08-11：`dev/0.4.7` CLI authority 审计

### 已确认的设计与验证

- 审计对应的核心提交为 `b138563b fix(cli): eliminate stale home payload authority` 与 `f75b5d8f docs(architecture): align CLI bundle authority`。
- 当前 App bundle 是 CLI 业务代码的唯一 authority；`~/.myagents/bin/myagents{,.cmd}` 仅为回跳当前 App 的确定性薄启动器，不再维护独立 HOME payload 或 `.cli-version`。
- 实机确认 App bundle 与构建 staging 的 `myagents.cjs` 哈希一致，启动器参数、stdin/stdout、cwd、exit code、PATH 优先级和 `--port` 覆盖行为正常。
- 定向验证通过：build-script 4/4、CLI/shell unit 82/82、Agent/Session env integration 17/17、Rust CLI 13/13、TypeScript typecheck、ESLint、bundle build 与 `git diff --check`。
- 覆盖的真实 CLI surface 包括 status/version/reload、MCP、Model、Agent/Channel/Runtime/Session、Task/Cron/Goal/Thought、Space/IM/Vision、Skill/Tool/Plugin/Config/Widget。持久写入类能力使用 dry-run 或无效 ID，未留下测试资源。

### 发现项与当前状态

| Issue | 发现 | 2026-08-16 状态 |
|---|---|---|
| #531 | 普通终端经 Global Sidecar 调用 `status`/`reload` 返回 `Not Found` | `COMPLETED`；owner 说明 `status` 已改为 common，`reload` 保持 Session-only 并返回恢复指引 |
| #532 | 未认证 Gemini discovery 触发登录，中断后可能遗留 orphan `gemini --acp` | `COMPLETED`；owner 说明已增加非交互鉴权前置检查、AbortSignal 贯穿和有界进程树清理 |
| #533 | `agent runtime-status` 对在线 Channel 返回 `uptimeSeconds: 0` | `COMPLETED`；owner 说明已改为从 live instance `started_at` 计算 |
| #534 | `mcp add`、`model add`、`config set` 的 leaf help 未披露已支持的 `--dry-run` | `COMPLETED`；owner 说明已补精确 leaf help 与回归测试 |
| #535 | 文档声称 Cron 支持 `get`，实际 surface 不提供 | `COMPLETED`；决策为不新增 `cron get`，详情统一走 canonical `task get`，文档已同步 |
| #536 | `model verify` 对订阅型 Provider 错走 API-key 校验 | `COMPLETED`；owner 说明已按 effective provider catalog 与 subscriptionAuth owner 分流 |
| #537 | 未知 CLI group/leaf 仅返回后端 `Not Found` | `COMPLETED`；owner 说明已在发请求前校验 grammar 并提供结构化恢复提示 |

以上“已修复”状态来自 GitHub owner 的关闭说明；本次记忆审计未独立复测当前 `dev/0.4.9`。若相关行为再次出现，先按 Issue 中的最小复现回归，再判断是否重开。

### 实机测试边界

- Runtime model discovery 可能启动外部 CLI、打开浏览器或进入登录，即使入口名为 `describe`。测试前先检查凭据/非交互 auth evidence；无凭据时验证 guard 与错误恢复，不进入登录。
- 发现外部 Runtime 中断后残留进程时，只在确认 PID、命令行、启动时间与父子关系后清理精确目标，不使用宽泛 kill。
