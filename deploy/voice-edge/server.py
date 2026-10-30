#!/usr/bin/env python3
"""voxd 兼容的语音合成服务（Edge TTS 后端）。

SurfCore 的语音子系统只认一个 HTTP 契约（见 docs/guides/SUBSYSTEM-VOICE.md §4）：

    POST /v1/speak/file
    { "text": "...", "format": "wav", "sr": 24000, "cache": true,
      "character": "（可选，角色名）", "voice": "（可选，音色 id）", "style": {...} }
    → 音频字节（format=wav 时是标准 WAV），响应头带 X-Duration-Ms

本文件就是这个契约的最小实现：文字 → edge-tts 合成 mp3 → ffmpeg 转 24k 单声道 wav。
不依赖 FastAPI，只用标准库，方便在容器里 long-run。

约定：
- 只监听 127.0.0.1（语音条不需要外网访问）。
- `character` 走 voices.json 里的角色映射；`voice` 直接当 edge 音色 id 用。
- 文本里的语气标记（[笑] [叹气] [小声] …）Edge 不支持 SSML，这里统一剥掉并换成停顿。
- 磁盘缓存：同 text+voice 直接复用，避免重复烧钱/耗时。
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("VOICE_EDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_EDGE_PORT", "8765"))
MAX_CHARS = int(os.environ.get("VOICE_EDGE_MAX_CHARS", "2000"))
DEFAULT_VOICE = os.environ.get("VOICE_EDGE_VOICE", "zh-CN-XiaoyiNeural")
CACHE_DIR = os.path.join(HERE, "cache")
CACHE_MAX_FILES = int(os.environ.get("VOICE_EDGE_CACHE_MAX", "300"))

# 语气标记：[笑] [叹气] … 剥掉后换成短停顿，避免被念出来
TAG_RE = re.compile(r"[\[（(【]([^\[\]（）()【】]{1,6})[\]）)】]")
PAUSE_TAGS = {"笑", "笑死", "叹气", "小声", "温柔", "不耐烦", "认真", "惊讶", "难过", "平静",
              "开心", "哼", "哭", "生气", "害羞", "无语", "得意", "可怜"}

CHARACTERS = {}
VOICE_LOCK = threading.Lock()


def load_voices():
    """voices.json：{"characters": {"xiaoyu": "zh-CN-XiaoyiNeural"}, "voices": {...}, "default": "..."}"""
    global CHARACTERS
    p = os.path.join(HERE, "voices.json")
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            CHARACTERS = {str(k): str(v) for k, v in (data.get("characters") or {}).items()}
        except Exception as e:  # 配置坏了要出声，但不能起不来
            print(f"[voice-edge] voices.json 读取失败，用默认音色：{e}", flush=True)


def pick_voice(character, voice):
    if voice:
        return str(voice)
    if character and character in CHARACTERS:
        return CHARACTERS[character]
    return DEFAULT_VOICE


def clean_text(text):
    """剥语气标记，换成逗号停顿；压掉多余空白。"""
    def repl(m):
        tag = m.group(1)
        if tag in PAUSE_TAGS:
            return "，"
        return ""
    t = TAG_RE.sub(repl, text)
    t = re.sub(r"[ \t]+", " ", t).strip()
    t = re.sub(r"^，+|，+$", "", t)
    return t


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


def wav_duration_ms(path):
    """从 WAV 头算时长：比 ffprobe 快，且不依赖外部进程。"""
    try:
        import wave
        with wave.open(path, "rb") as w:
            return int(round(w.getnframes() * 1000.0 / w.getframerate()))
    except Exception:
        return 0


async def synth(text, voice):
    """edge-tts 合成 mp3。"""
    comm = edge_tts.Communicate(text, voice)
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


def to_wav(mp3_path, sr):
    """mp3 → 标准 WAV（单声道，给定采样率）。"""
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", mp3_path,
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


def synthesize(text, voice, sr, want_wav):
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = sha1(f"{voice}|{sr}|{text}")
    cached = os.path.join(CACHE_DIR, key + ".wav")
    if os.path.exists(cached) and os.path.getsize(cached) > 0:
        with open(cached, "rb") as f:
            data = f.read()
        return data, wav_duration_ms(cached), True

    mp3 = asyncio.run(synth(text, voice))
    try:
        wav = to_wav(mp3, sr)
    finally:
        try:
            os.remove(mp3)
        except OSError:
            pass
    try:
        with open(wav, "rb") as f:
            data = f.read()
        dur = wav_duration_ms(wav)
        with open(cached, "wb") as f:  # 缓存放最后，写失败不影响本次返回
            f.write(data)
        prune_cache()
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

    if not want_wav:
        # format 缺省 = 裸 PCM：剥掉 44 字节 WAV 头，返回 s16le
        data = data[44:]
    return data, dur, False


class Handler(BaseHTTPRequestHandler):
    server_version = "voice-edge/1.0"

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
            return self._json(200, {"ok": True, "engine": "edge-tts", "defaultVoice": DEFAULT_VOICE,
                                    "characters": sorted(CHARACTERS.keys())})
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

        spoken = clean_text(text)
        if not spoken:
            return self._json(400, {"ok": False, "error": "剥掉语气标记后没有可念的内容"})

        t0 = time.time()
        try:
            with VOICE_LOCK:  # edge-tts 并发太高会被限流，串行更稳
                data, dur, hit = synthesize(spoken, target, sr, want_wav)
        except Exception as e:
            print(f"[voice-edge] 合成失败：{e}", flush=True)
            return self._json(503, {"ok": False, "error": f"语音合成失败：{e}"})

        self.send_response(200)
        self.send_header("content-type", "audio/wav" if want_wav else "audio/L16")
        self.send_header("content-length", str(len(data)))
        self.send_header("X-Duration-Ms", str(dur))
        self.send_header("X-Cached", "1" if hit else "0")
        self.send_header("X-Voice", target)
        self.end_headers()
        self.wfile.write(data)
        print(f"[voice-edge] {len(data)}B {dur}ms voice={target} hit={hit} "
              f"{int((time.time() - t0) * 1000)}ms text={spoken[:30]!r}", flush=True)


def main():
    load_voices()
    os.makedirs(CACHE_DIR, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[voice-edge] listening on http://{HOST}:{PORT} default={DEFAULT_VOICE} "
          f"characters={sorted(CHARACTERS.keys())}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
