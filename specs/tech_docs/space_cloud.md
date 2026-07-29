# MyAgents Cloud Space 架构

## 定位

Cloud Space 是桌面端连接 MyAgents 官方/团队空间的客户端能力。0.3.0 起作为实验室功能随客户端发布，默认关闭，用户需在「设置 → 关于&反馈 → 实验室」显式开启；它应写入 CHANGELOG 与 GitHub Release notes，但不视为默认稳定入口。

它不是 AI Runtime，也不属于 Session Sidecar：登录、Issue/Skill/Agent 注册、附件上传下载、IssueDelivery 拉取都由 Rust Tauri command 拥有；React 只负责 UI 编排；CLI 通过 management API 暴露 issue/attachment/claim 子集给 Agent 自动化使用。

## 文档归属与兼容基线

Cloud Space 横跨两个独立版本、独立发布的仓库，不能把其中一边的文档当成全部真相：

| 范围 | 权威位置 |
| --- | --- |
| Desktop build gate、Rust HTTP/session、`device_id`、本地 token/状态、connector、UI、CLI、Task/Session 执行 | `hAcKlyc/MyAgents`：本文 + `specs/ARCHITECTURE.md`「MyAgents Cloud Space」 |
| Cloud API、身份/权限、领域模型、D1/R2/KV ownership、Account plan/quota、运营与发布 | `hAcKlyc/MyAgents_space`：`specs/ARCHITECTURE.md` + `specs/RELEASE.md` |
| Space IssueDelivery Prompt、Registered Agent context/instruction、拼接与版本规则 | `hAcKlyc/MyAgents`：`specs/tech_docs/space_issue_delivery_protocol.md` |

本地平级 checkout 中，云端架构文档地址是 `../MyAgents_space/specs/ARCHITECTURE.md`。截至 2026-07-22，0.3.2 联合发布基线为：

- Desktop：`dev/0.3.2` 源码实现 Registered Agent execution instance、Instruction、多 Subscription、v2 Prompt 与 exact Session origin；尚未发布。
- Cloud：`MyAgents_space` v0.1.6（`main-0fc6112f77904b197e5ffa1e61aedf5bd2d82116`）已部署 Production，包含 additive migration `0018`、Instruction/CAS、transport-only Delivery 与 v0/v1/v2 response projection；Production release workflow、公开 `/health` 与 100% traffic 验证均已通过。
- Production/Dev 的实时部署真相仍只以各环境 `/health` 返回的 Git tag、完整 SHA 与 Worker Version ID 为准，不能从本地源码状态推断已经上线。

发布兼容按 `X-MyAgents-Client-Version` 三档投影：缺失/非法/`<0.2.50` 只返回 legacy subscription；`>=0.2.50 && <0.3.2` 返回 v1 `deliveryKind/cloudInstruction/trigger/...`，由旧 Desktop 本地组装旧 Prompt；`>=0.3.2` 返回 v2 package，由新 Desktop 严格解析并本地组装 v2 Prompt。Cloud 不下发完整 Prompt，新 Desktop 不保留 v1 builder。Cloud migration/Worker 与三档 smoke 已先通过，当前下一步是发布 Desktop 0.3.2；这只是同一协调上线的依赖顺序。

这个组合是兼容记录，不是版本绑定。当前 API 没有 URL version prefix；双方通过 additive response、缺省字段 fallback 和 rollout 兼容旧调用方。修改 API 字段、错误码、状态机、permission、poll/presence 或兼容策略时，必须同步更新 Space serializer/tests/架构文档与本仓 types/wrapper/tests/本文。只改 Desktop UI 或本地执行且云端契约不变时，不要把客户端细节复制进云端文档；只改 Worker 内部实现且无契约变化时也不要求改本文。

## 构建门控

Space 是 build-time capability：

- `src-tauri/build.rs` 读取环境变量或仓库根 `.env`，仅转发 `MYAGENTS_SPACE_*` 白名单。
- `MYAGENTS_SPACE_ENABLED=true` 时必须提供 HTTPS 且不带 path/credential 的 `MYAGENTS_SPACE_BASE_URL`；build/runtime 校验会移除 query/fragment 并注入规范化后的 origin。
- debug 构建可以额外烘焙 `MYAGENTS_SPACE_DEV_BASE_URL`。release profile 会在 `build.rs` 中无条件丢弃 Dev origin，因此生产二进制不能暴露 Dev 服务开关。
- `cmd_space_get_capability` 返回 `{available, baseUrl, publicClientId, reason, environments, activeEnvironment}`，只代表构建能力与 Rust 当前选中的 build-time origin；前端还必须叠加 `config.teamSpaceEnabled === true`（默认关闭）才展示实验室 Team Space 入口。
- `config.spaceEnvironment` 只能写入烘焙的 `production` / `dev` origin，默认 `production`。旧值 `staging` 只作为读取兼容 alias：debug 构建包含 Dev origin 时映射到 `dev`，release 构建仍回落 Production。Renderer 不提供自由 URL 输入；所有云端请求仍从 Rust `space_build_capability()` / `space_base_url()` 单一咽喉读取当前 origin。
- 缺少能力时，Space UI 不应降级为硬编码 URL；所有云端请求必须经 Rust 能力检查。

