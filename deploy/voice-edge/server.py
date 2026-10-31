#!/usr/bin/env python3
"""voxd 兼容的语音合成服务（v2：可切引擎 + 语气标记真的变成韵律）。

SurfCore 的语音子系统只认一个 HTTP 契约（见 docs/guides/SUBSYSTEM-VOICE.md §4）：

    POST /v1/speak/file
    { "text": "...", "format": "wav", "sr": 24000, "cache": true,
      "character": "（可选，角色名）", "voice": "（可选，音色 id）",
      "style": {"rate":"+10%","pitch":"+5Hz","volume":"+0%","pauseMs":200,"emotion":"笑"} }
    → 音频字节（format=wav 时是标准 WAV），响应头带 X-Duration-Ms

v1 只做「文字 → edge-tts → 24k 单声道 WAV」，语气标记一律换成逗号。
v2 把两件 ROADMAP 上的事做了：

1. **引擎可切换**：`engine.json` 里一行 `engine: "edge" | "openai"`。
   - edge：微软 Edge TTS（免费，默认）
   - openai：任何 OpenAI 兼容的 `/audio/speech` 端点（火山/CosyVoice/本地 TTS 都能套壳），
     baseUrl / model / voice 写在 engine.json，密钥**只从环境变量读**，不落盘。
2. **韵律**：语气标记不再只是停顿，而是「语速 / 音高 / 音量 / 停顿」四件事。
   `[笑]` 快一点高一点，`[叹气]` 慢一点低一点，`[小声]` 小音量压低语速。
   实现方式：按标记切段，每段用各自的 rate/pitch/volume 合成，再按停顿拼接成一条 WAV。
   （Edge 不支持 SSML，所以只能在 HTTP 层分段合成——正好也是换引擎后同样能用的做法。）

约定：
- 只监听 127.0.0.1（语音条不需要外网访问）。
- `character` 走 voices.json 里的角色映射；`voice` 直接当引擎的音色 id 用。
- 磁盘缓存：同 text + 音色 + 韵律参数直接复用；分段结果不单独缓存（拼接过 WAV 很便宜）。
- 引擎挂了返回 503 → 桥接映射 502 → agent 改打字，**不假装发过语音**。
"""

import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("VOICE_EDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_EDGE_PORT", "8765"))
MAX_CHARS = int(os.environ.get("VOICE_EDGE_MAX_CHARS", "2000"))
DEFAULT_VOICE = os.environ.get("VOICE_EDGE_VOICE", "zh-CN-XiaoyiNeural")
CACHE_DIR = os.path.join(HERE, "cache")
CACHE_MAX_FILES = int(os.environ.get("VOICE_EDGE_CACHE_MAX", "300"))

# 语气标记：[笑] [叹气] … 剥掉后按 PROSODY 改韵律，不念出来
TAG_RE = re.compile(r"[\[（(【]([^\[\]（）()【】]{1,6})[\]）)】]")

