#!/usr/bin/env python3
"""voice-edge 自检：契约 + 韵律 + 缓存，一条命令跑完。

只依赖标准库，对着**正在跑的服务**发请求（默认 8765，灰度实例用 --port 8766）。

    python3 selftest.py
    python3 selftest.py --port 8766 --verbose

干嘛用：每次改 server.py / engine.json 之后跑一遍，比「听一下还行」靠谱；
输出会直接抄进 cases/ 的「验证」表。
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
import wave
import io

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + detail) if detail else ''}")
    return bool(cond)


def speak(port, text=None, **extra):
    body = {"format": "wav", "sr": 24000, "cache": True, **extra}
    if text is not None:
        body["text"] = text
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/speak/file",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return {
                "code": resp.status,
                "headers": dict(resp.headers),
                "body": resp.read(),
            }
    except urllib.error.HTTPError as e:
        return {"code": e.code, "headers": dict(e.headers), "body": e.read()}


def wav_info(raw):
    with wave.open(io.BytesIO(raw), "rb") as w:
        return {
            "channels": w.getnchannels(),
            "rate": w.getframerate(),
            "width": w.getsampwidth(),
            "frames": w.getnframes(),
            "ms": int(round(w.getnframes() * 1000.0 / w.getframerate())),
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--character", default="xiaoyu")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    port = args.port
    char = args.character

    print(f"[selftest] voice-edge @ 127.0.0.1:{port}")

    # 1) 健康检查
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=10) as resp:
            health = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  ✗ /health 打不开：{e}")
        return 2
    check("/health ok", health.get("ok") is True, f"engine={health.get('engine')}")
    check("/health 报韵律表", isinstance(health.get("prosodyTags"), list) and health["prosodyTags"],
          f"{len(health.get('prosodyTags') or [])} 个标记")
    print(f"[selftest] 当前引擎：{health.get('engine')}")

    # 2) 纯文本 → 标准 WAV
    r = speak(port, "今天也要好好吃饭", character=char)
    check("纯文本 200", r["code"] == 200)
    if r["code"] == 200:
        w = wav_info(r["body"])
        check("返回标准 WAV", r["body"][:4] == b"RIFF" and r["body"][8:12] == b"WAVE")
        check("24k / 单声道 / 16bit",
              (w["rate"], w["channels"], w["width"]) == (24000, 1, 2),
              f"{w['rate']}Hz/{w['channels']}ch/{w['width'] * 8}bit")
        check("X-Duration-Ms 与 WAV 头一致",
              abs(int(r["headers"].get("X-Duration-Ms", 0)) - w["ms"]) <= 20,
              f"{r['headers'].get('X-Duration-Ms')} vs {w['ms']}")

    # 3) 缓存第二次必须命中
    r2 = speak(port, "今天也要好好吃饭", character=char)
    check("第二次走缓存", r2["headers"].get("X-Cached") == "1")

    # 4) 语气标记 → 分段 + 停顿
    base = "才不是呢我哪有"
    plain = speak(port, base, character=char)
    tagged = speak(port, "[笑]才不是呢[叹气]我哪有", character=char)
    check("带标记 200", tagged["code"] == 200)
    if plain["code"] == 200 and tagged["code"] == 200:
        segs = int(tagged["headers"].get("X-Segments", "0"))
        check("标记被切成多段", segs >= 2, f"segs={segs}")
        d_plain = wav_info(plain["body"])["ms"]
        d_tag = wav_info(tagged["body"])["ms"]
        check("标记带出停顿/变速（时长不为 0 且与原句不同）",
              d_tag > 0 and abs(d_tag - d_plain) > 50,
              f"plain={d_plain}ms tagged={d_tag}ms")

    # 5) style 覆盖：加速后一句更短
    slow = speak(port, "这是一句用来测速的话", character=char, style={"rate": "-30%"})
    fast = speak(port, "这是一句用来测速的话", character=char, style={"rate": "+40%"})
    if slow["code"] == 200 and fast["code"] == 200:
        d_slow = wav_info(slow["body"])["ms"]
        d_fast = wav_info(fast["body"])["ms"]
        check("style.rate 生效（+40% 比 -30% 短）", d_fast < d_slow, f"-30%={d_slow}ms +40%={d_fast}ms")
    else:
        check("style.rate 生效", False, f"slow={slow['code']} fast={fast['code']}")

    # 6) 裸 PCM
    rp = speak(port, "裸 PCM 也是契约的一部分", character=char, format="pcm")
    check("format=pcm 返回裸 s16le", rp["code"] == 200 and rp["body"][:4] != b"RIFF",
          f"{len(rp['body'])}B")

    # 7) 错误路径
    empty = speak(port, "", character=char)
    check("空文本 400", empty["code"] == 400)
    onlytag = speak(port, "[笑][叹气]", character=char)
    check("只有标记 400", onlytag["code"] == 400)

    # 8) 角色名 → 音色
    if args.verbose:
        print(f"  · X-Voice = {r['headers'].get('X-Voice')}")
        print(f"  · X-Engine = {r['headers'].get('X-Engine')}")

    ok = sum(1 for _, passed, _ in RESULTS if passed)
    bad = len(RESULTS) - ok
    print(f"[selftest] {len(RESULTS)} 项：通过 {ok} / 失败 {bad}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
