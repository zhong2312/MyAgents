# MyAgents Design Guide

> **Version**: 2.7.7
> **Last Updated**: 2026-07-22
> **Status**: Active
> **Platform**: macOS / Windows Desktop Client

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

Production catalog 当前包含八套完整 Theme：MyAgents Default、Default Black、Sage、Claude、
Linear、Proof、Codex、Raycast。`myagents-default` 仍是 canonical
fallback；它的物理 owner 是：

- `src/renderer/theme/themes/myagents-default.css`：通用首帧 fallback + 精确 Theme root / light / dark root 下的字体角色、颜色、材质、圆角、阴影、动画和 Floating Ball 运行时 Token；同一文件既静态保护 canonical 首帧，也由 manifest 提供实际 source 给注册校验与 runtime 激活；
- `src/renderer/theme/themes/myagents-default.ts`：Launcher Hero 与 xterm / Monaco / Mermaid / Prism / Widget adapters；
- `src/renderer/theme/themes/<preset>.css + <preset>.ts`：六套 palette Theme 的共置 package；CSS
  显式拥有完整 visual Token，manifest 只用 `?inline` 读取同一份源码，adapter 从这份 CSS 的语义
  色板派生，不复制 canonical 值；构造与 Registry 校验共享语义解析器，不依赖 production minifier
  是否保留属性引号、空白或末尾分号；
- `default-black` 是当前产品默认，也是受控的 Baseline A/B：完整复制 canonical host Token，只将 light
  `button-primary-bg/hover` 改为中性黑；dark、Hero 与五类 embedded adapter 与 Default 保持同源，
  并由测试锁定除此配对外不得漂移；
- `src/renderer/index.css`：与品牌视觉无关的布局、交互、七档 Type Scale，以及不携带视觉值的 Tailwind runtime Token 编译桥。

组件只消费语义 Token 或 `useResolvedTheme()` adapter，不持有 light/dark palette，不观察 `.dark` 反推状态。Widget adapter 必须提供 iframe 可直接使用的 literal，不能引用宿主 `var(...)`。完整 Theme 不允许让用户混搭颜色、字体、背景等零件；某 Theme 缺项时整套回退 canonical default。

可主题化：宿主与 Space 的色彩/字体/材质、Launcher Hero 两行内容和可选 bundled 背景、语法/图表/终端/编辑器/Widget iframe、Floating Ball。非主题化：布局与信息架构、业务状态机、原生窗口按钮、Browser 子 Webview 网页、用户内容、三方品牌 Logo/二维码、宠物 spritesheet。Space 不维护第二套 palette；其 paper、文字、圆角、阴影、动作色与业务状态色直接继承当前全局 Theme。

八套 Theme 的产品顺序和动作语义：

| Theme | 主要视觉角色 |
|---|---|
| MyAgents Default / Default Black | 暖纸张、陶土橙；Default Black 是当前产品默认，仅将 light 主按钮改为中性黑，本章色值表仍只描述 canonical Theme |
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
| prose | `--text-base` / `text-base` | 16px | 1.7 | **正文主体**——AI 回答、用户气泡、widget body、输入框* |
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
- AI 回复的 Markdown 正文使用 16px / 1.7，确保阅读舒适
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

**Tailwind 类名**：
```jsx
<div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 backdrop-blur-sm">
  <div className="rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-2xl">
    弹层内容
  </div>
</div>
```

**适用范围**：
- 模态框（ConfirmDialog、SessionStatsModal 等）
- 全屏面板（WorkspaceConfigPanel、Settings 弹层等）
- 选择器弹层（SkillDialogs、PathInputDialog 等）
- 日志面板（UnifiedLogsPanel）
- 任务中心 Overlay（TaskCenterOverlay）

**例外**：
- 图片预览（ImagePreview）使用 `bg-black/80 backdrop-blur-sm`，深色背景便于查看图片内容

