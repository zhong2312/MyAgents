# Windows 跨端兼容 Review 与实测指南（WebView2 / Chromium）

> **日期**：2026-06-06 · **分支**：`dev/0.2.31`
> **用途**：在 **Windows 真机**上实测确认本文列出的跨端兼容问题。Windows 跑 **WebView2（Chromium/Edge，Evergreen）**；本仓库长期只在 **macOS（WKWebView/WebKit）** 开发与度量，二者在 CSP 继承、滚动条布局、原生子 webview 合成、DPR 等处系统性发散。
> **重要**：以下结论是 macOS 主机上的**静态源码分析 + WebKit-vs-Chromium 行为推理**得出的，**未在 Windows 实跑过**。标 `需实测` 的项，请按本文「验证步骤」在真机 WebView2 build 上先确认现象，再决定修复。
> **2026-08-02 更新**：W3 已按原生输入感知滚动条 PRD 完成代码与确定性测试：所有共享默认 data directory 的 WebView builder 统一走 `src-tauri/src/webview_policy.rs`，Windows 选择 Fluent Overlay，Renderer 的全局 6px / 透明 thumb / scroll activity 模拟已删除。Windows 真机矩阵仍未执行，因此状态是 `implemented-needs-verify`，不是可发布结论。

普通文本复制统一走 `src/renderer/utils/clipboard.ts::copyPlainText`：WebView2 的 Async Clipboard 即使存在也可能因焦点/权限 reject，helper 会在同一用户动作内退回隐藏 textarea selection copy，并且两路都失败时 reject，调用方不得显示“已复制”。Windows 真机回归必须覆盖“Async Clipboard reject + fallback 成功”和“双路径失败不误报”两种场景。
> **配套**：完整 PRD 在 `specs/prd/prd_0.2.31_windows_cross_platform_review.md`（注意 `specs/prd/` 被 `.gitignore`，**不会同步到 Windows 机器** —— 故本 tech_doc 自包含全部信息）。相关 memory：见 `project_windows_cross_platform_review.md`。
> **修复判据（第零原则）**：架构正确 + 零技术债 + Δcomplexity≤0；归位 ownership / 复用既有原语，不叠 band-aid。所有修复 MUST 保持 **macOS 行为逐像素不回退**。

---

## 0. 结论摘要

1. **2026-06-06 的前端性能优化轮（P0–P3）在 Windows 上是安全的——没有引入跨端回归**（依据见 §3 W0）。本批 Windows 问题都是 **Mac-only 开发长期遗留的*既有*债**，不是该轮引入的。
2. **5 个既有 Windows 问题**，按价值排序：

| ID | 严重度 | 一句话 | 需 Windows 实测 |
|---|---|---|---|
| **W1** | 🔴 would-break | 工具生成图片用 `http://127.0.0.1:PORT` 当 `<img src>`，不在 CSP `img-src` → Codex/gemini 产图在 Windows 大概率全裂 | **是**（先确认） |
| **W2** | 🔴 would-break（限 D3/Lucide/Mermaid 等 widget） | srcdoc widget 在 Chromium 继承父 CSP，CDN `<script>` 被拦；Chart.js 已修，其余 CDN 库 widget 空白 | 否（代码注释自证；实测作确认） |
| **W3** | 🟠 implemented-needs-verify | Windows 改由 WebView2 Fluent Overlay；主滚动面保留 stable gutter 作为旧 Runtime / classic fallback 的布局保护 | **是（发布硬门槛）** |
| **W4** | 🟠 would-degrade | 分栏浏览器是 OS 级 WebView2 子控件，`transition-[width]` 期间每帧 resize → 撕裂 + IPC 风暴 | **是** |
| **W5** | 🟡 latent/minor | `macFunctionKeyGuard` 未按平台门控 → Windows 上几乎每次 Ctrl+键都全 DOM 扫描（永远 no-op） | 否 |

---

## 1. 怎么在 Windows 上验证（准备）

