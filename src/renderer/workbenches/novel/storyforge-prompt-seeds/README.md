# StoryForge 提示词快照

本目录保存小说工作台默认提示词包使用的 StoryForge 内容快照，不包含 StoryForge 的数据库、组件、Agent 适配器或其它业务实现。

- 来源仓库：`https://github.com/zhong2312/storyforge`
- 来源版本：`3.7.5`
- 导入日期：`2026-07-16`
- 许可证：MIT
- 提示词数量：89

来源文件：

- `src/lib/ai/prompt-seeds.ts`
- `src/lib/ai/prompt-seeds-genre-packs.ts`
- `src/lib/ai/prompt-seeds-genre-packs-extended.ts`

更新快照时必须同步三个来源文件，更新 `promptLibraryDefaults.ts` 中的版本和数量，并运行 `promptLibraryDefaults.test.ts`、`promptLibraryRepository.test.ts` 与项目初始化测试。不得在快照文件里改写提示词正文；MyAgents 的安装身份、目录、作用域和 Markdown 适配只放在 `promptLibraryDefaults.ts`。
