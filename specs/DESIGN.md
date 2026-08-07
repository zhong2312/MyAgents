# MyAgents Design Guide

> **Version**: 2.8.47
> **Last Updated**: 2026-08-04
> **Status**: Active
> **Platform**: macOS / Windows Desktop Client

> **阅读方式**：先读与任务匹配的规范章节，并用源码中的 Theme Token / 共享组件确认当前值；不要默认加载全文。末尾版本历史只解释演进，不是实现权威，普通前端任务无需读取。

---

## 设计理念

MyAgents 是一款 AI Agent 桌面客户端，采用**温暖纸张质感**的设计风格，营造舒适、专业的使用体验。

### 核心原则

- **易读有质感** - AI 生成大量内容，阅读体验是第一优先级
- **逻辑清晰有重点** - 不同内容块有明确的视觉层级，用户能快速定位关键信息
- **统一有秩序** - 所有页面、所有内容类型遵循相同的设计语言
- **温暖亲和** - 奶油白背景配合暖棕色文字，长时间使用不疲劳

### 产品特性考量

作为 AI Agent 产品，设计需特别关注：
- **长文本阅读** - AI 回复通常较长，需优化行高、段落间距
- **多种内容块** - 普通文本、代码、工具调用、思考过程等需要清晰区分
- **信息密度平衡** - 既要展示完整信息，又不能让用户感到压迫
- **跨平台一致性** - macOS 和 Windows 保持相同的视觉体验

### Theme 与 Appearance 的设计边界

MyAgents 的视觉由完整 `Theme` 管理；light / dark / system 是 `AppearanceMode`，不是三套 Theme。一套 Theme 必须同时交付并验收 light 与 dark，system 只跟随 OS 解析其中一套。

Production catalog 当前包含九套完整 Theme：MyAgents Light、MyAgents Classic、MyAgents Classic2、
Sage、Claude、Linear、Proof、Codex、Raycast。`myagents-default`（用户可见名 MyAgents Classic）仍是 canonical
fallback；它的物理 owner 是：

- `src/renderer/theme/themes/myagents-default.css`：通用首帧 fallback + 精确 Theme root / light / dark root 下的字体角色、颜色、材质、圆角、阴影、动画和 Floating Ball 运行时 Token；同一文件既静态保护 canonical 首帧，也由 manifest 提供实际 source 给注册校验与 runtime 激活；
- `src/renderer/theme/themes/myagents-default.ts`：Launcher Hero 与 xterm / Monaco / Mermaid / Prism / Widget adapters；
- `src/renderer/theme/themes/<preset>.css + <preset>.ts`：七套 preset-built palette Theme 的共置 package；CSS
  显式拥有完整 visual Token，manifest 只用 `?inline` 读取同一份源码，adapter 从这份 CSS 的语义
  色板派生，不复制 canonical 值；构造与 Registry 校验共享语义解析器，不依赖 production minifier
  是否保留属性引号、空白或末尾分号；
- `myagents-light` 是当前产品默认：完整复制 Claude host Token，只将 light
  `button-primary-bg/hover` 改为中性黑；dark 与五类 embedded adapter 与 Claude 保持一致；
- `default-black`（用户可见名 MyAgents Classic2）保留为 canonical 的受控 Baseline A/B：同样只将 light
  主按钮改为中性黑，dark、Hero 与五类 embedded adapter 与 MyAgents Classic 保持同源；两组差异都由测试锁定；
- `src/renderer/index.css`：与品牌视觉无关的布局、交互、七档 Type Scale，以及不携带视觉值的 Tailwind runtime Token 编译桥。

组件只消费语义 Token 或 `useResolvedTheme()` adapter，不持有 light/dark palette，不观察 `.dark` 反推状态。Widget adapter 必须提供 iframe 可直接使用的 literal，不能引用宿主 `var(...)`。完整 Theme 不允许让用户混搭颜色、字体、背景等零件；某 Theme 缺项时整套回退 canonical default。

可主题化：宿主与 Space 的色彩/字体/材质、Launcher Hero 两行内容和可选 bundled 背景、语法/图表/终端/编辑器/Widget iframe、Floating Ball。非主题化：布局与信息架构、业务状态机、原生窗口按钮、Browser 子 Webview 网页、用户内容、三方品牌 Logo/二维码、宠物 spritesheet。Space 不维护第二套 palette；其 paper、文字、圆角、阴影、动作色与业务状态色直接继承当前全局 Theme。

九套 Theme 的产品顺序和动作语义：

| Theme | 主要视觉角色 |
|---|---|
| MyAgents Light | Claude 的柔和中性色表面与陶土强调色；当前产品默认，light 主按钮使用中性黑 |
| MyAgents Classic / MyAgents Classic2 | 暖纸张、陶土橙；Classic2 仅将 Classic 的 light 主按钮改为中性黑，本章色值表仍只描述 canonical Theme |
| Sage | PR #441 的鼠尾草绿与自然纸面 |
| Claude / Linear / Proof / Codex / Raycast | 陶土橙 / 靛蓝 / 森林绿 / 标准蓝 / 珊瑚红 |

Primary CTA 必须消费 `--button-primary-*`；Accent 控制 Toggle 启用态、关键选中指示、
Focus、链接和进行中状态。success/error/warning/info 继续使用各 Theme 自己的业务
状态组，第三方品牌色不随 Accent 改写。紧凑卡片 hover
仍只增加 Theme 的 `shadow-sm`，不使用描边或位移模拟层级。

注册、bootstrap 和 adapter 细则见 `tech_docs/theme_system.md`。

---

## 1. 颜色系统 (Colors)

下列值描述 canonical `myagents-default` 的 light scheme；真实定义以
`src/renderer/theme/themes/myagents-default.css` 为准。dark scheme 也在同一文件中完整定义。

### 1.1 核心色板

#### Ink (文字色)
| Token | 值 | 用途 |
|-------|------|------|
| `--ink` | `#1c1612` | 主文字、标题 |
| `--ink-secondary` | `#2e2825` | 次级标题、重要内容 |
| `--ink-muted` | `#6f6156` | 辅助文字、描述、placeholder |
| `--ink-subtle` | `#a69a90` | 弱化文字、时间戳、提示 |

#### Paper (背景色)
| Token | 值 | 用途 |
|-------|------|------|
| `--paper` | `#faf6ee` | 主背景 |
| `--global-sidebar-bg` | `#f5efe5` | 全局 App Shell 侧栏背景；比主背景略深、比 inset 克制 |
| `--paper-elevated` | `#fffcf7` | 卡片、弹层背景 |
| `--message-user-bg` | `#fffefa` | 用户 Query 气泡背景（比对话页更白，去阴影后保持层次） |
| `--paper-inset` | `#e8dccf` | 输入框内部、小按钮 hover |
| `--hover-bg` | `rgba(194, 109, 58, 0.07)` | 通用列表项 hover（7% 暖橙） |

#### Accent (强调色)
| Token | 值 | 用途 |
|-------|------|------|
| `--accent` | `#c26d3a` | 交互强调色（= accent-warm；不承担 Primary CTA） |
| `--accent-warm` | `#c26d3a` | 链接、Focus、关键选中与进行中状态 |
| `--accent-warm-hover` | `#e18a58` | 强调态 hover |
| `--accent-warm-subtle` | `rgba(194, 109, 58, 0.08)` | 微弱强调背景 |
| `--accent-warm-muted` | `rgba(194, 109, 58, 0.15)` | 选中态强调背景 |
| `--on-accent` | `#ffffff` | Accent 实底状态上的配对前景色，light / dark 均为白色；Primary CTA 使用独立的 `--button-primary-fg` |
| `--accent-cool` | `#2e6f5e` | 冷强调色（文件夹、标签） |
| `--accent-cool-hover` | `#3d8a75` | 冷强调 hover |

#### Border (边框)
| Token | 值 | 用途 |
|-------|------|------|
| `--line` | `rgb(28 22 18 / 0.10)` | 默认边框 |
| `--line-strong` | `rgb(28 22 18 / 0.18)` | 强调边框、hover 边框 |
| `--line-subtle` | `rgb(28 22 18 / 0.06)` | 弱化边框、分割线 |

### 1.2 语义色 (Semantic Colors)

用于状态反馈，需谨慎使用，避免页面过于花哨。

| Token | 值 | 背景色 | 实色表面前景 | 用途 |
|-------|------|-------|-------------|------|
| `--success` | `#2d8a5e` | `#e2f0e8` | `--on-success` | 成功、已启用、已完成（暖化绿） |
| `--error` | `#dc2626` | `#fee2e2` | `--on-error` | 错误、失败、危险操作 |
| `--error-hover` | `#b91c1c` | — | `--on-error` | 危险按钮 hover（消除硬编码） |
| `--warning` | `#d97706` | `#fef3c7` | `--on-warning` | 警告、需注意 |
| `--info` | `#4a7ab5` | `#e4ecf4` | `--on-info` | 信息提示、加载中（暖化蓝） |

**使用原则**：
- 语义色仅用于状态指示，不作为装饰
- 优先使用图标+文字，颜色作为辅助
- 背景色用于 toast、badge，主色用于图标、文字
- 主色作为实色 surface 时必须使用对应的 `--on-success/error/warning/info`，禁止借用 `--on-accent` 或硬编码白色

### 1.3 按钮专用色

| Token | 值 | 用途 |
|-------|------|------|
| `--button-primary-bg` | `#c26d3a` | 主按钮背景 |
| `--button-primary-bg-hover` | `#b05e2d` | 主按钮 hover |
| `--button-primary-text` | `var(--on-accent)` | 主按钮文字，light/dark 自动保持对比度 |
| `--button-dark-bg` | `#1c1612` | 固定深色按钮/tooltip 背景（特殊场景） |
| `--button-dark-bg-hover` | `#3a3532` | 固定深色按钮 hover |
| `--button-dark-text` | `#ffffff` | 固定深色 surface 的配对前景；dark 中为 `#e4dcd4` |
| `--button-secondary-bg` | `#e8dccf` | 次按钮背景 |
| `--button-secondary-bg-hover` | `#ddd0c2` | 次按钮 hover |
| `--button-secondary-text` | `#1c1612` | 次按钮文字 |

### 1.4 透明度层级 (Opacity Levels)

在需要更细腻的层次区分时，可对颜色 token 使用透明度修饰符：

| 透明度 | 用途 |
|--------|------|
| `/70` | 次要描述文字、弱化路径 |
| `/60` | Section 标题、辅助标签 |
| `/50` | 时间戳、极弱化文字 |
| `/45` | 附属信息、最弱化提示 |

**使用原则**：
- 优先使用 `--ink-muted`、`--ink-subtle` 等语义化 token
- 透明度修饰符用于同一 token 内需要更细层次的场景
- 常用组合：`text-[var(--ink-muted)]/60`

**示例**：
```jsx
// Section 标题 - 使用 /60 透明度
<h3 className="text-[var(--ink-muted)]/60">工作区</h3>

// 路径文字 - 使用 /70 透明度
<p className="text-[var(--ink-muted)]/70">/Users/project/path</p>

// 时间戳 - 使用 /50 透明度
<span className="text-[var(--ink-muted)]/50">20:53</span>
```

---

## 2. 字体系统 (Typography)

### 2.1 字体族

跨平台字体策略：macOS 优先使用系统字体，Windows 使用对应的系统字体作为 fallback。

> ⚠️ **雅黑陷阱**：`sans-serif` / `monospace` 通用字族在中文 Windows 上映射到 SimSun / NSimSun（宋体），CJK 字符在它们那里会被"成功"命中 → 后续的 `Microsoft YaHei` 永远轮不到。
> 因此 Latin-only 子链 **不能**以 `sans-serif` 结尾，组合链的通用字族兜底必须放在整条链的**最末端**（CJK 字体之后）。

```css
/* myagents-default.css — Theme 只拥有运行时视觉值 */
:root,
html[data-theme-id='myagents-default'] {
  /* Latin-only 子链：结尾无 generic */
  --font-latin: 'SF Pro Text', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI';
  /* CJK 子链：macOS 苹方 → Windows 微软雅黑（加 Microsoft YaHei UI 容错） */
  --font-chinese: 'PingFang SC', 'Microsoft YaHei', 'Microsoft YaHei UI', 'Hiragino Sans GB';
  /* 等宽 Latin-only：结尾无 generic */
  --font-mono-latin: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'Fira Code';

  /* 公共 Token：generic 只在整条链最末 */
  --font-body: var(--font-latin), var(--font-chinese), sans-serif;
  --font-display: var(--font-latin), var(--font-chinese), sans-serif;
  --font-code: var(--font-mono-latin), var(--font-chinese), monospace;
}

/* index.css — Tailwind 编译期桥，不复制 Theme 值 */
@theme inline {
  --font-sans: var(--font-body);
  --font-mono: var(--font-code);
}
```

Theme package 中禁止声明 raw `@theme`：它在 runtime 动态注入时不会再经过 Tailwind 编译，
会让 `font-sans` / `font-mono` 静默退回 Tailwind 默认字体。编译指令只存在实际 Tailwind
入口 `index.css`，运行时值只存在已注册 Theme package。

**平台字体映射**：
| 用途 | macOS | Windows |
|------|-------|---------|
| 英文正文 | SF Pro Text | Segoe UI |
| 英文标题 | SF Pro Display | Segoe UI |
| 中文 | PingFang SC (苹方) | Microsoft YaHei (微软雅黑) |
| 等宽/代码 | SF Mono | Cascadia Code / Consolas |

### 2.2 字号层级 (Type Scale)

基于 **16px** 作为 AI 回复正文的基准字号设计，确保长文本阅读的舒适性。
Token 定义在 `src/renderer/index.css` 的 `@theme` 块（单一真相源，同时驱动
`text-xs` / `text-sm` 等 Tailwind utility 与配对行高）。

> v2.5（PRD 0.2.34 Part 3）双合并后，`text-xs/sm/base/lg/xl` 已**回归 Tailwind 官方值**，
> 同名异值陷阱仅剩两条：`text-2xl`=**22px**（官方 24）、`text-3xl`=**28px**（官方 30）。
> **禁止 `text-[Npx]` 任意字面量**（eslint 强制）——幽灵字阶曾长到 ~700 处，
> 是"字号大小不一"用户投诉的根因（PRD 0.2.34 统一清理）。
> 已删除的档位类名 `text-2xs`/`text-2sm`/`text-md` 同样被 eslint 封禁
> （token 已不存在，写了编译不报错但字号静默失效）。

终局七档（等距 2px 步进至 18），每档唯一职责，新场景先归档位再写代码：

| 档位 | Token / Utility | 大小 | 行高 | 唯一职责 |
|------|----------------|------|------|---------|
| meta | `--text-xs` / `text-xs` | 12px | 1.45 | 时间戳、badge、计数、快捷键、分类头(uppercase)、描述行、hint |
| ui | `--text-sm` / `text-sm` | 14px | 1.5 | 按钮、菜单项、树节点、tab、工具卡、控制台输出、Markdown 表格 |
| prose | `--text-base` / `text-base` | 16px | 1.7 默认；Markdown 1.625 | **正文主体**——AI 回答、用户气泡、widget body、输入框* |
| display | `--text-lg/xl/2xl` | 18/20/22px | 1.5/1.4/1.3 | 弹窗标题/Markdown H3、H2、H1 |
| stat | `--text-3xl` / `text-3xl` | 28px | 1.2 | 数据大数字（占用率百分比等）、页面大标题 |
| brand | `--text-brand` | 56px | 1.1 | 品牌名（Launcher 品牌区与 Settings About） |