### Dev/Test mock data mode

Phase 2 为本地验证和自动化测试新增了显式 mock mode：

- debug/test build 中运行时设置 `MYAGENTS_SPACE_MOCK_DATA=true` 时，`space_build_capability()` 返回可用能力，baseUrl 为 `https://space.mock.myagents.local`。release build 中该环境变量被忽略。
- mock mode 仍然由 Rust Space 边界拥有：renderer 继续只调用 `src/renderer/api/spaceCloud.ts`，Tauri command/CLI helper 继续走 `src-tauri/src/space_cloud.rs`，不会在 React 组件里塞假数据。
- mock mode 使用进程内 deterministic 数据集，覆盖 Goals、Issues、评论、附件、Skills、Skill 文件、Registered Agents、IssueDelivery 与 claim。mutation 会更新同一份 in-memory state，便于验证创建/评论/状态/claim/complete 等交互。
- mock mode 不读写真实 `~/.myagents/space/session.json`，不访问 `space.myagents.io`，不作为发布能力写入 CHANGELOG 或 Release notes。
- mock mode 只用于 dev/test。生产构建仍以 `MYAGENTS_SPACE_ENABLED` / `MYAGENTS_SPACE_BASE_URL` / public client id 的 build-time capability 为准。

## 模块边界

| 层           | 文件                                                          | 职责                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust         | `src-tauri/src/space_cloud.rs`                                | Space session、HTTP proxy、registered agents、IssueDelivery poll/process、claim wrapper、Skill zip、附件上传下载                                                                                                                                                                                                                   |
| Renderer API | `src/renderer/api/spaceCloud.ts`                              | Tauri invoke typed wrapper；不直接 `fetch` Space 服务                                                                                                                                                                                                                                                                              |
| Renderer UI  | `src/renderer/pages/Space.tsx` + `src/renderer/pages/space/*` | Space shell 与 Issues / Skills / Agents 三个 workspace，登录轮询、创建/评论/Goal 订阅、Skill 安装、本地缓存                                                                                                                                                                                                                        |
| CLI          | `src/cli/myagents.ts` + Sidecar Admin API + Rust Management API | 每个业务命令显式 `--space <slug>`；Sidecar 从当前 project 补 stable workspace id，Rust 单点解析 User/Registered Agent actor 和 token。支持 list/whoami/Goal/assignee discovery、Issue create/read/metadata update/comment/claim/complete、top attachment add/download；CLI 不接受显式 actor/token |

### CLI Goal discovery 与 Issue 元数据更新

- `space goal list` 与 Issue mutation 共用 `SpaceCliContext` 的 resolved actor。Registered Agent token 必须同时通过 route Space 与 `X-MyAgents-Space-Context` 校验；binding 或 scope 失配直接失败，不能改用 User token 重试。默认只返回 active Goal，`--include-archived` 仅用于诊断。
- `space issue update` 是既有 Cloud `PATCH /api/issues/:id` 的薄适配，只允许 title/body/goal/humanOnly。CLI/Rust 以 `{action:'set',goalId}` / `{action:'clear'}` 保留“不变 / 设置 / 清除”三态，仅在 Rust Cloud adapter 组 PATCH body 时把 clear 翻译为 `goalId:null`。
- state、assignee、claim、comment、attachment 不进入 generic update。成功响应返回权威 Issue detail；Goal update/clear 沿用 Cloud 的 active same-Space Goal 校验、权限、update event/delivery 与 notificationVersion 语义。
- Space mutation 当前没有 preview API。CLI 遇到 `--dry-run` 会在端口发现、HTTP 和 workspace 文件 IO 前返回 `DRY_RUN_UNSUPPORTED`，不得把拒绝描述成已预览。

## Cloud Worker 容量与一致性不变量

`MyAgents_space` 是 Cloud Space 的服务端 counterpart；桌面端只消费它暴露的 API，不在客户端重建服务端策略。

