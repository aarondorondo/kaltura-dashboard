@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  npm install
)
start /b node src/server.js
timeout /t 2 /nobreak >nul
start http://localhost:3000
