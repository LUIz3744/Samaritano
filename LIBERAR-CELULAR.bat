@echo off
setlocal

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Solicitando permissao de administrador para o Firewall...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall show rule name="Samaritano LAN 5070" >nul 2>&1
if "%errorlevel%"=="0" (
  netsh advfirewall firewall set rule name="Samaritano LAN 5070" new enable=yes profile=private remoteip=localsubnet >nul
) else (
  netsh advfirewall firewall add rule name="Samaritano LAN 5070" dir=in action=allow protocol=TCP localport=5070 profile=private remoteip=localsubnet >nul
)

netsh advfirewall firewall show rule name="Samaritano HTTPS 5071" >nul 2>&1
if "%errorlevel%"=="0" (
  netsh advfirewall firewall set rule name="Samaritano HTTPS 5071" new enable=yes profile=private remoteip=localsubnet >nul
) else (
  netsh advfirewall firewall add rule name="Samaritano HTTPS 5071" dir=in action=allow protocol=TCP localport=5071 profile=private remoteip=localsubnet >nul
)

if "%errorlevel%"=="0" (
  echo.
  echo Firewall liberado somente para a rede local privada.
  echo No celular, abra: https://192.168.1.5:5071
) else (
  echo.
  echo Nao foi possivel criar a regra. Confirme que o Wi-Fi do Windows esta como Rede privada.
)

echo.
pause
