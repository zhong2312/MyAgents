---
name: myagents-memory-gardener
description: >
  仅当系统或用户明确指定完整名称 `myagents-memory-gardener` 时使用；
  不要根据任务语义或相似表述自行触发。
metadata:
  author: MyAgents
---

# MyAgents Memory Gardener

本 skill 是长期记忆机制的第二层：它不捕获当天经历，而是把已经沉淀下来的
`03-USER` / `04-MEMORY` 自动装载层修剪回可长期运行的状态。

核心判断：**遗忘是降级，不是删除。** 自动装载层只保留会影响每次会话行为的规则；
案例、项目细节、推导过程下放到 `memory/topics/`，并在自动装载层保留可召回指针。

## 边界

- `UPDATE_MEMORY.md`：24h 捕获层，只做 session 级增量沉淀。
- `myagents-memory-gardener`：72h 整编层，只做删、下放、合并、体检。
- `myagents-memory-molt`：14d 深反层，才允许改 SOUL / 底层信念。

## 工作流程

1. 确认当前目录是目标工作区；如需显式指定，脚本都支持 `--repo /path/to/workspace`。
2. 如果是 git 仓库，检查工作树。存在非本次任务的未提交改动时，只做只读体检并报告。
3. 运行 `python3 <skill>/scripts/memory_lint.py --repo <workspace>`，把 RED 作为必做议程，WARN 酌情处理。
4. 读取上次园丁运行后的日志和 topic，把可长期复用的规则留下，把故事和证据下放。
5. 对超预算自动装载层执行顺序：删过时项 -> 下放故事 -> 合并同根规则 -> 最后才新增。
6. 发现 SOUL / 底层信念问题时，只追加到 `memory/gardener/flags-for-molt.md`，不要直接改 SOUL。
7. 报告写入 `memory/gardener/YYYY-MM-DD.md`，再运行 `memory_lint.py --mark-run`。
8. 如果是 git 仓库，只提交本次记忆维护改动；**不要 push**。如果不是 git 仓库，跳过提交。

lint 全绿且没有新沉淀时，写一条空跑记录后结束。

## 报告格式

```markdown
## Gardener Run YYYY-MM-DD
- lint: N RED / N WARN -> 处理结果各一行
- budgets: MEMORY xx.xKB / budget, USER xx.xKB / budget
- operations: delete N, demote N, merge N clusters, add N
- drill / flags-for-molt / deferred: <各一行；无则写无>
```

建议 commit message：

```text
memory: gardener YYYY-MM-DD
```

## 自检

- 超预算文件净变小了吗？
- 下放内容真的落进 topic，并且自动装载层指针有效吗？
- 没有直接改 SOUL 吗？
- `flags-for-molt.md` 只放信念级问题，不放日常整理事项吗？
- 如有 git 仓库，提交只包含本次记忆文件，且没有 push 吗？

具体整编手法见 [references/playbook.md](references/playbook.md)。