- D1 访问统一走 `src/services/db.ts::db(...)` / `createPrimaryDb(...)` facade。请求路径使用 D1 Sessions API 维护 bookmark，并通过 `x-d1-bookmark` header 回传；`first/all/raw` 只对瞬态读错误做一次短重试，`run/batch` 写路径不做自动重试，避免重复写入。
- Worker `wrangler.jsonc` 开启 Smart Placement、Observability、Rate Limiting binding 与 scheduled prune。`src/services/prune.ts` 定期清理已结束的 `issue_deliveries` 以及历史 `space_events` / `issue_updates`；保留期与批大小由 `SPACE_DELIVERY_RETENTION_DAYS`、`SPACE_EVENT_RETENTION_DAYS`、`SPACE_PRUNE_BATCH_SIZE`、`SPACE_PRUNE_MAX_BATCHES` 控制。
- Desktop OAuth handoff 必须由 D1 `desktop_login_sessions` 拥有，不能用 Cloudflare KV。浏览器 callback 写入 `done` 后，桌面端 poll 需要跨浏览器/客户端边缘节点立即读到同一状态；KV 的最终一致传播窗口会把“浏览器已成功”放大成约 1 分钟的客户端等待。
- Space 业务统计事实由 `MyAgents_space` 拥有：只读 admin endpoints 位于 `/api/admin/dashboard/*`，通过 `SPACE_ADMIN_API_KEY` bearer secret 做 Worker-to-Worker 鉴权，供 `MyAgents_web` admin proxy 消费。`MyAgents_web` 不直接绑定或查询 Space D1；它只负责 Web admin auth、缓存、UI 以及客户端 analytics `space_*` 事件查询。
- Space 运营写能力位于 `/api/admin/operations/*`，使用独立 `SPACE_OPERATIONS_API_KEY`，由 `myagents.io/admin` 的同源 server proxy 注入可信 operator email。账号 Pro grant/regrant/extend/revoke、独立 Space entitlement set/remove、只读权益矩阵与 append-only audit 都由 Space Worker 拥有；Website 不复制会员或 quota 判定。
- `agg_space_global_day` 是 Space 全局规模趋势 snapshot 表，由 scheduled cron 写入；`GET /api/admin/dashboard/overview` 必须保持读路径，不在请求中 materialize/重写历史 snapshot。当天 current metrics 可作为 response 内存 partial point 合并，不能把读请求变成 rollup owner。
- delivery fanout/backfill 只能先用固定查询选出订阅/Issue，再由 JS 生成 delivery id 后 batch `INSERT OR IGNORE`。不要为了每个订阅或每个 Issue 发散成 N 次查询，也不要把 delivery id 生成塞回 SQL 表达式。
- `/api/registered-agents/me/deliveries` 是读路径：根据 token 识别 registered agent，读取 pending delivery，附带 `poll` 提示；它不更新 device `last_seen`，也不在 poll 中写入心跳。
- connector 在线状态使用独立 `POST /api/registered-agents/me/device-presence`。服务端只能从 active registered-agent token 派生 owner/device，body 不接受自报身份；touch 更新 `user_devices.connector_last_seen_at/connector_online_until`，不写 `space_events`。
- `src/services/pollPolicy.ts` 是服务端 poll 策略数字的唯一 owner。客户端传 `emptyStreak`，服务端根据 returned count、空轮询次数、active claim 与可选 `SPACE_POLL_*` 环境变量返回 `poll.nextAfterSeconds` / `reason`。客户端只负责 clamp、jitter、错误退避与执行，不复制策略阈值。
- active claim 快路径依赖 `issue_claims(actor_type, actor_id, status)` 索引；如果 claim 查询语义变化，必须同步检查迁移与 poll policy。

## Device / Registered Agent 身份模型

Space 不创建第二套“云端 device id”。本地端点身份的唯一值是既有 `~/.myagents/device_id`：

- Rust owner：`src-tauri/src/device_identity.rs`，负责读取/创建 `device_id`，并提供设备名、platform、OS version、app version。首次创建必须通过 `~/.myagents/device_id.lock` 串行化，避免 Analytics 与 Space 并发启动时生成不同 ID。
- Renderer owner：`src/renderer/identity/deviceIdentity.ts`，只做 typed invoke/cache；Analytics 和 Space 共同消费这一层。
- Analytics 事件中的 `device_id` 口径不变，仍是同一个 `~/.myagents/device_id`。

云端需要一个 `user_devices` 概念/表，主键语义为 `(userId, deviceId)`：

- 必备字段：`userId`、`deviceId`。
- 设备摘要字段：`deviceName`、`platform`、`osVersion`、`appVersion`、`status`、`lastSeenAt`。其中普通 `lastSeenAt` 只表示账号/设备活动，不得解释为 connector 在线。
- connector presence 字段：`connectorLastSeenAt`、`connectorOnlineUntil`。Registered Agent projection 只返回服务端判定的 `presence: online|offline`、`lastOnlineAt`、`onlineUntil`；Renderer 不复制 lease 数字或自行用时钟重算 online。
- 登录/授权完成后，客户端尝试调用 `/api/devices/upsert` 写入当前 `user_devices` 记录；为兼容桌面端与云端部署顺序，该调用失败不阻塞 Space 登录。客户端 auth poll / session read 路径必须把该 upsert 作为后台 best-effort，不能同步 await 到 UI 登录完成之前。
- `cmd_space_register_agent` / `cmd_space_update_registered_agent` payload 同时携带 `deviceId`、`deviceName`、`platform`、`osVersion`、`appVersion`，服务端必须在 registered-agent mutation 中同步维护 `user_devices`，不能只依赖 bootstrap upsert。

Registered Agent 是“执行实体”，不是设备本身：