**已废除**（详见 changelog）：10px 档（v2.3）；11px micro 与 12px caption 合档为 12px
meta（v2.5——11px 中文在 Windows 低分屏雅黑下偏虚，且 11/12/13 三连密排是"大小不一"
观感残留）；13px ui 与 14px dense 合档为 14px（v2.5 用户裁决——产品以 AI 对话阅读为
核心，密度气质从 IDE 系移向阅读舒适系；`--text-2sm`/`--text-md` token 与类名全部删除）；
9 / 10.5 / 12.5 / 15 / 17px 等离阶孤值（唯一 px 字面量例外：Launcher 品牌 slogan
15/17px，见 §15.2，带 eslint-disable 立档）。

**\*立档例外与禁令边界**：
- 聊天输入框 textarea（SimpleChatInput）行高为 26px 整数常量（≈1.625）——自适应高度
  计算依赖整数像素，不随 prose 档 1.7 配对行高，属字号同档、行高立档例外。
- eslint 只封禁 **px 字面量**；rem/em 相对值（Theme brand title `2.5/3.5rem`、行内代码 `0.9em`）
  与 `style={{fontSize}}` API 配置项（Monaco/xterm/语法高亮等）不在射程内——新增此类
  用法需对照本表自证档位。
- 悬浮球伴侣窗（`src/renderer/floating-ball/fb.css`）已于 v2.5 对齐本字阶（全部
  font-size 走 `var(--text-*, fallback)`，AI 消息挂 `.ai-message-content`，详见
  PRD 0.2.35 §12.5）。fb.css 不在 eslint 射程内——新增 fb 文字 MUST 用 token，
  禁止裸 px。

**字号使用原则**：
- AI 回复与文档预览的 Markdown 正文使用 16px / 1.625；保持正文可读性的同时，让短段落和列表形成清晰聚落
- AI 回复内的 Markdown 表格用 dense 档：td=14px，th=12px uppercase（表格是密集内容，
  但 13px 会在同一条消息内造成肉眼可见跳变；v2.5 起 ui 档即 14，自然归一）
- 全部按钮（含工具栏 ghost）使用 14px（text-sm），配合 h-3.5 w-3.5 图标；按钮文字下限 14px
- 时间戳、状态、描述行、hint 等辅助信息统一 12px（text-xs，meta 档）
- Markdown 标题：H1=22px, H2=20px, H3=18px, H4-H6=16px
- 菜单分组头统一形态：`text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60`
- Widget 沙箱与宿主同阶：body 16px；h1=20/h2=18/h3=16（嵌入式卡片，比文档标题低一档，
  沙箱已预置重置，AI 不允许自设标题字号）；utility .text-xl=20/.text-2xl=22 与宿主一致

### 2.3 字重

| Token | 值 | 用途 |
|-------|------|------|
| `--font-light` | 300 | 品牌大字、slogan |
| `--font-normal` | 400 | 正文 |
| `--font-medium` | 500 | 小标题、标签、按钮 |
| `--font-semibold` | 600 | 标题、重要内容 |
| `--font-bold` | 700 | 强调（谨慎使用） |

### 2.4 字间距

| Token | 值 | 用途 |
|-------|------|------|
| `--tracking-tight` | -0.02em | 大标题 |
| `--tracking-normal` | 0 | 正文 |
| `--tracking-wide` | 0.04em | 小标签、slogan |
| `--tracking-wider` | 0.08em | 大写标签（如 "AGENT UI"） |

---

## 3. 间距系统 (Spacing)

采用 4px 基准网格。

| Token | 值 | 用途示例 |
|-------|------|---------|
| `--space-0.5` | 2px | 图标与文字间距 |
| `--space-1` | 4px | 紧凑元素间距 |
| `--space-1.5` | 6px | 按钮内边距（垂直） |
| `--space-2` | 8px | 小组件间距、列表项间距 |
| `--space-3` | 12px | 组件内边距 |
| `--space-4` | 16px | 卡片内边距、区块间距 |
| `--space-5` | 20px | 区块内边距 |
| `--space-6` | 24px | 大区块间距 |
| `--space-8` | 32px | 页面边距、大分隔 |
| `--space-10` | 40px | 区域分隔 |
| `--space-12` | 48px | 页面区块分隔 |

---

## 4. 圆角系统 (Border Radius)

Theme package 拥有 `--theme-radius-*` 运行时值，`index.css` 只把它们桥接为
Tailwind `rounded*` utility 的 `--radius-*` 别名。因此组件继续使用 `rounded-lg`
或 `var(--radius-lg)` 时，实际值仍由当前 Theme 决定。

| Theme Token / Utility Alias | 值 | 用途 |
|-------|------|------|
| `--theme-radius-base` / `rounded` | 4px | 基础圆角 |
| `--theme-radius-sm` / `rounded-sm` | 6px | 小按钮、输入框、标签 |
| `--theme-radius-md` / `rounded-md` | 10px | 按钮、下拉菜单 |
| `--theme-radius-lg` / `rounded-lg` | 14px | 卡片、弹层 |
| `--theme-radius-xl` / `rounded-xl` | 20px | 大卡片、面板 |
| `--theme-radius-2xl` / `rounded-2xl` | 24px | 模态框、全屏面板 |
| `--theme-radius-full` / `rounded-full` | 9999px | 胶囊按钮、头像 |

---

## 5. 阴影系统 (Shadows)

当前 Theme 在 light/dark scheme 中分别定义 `--theme-shadow-*`；`index.css`
通过无视觉值的 `@theme inline` 桥接，使 `shadow` / `shadow-xs/sm/md/lg/xl/2xl`
和 `hover:shadow-*` 在运行时读取当前 Theme，不得回退到 Tailwind 默认蓝灰阴影。
下表是 canonical light scheme：

| Tailwind Class | 值 | 用途 |
|----------------|------|------|
| `shadow-xs` | `0 1px 2px rgb(28 22 18 / 0.05)` | 微弱提升感 |
| `shadow-sm` | `0 2px 8px rgb(28 22 18 / 0.08)` | 按钮、小卡片 |
| `shadow-md` | `0 8px 24px rgb(28 22 18 / 0.12)` | 下拉菜单、弹层 |
| `shadow-lg` | `0 16px 40px rgb(28 22 18 / 0.16)` | 模态框、浮层 |
| `shadow-xl` | `0 24px 48px rgb(28 22 18 / 0.20)` | 全屏面板 |
| `shadow-2xl` | `0 32px 64px -12px rgb(28 22 18 / 0.25)` | 最高层浮层 |

CSS var aliases (`--shadow-*`) 由 Tailwind 编译桥产生；Theme contract 校验的 owner
是 `--theme-shadow-*`。

---

## 6. 组件规范

### 6.1 按钮 (Buttons)

#### 按钮尺寸规范

| 类型 | 字号 | 内边距 | 图标尺寸 | 圆角 | 场景 |
|------|------|--------|---------|------|------|
| 大按钮 | 14px | py-2.5 px-5 | h-4 w-4 | radius-full | 主要 CTA |
| 中按钮 | 14px | py-2 px-4 | h-3.5 w-3.5 | radius-lg | 表单提交、弹窗操作 |
| 小按钮 | 14px | py-1.5 px-3 | h-3.5 w-3.5 | radius-md | 卡片内操作 |
| 工具栏按钮 | 14px | py-1.5 px-2.5 | h-3.5 w-3.5 | radius-lg | 页头工具栏、输入框工具栏 |

#### 主按钮 (Primary)
```
背景: var(--button-primary-bg)
文字: var(--button-primary-text)
圆角: var(--radius-md) 或 var(--radius-full)
内边距: py-2 px-4 (中) | py-2.5 px-5 (大)
字号: 14px (text-sm) font-medium
图标: h-3.5 w-3.5
```

实底 Primary 控件在 light / dark 都优先使用白色/近白前景；当来源 Accent 偏亮时，
Theme 必须为 `--button-primary-bg` 使用同色相的更深 action shade，并保证正常与
hover 都不低于 4.5:1。Accent 实底选中控件仍由 `--on-accent` 按实际明度配对，
不随 Primary 一刀切反转。

#### 次按钮 (Secondary)
```
背景: var(--button-secondary-bg)
文字: var(--button-secondary-text)
边框: 1px solid var(--line)
圆角: 同主按钮
内边距: 同主按钮
```

#### Ghost/工具栏按钮
```
背景: transparent
文字: var(--ink-muted)
圆角: var(--radius-lg)
内边距: py-1.5 px-2.5
字号: 14px (text-sm) font-medium
图标: h-3.5 w-3.5
Hover 背景: var(--paper-inset)（小型图标按钮）或 var(--hover-bg)（列表行内按钮）
Hover 文字: var(--ink)
```

**工具栏按钮示例** (Chat 页面顶部、SimpleChatInput 底部):
```jsx
<button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5
  text-sm font-medium text-[var(--ink-muted)]
  hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
  <Plus className="h-3.5 w-3.5" />
  新对话
</button>
```

#### 危险按钮 (Danger)
```
背景: var(--error)
文字: var(--on-error)
Hover: var(--error-hover)
用于: 删除、不可恢复操作
```

#### 强调按钮 (Accent)
```
背景: var(--accent)
文字: var(--on-accent)
Hover: var(--accent-warm-hover)
用于: 下载、跳转等次要强调操作
```

#### 文字链按钮 (Text Link)
```
背景: transparent
文字: var(--ink-muted), text-xs
Hover 背景: var(--paper-inset)
Hover 文字: var(--ink)
用于: 卡片内"去官网"等外部链接入口
```

### 6.2 卡片 (Cards)

#### 主卡片（供应商/MCP/设置区块）
```
背景: var(--paper-elevated)
边框: 1px solid var(--line)
圆角: var(--radius-lg)
内边距: var(--space-5) (p-5, 20px)
Hover: 添加 var(--shadow-sm)
```

#### 紧凑卡片（Grid 内技能/命令/工作区 + 任务中心想法/任务）
```
背景: var(--paper-elevated)
边框: 无（v2.3+）
圆角: var(--radius-lg) 或 --radius-xl
内边距: var(--space-4) (p-4, 16px)
静态: 无阴影（纯填色，融在底纸上）
Hover: shadow-sm（0 2px 8px rgb(28 22 18 / 0.08)）
动效: transition-shadow（仅阴影过渡，无边框/位移）
```

**v2.3 变更原因**：同一列表密集堆叠 N 张卡时，边框 + hover 位移会让页面显得"稀碎"。取消边框、用阴影强度变化承载 hover 反馈，卡片更像"漂在温暖纸张上"，静态整体感更强。

### 6.3 输入框 (Inputs)

```
背景: var(--paper) 或 transparent
边框: 1px solid var(--line)
圆角: var(--radius-sm)
内边距: 10px 12px
字号: var(--text-base)
Placeholder: var(--ink-muted)
Focus: border-color 变为 var(--ink)
```

### 6.4 标签 (Badges/Tags)

```
背景: var(--paper-inset)
文字: var(--ink-muted)
圆角: var(--radius-sm) 或 var(--radius-full)
内边距: 2px 8px
字号: var(--text-xs) font-medium
```

#### 状态标签
- 成功: `bg: var(--success-bg), text: var(--success)`
- 错误: `bg: var(--error-bg), text: var(--error)`
- 警告: `bg: var(--warning-bg), text: var(--warning)`

### 6.5 下拉菜单 (Dropdowns)

```
背景: var(--paper-elevated)
边框: 1px solid var(--line)
圆角: var(--radius-md)
阴影: var(--shadow-md)
Item 高度: 36px (紧凑) | 40px (标准)
Item Hover: 背景 var(--hover-bg)（列表类）或 var(--paper-inset)（小型弹出菜单）
Item 选中: 文字 var(--accent-warm)
```

### 6.6 开关 (Toggle/Switch)

```
宽度: 44px (w-11)
高度: 24px (h-6)
圆角: var(--radius-full)
关闭背景: var(--line-strong)
开启背景: var(--accent)
滑块: 20px (h-5 w-5) 圆形, bg-[var(--toggle-thumb)] shadow；所有 production Theme 的 light / dark 均使用白色/近白控制面
滑块位置: 关闭 translate-x-0, 开启 translate-x-5
光标: cursor-pointer, 加载中 cursor-wait, 禁用 cursor-not-allowed
```

### 6.7 Overlay 遮罩层 (Overlay Backdrop)

所有模态框、全屏面板、弹层等 Overlay 统一使用**毛玻璃遮罩**，营造层次感和沉浸式体验。

```
背景: bg-black/30
模糊: backdrop-blur-sm
```

**统一组件**：
```jsx
<OverlayBackdrop onClose={handleClose} className="z-[200]">
  <div className="rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-2xl">
    弹层内容
  </div>
</OverlayBackdrop>
```

所有新 Overlay 必须复用 `src/renderer/components/OverlayBackdrop.tsx`，不要手写裸 backdrop。组件封装了正确的 pointer dismissal 语义；`className` 只补 z-index、padding、overflow 等布局差异，图片预览用 `variant="dark"`。可关闭 Overlay 还必须用 `useCloseLayer(handler, zIndex)` 注册关闭层，且 z-index 与视觉层级一致，避免 Cmd+W 跳过 Overlay 直接关闭 Tab。

内嵌 `BrowserPanel` 是全表面例外：它承载浮于 React DOM 之上的原生 child Webview，窄布局时必须让同一个 Chat / Tab-owned host 原位铺满 Chat，不能通过 `OverlayBackdrop` 重挂载或重建 Webview。其全屏关闭层 z-index 必须与视觉层级一致，并与分屏、工具栏、Browser Tab × 复用同一个关闭 callback；只有当前 active Browser view 可以消费该关闭层。

全局历史搜索由 DOM 顺序早于 Tab 工作区的 `GlobalSidebar` 声明，因此 `HistorySearchOverlayFrame` 的稳定外壳必须 portal 到 `document.body`。这里不能只提高 `z-index`：macOS WKWebView 的 overflow scrollbar 使用独立合成层，后续 Tab 滚动面仍可能穿透较早的 backdrop。未来新增或重构同类 App 级 Overlay 时应先核对 owner 与 DOM 绘制顺序；页面内部、天然位于自身滚动面之后的局部 Overlay不受此约束。

**适用范围**：
- 模态框（ConfirmDialog、SessionStatsModal 等）
- 全屏面板（WorkspaceConfigPanel、Settings 弹层等）
- 选择器弹层（SkillDialogs、PathInputDialog 等）
- 日志面板（UnifiedLogsPanel）
- 历史搜索 Overlay（`HistorySearchOverlayFrame` + `HistorySearchOverlayContent`）

