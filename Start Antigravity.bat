@echo off
cd /d "%~dp0"
title Antigravity / 3DFLOW Server
echo ==================================================
echo   Starting Antigravity / 3DFLOW server...
echo   The dashboard will open in your browser shortly.
echo   Login:  admin  /  antigravity
echo   Keep THIS window open while using the site.
echo   Close this window (or press Ctrl+C) to stop.
echo ==================================================
echo.

REM Stop any server already running on port 3000 (clean restart)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Stopping previous server (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 >nul

REM Open the dashboard a few seconds after the server starts
start "" cmd /c "timeout /t 5 >nul && start "" http://localhost:3000"

REM Start the server (uses settings from .env)
node server.js

echo.
echo Server stopped. Press any key to close this window.
pause >nul
