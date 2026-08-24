# Managed Codex sub-agent lifecycle

## Incident and root cause

During the 2026-08-15 AnyDoc fan-out test, four child agents had completed and the durable transcript had terminal results for all 628 nested calls, yet the Agent Status Panel and `CollabAgent` cards kept pulsing and elapsed time kept increasing. Unified logs showed all child/root `turn/completed`, persistence and `chat:message-complete`; there was no SSE drop/backpressure evidence.

The owner mismatch was:

- `codex.ts` already observed native child `turn/started`/terminal and used it to hold/release the root turn, but the child lifecycle gate returned `null` instead of emitting a runtime-neutral parent-card status.
- `subAgentActivity` completion is only spawn/control invocation completion, not child-work completion.
- Renderer used parent/nested trace `isLoading` as a proxy for Agent execution.
- reasoning summary/content deltas and completed events used mismatched trace identities, causing deterministic pending traces and a terminal completion burst.
- late nested terminal events could no-op after the streaming assistant moved to history, while root finalization only closed top-level blocks.

## Implemented architecture

PRD: `specs/prd/prd_0.4.9_managed-codex-subagent-lifecycle.md`; status `implemented`. Commit: `8cb9391f` (`fix(codex): converge subagent lifecycle state`).

- Native child turn is the only normal execution authority.
- Codex adapter owns raw protocol mapping, observation timestamps and turn-local card correlation; only cards with a proven child turn are lifecycle-eligible.
- A minimal monotonic parent-card lifecycle (`running | completed | failed | interrupted`) flows through runtime-neutral `subagent_lifecycle`, external-session/content-blocks, critical `chat:subagent-status`, successful-turn persistence and Renderer projection.
- Queue-only `send_message`, wait, interrupt, close and other control-only cards do not gain a lifecycle. Trigger-turn follow-up cards do.
- Descendants delay parent-card terminal but do not overwrite the direct owner child's outcome.
- Root terminal is fail-closed recovery only: residual running becomes `failed`, or `interrupted` for explicit user stop; root success never synthesizes child success. Failed/stopped turns keep the existing contract of discarding partial assistant content.
- Renderer, Companion, ProcessRow, TaskTool and Agent Status Panel consume the same explicit lifecycle. Archived messages accept late idempotent updates; old persisted cards without lifecycle do not revive from stale nested loading. The panel keeps one 500 ms group-level terminal linger, then follows its existing fade/unmount.
- reasoning traces now pair exact start/delta/stop identities; `subAgentActivity item/started` is an explicit no-op instead of diagnostic noise.

No Session registry, second state machine, polling, timeout inference, retry, feature flag, new endpoint/process/store or builtin Task/Agent lifecycle rewrite was added.

## Verification and future diagnosis

- 10 focused files / 275 tests and a final 85-test Codex set passed, along with typecheck, full lint, server/web builds and 226 classification checks.
- Requirements and adversarial review blockers were fixed; final fresh-context architecture review passed.
- Managed Codex 0.146.0 smoke covered four-agent fan-out, nested reasoning/tools, queue-only control, interrupt/failure, successful persistence/Sidecar recovery, same-child trigger-turn follow-up and activity-before-start timing.

If a similar UI symptom returns, first distinguish native child lifecycle from trace rendering and inspect the persisted parent `subagentLifecycle`; do not infer execution from breathing animation or nested `isLoading`. Then verify adapter correlation, critical SSE/live restore registration, archived-message update and root fail-closed projection in that order.
