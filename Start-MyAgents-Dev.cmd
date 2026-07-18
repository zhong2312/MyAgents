@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-myagents-dev.ps1" %*
if errorlevel 1 (
  echo.
  echo Development mode failed to start.
  if not defined MYAGENTS_DEV_NO_PAUSE pause
  exit /b 1
)