1. 拉本分支，按 `guides/windows_build_guide.md` 出一个 **debug build**（`build_dev_win.ps1` 默认生成可直接运行的 debug exe，带 DevTools + `VITE_DEBUG_MODE=true`），或生产 `build_windows.ps1`。只有需要验证安装器时才跑 `build_dev_win.ps1 -BundleNsis`。debug build 可开 DevTools 看 console（关键）。
2. **打开 DevTools console**（debug build）。CSP 违例会以红字 `Refused to load … because it violates the following Content Security Policy directive: …` 出现 —— 这是 W1/W2 最直接的证据。
3. 按下面每项的「验证步骤」逐条走。把 console 报错 + 截图记下来，回填到本文或 PRD。
4. **最小烟测优先**：W1/W3/W4 三项只需各做一个动作即可证实/排除，先把这三项跑了。

> 注：如果只能出生产 build（无 DevTools），W1 可用"工具产图是否显示"肉眼判断；W3/W4 也都是肉眼可见现象。

---

## 2. 发现逐项（现象 / 根因 / 验证步骤 / 修法）

### W0 — 本轮性能优化（P0–P3）的 Windows 安全性 ✅（无需改，仅记录依据）

- **结论**：路由分割的 chunk 用**相对 URL** 加载（Vite 默认 `base:'/'`，构建产物 chunk→chunk 为 `import("./x.js")`），CSP `script-src 'self'` 的 `'self'` 在 `tauri://localhost`(Mac) 与 `http://tauri.localhost`(Windows) 都解析为文档源 → 同源 chunk + modulepreload 两端都放行；`requestIdleCallback` 已整体移除；perfMark/store/memo 平台无关。**本轮无需为 Windows 改动。**
- **可选验证**：Windows 上打开 Chat/Settings/TaskCenter 各一次 → 正常加载、console 无 chunk 加载错误即可。

---

### W1 — 工具生成图片在 Windows 大概率全裂 🔴 `needs-verify`

- **现象（预期）**：在 Windows 上让 AI 用工具产图（Codex 官方 `image_generation`，或 builtin gemini-image），工具卡里**图片不显示/裂图**；DevTools console 出现 `Refused to load the image 'http://127.0.0.1:PORT/api/attachment/tool/...' because it violates the following Content Security Policy directive: "img-src ..."`。**macOS 上同样的图能正常显示**（这正是跨端发散）。
- **根因（WebKit vs Chromium）**：`src/renderer/utils/toolAttachment.ts:44` 在 Tauri 下把工具产物解析成 `http://127.0.0.1:${port}${refPath}`，喂给 `<img src>`（`ToolImageAttachment.tsx` → `ToolAttachmentGallery`，挂在 `Message.tsx`/`TaskTool.tsx`）。但 CSP `img-src`（`src-tauri/tauri.conf.json:15`）= `'self' data: blob: asset: myagents: http://myagents.localhost https://asset.localhost https://download.myagents.io https:` —— 有 `https:` 通配，**没有 `http:`、没有 `http://127.0.0.1:*`**（`http://127.0.0.1:*` 只在 `connect-src`，那管 `fetch`/XHR、不管 `<img>`）。`toolAttachment.ts:8-10` 注释"`img-src` already permits http(s)"是错的（把 CORS 当 CSP、把 `https:` 当 `http:`；`<img>` 默认 no-cors，CORS 头与显示无关，唯一闸门是 `img-src`）。按 CSP 规范两端都应拒；Mac 能出图 = WebKit 对 loopback 宽容（或只在 browser-dev 相对 URL 验证过）。**Chromium/WebView2 严格 → Windows 裂。**
- **验证步骤**：
  1. Windows debug build，开 DevTools console。
  2. 触发一次工具产图（让 AI 调 Codex `image_generation` 或 gemini-image）。
  3. 看工具卡是否显示图 + console 是否有 `img-src` 拒绝。
  4. 对照：同一操作在 macOS 上能显示（确认是跨端差异而非全坏）。
- **确认后的修法（第零原则，Δcomplexity 负）**：把工具产物的 URL **从 `http://127.0.0.1:PORT` 改走已存在的 app-owned attachment protocol**（`src-tauri/src/attachment_protocol.rs`）：macOS/Linux 输出 `myagents://tool-attachment/<rel>`，Windows/WebView2 输出 Tauri 2 custom-protocol 的实际子资源形态 `http://myagents.localhost/tool-attachment/<rel>`；两端 `img-src`/`media-src` 都已列 `myagents:` + `http://myagents.localhost`，Rust handler 对两种 URL 形式都有测试。与用户上传路径（`attachmentUrl.ts`）同源。顺带删掉 per-session 端口查找（`getSessionPort`）。
- **D 不变量**：Mac 工具图逐像素不变；attachment-aware 权限/路径安全不被绕过；pending/error sentinel 行为不变。

