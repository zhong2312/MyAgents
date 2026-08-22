---
intent: 将小说工作台存储层从「大聚合 JSON = 单一 CAS 单元」重构为「实体级分片事实源 + 可丢弃 SQLite 只读投影 + 统一事务原语」，在保留 Git 友好性的前提下解决并发冲突面过大、跨文件事务靠手写补偿、跨库查询需全量读取、热路径重复全量读盘四类问题。
success_criteria: characters 库以 meta.json + index.json + records/<id>.json 三层分片持久化且全部调用点已切换；WorkbenchProjection 能力可用并已承载 domainIndex 与 findInboundReferences 查询；StorageTransaction 原语替代 createChapter 的手写补偿分支；useNovelProject 单次刷新只做一次全量读取；npm run lint、npm run typecheck、npm run test:unit、npm run test:dom 全绿，cargo test 全绿。
risk_level: medium
auto_approve: true
---

## Steps

- [ ] **Step 1: 为 useNovelProject 刷新路径写全量读取计数回归测试**
action: 新建 `src/renderer/workbenches/novel/useNovelProject.test.tsx`。用 `NovelMemoryStorage`（来自 `./testStorage`）构造含 `novel.json` 与 `manuscript/index.json` 的空项目，在其上包一层计数代理，统计 `readText("manuscript/index.json")` 的调用次数。用 `@testing-library/react` 的 `renderHook` 渲染 `useNovelProject(storage, true)`，`waitFor` 等到 `isLoading === false`，断言该计数为 1。当前实现会得到 2，因此这一步必须产出失败测试。
loop: false
verify: npx vitest run --project dom src/renderer/workbenches/novel/useNovelProject.test.tsx
gate: auto

- [ ] **Step 2: 让 synchronizeNarrative 返回是否写盘的标记**
action: 在 `src/renderer/workbenches/novel/repository.ts` 中，把 `NovelRepository.synchronizeNarrative` 的返回类型由 `Promise<void>` 改为 `Promise<{ readonly changed: boolean }>`。在其实现体（约 L1030 起）的每一条提前返回路径返回 `{ changed: false }`，在确实执行了索引写入、章节归档、批次重排或剧情工程写入的路径返回 `{ changed: true }`。不改变任何写盘顺序与既有补偿逻辑。
loop: false
verify: npm run typecheck

- [ ] **Step 3: useNovelProject 依据 changed 标记决定是否二次加载**
action: 在 `src/renderer/workbenches/novel/useNovelProject.ts` 的 `load`（L160-L187）与 watch 回调 `refresh`（L205-L234）两处，把 `await repository.synchronizeNarrative(...)` 的结果存入变量，仅当 `result.changed === true` 时才执行第二次 `await repository.load()`，否则直接复用首次加载结果。两处改法保持一致。
loop: until Step 1 的计数断言通过
max_iterations: 3
verify: npx vitest run --project dom src/renderer/workbenches/novel/useNovelProject.test.tsx

- [ ] **Step 4: 修正 repository.test.ts 中 synchronizeNarrative 的返回值断言**
action: 在 `src/renderer/workbenches/novel/repository.test.ts` 中检索全部 `synchronizeNarrative` 调用点，为断言返回值的用例改为匹配 `{ changed: true }` 或 `{ changed: false }`；仅调用而不断言返回值的用例保持不变。
loop: until 测试全绿
max_iterations: 3
verify: npx vitest run --project unit src/renderer/workbenches/novel/repository.test.ts

- [ ] **Step 5: 在 workbench-sdk 收敛 ensureTextFile**
action: 在 `src/shared/workbench-sdk/storage.ts` 末尾导出 `ensureWorkbenchTextFile(storage: WorkbenchStorage, path: string, fallbackContent: string): Promise<WorkbenchTextFile>`，语义与现有四份重复实现一致：先 `stat`，存在则 `readText`；不存在则 `createText(path, content, { createParents: true })`；`createText` 抛错时回退 `readText`。同时在 `src/shared/workbench-sdk/storage.test.ts` 追加三个用例，分别覆盖「已存在则读」「不存在则创建」「创建冲突回退读」。
loop: false
verify: npx vitest run --project unit src/shared/workbench-sdk/storage.test.ts

- [ ] **Step 6: 四个 repository 改用 SDK 版 ensureTextFile**
action: 删除 `src/renderer/workbenches/novel/timelineLibraryRepository.ts`、`characterLibraryRepository.ts`、`settingLibraryRepository.ts`、`narrativeEngineeringRepository.ts` 中各自的本地 `ensureTextFile` 函数定义，改为从 `@/workbench-sdk` 导入 `ensureWorkbenchTextFile` 并替换全部调用点。不改变调用参数与调用顺序。
loop: until typecheck 与相关测试全绿
max_iterations: 3
verify: npm run typecheck

