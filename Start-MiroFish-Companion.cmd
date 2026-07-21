@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-mirofish-companion.ps1" %*
exit /b %errorlevel%
