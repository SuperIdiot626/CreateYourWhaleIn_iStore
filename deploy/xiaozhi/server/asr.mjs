// 音频 → 文字：Opus 解码、端点检测（VAD）、调本地 ASR 服务
//
// 为什么需要自己判"说完了"：实测这版固件在 mode=auto 下**不发 listen:stop**，
// 结束判断得由服务端做。早期的做法是"收够 50 包（3 秒）就当成说完"，
// 那会把人还没说完的话截断，也会被环境噪声反复触发。这里改成能量 VAD：
//   有过一段人声 → 之后安静够久 → 判定这一句说完。

import OpusScript from 'opusscript';

const SAMPLE_RATE = 16000;

// ── 端点检测参数（60ms 一帧）─────────────────────────────────────────
const FRAME_MS = 60;
const MIN_SPEECH_FRAMES = 4;     // 至少 240ms 人声才算开口，过滤咳嗽/碰撞
const END_SILENCE_FRAMES = 10;   // 之后连续 600ms 安静 = 说完了
const MAX_UTTERANCE_FRAMES = 350; // 20.9s 强制截断，避免一直录下去
const PREROLL_FRAMES = 4;        // 把开口前 240ms 也带上，免得吞掉第一个字
const ABS_THRESHOLD = 260;       // 绝对能量下限（16bit RMS）

/** 一句完整的话：PCM + 统计信息 */
export class Utterance {
  constructor(pcm, meta) {
    this.pcm = pcm;
    this.meta = meta;
  }
  get wav() {
    return pcmToWav(this.pcm, SAMPLE_RATE);
  }
}

/**
 * 逐帧喂进来的端点检测器。
 * 用法：detector.push(pcmBuffer) 返回 Utterance 或 null。
 */
export class UtteranceDetector {
  constructor() {
    this.reset();
    // 噪声基线：跑得越久越准，用它自动抬阈值（风扇、空调底噪）
    this.noiseFloor = 200;
  }

  reset() {
    this.frames = [];        // 本轮已缓存的帧（含 preroll）
    this.totalFrames = 0;
    this.speechSeen = false;
    this.speechFrames = 0;
    this.silenceRun = 0;
    this.preroll = [];
  }

  /** 返回这一帧的 RMS（16bit 采样） */
  static rms(pcm) {
    let sum = 0;
    const n = pcm.length >> 1;
    if (n === 0) return 0;
    for (let i = 0; i < n; i += 1) {
      const s = pcm.readInt16LE(i * 2);
      sum += s * s;
    }
    return Math.sqrt(sum / n);
  }

  /**
   * 喂一帧 PCM（16bit 单声道 16k，960 样本 = 60ms）。
   * @returns {Utterance|null} 一句说完时返回整句
   */
  push(pcm) {
    const level = UtteranceDetector.rms(pcm);
    this.totalFrames += 1;

    // 只在安静时更新底噪，避免把人声算进基线
    if (!this.speechSeen) {
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
    }
    const threshold = Math.max(ABS_THRESHOLD, this.noiseFloor * 3.0);
    const voiced = level > threshold;

    if (voiced) {
      this.speechFrames += 1;
      this.silenceRun = 0;
      if (!this.speechSeen && this.speechFrames >= MIN_SPEECH_FRAMES) {
        this.speechSeen = true;
        // 把开口前的 preroll 拼上
        this.frames = [...this.preroll, ...this.frames];
        this.preroll = [];
      }
    } else {
      this.silenceRun += 1;
      if (!this.speechSeen) {
        this.speechFrames = 0; // 零散噪声不算开口
      }
    }

    if (this.speechSeen) {
      this.frames.push(pcm);
      const done =
        this.silenceRun >= END_SILENCE_FRAMES ||
        this.frames.length >= MAX_UTTERANCE_FRAMES;
      if (done) return this.finish('vad-end');
      return null;
    }

    // 还没开口：维护 preroll 环形缓冲
    this.preroll.push(pcm);
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    // 长时间没人说话就整体丢弃，别让内存涨
    if (this.totalFrames > 2000) {
      this.preroll = [];
      this.totalFrames = 0;
    }
    return null;
  }

  finish(reason) {
    const pcm = Buffer.concat(this.frames);
    const meta = {
      reason,
      frames: this.frames.length,
      ms: this.frames.length * FRAME_MS,
      noiseFloor: Math.round(this.noiseFloor),
    };
    this.reset();
    return new Utterance(pcm, meta);
  }

  /** 强制收尾（比如收到 listen:stop） */
  flush(reason = 'forced') {
    if (!this.speechSeen || this.frames.length === 0) {
      this.reset();
      return null;
    }
    return this.finish(reason);
  }
}

/** 包一层 44 字节 WAV 头（16bit 单声道） */
export function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM 块大小
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // 字节率
  header.writeUInt16LE(2, 32);         // 块对齐
  header.writeUInt16LE(16, 34);        // 位深
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 每路连接一个 Opus 解码器 */
export function createDecoder() {
  return new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
}

export function decodeFrame(decoder, packet) {
  try {
    return decoder.decode(packet);
  } catch {
    return null; // 坏包直接丢，别让整条链路崩
  }
}

/** 调本地 ASR 服务，把一句 WAV 换成文字 */
export async function transcribe(wav, { port = 8004, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