- 归属字段：`ownerUserId` + `deviceId`。Registered Agent 是执行实例；同一设备、同一 user、同一 Space、同一 workspace 也可以登记多个实例，每个实例拥有独立 id/token、Instruction、Subscription 集合与 Session binding，quota 仍按实例计数。
- `instruction + instructionRevision` 是实例长期“目标与指令”的 Cloud 权威；新登记必填 1–20,000 Unicode code point，编辑使用 revision CAS。Subscription 只定义唤醒范围，不复制 Instruction。
- 本地工作区绑定字段：`localWorkspaceId`、`localAgentId`、`workspacePath`、`workspaceLabel`。这些字段描述的是该设备上的本地 Agent 工作区，只能在登记它的那台设备上修改。
- 展示字段：registered-agent list/detail 必须返回 `deviceId` 与 `device` 摘要，renderer 用它展示“本地电脑 / 平台 / 系统版本 / 客户端版本 / last seen”。
- 在线 owner 是维护 harness 的 MyAgents 客户端/设备，不是单个 Agent 工作区。同一 owner+device 下的 active Agent 继承同一 presence；disabled 始终优先显示“已停用”。
- Local 判定只能用 `ownerUserId === current session user id && deviceId === current ~/.myagents/device_id`。禁止用 `clientId`、hostname、是否存在本地缓存记录来推断 local。

Registered Agent 执行请求是 token-only capability：

- 本地轮询 delivery/dispatch 时只带 registered-agent token，服务端由 token 映射出 user / space / device / registered-agent 权限边界。
- MyAgents Desktop 默认 token selector 只消费“当前 Space user + 当前 device_id”的本地 token 集合。
- token 存储仍在 `registered_agents.json`，但 token 对外不可见；renderer 只能看到 redacted public view。
- 第三方/未来客户端接入时也只需要 token，不需要额外提交 userId/deviceId 参与鉴权；user/device 是服务端 token 记录的一部分。

## 本地状态

Space 本地状态由 Rust `space_data_dir()` 按当前环境选择：

- production 保持兼容路径 `~/.myagents/space/{session.json,registered_agents.json,delivery_log.json}`。
- Dev 使用 `~/.myagents/space/dev/{session.json,registered_agents.json,delivery_log.json}`；旧 `space/staging` 数据不自动复制或删除，用户在全新 Dev 环境重新登录。
- `session.json` — 云端 session token 与用户/accountPlan/space/membership 摘要；Rust 对外只返回 redacted public view。
- `registered_agents.json` — 本机注册到 Space 的 Agent 映射，包含本地 workspace path、`ownerUserId`、`deviceId`、设备摘要、订阅状态与云端 token。
- `delivery_log.json` — 已注入 IssueDelivery 的稳定 transport receipt/audit；它只用于 ACK 重放，不参与 CLI actor 推断。connector 每轮 poll 前重放尚未完成的 Cloud ACK，单条 ACK 失败不阻塞其它 receipt 或本轮 poll。

这些文件属于桌面客户端状态，不进入 SessionStore，也不由 Sidecar 管理。

全局 Skill 安装路径不属于 Space 服务环境状态，始终是 `~/.myagents/skills`；不能从环境化后的 `space_data_dir()` 反推。

Renderer `spaceStore` 的缓存身份必须至少包含服务 origin。production/Dev 都可能使用 `official` slug，切换环境时即使 slug 不变也必须清掉 issue/skill/agent/event 缓存，避免旧环境数据被拿来驱动新环境 API。

Renderer 加入 Space 时先以本地 session 的已加入列表按规范化 slug 去重；命中后不发送 join mutation，直接提示并切换到目标 Space 的 Issues。未命中才请求 Cloud：加入期间保留当前页面，只在加入弹窗内展示 loading；`joined` 后把 mutation 返回的 Space / membership 先写入本地列表投影，再复用同一导航路径进入默认 Issues，`pending` 只提示申请已提交。

Space 切换属于 Renderer 导航状态，不是 Cloud mutation。点击已加入 Space 的子导航时，必须在第一个 `await` 前用 `session.spaces` 已有的 Space / membership 同步提交 active Space、目标 tab 与目标页 loading；不得等待 `/api/me` 或 Space detail bootstrap 后才高亮。切换会清掉当前 Space 的非隔离数据并由目标 workspace 自己请求，应用外壳和 session 始终保留，不进入全页 boot loading。`lastActiveSpaceId` 仅作为后台持久化副作用串行落盘，快速连续切换以最后一次意图为准；持久化或 collection 请求失败不得把用户回滚到旧 Space。Rust 把 active Space 的 read-modify-write 放在同一文件锁内，任何较早开始的 Cloud session refresh 在提交时都必须保留磁盘上更新的 `lastActiveSpaceId`，禁止迟到 `/api/me` 覆盖新导航。Renderer/Rust 之间的 active-Space 写入必须携带当前 session 的 opaque binding 并在锁内核对，避免退出后已发出的旧请求污染同源新账号；logout 则先同步清空 Renderer 状态与队列、锁内删除本地 session，再使用删除前的 token 尝试远端注销，远端延迟或失败不得恢复本地身份。

Space 头像是产品/组织身份，所有尺寸统一使用 APP icon 式圆角矩形；User 与 Registered Agent 是主体身份，继续使用圆形头像。两类形态不得混用。

Space 侧栏中的多个 Space 是同级导航实体，必须按服务端列表顺序渲染为一级手风琴项；每项都可在本地展开 Issues / Goals / Skills，以及按该 Space membership 权限展示的 Settings，且同时最多展开一个。展开/折叠只修改 Renderer UI 状态，不请求接口，也不改变当前 Space；只有点击某个子导航时才原子切换到对应 Space 与页面。其它 Space 不得嵌入当前 Space 的展开容器伪装成子级。

