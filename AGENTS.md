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