---

### W2 — D3/Lucide/Mermaid 等 CDN-脚本 widget 在 Windows 空白 🔴（Chart.js 已修）

- **现象（预期）**：用 D3 / Lucide（或其它非 Chart.js 的 CDN 库）的 generative-UI widget，在 Windows 上**空白**；用 **Chart.js 的 widget 正常**（已修）。"部分显示部分不显示"是 per-widget 指纹。SVG-only / inline-script widget 不受影响。
- **根因**：widget 在 `sandbox="allow-scripts"` 的 srcdoc iframe 渲染。**Chromium/WebView2 让 srcdoc iframe 继承父 CSP 并与自身 meta CSP 取交集（最严胜）；WebKit 不强制**。父 `script-src 'self' 'unsafe-inline'` ∩ widget-meta（含 CDN 主机）= 只剩 `'unsafe-inline'` → 外部 CDN `<script src>` 被拦。`src/renderer/components/tools/widgetLibraries.ts` **已为 Chart.js 修好**（渲染期把 CDN `<script src>` 换成本地 bundled UMD 的内联 `<script>`，跑在 `'unsafe-inline'` 下、且去网络依赖），但注册表 `LIBRARIES`（`:43-55`）**只有 chart.js**，代码自带注释（`:38-42`）明说 D3/Mermaid/Lucide 未注册 → 这些 widget 在 Windows 仍空白。
- **验证步骤**：
  1. Windows build。让 AI 生成一个用 **Chart.js** 的图表 widget → 应正常（验证已修机制在 Windows 生效）。
  2. 再生成一个用 **D3** 或 **Lucide** 的 widget → 预期空白；DevTools console 看是否 `Refused to load the script 'https://…cdn…' … script-src`。
- **确认后的修法（机制现成，只加注册行）**：给 `widgetLibraries.ts` 的 `LIBRARIES` 加 D3、Lucide 两行（`?raw` 别名到各自 UMD dist，与 `chartjs-umd-source` 同模式）。**不要**把 CDN 主机加进父 CSP（会重引网络依赖，且 opaque-origin srcdoc 对 `src='self'` 无效、只认 `'unsafe-inline'`）。Mermaid 已是 app dep + 聊天 fenced-block 已渲染，widget 内极少用 → 最低优先。
- **D 不变量**：已修的 Chart.js 路径不回退；`</script>` 转义防御保留；渲染期解析（不持久化库源到 session）不变。

---

### W3 — 原生输入感知滚动条与 Virtuoso 宽度稳定性 🟠 `implemented-needs-verify`

- **旧根因**：Renderer 曾对所有元素强制 6px scrollbar，并在 Windows 用 scroll capture + 850ms activity class 把 thumb 在静止时设为透明。它只有“滚动中”状态，没有鼠标寻找、hover 或拖拽状态；同时 classic scrollbar 仍占布局宽，overflow 阈值变化会让消息列与文件树重排。
- **现行 owner**：`src-tauri/src/webview_policy.rs` 是 native style 的唯一解析入口。Windows 返回 `ScrollBarStyle::FluentOverlay`，macOS / Linux 返回 `Default`；主窗口、Browser child、macOS / Windows 浮球、Shield 与 Companion 的全部 builder 都调用同一 policy。这个一致性是 WebView2 共享 data directory 的硬约束，由 Rust 测试枚举 builder 防止后续漏配。
- **Renderer 边界**：全局 6px / `scrollbar-width: thin` / transparent thumb / `.myagents-scrollbar-active` 已删除，浮球对 conversation scrollbar 的局部 WebKit override 也已删除。Theme 只保留根 `color-scheme`。MessageList、WorkspaceTreeViewport、GlobalSidebar 与能力列表保留 `scrollbar-gutter: stable`，用于旧 Runtime 不支持 Fluent Overlay 或其它 classic fallback 时稳定内容盒；它不创建新的滚动层，也不改变 Virtuoso owner。
- **Runtime 边界**：Fluent Overlay 需要 WebView2 Runtime ≥ 125.0.2535.41；旧 Runtime 对该选项不生效并保持浏览器 Default。不得用透明 thumb 或 pointer proximity 监听为旧 Runtime 再造模拟 fallback。
- **Windows 发布验证（尚未执行）**：
  1. 记录 Windows 10 / 11 与 WebView2 Runtime 版本；确认主窗口、Companion、embedded Browser child 都能创建，没有 data-directory style 冲突。
  2. mouse 与 precision touchpad 分别验证静止、滚动、指针进入 scrollbar 区、thumb drag；显隐过程不能改变内容宽度。
  3. 覆盖 light / dark、100% / 125% / 150% DPI、“始终显示 scrollbar”开关、High Contrast / forced colors。
  4. 长会话流式输出验证 follow / pin、历史反向加载与正文居中；文件树验证 sticky ancestors、拖放、定位文件与 scroll restore。
