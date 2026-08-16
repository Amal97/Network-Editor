@echo off
REM Double-click this file in Explorer to start Network Modifier.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund || (echo Install failed. & pause & exit /b 1)
)

node bin\netmod.js start %*
pause
