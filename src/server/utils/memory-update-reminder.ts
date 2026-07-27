import { escapeSystemReminderText } from '../../shared/systemReminder';

export const MEMORY_UPDATE_COMPLETION_MARKER = 'MEMORY_UPDATE_OK';

export interface MemoryUpdateReminderInput {
  workspaceMemoryInstructions: string;
  currentTime: string;
}

/**
 * Build the hidden turn injected into the current Session by Memory Update.
 *
 * Keep the workspace instruction container even when its body is empty: an
 * empty body means “no workspace-specific additions”, while the official
 * system skill remains the workflow authority.
 */
export function buildMemoryUpdateReminder(input: MemoryUpdateReminderInput): string {
  const workspaceMemoryInstructions = escapeSystemReminderText(input.workspaceMemoryInstructions);
  const currentTime = escapeSystemReminderText(input.currentTime);

  return [
    '<system-reminder>',
    '<MEMORY_UPDATE>',
    '现在进入当前 Session 的强制记忆审计与巩固。使用 `myagents-memory-update` skill；不要假定本 Session 中值得保留的信息已经在日常工作阶段被主动写入。',
    `执行前先锁定最终输出：完成所有工具调用后，只能发送 ${MEMORY_UPDATE_COMPLETION_MARKER}，不要发送任何过程或状态说明。`,
    '',
    '重新检查完整对话、实际产物和现有记忆，至少完成两类审计：',
    '1. 事实与状态：完成、决定、验证或推翻了什么；当前真实状态、关键理由、未完成事项和下一步是什么。',
    '2. 互动与协作：用户在哪里选择、纠正、拒绝、强调或重新定义；这让你对其目标、判断标准、取舍、质量要求、协作方式或授权边界有了什么可改变未来行为的新理解；你自己的哪些做法应在相似情境中调整。',
    '',
    '按工作区既有记忆结构更新所有受影响的层级：当日日志保留重要事件与证据，相关 topic 保留项目状态和项目内经验，自动加载的 USER/Core 类记忆只保留稳定、当前、跨 Session 仍应影响行为的结论。先读取并修正旧记忆；不要机械重复，也不要把一次弱信号写成永久人格判断。',
    '',
    '遵循谨慎原则：错误的长期记忆通常比暂时缺失更有害。结合连续对话判断反馈含义；不置可否、忽略、未纠正或简单接受不自动等于认可。明确限定为“本次/这次/单次”的指令、授权或纠正不得进入自动加载记忆；不要因为某个 topic 已存在就推断当前事件属于它。证据不足或归属不明时保留局部 Daily 事实或不写，不要升级成稳定偏好、全局规则或项目结论。',
    '',
    '以下是当前工作区自定义的维护要求：',
    '<workspace-memory-instructions>',
    workspaceMemoryInstructions,
    '</workspace-memory-instructions>',
    '',
    '只处理当前 Session 自上次成功更新后新增的工作、相关工作区产物及其直接造成的记忆修正；不要扩大为全工作区 Gardener 或 Molt。',
    '',
    `Current time: ${currentTime}`,
    '',
    '<output-contract>',
    `FINAL RESPONSE CONTRACT（覆盖普通任务总结习惯）：所有工具调用结束后，最终 assistant message 必须且只能是单独一行 ${MEMORY_UPDATE_COMPLETION_MARKER}。任何额外字符都会让调用方把本轮判定为失败。特别不要报告 no-op、文件变化、Git 状态、无需提交或检查过程。`,
    '</output-contract>',
    '</MEMORY_UPDATE>',
    '</system-reminder>',
  ].join('\n');
}