**点击遮罩关闭**：
- 支持点击遮罩层区域触发关闭（等同于取消操作）
- 实现方式：`onMouseDown` + `e.target === e.currentTarget` 防止冒泡误触

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
- 任务中心: TaskCenterOverlay 任务行
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
| 最小宽度 | 320px |
| 设置页侧边栏 | 208px (w-52) |

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
行高: 1.7 (阅读优化，@theme 配对行高)
段落间距: var(--space-4)
最大宽度: 768px (居中)
```

#### 用户消息 (User Message)
```
背景: var(--paper-inset)
文字: var(--ink)
圆角: var(--radius-lg)
内边距: var(--space-4)
字号: var(--text-base)，行高 1.7（与 AI 消息一致，不另设 leading）
对齐: 右侧（或左侧皆可，但需与 AI 区分）
```

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
背景: #1e1e1e (深色) 或 var(--paper-inset) (浅色)
文字: 根据语法高亮
字体: var(--font-mono)
字号: 14px (text-sm)
行高: 1.5
圆角: var(--radius-md)
内边距: var(--space-4)

头部 (可选):
  - 语言标签: 左上角
  - 复制按钮: 右上角
```

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
/* AI 回复正文 */
.ai-message-content {
  font-size: var(--text-base);  /* 16px */
  line-height: 1.7;              /* 27.2px - 适合长文本阅读 */
  letter-spacing: 0.01em;        /* 略微增加字间距 */
}

/* 段落间距 */
.ai-message-content p + p {
  margin-top: var(--space-2);    /* 8px */
}

/* 列表项间距 */
.ai-message-content li + li {
  margin-top: var(--space-1.5);  /* 6px */
}
```

#### 内容宽度
- 最大宽度限制 768px，避免单行过长影响阅读
- 居中显示，两侧留白形成阅读聚焦

#### 标题层级
在 AI 生成的 Markdown 内容中：
| Markdown | 样式 |
|----------|------|
| `# H1` | 22px, bold, margin-top: 24px, margin-bottom: 16px |
| `## H2` | 20px, semibold, margin-top: 20px, margin-bottom: 12px |
| `### H3` | 18px, semibold, margin-top: 16px, margin-bottom: 8px |
| `#### H4` | 16px, semibold, margin-top: 12px, margin-bottom: 8px |
| `##### H5` | 16px, medium, margin-top: 12px, margin-bottom: 8px |
| `###### H6` | 16px, medium, margin-top: 12px, margin-bottom: 8px |

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
| 消息内段落 | var(--space-4) / 16px |
| 工具块与文本 | var(--space-3) / 12px |
| 代码块与文本 | var(--space-3) / 12px |
| 列表项之间 | var(--space-2) / 8px |

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
| 窗口控制 | 左上角红绿灯 | 右上角三按钮 | Tauri 自动处理 |
| 滚动条 | 自动隐藏 | WebView2 经典滚动条 | 全局活动态控制：稳定 6px 几何，thumb 仅滚动中显色 |
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

```css
/* 跨平台细滚动条 */
* {
  scrollbar-width: thin;  /* Firefox */
  scrollbar-color: var(--ink-subtle) transparent;
}

/* Webkit (Chrome/Safari/Edge) */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-thumb {
  background: var(--ink-subtle);
  border-radius: 3px;
}
::-webkit-scrollbar-track {
  background: transparent;
}

/* Windows: renderer 全局 scroll capture 给正在滚动的元素加
   .myagents-scrollbar-active。默认 thumb 透明，滚动停止后恢复透明，
   保留 6px 几何以避免内容列重排。 */
html.platform-windows.platform-windows,
html.platform-windows.platform-windows * {
  scrollbar-color: transparent transparent;
}

html.platform-windows.platform-windows.myagents-scrollbar-active,
html.platform-windows.platform-windows .myagents-scrollbar-active {
  scrollbar-color: var(--ink-subtle) transparent;
}
```

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

## 15. Launcher 页面规范

Launcher 是应用的启动页，采用左右分栏布局。左侧负责品牌、对话 / 想法输入和当前工作区上下文；右侧是一个连续滚动的 right rail，上方保留 Agent 工作区，下方以历史对话为核心。Launcher 不承载任务中心摘要和新建任务入口；任务统一从顶部导航栏「任务」进入。

