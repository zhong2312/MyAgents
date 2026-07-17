# MyAgents 暖纸工作台视觉契约

本原型采用安静、工作导向的暖纸编辑台系统：层级依靠纸面明度、细线和密度建立，暖橙只标记当前操作，冷绿只表达结构与有效状态。

## 色彩令牌

```css
:root {
  --bg: oklch(97.5% 0.014 82);
  --surface: oklch(99.2% 0.008 80);
  --fg: oklch(19.5% 0.022 56);
  --muted: oklch(47% 0.027 57);
  --border: oklch(85.8% 0.028 72);
  --accent: oklch(58.5% 0.132 48);
}
```

辅助结构色采用任务书指定的冷绿 `#2e6f5e`，仅用于有效状态、制度结构与跨轴关系；下沉面采用 `#e8dccf`。

## 字体

- 展示：`"Noto Serif SC", "Songti SC", SimSun, serif`
- 正文：`"Noto Sans SC", "Microsoft YaHei", sans-serif`
- 等宽：`"SFMono-Regular", Consolas, "Liberation Mono", monospace`

## 姿态规则

- 编辑内容占据完整页面工作面，不包进装饰卡片。
- 导航与工具区紧凑，控制高度以 32–40px 为主，最小触控目标 44px。
- 面板之间使用 1px 暖灰分隔线，不使用渐变、玻璃态或大圆角。
- 暖橙强调每屏最多两处；冷绿只表达系统结构和已通过状态。
- 空间层级与制度作用域始终保持独立选择状态，任何一轴切换都不重置另一轴。
