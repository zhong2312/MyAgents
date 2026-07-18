CLAUDE.md
Novel-Design.md
.opendesign/README.md

## Windows 测试包

- 后续本仓库的日常 Windows 测试打包统一运行根目录入口：`Package-MyAgents-Test.cmd`。不要直接运行裸 `tauri build`，也不要用发布脚本替代测试打包脚本。
- Agent 或 CI 运行时必须关闭批处理暂停：`$env:MYAGENTS_PACKAGE_NO_PAUSE='1'; & .\Package-MyAgents-Test.cmd`。
- 默认产物目录为 `F:\workspace\MyAgents-test`。脚本会构建 Release 应用，以 `app.new -> app` 原子替换程序文件，并保留 `profile` 与 `小说` 两个持久目录。
- 脚本默认执行启动冒烟测试。仅在当前已有其他 MyAgents 实例无法关闭时，才使用 `-SkipSmokeTest`；不能把该参数作为常规默认值。
- 打包前检查环境但不构建：`$env:MYAGENTS_PACKAGE_NO_PAUSE='1'; & .\Package-MyAgents-Test.cmd -ValidateOnly`。
- 自定义测试包或构建工具位置：`& .\Package-MyAgents-Test.cmd -TargetRoot 'D:\MyAgents-test' -BuildToolsRoot 'D:\.myagents-build-tools'`。
- PowerShell 实现位于 `scripts/package-myagents-test.ps1`；修改打包行为时更新该文件，根目录 `.cmd` 仅作为稳定入口保留。

## Windows 开发模式（复用测试包数据）

- 日常改 UI / 小说工作台时，优先用根目录入口：`Start-MyAgents-Dev.cmd`。它会启动开发服务，但读写 `F:\workspace\MyAgents-test\profile` 与 `小说`，与长期测试包共用同一套数据。
- 默认是浏览器开发模式（Vite + TS server，热更新）。完整桌面壳用：`.\Start-MyAgents-Dev.cmd -Mode Tauri`。
- 数据隔离环境变量与测试包启动器一致：`MYAGENTS_DATA_DIR`、`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`MYAGENTS_TEST_ROOT`。
- 自定义测试目录或初始小说项目：`.\Start-MyAgents-Dev.cmd -TestRoot 'D:\MyAgents-test' -AgentDir 'D:\MyAgents-test\小说\枪出如龙'`。
- PowerShell 实现位于 `scripts/start-myagents-dev.ps1`；根目录 `.cmd` 仅作为稳定入口保留。