- [ ] **Step 7: 新增 StorageTransaction 原语**
action: 新建 `src/renderer/workbenches/novel/storageTransaction.ts`，导出 `createStorageTransaction(storage: WorkbenchStorage)`，返回对象含 `writeText(path, content, expectedContent?)`、`createText(path, content)`、`move(from, to)`、`remove(path)` 四个意图登记方法（同步登记、不立即落盘）与 `commit(): Promise<void>`。`commit` 按登记顺序执行，任一步失败时按反序对已成功步骤执行逆操作（writeText 逆操作是写回 expectedContent、createText 逆操作是 remove、move 逆操作是反向 move、remove 逆操作抛出不可逆错误），回滚过程中再次失败时抛出同时含原始错误与回滚失败原因的聚合错误。
loop: false
verify: npm run typecheck

- [ ] **Step 8: 为 StorageTransaction 写单元测试**
action: 新建 `src/renderer/workbenches/novel/storageTransaction.test.ts`，基于 `NovelMemoryStorage` 覆盖四个场景：全部成功后磁盘状态正确；中途 `writeText` 失败时先前的写入被回滚到原内容；中途失败时先前的 `createText` 产物被删除；`expectedContent` 不匹配时 commit 抛错且磁盘无变更。用 `NovelMemoryStorage.failWritePathOnce` 注入写失败。
loop: until 全部用例通过
max_iterations: 4
verify: npx vitest run --project unit src/renderer/workbenches/novel/storageTransaction.test.ts

- [ ] **Step 9: 用 StorageTransaction 重写 createChapter**
action: 在 `src/renderer/workbenches/novel/repository.ts` 中把 `createChapter`（约 L501-L675）的手写补偿分支替换为 `createStorageTransaction` 登记加 `commit`。保留既有的写入顺序语义（先写索引再写正文文件，使孤儿文件而非索引悬空引用成为失败态）与 `assertMutableStructure` 结构锁定校验。删除该函数内已不再被引用的局部补偿辅助代码。
loop: until repository.test.ts 全绿
max_iterations: 4
verify: npx vitest run --project unit src/renderer/workbenches/novel/repository.test.ts

- [ ] **Step 10: 定义 characters 分片后的 schema**
action: 在 `src/renderer/workbenches/novel/characterLibrarySchema.ts` 中新增 `characterIndexEntrySchema`，字段对齐 `itemLibrarySchema.ts` 的 `itemIndexEntrySchema` 形状：`id`、`name`、`raceId`（可空）、`groupIds`、`summary`、`recordPath`（校验须匹配 `characters/records/<id>.json`）、`updatedAt`（datetime）。把 `characterLibraryIndexSchema` 的 `characters: z.array(characterRecordSchema)` 改为 `characters: z.array(characterIndexEntrySchema)`，保留 id 唯一性 `superRefine`。新增 `characterRecordFileSchema`（在 `characterRecordSchema` 基础上补 `schemaVersion` 字面量）与 `parseCharacterRecordFile`。删除 `normalizeCharacterArcStageIds` 在 index 解析上的挂载，改挂到单条 record 解析上。
loop: false
verify: npm run typecheck

- [ ] **Step 11: 改造 characterLibraryRepository 为分片读写**
action: 在 `src/renderer/workbenches/novel/characterLibraryRepository.ts` 中把 `CHARACTER_LIBRARY_PATHS` 扩展为 `{ meta: "characters/library.json", index: "characters/index.json", records: "characters/records" }`。`load()` 只读 meta 与 index，不再读全部 record。新增 `loadCharacter(entry)` 按需读单条 record。把 `saveCharacters` 拆为 `saveCharacter(library, record)`（写单条 record 加更新 index 条目，用 Step 7 的 StorageTransaction 保证两文件一致）与 `deleteCharacter(library, id)`（先写 index 再删 record 文件）。`ensureUniqueReferences` 与 `ensureCultivationReferences` 的入参由完整 record 数组改为 index 条目数组加当前变更的单条 record，避免全量加载。
loop: until typecheck 通过
max_iterations: 4
verify: npm run typecheck

