#!/usr/bin/env python3
"""QQ 掉线运营（host 侧，cron 每分钟）：抓码推微信 + 被踢频率监控。

为什么放在宿主机而不是容器里：
  抓二维码要读 NapCat 容器自己的 overlay 目录（`/mnt/sata1-4/docker/overlay2/*/diff/app/napcat/cache/qrcode.png`），
  以前的 `qq-notify.py` 跑在 dsh 容器里、路径对不上，于是每次被踢只报得出
  「掉线（无码）」——2026-11-01 那次因此空了 9 小时没人扫。
  宿主机上 docker / python3 / ffmpeg / node 都有，而且两个容器都是 host 网络，
  3000/3001/3100 端口在宿主机直接可达。

一次检查做四件事：
  1. QQ 在线状态（OneBot 3000 端口）；
  2. 掉线时：读出 NapCat 刚生成的那张二维码（<180 秒才算新），放大到 480 推到微信；
  3. 被踢频率：最近 6 小时掉线 ≥2 次 → 推一条「这个号被盯上了」的提醒（6 小时最多一条）；
  4. 在线但桥接没连上（假在线/聋了）超过 5 分钟 → 推一条提醒（30 分钟最多一条）。

用法：
    python3 qq-ops.py            # 正常跑（cron 里也这么调）
    python3 qq-ops.py --status   # 只打印当前判据，不发消息
    python3 qq-ops.py --test-text # 发一条测试文字到微信（验证推送链路）
"""

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

HOST_IM = "/mnt/sata1-4/dsh/home/im"          # 宿主机上的 im 目录（容器里是 /root/.dsh/im）
CONT_IM = "/root/.dsh/im"                      # 容器内路径（wx-notify 在容器里跑）
HOST_SURF = "/mnt/sata1-4/dsh/home/surfcore"
STATE = os.path.join(HOST_IM, ".qq-ops-state.json")
ALERT = os.path.join(HOST_IM, "qq-alerts.log")
WX = f"{CONT_IM}/bin/wx-notify.mjs"
QR_CONT = "/app/napcat/cache/qrcode.png"        # NapCat 容器里的二维码
QR_RAW_HOST = "/tmp/qq-qr-raw.png"
QR_BIG_HOST = "/tmp/qq-qr-scan.png"
QR_BIG_CONT = f"{CONT_IM}/qr-scan.png"

QR_FRESH_S = 180          # 二维码只在 3 分钟内算"新码"（每约 2 分钟换一张）
FREQ_WINDOW_S = 6 * 3600  # 被踢频率窗口
FREQ_MIN_KICKS = 2        # 窗口内 ≥2 次就提醒
FREQ_WARN_GAP_S = 6 * 3600
DEAF_WARN_GAP_S = 1800
ALERT_GAP_S = 1800


# ─────────────── 基础 ───────────────
def sh(args, timeout=20, check=False):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=check)
    except Exception as e:
        return subprocess.CompletedProcess(args, 1, "", str(e))


def port_open(port, host="127.0.0.1", timeout=0.8):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def load_state():
    try:
        with open(STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(st):
    try:
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False)
    except OSError:
        pass


def log(msg, also_alert=True):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    print(line, end="")
    if also_alert:
        try:
            with open(ALERT, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass


def bridge_snowluma():
    """桥接 /api/status 的 snowluma 快照；桥接不在就 None。"""
    try:
        tok = open(os.path.join(HOST_SURF, "state", "console-token"), "r", encoding="utf-8").read().strip()
        req = urllib.request.Request("http://127.0.0.1:3100/api/status", headers={"x-console-token": tok})
        with urllib.request.urlopen(req, timeout=5) as r:
            return (json.loads(r.read().decode("utf-8")) or {}).get("snowluma")
    except Exception:
        return None


# ─────────────── 微信推送 ───────────────
def push_text(text):
    r = sh(["docker", "exec", "dsh", "node", WX, "text", text], timeout=30)
    ok = r.returncode == 0
    log(f"微信通知（{'成功' if ok else '失败'}）：{text}" + ("" if ok else f" | {r.stderr[:200]}"))
    return ok


def push_qr_image(caption):
    """把宿主机上已放大的二维码塞进容器，再用 wx-notify 发图。"""
    cp = sh(["docker", "cp", QR_BIG_HOST, f"dsh:{QR_BIG_CONT}"], timeout=30)
    if cp.returncode != 0:
        log(f"二维码拷进容器失败：{cp.stderr[:200]}")
        return False
    r = sh(["docker", "exec", "dsh", "node", WX, "image", QR_BIG_CONT, caption], timeout=40)
    ok = r.returncode == 0
    log(f"微信推码（{'成功' if ok else '失败'}）：{caption}" + ("" if ok else f" | {r.stderr[:200]}"))
    return ok


# ─────────────── 抓码 ───────────────
def qr_file_info():
    """NapCat 容器里二维码的 (mtime, age秒)；拿不到就 (None, None)。"""
    r = sh(["docker", "exec", "napcat", "stat", "-c", "%Y", QR_CONT], timeout=15)
    if r.returncode != 0 or not (r.stdout or "").strip().isdigit():
        return None, None
    mtime = int(r.stdout.strip())
    return mtime, int(time.time() - mtime)


def stage_qr():
    """把 NapCat 的二维码拷到宿主机并放大成 480x480。返回是否成功。"""
    cp = sh(["docker", "cp", f"napcat:{QR_CONT}", QR_RAW_HOST], timeout=30)
    if cp.returncode != 0:
        return False
    ff = sh(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-i", QR_RAW_HOST,
             "-vf", "scale=480:480:flags=neighbor", QR_BIG_HOST], timeout=30)
    return ff.returncode == 0 and os.path.exists(QR_BIG_HOST)


