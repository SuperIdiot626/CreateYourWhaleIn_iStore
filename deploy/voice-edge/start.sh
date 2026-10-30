#!/bin/sh
# 启动 voice-edge（edge-tts 版 voxd 兼容服务）。
# 外层带一个守护循环：服务崩了 3 秒后自动拉起，避免"语音突然没了还得手动起"。
# 幂等：以端口探测判断是否已在跑（容器重启后 pid 会被复用，pidfile 不可靠）。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PIDFILE="$HERE/voice-edge.pid"
LOG="$HERE/voice-edge.log"
PORT="${VOICE_EDGE_PORT:-8765}"

if python3 - "$PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket(); s.settimeout(0.3)
sys.exit(0 if s.connect_ex(('127.0.0.1', int(sys.argv[1]))) == 0 else 1)
PY
then
  echo "already running (port $PORT open)"
  exit 0
fi

mkdir -p "$HERE/cache"
cd "$HERE"
setsid nohup sh -c "cd '$HERE' && while true; do python3 '$HERE/server.py'; echo '[voice-edge] exited, restart in 3s'; sleep 3; done" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
sleep 1
echo "started pid $(cat "$PIDFILE") log=$LOG"
