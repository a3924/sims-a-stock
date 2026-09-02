@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   我的模拟人生·A股版  ——  本地服务器启动
echo ============================================
echo.
echo 正在启动本地服务器，浏览器将自动打开：
echo   http://127.0.0.1:8123
echo.
echo [说明] 通过本地服务器(http)打开，存档(cookie)最稳定；
echo         关闭这个黑窗口即停止游戏。
echo.
start "" "http://127.0.0.1:8123"
python serve.py
if errorlevel 1 (
  echo.
  echo [错误] 未找到 python，请先安装 Python 3 并加入 PATH，
  echo         或直接双击 index.html 也能玩（仅存档可能不持久）。
  pause
)
