# Workbench Platform Foundation

> Workbench 是 MyAgents 的产品模块扩展协议。它与 Claude Plugin（Skill / Agent / Hook / MCP）以及 OpenClaw Channel Plugin（IM 渠道）相互独立。

## 当前范围

本阶段提供编译期注册的受信任工作台基础设施：

- 纯共享 `workbench-sdk`：manifest、API 版本协议、打开请求和 Tab target；
- Renderer SDK：工作台定义、密封注册表、懒加载模块契约；
- 工作台 Tab 与 `WorkbenchShell`；
- Workspace / WorkspaceTemplate 的 `workbenchId` 归属；
- `OPEN_WORKBENCH` 打开协议；
- dependency-cruiser 架构硬门。
- Workbench API 1.1 的工作区根绑定通用存储接口。
- Workbench API 1.2 的声明式新项目初始化协议。
- Workbench API 1.3 的完整 MyAgents Agent Session 宿主端口。
- Workbench API 1.7 的页面导航守卫注册接口。

本阶段不包含工作台后台进程、动态下载、第三方代码沙箱、工作台自有存储后端或用户可配置的领域 MCP。API 1.1 的通用存储端口与 API 1.2 的项目初始化均委托 MyAgents 已有 Workspace File Service，不引入第二套文件 IO owner；API 1.3 的大型 AI 任务委托现有 Chat Session 生命周期。

## 目录与依赖方向

```text
src/shared/workbench-sdk/          # 跨进程纯协议；不得依赖 renderer/server/cli
src/renderer/workbench-sdk/        # React 宿主 SDK 与 WorkbenchShell
src/renderer/workbench-host/       # SDK 能力到 MyAgents 内部实现的私有适配层
src/renderer/workbenches/          # 具体官方工作台
src/renderer/workbench-registry.ts # 唯一聚合点
```

依赖只能沿以下方向流动：

```text
MyAgents Core -> workbench-sdk <- Concrete Workbench
                    ^
                    |
          workbench-registry (唯一聚合点)
```

禁止：

- 核心模块直接导入 `src/renderer/workbenches/*`；
- 具体工作台导入 `App`、Chat、Config Store、Sidecar 或其它宿主内部模块；
- shared SDK 导入任何进程专用模块；
- 为每个工作台增加新的 `Tab.view` 字面量。

## Manifest v1

```ts
interface WorkbenchManifest {
  manifestVersion: 1;
  id: string; // namespaced lowercase id
  name: string;
  description: string;
  version: string; // SemVer
  api: {
    major: number;
    minMinor: number;
    maxMinor?: number;
  };
  entry: {
    renderer: string; // logical module id, not a file path
    defaultRoute: string;
  };
  navigation: Array<{
    id: string;
    label: string;
    icon?: string;
    order?: number;
  }>;
  capabilities?: string[];
}
```

`parseWorkbenchManifest()` 在注册阶段一次性校验并冻结 manifest。`entry.defaultRoute` 必须指向声明过的 navigation id；工作台 ID 必须带命名空间，例如 `io.myagents.storyforge`。

## API 版本协议

宿主版本由 `WORKBENCH_HOST_API_VERSION` 定义，当前为 `1.7`。

- `major` 必须完全相同；
- 宿主 `minor` 必须大于等于 `minMinor`；
- 工作台声明 `maxMinor` 时，宿主不得超过该上限；
- patch 不参与宿主协议协商，工作台自身版本仍使用完整 SemVer。

不兼容的工作台仍保留在注册表中，Shell 显示明确的不兼容状态，而不是静默消失。

## 注册与加载

具体工作台使用 `defineWorkbench(manifest, load)` 声明，并只在 `src/renderer/workbenches/index.ts` 汇总。注册表启动时拒绝重复 ID，并提前计算兼容性。

工作台可以通过 definition options 的 `shell.defaultNavigationCollapsed` 声明左侧导航的默认状态。Shell 仍拥有展开 / 收起交互与响应式布局，具体工作台不得根据自身 ID 修改通用 Shell。

工作台 renderer 必须是懒模块：

```ts
export default defineWorkbench(manifest, () => import("./renderer"));
```

模块默认导出接收 `WorkbenchRendererProps`。宿主 context 只暴露稳定字段：manifest、workspacePath、workspaceName、route、isActive、`storage`、`agentSessions`、受控运行端口、`navigate()` 和 `registerNavigationGuard()`。

Workbench API 1.7 允许当前页面注册一个导航守卫。具体工作台只声明页面是否允许离开以及保存动作；Shell 统一串行化侧栏导航请求，App 在关闭工作台标签前调用同一守卫，并根据结果决定继续或留在原页。页面卸载时必须注销守卫，宿主不会替工作台推断 dirty 状态。

工作台需要浮层或选择器时使用 Renderer SDK 导出的 `Popover` 与 `CustomSelect`。这些原语统一提供 Portal、视口翻转、边界偏移、关闭语义和跨平台选择器样式，具体工作台不得直接导入宿主 `components/` 下的实现。

只读文件差异通过 Renderer SDK 的 `DiffViewer` 接入。该组件基于项目现有开源依赖 `@monaco-editor/react` / `monaco-editor` 的 `DiffEditor`，按需加载并统一本地 Worker、主题、CJK Unicode 规则和只读配置。具体工作台不得自行实现文本 diff 算法，也不得直接导入宿主 `components/MonacoEditor`。

## 通用存储接口

Workbench API 1.1 在 renderer context 中提供 `WorkbenchStorage`。它绑定当前 Workspace 根目录，所有参数都是使用 `/` 分隔的相对路径；绝对路径、`..` 穿越和 NUL 字节在进入宿主文件系统前即被拒绝。

稳定能力包括：

