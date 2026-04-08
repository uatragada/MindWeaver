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

echo Building MindWeaver web app...
call npm.cmd run build
if errorlevel 1 exit /b %errorlevel%

echo Starting MindWeaver production server...
call npm.cmd run start
exit /b %errorlevel%