- **macOS 发布验证（尚未完整执行）**：系统 scrollbar“自动 / 滚动时 / 始终”偏好、mouse / trackpad、light / dark；确认没有 MyAgents 6px / 颜色残留，且 App 级 overlay 合成关系不回退。
- **D 不变量**：scroll container / Virtuoso 继续拥有内容滚动；WebView / OS 唯一拥有 scrollbar 外观与输入态；不能因 W3 再引入 Renderer 可见性状态。

---

### W4 — 分栏浏览器的 OS 子 webview 在过渡期每帧重定位 → Windows 撕裂 🟠 `needs-verify`

- **现象（预期）**：打开/关闭右侧分栏浏览器时（300ms 宽度过渡），内嵌浏览器**步进/滞后/撕裂**，跟不上 React 面板边缘；Mac 上平滑。
- **根因**：分栏浏览器是 **OS 级子 webview**（`src-tauri/src/browser.rs` `add_child` → `set_position/set_size`）。`transition-[width]` 300ms 期间（`Chat.tsx:3180`），`BrowserPanel` 的 ResizeObserver（`BrowserPanel.tsx:232`）每观测帧 `invoke('cmd_browser_resize')` → Rust 每帧重定位。Mac 子 `WKWebView` 同层、随父合成器平滑；**Windows 子 WebView2 是独立 controller**，每帧 `SetWindowPos`、不参与父 CSS transition 合成 → 撕裂 + ~18 次/开（300ms/16ms）IPC。`#290` 的 `hasUsableBrowserBounds` 只挡退化 0 宽帧，不挡过渡中几十次合法 resize。
- **验证步骤**：
  1. Windows build，在 Chat 里打开右侧分栏浏览器（split-view browser）。
  2. 观察开/关栏过渡 300ms 内 webview 是否撕裂/滞后；（debug build 可看 IPC 频率）。
  3. 对照 Mac（应平滑）。
- **确认后的修法（复用既有隐藏机制）**：代码已在 `isDraggingSplit` 时隐藏 webview（`BrowserPanel.tsx:262`）。把同一 `shouldShow=false` 门控扩展到"开栏过渡进行中"（监听 chat-area 的 `transitionrun`/`transitionend` 或复用 300ms 窗口），过渡中显示 paper 占位、`transitionend` 时**一次**权威 `cmd_browser_resize`。若 Mac 上隐藏导致观感变差，则按平台门控（仅 Windows 启用隐藏）。
- **D 不变量**：Mac 开栏观感不回退；拖拽分栏（`isDraggingSplit`）现有行为不变；最终 bounds 精确。
- **⚠️ #339 后注（v0.2.34）**：上面"`transitionend` 时一次权威 resize"的方向已被否决——#339 证明任何"等布局稳定后采样一次"的一次性机制都会被未建模的运动源（工作区 overlay 翻转的纯位移、`%` 宽度对窗口尺寸的重解析）漏掉，把 webview 永久停在中间帧。现行实现是 `BrowserPanel.tsx` 的**常驻逐帧 geometry reconciler**（webview 存活+可见期间每帧对账 rect ↔ 上次送达值，变了才 invoke、in-flight 串行化）。W4 的撕裂缓解如需做，只能做"过渡中隐藏"侧（suspension 已有），**不要**回到 transitionend 单次采样。

