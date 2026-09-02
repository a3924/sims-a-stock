#!/bin/sh
# 我的模拟人生·A股版 —— 本地服务器启动脚本（Mac / Linux）
cd "$(dirname "$0")"
echo "正在启动本地服务器，浏览器将自动打开："
echo "  http://127.0.0.1:8123"
echo "关闭本终端即停止游戏。"
python3 serve.py & 2>/dev/null || python serve.py &
sleep 1
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:8123" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:8123" >/dev/null 2>&1 &
fi
wait
