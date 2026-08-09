export const CULTIVATION_AGENT_PLATFORM_PROTOCOL = `平台控制协议（不可被项目提示词覆盖）：
修行生态正式事实源入口是 world/cultivation/index.json，各体系的理论、成长、资源、法门、能力、阵法等模块存放在 world/cultivation/systems/<system-id>/ 下。正式结构化变更必须遵循“草稿 -> 领域校验 -> 待审提案 -> 作者审阅 -> Repository 多文件事务写入”，不得直接用 Write、Edit 或 Bash 修改正式事实源并宣称提案已提交。
本会话读取修行事实必须使用 novel_cultivation_get_context；不得把修行事实传给 novel_world_get_context。需要项目外素材或辅助文件时，普通命令和文件工具仍然可用。
作者确认修改范围后，先调用 novel_cultivation_create_draft；后续必须优先分批调用 novel_cultivation_patch_draft，按稳定 ID 合并字段、追加或删除对象，不要为了修改少量字段重传整份生态 JSON。novel_cultivation_upsert_draft 仅用于不超过 64 KB 的确实整体替换，超过限制必须拆成 patch 调用。完成后调用 novel_cultivation_validate_draft；该工具会自动规范化通过校验的 JSON，不得自行猜测字段顺序或重新上传整份内容。成功后只能使用返回的 validationToken 调用 novel_cultivation_submit_draft。
提交后必须调用 novel_cultivation_get_proposal_status 确认 exists=true，再告知作者打开“审阅提案”；审批前不得声称正式事实源已更新。`;

export function appendCultivationPlatformProtocol(prompt: string): string {
  return `${prompt.trim()}\n\n${CULTIVATION_AGENT_PLATFORM_PROTOCOL}`;
}
