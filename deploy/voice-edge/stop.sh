#!/bin/sh
# 停止 voice-edge（连同守护循环的整个进程组一起停）。
HERE=$(cd "$(dirname "$0")" && pwd)
PIDFILE="$HERE/voice-edge.pid"

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
    sleep 1
  fi
  rm -f "$PIDFILE"
fi

# 兜底：按命令行再清一遍（pid 文件丢了也不会留下孤儿进程）
pkill -f "$HERE/server.py" 2>/dev/null || true
echo "stopped"
