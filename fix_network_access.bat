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
echo ==========================================
echo FIXING NETWORK & FIREWALL SETTINGS
echo ==========================================
echo.

echo 1. Setting Network Profile to PRIVATE (Trusted)...
powershell -Command "Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private"
if %errorLevel% == 0 (
    echo    [OK] Network is now Private.
) else (
    echo    [ERROR] Could not set network profile.
)

echo.
echo 2. Opening Port 3000 in Firewall...
netsh advfirewall firewall delete rule name="Allow Node Port 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Allow Node Port 3000" dir=in action=allow protocol=TCP localport=3000 profile=private,domain
if %errorLevel% == 0 (
    echo    [OK] Firewall rule added.
) else (
    echo    [ERROR] Could not add firewall rule.
)

echo.
echo ==========================================
echo DONE!
echo Try accessing http://YOUR_LAN_IP:3000 on your phone.
echo ==========================================
pause
