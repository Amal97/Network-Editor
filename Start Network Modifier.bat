@echo off
setlocal
REM Double-click this file in Explorer to start Network Modifier.
cd /d "%~dp0"

set MIN_NODE_MAJOR=20
set MIN_NODE_MINOR=19

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install Node.js %MIN_NODE_MAJOR%.%MIN_NODE_MINOR% or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  set NODE_MAJOR=%%a
  set NODE_MINOR=%%b
)

set NODE_TOO_OLD=0
if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% set NODE_TOO_OLD=1
if %NODE_MAJOR% EQU %MIN_NODE_MAJOR% if %NODE_MINOR% LSS %MIN_NODE_MINOR% set NODE_TOO_OLD=1
if %NODE_TOO_OLD% EQU 1 (
  echo Found Node.js %NODE_MAJOR%.%NODE_MINOR%, but %MIN_NODE_MAJOR%.%MIN_NODE_MINOR% or newer is required.
  echo Update Node.js from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund || (echo Install failed. & pause & exit /b 1)
)

node bin\netmod.js start %*
if errorlevel 1 (
  echo Turning the system proxy back off so the internet keeps working...
  node bin\netmod.js system-proxy off >nul 2>&1
)
pause