### 15.1 布局结构

```
┌────────────────────────────────────────────────────────┐
│                    Tauri Title Bar                      │
├──────────────────────────┬─────────────────────────────┤
│                          │  Agent 工作区       [+ 添加] │
│        MyAgents          │  [卡片] [卡片]               │
│  对话 / 想法 + 输入框     │  [卡片] [卡片]               │
│                          │  展开更多 N 个 / 收起         │
│                          │  ────────────────────────── │
│        (60%)             │  历史对话  [全部⌄]      [🔍] │
│                          │  [历史行...]       (40%)     │
└──────────────────────────┴─────────────────────────────┘
```

**分栏比例**：左侧 60%（品牌区） / 右侧 40%（right rail，最小宽度 320px）。

**滚动模型**：右栏只有一个 scroll root。Agent 工作区展开后占用右栏上方空间，历史对话自然下移；历史列表本身不做内嵌滚动。向下滚动时「历史对话」标题行吸顶。

### 15.2 品牌区域

品牌区 JSX 只消费 `ResolvedTheme.hero`。产品名、zh-CN/en-US slogan、文字视觉参数和每个 scheme 的可选 bundled 背景槽都由 Theme 拥有；`BrandSection` 不硬编码 `MyAgents` 或 slogan source。canonical Theme 当前没有独立背景图，因此与迁移前视觉一致。

Settings About 的品牌名复用同一个 `.theme-launcher-hero-title` selector，使字体、字重、
字距、响应式字号与渐变都随完整 Theme 同步；About 不复制或覆盖品牌配色。

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

### 15.3 Right Rail 区域

**区域内边距**：水平 24px。右栏 scroll root 本身不设置垂直 padding；顶部工作区内容用 `pt-6` 保持首屏呼吸感，保证历史标题行 `sticky top-0` 时可以贴到右栏最上沿。

**Section 间距**：
| Section | 规则 |
|---------|------|
| Agent 工作区 | 顶部 section，默认展示 6 个可见工作区（3 行 x 2 列） |
| 分割线 | `border-t border-[var(--line-subtle)]`，位于工作区和历史之间，保持在右栏内容内距内，不贴左右边缘；上下间距收敛为紧凑弱分割，不形成格子切割感 |
| 历史对话 | 标题行 `sticky top-0`，吸顶时保持 `var(--paper)` 近似背景；标题行自身不加横穿整栏的底边，sticky 背景不得横向铺到 right rail scrollbar 区域 |

**入口边界**：
- Launcher 右栏不展示「我的任务」摘要。
- Launcher 右栏不展示「新建任务」按钮。
- 历史标题行不展示「全部 →」跳转，只保留搜索 icon 和历史筛选器（全部 / 我的收藏 / 工作区）。

### 15.4 Agent 工作区

```
Header:
  - 标题: text-base, font-semibold, tracking-[0.04em], var(--ink-muted)
  - 右侧: Logs（仅 dev tools）+ AddWorkspaceMenu（仅非空工作区列表）；顶部按钮使用 py-1，避免高于 section 标题过多

默认态:
  - Grid: 2 columns, gap-3
  - 展示数量: 6 个（3 行 x 2 列）
  - 超过 6 个才显示「展开更多 N 个」按钮
  - 排序: pinnedAt desc 的置顶组在前，其次 lastOpened desc，最后名称稳定排序

展开态:
  - 展示所有可见工作区
  - 历史对话 section 被自然压到下方
  - 底部显示「收起」按钮
  - 「展开更多 N 个 / 收起」按钮使用 text-xs，弱于 section 标题和卡片主信息
  - 点击「收起」后立即切回折叠态，只渲染默认 6 个工作区，并把 right rail scroll root 回到 top=0
  - 展开 / 收起使用 max-height transition，尊重 motion-reduce；不得出现按钮文案先变、卡片延迟卸载的中间态
```