- [ ] **Step 12: 为 characters 分片仓库写单元测试**
action: 新建 `src/renderer/workbenches/novel/characterLibraryRepository.test.ts`，仿照 `itemLibraryRepository.test.ts` 的 `NovelMemoryStorage` 构造方式，覆盖：`load` 只读 meta 与 index 且不触碰 records 目录；`saveCharacter` 同时写 record 与 index 条目；`saveCharacter` 在 record 写入失败时回滚 index；`deleteCharacter` 移除 index 条目并删除 record 文件；两次并发 `saveCharacter` 改不同角色时互不触发 CAS 冲突。
loop: until 全部用例通过
max_iterations: 4
verify: npx vitest run --project unit src/renderer/workbenches/novel/characterLibraryRepository.test.ts

- [ ] **Step 13: 更新项目初始化蓝图**
action: 在 `src/renderer/workbenches/novel/projectInitialization.ts` 的 `DIRECTORIES` 中新增 `"characters/records"`，在 `EMPTY_DIRECTORY_MARKERS` 中新增 `"characters/records/.gitkeep"`。在同文件的项目级 `.gitignore` 内容块（约 L130）中追加一行 `.cache/`，并在其上方加一行注释说明该目录存放可重建的派生投影。
loop: false
verify: npx vitest run --project unit src/renderer/workbenches/novel/projectInitialization.test.ts

- [ ] **Step 14: 切换渲染层读取 characters/index.json 的调用点**
action: 依次修改 `src/renderer/workbenches/novel/domainIndex.ts`（L82、L94）、`crossLibraryReferences.ts`（L78、L372）、`knowledgeGraph.ts`（L508）和 `CultivationEcologyWorkbench.tsx`（L2130、L2133）。这些位置此前假定 `characters/index.json` 内嵌完整 record；改为消费 Step 10 定义的 index 条目字段。凡需要 record 内独有字段的位置，改为调用 `loadCharacter` 按需读取。
loop: until typecheck 通过
max_iterations: 5
verify: npm run typecheck

- [ ] **Step 16: 为服务端 readIdSet 锁定分片 index 契约**
action: `src/server/tools/novel-workbench-tool.ts` 的 `readIdSet`（L2018-L2032）只从 `characters` 数组的每个条目提取 `.id`，分片后的 index 条目仍保留 `id`，因此 L2061 与 L2188 两处调用无需改动。新建 `src/server/tools/novel-workbench-tool-idset.unit.test.ts`，构造一份分片形态的 `characters/index.json`（条目仅含 `id`、`name`、`recordPath`、`updatedAt`，不含完整 record 字段），断言 `readIdSet` 仍返回正确的 id 集合。若 `readIdSet` 当前非导出则改为导出以便测试。文件名必须使用 `.unit.test.ts` 后缀，否则 `npm run test:classification` 会失败。
loop: until 用例通过
max_iterations: 3
verify: npx vitest run --project unit src/server/tools/novel-workbench-tool-idset.unit.test.ts

- [ ] **Step 17: 更新全部 characters 测试 fixture**
action: 更新 `domainIndex.test.ts`、`crossLibraryReferences.test.ts`、`knowledgeGraph.test.ts`、`useDomainIndex.test.tsx`、`CommandPalette.test.tsx`、`KnowledgeGraphView.test.tsx`、`projectInitialization.test.ts` 中的 characters fixture，把内嵌完整 record 的 `characters/index.json` 改为 index 条目加对应 `characters/records/<id>.json` 文件。
loop: until unit 与 dom 两个 project 全绿
max_iterations: 5
verify:
  - type: shell
    command: npx vitest run --project unit
  - type: shell
    command: npx vitest run --project dom

- [ ] **Step 18: 引入 rusqlite 依赖**
action: 在 `src-tauri/Cargo.toml` 的 `[dependencies]` 段落新增 `rusqlite = { version = "0.32", features = ["bundled"] }`，并在其上方加注释说明该依赖仅用于可丢弃的小说领域派生投影，事实源仍是 Markdown 与 JSON。使用 `bundled` feature 以避免在 Windows 构建机上依赖系统 SQLite。
loop: false
verify: cargo build --manifest-path src-tauri/Cargo.toml

- [ ] **Step 19: 实现 Rust 侧投影表结构与重建逻辑**
action: 新建 `src-tauri/src/novel_projection/mod.rs` 与 `src-tauri/src/novel_projection/schema.rs`。数据库落在项目根的 `.cache/novel-projection.db`。建三张表：`entities(id TEXT, kind TEXT, name TEXT, source_path TEXT, updated_at TEXT, PRIMARY KEY(kind, id))`、`refs(from_kind TEXT, from_id TEXT, to_kind TEXT, to_id TEXT, field TEXT)`、`meta(key TEXT PRIMARY KEY, value TEXT)`。`meta` 存事实源指纹（参与投影的文件数与最大 mtime）。实现 `rebuild(project_root) -> Result<(usize, usize), String>` 扫描 `characters/index.json`、`world/factions/index.json`、`world/items/index.json`、`world/locations/index.json`、`timeline/index.json`、`narrative/index.json` 六个索引并填表，返回实体数与引用数。所有路径解析必须复用 `crate::workspace_files::path_safety` 的既有工作区内解析函数，禁止拼接未校验路径。
loop: until cargo build 通过
max_iterations: 4
verify: cargo build --manifest-path src-tauri/Cargo.toml

