@echo off
chcp 65001 >nul
rem 双击启动（Windows）：起本地服务并用默认浏览器打开
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 Node.js。
  echo   先装一个：https://nodejs.org  ^(选 LTS，22 以上^)
  echo.
  pause
  exit /b 1
)

set ELN_OPEN=1
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
echo   启动中……浏览器会自动打开 http://127.0.0.1:4780
node server\index.js
pause
