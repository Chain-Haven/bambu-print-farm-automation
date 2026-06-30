@echo off
setlocal

echo Starting PrintKinetix local cloud node...
echo.

if not exist ".env" (
  echo Missing .env file.
  echo Copy .env.example to .env and set CLOUD_API_URL plus LOCAL_NODE_TOKEN first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

call npm run local-node
pause