- [ ] **Step 20: 为投影重建与指纹失效写 Rust 单元测试**
action: 在 `src-tauri/src/novel_projection/mod.rs` 内新增 `#[cfg(test)] mod tests`，用 `tempfile` 构造临时项目目录，覆盖：空项目重建得到 0 实体；含两个角色索引条目时重建得到 2 实体；重复调用 `rebuild` 结果幂等；事实源文件变更后指纹不匹配。若 `tempfile` 尚未在 `[dev-dependencies]` 中则一并加入。
loop: until cargo test 通过
max_iterations: 4
verify: cargo test --manifest-path src-tauri/Cargo.toml novel_projection

- [ ] **Step 21: 暴露投影查询的 Tauri command**
action: 新建 `src-tauri/src/novel_projection/commands.rs`，实现三个 command：`cmd_novel_projection_rebuild(workspace: String) -> Result<(usize, usize), String>`、`cmd_novel_projection_list_entities(workspace: String, kind: Option<String>) -> Result<Vec<EntityRow>, String>`、`cmd_novel_projection_inbound_refs(workspace: String, kind: String, id: String) -> Result<Vec<RefRow>, String>`。三者均以 `validate_workspace_root` 开头。在 `src-tauri/src/lib.rs` 的 `invoke_handler` 生成器中注册这三个 command，位置紧随现有 `workspace_files::save_file::cmd_workspace_save_file`（L630）之后。
loop: until cargo build 通过
max_iterations: 4
verify: cargo build --manifest-path src-tauri/Cargo.toml

- [ ] **Step 22: 定义 WorkbenchProjection 能力契约**
action: 新建 `src/shared/workbench-sdk/projection.ts`，仿照 `src/shared/workbench-sdk/search.ts` 的形状：顶部中文块注释说明该能力由 Tauri 桌面端的 rusqlite 投影提供、浏览器开发模式下 `isAvailable` 为 false 且工作台必须降级为直接读文件、投影可随时删除重建且不得成为项目打开的前置条件。导出 `WorkbenchProjectionEntity`、`WorkbenchProjectionRef` 两个只读接口与 `WorkbenchProjection` 接口（含 `isAvailable`、`listEntities(kind?)`、`inboundRefs(kind, id)`、`rebuild()`）。在 `src/shared/workbench-sdk/index.ts` 追加 `export * from './projection';`。
loop: false
verify: npm run typecheck

- [ ] **Step 23: 在宿主层接线投影能力**
action: 仿照 `WorkbenchSearch` 的注入链路接线新能力：在 `src/renderer/workbench-sdk/types.ts` 的 workbench 能力对象中新增 `readonly projection: WorkbenchProjection`；在 `src/renderer/workbench-sdk/WorkbenchShell.tsx` 中新增 `onProvideProjection` prop 与 `UNAVAILABLE_PROJECTION` 常量（三个方法分别 reject 或返回空数组，`isAvailable: false`）；在 `src/renderer/App.tsx` 中新增 `provideWorkbenchProjection` 回调（调用 Step 21 的三个 command）并通过 `onProvideWorkbenchProjection` 传入。在 `src/renderer/workbench-sdk/index.ts` 导出新类型。
loop: until typecheck 与 lint 通过
max_iterations: 5
verify: npm run typecheck

- [ ] **Step 24: 新增内存版投影替身供测试使用**
action: 在 `src/renderer/workbenches/novel/testStorage.ts` 中新增导出 `NovelMemoryProjection implements WorkbenchProjection`，以内存 Map 承载实体与引用，`isAvailable` 可通过构造参数切换，用于覆盖投影可用与不可用两条分支。
loop: false
verify: npm run typecheck

