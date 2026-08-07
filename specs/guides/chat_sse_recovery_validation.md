# Chat SSE 断线恢复验证清单（0.4.2）

本文只验证 Tauri SSE 维护型订阅。不要使用 reload、切换 Session 或重启 App 作为“恢复”步骤；恢复必须自动发生。

## Windows 11 / WebView2 构建

在仓库根目录的 PowerShell 执行：

```powershell
.\build_dev_win.ps1
```

运行：

```powershell
.\src-tauri\target\x86_64-pc-windows-msvc\debug\myagents.exe
```

若本机 target 目录不同，以构建脚本最后打印的 exe 路径为准。Debug build 带 DevTools，但本清单不依赖前端手工重连。

## 确定性 transport 测试

先在 Windows 仓库执行：

```powershell
cargo test --manifest-path src-tauri\Cargo.toml sse_proxy::tests --lib
cargo test --manifest-path src-tauri\Cargo.toml sse_owner_resolver --lib
```

第一组用本机 loopback TCP 覆盖 connection refused、HTTP 503、正常 EOF、截断 body error、read timeout、旧 subscription emit fence，以及 supervisor 在失败后重新解析 replacement port 并建立第二条 stream；同时验证同一 HTTP stream 内每条 envelope generation 一致。第二组覆盖 exact hint、owner mismatch fail-closed、pending→real 与 Floating Ball 歧义裁决。测试不访问外网。

## RST / `10054` 等价注入

使用 Microsoft Sysinternals TCPView（或能关闭单条 TCP connection 的等价工具）：

1. 打开一个真实 existing Chat Session，等待 SSE 正常连接；统一日志中会出现 `Subscription <tabId> transport connected`。
2. 在 TCPView 找到 `myagents.exe` 到 `node.exe` loopback 端口的长期 `ESTABLISHED` connection。普通 HTTP 很短暂；持续存在的是 SSE。
3. 右键该 connection，选择 **Close Connection**。这会让 reqwest 进入 Windows reset/close 等价分支；无需精确复现最初未确认的根因。
4. 在自动重连前后继续当前 turn，或立即发送一条可辨识但不含隐私的测试消息。
5. 不做 reload/Session 切换。等待日志出现旧 generation disconnected、retry 和更大的 transport generation connected。

通过标准：页面短暂停顿后自动补齐；测试 user/assistant message 各一次；turn 没有被 abort/restart；最终 loading/streaming/interactive 状态与后端一致。

## Sidecar crash / 换端口

1. 从日志记下当前 Tab 的 resolved endpoint 端口。
2. 用 TCPView 根据该端口定位对应 `node.exe` PID，然后执行：

```powershell
Stop-Process -Id <SIDE_CAR_PID> -Force
```

3. 保持 Chat Tab 不动，等待 Rust health monitor 重建 Sidecar。

通过标准：日志出现新的 resolved endpoint、随后出现更大的 transport generation；Renderer 的 `session-sidecar:restarted` 清理 URL cache、废弃旧 live-revision baseline 并重新执行 REST restore，但不 stop/start 长期 SSE subscription；当前页自动恢复。

## 逐项产品验收

- A1 reset window：streaming 中关闭 SSE connection；窗口内继续 turn/发送；消息恰好一次且 terminal 自动恢复。
- A2 normal EOF：`sse_attempt_forwards_one_generation_on_every_event_then_retries_eof` 与 `supervisor_retries_and_resolves_the_sidecar_port_again` 通过；App 在 Sidecar 正常/异常退出后都不会永久假在线。
- A3 new port：kill 当前 Session Sidecar；supervisor 自动解析 replacement port。
- A10 Floating Ball：打开 companion，对 `connectionKey=fb` 的长期 connection 注入关闭，再验证后续消息继续进入；切换 companion Session/关闭窗口后，旧 supervisor 无 retry/emit。
- A11 multi-Tab：同时打开至少两个不同 Session，只关闭其中一个端口的 SSE connection；另一个 Tab 无 generation/REST/UI 变化，恢复 Tab 不串消息。

## 日志与最小回传

统一日志位于：

```text
%USERPROFILE%\.myagents\logs\unified-YYYY-MM-DD.log
```

可提取 SSE 行：

```powershell
Select-String -Path "$env:USERPROFILE\.myagents\logs\unified-$(Get-Date -Format yyyy-MM-dd).log" -Pattern '\[sse-proxy\]|session-sidecar:restarted'
```

请回传：Windows/WebView2 版本、A1/A2/A3/A10/A11 逐项通过/失败，以及从 subscription start 前一行到恢复 connected 后一行的最小日志片段。可遮盖 workspace、消息正文和其它不相关字段；SSE proxy 本身不记录消息正文或 credential。

## macOS / browser 回归

- macOS Debug App：`./build_dev.sh`；验证正常 streaming、kill Session Sidecar 后自动恢复、Session 切换、Tab 关闭和 Floating Ball。
- Browser dev：`./start_dev.sh`；验证原生 EventSource open/error/reconnect 和消息解析。Browser 不使用 Tauri envelope。
