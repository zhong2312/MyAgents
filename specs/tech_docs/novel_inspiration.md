# 小说灵感模块

> 状态：已实现。本文记录独立灵感模块的事实源、交互边界和 AI 约束。

## 事实源

灵感使用项目内的 `inspiration/` 目录。`index.json` 使用 `schemaVersion: 1`、`storageVersion: 1`，只保存有序 `{id,path}` 引用和库更新时间；每条灵感的完整记录保存为 `records/<inspiration-id>.json`。文件由 `inspirationSchema.ts` 校验，由 `inspirationRepository.ts` 通过 `WorkbenchStorage` 递归读取并聚合，在保存时对整个目录快照执行 CAS，先差量写记录、最后提交根索引并清理孤立记录。

每条灵感包含稳定 ID、标题、Markdown 正文、状态、来源、标签及创建/更新时间。状态限定为：

- `inbox`：收集箱；
- `organizing`：待整理；
- `unused`：暂不使用；
- `archived`：已归档。

旧单文件灵感库不兼容、不迁移。程序不会主动删除项目目录中的其它旧文件。

## 工作面

灵感工作面提供列表、四列看板、搜索、状态筛选、来源排序、新增、编辑、删除和帮助。正文使用通用 Markdown 编辑器，支持可视化/源码切换与适中尺寸的放大弹窗。

页面草稿与磁盘内容分离。外部文件变化不会覆盖未保存草稿；离开页面时通过工作台导航守卫提供保存、放弃或继续编辑选择。

## AI 边界

一次性任务使用 `inspiration.assist`，完整会话使用 `inspiration.coauthor`。模型、供应商、凭据和 Session 生命周期由工作台宿主管理。

AI 启动消息只包含任务和焦点灵感稳定 ID，不内嵌灵感正文。模型通过 `novel_inspiration_get_context` 按需读取目录聚合后的已保存事实；传 `focusId` 才返回对应记录全文，省略时只返回索引摘要和覆盖目录快照的 `sourceHash`。输出仅为诊断或发展建议，不自动写入灵感文件，不创建或修改正文和其它项目数据。

## 退役范围

小说工作台不再提供故事规划、旧大纲、线路、故事弧、期待追踪、章节计划和规划自定义页面。新项目不再初始化 `story/`、`outline/` 或规划自定义事实文件。
