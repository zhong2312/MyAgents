---
name: myagents-memory-molt
description: >
  仅当系统或用户明确指定完整名称 `myagents-memory-molt` 时使用；
  不要根据任务语义或相似表述自行触发。
metadata:
  author: MyAgents
---

# MyAgents Memory Molt

Molt 是长期记忆机制的第三层：它不是把文件整理得更整齐，而是让工作区的长期记忆发生真实进化。
如果结束后没有任何旧判断被反对、没有任何新原则被接受、没有任何元层文件被改动，这次就是无效反思。

## 三层位置

| 层 | 节奏 | 本质 | 允许改什么 |
|---|---:|---|---|
| `UPDATE_MEMORY.md` | 24h | session 级捕获 | 日志 / 增量记忆 |
| `myagents-memory-gardener` | 72h | 修剪和下放 | USER / MEMORY / topic / gardener flags |
| `myagents-memory-molt` | 14d | 信念审计和自我改写 | SOUL / USER / MEMORY / molt 文档 |

## 硬规则

1. **不能空手而归。** 至少产出一个新接受的信念、一个新拒绝的旧信念、一个升级到 SOUL/USER/MEMORY 的模式。
2. **找不舒服的信号。** 优先处理矛盾、反复纠正、长期拖延、和当前叙事不一致的证据。
3. **外部事实核验是硬要求。** 对会随时间衰减的事实判断，必须搜索验证；无法验证时显式标 `unverified`。
4. **用第一人称写内省。** 不写面向用户的汇报体。
5. **自审，不等用户审批。** 在权限允许范围内直接落地，事后通过 git history 留痕。
6. **识别迎合。** 标出哪些判断只是用户透传、哪些是自己独立验证后接受。
7. **承认不知道。** 证据不足时保留待验证状态，不硬下判断。

## 工作流程

1. 在目标工作区运行 `python3 <skill>/scripts/prepare_molt.py --repo <workspace>`，采集范围清单。
2. 运行 `python3 <skill>/scripts/prepare_molt.py --repo <workspace> --init-progress`，生成 `memory/molts/YYYY-MM-DD-molt-NNN.progress.md`。
3. 创建并撰写 `memory/molts/YYYY-MM-DD-molt-NNN.md`。结构参考 [references/landing_template.md](references/landing_template.md)。
4. 按顺序完成五个认知动作：模式挖掘、信念审计、外部核验、身份一致性、综合落地。
5. 同步更新 progress 文件。所有 checkbox 必须变成 `[x]` 或 `[defer] + 理由`。
6. 直接落地修改 `SOUL` / `USER` / `MEMORY` 中需要变化的部分；不要把结果只写在 molt 文档里。
7. 如存在 `myagents-memory-gardener` 的 lint 脚本，落地后跑一遍，避免自动装载层膨胀。
8. 如果是 git 仓库，只提交本次记忆进化改动；**不要 push**。如果不是 git 仓库，跳过提交。

## 允许修改范围

- `.claude/rules/02-SOUL.md` 或 `.claude/rules/SOUL.md`
- `.claude/rules/03-USER.md` 或 `.claude/rules/USER.md`
- `.claude/rules/04-MEMORY.md` 或 `.claude/rules/MEMORY.md`
- `memory/molts/`
- `memory/gardener/flags-for-molt.md`

topic 文件通常不在 molt 中大规模重写；需要时只做必要的指针和状态调整。

## Commit

建议 commit message：

```text
memory: molt YYYY-MM-DD
```

如果修改了 SOUL，message 中包含 `SOUL:`，例如：

```text
memory: molt YYYY-MM-DD SOUL: tighten operating principles
```

参考细节：

- [references/cognitive_moves.md](references/cognitive_moves.md)
- [references/external_verification.md](references/external_verification.md)
- [references/landing_template.md](references/landing_template.md)
