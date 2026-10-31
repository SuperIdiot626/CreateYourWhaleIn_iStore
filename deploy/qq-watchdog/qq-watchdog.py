#!/usr/bin/env python3
"""QQ 入站看门狗：桥接「假在线、其实聋了」时自动救回来。

## 为什么需要它（2026-11-01 事故）

NapCat 13:38 被风控踢下线，桥接与它的那条 WebSocket 断了（close code=1006），
但桥接进程还活着、控制台端口还开着、`/api/status` 里 `connected` 还是 true。
于是出现了最坏的一种故障：**能发不能收**，外站看着"在线"，其实 10.5 小时一条都收不到。

桥接自己其实**发现了**：13:48:16 它打了

    ⚠️ SnowLuma 上游不健康：已连接但 10 分钟没有收到任何事件包 …

但发现之后**什么也没做** —— 只写日志，不重连、不重启。DSH 插件的自愈轮询
（`maybeAutoStartBridge`，每 2 分钟）只看端口在不在，所以也认为一切正常。

这个脚本补的就是"发现之后怎么办"，跑在容器里，不依赖桥接改动：

    NapCat 可达（它自己的 HTTP 能应答）
      + 桥接 /api/status 说 snowluma 静默/断线
      → 调桥接的 /api/restart 让它退出，DSH 插件的 2 分钟自愈轮询会把它拉起来

判据用「NapCat 可达」做前置，是为了避免 NapCat 自己挂掉时反复重启桥接（那没用，
只会增加抖动）。真正的判据是 `lastPacketAgoMs`：NapCat 每 30 秒无条件发心跳，
心跳停了就说明**桥接这条链路**死了，跟"没人发消息"无关。

另外兜底一件事：桥接进程整个不在、而且超过 4 分钟还没被 DSH 插件拉起
（插件那个自愈开关可能在设置里被关掉），脚本会自己 `node src/bridge.js` 起一个。

## 用法

    python3 qq-watchdog.py            # 正常跑（cron 里也这么调）
    python3 qq-watchdog.py --dry-run  # 只判断、只打印，不动手
    python3 qq-watchdog.py --force    # 忽略频率限制，立刻重启一次（人工救急）
    python3 qq-watchdog.py --status   # 打印当前判据就退出

## 部署（宿主 cron，每 2 分钟）

    */2 * * * * docker exec dsh python3 /root/.dsh/surfcore/qq-watchdog.py >/dev/null 2>&1

日志：`state/qq-watchdog.log`（超过 256KB 自动轮转成 .1）。
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

SURFCORE = "/root/.dsh/surfcore"
STATE = os.path.join(SURFCORE, "state")
CONFIG = os.path.join(SURFCORE, "config.json")
LOG = os.path.join(STATE, "qq-watchdog.log")
LOG_MAX_BYTES = 256 * 1024
RATE_FILE = os.path.join(STATE, "qq-watchdog-restarts.json")

# 判定阈值：NapCat 心跳 30 秒一次，5 分钟没事件包 = 链路已经不可信
SILENCE_MS = int(os.environ.get("QQ_WATCHDOG_SILENCE_MS", str(5 * 60_000)))
# 两次重启之间至少隔 10 分钟；一小时内最多 4 次（防止 NapCat 侧原因导致反复重启）
MIN_RESTART_GAP_S = int(os.environ.get("QQ_WATCHDOG_MIN_GAP_S", str(10 * 60)))
MAX_RESTARTS_PER_HOUR = int(os.environ.get("QQ_WATCHDOG_MAX_PER_HOUR", "4"))
# 桥接进程整个不在了：超过这个时长还没被 DSH 插件拉起，就自己兜底起一个
DOWN_SPAWN_AFTER_S = int(os.environ.get("QQ_WATCHDOG_DOWN_SPAWN_S", str(4 * 60)))


# ─────────────── 基础工具 ───────────────
def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"
    try:
        os.makedirs(STATE, exist_ok=True)
        try:
            if os.path.getsize(LOG) > LOG_MAX_BYTES:
                os.replace(LOG, LOG + ".1")
        except OSError:
            pass
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    print(line, end="")


def console_token(cfg):
    tok = str(cfg.get("consoleToken") or "").strip()
    if tok:
        return tok
    try:
        with open(os.path.join(STATE, "console-token"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def http_json(url, *, token=None, method="GET", body=None, timeout=6):
    headers = {"accept": "application/json"}
    if token:
        headers["x-console-token"] = token
    data = None
    if method.upper() != "GET":
        headers["content-type"] = "application/json"
        data = json.dumps(body if body is not None else {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


# ─────────────── 判据 ───────────────
def probe_napcat(cfg):
    """NapCat（OneBot HTTP）能不能应答。它自己活着，才能怪桥接。"""
    base = str(cfg.get("snowluma", {}).get("httpUrl") or "http://127.0.0.1:3000").rstrip("/")
    token = str(cfg.get("snowluma", {}).get("accessToken") or "")
    try:
        headers = {"content-type": "application/json", "accept": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            f"{base}/get_status", data=b"{}", headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200, json.loads(resp.read().decode("utf-8") or "{}")
    except Exception as e:
        return False, str(e)


def evaluate(status, napcat_ok, napcat_detail):
    """返回 (是否需要重启, 人话原因, 明细)。"""
    sl = (status or {}).get("snowluma") or {}
    ago = sl.get("lastPacketAgoMs")
    silent = bool(sl.get("silent"))
    degraded = bool(sl.get("degraded"))
    connected = sl.get("connected")
    hints = []

    if not connected:
        hints.append("桥接没连上 NapCat WS（connected=false）")
    if silent:
        hints.append("桥接判定入站静默（silent=true）")
    if degraded:
        hints.append("桥接已自报上游不健康（degraded=true）")
    if isinstance(ago, (int, float)) and ago > SILENCE_MS:
        hints.append(f"{int(ago // 1000)} 秒没收到任何事件包（阈值 {SILENCE_MS // 1000} 秒）")

    need = bool(hints)
    if need and not napcat_ok:
        # NapCat 自己都不可达：重启桥接没用，只记录（等 NapCat 恢复后下一次再判）
        return False, "桥接静默，但 NapCat 也不可达（重启桥接没用，等 NapCat 恢复）", {
            "silent": silent, "agoMs": ago, "napcat": napcat_detail,
        }
    return need, "；".join(hints) if hints else "入站健康", {
        "silent": silent, "degraded": degraded, "connected": connected,
        "agoMs": ago, "napcatOk": napcat_ok,
    }


# ─────────────── 重启（带频率限制） ───────────────
def rate_state():
    return load_json(RATE_FILE, {}) or {}


def save_rate_state(st):
    try:
        with open(RATE_FILE, "w", encoding="utf-8") as f:
            json.dump(st, f)
    except OSError:
        pass


def rate_allows(force=False):
    if force:
        return True, ""
    st = rate_state()
    now = time.time()
    last = float(st.get("lastRestartAt") or 0)
    hist = [t for t in (st.get("history") or []) if now - t < 3600]
    if last and now - last < MIN_RESTART_GAP_S:
        return False, f"距上次重启只有 {int(now - last)} 秒（限 {MIN_RESTART_GAP_S} 秒）"
    if len(hist) >= MAX_RESTARTS_PER_HOUR:
        return False, f"最近一小时已经重启 {len(hist)} 次（限 {MAX_RESTARTS_PER_HOUR} 次）"
    return True, ""


def mark_restart():
    now = time.time()
    st = rate_state()
    hist = [t for t in (st.get("history") or []) if now - t < 3600]
    hist.append(now)
    save_rate_state({"lastRestartAt": now, "history": hist})


def find_bridge_pid():
    """按 /proc 找 bridge.js 进程（容器里没有 ps）。"""
    pids = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode(errors="replace")
        except OSError:
            continue
        if "bridge.js" in cmd and "src/bridge.js" in cmd:
            pids.append(int(pid))
    return pids


def restart_bridge(token, cfg):
    """优先让桥接自己退出（/api/restart）；不行再按 pid 发 TERM。"""
    base = f"http://127.0.0.1:{int(cfg.get('consolePort') or 3100)}"
    try:
        http_json(f"{base}/api/restart", token=token, method="POST", body={}, timeout=8)
        return "已请求桥接自重启（/api/restart），等 DSH 插件 2 分钟内拉起"
    except Exception as e:
        pass
    pids = find_bridge_pid()
    if not pids:
        return "没找到 bridge.js 进程，也没拿到 /api/restart 响应"
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError as e:
            return f"SIGTERM pid={pid} 失败：{e}"
    return f"已向 bridge.js（pid={','.join(map(str, pids))}）发 SIGTERM，等 DSH 插件拉起"


def spawn_bridge():
    """最后一道兜底：桥接下线超过几分钟还没人拉起，自己起一个。

    为什么不全靠 DSH 插件的自愈：那条路的开关在别人手里（设置项一关就没人拉），
    而这里的目标是"永远别再静默聋掉"。并发风险可控：桥接有单实例锁和 3100 端口两道闸，
    抢输的那个会自己 exit(2)。
    """
    node = shutil.which("node") or "/usr/local/bin/node"
    if not os.path.exists(node):
        return f"找不到 node（{node}），没法兜底拉起"
    env = dict(os.environ)
    env.setdefault("DSH_WEB_URL", os.environ.get("DSH_WEB_URL") or "http://127.0.0.1:3080")
    logfile = os.path.join(STATE, "bridge.spawn.log")
    try:
        with open(logfile, "a", encoding="utf-8") as out:
            subprocess.Popen(
                [node, os.path.join(SURFCORE, "src", "bridge.js")],
                cwd=SURFCORE,
                env=env,
                stdout=out,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        return f"桥接下线超时，已直接拉起（日志 {logfile}）"
    except Exception as e:
        return f"兜底拉起失败：{e}"


# ─────────────── 主流程 ───────────────
def main():
    args = set(sys.argv[1:])
    cfg = load_json(CONFIG, {}) or {}
    token = console_token(cfg)
    port = int(cfg.get("consolePort") or 3100)
    base = f"http://127.0.0.1:{port}"

    try:
        status = http_json(f"{base}/api/status", token=token)
    except Exception as e:
        # 桥接真的没在跑：平时交给 DSH 插件的 2 分钟自愈轮询；
        # 但它一直没被拉起来（>4 分钟）就自己兜底拉一次，别等主人发现。
        st = rate_state()
        now = time.time()
        down_since = float(st.get("downSince") or 0)
        if "--status" in args:
            print(json.dumps({
                "ok": False,
                "error": f"桥接不可达：{e}",
                "downSeconds": int(now - down_since) if down_since else 0,
            }, ensure_ascii=False, indent=2))
            return 0
        if not down_since:
            save_rate_state({**st, "downSince": now})
            return 0
        if now - down_since < DOWN_SPAWN_AFTER_S:
            return 0
        log(f"⚠️ 桥接已下线 {int(now - down_since)} 秒仍未被拉起，兜底处理")
        if "--dry-run" in args:
            log("   --dry-run：本应自己拉起桥接，本次不动手")
            return 0
        log("   " + spawn_bridge())
        save_rate_state({**st, "downSince": 0, "lastSpawnAt": now})
        return 0

    # 桥接回来了：清掉"下线计时"
    st0 = rate_state()
    if st0.get("downSince"):
        save_rate_state({**st0, "downSince": 0})

    napcat_ok, napcat_detail = probe_napcat(cfg)
    need, why, detail = evaluate(status, napcat_ok, napcat_detail)
    if isinstance(napcat_detail, dict) and napcat_detail.get("status") == "ok":
        detail["napcat"] = "ok"

    if "--status" in args:
        print(json.dumps({
            "needRestart": need, "why": why, "detail": detail,
            "napcatOk": napcat_ok,
            "rate": rate_state(),
        }, ensure_ascii=False, indent=2))
        return 0

    if not need:
        # 平时保持安静：只在"恢复"这一刻和每 30 分钟记一行心跳，证明 cron 还活着
        st = rate_state()
        now = time.time()
        if st.get("wasSilent"):
            log(f"✅ 入站已恢复（lastPacketAgoMs={detail.get('agoMs')}）")
            save_rate_state({**st, "wasSilent": False, "lastOkLogAt": now})
        elif now - float(st.get("lastOkLogAt") or 0) > 30 * 60:
            log(f"入站健康（lastPacketAgoMs={detail.get('agoMs')}，NapCat 可达）")
            save_rate_state({**st, "lastOkLogAt": now})
        return 0

    allowed, block_reason = rate_allows(force="--force" in args)
    log(f"⚠️ 入站不健康：{why}")
    if not allowed:
        log(f"   本次不重启：{block_reason}")
        st = rate_state()
        save_rate_state({**st, "wasSilent": True})
        return 0

    if "--dry-run" in args:
        log("   --dry-run：本应重启桥接，本次不动手")
        return 0

    result = restart_bridge(token, cfg)
    mark_restart()
    st = rate_state()
    save_rate_state({**st, "wasSilent": True})
    log(f"   {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
