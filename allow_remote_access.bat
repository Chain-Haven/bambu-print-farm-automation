@echo off
echo Requesting administrator privileges...
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Success: Administrative permissions confirmed.
) else (
    echo Failure: Current permissions inadequate.
    echo Please right-click this file and select "Run as administrator".
    pause
    exit
)

echo.
echo Opening port 3000 for Antigravity...
netsh advfirewall firewall add rule name="Allow Node Port 3000" dir=in action=allow protocol=TCP localport=3000

echo.
echo Done! You should now be able to access the site from your phone.
echo URL: http://YOUR_LAN_IP:3000
echo.
pause
