"""本地 ASR 微服务 —— 给小智后端用。

为什么单独一个进程：
  whisper 模型加载要 1~3 秒、常驻吃 300MB~1GB。放在 Node 后端里既别扭又会拖慢
  音频线程；单独一个只做"PCM/WAV 进来 → 文字出去"的小服务最干净。

跑法：
    py -3.10 asr_server.py            # 默认 127.0.0.1:8004
环境变量：
    ASR_PORT      端口（默认 8004）
    ASR_MODEL     模型（默认 small；可选 base/small/medium，越大越准越慢）
    ASR_LANG      语言（默认 zh）
    ASR_COMPUTE   int8 / float32（默认 int8，CPU 上快很多）

接口：
    POST /asr     body = 16kHz 单声道 16bit WAV 字节  →  {"ok":true,"text":"...","ms":123}
    GET  /health  →  {"ok":true,"model":"small","loaded":true}
"""

import io
import json
import os
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = os.environ.get("ASR_MODEL", "small")
LANG = os.environ.get("ASR_LANG", "zh")
COMPUTE = os.environ.get("ASR_COMPUTE", "int8")
PORT = int(os.environ.get("ASR_PORT", "8004"))

_model = None
_loaded_at = 0.0


def get_model():
    """懒加载：第一次请求时才把模型读进内存。"""
    global _model, _loaded_at
    if _model is None:
        from faster_whisper import WhisperModel  # 放函数里，/health 不依赖它

        t0 = time.time()
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE)
        _loaded_at = time.time() - t0
        print(
            f"[asr] 模型已加载：{MODEL_NAME} ({COMPUTE})，耗时 {_loaded_at:.1f}s",
            flush=True,
        )
    return _model


def wav_duration_sec(data: bytes) -> float:
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate() or 16000
            return frames / rate
    except Exception:
        return 0.0


def transcribe(wav_bytes: bytes) -> dict:
    model = get_model()
    t0 = time.time()
    segments, info = model.transcribe(
        io.BytesIO(wav_bytes),
        language=None if LANG in ("", "auto") else LANG,
        beam_size=1,          # 语音助手场景：低延迟优先
        vad_filter=True,      # 过滤静音，减少幻听
        condition_on_previous_text=False,
        without_timestamps=True,
    )
    text = "".join(s.text for s in segments).strip()
    return {
        "ok": True,
        "text": text,
        "lang": getattr(info, "language", None),
        "audioSec": round(wav_duration_sec(wav_bytes), 2),
        "ms": int((time.time() - t0) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {
                "ok": True,
                "model": MODEL_NAME,
                "compute": COMPUTE,
                "loaded": _model is not None,
                "loadSec": round(_loaded_at, 1),
            })
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/asr"):
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0:
                self._json(400, {"ok": False, "error": "空请求体"})
                return
            data = self.rfile.read(length)
            print(f"[asr] 收到 {len(data)} 字节（{wav_duration_sec(data):.2f}s）", flush=True)
            result = transcribe(data)
            print(f"[asr] → {result['text']!r}  ({result['ms']}ms)", flush=True)
            self._json(200, result)
        except Exception as e:  # 任何异常都回 JSON，别让 Node 侧看到空响应
            import traceback

            traceback.print_exc()
            self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *args):  # 默认会往 stderr 刷每行访问日志，压掉
        pass


if __name__ == "__main__":
    print(f"[asr] 监听 127.0.0.1:{PORT}  模型={MODEL_NAME} 语言={LANG} 精度={COMPUTE}", flush=True)
    # 提前加载，避免第一句话等 3 秒
    try:
        get_model()
    except Exception as e:
        print(f"[asr] 预加载失败（首次请求会重试）：{e}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