# ─────────────── 韵律表 ───────────────
# rate / pitch / volume 是 edge-tts 的参数写法；pauseMs 是**这段话之前**留的空白。
# 没登记的短标记 = 纯停顿（延续 v1 行为），长标记当正文保留。
PROSODY = {
    "笑":      {"rate": "+12%", "pitch": "+6Hz",  "volume": "+0%",  "pauseMs": 120},
    "笑死":    {"rate": "+14%", "pitch": "+7Hz",  "volume": "+2%",  "pauseMs": 100},
    "开心":    {"rate": "+10%", "pitch": "+5Hz",  "volume": "+4%",  "pauseMs": 100},
    "兴奋":    {"rate": "+14%", "pitch": "+7Hz",  "volume": "+5%",  "pauseMs": 100},
    "得意":    {"rate": "+8%",  "pitch": "+4Hz",  "volume": "+2%",  "pauseMs": 150},
    "惊讶":    {"rate": "+6%",  "pitch": "+8Hz",  "volume": "+2%",  "pauseMs": 200},
    "害羞":    {"rate": "-5%",  "pitch": "+3Hz",  "volume": "-10%", "pauseMs": 200},
    "小声":    {"rate": "-8%",  "pitch": "+0Hz",  "volume": "-30%", "pauseMs": 250},
    "温柔":    {"rate": "-6%",  "pitch": "-2Hz",  "volume": "-5%",  "pauseMs": 150},
    "叹气":    {"rate": "-10%", "pitch": "-4Hz",  "volume": "-5%",  "pauseMs": 350},
    "难过":    {"rate": "-10%", "pitch": "-4Hz",  "volume": "-8%",  "pauseMs": 350},
    "哭":      {"rate": "-12%", "pitch": "-3Hz",  "volume": "-5%",  "pauseMs": 300},
    "委屈":    {"rate": "-8%",  "pitch": "+2Hz",  "volume": "-15%", "pauseMs": 300},
    "生气":    {"rate": "+8%",  "pitch": "+2Hz",  "volume": "+8%",  "pauseMs": 250},
    "哼":      {"rate": "+6%",  "pitch": "+3Hz",  "volume": "+0%",  "pauseMs": 200},
    "不耐烦":  {"rate": "+10%", "pitch": "+1Hz",  "volume": "+0%",  "pauseMs": 150},
    "无语":    {"rate": "-8%",  "pitch": "-3Hz",  "volume": "-5%",  "pauseMs": 400},
    "认真":    {"rate": "-3%",  "pitch": "+0Hz",  "volume": "+0%",  "pauseMs": 200},
    "平静":    {"rate": "+0%",  "pitch": "+0Hz",  "volume": "+0%",  "pauseMs": 150},
    "可怜":    {"rate": "-8%",  "pitch": "+1Hz",  "volume": "-10%", "pauseMs": 300},
    "心虚":    {"rate": "-4%",  "pitch": "+2Hz",  "volume": "-10%", "pauseMs": 200},
}
# 只留停顿、不带情绪的标记（老行为和 v1 一致）
PAUSE_ONLY_TAGS = {"嗯", "诶", "啊", "哦", "呃", "那个", "……", "..."}

DEFAULT_PROSODY = {"rate": "+0%", "pitch": "+0Hz", "volume": "+0%"}

CHARACTERS = {}
ENGINE_CFG = {
    "engine": "edge",
    "edge": {"proxy": ""},
    "openai": {
        "baseUrl": os.environ.get("VOICE_OPENAI_BASEURL", ""),
        "model": os.environ.get("VOICE_OPENAI_MODEL", "tts-1"),
        "voice": os.environ.get("VOICE_OPENAI_VOICE", "alloy"),
        # 密钥只从环境变量读，engine.json 里只写变量名
        "apiKeyEnv": "VOICE_OPENAI_KEY",
        "format": "mp3",
    },
    "prosody": {"base": dict(DEFAULT_PROSODY)},
}
VOICE_LOCK = threading.Lock()


# ─────────────── 配置 ───────────────
def load_jsons():
    """voices.json（角色映射 + 预热清单）与 engine.json（引擎/韵律）都是可选的。"""
    global CHARACTERS, ENGINE_CFG
    p = os.path.join(HERE, "voices.json")
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            CHARACTERS = {str(k): str(v) for k, v in (data.get("characters") or {}).items()}
        except Exception as e:  # 配置坏了要出声，但不能起不来
            print(f"[voice-edge] voices.json 读取失败，用默认音色：{e}", flush=True)

    e = os.path.join(HERE, "engine.json")
    if os.path.exists(e):
        try:
            with open(e, "r", encoding="utf-8") as f:
                data = json.load(f)
            for k, v in data.items():
                if isinstance(v, dict) and isinstance(ENGINE_CFG.get(k), dict):
                    ENGINE_CFG[k].update(v)
                else:
                    ENGINE_CFG[k] = v
        except Exception as e2:
            print(f"[voice-edge] engine.json 读取失败，用内置默认：{e2}", flush=True)

    # 环境变量优先于文件（便于临时换引擎试听）
    if os.environ.get("VOICE_EDGE_ENGINE"):
        ENGINE_CFG["engine"] = os.environ["VOICE_EDGE_ENGINE"]


