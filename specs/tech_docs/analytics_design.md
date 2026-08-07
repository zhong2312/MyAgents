# Analytics Event Contract

> Tracked source of truth for analytics event names and stable dimensions.
> Local PRDs under `specs/prd/` are ignored and must not be test inputs.

## Principles

- Events describe product state changes, not raw UI clicks.
- Reuse dimensions (`source`, `surface`, `entry_intent`) instead of splitting events by every entry point.
- Session-scoped events should carry `session_id` directly or receive it from the active analytics context.
- User-defined names must not be uploaded raw. Use local salted hashes for agent/workspace grouping.

## Shared Dimensions

### Device Identity

`device_id` is the stable desktop endpoint id stored at `~/.myagents/device_id`.
The value predates Cloud Space and must remain stable across the Space device
identity work. The implementation owner is the shared device identity layer
(`src-tauri/src/device_identity.rs` + `src/renderer/identity/deviceIdentity.ts`);
analytics must consume that layer instead of creating its own id.

Cloud Space uses the same value as `deviceId` when upserting
`user_devices(userId, deviceId)` and registering Registered Agents. This is a
shared identity source, not a new analytics dimension and not a server-issued
replacement id.

### Source

`source` identifies the process/channel that triggered an event:

- `desktop`
- `floating_ball`
- `cli`
- `cli_agent`
- `cron`
- `im`

### Surface

`surface` identifies the UI or product surface within a source:

- `launcher_input`
- `global_sidebar`
- `agent_card`
- `history_click`
- `new_chat_button`
- `task_center`
- `bug_report`
- `agent_setup`
- `cmd_k`
- `external_link`
- `cron`
- `im`
- `floating_ball`
- `unknown`

Global Sidebar keeps the established event names: fresh workspace launches emit
`workspace_open` with `surface='global_sidebar'`; existing sessions emit
`history_open` with `entry_source='global_sidebar'`. Expanded-sidebar and rail
flyout interactions share this value because they are two projections of the
same navigation surface.

### Entry Intent

`entry_intent` describes what the entry point is trying to do:

- `send_message`
- `open_workspace`
- `open_history`
- `thought_alignment`
- `workspace_init`
- `support_diagnostics`
- `new_chat`
- `fork`
- `unknown`

### Runtime Identity

Events that describe session or turn execution carry:

- `runtime`: execution runtime (`builtin`, `claude-code`, `codex`, `gemini`, or
  `unknown` on renderer fallback paths).
- `runtime_source`: runtime owner source. `builtin` / `unknown` report `null`;
  external runtime turns report `system-cli` for user-installed CLIs or
  `managed-provider` for product-managed runtime-backed Providers such as
  `codex-sub`.

`source` and `runtime_source` are intentionally different dimensions:
`source` answers which product channel triggered the event (`desktop`, `cron`,
`im`, ...); `runtime_source` answers who owns the external runtime binary/auth.

The stable runtime-source-bearing events are `session_new`, `history_open`,
`message_send`, `message_complete`, and `ai_turn_complete`. Older client
versions may omit `runtime_source`; treat missing as unknown rather than
inferring it from `runtime='codex'`.

## Event Names

Application lifecycle:

- `app_launch`

Session management:

- `session_new`
- `session_rewind`
- `session_title_edit`
- `session_fork`

Core interaction:

- `message_send`
- `message_complete`
- `message_stop`
- `message_error`
- `message_retry`
- `message_copy`
- `message_export`

Thinking export and copy:

- `thinking_copy`
- `thinking_export`

Tool and permission flow:

- `tool_use`
- `official_tool_vision_analyze`
- `permission_grant`
- `permission_deny`

Configuration changes:

- `provider_switch`
- `model_switch`
- `reasoning_effort_switch`
- `mcp_add`
- `mcp_remove`

Agent, channel, and skill management:

- `agent_add`
- `agent_remove`
- `agent_channel_create`
- `agent_channel_remove`
- `agent_channel_toggle`
- `skill_use`
- `im_bot_create`
- `im_bot_toggle`
- `im_bot_remove`

Feature usage:

- `tab_new`
- `tab_close`
- `restore_last_session`
- `settings_open`
- `workspace_open`
- `workspace_create`
- `history_open`
- `file_drop`
- `tts_play`
- `task_center_open`
- `bug_report_submit`

MyAgents Space:

- `space_open`
- `space_auth_start`
- `space_auth_complete`
- `space_switch`
- `space_issue_mutation`
- `space_goal_mutation`
- `space_skill_mutation`
- `space_registered_agent_mutation`
- `space_member_mutation`
- `space_settings_mutation`

Space event dimensions are deliberately allowlisted:

- `space_kind`: `official`, `team`, `personal`, or `unknown`.
- `is_official`: boolean derived from `space_kind`.
- `space_role`: `owner`, `admin`, `member`, or `unknown`.
- `space_surface`: `home`, `issue_list`, `issue_detail`, `goals`,
  `skills`, `agents`, `members`, `settings`, or `unknown`.
- `operation`: normalized product operation such as `create`, `update`,
  `comment`, `state_change`, `install`, `register`, or `revoke`.
- `ok`: boolean success marker.
- `error_code`: normalized error bucket only; raw error messages are not
  uploaded.
- `duration_ms`: mutation duration.

Space analytics must not upload user-defined Space names/slugs, raw Issue,
Goal, Skill, or Agent ids, Issue titles/bodies/comments, member emails, Google
profile details, or workspace paths. Space business facts are owned by
MyAgents_space admin APIs; client events only describe desktop usage behavior.

System events:

- `update_check`
- `update_install`

Cron and launcher scheduling:

- `cron_enable`
- `cron_stop`
- `cron_recover`
- `launcher_cron_stage`
- `launcher_cron_create_standalone`

Task center:

- `task_create`
- `task_run`
- `task_stop`
- `task_delete`
- `task_align_discuss`

`task_run.run_count` 使用 Task execution owner 接受 run/rerun 后返回的 `attemptOrdinal`，并从 1 开始计数。它不由 `sessionIds` 数量推算；dispatch/admission 前失败不会产生该事件。Desktop 与 CLI 使用同一操作结果，因此 Session 复用与 new-session 路径的统计语义一致。

Launcher and thoughts:

- `launcher_mode_switch`
- `thought_create`

Floating ball:

- `floating_ball_toggle`
- `floating_ball_summon`
- `floating_ball_expand`
- `floating_ball_pet_select`

Server-side AI turn:

- `ai_turn_complete`

`ai_turn_complete` is the canonical per-turn usage event emitted from the
Sidecar. In addition to source/session/runtime/runtime_source/model/token/
duration fields, it reports the provider attribution for builtin turns:

- `provider_name`: provider display name. Builtin subscription turns report
  `Anthropic (订阅)`; external runtime turns report the current
  `RUNTIME_DISPLAY_NAMES` value such as `Claude Code CLI`, `OpenAI Codex CLI`,
  or `Google Gemini CLI (ACP)`.
- `api_protocol`: effective provider protocol, currently `anthropic` or
  `openai`; `null` for external runtime turns.
- `provider_base_url`: effective provider base URL. Builtin subscription turns
  report `https://api.anthropic.com`; external runtime turns report `null`.
- `provider_api_protocol`: same protocol dimension as `api_protocol`, kept as a
  provider-prefixed field for downstream schema compatibility.