Space 页面各 workspace 的数据加载必须显式以 active Space identity 为依赖，不能依赖 boot loading→ready 的视觉状态跃迁来间接触发；静默切换保持页面可见时，目标 Space 的 Issues / Goals / Skills / Settings 仍必须主动加载并收口自己的 loading 状态。各 collection 的 freshness 必须由该 collection 在当前 active Space 投影内独立持有；不得复用 session/bootstrap 的刷新时间，否则切换时清空 collection 后会被旧 owner 的 boot freshness 错误拦截。

Space 侧栏的加入方式副标题必须通过 i18n 显式映射领域值：`open_join` 显示“开放加入”，`approval_required` 显示“需审核加入”；未知值显示本地化兜底文案，禁止把原始技术 token 转空格后直接暴露给用户。

Legacy 兼容规则：

- 旧 `registered_agents.json` 缺 `deviceId` 时，Rust 只在该记录已经有 `ownerUserId === current Space session user id` 的情况下补为当前 `~/.myagents/device_id`，并顺带补设备名、platform、OS version、app version。
- 缺 `ownerUserId` 或 owner 不等于当前登录用户的旧记录不会被当前设备认领，避免同一电脑切换 user 后把旧 token / 工作区误归到新 user。
- 云端旧 Registered Agent 缺 `deviceId` 时也不按 hostname / `clientId` 猜测本机；没有本地 owner+device 证据的记录按 unknown/remote 展示，不能修改本地工作区绑定。

## 网络与安全

- 所有 Space HTTP 请求由 Rust `reqwest` 发起；renderer 不持有 session token。认证、JSON、multipart、raw download、generic renderer proxy、delivery poll/ACK/presence 全部复用 `with_space_client_context_headers`，统一带 public client id、客户端版本、device id、platform、OS version、`Accept-Language` 与 `User-Agent`。设备事实来自进程内缓存的 `current_device_identity()`，不能由各调用方自行拼接。
- 用户可控 workspace 路径进入 Rust 后必须通过 `validate_workspace_root`。
- 写入 workspace 的附件下载由 Rust 流式累计限制 25MB，完整接收成功后才提交文件；父目录逐段 no-follow、临时文件 exclusive create。Unix 用目录句柄内 `openat/renameat`；Windows 用 `NtCreateFile(RootDirectory=parentHandle, FILE_OPEN_REPARSE_POINT)` 逐级相对打开/创建目录与 temp，最终通过带同一 `RootDirectory` 的 `SetFileInformationByHandle(FileRenameInfo)` 覆盖目标。因此 namespace 被替换或目录原地变成 junction 都不能重定向 IO，重复下载仍可安全覆盖。
- Skill zip 安装有总大小、单文件大小、entry 数限制，并防 Zip-Slip；安装目标只允许 global 或当前 project。同名目标不自动改名：Rust 在下载前返回冲突，Renderer 明确确认后才携带 `overwrite` 重试；覆盖仍先完整解压到同级 staging，同一目标的提交经现有 file-lock 串行化后，再用短暂 sibling backup 交换目录，提交失败恢复旧目录，不做文件级合并或长期备份。
- GUI 选择附件先调用 Rust `cmd_space_inspect_attachment_drafts`，返回本地 `{path,name,sizeBytes,mimeType}`；评论/创建草稿不预上传。提交时 Rust 再用同一底层 bounded/no-follow reader 读取：Windows workspace 路径逐级用 parent handle 相对解析，leaf 以 `FILE_OPEN_REPARSE_POINT` 打开并拒绝 reparse，避免 inspect/submit 间、validate/open 间的替换或原地 reparse；显式本地文件也复用统一 leaf opener。Cloud 只在 JSON 或 multipart 整体成功时绑定正文/评论。
- CLI 附件只允许当前 workspace 内普通文件；数量先于读取限制为 5，单文件读取过程限制 25MB。complete 的 operation key 由 Rust 基于实际 multipart bytes 派生，Node 不预读/预哈希文件。

## 用户 Profile / 头像

登录用户资料是云端 `users` 的 account-level 数据；本地 `~/.myagents/space/session.json` 只缓存 redacted 摘要。桌面端更新昵称/头像必须走 `cmd_space_update_profile`，由 Rust 读取本地图片、做 symlink/大小/扩展名校验并 multipart 调用 Cloud Worker `/api/me/profile`。Renderer 只能通过 `src/renderer/api/spaceCloud.ts` wrapper 和 `spaceStore` 更新本地 UI 缓存，不能直接 fetch Worker 或持有 session token。

Cloud Worker 用 `users.name_source` / `avatar_source` 区分登录资料、MyAgents 预设头像和用户上传头像：