def active_engine():
    return str(ENGINE_CFG.get("engine") or "edge").lower()


def base_prosody():
    p = dict(DEFAULT_PROSODY)
    p.update(ENGINE_CFG.get("prosody", {}).get("base") or {})
    return p


def pick_voice(character, voice):
    if voice:
        return str(voice)
    if character and character in CHARACTERS:
        return CHARACTERS[character]
    return DEFAULT_VOICE


# ─────────────── 分段与韵律 ───────────────
def parse_segments(text, style=None):
    """把文本切成 [(说话内容, 该段韵律, 前置停顿)]。

    标记语义：标记管的是**它后面**那句话的情绪，停顿插在那句话之前
    （真人先吸一口气/笑一声，再说话）。
    """
    style = style if isinstance(style, dict) else {}
    base = base_prosody()
    # 请求级的 style 覆盖：先当全局基准，再叠加标记
    for k in ("rate", "pitch", "volume"):
        if style.get(k):
            base[k] = str(style[k])
    if style.get("emotion") in PROSODY:
        base.update({k: v for k, v in PROSODY[style["emotion"]].items() if k != "pauseMs"})

    segs = []
    pending_pause = int(style.get("pauseMs") or 0)
    cur = {"rate": base["rate"], "pitch": base["pitch"], "volume": base["volume"]}
    pos = 0
    for m in TAG_RE.finditer(text):
        chunk = text[pos:m.start()]
        if chunk.strip():
            segs.append({"text": chunk, "prosody": dict(cur), "pauseMs": pending_pause})
            pending_pause = 0
        tag = m.group(1).strip()
        if tag in PROSODY:
            p = PROSODY[tag]
            cur = {"rate": p["rate"], "pitch": p["pitch"], "volume": p["volume"]}
            pending_pause = max(pending_pause, int(p.get("pauseMs") or 0))
        elif tag in PAUSE_ONLY_TAGS:
            pending_pause = max(pending_pause, 200)
            cur = {"rate": base["rate"], "pitch": base["pitch"], "volume": base["volume"]}
        else:
            # 不认识的标记：直接扔掉，不念出来
            cur = {"rate": base["rate"], "pitch": base["pitch"], "volume": base["volume"]}
        pos = m.end()
    tail = text[pos:]
    if tail.strip():
        segs.append({"text": tail, "prosody": dict(cur), "pauseMs": pending_pause})

    for s in segs:
        s["text"] = re.sub(r"[ \t]+", " ", s["text"]).strip()
    segs = [s for s in segs if s["text"]]
    return segs


# ─────────────── 引擎 ───────────────
def synth_edge(text, voice, prosody):
    """edge-tts：一段文字 → mp3 临时文件。"""
    import edge_tts  # 只在用 edge 引擎时才要求装它

    async def _run():
        comm = edge_tts.Communicate(
            text,
            voice,
            rate=str(prosody.get("rate") or "+0%"),
            pitch=str(prosody.get("pitch") or "+0Hz"),
            volume=str(prosody.get("volume") or "+0%"),
            proxy=(ENGINE_CFG.get("edge", {}).get("proxy") or None),
        )
        fd, mp3 = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        try:
            await comm.save(mp3)
            return mp3
        except Exception:
            try:
                os.remove(mp3)
            except OSError:
                pass
            raise

    return asyncio.run(_run())