---

### W5 — `macFunctionKeyGuard` 在 Windows 上每次 Ctrl+键全 DOM 扫描 🟡（逻辑确定，可直接修）

- **现象**：无可见 UI 问题，但 Windows 上输入路径有无谓开销：每次按住 Ctrl 的击键都触发多趟全文档 `querySelectorAll('textarea, input')`（永远 no-op）。
- **根因**：`src/renderer/utils/macFunctionKeyGuard.ts` 在 `main.tsx:20` **无条件安装**。`onKeyDown`（`:126-133`）在 `metaKey||ctrlKey` 时 `scheduleScrub()`，每次排 5 趟延迟 `scrubAllInputs()`（`:157` 全文档查询）。Mac 上是偶发 Cmd；Windows 上 Ctrl 是日常键（Ctrl+A/C/V/X/Z、Ctrl+←/→、Ctrl+Backspace）→ 一大半击键都触发。而该泄漏（ASCII C0 U+001C–001F）是 **WKWebView 专属**，WebView2 根本不产生 → 永远 no-op 纯浪费。
- **修法（安装期平台门控）**：`main.tsx:20` 用 macOS 判定门控 `installMacFunctionKeyGuard()`（Windows/Linux no-op）。Mac 行为完全不变（守卫照装、单测保留）。无需 Windows 实测。

---

## 3. 已确认 cross-platform-safe（**不要**再查，避免浪费）

- `content-visibility:hidden` 后台 Tab（Chromium 原生支持更好）；`runAfterNextPaint` 双 rAF（spec 定义）；30fps 流式 reveal（`dt` clamp 抗节流）；`mix-blend-mode` 点阵纹理（画在 `#root` 之下、廉价）。
- PdfViewer DPR（`PdfViewer.tsx`/`pdfMetrics.ts` 正确读 `devicePixelRatio` + clamp + `deviceCanvasSize`，1.5× 不糊）；OS 浏览器 bounds（`browser.rs` 用 `LogicalPosition/LogicalSize`，分数 DPR 安全）。
- 键盘快捷键（`appShortcuts.ts` 用 `modHeld(e,isMac)`、`isMac` 取自 `navigator.platform`）；close-layer（按平台 close-tab 触发）；发送键 + IME（W3C composition 三重守卫，Windows 拼音/微软 IME 一致）。
- 字体栈（`index.css` 含 `Segoe UI` / `Cascadia Code`/`Consolas` / `Microsoft YaHei`，Windows 有正确 fallback、无 tofu）。
- 媒体：音频走 `blob:`（`media-src` 含）；用户上传走 app-owned attachment protocol（macOS/Linux `myagents://attachment/...`，Windows/WebView2 `http://myagents.localhost/attachment/...`；两端 img-src/media-src 覆盖）；`/refs/:id` 走 `connect-src` + `Access-Control-Allow-Origin:*`；pdf worker 同源 `script-src 'self'`。无 `convertFileSrc`/`asset://`/`tauri://` 硬编码。

## 4. 环境性 / 预存（不修，仅记录）

- **WebView2 软件渲染回退**（RDP/VM/老 GPU/组策略禁 GPU）：~15 处 `backdrop-blur`（含常驻 TitleBar）+ 合成相关过渡 + Virtuoso 会**退化非崩溃**。环境问题，非代码 bug；若有 Windows 软渲染性能报告，再考虑 `@media (prefers-reduced-transparency)` 优雅降级。
- **CSP 缺 `'wasm-unsafe-eval'`**：本轮不引入 wasm/eval；但未来某懒加载 chunk 拉入用 wasm 的库（历史上某些 mermaid/syntax 路径）会在两端都撞 CSP。预存备查。

## 5. 推荐顺序

先 Windows 烟测证实/排除 W1/W3/W4 → **W1（产图全裂，最高价值）→ W2（widget 库补全）→ W3（代码已实现，完成真机发布矩阵）→ W4（webview 过渡隐藏）→ W5（守卫门控）**。每项独立成 commit、可单独回滚、复用既有原语、零新概念，且 MUST 保持 Mac 逐像素不回退。