**例外**：
- 图片预览（ImagePreview）使用 `bg-black/80 backdrop-blur-sm`，深色背景便于查看图片内容
- 图片预览的双击、触摸板捏合、双指平移、鼠标拖拽和工具栏必须共享一个 viewport transform owner；双击在适应窗口与 200% 间切换，缩放锚定手势位置，放大后平移受图片边界约束，重置同时清除缩放、位移与旋转
- PDF / DOCX / PPTX 文档预览的各自 zoom owner 也必须消费统一的跨 WebView 捏合协议：WebView2 使用 Ctrl+wheel，WKWebView 使用 gesturestart/change；它们只复用缩放手势归一化，不继承 ImagePreview 的平移、拖拽或 transform state

**点击遮罩关闭**：
- 支持点击遮罩层区域触发关闭（等同于取消操作）
- `OverlayBackdrop` 内部使用 `onMouseDown` + `e.target === e.currentTarget`，避免从面板内拖选文字并在遮罩上松手时误关；业务组件只传 `onClose`，不要重复实现判断

**焦点保持**：
- 点击另一个控件仍需保留当前输入焦点时，在 `onMouseDown` 使用 `retainFocusOnMouseDown`（`src/renderer/utils/focusRetention.ts`）；不要在 `onClick` 后用 `requestAnimationFrame(...focus())` 抢回焦点，macOS WebKit 触摸板 tap 可能被吞掉

### 6.8 Section 标题 (Section Headers)

用于 Launcher、Settings 等页面的区块标题，统一样式确保页面一致性。

```
字号: 14px (text-sm)   ← v2.4 由 11px 上调至 13（用户裁决"标题取大"）；v2.5 随 ui 档合并至 14
字重: 600 (font-semibold)
字间距: 中文标签 tracking-[0.04em]；拉丁/大写标签 uppercase + tracking-[0.12em]
       （CJK 无大小写，0.12em 在 14px 中文上过散，按文种取距）
颜色: var(--ink-muted)（静态标题）或 var(--ink-muted) / 60%（Tab 式切换中的非选中态）
下边距: 12px (mb-3)
```

**Tailwind 类名**：
```jsx
{/* 静态 Section 标题（中文标签） — 始终全色 */}
<h3 className="mb-3 text-sm font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
  工作区
</h3>

{/* Tab 式 Section 标题 — 选中态全色，非选中态 /40，hover /60 */}
<button className={`text-sm font-semibold tracking-[0.04em] ${
  isActive ? 'text-[var(--ink-muted)]' : 'text-[var(--ink-muted)]/40 hover:text-[var(--ink-muted)]/60'
}`}>
  最近任务
</button>
```

**使用场景**：
- Launcher right rail 使用 §15.4 / §15.6 的 16px section 标题，不套用本段 14px 常驻面板标题
- TaskCenter / 插件面板等常驻面板的区块标题（静态）

**边界（14px (text-sm) 形态只用于"常驻页面/面板"的区块标题）**：
- 弹出层内分组头（菜单、popover、dropdown）维持 text-xs（12px）菜单形态：
  `text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60`（见 §2.2）
- 内容内小节标签（如工具卡的"输入/输出"）维持 `text-xs uppercase`——它们是 micro
  档的字段标签，不是区块标题
- 列表分桶分隔头（如 TaskListPanel BucketHeader：label + hairline 横线，自述
  "section divider 而非 heading"，视觉权重让位于下方卡片）维持 text-xs（12px）uppercase
  形态——它是内容流里的安静分隔符，升 14px 会与卡片标题抢权重

### 6.9 心跳组件 (Heartbeat)

心跳循环（Cron Task）功能使用专用暖化红色 Token，与 `--error` 语义色区分 — error 表示错误/危险，heartbeat 是功能状态色。

**Token 定义**：
```css
--heartbeat: #c75050;                       /* 暖化红（比 Tailwind red-500 偏暖） */
--heartbeat-bg: rgba(199, 80, 80, 0.10);    /* 心跳背景 */
--heartbeat-border: rgba(199, 80, 80, 0.20); /* 心跳边框 */
```

**使用规则**：
- 心跳组件（StatusBar、Overlay、工具栏按钮）中的红色 **必须** 使用 `--heartbeat` 系列 Token
- **禁止** 使用 Tailwind 原色 `red-500`、`red-500/10` 等
- 图标/文字颜色: `text-[var(--heartbeat)]`
- 背景/hover: `bg-[var(--heartbeat-bg)]`
- 边框: `border-[var(--heartbeat-border)]`
- StatusBar 背景使用 `color-mix(in srgb, var(--paper) 92%, var(--heartbeat))` 实现微妙的暖红底色

### 6.10 Hover 背景分层 (Hover Background)

交互元素的 hover 背景色根据元素类型分为两层，避免「一刀切」：

| 类别 | Token | 适用场景 |
|------|-------|---------|
| **列表行 / 大面积 hover** | `var(--hover-bg)` | 任务行、历史记录、侧边栏导航、目录树 item、命令菜单、Tab 切换、工具执行行 |
| **小型按钮 / 紧凑 hover** | `var(--paper-inset)` | 图标按钮、工具栏 ghost 按钮、表单内操作按钮、tooltip 内按钮 |

**`--hover-bg` 定义**：light 为 `rgba(194, 109, 58, 0.07)`，dark 为
`rgba(194, 109, 58, 0.12)`；统一使用暖橙低透明铺底，在两种 scheme 中保持品牌动作反馈。

**Tailwind 类名**：
```jsx
{/* 列表行 hover */}
<div className="hover:bg-[var(--hover-bg)]">任务项</div>

{/* 小按钮 hover */}
<button className="hover:bg-[var(--paper-inset)]">
  <Settings className="h-4 w-4" />
</button>
```

**适用组件**（列表行 hover 使用 `--hover-bg`）：
- Chat 页: 工具栏按钮、目录树 item、历史列表
- Launcher 页: 历史对话行、工作区筛选项
- Settings 页: 侧边栏 active 导航
- 工作区选择器: 下拉项
- 命令菜单: SlashCommandMenu item
- 历史搜索 Overlay: `HistorySearchOverlayContent` 会话行
- 工具执行列表: ProcessRow

### 6.11 设置页浮层面板字号规范 (Settings Overlay Font Sizes)

设置页的 MCP 工具浮层（Builtin MCP、Gemini Image、Playwright、Edge TTS）MUST 与供应商管理浮层（管理供应商）保持一致的字号层级：

| 元素 | 字号 | 颜色 | 说明 |
|------|------|------|------|
| 表单标签 (`<label>`) | `text-sm` (14px) font-medium | `var(--ink)` | 深色 + 14px，保证可读性 |
| 文本输入框 | `text-sm` (14px) | `var(--ink)` | 与标签同级 |
| 开关/设置项标题 | `text-sm` (14px) font-medium | `var(--ink)` | 如"无头模式"、"搜索增强" |
| 开关/设置项描述 | `text-xs` (12px) | `var(--ink-muted)` | 如"后台运行，不弹出浏览器窗口" |
| 提示文字 (hint) | `text-xs` (12px) | `var(--ink-muted)` | 如"留空使用官方端点" |
| Section 分隔标题 | `text-sm` (14px) font-medium | `var(--ink-muted)` | 如"高级设置"、"语音参数" |
| 选择芯片 (pills) | `text-xs` (12px) | 选中/未选中色 | 如浏览器选择、设备选择 |
| 弹窗标题 | `text-lg` (18px) font-semibold | `var(--ink)` | 如"Playwright 浏览器设置" |
| Footer 按钮 | `text-sm` (14px) | — | "取消" / "保存" |

> 注：v2.3 之前本表的 px 标注（14px/12px）与实际 token 值不符——v2.3-2.4 真值为 `text-sm`=13px、
> `text-xs`=11px 才是当时真值；v2.5 双合并后 text-sm=14px、text-xs=12px，与 Tailwind 官方一致。

### 6.12 文案国际化 (UI Copy I18n)

新增或重构产品 UI 文案时，用户可见的稳定产品文案 SHOULD 进入 i18n resource，而不是直接硬编码在组件里。例外包括：用户/AI 生成内容、日志原文、调试输出、供应商返回的原始错误、仍未接入 i18n 的旧页面存量文案。

设计实现约束：

| 场景 | 要求 |
|------|------|
| 按钮 / 菜单 / Tooltip / Placeholder | 使用 `useTranslation()` 从对应 namespace 取文案 |
| 多语言长度差异 | 容器必须允许换行或有稳定宽度；不要按中文短文本假设按钮宽度 |
| 图标按钮 | 图标仍按本设计规范选择；`title` / `aria-label` 文案走 i18n |
| 时间 / 数量 / Cron 摘要 | 用 locale-aware formatter；不要手拼只适合中文的单位和语序 |
| Native chrome（托盘等） | 文案归 Rust native i18n 表；普通 React UI 文案归 renderer JSON |

语言设置 UI 使用 `CustomSelect`，不能使用原生 `<select>`。新增语言的完整技术流程见 `tech_docs/i18n_architecture.md`。

### 6.13 选中指示层级

- 顶部 Tab 是高频上下文切换：active 底线使用 2px、`var(--accent)` 70% 透明度，并收窄到内容槽内侧；厚度保证识别性，透明度和长度负责控制视觉重量。
- Settings 侧栏是页面内主导航：active 保留 `var(--hover-bg)` 底色，指示条使用 2px、`var(--accent)` 80% 透明度；移动端横条保持同一强度。
- 两者共享 Accent；侧栏通过底色和更高不透明度表达更高层级，禁止分别硬编码具体主题色。

---

## 7. 布局规范

### 7.1 断点

| Token | 值 | 说明 |
|-------|------|------|
| `--breakpoint-mobile` | 640px | 移动端/桌面端分界 |

### 7.2 容器宽度

| 用途 | 最大宽度 | 布局 |
|------|---------|------|
| 消息列表 | 768px (max-w-3xl) | 单栏 |
| 设置 - 通用/关于 | 576px (max-w-xl) | 单栏 |
| 设置 - 供应商/MCP/技能/Agent | 896px (max-w-4xl) | 双栏 grid-cols-2 gap-4 |

### 7.3 侧边栏

| 属性 | 值 |
|------|------|
| 全局侧边栏展开态 | 256px |
| 全局侧边栏 rail | 64px（16px 功能图标中心线固定于 x=32px） |
| rail 工作区 flyout | 320px |
| 设置页内部侧边栏 | 208px (w-52) |

### 7.4 Header 高度

```
固定高度: 48px (h-12)
内边距: 0 16px
```

---

## 8. 动效规范

### 8.1 Transition Duration

| Token | 值 | 用途 |
|-------|------|------|
| `--duration-fast` | 150ms | 按钮、开关 |
| `--duration-normal` | 200ms | 菜单、展开 |
| `--duration-slow` | 300ms | 页面切换、模态框 |

### 8.2 Easing

| Token | 值 | 用途 |
|-------|------|------|
| `--ease-default` | `ease` | 大多数过渡 |
| `--ease-out` | `ease-out` | 弹出动画 |
| `--ease-in-out` | `ease-in-out` | 双向过渡 |

### 8.3 常用动效

```css
/* 按钮 hover */
transition: background var(--duration-fast),
            border-color var(--duration-fast),
            transform var(--duration-fast);

/* 点击反馈 — 统一 scale(0.98)，全局生效
   `:not(:has(...))` 保证只有最内层被按下的元素缩放；点卡片内部按钮时，
   外层卡片不会跟着动。 */
button:active:not(:disabled):not(:has(:is(button, [role="button"], [data-tree-row]):active)),
[role="button"]:active:not(:has(:is(button, [role="button"], [data-tree-row]):active)),
[data-tree-row]:active:not(:has(:is(button, [role="button"], [data-tree-row]):active)) {
  transform: scale(0.98);
}

/* 下拉菜单出现 */
transition: opacity var(--duration-normal),
            transform var(--duration-normal);
transform-origin: top;

/* 模态框 */
transition: opacity var(--duration-slow),
            transform var(--duration-slow);
```

### 8.4 交互反馈原则

所有可交互元素都应有明确的状态反馈：

| 状态 | 反馈方式 |
|------|----------|
| Hover | 背景色变化、文字颜色加深 |
| Active/Press | 统一缩放 `scale(0.98)` |
| Focus | 边框高亮或轮廓 |
| Disabled | 降低不透明度、禁用光标 |

**点击动效已全局配置**（`button`、`[role="button"]`、`[data-tree-row]`），无需在各组件中单独添加。

---

## 9. 图标规范

### 9.1 尺寸

| 场景 | 尺寸 | Tailwind |
|------|------|----------|
| 极小辅助 | 10px | h-2.5 w-2.5 |
| 内联文字 | 12px | h-3 w-3 |
| 工具栏按钮 | 14px | h-3.5 w-3.5 |
| 主/次按钮 | 14px | h-3.5 w-3.5 |
| 导航菜单 | 16px | h-4 w-4 |
| 列表项 | 16px | h-4 w-4 |
| 卡片图标 | 16px | h-4 w-4 |
| 空状态 | 24px | h-6 w-6 |

**图标与按钮配合**：
- 14px 字号按钮 → h-3.5 w-3.5 图标
- 14px 字号按钮 → h-3.5 ~ h-4 图标
- 图标与文字间距: gap-1.5

### 9.2 颜色

- 默认: `var(--ink-muted)`
- Hover: `var(--ink)`
- 文件夹/文件: `var(--accent-warm)` (统一暖色调，保持页面视觉一致性)
- 成功: `var(--success)`
- 错误: `var(--error)`

---

## 10. AI 内容规范

作为 AI Agent 产品的核心，对话内容的展示需要特别规范。

### 10.1 内容层级体系

从高到低的视觉重要性：

| 层级 | 内容类型 | 视觉特征 |
|------|---------|---------|
| **L1** | AI 最终回复 | 清晰、大字号、高对比度 |
| **L2** | 用户输入 | 次要背景色区分，同等字号 |
| **L3** | 工具调用结果 | 边框卡片，可折叠 |
| **L4** | 工具调用过程 | 弱化样式，默认折叠 |
| **L5** | 思考过程 | 最弱化，斜体或更小字号 |

### 10.2 消息气泡 (Message Blocks)

#### AI 消息 (Assistant Message)
```
背景: transparent (与页面融合)
文字: var(--ink)
字号: var(--text-base) / 16px
行高: 1.625（26px；聊天与文档共用的 Markdown 阅读节奏）
段落间距: var(--space-3) / 12px
最大宽度: 768px (居中)
```

#### 用户消息 (User Message)
```
背景: var(--paper-inset)
文字: var(--ink)
圆角: var(--radius-lg)
内边距: var(--space-4)
字号: var(--text-base)，行高 1.625（与 AI Markdown 一致）
对齐: 右侧（或左侧皆可，但需与 AI 区分）
```

#### 对话 Rewind / Fork 操作

- Builtin 沿用 SDK anchor 行为；Codex 仅在当前版本支持且消息已持久化 exact root-turn anchor 时显示入口，不能给 legacy/失败/进行中消息提供看似可用的按钮。
- Rewind 入口位于 user bubble，确认弹窗必须明确“只回溯对话，工作区文件不变”；输入区已有草稿或图片时还要明确目标消息会替换草稿。确认后立即乐观截断并把目标文本/图片放回输入区，失败则完整恢复操作前的消息和 composer。
- Fork 入口位于成功 assistant action row，成功沿用新 Tab 打开体验，不额外弹成功 toast。请求期间禁用重复提交。
- Codex Rewind 成功使用轻量成功反馈；native restore 暂时失败时说明回溯已生效、可重开继续，不能误报为回溯失败。分类错误用用户可理解的 `busy / anchor unavailable / update required / native fork / persistence / restore` 文案。

