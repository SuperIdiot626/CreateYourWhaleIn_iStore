#!/bin/sh
# qq-device-id.sh —— 记录 QQ(NapCat) 的「设备身份」原件，并在变化时报警。
#
# 为什么需要它：
#   主人怀疑「NapCat 一重启就变成新设备登录」。要验证这一点，只能把每次
#   启动时的设备身份原件记下来对比——NapCat 在 Linux 上算 GUID 用
#   md5(/etc/machine-id + machine-info 里的 MAC)，这两样任何一样变了，
#   腾讯那头就会当成新设备。
#
# 记录内容（只存哈希/备份，不打印原文）：
#   · 容器启动时间（restart 保持不变，重建会变）
#   · /etc/machine-id 的 sha256
#   · machine-info（存的是 ROT13 后的 MAC）的 sha256 + 原件备份
#
# 用法（宿主机）：
#   sh qq-device-id.sh            # 记录一次
#   sh qq-device-id.sh --print    # 只打印当前值，不写日志
#
# 建议：cron 每 10 分钟跑一次；这样每次重启/重建都能被捕捉到。
set -u

STATE_DIR="${QQ_STATE_DIR:-/mnt/sata1-4/dsh/home/im}"
LOG="$STATE_DIR/qq-device-id.log"
BAK="$STATE_DIR/device-backup"
CONTAINER="${QQ_CONTAINER:-napcat}"
MACHINE_INFO_HOST="${QQ_MACHINE_INFO:-/mnt/sata1-4/napcat/qq/global/nt_data/msf/machine-info}"

mkdir -p "$BAK" 2>/dev/null || true

started=$(docker inspect "$CONTAINER" --format '{{.State.StartedAt}}' 2>/dev/null || echo missing)
created=$(docker inspect "$CONTAINER" --format '{{.Created}}' 2>/dev/null || echo missing)
machine_id_sha=$(docker exec "$CONTAINER" sha256sum /etc/machine-id 2>/dev/null | cut -d' ' -f1)
[ -n "${machine_id_sha:-}" ] || machine_id_sha="missing"

if [ -f "$MACHINE_INFO_HOST" ]; then
  machine_info_sha=$(sha256sum "$MACHINE_INFO_HOST" | cut -d' ' -f1)
else
  machine_info_sha="missing"
fi

if [ "${1:-}" = "--print" ]; then
  echo "started=$started"
  echo "created=$created"
  echo "machine-id-sha256=$machine_id_sha"
  echo "machine-info-sha256=$machine_info_sha"
  exit 0
fi

line="$(date '+%F %T') started=$started created=$created machine-id=$machine_id_sha machine-info=$machine_info_sha"

# 和上一条对比：只看这两个哈希（created 也会变，但单独提示）
prev=$(tail -n 1 "$LOG" 2>/dev/null || true)
changed=""
if [ -n "$prev" ]; then
  prev_mi=$(printf '%s' "$prev" | sed -n 's/.*machine-id=\([^ ]*\).*/\1/p')
  prev_mf=$(printf '%s' "$prev" | sed -n 's/.*machine-info=\([^ ]*\).*/\1/p')
  [ "$prev_mi" != "$machine_id_sha" ] && changed="$changed machine-id"
  [ "$prev_mf" != "$machine_info_sha" ] && changed="$changed machine-info"
  case "$prev" in
    *"created=$created"*) : ;;
    *) changed="$changed container-recreated" ;;
  esac
fi
if [ -n "$changed" ]; then
  line="$line  ⚠️ 设备指纹变了:$changed"
fi
printf '%s\n' "$line" >> "$LOG"

# 备份原件（只在缺失或内容变化时更新，避免刷屏）
if [ "$machine_info_sha" != "missing" ]; then
  if [ ! -f "$BAK/machine-info.bak" ] || ! cmp -s "$MACHINE_INFO_HOST" "$BAK/machine-info.bak"; then
    cp -f "$MACHINE_INFO_HOST" "$BAK/machine-info.bak.$(date +%Y%m%d-%H%M%S)"
    cp -f "$MACHINE_INFO_HOST" "$BAK/machine-info.bak"
    chmod 600 "$BAK"/machine-info.bak*
  fi
fi
if ! cmp -s /dev/null "$BAK/machine-id.bak" 2>/dev/null || [ ! -s "$BAK/machine-id.bak" ]; then
  docker exec "$CONTAINER" cat /etc/machine-id > "$BAK/machine-id.bak" 2>/dev/null || true
  chmod 600 "$BAK/machine-id.bak" 2>/dev/null || true
fi

[ -n "$changed" ] && echo "⚠️ 设备指纹变了:$changed"
exit 0
