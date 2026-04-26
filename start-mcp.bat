@echo off
setlocal

cd /d "%~dp0" || (
  echo Failed to locate the project root. 1>&2
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js and try again. 1>&2
  exit /b 1
)

if not exist "server\mcp.js" (
  echo MindWeaver MCP server entrypoint was not found at server\mcp.js. 1>&2
  exit /b 1
)

node server\mcp.js
exit /b %errorlevel%