### 10.3 工具调用块 (Tool Call Blocks)

工具调用是 AI Agent 的核心交互，需要清晰但不喧宾夺主。

#### 工具调用卡片
```
背景: var(--paper-elevated)
边框: 1px solid var(--line)
圆角: var(--radius-md)
内边距: var(--space-3)

标题区:
  - 图标: 16px, var(--ink-muted)
  - 工具名: var(--text-sm), font-medium, var(--ink)
  - 状态标签: 右侧对齐

内容区:
  - 字号: var(--text-sm)
  - 字体: var(--font-mono)
  - 颜色: var(--ink-muted)
  - 可折叠，默认折叠长内容
```

#### 工具状态指示
| 状态 | 图标 | 颜色 |
|------|------|------|
| 执行中 | Loader (旋转) | var(--info) |
| 成功 | Check | var(--success) |
| 失败 | X | var(--error) |
| 等待确认 | AlertCircle | var(--warning) |

### 10.4 代码块 (Code Blocks)

#### 行内代码
```
背景: var(--paper-inset)
文字: var(--ink)
字体: var(--font-mono)
字号: 0.9em (相对父元素)
圆角: var(--radius-sm)
内边距: 2px 6px
```

#### 多行代码块
```
正文背景: var(--paper-inset) / 30%，与 Chat tool/process 组共用同一表面
  - Light / Dark 均由当前 Theme 的 paper 层级自然适配
文字: Theme Prism Adapter 语法高亮，普通文字 var(--code-text)
字体: var(--font-mono)
字号: 14px (text-sm)
行高: 1.6
长行: 不换行，由代码正文自身 `overflow-x-auto` 承担横向滚动；该显式声明同时使正文在 App-level Tab 横滑手势前取得完整手势所有权，抵达边缘也不得切换 Tab
圆角: var(--radius-md)
内边距: var(--space-4)
边界: 1px solid var(--line)
阴影: none

头部:
  - 背景: Theme-owned var(--code-bg)（原代码正文色，作为比正文深一阶的标题面）
  - 与正文之间: 1px solid var(--line)
  - 语言标签: 左上角
  - 复制按钮: 右上角
```

Theme 与 AppearanceMode 正交：每套 Theme 必须分别交付 light/dark Code Token 与 Prism
palette。Light 不得复用 dark palette，Dark 也不能退回无主题色的通用纯黑；组件只消费
`ResolvedTheme.adapters.prism` 和 Code Token，不判断 Theme ID。

### 10.5 思考块 (Thinking Blocks)

AI 的思考过程，用户可选择查看。

```
默认状态: 折叠，仅显示 "思考中..." 或 "查看思考过程"
展开样式:
  - 背景: transparent
  - 左边框: 2px solid var(--line)
  - 内边距: var(--space-3) 0 var(--space-3) var(--space-4)
  - 文字: var(--ink-muted)
  - 字号: var(--text-sm)
  - 字体: 正常（非斜体，保持可读性）
```

### 10.6 权限请求块 (Permission Prompt)

当 AI 需要用户授权时显示。

```
背景: var(--warning-bg)
边框: 1px solid var(--warning) / 0.3
圆角: var(--radius-lg)
内边距: var(--space-4)

标题: font-medium, var(--ink)
描述: var(--text-sm), var(--ink-muted)
操作区:
  - 拒绝按钮: Ghost 样式
  - 允许按钮: Primary 样式
```

### 10.7 长文本阅读优化

#### 行高与段落
```css
/* Chat 与 Document 共用的 Markdown 正文 */
.markdown-content {
  font-size: var(--text-base);  /* 16px */
  line-height: 1.625;            /* 26px - 长文可读，短列表不漂散 */
  letter-spacing: 0;
}

/* 段落间距 */
.markdown-paragraph {
  margin-top: var(--space-3);    /* 12px */
}

/* 列表项间距 */
.markdown-list-item + .markdown-list-item {
  margin-top: var(--space-1-5);  /* 6px */
}

.markdown-list {
  margin-inline-start: var(--space-8); /* 32px，marker 与正文边界形成可见区隔 */
}
```

正文采用单向 `margin-block-start`：后一个内容块拥有间距，禁止同时给前后元素设置
上下 margin 后依赖 margin collapse。Chat 与 Document 使用同一默认节奏；`compact`
是唯一独立变体，正文 14px / 1.55、段落 8px、列表块 6px、列表项 4px、列表缩进 24px，并同步收紧
标题、表格、引用、代码块和分隔线，不能只缩字号。

#### 内容宽度
- 最大宽度限制 768px，避免单行过长影响阅读
- 居中显示，两侧留白形成阅读聚焦

#### 标题层级
在 AI 生成的 Markdown 内容中：
| Markdown | 样式 |
|----------|------|
| `# H1` | 22px, semibold, margin-top: 24px；到正文 8px |
| `## H2` | 20px, semibold, margin-top: 20px；到正文 8px |
| `### H3` | 18px, semibold, margin-top: 20px；到正文 8px |
| `#### H4` | 16px, semibold, margin-top: 16px；到正文 8px |
| `##### H5` | 16px, medium, margin-top: 12px；到正文 8px |
| `###### H6` | 16px, medium, margin-top: 12px；到正文 8px |

#### 表格 (Markdown Table)

表格是嵌在 16px 正文里的密集内容，比正文低一档（13px 会造成肉眼可见跳变，
PRD 0.2.34 P0-1 定为 14px；v2.5 起 ui 档即 14，dense 专用档已合并删除）：

| 元素 | 样式 |
|------|------|
| 单元格 (td) | `text-sm` (14px) |
| 表头 (th) | `text-xs` (12px), semibold, uppercase, tracking-wide, `var(--ink-muted)` |

### 10.8 内容块间距

不同内容块之间的间距规范：

| 场景 | 间距 |
|------|------|
| 消息之间 | var(--space-4) / 16px |
| 消息内段落 | var(--space-3) / 12px |
| 工具块与文本 | var(--space-3) / 12px |
| 代码块与文本 | var(--space-3) / 12px |
| 列表块上下 | var(--space-2) / 8px |
| 列表项之间 | var(--space-1-5) / 6px |
| 嵌套列表项之间 | var(--space-1) / 4px |

### 10.9 加载与过渡状态

#### AI 生成中
```
显示: 光标闪烁 或 "..." 动画
位置: 消息末尾
动画: shimmer 呼吸效果
```

#### 工具执行中
```
图标: Loader2 旋转动画
文字: "执行中..." var(--ink-muted)
进度: 可选的进度条
```

#### 内容流式输出
```
新内容: 逐字/逐块出现
滚动: 自动滚动到底部（用户手动滚动时暂停）
```

- 切到其他桌面应用不暂停 AI、SSE、消息保存或当前 active Chat 的可见刷新；窗口仍在双屏/分屏中展示时，即使失焦也继续实时渲染。只有 MyAgents 内部未展示、由 host 设为 `content-visibility:hidden` 的 inactive Tab 冻结虚拟列表输入。
- 若切走前仍在自动跟随，失焦期间继续显示当前最新输出并自动跟随；回到 MyAgents 时只允许一次无动画位置校正。
- 若切走前已主动上滑阅读历史，回到 MyAgents 时应保持同一消息及其相对视口位置；新输出只续在下方，不抢回底部。

#### 已有 Session 恢复

- 从 active cold Tab 尚未挂载 `TabProvider` 开始，到 REST 历史完成采用同一个稳定的 `ChatBootOverlay`；inactive cold Tab 仍保持廉价 paper placeholder。遮罩允许在同一 Chat 挂载周期内即时重新启用，只在退出时做轻量淡出。
- 历史内容只揭示一次：不得先显示 SSE cold replay、原始 Markdown / stringified ContentBlock 或旧 Session 内容，再用 REST 结果替换。
- REST 内容提交后直接显示最终排版；禁止在下一帧把已可见 MessageList 的 opacity 重置为 0 后再次淡入。
- `ChatBootOverlay` 是恢复期唯一的可见状态与旋转动画 owner，MessageList 不在其下重复挂载 loading。恢复失败时同一壳层原位显示失败态，并继续覆盖不可信的旧内容，直到用户重开、切换或新建对话。
- 恢复失败文案属于当前目标 Session 的 restore token，不与普通对话错误共用；后续实时快照成功修复时，最终内容与壳层退出同次提交。恢复壳存在期间发送按钮与 action boundary 都不可提交消息。

---

## 11. CSS 变量完整定义

```css
:root {
  /* ========== Colors: Ink ========== */
  --ink: #1c1612;
  --ink-secondary: #2e2825;
  --ink-muted: #6f6156;
  --ink-subtle: #a69a90;

  /* ========== Colors: Paper ========== */
  --paper: #faf6ee;
  --paper-elevated: #fffcf7;
  --paper-inset: #e8dccf;
  --hover-bg: rgba(194, 109, 58, 0.07);

  /* ========== Colors: Heartbeat ========== */
  --heartbeat: #c75050;
  --heartbeat-bg: rgba(199, 80, 80, 0.10);
  --heartbeat-border: rgba(199, 80, 80, 0.20);

  /* ========== Colors: Accent ========== */
  --accent: #c26d3a;
  --accent-warm: #c26d3a;
  --accent-warm-hover: #e18a58;
  --accent-warm-subtle: rgba(194, 109, 58, 0.08);
  --accent-warm-muted: rgba(194, 109, 58, 0.15);
  --on-accent: #ffffff;
  --accent-cool: #2e6f5e;
  --accent-cool-hover: #3d8a75;

  /* ========== Colors: Semantic ========== */
  --success: #2d8a5e;
  --success-bg: #e2f0e8;
  --on-success: #000000;
  --error: #dc2626;
  --error-bg: #fee2e2;
  --error-hover: #b91c1c;
  --on-error: #ffffff;
  --warning: #d97706;
  --warning-bg: #fef3c7;
  --on-warning: #1c1612;
  --info: #4a7ab5;
  --info-bg: #e4ecf4;
  --on-info: #000000;

  /* ========== Colors: Button ========== */
  --button-primary-bg: #c26d3a;
  --button-primary-bg-hover: #b05e2d;
  --button-primary-text: var(--on-accent);
  --button-dark-bg: #1c1612;
  --button-dark-bg-hover: #3a3532;
  --button-dark-text: #ffffff;
  --button-secondary-bg: #e8dccf;
  --button-secondary-bg-hover: #ddd0c2;
  --button-secondary-text: #1c1612;

  /* ========== Colors: Border ========== */
  --line: rgb(28 22 18 / 0.10);
  --line-strong: rgb(28 22 18 / 0.18);
  --line-subtle: rgb(28 22 18 / 0.06);

  /* ========== Typography ==========
     注：font 运行时值在 Theme root；index.css 的 @theme inline 只是编译桥。
     Latin-only 子链末尾不带 generic；组合链的 sans-serif / monospace 只出现在
     最末端 —— 避开 Chinese Windows 的 SimSun/NSimSun 回退坑。 */
  --font-latin: 'SF Pro Text', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI';
  --font-chinese: 'PingFang SC', 'Microsoft YaHei', 'Microsoft YaHei UI', 'Hiragino Sans GB';
  --font-mono-latin: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'Fira Code';
  --font-body: var(--font-latin), var(--font-chinese), sans-serif;
  --font-display: var(--font-latin), var(--font-chinese), sans-serif;
  --font-code: var(--font-mono-latin), var(--font-chinese), monospace;

  /* ========== Border Radius ========== */
  --theme-radius-base: 4px;
  --theme-radius-sm: 6px;
  --theme-radius-md: 10px;
  --theme-radius-lg: 14px;
  --theme-radius-xl: 20px;
  --theme-radius-2xl: 24px;
  --theme-radius-full: 9999px;

  /* ========== Animation ========== */
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
}
```

Shadow 运行时值是 Theme scheme 下的 `--theme-shadow-*`，Tailwind 只通过
`index.css` 的 `@theme inline` 编译桥生成 utility，详见第 5 节。dark scheme 使用更亮的
暖橙 Accent（`#d4803f`），Primary 则使用校深的 `#b05e2d` / `#9c5027` 与白色前景。
所有 production Theme 的 dark `--toggle-thumb` 均使用白色/近白控制面，与 light scheme 保持一致。

---

## 12. 跨平台规范

### 12.1 macOS vs Windows 差异处理

| 特性 | macOS | Windows | 处理方式 |
|------|-------|---------|---------|
| 字体渲染 | 更平滑 | 更锐利 | 使用系统字体，信任系统渲染 |
| 窗口控制 | 左上角红绿灯 | 右上角三按钮 | 使用系统原生控件；macOS Overlay inset 由 `NSWindow` 几何通知维护（见 §15），其余交给 Tauri |
| 滚动条 | 系统 Default，服从“自动 / 滚动时 / 始终显示”偏好 | WebView2 Fluent Overlay（Runtime ≥ 125；旧 Runtime 原生回退） | WebView / OS 负责显隐、hover 与拖拽；Renderer 不自绘 |
| 圆角 | 系统级大圆角 | 小圆角/直角 | 使用自定义圆角，两端一致 |

### 12.2 字体渲染优化

```css
body {
  /* 跨平台字体渲染优化 */
  -webkit-font-smoothing: antialiased;  /* macOS */
  -moz-osx-font-smoothing: grayscale;   /* macOS Firefox */
  text-rendering: optimizeLegibility;    /* 通用 */
}
```

### 12.3 滚动条样式

滚动条统一的是产品语义，不是跨平台硬编码同一组像素：静止时不抢注意力，滚动时反馈当前位置，鼠标或笔直接操作时提供平台原生的明确 hover / thumb / track 与拖拽能力。

- Windows：Tauri WebView creation policy 为所有共享默认 data directory 的 WebView 设置 `ScrollBarStyle::FluentOverlay`。受支持的 WebView2 Runtime 负责从轻量滚动指示器切换到鼠标 / 笔可直接操作的 Fluent scrollbar，显隐不能引起内容宽度变化；Runtime 低于 125.0.2535.41 时能力不生效并保留原生 Default，不用透明 thumb 伪装 overlay。
- macOS / Linux：保持 WebView `Default`，服从系统偏好、桌面环境与原生手势。应用不能用全局 6px 宽度、颜色或计时 class 覆盖系统行为。
- Theme：`ThemeRuntime` 继续把当前 scheme 投影到根节点 `color-scheme`；这只提供原生控件的 light / dark 语义，不接管 scrollbar 的交互状态。
- 标准位置：左侧全局侧栏、中央 AI 对话、右侧文件工作区必须保持各自独立的既有 scroll owner；能力列表等应用内常规滚动面遵循同一 native policy。MessageList、WorkspaceTreeViewport、GlobalSidebar 与能力列表使用 `scrollbar-gutter: stable` 保护 classic fallback 下的内容宽度，不新增平行 DOM scroller。
- 局部例外：仅允许组件职责明确的隐藏轨道（例如横向 Tab rail、设置导航）或组件自带实现（例如 Monaco）。局部规则必须作用域隔离，不能覆盖三个标准滚动面；embedded Browser 的第三方页面可由页面自身 CSS 改写外观，不承诺 MyAgents 视觉一致性。