# ─────────────── 被踢频率 ───────────────
def seed_kicks_from_log(st):
    """第一次跑的时候，从 qq-alerts.log 里捡出历史掉线时间，别从零开始算。"""
    if st.get("kicksSeeded"):
        return st
    kicks = list(st.get("kicks") or [])
    try:
        with open(ALERT, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.match(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*掉线", line)
                if m:
                    try:
                        kicks.append(time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")))
                    except ValueError:
                        pass
    except OSError:
        pass
    kicks = sorted(set(round(k) for k in kicks))[-50:]
    st["kicks"] = kicks
    st["kicksSeeded"] = True
    return st


def note_kick(st, now):
    kicks = [t for t in (st.get("kicks") or []) if now - t < 7 * 86400]
    kicks.append(now)
    st["kicks"] = sorted(set(kicks))[-50:]
    recent = [t for t in st["kicks"] if now - t < FREQ_WINDOW_S]
    warn = ""
    if len(recent) >= FREQ_MIN_KICKS and now - float(st.get("lastFreqWarn") or 0) > FREQ_WARN_GAP_S:
        span = (recent[-1] - recent[0]) / 3600.0
        warn = (f"⚠️ 小鲸鱼被踢频率升高：最近 {FREQ_WINDOW_S // 3600} 小时掉了 {len(recent)} 次"
                f"（跨度 {span:.1f} 小时）。这个号可能被重点盯上了，建议考虑换小号跑机器人。")
        st["lastFreqWarn"] = now
    return warn


# ─────────────── 主流程 ───────────────
def main():
    args = set(sys.argv[1:])
    now = time.time()
    online = port_open(3000)
    sl = bridge_snowluma() or {}
    connected = sl.get("connected") is True
    biz_ago = sl.get("lastBusinessAgoMs")

    if "--test-text" in args:
        push_text(f"测试：QQ 运营链路已通（{time.strftime('%m-%d %H:%M')}）。以后小鲸鱼被踢，会把二维码图直接发到这里。")
        return 0

    if "--status" in args:
        print(json.dumps({
            "qqOnline": online,
            "bridgeConnected": connected,
            "lastBusinessAgoMs": biz_ago,
            "state": {k: v for k, v in load_state().items() if k != "kicks"}
            | {"kickCount": len(load_state().get("kicks") or [])},
        }, ensure_ascii=False, indent=2))
        return 0

    st = load_state()
    st = seed_kicks_from_log(st)
    prev = st.get("lastOnline")

    # ── 上线 ──
    if online:
        if prev is False and st.get("offlineAlerted"):
            push_text(f"✅ 小鲸鱼重新上线了（{time.strftime('%m-%d %H:%M')}）")
            st["offlineAlerted"] = False
        # 在线但桥接没连上：假在线/聋了
        if connected is False and now - float(st.get("lastDeafWarn") or 0) > DEAF_WARN_GAP_S:
            st["lastDeafWarn"] = now
            push_text(f"⚠️ QQ 在线但桥接没连上 OneBot（{time.strftime('%m-%d %H:%M')}）。"
                      f"桥接会自己重建连接；如果 5 分钟后还没好，我这边会再看。")
        st["lastOnline"] = True
        st["offlineSince"] = 0
        save_state(st)
        return 0

    # ── 掉线 ──
    if prev is not False:
        # 第一次发现掉线：记一笔，按频率决定要不要额外提醒
        st["offlineSince"] = now
        st["qrPushedMtime"] = 0
        warn = note_kick(st, now)
        log("QQ 掉线（OneBot 3000 不通）")
        if warn:
            push_text(warn)
        st["lastOnline"] = False

    # 抓码：只有"新码"才推（旧码是上次登录留下的，扫了也没用）
    mtime, age = qr_file_info()
    if mtime and age is not None and age <= QR_FRESH_S and mtime != st.get("qrPushedMtime"):
        if stage_qr():
            mins = max(1, round(age / 60))
            if push_qr_image(f"小鲸鱼被踢下线了（{time.strftime('%m-%d %H:%M')}）。扫码恢复——"
                             f"这张码 {mins} 分钟前生成，约 2 分钟有效；过期我再送新的。"):
                st["qrPushedMtime"] = mtime
                st["offlineAlerted"] = True
        else:
            log("二维码拷贝/放大失败（NapCat 里有文件，但 stage 失败）")
    elif not st.get("offlineAlerted") and now - float(st.get("lastAlertAt") or 0) > ALERT_GAP_S:
        st["lastAlertAt"] = now
        push_text(f"⚠️ 小鲸鱼掉线了（{time.strftime('%m-%d %H:%M')}），但还没拿到新二维码。"
                  f"NapCat 出码后我会把图推过来。")

    st["lastOnline"] = False
    save_state(st)
    return 0


if __name__ == "__main__":
    sys.exit(main())
