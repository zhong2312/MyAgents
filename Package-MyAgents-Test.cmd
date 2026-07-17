@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package-myagents-test.ps1" %*
if errorlevel 1 (
  echo.
  echo Packaging failed. The previous test application was restored when possible.
  if not defined MYAGENTS_PACKAGE_NO_PAUSE pause
  exit /b 1
)
echo.
echo Packaging completed successfully.
if not defined MYAGENTS_PACKAGE_NO_PAUSE pause