禁止通过全局 `::-webkit-scrollbar`、`scrollbar-width: thin`、透明 thumb、scroll timer、pointer proximity 监听或第三方 ScrollArea 模拟原生输入感知行为。所有新增 Tauri WebView builder 必须复用 `src-tauri/src/webview_policy.rs`，避免同 data directory 的 WebView2 style 冲突。

---

## 13. 变量别名（v2.0 已清理）

v2.0 移除了所有旧别名。以下是唯一保留的等价关系：

| Token | 等价于 | 说明 |
|------|-------|------|
| `--accent` | `--accent-warm` | 一等公民强调色（非别名） |

**已删除的旧别名**（v2.0 全局替换完成）：
- `--paper-contrast` → 已替换为 `--paper-inset`
- `--paper-strong` → 已替换为 `--paper-elevated`
- `--paper-reading` → 已替换为 `--paper-elevated`
- `--ink-strong` → 已替换为 `--ink-secondary`
- `--accent-strong` → 已替换为 `--accent-warm-hover`
- `--accent-bg` → 已替换为 `--accent-warm-muted`
- `--shadow-soft` / `--shadow-strong` → 已替换为 Tailwind `shadow-lg` / `shadow-xl`
- `--paper-button` → 已替换为 `--button-secondary-bg`
- `--paper-subtle` → 已合并入 `--paper-elevated`

---

## 14. 使用示例

### Tailwind 类名映射参考

```jsx
// 主按钮 (14px)
<button className="flex items-center gap-1.5 bg-[var(--button-primary-bg)]
  text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]
  rounded-full px-4 py-2 text-sm font-medium transition-colors">
  <Plus className="h-3.5 w-3.5" />
  启动
</button>

// 工具栏按钮 (14px) - Ghost 样式
<button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5
  text-sm font-medium text-[var(--ink-muted)] transition-colors
  hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
  <Plus className="h-3.5 w-3.5" />
  新对话
</button>

// 卡片
<div className="bg-[var(--paper-elevated)] border border-[var(--line)]
  rounded-[var(--radius-lg)] p-4 hover:border-[var(--line-strong)]
  transition-colors">
  卡片内容
</div>

// 输入框
<input className="bg-transparent border border-[var(--line)]
  rounded-[var(--radius-sm)] px-3 py-2.5 text-sm
  placeholder:text-[var(--ink-muted)] focus:border-[var(--ink)]
  focus:outline-none transition-colors" />
```

---

## 15. 全局 App Shell 与 Launcher 规范

MyAgents 使用“双层注意力导航”：全局侧边栏回答“产品能力和资源在哪里”，顶部 Tab 回答“哪些窗口正在占用注意力”。侧边栏属于 `App` Shell，不属于 Launcher；所有占据主内容区的页面仍由 Tab 拥有。全局侧边栏是可选的：默认不挂载，用户可从标题栏显式开启。

### 15.1 布局结构

```
开启全局侧边栏时：

┌──────────────┬─────────────────────────────────────────┐
│ 全局侧边栏    │ 顶部 Active Tabs                         │
│              ├─────────────────────────────────────────┤
│ 全局入口      │                                         │
│ 工作区/历史   │ 当前 Tab 内容                            │
│              │                                         │
│ 小助理/设置   │                                         │
└──────────────┴─────────────────────────────────────────┘
```

- 全局栏开启时从窗口最顶部延伸到底部；右侧才是标题栏与 Tab Workspace。关闭时完全卸载全局栏，Tab Workspace 占满窗口宽度，不保留 rail、空白占位或后台数据订阅。
- 标题栏右上角提供全局侧边栏可见性滑动开关，默认关闭，并跨重启保存用户选择。Windows 中该控件位于最小化按钮左侧；它使用 44 × 24px 轨道、20px 滑块、`--toggle-off-bg` 关闭态和 `--accent-cool` 开启态，并暴露即时的 `aria-label` / `aria-checked` 状态。该开关决定全局栏是否挂载，不承担 rail/展开模式切换，也不得在侧栏内部复制第二个入口。
- macOS 红绿灯安全区属于侧栏顶部 chrome；Windows 窗口按钮仍固定在右侧标题栏最右端。原生窗口 zoom、拖拽 resize、全屏切换期间，红绿灯相对窗口左上角的 inset 与三按钮间距 MUST 逐帧稳定，不能先漂到系统默认位置再在动画结束后纠正。
- 全局栏开启后，常驻展开态 256px，rail 64px。rail/展开切换时布局槽一次提交到最终宽度，禁止用 `width` transition 持续重排主内容；视觉动效由固定 256px 的侧栏材质层以 `clip-path` 在 200ms 内横向揭示/收回，展开内容同步淡移，rail 内容交错接续。右侧 Tab 标题栏与当前 Tab 内容在最终布局上从旧视觉位置横向归位，让背景边界、Tab 与页面形成同一段空间运动。收起边界从右向左、展开边界从左向右，App Icon 与功能图标仍保持窗口坐标不动；`prefers-reduced-motion` 下立即切换。
- 开启全局栏后，其顶部 chrome 分两行：第一行 44px 承载原生窗口区、拖拽区与 rail/展开控制，第二行 40px 承载 App Icon + `MyAgents` 品牌。App Icon 使用 macOS App 风格的 22% 圆角矩形轮廓，在展开态与 rail 中始终保持 20px、固定于窗口 `x=22px` 且复用同一 DOM；其中心与 16px 功能图标共同落在 `x=32px` 中线上，切换时只让品牌文字出现或消失。品牌文字复用 Theme-owned 产品字标的字体、字距与渐变，紧凑角色保持 `text-sm / font-medium`，不复制 Launcher 的展示字号与轻字重。rail/展开控制两态共用简洁的单一 `PanelLeft` 轮廓，不叠加方向箭头；动作含义由即时 Tooltip 和 `aria-label` 表达。
- 顶部 Tab 保留 active、关闭、拖拽、溢出、生成中、未读与触摸板切换语义，侧栏不得建立第二套页面选中状态。
- 右侧标题栏与全局侧栏共用 `var(--global-sidebar-bg)` 单色根面，不使用 `paper → paper-inset` 混合渐变，也不在下方叠加横向分割线；材质色差直接承担顶部 chrome 与页面的分区。常规模式在侧栏边界后保留 8px leading inset；手动 rail 的 60px 预留同时包含固定 toggle 槽位及其后的 8px 留白，使 rail 收窄后首个 Tab 仍固定在窗口 `x=124px`。32px Tab 使用 Theme-owned `rounded-md`；active 与 hover 均使用 `var(--hover-bg)`，active 不增加常驻阴影，只额外保留 2px `var(--accent)` 底线。新增 Tab、溢出按钮与溢出渐隐都基于同一侧栏表面色，使顶部 Chrome 与左侧工作区共享克制的注意力反馈，而不新增 Tab 专属 palette。

### 15.2 全局侧边栏

全局侧边栏默认关闭，由标题栏右上角滑动开关决定是否挂载。关闭后不渲染侧栏内容、rail 或 flyout；重新开启时恢复已保存的 rail/展开、工作区树和会话显示偏好。

开启后的展开态从上到下依次为：原生窗口 chrome 与 rail/展开控制、独立产品身份行、新对话/搜索/任务/团队/技能与工具的连续主导航、Agent 工作区树、底部小助理/设置；其中团队入口仅在 Team Space 实验室开关开启且当前构建能力可用时出现，关闭后展开态与 rail 均不保留失效入口。主导航项与底部入口使用 36px 命中高度且不添加行间距；从主导航到 Agent 工作区、再到底部入口均不使用横分割线，主要层级只依靠 8–12px 组间留白、工作区标题和选中面，不将每组包成卡片。

全局侧栏根面与顶部 Tab 标题栏共同消费 Theme-owned `--global-sidebar-bg`。九套 Theme 的 light/dark 均在自身 `--paper` 与 `--paper-inset` 之间提供一个略深于页面的值，使两块 App Shell chrome 同时能与右侧 `--paper` 页面和 `--paper-elevated` 对话面形成克制分区；该色差独立承担分区，不再叠加侧栏右侧竖线或标题栏底部横线。该结构 Token 不替代通用 Paper 层级：右侧页面、卡片与弹层继续使用原有 Token，工作区/Session hover 与 active 也不随侧栏底色重算。

```
展开态 256px:
  顶部第一行: h-11；macOS 原生红绿灯 + rail/展开控制（全局可见性由右上标题栏滑动开关控制）
  品牌第二行: h-10；固定 x 的 20px 圆角矩形 App Icon + Theme 产品字标 text-sm/font-medium
  连续主导航行: h-9, px-3, text-sm, icon 16px, 行间距 0
  工作区标题行: h-12, text-xs, 弱化文字
  工作区行: h-9；14px 展开箭头保留 hover 内侧安全边距，分支线穿过箭头中心；icon / text-sm 名称维持导航列位置；整行只负责展开/折叠；顶层条目额外行间距 0
  Session 行: h-9；标题 text-sm 单行 truncate，来源 tag / 右侧时间 text-xs
  底部入口: h-9，额外行间距 0；固定且不随工作区历史滚动

rail 64px:
  图标按钮: 40 × 36px
  按钮左缘: x=12px；16px 功能图标左缘固定 x=24px，中心线 x=32px，与展开态及 rail 中线一致
  App Icon: 20px，左缘 x=22px；40px 官网链接命中区同样固定于 x=12px
  只有工作区入口打开 320px 可交互 flyout
  工作区 flyout: viewport top=128px / bottom=112px；起点高于入口，底部为固定动作区留位
  其它入口只显示即时黑底名称 Tooltip
```

手动 rail 中，App Icon 保持静态品牌身份；它只向功能图标中线校正一次，不在展开/收起时重新居中，切换时只显隐右侧文字，因此点击瞬间图标留在原地。主导航、工作区入口和底部入口也不按 rail 剩余宽度重新居中：40px 宽、36px 高的命中区统一固定于窗口 `x=12px`，其 16px 功能图标左缘在展开态与 rail 都保持 `x=24px`，因此整列图标切换时不发生横向抖动。rail/展开控制仍使用第一行同一个固定入口，不随侧栏宽度移动或复制造成双入口；它与标题栏右上角的全局可见性滑动开关是两项独立操作。自动 rail 中隐藏无法兑现的展开控制，仅保留静态品牌图标。所有侧栏图标按钮复用 Theme-owned `Tip`：hover/focus 无等待即时出现，使用 `--button-dark-bg / --button-dark-text`，不得回退浏览器原生 `title`；菜单打开期间隐藏对应 Tooltip。工作区 flyout 覆盖主内容而不推挤布局，按 viewport 固定在 `top=128px / bottom=112px`，让起点明显高于工作区入口并为底部小助理/设置留出安全区；资源树在这段稳定高度内自行滚动。flyout 使用轻量 opacity/translate 入场；真实离开交互区域才短延迟关闭，树枝展开/收起造成的布局边界事件若指针仍在 flyout 几何范围内不得误关；`Esc` 关闭并回焦入口。嵌套菜单、确认弹层和 flyout 共用同一交互生命周期。

产品身份行的 App Icon 与 `MyAgents` 字标共同组成紧凑官网链接，点击后通过系统默认浏览器打开 `https://myagents.io`；rail 中链接自然收缩为 App Icon。其 hover 只使用 pointer 光标，不铺整行或局部背景色，键盘焦点仍保留 Accent focus ring，避免把品牌入口误表现成主导航选中面。

活跃工作区的资源菜单固定按“Agent 设置 → 打开所在文件夹 → 置顶/取消置顶 → 归档 → 移除”排列：先放配置与定位等高频动作，再放排序和生命周期动作，危险的移除始终收尾。展开侧栏与 rail flyout 复用同一 `WorkspaceRow`，不得分别维护菜单顺序。

工作区标题行与每个活跃工作区行的右侧双动作采用同一优先级方向：低频“更多”在左，高频“新增工作区 / 新对话”固定在最右边缘。最右槽位不得因菜单打开状态或侧栏收展而交换，确保快速创建的屏幕边缘肌肉记忆稳定。工作区新建动作的 Tooltip 统一使用短文案“新对话”；列表首项的动作提示向下展开，避开滚动容器上边界裁切，其余条目保持向上展开。

### 15.3 工作区与 Session 树