- `name_source='google'` 时，Google 重登可以刷新 `users.name`；`name_source='user'` 时不得覆盖。
- Google / OAuth `picture` 不进入产品头像展示体系；无用户上传时，Cloud Worker 持久化 `avatar_source='preset'` + `avatar_preset_id`，并在序列化时由 `R2_PUBLIC_BASE_URL` 投影成 `avatars/presets/{people|agents}/v1/<presetId>/{64|128|256}.webp`。
- `avatar_source='r2'` 表示用户或 Registered Agent 在 MyAgents 内部上传的头像，Google 重登不得覆盖。
- 用户头像上传写入 `ASSETS` R2 bucket 的 `avatars/users/<userId>/<sha256>.<ext>`；Registered Agent 头像上传写入 `avatars/registered-agents/<registeredAgentId>/<sha256>.<ext>` 并计入 Space storage quota。
- 头像 legacy 修复不能放在 `getAuth` / `getAgentAuth` / poll/list 读路径里做 lazy mutation；迁移、OAuth upsert、Agent 注册/头像更新是头像字段写入 owner，读路径只做 R2 URL 投影。

头像 URL 明确不走 Worker 附件下载 route。部署侧必须给 `myagents-space-assets` / `ASSETS` bucket 启用 public `r2.dev` URL 或绑定自定义域名，并在 `MyAgents_space` Worker 环境配置 `R2_PUBLIC_BASE_URL`。缺少该配置时头像上传应 fail closed；不要回退到 Worker 代理图片流量。

当前 production 配置使用 `R2_PUBLIC_BASE_URL=https://files.myagents.io`。2026-07-06 已通过 `wrangler r2 bucket domain list myagents-space-assets` 确认 `files.myagents.io` 绑定到 bucket，且用临时对象 `__healthchecks/files-domain-check.txt` 实测公开 HTTPS 直链返回 200；测试对象随后已删除。

## IssueDelivery / Claim 处理

> **协议状态**：Protocol v2 的 Cloud migration/Worker 已在 Production 上线，Desktop 0.3.2 待发布；完整逐字 Prompt、字段来源与拼接规则以 `specs/tech_docs/space_issue_delivery_protocol.md` 为准。v1 仅作为已发布旧 Desktop 的 Cloud 兼容 projection。

Registered Agent 从 Space 拉取 IssueDelivery，并将其作为轻量通知注入本地 AI session。`Issue.assignee` 是持久责任真相源，可以是真人、Registered Agent 或空，且独立于 Issue `state`；`issue_claims` 只记录 Agent/用户执行层的 operational claim 与本地 Task/Session 连接。完成/关闭保留 assignee，显式取消指派才会清空 assignee、取消 active claim、回到 `todo` 并重新按订阅规则发现。

1. `cmd_space_register_agent` 在云端创建 registered agent，并写入本地映射。
2. Rust 启动时调用 `start_space_connector()` 创建进程内 connector。connector 按本地 runnable registered agents 维护每个 agent 的 `next_due_at`、`empty_streak`、`last_interval_secs`；`cmd_space_wake_connector` 只是唤醒 connector，`cmd_space_process_deliveries_once` 仅保留为手动强制处理入口。
3. Cloud v2 poll 返回同一读取中的 Space、Registered Agent Instruction/revision 与 `items[]`。Delivery 行只拥有 target、kind/reason、source update id 与 notification version range；当前 Issue、评论与 Instruction 不复制成新逻辑 Delivery 权威。
4. Rust 严格解析 v2 package，按 exact `spaceId + registeredAgentId` 选择/创建 Session，并通过 SessionEngine inbox 注入 `space.issue_delivery`。Prompt 固定为 `registered-agent-context → registered-agent-instruction → operating-guidance → deliveries`；动态文本必须做有界 XML escape，未知 protocol/kind/reason/status fail closed。
5. subscription single-session 可批量；assignment 单 Issue 投向该实例会话；claim-followup 有 `targetSessionId` 时回到 claim 的 exact Session，Cloud 无法提供该 hint 时则按该 Registered Agent 的当前 run mode 解析其 single/Issue Session。两条路径都必须持久化同一个 exact Registered Agent origin，不能退回其它 Agent 或普通同 workspace Session。
6. Session 接受消息后 Rust 先写本地 receipt，再自动 ACK Cloud。ACK 只改变自己的 transport row；迟到 ACK 可把自己的 cancelled/expired row 校正为 delivered，但不能吞掉 successor，也不表示 Agent 已 claim、处理或完成。
7. AI 用 `myagents space issue --help` 发现完整动作面，读取当前 Issue 后自主选择 no-op、comment/update、claim/attached Task、继续执行或 complete。新 CLI 不提供 Delivery ignore；业务动作只修改 Issue/Claim/Task/Comment。

Delivery connector 的轮询节奏由云端提示 + 本地执行机制共同决定：

