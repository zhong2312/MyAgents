# MyAgents 长期测试包脚本

在仓库根目录双击 `Package-MyAgents-Test.cmd`，即可完成一次完整更新。

也可以在 PowerShell 中运行：

```powershell
.\scripts\package-myagents-test.ps1
```

默认配置：

- 测试目录：`F:\workspace\MyAgents-test`
- 隔离构建工具：`F:\workspace\.myagents-build-tools`
- 构建目标：`x86_64-pc-windows-msvc` release

脚本会依次执行：

1. 关闭测试包自己的 MyAgents、Node 和 cuse 进程。
2. 对 `profile` 和 `小说` 目录生成更新前指纹。
3. 构建前端、服务端、插件桥、CLI 和 Tauri release exe。
4. 在 `app.new` 中组装完整程序和运行时资源。
5. 将旧 `app` 暂存为 `app.previous`，再切换新程序。
6. 更新 `PACKAGE-INFO.json` 和 exe SHA-256。
7. 确认持久目录未在替换过程中发生变化。
8. 通过 `Start-MyAgents.ps1` 启动并执行 10 秒烟雾测试。
9. 成功后关闭测试实例并清理回滚副本。

构建、复制、哈希或启动检查任一步失败，脚本都会尝试恢复旧 `app` 和旧包信息。脚本不会删除或替换 `profile`、`小说`、启动脚本和测试包说明文件。

常用参数：

```powershell
# 只检查工具链、资源和测试目录，不执行构建
.\scripts\package-myagents-test.ps1 -ValidateOnly

# 使用其他测试目录
.\scripts\package-myagents-test.ps1 -TargetRoot 'D:\MyAgents-test'

# 跳过启动烟雾测试，适合另一套 MyAgents 正在运行时使用
.\scripts\package-myagents-test.ps1 -SkipSmokeTest
```
