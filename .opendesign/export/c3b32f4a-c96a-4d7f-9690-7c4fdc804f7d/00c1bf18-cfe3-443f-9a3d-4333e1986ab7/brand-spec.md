# MyAgents 暖纸工作台视觉规范

系统以暖纸底色、深墨文字和克制的烧橙操作色组成连续编辑面，辅以墨绿表达完成、采用与通过状态。

## 色彩令牌

```css
:root {
  --bg: oklch(97.5% 0.012 80);      /* #faf6ee */
  --surface: oklch(99.2% 0.007 79); /* #fffcf7 */
  --fg: oklch(20.5% 0.018 58);      /* #1c1612 */
  --muted: oklch(48.8% 0.026 60);   /* #6f6156 */
  --border: oklch(90.2% 0.030 72);  /* #e8dccf */
  --accent: oklch(61.8% 0.130 48);  /* #c26d3a */
}
```

## 字体

- 展示：`"Noto Serif SC", "Source Han Serif SC", serif`
- 正文：`"Microsoft YaHei", "Noto Sans SC", sans-serif`
- 等宽：`"Cascadia Code", "SFMono-Regular", monospace`

## 姿态规则

- 工作区由连续纸面和 1px 分隔线构成，不使用卡片仪表盘。
- 内容层级依靠栏宽、字重和留白区分；圆角仅用于按钮、标签和局部浮层，最大 8px。
- 烧橙只标识当前选择和主动作，墨绿只标识已采用、已完成与通过。
- 信息密度偏高但保持 14px 常规 UI、16px 正文、12px 元信息。
- 线路和关系保持功能性，连接线轻、节点清晰、画布允许受控平移。