- 每次 poll 带上当前 agent 的 `emptyStreak`。服务端返回 `poll.nextAfterSeconds` 与 `poll.reason`；老服务端缺少 `poll` 时客户端回退到 60s。
- Rust 对服务端提示 clamp 到 30s-600s，并按 agent key 与 empty streak 加稳定 jitter；poll 失败时按上次间隔指数退避，最大 300s。
- `cmd_space_wake_connector` 用于 Space 页面激活、registered agent 创建/更新等“可能有新工作”的边界。Renderer 不自己 poll/process delivery，也不持有 registered-agent token。
- connector 读取当前 `baseUrl + user + device` 下全部 active 本地 Agent，不受 Renderer 当前选中 Space 限制；当前 Space 只属于导航/页面状态。每轮 delivery **GET 成功**即保留 poll-success 事实，后续 delivery 解析、session 注入或 ACK 失败不能把活跃客户端误判为离线。
- 某设备组至少一次 poll 成功后，现有 connector owner 按 `(baseUrl, ownerUserId, deviceId)` 从组内选稳定 token，至多每 60 秒尝试一次 device-presence touch。失败尝试同样进入 60 秒节流，并在下一轮优先换用组内其他 token；一个设备有多个 Agent 也只写一次。不新增 loop，delivery GET 继续纯读。

客户端模型区分三种 Delivery mode：

- `subscription`：仅在 assignee 为空且 Goal path + `stateFilter` 命中时广播，是发现通知，不授予责任。
- `assignment`：人工创建/改派给 Registered Agent 时定向生成，无视该 Agent 是否订阅 Goal；不能与 subscription 混批。
- `claim_followup`：assignee Agent 责任内由其它身份产生的后续 update，定向 `claim.localSessionId`；Agent 自己触发的 update 不回投。

delivery 只是投送事实，不是 claim/assignee；多个 Agent 可以感知同一未指派 Issue，但只有一个 assignee。用户主动指派真人时不向 Agent 发送；主动指派 Agent 时只给该 Agent。delivery 被客户端成功注入并 ACK 后云端从 pending 消费队列移除，历史行仍保留 delivered 状态用于审计。

该链路保持“云端关注/认领、客户端执行”的边界：云端不直接访问本地文件系统或 Sidecar；本地执行仍走 MyAgents 的 Task/Session 体系。兼容命令 `cmd_space_poll_dispatches` / `cmd_space_process_dispatches_once` 仅作为旧调用方别名保留，语义已映射到 delivery。

## Issue 详情任务卡与评论窗口

- 详情页顶部元信息只保留 Issue 编号、创建者与创建时间。正文/附件之后、评论之前是一张两列两行任务卡，第一行展示创建人、Goal，第二行展示状态、经办人；Owner/Admin 可在卡内改 Goal、状态和任意有效经办人。
- 经办人 picker 的默认列表是 active Registered Agents，其后是当前 Space/user 本机最近选择过的真人；搜索时统一搜索 Agent + Space members。Member 只暴露认领自己/释放自己，Cloud 权限仍是最终边界。
- picker 当前选择行右侧 X 经过 ConfirmDialog 执行“取消指派”复合动作。详情值区域点击整个人名打开 picker，Agent tag 在这里不承担 owner tooltip；创建者和评论作者是只读身份，灰色 `Agent` tag 可点击显示 Agent owner 的 Space 名称。
- Issue detail 固定返回最新 5 条评论且按时间正序展示。更早评论通过 `GET /api/issues/:id/comments?cursor=...&limit=20` prepend，按 comment id 去重并补偿外层 scroll height 保持阅读锚点。delivery trigger 指定评论时，CLI 用 `space issue comment get <issueId> <commentId>` 精确读取，不扫描分页。

## Issue 编号模型

Space Issue 的用户可见编号由云端拥有，不从 opaque `issue.id` 推导。`issues.number` 是同一 `space_id` 内唯一、正整数、自增的稳定编号；迁移会回填历史数据，并用 `(space_id, number)` 唯一索引和 insert/update trigger 防止缺失或非正数写入。

所有 issue list/detail、IssueDelivery 和 mock 数据都必须携带该编号。Renderer 展示 `#<number>` 时只消费 API 返回的 `number` / 兼容字段 `issueNumber`；v2 Rust parser 要求 `issueMeta.number` 是正整数，缺失或非法时整条 Delivery fail closed 并留在 pending，不能降级为内部 `issueId` 或自行解析 id 后缀。

## Issue 关系筛选与最近更新

- `GET /api/spaces/:space/issues?related=me` 是服务端行为关系筛选，与 state/goal/subtree/search/humanOnly 做 AND，并继续使用 `updated_at DESC, id DESC` cursor 分页。
- “与我相关”覆盖当前用户或其拥有的任一 Registered Agent 创建、评论、曾 claim 的 Issue；claim completed/cancelled、Agent disabled/revoked 都不抹除历史关系。
- Renderer 必须把 `related` 放进 query cache key，并在当前 Tab 内按 Space ID 保存 toggle，避免切换 Space 后串值。新 query 首次请求期间使用 keep-previous-data；失败时保留最近成功列表并显示 inline error/retry，成功空结果后才能进入空态。
- Issue cursor 页由基础 query cache 持有；UI 用“加载更多”把 `nextCursor` 页追加并按 ID 去重，不得只展示首个 50 条。Issue/Skill 集合展示 `updatedAt`；本机 mutation 可立即按 updatedAt 重排。event cursor 收到 Issue / 评论 / Goal / delivery 远端更新时，Renderer 对当前筛选 query 强制 silent revalidate：请求期间保留已有列表，成功后原子替换并按最新 `updatedAt` 顺序展示，失败仍保留最近成功数据并暴露 inline error/retry。远端 detail revalidate 只更新 detail cache，不得直接 patch 列表行或提前重排。

