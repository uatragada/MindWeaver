@echo off
setlocal

cd /d "%~dp0" || (
  echo Failed to locate the project root.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found on PATH. Install Node.js and try again.
  exit /b 1
)

call npm.cmd run dev
exit /b %errorlevel%
