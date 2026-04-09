@echo off
setlocal

cd /d "%~dp0" || (
  echo Failed to locate the project root.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js and try again.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found on PATH. Install Node.js and try again.
  exit /b 1
)

call node scripts\quick-start-first-time.mjs
exit /b %errorlevel%