### 15.5 工作区卡片

```
背景: var(--paper-elevated)
圆角: var(--radius-xl) / 12px
内边距: px-4 py-3

Hover 状态:
  - shadow-sm
  - hover 卡片提升到相邻内容之上，保证右侧操作入口不被后续卡片 / 展开按钮 / 分割线压住
  - 右侧以 absolute overlay 显示「更多」icon button，不占用卡片正文布局宽度
  - 「更多」只显示 icon，不显示 hover tooltip；点击后打开与右键一致的工作区菜单
  - overlay 使用从透明到 `var(--paper-elevated)` 的弱渐显遮罩，避免按钮浮在文字上
  - 卡片自身负责 rounded 裁剪（`overflow-hidden`），absolute overlay 不得把右上/右下圆角画成方角

文件夹图标:
  - 容器: 28px
  - 图标: WorkspaceIcon

项目名称: 14px (text-sm), font-medium, var(--ink)
项目路径: 12px (text-xs), var(--ink-muted)

频道标签:
  - 与项目名称同一行
  - text-xs
  - 不换行；工作区名称优先展示，频道标签吃剩余空间
  - 空间不足时频道标签在右侧用 mask 渐隐裁切，不新增第三行

右键菜单:
  - 置顶 / 取消置顶
  - Agent 设置
  - 打开所在文件夹
  - 移除
```

### 15.6 历史对话列表

```
Header:
  - 标题: 历史对话，text-base, font-semibold, tracking-[0.04em], var(--ink-muted)
  - 标题右侧: 弱化历史筛选器，默认文案「全部」；菜单包含「全部」「我的收藏」和各工作区，筛选按钮 h-6 / py-0，与标题上下居中
  - 右侧: 搜索 icon button，打开现有 TaskCenterOverlay search mode
  - 吸顶: sticky top-0，随 right rail scroll root 生效

列表结构:
  - 纯列表，不显示「今天 / 昨天 / 近 7 天 / 更早」等分组行
  - 保持 lastActiveAt 倒序，不额外插入日期分割 DOM

列表项:
  - 内边距: py-2 px-3
  - 圆角: var(--radius-lg)
  - Hover 背景: var(--hover-bg)
  - 单行展示，标题与工作区信息均 truncate
  - `select-none`，避免右键时浏览器先选中行内文字
  - 若该 session 有未读系统通知，在标签与标题之间显示弱未读标记：1 条为 6px 暖色点，多条为小号暖色数字胶囊；不改变排序

时间:
  - 字号: 12px (text-xs)
  - 颜色: var(--ink-muted) / 50%
  - 固定宽度: 64px (w-16)
  - 不显示时钟 icon，为时间 / 日期文本留出空间

任务标题:
  - 字号: 14px (text-sm)
  - 颜色: var(--ink-secondary)
  - Hover: var(--ink)

工作区名称:
  - 字号: 12px (text-xs)
  - 颜色: var(--ink-muted) / 55%
  - 固定宽度: 64px (w-16, truncate)
  - 列表行内不显示工作区图标；历史筛选菜单的工作区项保留图标辅助识别

Hover 操作:
  - 仅显示「更多」三个点 icon
  - 「更多」使用右侧 absolute overlay，不占用标题布局宽度
  - overlay 使用从透明到 row hover surface 的弱渐显遮罩；标题尾部使用 mask 渐隐，避免 hover 操作覆盖文字时生硬截断
  - 历史行更多菜单由列表级状态控制，同一时间最多只能打开一个菜单
  - 右键行任意位置打开同一份更多菜单，菜单锚点跟随右键点击位置；右键在 mouseDown 阶段拦截，避免文字选中后延迟弹出
  - 二级菜单包含「收藏对话 / 取消收藏」「查看统计」「删除」
  - 运行中 Cron 绑定的 session 删除禁用，提示先停止定时任务

性能:
  - 初始渲染一页历史
  - 滚动到 sentinel 附近自动追加下一页
  - 不在 scroll handler 中做重计算，使用 IntersectionObserver
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
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
