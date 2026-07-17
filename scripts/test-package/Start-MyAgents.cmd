@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-MyAgents.ps1"
if errorlevel 1 pause