def synth_openai(text, voice, prosody, sr):
    """任何 OpenAI 兼容的 /audio/speech。返回临时音频文件（mp3/wav 都行，后面 ffmpeg 统一）。"""
    import urllib.request

    cfg = ENGINE_CFG.get("openai", {})
    base_url = str(cfg.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("engine=openai 但 engine.json 里没配 openai.baseUrl")
    key = os.environ.get(str(cfg.get("apiKeyEnv") or "VOICE_OPENAI_KEY"), "")
    body = {
        "model": str(cfg.get("model") or "tts-1"),
        "input": text,
        "voice": voice or str(cfg.get("voice") or "alloy"),
        "response_format": str(cfg.get("format") or "mp3"),
        # speed 只接受 0.25~4.0 的倍数；把 rate 的百分比近似转成倍数
        "speed": _rate_to_speed(prosody.get("rate")),
    }
    req = urllib.request.Request(
        f"{base_url}/audio/speech",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "content-type": "application/json",
            **({"authorization": f"Bearer {key}"} if key else {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
    if not raw:
        raise RuntimeError("引擎返回空音频")
    fd, path = tempfile.mkstemp(suffix=".bin")
    os.close(fd)
    with open(path, "wb") as f:
        f.write(raw)
    return path


def _rate_to_speed(rate):
    """'+10%' → 1.10；解析不了就 1.0。"""
    try:
        s = str(rate or "+0%").strip()
        if s.endswith("%"):
            return max(0.25, min(4.0, 1.0 + float(s[:-1]) / 100.0))
        return max(0.25, min(4.0, float(s)))
    except Exception:
        return 1.0


def synth_segment(text, voice, prosody, sr):
    """一段文字 → 该段 WAV 路径（统一 24k/给定采样率、单声道、s16le）。"""
    engine = active_engine()
    if engine == "openai":
        src = synth_openai(text, voice, prosody, sr)
    else:
        src = synth_edge(text, voice, prosody)
    try:
        return to_wav(src, sr)
    finally:
        try:
            os.remove(src)
        except OSError:
            pass


def to_wav(path, sr):
    """任意音频 → 标准 WAV（单声道，给定采样率）。"""
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
             "-ar", str(sr), "-ac", "1", "-acodec", "pcm_s16le", wav],
            check=True,
        )
        return wav
    except Exception:
        try:
            os.remove(wav)
        except OSError:
            pass
        raise


# ─────────────── 拼接 / 缓存 ───────────────
def silence_frames(ms, sr):
    return b"\x00\x00" * int(sr * max(0, ms) / 1000)


def assemble(parts, sr, out_path):
    """把 [(wav 路径, 前置停顿)] 拼成一条 WAV；顺便返回总时长（ms）。"""
    with wave.open(out_path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sr)
        for path, pause in parts:
            if pause:
                out.writeframes(silence_frames(pause, sr))
            with wave.open(path, "rb") as w:
                out.writeframes(w.readframes(w.getnframes()))
    return wav_duration_ms(out_path)


def wav_duration_ms(path):
    """从 WAV 头算时长：比 ffprobe 快，且不依赖外部进程。"""
    try:
        with wave.open(path, "rb") as w:
            return int(round(w.getnframes() * 1000.0 / w.getframerate()))
    except Exception:
        return 0


def sha1(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def prune_cache():
    try:
        files = [os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR) if f.endswith(".wav")]
    except FileNotFoundError:
        return
    if len(files) <= CACHE_MAX_FILES:
        return
    files.sort(key=lambda p: os.path.getmtime(p))
    for p in files[: len(files) - CACHE_MAX_FILES]:
        try:
            os.remove(p)
        except OSError:
            pass


def cache_key(text, voice, sr, segs, engine):
    sig = "|".join(
        f"{s['text']}~{s['prosody']['rate']}~{s['prosody']['pitch']}~{s['prosody']['volume']}~{s['pauseMs']}"
        for s in segs
    )
    return sha1(f"{engine}|{voice}|{sr}|{sig}")


def synthesize(text, voice, sr, style):
    """返回 (WAV 字节, 时长 ms, 是否缓存命中, 段数, 引擎名)。"""
    engine = active_engine()
    segs = parse_segments(text, style)
    if not segs:
        raise ValueError("剥掉语气标记后没有可念的内容")

    os.makedirs(CACHE_DIR, exist_ok=True)
    key = cache_key(text, voice, sr, segs, engine)
    cached = os.path.join(CACHE_DIR, key + ".wav")
    if os.path.exists(cached) and os.path.getsize(cached) > 44:
        with open(cached, "rb") as f:
            return f.read(), wav_duration_ms(cached), True, len(segs), engine

    parts = []
    tmp_files = []
    fd, out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    tmp_files.append(out)
    try:
        for s in segs:
            wav = synth_segment(s["text"], voice, s["prosody"], sr)
            tmp_files.append(wav)
            parts.append((wav, s["pauseMs"]))
        dur = assemble(parts, sr, out)
        with open(out, "rb") as f:
            data = f.read()
        try:  # 缓存放最后，写失败不影响本次返回
            with open(cached, "wb") as f:
                f.write(data)
            prune_cache()
        except OSError:
            pass
    finally:
        for p in tmp_files:
            try:
                os.remove(p)
            except OSError:
                pass
    return data, dur, False, len(segs), engine


# ─────────────── HTTP ───────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "voice-edge/2.0"

    def log_message(self, fmt, *args):  # 让日志走 stdout，由 start.sh 重定向
        print(f"[voice-edge] {self.address_string()} {fmt % args}", flush=True)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/api/v1/health", "/"):
            try:
                cached = len([f for f in os.listdir(CACHE_DIR) if f.endswith(".wav")])
            except OSError:
                cached = 0
            return self._json(200, {
                "ok": True,
                "engine": active_engine(),
                "defaultVoice": DEFAULT_VOICE,
                "characters": sorted(CHARACTERS.keys()),
                "cacheFiles": cached,
                "prosodyTags": sorted(PROSODY.keys()),
            })
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/speak/file":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            return self._json(400, {"ok": False, "error": f"请求体必须是合法 JSON：{e}"})

        text = str(body.get("text") or "").strip()
        if not text:
            return self._json(400, {"ok": False, "error": "text 不能为空"})
        if len(text) > MAX_CHARS:
            return self._json(413, {"ok": False, "error": f"文本过长（{len(text)} > {MAX_CHARS} 字）"})

        fmt = str(body.get("format") or "pcm").lower()
        want_wav = fmt == "wav"
        sr = int(body.get("sr") or 24000)
        if sr < 8000 or sr > 48000:
            sr = 24000
        character = body.get("character")
        voice = body.get("voice")
        target = pick_voice(character, voice)
        style = body.get("style")

        t0 = time.time()
        try:
            with VOICE_LOCK:  # 引擎并发太高会被限流，串行更稳
                data, dur, hit, nseg, engine = synthesize(text, target, sr, style)
        except ValueError as e:
            return self._json(400, {"ok": False, "error": str(e)})
        except Exception as e:
            print(f"[voice-edge] 合成失败：{e}", flush=True)
            return self._json(503, {"ok": False, "error": f"语音合成失败：{e}"})

        if not want_wav:
            # format 缺省 = 裸 PCM：剥掉 44 字节 WAV 头，返回 s16le
            data = data[44:]

        self.send_response(200)
        self.send_header("content-type", "audio/wav" if want_wav else "audio/L16")
        self.send_header("content-length", str(len(data)))
        self.send_header("X-Duration-Ms", str(dur))
        self.send_header("X-Cached", "1" if hit else "0")
        self.send_header("X-Voice", target)
        self.send_header("X-Engine", engine)
        self.send_header("X-Segments", str(nseg))
        self.end_headers()
        self.wfile.write(data)
        print(f"[voice-edge] {len(data)}B {dur}ms engine={engine} voice={target} segs={nseg} "
              f"hit={hit} {int((time.time() - t0) * 1000)}ms", flush=True)


def main():
    load_jsons()
    os.makedirs(CACHE_DIR, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[voice-edge] v2 listening on http://{HOST}:{PORT} engine={active_engine()} "
          f"default={DEFAULT_VOICE} characters={sorted(CHARACTERS.keys())} "
          f"tags={len(PROSODY)}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