- 路径状态和目录枚举；
- UTF-8 文本读取、创建和原子写入；
- 基于 `expectedContent` 的外部修改冲突检测；
- 二进制读取；
- 目录递归创建、复制、移动、重命名和删除；
- 不暴露 Tauri watcher token 的粗粒度 Workspace 变更订阅。

该接口只提供通用存储原语。JSON/Markdown codec、Schema、实体目录、事务变更集和知识索引均由具体工作台在自身模块内定义；工作台不得绕过它直接导入 `useWorkspaceFileService` 或 Tauri API。

## 新项目初始化

Workbench API 1.2 允许 Launcher 项目创建器提交版本化的声明式初始化蓝图：相对目录、UTF-8 文本文件及可选 Git 初始化。具体工作台拥有目录和文件内容；宿主只做路径、数量和大小校验，并通过 Workspace File Service 调用 Tauri。

初始化蓝图当前最多包含 256 个目录、256 个文件；单个 UTF-8 文本文件最大 256 KiB，全部文件正文合计最大 2 MiB。该边界允许项目初始化携带可人工编辑的提示词注册表和 Markdown 快照，同时继续限制单次初始化的内存与磁盘占用。

Tauri 在目标目录同级创建随机暂存目录，完整写入全部内容并完成可选 `git init` 后，才原子重命名为目标目录。目标已存在时绝不覆盖；校验、写入或 Git 初始化失败时删除暂存目录。文件系统提交成功后 Launcher 才把 Workspace 写入 MyAgents 配置并打开 Workbench Tab。

## 完整 Agent Session

Workbench API 1.3 在 renderer context 中提供 `agentSessions`。大型领域任务调用 `agentSessions.open()`，只提交版本化请求、对话标题、初始消息和可选稳定提示词 ID。Shell 自动绑定当前 Workspace 路径并把请求交给 App 宿主。

工作台 AI 入口可声明可选 `historyGroupPath`，用于把最终 MyAgents Session 挂到项目内最多两级的历史分组。宿主负责在 pending Session 获得真实 ID 后持久化该字段；工作台不得通过会话标题推断或直接修改 `sessions.json`。未声明分组的普通会话继续直接显示在项目根下。

宿主负责查找已注册 Workspace、检查 Tab 上限、选择现有项目运行配置，并通过统一 `handleLaunchProject` 创建 MyAgents Chat Tab。具体工作台不得导入 Chat、TabProvider、Config Store、Sidecar 或模型接口，也不得自行维护消息列表和会话状态。

对于携带初始消息的工作台会话，宿主必须在打开 Chat Tab 前通过统一 Provider 解析链确认执行配置。内置 Runtime 按 Agent → Workspace → 全局默认 → 首个可用 Provider 的顺序解析，并跳过已停用、缺少凭据或不可用的候选项；最终 Provider 与 Model 必须作为成对的 `builtinSelection` 随初始消息交给 Chat。Runtime-backed Provider 使用 `providerExecutionIdentity`，外部 Runtime 使用 `runtimeModel`。系统没有任何可用模型服务时应在 Sidecar 创建前失败，不得让 Chat 首次自动发送回落到未经校验的旧配置。

`agentSessions.open()` 是显式用户操作。普通工作台 Tab 仍不挂载 `TabProvider`、不拥有 `sessionId`、不隐式启动 Sidecar。小型单次生成不复用此完整对话端口，后续通过独立的受控运行接口和统一运行投影接入。

工作台通过 `toolset` 请求的业务工具属于 MyAgents Host 原生能力：生命周期由工作台会话控制，不进入 MCP 设置，不允许用户开关，也没有面向用户的连接状态。Claude Agent SDK 当前只通过 `createSdkMcpServer()` 接收进程内自定义工具，因此 builtin Runtime 适配器可以在 SDK 边界使用该传输；`mcp__` 名称、server id 和连接术语都属于适配层实现细节，禁止进入工作台 UI、模型对用户的说明或故障恢复建议。其它 Runtime 应使用各自的宿主工具适配面，不得据此把工作台能力定义成领域 MCP。

## 打开与 Tab 语义

一个工作台 Tab 由 `(workbenchId, canonical workspacePath)` 唯一标识。调用方发送：

```ts
window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_WORKBENCH, {
  detail: { workbenchId, workspacePath, route?, title? },
}))
```

已打开时切换到现有 Tab，并可更新 route；否则创建 `view: 'workbench'` 的新 Tab。工作台 Tab 的 `sessionId` 为 `null`，不挂载 `TabProvider`，因此不会隐式创建 AI Sidecar。用户通过 `agentSessions.open()` 发起大型任务时，宿主另建拥有显式 Session owner 的普通 Chat Tab。

当前 `open-tabs.json` 仍只恢复真实 Chat Session，工作台 Tab 不跨重启持久化。直接把它加入现有恢复列表会让所有后台工作台 renderer 在启动时挂载；后续必须先增加不挂载 renderer 的 cold-workbench 状态，再开放恢复。

Workspace 或 WorkspaceTemplate 声明 `workbenchId` 后，Launcher 点击工作区卡片直接打开对应工作台；Launcher 中发送消息仍沿用普通 Chat 路径。

## WorkbenchShell

Shell 统一负责：

- 工作台与 Workspace 身份展示；
- manifest 驱动的导航和 route 归一化；
- 页面级未保存修改导航守卫；
- renderer 懒加载；
- 未注册、版本不兼容、模块加载失败和加载中状态；
- 工作台局部错误边界，避免具体 renderer 崩溃替换整个 MyAgents UI。

具体工作台只渲染内容区域，不复制标题栏、工作台导航或宿主错误状态。

## 验证门

提交新工作台或修改协议时至少运行：

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:dom
npm run build:web
```