## 账号会员与 Space quota

- Pro 是 account-level 有效期会员；Space 仍是 member/open issue/skill/registered-agent/storage 的 quota 作用域。`billingOwnerUserId` 把账号的有效权益动态投影到该账号全部没有独立 override 的 owned Spaces，加入他人的 Space 不受当前账号会员影响。Cloud 不把 Pro 冗余写进某一个“最后创建”的 Space。
- 官方或特殊 Space 可由 Operations 持有独立 `entitlement { source, key, displayName, expiresAt, version }` 与五项 authoritative limits，不再以 `quotaBypassed` 形成展示/执行双轨。每个 Space-scoped limit 都是 `number | null`：`null` 明确表示不限制，`undefined` 只表示旧 Cloud/缺字段，不能当成 unlimited。
- `/api/me` / Desktop `SpaceSession` 返回 `accountPlan { effectiveTier, evaluatedAt, membership }`；Space projection 返回 `effectivePlanTier`、`planExpiresAt`、`entitlement`、`limits`。Desktop `0.3.0` 消费 nullable limits 和 Cloud 展示名；Cloud 兼容判定仍使用预发布阶段确定的 `>=0.2.50` 协议门槛，对更旧/无版本客户端继续投影可解析的 Free 数字且不下发 entitlement，避免滚动发布期间旧类型崩溃。
- Settings 的 Plan 与“SPACE 资源 · … 套餐”标题都优先使用 `entitlement.displayName`；有限值显示本地化 `usage / limit`，`null` 显示 `usage / 不限制`（英文 `Unlimited`），且无限资源不得触发 over-limit 或禁用 Members/Agents 操作。期限优先使用 `entitlement.expiresAt`；独立 entitlement 的 null 期限不能误回退到 owner 账号 Pro 期限。
- 到期判定严格为 `[startsAt, expiresAt)`，无需 cron。到期/撤销后 resolver 立即回到 Free；存量仍可读，只有超额资源的正增量 mutation 被拒绝，删除/归档/释放额度始终允许。
- `space.plan_changed` 是普通 Space cursor event：当前 Space 收到后失效 session/overview 并 silent revalidate。Overview 的 `limits` 以当前 Space session projection 为单一权威，members payload 只补 usage/兼容旧服务，不能用旧快照遮住 plan event 的新额度。
- 账户菜单打开且 `accountPlan.evaluatedAt` 超过 60 秒未校验、Pro 到期 timer、App 恢复前台也会补刷新；到期 timer 用服务端 `evaluatedAt → expiresAt` 的相对时长规避本机时钟偏差，并按同一 membership version/expiry 限制重试，不能形成 refresh storm。不新建常驻会员 poll。

## Agents UI 约束

- Agents 列表是双列卡片；单个 Agent 也保持半宽，布局宽度边界与 Skills 列表一致。
- 卡片只展示注意力关键项：Agent 名称 + `在线/离线/已停用/连接中`、最后在线、本地电脑、工作区 Path、订阅目标。`active` 是管理态，绝不能直接渲染为绿色 online；普通 device lastSeen 与配置 updatedAt 也不能回退成在线时间。
- active online、active offline、disabled 是首载/手动刷新/重新进入 Agent 页面时的排序组；60 秒 presence revalidate 与 App visibility resume 都只原位更新 badge，不在页面停留期间换位。
- 用户文案统一为“添加本机 Agent 工作区”；registered agent 只保留在技术说明和字段名称中。
- 点击卡片打开 overlay 详情，不跳页。详情按“设备信息 / 工作区信息 / 派发设置 / 登记信息”分组。
- 编辑弹窗中的“本地 Agent 工作区”必须与登记弹窗使用同一工作区选择交互；但只有 current local Agent (`ownerUserId + deviceId` 命中当前端点) 可修改。远端设备登记的 Agent 工作区字段置灰，只能修改名称、订阅目标、订阅范围、订阅执行策略。
- 登记与编辑弹窗使用同一套 viewport-safe 三段布局：外框不超过可视区并保留安全边距，header/footer 始终可见，只有中间表单区滚动；不得让整个 overlay 随字段数量越过屏幕边界。
- “目标与指令”正常态只展示字段名与 placeholder，不重复显示说明文字；校验错误和旧 Agent 缺少 Instruction 的兼容提醒仍显示在输入框下方。
- Cloud 数据模型与 create/delete API 继续允许一个 Registered Agent 拥有多条 Subscription；Desktop 登记/编辑弹窗暂时只提供一条可编辑订阅，不提供添加多条、逐条删除或重新评估入口。编辑时只替换 UI 当前呈现的一条规则，不得静默删除由其它客户端/API 创建的额外规则。
- “订阅执行策略”选项固定按“新开对话 → 连续对话”排列，新登记 Agent 默认 `new_session`；编辑已有 Agent 必须保留其权威值，旧数据缺字段仍按历史 `single_session` 回退。
- `clientId` 是 OAuth public client/build 配置，不是设备标识，不应出现在卡片关键位。
