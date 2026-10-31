#!/usr/bin/env python3
"""语音缓存预热：把 voices.json 里 prewarm 的短句先合成进缓存。

为什么要有它：ROADMAP v0.2 的「缓存命中率优化」——
「嗯」「诶」「在的」这种 0.3 秒的短语气，真人一天要说几十次；
现场合成要等微软 1.5~2.5 秒，预生成之后就是 0 延迟命中（还省流量）。

用法（容器里）：

    python3 prewarm.py                     # 用 voices.json 的 prewarm 清单
    python3 prewarm.py --extra "好呀,别闹"  # 临时补几句
    python3 prewarm.py --port 8766         # 预热另一个实例（灰度/试听）
    python3 prewarm.py --check             # 只查命中情况，不生成

放在 start.sh 里跑一次即可（引擎没起来时会失败，不影响服务）。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_voices():
    p = os.path.join(HERE, "voices.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[prewarm] voices.json 读不出来：{e}", file=sys.stderr)
        return {}


def call(port, text, character, check_only):
    url = f"http://127.0.0.1:{port}/v1/speak/file"
    body = json.dumps(
        {"text": text, "format": "wav", "sr": 24000, "cache": not check_only,
         "character": character},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
        dur = resp.headers.get("X-Duration-Ms", "?")
        hit = resp.headers.get("X-Cached") == "1"
        engine = resp.headers.get("X-Engine", "?")
    return {
        "bytes": len(data),
        "durMs": dur,
        "hit": hit,
        "engine": engine,
        "ms": int((time.time() - t0) * 1000),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("VOICE_EDGE_PORT", "8765")))
    ap.add_argument("--extra", default="", help="逗号分隔，临时再补几句")
    ap.add_argument("--check", action="store_true", help="只查缓存命中，不生成")
    args = ap.parse_args()

    cfg = load_voices()
    phrases = list(cfg.get("prewarm") or [])
    if args.extra:
        phrases += [s.strip() for s in args.extra.split(",") if s.strip()]
    chars = cfg.get("characters") or {}
    character = cfg.get("_prewarmCharacter") or (next(iter(chars)) if chars else "")

    if not phrases:
        print("[prewarm] voices.json 里没有 prewarm 清单，什么都不做")
        return 0

    ok = miss = fail = 0
    total_ms = 0
    for text in phrases:
        try:
            r = call(args.port, text, character, args.check)
        except urllib.error.HTTPError as e:
            fail += 1
            print(f"  ✗ {text!r} → HTTP {e.code} {e.read()[:120]!r}")
            continue
        except Exception as e:
            fail += 1
            print(f"  ✗ {text!r} → {e}")
            continue
        total_ms += r["ms"]
        if r["hit"]:
            ok += 1
            flag = "命中"
        else:
            miss += 1
            flag = "新生成"
        print(f"  ✓ {text!r:<14} {flag} {r['durMs']}ms {r['bytes']}B {r['ms']}ms engine={r['engine']}")

    print(f"[prewarm] {len(phrases)} 句：命中 {ok} / 新生成 {miss} / 失败 {fail}，共 {total_ms}ms")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
