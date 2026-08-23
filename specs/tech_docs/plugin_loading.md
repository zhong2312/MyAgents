# Claude Plugin Loading (PRD 0.2.17)

> 与 Anthropic 官方的 [Claude Code Plugin 协议](https://code.claude.com/docs/en/plugins-reference) 对接的产品层。MyAgents 负责"目录 + 启停"；builtin 由 SDK 加载运行，Managed Codex 则由 Product Extension compiler 按组件转换。
>
> 关联：
> - PRD：`specs/prd/prd_0.2.17_plugin_basic_support.md`
> - 研究：`specs/research/0514_research_claude_plugin_mechanism.md`
> - 当前 SDK 版本：`@anthropic-ai/claude-agent-sdk@0.3.233`；插件入口仍是 `Options.plugins: SdkPluginConfig[]`（MyAgents 当前只传 `type: 'local'`）

---

## 边界（最重要的三句话）

1. **Builtin Runtime 不解释插件内组件**。`SKILL.md` 的 frontmatter 字段、`hooks.json` 的 30+ 种事件、`.mcp.json` 的 server 配置、`${CLAUDE_PLUGIN_ROOT}` 替换——**全部交给 SDK**；MyAgents 只把绝对路径喂给 `Options.plugins`。Managed Codex 是下文明确登记的例外，由 Product Extension compiler 读取并转换可忠实映射的组件。
2. **OpenClaw 的 `plugin` 和 Claude 的 `cc-plugin` 是两套独立体系**。前者是 IM 渠道 npm 包（飞书/微信适配器），存在 Rust Management API；后者是 Anthropic 协议的插件目录，存在 Node Sidecar 的 AppConfig + 磁盘。CLI 命名分别是 `myagents plugin *` vs `myagents cc-plugin *`，互不影响。HTTP 路径也分别是 `/api/plugin/*`（Rust）vs `/api/cc-plugin/*`（Node Sidecar），不会撞名。
3. **两层启用模型，镜像 MCP**（PRD 0.2.17 重构）：
   - Layer 1（全局可见性）：`AppConfig.enabledPlugins` —— Settings 面板的开关，OFF 则各工作区都看不到此 plugin（"安装但隐藏"）
   - Layer 2（工作区启用）：`Agent.enabledPluginIds` / `Project.enabledPluginIds` —— 实际在该 Agent / 工作区被选用的子集。两个 UI surface 写入同一份：Agent 设置面板的「插件」行 + Chat 输入框工具菜单的「插件」子菜单

---

## 模块布局

```
src/server/plugins/
├── url-resolver.ts   # 解析用户输入：owner/repo / GitHub URL / zip URL / file://
├── fetcher.ts        # 拉取 → ExtractedTree（复用 skills/tarball-fetcher.ts）
├── manifest.ts       # plugin.json 解析 + 组件清单扫描（仅 UI 展示用）
├── installer.ts      # 树分析（detect plugin / marketplace / multi-plugin）+ 写盘
└── store.ts          # install / uninstall / toggle / list（withConfigLock 序列化）

src/shared/types/plugin.ts   # PluginEntry / PluginManifest / PluginComponentInventory / SSE event types
```

---

## 数据流

### 探测（`POST /api/cc-plugin/inspect`）

PRD 0.2.17 追加：用户填 URL 后**先探测、后选装**，让 marketplace 风格的多插件仓库（如 `anthropics/claude-for-legal` 13 个法律插件平铺在根目录）能一键批量导入。

```
renderer InstallDialog 输入视图 → apiPostJson('/api/cc-plugin/inspect', { sourceUrl })
  → store.inspectPluginSource(sourceUrl)
      → resolvePluginUrl + fetchPluginTree + analysePluginTree（不写盘）
  → return { mode, ... }
      ├─ mode: 'plugin'         → 自动 fallthrough 调 /install 走单装路径
      ├─ mode: 'multi-plugin'   → 切到「选择视图」，列出每个 candidate 的
      │                            { rootPath, manifest, manifestError? }，
      │                            默认全选（坏 manifest 的自动剔除）
      ├─ mode: 'marketplace'    → 友好提示「v0.2.18 支持」
      └─ mode: 'no-plugin'      → 友好错误
```

### 批量安装（多次 `/install` + `subPath`）

```
renderer 选择视图 → 用户勾选 → 「安装 N 个」按钮
  → 切到「正在安装」视图，串行循环：
      for each chosen candidate:
        apiPostJson('/api/cc-plugin/install', {
          sourceUrl,           // 原始 URL（不变）
          subPath: cand.rootPath,
          installId: uuid(),
        })
        → 后端 installPlugin(sourceUrl, { subPath })
            → analysePluginTree(tree, subPath) 收敛到 mode: 'plugin'
            → 走单装路径（withConfigLock + rename atomicity）
        → 收集 result.ok / error
  → 全部完成后：UI 弹「成功 N 个，失败 M 个」+ 列出每条
  → onInstalled() 刷新列表
```

**为什么串行不并行**：(1) 并发请求同名 GitHub 仓库会撞 rate limit；(2) installPlugin 的 `withConfigLock + installingNames` 防 race 假定串行调用；(3) 用户看进度条更直观。

### 安装（`POST /api/plugin/install`）

```
renderer InstallDialog → apiPostJson('/api/plugin/install', { sourceUrl, installId })
  → admin-api 注册的路由 handler (src/server/index.ts:6845+)
      → broadcast('plugin:install-progress', { phase: 'fetching' })
      → store.installPlugin(sourceUrl, { onProgress })
          → resolvePluginUrl(sourceUrl)                       (url-resolver)
          → fetchPluginTree(source)                           (fetcher → tarball-fetcher)
          → analysePluginTree(tree, subPath)                  (installer)
              → 'plugin' | 'marketplace' | 'multi-plugin' | 'no-plugin'
          → withConfigLock 检查 name 冲突
          → clearBrokenSymlinkAt(installPath)                 (Pit of Success 红线：双 lstat 防 cpSync crash)
          → writePluginToDisk(installPath, tree, rootPath)    (复用 skills/installer.writeSkillFiles 的 zip-slip 防护)
          → withConfigLock { plugins.push(entry); enabledPlugins[id] = true }
      → broadcast('plugin:install-progress', { phase: 'done' })
      → broadcast('plugins:changed', { reason: 'install' })
      → schedulePluginRestartLazy() → agent-session.schedulePluginDeferredRestart()
          → forceReloadActiveSession('plugins')
              → 若有 turn 在跑：scheduleDeferredRestart('plugins') + schedulePreWarm()
              → 否则：abortPersistentSession() (下一次 pre-warm 拿到新 plugin 列表)
```

### SDK 注入（PRD 0.2.17 两层模型）

```
agent-session.ts::commonQueryOptions 构建处
  ↓
  determine contextEnabledIds:
    if currentEnabledPluginIds !== null  → use per-Tab override (Layer 2)
    else                                  → getDefaultEnabledPluginIdsForWorkspace(agentDir)
                                            (Agent.enabledPluginIds, fallback Project)
  ↓
  getEnabledPluginSdkConfigs(contextEnabledIds)
    Layer 1: filter by AppConfig.enabledPlugins[id] === true (visibility gate)
    Layer 2: filter by contextEnabledIds (per-workspace enable)
    Symlink-swap defense: lstat + realpath canonical check
    返回 [{ type: 'local', path: '/abs/path' }, ...]
  ↓
  Options.plugins 注入
  ↓
  SDK 自动展开 plugin 内组件，merge 到 skills/agents/mcpServers/hooks
```

per-Tab override 设置：renderer 在 chat 输入框「插件」子菜单勾选 →
`/api/cc-plugin/session-enable` → `SessionEngine.updateEnabledPluginIds()`。Builtin adapter
委托 `setSessionEnabledPluginIds()` 并 schedule SDK restart；Managed Codex adapter 更新
extension desired revision，在 idle/terminal 安全边界 replacement process。两条路径都继续以
Plugin Store + Session enabled id set 为 authority。

`system-cli` Claude Code / Codex / Gemini 不消费这套 MyAgents-owned 投影；只有
`runtime:'codex' + runtimeSource:'managed-provider'` 例外。其 compiler 独立读取启用 Plugin
的 canonical 安装目录；Skills、Commands、Agents 按 project > user > plugin 优先级合并，
MCP 则按 server id 独立合并并显式报告冲突。compiler 读取 `plugin.json` 中受信任的
`skills`、`commands`、`agents`、`mcpServers` 相对路径：Skills 的自定义路径补充默认目录，
Commands/Agents 的自定义路径替代默认目录，MCP 自定义文件/inline 配置补充 `.mcp.json`。
Hooks、LSP、monitors、bin、SSE MCP 或含不可忠实映射字段的 Agent
逐组件报告 unsupported；一个组件失败不允许冒充整包成功，也不阻断其它可转换组件。

SDK `system/init.plugins` 会回报实际加载项的 `{ name, path, version? }`，用于低频
runtime 诊断；它不取代 MyAgents Plugin Store。设置页中的安装版本、启停和卸载仍以
Plugin Store 为唯一权威，避免把一次 Session 的加载快照误当成全局安装状态。

### Slash 菜单发现（plugin skills / commands）

Chat 输入框的 `/` 菜单有两类数据源：

1. **本地静态源**：Launcher 没有 Session Sidecar，继续由 `cmd_list_slash_commands` 通过 Rust 扫描工作区 / 用户的 commands 与 skills；Chat 则消费 `/api/project-capabilities` 返回的同一份 enabled project/global snapshot，与侧栏和 Runtime 保持一致。两条路径都必须保留 `skill` / `custom` 来源，不能因合并顺序改写成 SDK 来源。
2. **SDK 动态源**：builtin SDK 初始化后返回 `initializationResult().commands`，运行中还可能发 `commands_changed.commands`。Sidecar 将这份全量 snapshot 通过 `chat:slash-commands` SSE 发给 Tab，前端只在 Chat/builtin runtime 下把它作为补充项合并进菜单。前端每次收到同 session 的 snapshot 都用 replace 语义覆盖旧值，空数组也是有效状态（表示 runtime 当前没有 SDK commands），这样用户中途关闭 plugin 后可在下一次 SDK restart / `commands_changed` 后自然收敛。

对 builtin，这条动态源仍是 plugin skills 可被手动 `/plugin:skill` 触发的唯一正确来源：Renderer 不扫描 `~/.myagents/plugins/<id>/skills` 重建 SDK 语义。合并规则是本地静态源优先，SDK 只追加本地没有的命令，避免覆盖 `/goal` / `/loop` 这类 renderer client-action 或本地自定义命令。Managed Codex 也不消费 `chat:slash-commands`；它由 Sidecar compiler 按 Session snapshot 解析 Plugin Command，并在 turn admission 时展开。其它外部 Runtime 两条路径都不消费。

新会话首轮存在 `pending-* → UUID` 的 session birth upgrade：SDK snapshot 可能先于 React prop 同步到达，也可能在 SSE stream 仍标记为 pending 时携带真实 `sessionId`。前端只有在内部 state 已经由后端事件采纳该真实 `sessionId`、父级 prop 只是从 pending 补同步时，才把它视为同一个 session 的 snapshot 迁移窗口并保留/接受匹配真实 `sessionId` 的 SDK commands；真正的 reset / target replacement / external runtime 切换仍然清空该 volatile state。已有历史 Session 必须由 App new / jump / revive 目标 Tab，任何未建立 birth proof 的 target 变化都不是 birth upgrade，必须立即清空旧 snapshot。

---

## 磁盘布局

```
~/.myagents/
├── config.json                        # AppConfig.{plugins, enabledPlugins, pluginConfigs}
└── plugins/
    ├── <plugin-name>/                  # 每个插件一个目录，名字与 plugin.json::name 一致
    │   ├── .claude-plugin/plugin.json
    │   ├── skills/...
    │   ├── agents/...
    │   ├── .mcp.json
    │   ├── hooks/hooks.json
    │   └── ...
    └── data/
        └── <sanitized-id>/             # ${CLAUDE_PLUGIN_DATA}（如 node_modules、cache）
```

**沙箱性质**：插件代码以**当前用户权限**运行。安装弹窗显式警告"插件可执行任意代码 / 启动 MCP 进程 / 触发 hook 脚本"。

---

## SSE 事件

| Event | 时机 | Payload |
|-------|------|---------|
| `plugin:install-progress` | 安装的每个阶段 | `{ installId, phase: 'fetching'\|'extracting'\|'validating'\|'writing'\|'done'\|'failed', message?, error? }` |
| `plugins:changed` | install / uninstall / toggle 完成 | `{ reason: 'install'\|'uninstall'\|'toggle'\|'manifest_reload' }` |

注册位置：
- `src/server/sse.ts::SSE_EVENT_PRIORITIES`（`critical` 优先级——结构性事件不允许 coalesce/drop）
- `src/renderer/api/SseConnection.ts::JSON_EVENTS`
- `src/renderer/context/TabProvider.tsx` 把这两个事件 re-broadcast 成 `myagents:plugin-install-progress` / `myagents:plugins-changed` 的 window CustomEvent，`GlobalPluginsPanel` 监听这俩。

---

## 边界 & 红线

| 红线 | 落地点 |
|------|--------|
| 断 symlink 让 Node `cpSync` 抛 C++ 异常 abort sidecar | `installer.clearBrokenSymlinkAt()` + `fetcher.isBrokenSymlink()` lstat 双探 |
| SSRF | 复用 `tarball-fetcher.assertPublicUrl()` |
| zip-slip | 复用 `skills/installer.writeSkillFiles()` |
| Config race | 所有 AppConfig 修改走 `withConfigLock` |
| 大 payload 进 SSE | `plugin:install-progress` 只传 phase + 短文本 |
| `__dirname` 在 esbuild bundle 里硬编码 | 所有路径解析走绝对路径或 `fileURLToPath(import.meta.url)` |
| 外部 runtime 误走 SDK plugin 注入 | `schedulePreWarm` 的 `isExternalRuntime` 守卫；Managed Codex 只走 SessionEngine → extension compiler |
| 新 SSE 事件不注册白名单导致静默丢消息 | 已注册 `JSON_EVENTS` + `SSE_EVENT_PRIORITIES` |
| 名称冲突 | `plugin` (OpenClaw) vs `cc-plugin` (Claude) 严格分开 |

---

## 排除范围（v0.2.18+ 处理）

- **Marketplace 协议**（`.claude-plugin/marketplace.json` + `/plugin marketplace add` 等价）
- **Project scope**（仓库级 `.claude/settings.json::enabledPlugins`）
- **`userConfig` 弹窗**（敏感 token 走 Keychain）
- **版本升级**（重装即可）
- **Orphan 7-day GC**
- **`npm` / `git-subdir` 源**
- **方案 C**（透传 `extraKnownMarketplaces` 让 SDK 自动读 `~/.claude/settings.json`）

碰到 `marketplace.json` 时 `analysePluginTree` 返回 `mode: 'marketplace'`，前端给出友好提示"请提供单个插件子目录的链接"。