- 工作区按置顶时间、最近打开时间、名称稳定排序；归档工作区位于默认收起的独立分组。
- 初次有效解析默认 Mino 时只种子展开一次；之后用户的展开/折叠选择跨重启保持，当前焦点投影不自动改写展开状态。
- 每个展开工作区首批显示 5 个 Session，“展开更多”每次追加 5 个；折叠再展开保留当前进程内分页数量。
- 工作区 Session 分支在展开侧栏与 rail 工作区 flyout 中复用同一段 200ms 纵向运动：展开先挂载内容，再以 `0fr → 1fr` 向下撑开并淡入；收起以 `1fr → 0fr` 向上回拢并淡出，完成后卸载 Session 子树。箭头旋转与分支同节奏，`prefers-reduced-motion` 下取消过渡；禁止逐条 Session stagger 或让已折叠分支持续常驻渲染。
- Session 读取状态按工作区隔离：某个工作区加载时只保留与 Session 行同高的透明占位，不显示深色块或 pulse；失败时只在该树枝显示原位重试，不遮蔽其它已成功工作区。
- 工作区整行只切换树；“在此工作区新建对话”和更多菜单是独立 hover/focus 动作，避免把资源浏览与启动混为一谈。工作区与 Session 资源行整体不可文本选中，右键按下只进入各自行的同一份上下文菜单，不得同时触发标题蓝色选区。
- Session 行可显示收藏、来源标签、时间和具体 Session 状态；工作区行与 rail 不显示聚合 badge。Session 行占满树枝到右侧边界，日期以 `ml-auto` 贴近右缘；更多菜单绝对悬浮在日期位置，hover/focus 时替换日期，不参与正常布局宽度。Session 更多/右键菜单第一行固定为“复制对话 ID”，复制与 Chat 内对话菜单一致的 `SessionID: <id>` 引用并给出成功或失败 Toast；随后才排列收藏、统计和删除。历史搜索浮层中的浏览行、全文命中行和 Session ID 直接命中行必须复用这同一个菜单组件，禁止复制菜单项后各自演化。
- Session 状态只投影顶部 Tab 的两类注意力信号：运行中显示 `--success` 绿色脉冲点，未读显示 `--accent-warm` 静态点，且运行中优先。当前选中、已在后台 Tab 打开和普通历史均不显示额外图标；它们分别由行 active/hover 表面和顶部 Tab 自身表达，禁止再为侧栏发明 active 圆点或“已打开”方块状态。
- 顶层工作区按连续资源树排布，工作区 wrapper 之间不添加额外 gap；工作区行与 Session 行都使用 `h-9`。普通工作区的展开箭头固定 14px：工作区列表使用 8px 左 inset，按钮再保留 4px 左 padding，避免箭头笔画贴住 hover 圆角面；箭头到工作区 icon 的间距同步由 8px 收到 4px，因此 icon 的绝对位置不变。工作区名称额外保留 4px 左 margin，使 icon 到名称仍为 8px，名称位置也不变。展开分支边线相对列表内容使用 10px 左缩进，使 1px 线的中心继续与箭头中心落在同一视觉轴；分支左 padding 由 8px 收到 4px，因此 Session 内容位置不变。工作区名称与 Session 标题都是主要可点击资源名，统一使用 `text-sm` 14px；层级由缩进、图标、颜色和字重表达。来源 tag 与日期保留 `text-xs` 12px meta 档，不能与主标题等权。工作区名称默认 `font-normal`，仅在 hover、focus、菜单打开、Launcher 关联或包含当前 Session 时升至 `font-medium`，避免静态资源列表持续争夺注意力。
- 资源树始终只有一个持久选中面：Launcher 选择工作区时，工作区行与普通 hover 统一使用 `var(--hover-bg)`；Chat 已进入具体 Session 时，只由 Session active 行使用 `var(--hover-bg)`，父工作区不同时涂底或声明 `aria-current`，仅以中等字重保留路径上下文。两者均不增加 `paper-elevated` 或阴影；小图标按钮 hover 使用 `var(--paper-inset)`。
- 空态、静默加载占位和局部失败重试都留在工作区滚动区域，不能拖垮全局导航或推走底部入口。rail 工作区 flyout 与侧栏消费同一个 `--global-sidebar-bg`，避免白色浮层从侧栏材质中突兀跳出。
- Chat 顶栏不再提供“返回启动页”：全局侧栏负责跨资源导航。侧栏普通“新对话”优先聚焦 Tab 顺序中最左侧的现有 Launcher，只有不存在 Launcher 时才新建；顶部 Tab 栏“+”继续明确承担强制新建，避免重复点击侧栏堆积空启动页。Chat 顶栏与全局侧栏的“新对话”动作共用 `MessageSquarePlus` 语义图标，避免同一动作在两个入口分别显示通用加号与对话图标。侧栏 Session 标题仅在真实截断且持续 hover 1 秒后，以逃逸滚动裁切的 Tooltip 展示完整标题；未截断或提前离开时不显示。工作区内历史浮层标题明确为“工作区历史记录”，避免被误解成跨工作区全局历史。
- Chat 顶栏默认不展示工作区历史入口，既有按钮、下拉内容与打开 / 聚焦逻辑继续保留；`AppConfig.showChatHistoryEntry` 缺省为 `false`，并由“设置 → 关于 → 开发者”中紧跟“开发者模式”的开关控制，切换后即时生效。全局侧栏中的跨工作区搜索与 Session 树不受影响。
- Chat 右侧工作区展开/收起共用无箭头的 `PanelRight` 轮廓，控制始终位于当前可用横向空间的最右侧；展开态顺序为 `Agent 设置 → 收起工作区`，隐藏后展开按钮占据同一最右槽位。工作区面板标题栏不再显示冗余的“工作区”文字，只保留左侧工具与右侧动作；Chat 与面板之间不使用通顶边框，只保留上下各 16px 留白的 1px 内部短分隔线。面板以 200ms 横向滑入/滑出，对话区在一次提交最终宽度后从旧视觉中心同步归位；窄屏 overlay 只移动面板、不扰动对话区。两项动作都使用共享即时黑底 `Tip`，不得同时保留浏览器 `title` 造成二次提示；`prefers-reduced-motion` 下立即切换。
- Chat 右侧工作区头部只展示工作区图标、名称、分支与路径，不展示文件/文件夹聚合计数，避免易过期的扫描结果与资源导航争夺注意力。底部 `Agent 能力` 初始收起，仅保留标题与总数；用户显式展开后再分配内容高度并渲染能力列表。
- 从全局侧栏点击 Session 时，顶部立即新增并激活目标 Tab，Chat 子树同时挂载并由自身 `ChatBootOverlay` 覆盖启动过程；Sidecar ensure/activation 在其后完成。失败时撤销临时 Tab 并恢复仍存在的前一 Tab，不能让点击后数秒无反馈，也不能在 ready 后把主动切走的用户强拉回来。rail flyout 以 active Tab identity 的真实切换作为导航已发生的反馈，同 Tab 成功由当前资源表面交互周期的动作结果兜底；工作区 flyout 与搜索 overlay 每次重新开关都推进该周期。激活前拒绝或异常保留列表供重试，已完成乐观切换后的启动失败只回滚 Tab、不强行复活旧资源面。任何工作区或 Session 旧请求完成都不能关闭用户后来重新打开的 flyout / 搜索 overlay。
- 历史搜索 Overlay 在冷模块加载时立即显示同尺寸搜索壳；App Shell 从点击开始唯一持有 Backdrop、面板 DOM、关闭层和一次入场动画，Suspense 只能替换面板内部内容，禁止真实内容就绪时重新挂载或重播 opacity-from-zero。搜索入口 hover/focus 预取内容模块，实际面板入场压缩到 160ms。非搜索浏览态只保留“全部 / 收藏”分类与工作区筛选，不再用“活跃中 / 桌面 / 聊天机器人”重复切割同一历史集合；Session 来源继续由行内 tag 表达。空搜索默认历史使用虚拟列表，只渲染可视区与小幅 overscan，连续滚动中不得一次 mount 全部 Session；非空全文检索结果保持现有 50 条上限，不另做前端分页。

### 15.4 Launcher 品牌区域

品牌区 JSX 只消费 `ResolvedTheme.hero`。产品名、zh-CN/en-US slogan、文字视觉参数和每个 scheme 的可选 bundled 背景槽都由 Theme 拥有；`BrandSection` 不硬编码 `MyAgents` 或 slogan source。canonical Theme 当前没有独立背景图，因此与迁移前视觉一致。

`.theme-product-wordmark` 是 Launcher、Settings About 与全局侧栏共同消费的 Theme-owned
产品字标基类，统一字体、字距与渐变。Launcher 与 About 再叠加
`.theme-launcher-hero-title`，拥有展示字号、轻字重、间距和响应式规则；侧栏只叠加
`text-sm / font-medium` 的紧凑角色。小尺寸不会机械继承 250/300 的展示字重，三处也不会复制品牌配色。

```
标题 "MyAgents":
  - 字号: 3.5rem (桌面) / 2.5rem (窄窗口)
  - 字重: 250（保持品牌独特感）
  - 字间距: 0.02em
  - 渐变: linear-gradient(155deg, var(--ink) 30%, var(--accent-warm) 100%)

标语（zh-CN / en-US 由 Theme 提供）:
  - 当前中文: "每个人都应享受智能的推背感，欢迎来到言出法随的世界"
  - 当前英文: "Your intent, amplified"
  - 字号: 17px (桌面) / 15px (移动)
  - 字重: 300 (font-light)
  - 字间距: 0.06em
  - 颜色: var(--ink-muted)

中文标语 "让每个人都有一个智能助手":
  - 字号: 15px (桌面 17px 见品牌立档例外；本行历史值已并入 slogan 单行)
  - 字重: 400 (font-normal)
  - 字间距: 0.08em
  - 颜色: var(--ink-muted) / 70%
  - 与英文标语间距: 10px (mt-2.5)
```

### 15.5 轻量 Launcher

Launcher 只负责创建新工作：品牌 Hero、对话/想法输入、工作区选择、模型/Runtime/权限/推理强度，以及发送前的工具、插件、定时等配置。页面使用单列居中布局，输入区继续消费既有 Theme Hero 与输入原语。

Launcher 不再展示工作区卡片、历史列表、搜索按钮、管理菜单或 dev-only Logs。所有工作区/Session 浏览和正式管理能力只存在于全局侧边栏，避免用户进入其它 Tab 后失去资源导航，也避免两个 surface 漂移。

Launcher 选中的工作区仅投影为全局树的关联高亮，不因此展开树、不提前创建 Session/Sidecar、不改变 pending Tab 的 birth 语义。

### 15.6 技能与工具 Tab

“技能与工具”是单实例功能 Tab，顶部使用 3 个克制的下划线子 Tab：技能、插件、工具。它与普通 Settings 分别在自己的 Tab slot 内保留导航、草稿和弹层状态，同时复用既有技能/插件/工具模块；普通 Settings 内部侧栏不再重复显示这三项。配置传播等 app-global effect 由配置层唯一拥有，不跟随页面 mount。

- 页面标题 `text-xl`，描述 `text-sm`；内容最大宽度 `max-w-4xl`。
- 子 Tab 使用 `role=tablist/tab` 与 `aria-selected`；选中指示为 2px accent 下划线，不做分段胶囊。
- 页面只保留一个外层内容滚动容器：标题与描述随内容自然上移；技能/插件/工具子 Tab 行到达内容顶部后才 sticky，背景消费 `var(--paper)` 并使用弱 blur。能力列表不得再建立与页面并列的主滚动区。
- 来自旧 Settings deep-link 的 skills/sub-agents/plugins/mcp 意图统一重定向到该 Tab；重复打开只聚焦已有 Tab。

### 15.7 设置导航与模型选择器

Settings 内部导航顺序固定为：模型供应商、通用设置、聊天机器人 Bot、桌面宠物、使用统计、网络代理、快捷键、关于。网络代理是独立子页，复用既有代理配置卡片、范围选择、连通性检测与 `ConfigProvider` 持久化/热传播链路；通用设置不再重复承载代理模块，供应商验证失败中的“配置代理”入口直接切到该子页。

About 页必须把软件授权作为用户可达的一等产品信息：在联系方式之后使用标准
`paper-elevated` 卡片说明 `AGPL-3.0-only` 社区许可与闭源商业授权的边界，并提供许可证、
对应源码、第三方声明和商业授权邮件四个入口。开源入口使用 inset 次按钮，商业授权使用
Primary CTA；所有链接复用 `ExternalLink`，不得由 WebView 原生导航接管。

AI 输入框的模型菜单拥有独立滚动区。打开时在首帧把当前模型居中放入可视范围，模型供应商或外部 Runtime 模型异步刷新后再次校正，不得调用会牵动页面滚动的全局 `scrollIntoView`。底部“管理自定义模型服务”入口仅在 AgentSDK 输入 chrome 显示：builtin 与 Managed Codex 均显示，用户自管 Claude Code / Codex CLI / Gemini CLI 不显示；点击后关闭模型菜单并打开或聚焦 `设置 → 模型供应商`。

AI 输入框的会话模式保持各 Runtime 既有文案、顺序与菜单样式，图标统一使用 1.75 stroke 的 Lucide“权限边界”词汇：只读规划统一为 `Eye`；需逐项确认的 Default / Suggest 为 `ShieldQuestion`；自动编辑文件的 Accept Edits / Auto Edit / Auto-Edit 为 `FilePenLine`；受约束自主执行的 builtin 行动 / Codex Full Auto 为 `ShieldCheck`；跳过审批或限制的 Full Agency / Bypass / YOLO / No Restrictions 为 `LockOpen`。未知的 Runtime 自定义模式继续展示自身声明的图标。

AI 输入框的“定时任务”属于低频创建动作，和引用文件、使用技能、上传文件一起收纳在 `+` 菜单内，不单独占用工具栏位置；Launcher 与 Chat 共用同一结构和 handler。`+`、会话模式与工具菜单统一使用 200ms 的 opacity + 纵向 translate（6px → 0）入场，不使用 scale，并在 `prefers-reduced-motion` 下取消动画；动效不得覆盖 Floating UI 的定位 transform。`@` 文件引用与 `/` 技能选择弹窗使用 `shadow-md`，与 AI 输入框本体保持同一悬浮层级。

### 15.8 任务创建面板

