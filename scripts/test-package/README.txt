MyAgents 长期测试包
===================

启动：双击 Start-MyAgents.cmd

目录约定：

  app\       当前应用程序和运行时资源。更新测试包时可以整体替换。
  profile\   持久配置、会话、凭据、日志和 WebView 数据。更新时禁止删除。
  小说\      小说项目父目录。每一部小说仍以自己的目录作为项目根目录。

更新规则：

  1. 先退出所有 MyAgents 进程。
  2. 运行仓库根目录的 Package-MyAgents-Test.cmd。
  3. 打包脚本会更新 app、启动器、README 和 PACKAGE-INFO.json。
  4. 打包脚本不会覆盖或删除 profile、小说目录。

该测试包通过 MYAGENTS_DATA_DIR、HOME、USERPROFILE、APPDATA 和 LOCALAPPDATA
使用独立持久 profile，不与普通安装版 MyAgents 的配置目录混用。普通安装版和
测试版不能同时运行。