- [ ] **Step 25: domainIndex 优先走投影并保留文件降级**
action: 修改 `src/renderer/workbenches/novel/domainIndex.ts` 的 `buildDomainIndex`，新增可选 `projection` 参数。当 `projection.isAvailable === true` 时用 `listEntities` 一次取回全部实体构造 `DomainEntityRef[]`；否则保留现有的逐库 `loadOptional` 全量读取路径。两条路径必须产出结构完全一致的结果。
loop: until domainIndex.test.ts 全绿
max_iterations: 4
verify: npx vitest run --project unit src/renderer/workbenches/novel/domainIndex.test.ts

- [ ] **Step 26: 为 domainIndex 双路径一致性写测试**
action: 在 `src/renderer/workbenches/novel/domainIndex.test.ts` 追加用例：同一份 fixture 分别以 `NovelMemoryProjection`（可用）与不传 projection 两种方式调用 `buildDomainIndex`，断言两次结果深度相等；再断言投影不可用时不抛错且回退到文件路径。
loop: until 用例通过
max_iterations: 3
verify: npx vitest run --project unit src/renderer/workbenches/novel/domainIndex.test.ts

- [ ] **Step 27: findInboundReferences 优先走投影**
action: 修改 `src/renderer/workbenches/novel/crossLibraryReferences.ts` 的 `findInboundReferences`（L363 起），新增可选 `projection` 参数。投影可用时改用 `inboundRefs(kind, id)` 单次查询替代当前把所有库读入内存的表扫描；不可用时保留现有实现。在 `crossLibraryReferences.test.ts` 追加两条路径结果一致的用例。
loop: until crossLibraryReferences.test.ts 全绿
max_iterations: 4
verify: npx vitest run --project unit src/renderer/workbenches/novel/crossLibraryReferences.test.ts

- [ ] **Step 30: 全量静态检查与测试**
action: 依次运行 `npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run test:dom`、`cargo test --manifest-path src-tauri/Cargo.toml`，修复暴露出的类型错误、lint 违规与测试失败。不得通过放宽 lint 规则或跳过测试来达成绿灯。
loop: until 全部命令退出码为 0
max_iterations: 6
verify:
  - type: shell
    command: npm run typecheck
  - type: shell
    command: npm run lint
  - type: shell
    command: npm run test:unit
  - type: shell
    command: npm run test:dom
  - type: shell
    command: cargo test --manifest-path src-tauri/Cargo.toml

- [ ] **Step 31: 构建测试包到全新测试目录**
action: 运行 `$env:MYAGENTS_PACKAGE_NO_PAUSE='1'; & .\Package-MyAgents-Test.cmd -TargetRoot 'F:\workspace\MyAgents-test-v2'`。该脚本会构建 Release 应用并执行启动冒烟测试。不要操作、关闭或替换用户已在运行的其它 MyAgents 实例；若冒烟测试因已有实例占用而失败，改用 `-SkipSmokeTest` 重试一次并在完成时说明该限制。
loop: until 脚本退出码为 0
max_iterations: 2
verify:
  type: artifact
  path: F:\workspace\MyAgents-test-v2\app
  assert:
    kind: exists

- [ ] **Step 32: 在全新空项目上验证分片落盘形态**
action: 启动 `F:\workspace\MyAgents-test-v2` 中的测试包，新建一个空小说项目（项目名 `分片验证`），在人物库创建两个角色。随后运行以下 PowerShell 校验并要求全部输出 `PASS`：确认 `characters\records` 下存在恰好 2 个 `.json` 文件；确认 `characters\index.json` 的 `characters` 数组长度为 2；确认该数组首个条目包含 `recordPath` 键且不包含 `relations` 键（证明完整 record 已不再内嵌）；确认项目根 `.gitignore` 含 `.cache/` 一行。
loop: until 全部校验输出 PASS
max_iterations: 3
verify:
  type: shell
  command: powershell -NoProfile -Command "$p='F:\workspace\MyAgents-test-v2\小说\分片验证'; $r=Get-ChildItem \"$p\characters\records\*.json\" -ErrorAction SilentlyContinue; $i=Get-Content \"$p\characters\index.json\" -Raw | ConvertFrom-Json; $e=$i.characters[0]; $g=Get-Content \"$p\.gitignore\" -Raw; if($r.Count -eq 2){'PASS records=2'}else{throw \"FAIL records=$($r.Count)\"}; if($i.characters.Count -eq 2){'PASS index=2'}else{throw 'FAIL index count'}; if($e.PSObject.Properties.Name -contains 'recordPath'){'PASS recordPath'}else{throw 'FAIL recordPath missing'}; if($e.PSObject.Properties.Name -notcontains 'relations'){'PASS not-inlined'}else{throw 'FAIL record still inlined'}; if($g -match '\.cache/'){'PASS gitignore'}else{throw 'FAIL gitignore'}"