任务中心“新建任务”与“从想法派发”共用同一创建面板。面板不展示手工标签输入，优先保留任务需求、验收清单、工作区、执行模式与通知等直接影响执行的配置；空白新建提交空标签，从想法派发仅在数据层继承来源想法已有标签。标签仍可在既有 Task 编辑与管理表面维护，不删除持久化字段或历史筛选兼容。

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.8.46 | 2026-07-29 | **全局侧边栏可见性开关**：全局侧边栏改为默认关闭且关闭时不挂载；标题栏右上角、Windows 最小化按钮左侧新增 44 × 24px 持久化滑动开关。该开关只控制侧边栏是否存在，既有 rail/展开控制继续负责开启后的侧栏宽度模式。 |
| 2.8.47 | 2026-08-04 | **MyAgents Light 默认主题**：新增基于 Claude 完整 light/dark package 的 MyAgents Light，仅将 light Primary CTA 改为中性黑，并置于主题列表第一项成为未显式选择用户的新默认；MyAgents Default / Default Black 的用户可见名分别调整为 MyAgents Classic / MyAgents Classic2，稳定 ID 与显式选择兼容不变；Registry 产品顺序与 canonical fallback 注册顺序解耦，两组受控按钮差异由逐 Token 测试锁定 |
| 2.8.46 | 2026-07-29 | **Session 恢复单次揭示**：已有 Session 从 active cold Tab 首帧起即由同一 Chat shell 覆盖，REST history restore 前不投影 SSE cold replay，消除 raw Markdown 中间态；最终历史同帧提交，移除 MessageList 的 600ms 二次淡入与重复 spinner；恢复失败继续隔离旧内容和迟到 replay，revision/generation 修复成功后一次释放，target 变更会取消旧 REST/timer；恢复期间发送 fail closed，同 Tab UI intent、renderer 已确认 Node binding 与服务端全部 binding mutation 分层串行，并以有限 predecessor 候选做 CAS，保证快速切换/reset 的最终 identity |
| 2.8.45 | 2026-07-29 | **Markdown 代码横滑归属修复**：非换行代码正文显式声明 `overflow-x-auto`，让 user/query、assistant、文档等共享代码块及 Mermaid 源码视图恢复原生横向滚动，并在到达边缘时继续持有手势；普通正文的双指左右切 Tab 保持不变 |
| 2.8.44 | 2026-07-29 | **macOS 红绿灯留白校准**：顶部 Tab 与侧栏同色后，主窗口红绿灯左侧 inset 从 5px 调至 15px，使左缘留白接近顶部留白，并与右侧固定 toggle 槽形成更均衡的间隔；继续由原生布局 owner 保证 zoom、resize 与全屏切换稳定，Windows 不受影响 |
| 2.8.43 | 2026-07-29 | **Markdown 列表与代码面层级校准**：默认有序/无序列表整体缩进从 20px 调至 32px，让 marker 与正文左边界形成轻量区隔；compact 使用 24px，嵌套与 task list 保持文字列对齐。代码正文改与 Chat tool/process 组共用 `paper-inset / 30%` 浅表面，标题行接手原正文 `--code-bg`，Mermaid code view 同步，不新增颜色 Token |
| 2.8.42 | 2026-07-29 | **App Shell 材质边界减法**：顶部 Tab 标题栏改与全局侧栏共用 `--global-sidebar-bg`，并移除标题栏底部分割线；Chat 与右侧工作区的通顶左边框改为上下各留 16px 的内部短分隔线，不改变三栏宽度、面板内容或收展动效 |
| 2.8.41 | 2026-07-29 | **Chat 顶部信息减法**：AI 对话顶栏默认隐藏工作区历史入口，完整保留按钮、下拉与切换实现，并在“设置 → 关于 → 开发者”的开发者模式下方提供默认关闭的持久化开关；右侧工作区标题栏移除冗余“工作区”文字，搜索、终端、浏览器、Agent 设置与收展动作保持不变 |
| 2.8.40 | 2026-07-29 | **代码块双外观主题适配**：八套生产 Theme 的 Light 代码块从突兀深底改为各自 paper/inset 色系内的浅色代码面；Dark 保留各主题炭色材质，canonical Prism 从 light/dark 共用 `oneDark` 收口为按 Theme 语义色分别生成；Markdown 与 Mermaid 代码块统一细边框、Header 分隔、10px 圆角及 code-local hover，不增加阴影或 Theme ID 分支 |
| 2.8.39 | 2026-07-28 | **Markdown 排版聚落感校准**：Chat 与 Document 收口到同一默认节奏（16px/1.625、正文零额外字距、段落 12px、列表块 8px、列表项 6px、嵌套列表 4px），`strong` 与 H1 收至 600；改用后项拥有间距的单向流，补齐引用段落、GFM task list 和首尾块处理；`compact` 成为 14px/1.55 且标题、列表、表格、引用、代码块、分隔线同步收紧的完整变体 |
| 2.8.38 | 2026-07-28 | **全局历史搜索层级修正**：稳定搜索外壳 portal 到 App 根内容之后的 `document.body`，避免 macOS WKWebView 把后续 Tab 的原生纵横滚动条合成到遮罩和搜索面板上方；Suspense、动画与关闭层生命周期保持不变 |
| 2.8.37 | 2026-07-27 | **输入框菜单动效与层级收口**：`+`、会话模式、工具菜单统一为 200ms 淡入与自下向上归位，移除横向感和缩放；`@` 文件引用与 `/` 技能选择弹窗统一使用和输入框一致的 `shadow-md` |
| 2.8.36 | 2026-07-27 | **定时任务文案明确化**：中文输入框 `+` 菜单入口由“定时”改为“定时任务”，不改变 i18n key、英文翻译或功能行为 |
| 2.8.35 | 2026-07-27 | **输入框低频动作归位**：Launcher 与 Chat 的定时入口从常驻工具栏移入共享 `+` 菜单；菜单增加 200ms 淡入、上移归位与轻微缩放动效，并兼容 reduced motion 与 Floating UI 定位（缩放后由 2.8.37 移除） |
| 2.8.34 | 2026-07-27 | **对话权限模式图标统一**：builtin、Claude Code、Gemini 与 Codex 的已知模式从跨平台不稳定的 emoji 归一为 `Eye / ShieldQuestion / FilePenLine / ShieldCheck / LockOpen` 权限边界图标；文案、顺序、菜单样式与权限行为保持不变，未知模式保留 Runtime fallback |
| 2.8.33 | 2026-07-27 | **工作区 Tooltip 边界修正**：工作区新建动作统一精简为“新对话”；首条工作区的操作提示改为向下展开，避免被工作区滚动容器的上边界裁切 |
| 2.8.32 | 2026-07-27 | **工作区快捷动作边缘化**：工作区标题与活跃工作区行的双按钮统一为“更多在左、创建在右”，让高频的新增工作区 / 新对话固定占据最右边缘；同步锁定 DOM 与键盘焦点顺序 |
| 2.8.31 | 2026-07-27 | **工作区资源菜单排序**：活跃工作区菜单统一调整为“Agent 设置 → 打开所在文件夹 → 置顶/取消置顶 → 归档 → 移除”，配置与定位动作前置，危险操作保持收尾；展开侧栏与 rail flyout 继续复用同一菜单实现 |
| 2.8.30 | 2026-07-27 | **折叠侧栏视觉中线收口**：rail 从 72px 收至 64px，保持 16px 功能图标 `x=24px` 不动，使其中心与 rail 中线统一为 `x=32px`；20px App Icon 左移至 `x=22px` 并共享同中线，macOS 红绿灯 inset 同步左移 5px，Tab 留白与 compositor 位移按新边界重算 |
| 2.8.29 | 2026-07-27 | **macOS 原生窗口 zoom 持久定位修正**：红绿灯 inset 改由当前 `NSWindow` 的 AppKit 同步几何通知 owner 维护，覆盖 resize、zoom、全屏与 backing scale；移除不可靠的 Wry draw-only 持久化假设，也不再依赖滞后的 Tauri `WindowEvent` 追帧 |
| 2.8.28 | 2026-07-27 | **历史 Overlay 浏览筛选减负**：非搜索状态移除“活跃中 / 桌面 / 聊天机器人”三个分类及其本地过滤逻辑，只保留“全部 / 收藏”和工作区筛选；Session 来源仍由行内 tag 表达，搜索状态与请求行为不变 |
| 2.8.27 | 2026-07-27 | **工作区箭头安全边距**：箭头与分支轴整体右移 4px，避免箭头笔画贴住 hover 圆角面；同步把箭头到 icon 的间距收至 4px、分支 padding 收至 4px，并补偿名称 margin，使工作区 icon、名称和 Session 内容位置全部保持不变 |
| 2.8.26 | 2026-07-27 | **工作区树单轴对齐**：移除普通工作区按钮额外的 6px 左 inset，使 14px Lucide 箭头的可见左缘与“AGENT 工作区”标题左边界对齐；分支线从 16px 收至 6px 左缩进，让竖线中心穿过箭头中心，展开侧边栏与 rail flyout 同步生效 |
| 2.8.25 | 2026-07-27 | **侧栏资源字阶与缩进再平衡**：普通工作区箭头 16→14px，按钮左 inset 收 2px、Session 分支收 4px；纠正 Session 主标题与 tag/日期同为 12px 导致视觉权重倒挂的问题，Session 标题恢复 `text-sm` 14px，tag 与日期保持 `text-xs` 12px |
| 2.8.24 | 2026-07-27 | **工作区树展开动效**：展开侧栏与 rail 工作区 flyout 共用 200ms CSS Grid 高度过渡和轻量淡入位移；收起动画结束后卸载 Session 子树，快速反向操作会取消待卸载动作，并完整尊重 reduced-motion |
| 2.8.23 | 2026-07-27 | **Session 右键菜单统一**：全局侧栏 Session 行复用工作区行的不可选中与右键按下阻止默认行为；历史搜索浮层的浏览、全文命中和 Session ID 直接命中三种行复用侧栏同一个 Session 菜单组件，不再出现原生菜单或标题蓝色选区，也从结构上防止两处菜单漂移 |
| 2.8.22 | 2026-07-26 | **macOS 原生窗口缩放 chrome 稳定性**：红绿灯 inset 的连续帧所有权回归 Wry 原生 draw lifecycle，post-build 只负责首帧定位；移除滞后的 Tauri resize 事后纠偏，避免双击标题栏 zoom 时短暂向左上漂移 |
| 2.8.21 | 2026-07-26 | **rail 工作区浮窗与搜索冷启动连续性**：工作区 flyout 改为 viewport 固定的 128px 顶部、112px 底部安全区，起点高于入口并扩大资源浏览高度；历史搜索由 App Shell 唯一持有稳定外壳和一次入场动画，lazy 内容就绪只替换内部，消除首次打开的二次闪现 |
| 2.8.20 | 2026-07-26 | **工作区树单一焦点面**：顶部单一 active Tab 在侧栏只投影一个持久选中面；进入具体 Session 后只高亮 Session 行，父工作区取消叠加底色与 `aria-current`，仅保留层级字重 |
| 2.8.19 | 2026-07-26 | **About 许可信息与商业授权入口**：0.4.0 起在 About 中显式展示 AGPL-3.0-only、对应源码、第三方声明与商业授权邮件；社区信息使用 inset 动作，商业授权使用 Theme Primary CTA |
| 2.8.18 | 2026-07-26 | **左右区域联动动效**：全局侧栏收展时 Tab 标题栏与页面从旧视觉位置同步归位；Chat 右侧工作区以镜像横移动效进出，对话区同步重心变化，仍保持布局一次提交与 reduced-motion 即时路径 |
| 2.8.17 | 2026-07-26 | **侧栏产品身份直达官网**：App Icon 与紧凑产品字标组成无铺底的官网链接，hover 仅显示 pointer；rail 中收缩为同一位置的 App Icon，点击统一通过系统浏览器打开 myagents.io |
| 2.8.16 | 2026-07-26 | **全局侧栏收展动效**：布局槽仍一次提交以避免 Chat/Browser/Terminal 连续 resize；独立材质层用 200ms `clip-path` 实现收起右→左、展开左→右的背景边界，品牌/导航/工作区内容同步淡移并支持 reduced motion |
| 2.8.15 | 2026-07-26 | **产品字标跨层级统一**：将八套 Theme 的字体、字距与渐变抽为 `.theme-product-wordmark`，Launcher 与 About 继续叠加展示角色；全局侧栏品牌名复用同一字标并以 14px/500 保持小尺寸可读性 |
| 2.8.14 | 2026-07-26 | **侧栏 Session 状态与顶部 Tab 收口**：移除侧栏自定义的 active 圆点、Accent Loader 与后台已打开方块，仅保留共享的绿色脉冲运行态和暖棕未读态；行选中与 hover 继续由侧栏表面独立表达 |
| 2.8.13 | 2026-07-26 | **Session 菜单补齐对话 ID**：全局侧栏历史 Session 的更多/右键菜单首行增加“复制对话 ID”，复用可靠剪贴板 helper 与 Chat 既有 `SessionID: <id>` 引用格式，并提供成功/失败反馈 |
| 2.8.12 | 2026-07-26 | **工作区右键与新对话图标一致性**：工作区行在右键按下阶段阻止文本选区，只打开既有上下文菜单；Chat 顶栏“新对话”与全局侧栏统一使用 `MessageSquarePlus` 语义图标 |
| 2.8.11 | 2026-07-26 | **Chat 辅助区、历史搜索与任务创建减负**：右侧工作区头部移除文件/文件夹聚合计数，Agent 能力默认收起；历史搜索增加冷加载即时壳、入口预取、虚拟历史列表与单一刷新 owner；任务创建面板移除手工标签输入，保留来源想法标签的静默继承与历史数据兼容 |
| 2.8.10 | 2026-07-26 | **资源加载、能力页与设置动线收口**：Session 加载改为静默等高占位，rail flyout 复用侧栏材质并在折叠树枝失焦时保持；技能与工具页改为标题随外层滚动、子 Tab 到顶吸附；网络代理独立成设置子页；模型菜单首帧定位当前项并为 AgentSDK 增加模型供应商直达入口 |
| 2.8.9 | 2026-07-26 | **全局侧栏纵向密度与资源字重校准**：主导航、底部入口及工作区行从 40px 收至 36px；工作区名称默认 400，仅在 hover/focus/active/menu-open 时升至 500；“技能与连接器”统一更名为“技能与工具” |
| 2.8.8 | 2026-07-26 | **App Shell 动线、Tooltip 与即时 Session 反馈**：侧栏图标动作统一使用即时黑底共享 `Tip`，移除原生 `title` 与 500ms 延迟；左右栏 toggle 分别统一为简洁 `PanelLeft / PanelRight`，右侧工作区控制固定最右；flyout 过滤树枝收缩诱发的伪离开事件；Chat 移除返回启动页并明确工作区历史标题；侧栏 Session 新 Tab 先激活 loading UI、后等待 Sidecar ready |
| 2.8.7 | 2026-07-26 | **侧栏与 Tab Chrome 边界校准**：标题栏在侧栏后增加 8px 基础 leading inset，手动 rail 的 52px 槽位继续包含 toggle 后留白；侧栏移除右侧竖分割线及 Agent 工作区上下横分割线，左右区域依靠材质色差、侧栏纵向模块依靠 8–12px 留白分区 |
| 2.8.6 | 2026-07-26 | **顶部 Tab Chrome 材质收敛**：标题栏由 Paper 混合渐变改为纯 `paper`；Tab active/hover 与新增/溢出按钮统一复用 `hover-bg`，active 移除阴影并保留 accent 底线；32px Tab 改用 `rounded-md`，使相对曲率接近 40px 工作区行 |
| 2.8.5 | 2026-07-26 | **全局侧栏资源密度校准**：Session 标题从 `text-sm` 降为 `text-xs` 并保留 `h-9` 命中高度；顶层工作区与底部“小助理/设置”均移除额外 4px 行间距，使资源树和上下导航采用一致的连续节奏 |
| 2.8.4 | 2026-07-26 | **全局侧栏材质分层校准**：新增 Theme-owned `--global-sidebar-bg`，八套 Theme 的 light/dark 均在自身 `paper → paper-inset` 色阶间微量下探；仅全局侧栏根面消费，右侧页面、`paper-elevated` 卡片/弹层、顶部 Tab 栏与交互态不变 |
| 2.8.3 | 2026-07-25 | **全局侧边栏功能图标锚点校正**：主导航、工作区与底部入口的 40px rail 命中区统一固定于 x=12px，使 16px 图标左缘在展开/rail 中始终位于 x=24px；禁止 rail 按剩余宽度重新居中造成折叠时 4px 横跳 |
| 2.8.2 | 2026-07-25 | **全局侧边栏品牌锚点与信息密度校正**：App Icon 统一为 20px macOS 风格圆角矩形并绝对锁在窗口 x=24px，展开/rail 共用同一尺寸、坐标和 DOM，仅显隐文字；主导航改为无分割线、无行间距连续组；工作区关联态降为 hover 同级；Session 日期贴右，更多菜单悬浮替换日期而不占位 |
| 2.8.1 | 2026-07-25 | **全局侧边栏真机 chrome 校正**：展开态 288→256px、rail 80→72px；macOS 红绿灯 inset 随 rail 收紧并保持原生命中区；产品身份移到独立第二行；展开/收起共用窗口坐标固定的单一 toggle，手动 rail 时视觉归属自然转入 Tab 标题栏 |
| 2.8.0 | 2026-07-25 | **全局 App Shell 与 Active Tabs（PRD 0.3.5）**：将产品能力、Agent 工作区和 Session 树从 Launcher 右栏提升为 App 级全局侧边栏；定义 288px 展开态、80px rail、320px 工作区 flyout、窄窗自动 rail 与独立手动偏好；Launcher 收敛为单列新工作入口；技能、插件、工具迁入单实例功能 Tab，页面所有权继续由顶部 Tab 统一承载 |
| 2.7.9 | 2026-07-23 | **产品默认 Theme 与显式选择解耦**：Default Black 成为未选择用户当前跟随的产品默认，`myagents-default` 继续仅承担 canonical fallback；新增显式选择状态，未来调整产品默认不覆盖用户选择；Absolutely 用户可见名改为 Claude；Theme 菜单选中标记移到名称之后、light/dark 色块之前 |
| 2.7.8 | 2026-07-22 | **Theme 入口公开与配色速览**：Theme 选择器从隐藏开发者区迁到“通用设置 → 界面外观”末尾；下拉触发器与选项以两枚 16px 色块展示 package 的 light/dark Primary，颜色由 Registry 从 Theme CSS 派生，不在组件维护第二份 palette |
| 2.7.7 | 2026-07-22 | **Space 接入全局 Theme**：删除 `space-mono` 局部 palette 与 Popover portal scope 传播；Space 的 paper、文字、字体、圆角、阴影、动作色和状态色直接继承当前 Theme，同时保留布局、业务状态机、Logo、用户内容和纯 alpha 遮罩边界 |
| 2.7.6 | 2026-07-22 | **Theme 候选收敛与菜单扁平化**：移除 Ink、Fjord、Ochre、Mauve、Wisteria，production catalog 收敛为 8 套；开发者 Theme 下拉取消分组标题并直接按 Registry 产品顺序展示；所有保留 Theme 的夜间 Switch 使用白色 thumb |
| 2.7.5 | 2026-07-22 | **夜间实底控件反差校准**：所有深色 Primary 在 dark scheme 使用同色相校深 surface 与白色前景，正常/hover 均不低于 4.5:1；Ink 浅色 Primary 保留深色前景；canonical、Sage、Claude、Linear、Proof、Codex、Raycast 深色 Switch 使用白色 thumb，其余预设保留深色 thumb |
| 2.7.4 | 2026-07-22 | **Primary CTA 语义收口**：Launcher 对话发送、想法记录与 Task Editor 提交统一消费 `--button-primary-*`；Accent 保留给 Toggle、选中、Focus、链接与进行状态，使 Default Black 只改写主动作而不污染其他强调表面 |
| 2.7.3 | 2026-07-22 | **Default Black Baseline A/B**：新增基于 canonical Default 的受控对比 Theme；仅将 light 主按钮从陶土棕改为中性黑，dark、其余 host Token、Launcher Hero 与 embedded adapters 保持 Default 同源；分组与完整 Token 差异由测试锁定 |
| 2.7.2 | 2026-07-22 | **Theme 实色控件、代码前景与品牌呈现校正**：顶部 Tab active 底线恢复 2px；浅色预设的 Accent / Primary 实底控件统一改用白色前景与同色相深色 action surface；可选 Theme 的 Prism 普通文本消费 `--code-text`，其余语法色在 adapter 边界校准到深色 `--code-bg`；Settings About 品牌名复用 Launcher 的 Theme-owned Hero title 样式 |
| 2.7.1 | 2026-07-21 | **Theme 运行时与选中态校正**：main native Window background 在 Theme 生效后跟随 resolved `--paper`；预设 Theme 的 light Toggle thumb 统一回归浅色控制面；顶部 Tab / Settings 侧栏选中指示按 1px/2px 与 70%/80% 建立层级 |
| 2.7.0 | 2026-07-21 | **Theme preset catalog（PRD 0.3.2）**：production registry 扩展为 12 套完整 Theme；开发者设置用 Registry 驱动的单一下拉菜单切换；每套同时提供 light/dark、Hero、宿主/Floating Token 与 xterm/Monaco/Mermaid/Prism/Widget adapter；Theme/Appearance 正交，canonical default 与 Space 独立视觉不变 |
| 2.6.2 | 2026-07-20 | **恢复 canonical Theme 暖橙 action palette**：根据实机体验撤回 2.6.1 的黑白配色试验，Accent/Hover/Primary/Focus、Widget 与 xterm adapter 恢复原有暖橙参数；保留 Theme runtime 编译桥、语义 foreground、阴影与终端自适应等全部架构修复，Space `space-mono` 继续独立使用黑白 action palette |
| 2.6.1 | 2026-07-20 | **Theme runtime 编译桥与 action palette 修正**：Tailwind 入口用无值 `@theme inline` 桥接 Theme-owned font/radius/shadow/duration，production build 增加生成 CSS 契约校验；canonical default Accent/Hover/Primary/Focus 改用 Space 现行黑白 action palette，强调底前景改用 `--on-accent`；xterm 字体指标变化后原位 fit 并同步 PTY，split 几何判稳由 ResizeObserver 负责而不复制 Theme transition 时长 |
| 2.6.0 | 2026-07-20 | **Theme System 架构收口（PRD 0.3.2）**：区分 Theme / AppearanceMode / ResolvedColorScheme；现有 light/dark 视觉完整迁入 canonical `myagents-default`；Launcher Hero、CSS Token、xterm、Monaco、Mermaid、Prism、Widget 与 Floating Ball 统一消费 `ResolvedTheme`；Space `space-mono` 明确保持独立；本次无有意视觉优化 |
| 2.5.9 | 2026-07-08 | **移动端断点收窄**：`--breakpoint-mobile` 从 768px 调整为 640px；桌面中等宽度和 split preview 默认 50% 场景更倾向保留工作区 inline，真正窄屏才切 overlay / stacked 布局 |
| 2.5.8 | 2026-06-20 | **Launcher 历史筛选与收藏规范**：历史标题行筛选器明确为「全部 / 我的收藏 / 工作区」三类历史筛选，不再仅是工作区筛选；历史行更多菜单纳入「收藏对话 / 取消收藏」，收藏状态持久化到 session metadata |
| 2.5.7 | 2026-06-20 | **Launcher right rail final menu polish**：工作区卡片 hover 操作改为无 tooltip 的「更多」icon，点击打开与右键一致的菜单；工作区菜单新增「打开所在文件夹」；历史行右键在 mouseDown 阶段即时打开同一份更多菜单并禁用文本选中；历史时间列去掉时钟 icon 并扩到 w-16；right rail 底部增加同色渐隐遮罩 |
| 2.5.6 | 2026-06-20 | **Launcher right rail menu / tooltip / collapsed count 修正**：历史行更多菜单改为列表级互斥状态，避免连续点击多个 row 后重复菜单叠加；工作区卡片 hover 层级提升，保证 Agent 设置 tooltip 不被相邻内容压住；默认折叠展示改为 6 个工作区（3 行 x 2 列），超过 6 个才显示展开按钮；历史 sticky header 不再用横向负 margin 铺到滚动条区域 |
| 2.5.5 | 2026-06-20 | **Launcher right rail section 与历史行 overlay 修正**：right rail section 标题升为 text-base 16px；顶部添加按钮高度降为 py-1；历史筛选器 h-6 / py-0 与标题居中；历史行「更多」改为右侧 absolute overlay，不再占用标题宽度，标题尾部使用渐隐 mask |
| 2.5.4 | 2026-06-20 | **Launcher workspace card 标题分配修正**：Agent 设置入口从 flex 布局改为右侧 absolute overlay，不再挤占标题宽度；工作区名优先展示，频道 tag 只吃剩余空间；tag 溢出改为右侧渐隐 mask 截断 |
| 2.5.3 | 2026-06-20 | **Launcher right rail 交互修正**：历史列表改为纯列表，不再显示日期分组行；历史行工作区列收窄到 w-16；工作区收起立即切回折叠态并回到 right rail 顶部；菜单项点击必须截断 portal synthetic bubble，避免触发行打开 |
| 2.5.2 | 2026-06-20 | **Launcher right rail 视觉修正**：历史标题行 sticky 贴到 right rail 最上沿；工作区 / 历史分割线收紧间距；历史分组标题去除右侧横线；历史列表工作区列移除图标、筛选菜单保留图标；工作区展开按钮降为 text-xs |
| 2.5.1 | 2026-06-19 | **Launcher right rail 重构规范**：§15 改为「Agent 工作区 + 历史对话」连续滚动结构；移除 Launcher 内「我的任务 / 新建任务」入口；历史标题行吸顶，提供弱化工作区筛选器与搜索 icon；工作区默认 4 张卡、展开后占满右栏上方并压低历史，支持置顶排序和右键置顶菜单；历史列表按今天 / 昨天 / 近 7 天 / 更早分组并使用分页追加 |
| 2.5.0 | 2026-06-12 | **Typography Part 3——终局七档（PRD 0.2.34 Part 3，用户决策"合并成一次落掉"）**：双合并收敛为 12/14/16/18/20/22/28 等距梯子——11px(micro)+12px(caption)→**12px meta 档**（`text-xs`，回归 Tailwind 官方值）；13px(ui)+14px(dense)→**14px ui 档**（`text-sm`，回归官方值；产品密度气质从 IDE 系移向阅读舒适系，~880 处 UI 文字 +1px）；`--text-2sm`/`--text-md` token 与类名删除，eslint 封禁死类名（token 不存在时类名静默无样式=最坏失败模式），text-md 白名单机制随之退役（Markdown 表格直接 text-sm）；同名异值陷阱仅剩 text-2xl=22（官方 24）；§6.8 Section 标题随 ui 档至 14px；§6.1/§6.11/§10/§15 全部 px 标注同步；widget 沙箱 utility 与宿主同步（.text-xs 12/.text-sm 14/button 14/.stat-label 12），契约下限改 no-font-below-12px；CodeBlock 语法高亮内联字号 token 化（`var(--text-sm)`，改 token 自动跟随）；按钮文字下限升至 14px；**悬浮球 fb.css 随后对齐**（06-13 用户指令，最后一块字阶飞地——17 处 font-size 全 token 化，AI 消息挂 `.ai-message-content` 与主聊天同源，详见 PRD 0.2.35 §12.5）——全产品字阶自此完整收口 |
| 2.4.0 | 2026-06-12 | **Typography Part 2——全产品面档位归位（PRD 0.2.34 §7-11）**：§6.8 Section 标题 11px→**13px**（用户裁决"标题取大"，Launcher 事实标准升格为规范；弹出层分组头与列表分桶分隔头维持 11px，边界写入 §6.8）；`text-md` 27 处误用清零（卡片标题/面板小标题→text-sm、弹窗标题→text-lg，此后 text-md 仅限 Markdown 表格，eslint 白名单强制）；全部菜单系统统一 13px（MenuItem/DropdownMenu/ContextMenu 等 12→13，结束右键菜单与斜杠菜单双密度）；弹窗主标题统一 text-lg 18px（ConfirmDialog 14→18、WorkspaceConfigPanel 等 16→18、Settings 工具箱 20→18）；按钮文字下限 13px 落实（ConfirmDialog 等 12→13）；描述行两态规则（宿主标题 13px→描述 11px；宿主 ≥16px→描述 12px）；5 个 markdown 预览面板弃 `prose` 类改用 `.ai-message-content` + 自家 `<Markdown>` 组件（typography plugin 整个移除）；**修复 `.ai-message-content` 死 CSS**——该类定义了 16px/1.7 却从未接线到聊天，§10 宣称的 1.7 行高此前从未上屏，现已接线三个 assistant 分支并把 Markdown 段落行高 1.625→1.7 对齐 prose 档 |
| 2.3.0 | 2026-06-12 | **Typography Unification（PRD 0.2.34）**：字号 token 迁入 `@theme`（单一真相源，配对行高）；新增 caption 档 `--text-2sm`(12px) 与 dense 档 `--text-md`(14px)，每档唯一职责；废除 10px 档（`--text-2xs` 删除，155 处并入 11px）；全仓 ~700 处 `text-[Npx]` 字面量归一为 token utility（eslint 封禁新增 px 字面量，唯一豁免=品牌 slogan；rem/em 与悬浮球 fb.css 边界见 §2.2）；Markdown 表格 td 13→14px / th 11→12px（消同消息内字号跳变）；introduction-content 正文 14→16px 与聊天正文同基准（退层由色板承载）；用户气泡行高统一 1.7；Widget 沙箱注入 h1-h6 重置（20/18/16/14, 600）+ body 行高 1.6→1.7 + utility 对齐宿主（xl 22→20、2xl 28→22）——**存量 widget 重渲染后裸标题会从浏览器默认（h1=32px/700）收紧到契约尺寸，观感变化是预期行为**；菜单分组头统一 11px semibold uppercase tracking-wider /60；§2.2 字阶表重写为档位制并修正历史标注错误（旧表 `--text-base` 14px / `--text-md` 16px 均与代码不符）；删除死代码 `.tree-item*` |
| 2.2.0 | 2026-03-04 | **Design Polish v2.2**：新增 `--hover-bg` Token（`rgba(194,109,58,0.07)` 暖棕 7%）统一列表行 hover；Hover 背景分层（列表行用 `--hover-bg`，小按钮用 `--paper-inset`）；27 处列表行 hover 迁移至 `--hover-bg`（Chat/Launcher/Settings/TaskCenter/SlashMenu/ProcessRow 等 10 个文件）；Settings 浮层面板背景统一 `--paper-elevated`（SkillDialogs×2/WorkspaceConfigPanel/UnifiedLogsPanel/CronTaskDebugPanel）；Settings 侧边栏字号 text-[15px]→text-base、active 底色 paper-inset→hover-bg；MCP 工具浮层字号对齐供应商面板（labels/inputs text-xs→text-sm，hints text-[10px]→text-xs）；紧凑卡片增加 hover:translate-y-[-1px] 微上浮（Skill/Command/Agent/ImBot）；SessionTagBadge 底色 paper-inset→paper-elevated；UsageStatsPanel 深背景降档；BugReportOverlay 配色修正；ImBot 停止按钮改 outline 样式；Skills/Agents 详情页互斥显示 |
| 2.1.0 | 2026-03-04 | **Design Polish v2.1**：`--paper` 调浅（#f2ebe0 → #faf6ee）减少启动页/设置页压迫感；新增 heartbeat Token 系列替换 Tailwind red-500；工具栏弹窗背景统一 `--paper-elevated`；Plus 菜单/Slash 命令宽度归一化；工作区面板字号整体提升一档（10→11→13 阶梯）；Overlay 遮罩统一毛玻璃 `bg-black/30 backdrop-blur-sm`；Chat header 去除硬边框改渐变淡出；Launcher 横分割线改不封闭；Section 标题区分静态/Tab 式两种色阶 |
| 2.0.0 | 2026-03-04 | **Design Polish v2.0**：Paper 色阶拉开（paper/elevated/inset 对比度增强）；Ink 层级拉开（ink-secondary 加深、ink-subtle 微亮）；主按钮从深棕改为暖棕 Accent #c26d3a；语义色暖化（success→#2d8a5e, info→#4a7ab5）；新增 accent-warm-subtle/muted/error-hover token；Tailwind v4 @theme 接管 shadow 体系；清理全部旧别名（paper-contrast/strong/reading, ink-strong, accent-strong/bg, shadow-soft/strong）；删除未使用 CSS 类（btn-*/card*/badge*/soft-panel）；SessionTagBadge 降饱和统一暖色调；Settings 侧边栏增加 accent 左竖条指示器；WorkspaceCard 标准卡片化 + hover 微上浮；硬编码颜色全部 token 化 |
| 1.6.0 | 2026-02-23 | 新增 Overlay 遮罩层规范：统一 `bg-black/30 backdrop-blur-sm` 毛玻璃效果，点击遮罩关闭 |
| 1.5.0 | 2026-02-11 | Toggle 规范对齐实际实现（ON=accent, OFF=line-strong）；Settings 双栏布局；卡片分主/紧凑两级；按钮补充危险/强调/文字链；变量别名重新定位 |
| 1.4.0 | 2026-01-30 | 新增 Launcher 页面规范、Section 标题规范、透明度层级规范；统一文件夹图标为暖色调 |
| 1.3.0 | 2026-01-22 | 按钮尺寸规范：工具栏按钮 13px + h-3.5 图标，主按钮 14px |
| 1.2.0 | 2026-01-22 | 字号体系重构：以 16px 为正文基准，H1-H6 标题 22/20/18/16px |
| 1.1.0 | 2026-01-22 | 新增 AI 内容规范、跨平台规范、字体 fallback |
| 1.0.0 | 2026-01-22 | 初始版本，基于设计审计创建 |
