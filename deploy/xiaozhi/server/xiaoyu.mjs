// 「小鱼的大脑」：调 iStore 上的 SurfCore pet-api，拿她的回复 + 她的声音
//
// 为什么走 pet-api：那边已经有完整的一套 —— 人格卡 + 记忆卡拼 system prompt、
// 一次 LLM 调用出结果、对话还会写进记忆 inbox；TTS 走 voice-edge（她的音色 + 语气标记）。
// 我们这边只负责"把文字递进去、把音频接出来转成板子能播的 Opus"。
//
// 环境变量：
//   PET_BASE   pet-api 的根（默认 http://192.168.31.200:3080）
//   PET_TOKEN  桌宠令牌（读 ~/.dsh/surfcore/pet/host.json 里的 token）

import OpusScript from 'opusscript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PET_BASE = 'http://192.168.31.200:3080';

// 地址和令牌都不写进仓库：优先环境变量，其次 server/pet.env.json（已 gitignore）
const HERE = path.dirname(fileURLToPath(import.meta.url));
let cachedCfg = null;
function loadCfg() {
  if (cachedCfg) return cachedCfg;
  let token = String(process.env.PET_TOKEN || '').trim();
  let base = String(process.env.PET_BASE || '').replace(/\/$/, '');
  if (!token || !base) {
    try {
      // 去掉 BOM：PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
      // 带 BOM 的字符串 JSON.parse 会抛错 —— 现场就是这么踩的（令牌读成空）。
      const raw = fs.readFileSync(path.join(HERE, 'pet.env.json'), 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      if (!token) token = String(j.token || '').trim();
      if (!base && j.base) base = String(j.base).replace(/\/$/, '');
    } catch {}
  }
  cachedCfg = { base: base || DEFAULT_PET_BASE, token };
  return cachedCfg;
}

/** 给 server.mjs 用（主动说话要调 /events，需要 base + token） */
export function petConfig() {
  return loadCfg();
}

function petBase() {
  return loadCfg().base;
}

function petToken() {
  return loadCfg().token;
}

const OUT_RATE = 16000;      // 板子解码器按 24k 开、但发 16k 会被重采样播出来（已验证）
const FRAME_MS = 60;
const FRAME_SAMPLES = (OUT_RATE * FRAME_MS) / 1000; // 960

/**
 * 问小鱼一句话，要语音版（她的大脑 + 她的声音一起拿）。
 * @returns {{ok:boolean, text?:string, wav?:Buffer, ms?:number, error?:string}}
 */
export async function askXiaoyu(text, { timeoutMs = 45000 } = {}) {
  const token = petToken();
  if (!token) return { ok: false, error: '没配桌宠令牌（server/pet.env.json 或 PET_TOKEN）' };
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${petBase()}/dsh-surfcore/pet-api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-pet-token': token,
      },
      body: JSON.stringify({ text, modality: 'voice' }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    const reply = data.reply ?? {};
    const out = { ok: true, text: String(reply.text ?? ''), ms: Date.now() - t0, wav: null };

    // 有音频就把 WAV 拉回来（URL 带 token，直接请求即可）
    const audioUrl = reply.audio?.url;
    if (audioUrl) {
      const abs = audioUrl.startsWith('http') ? audioUrl : `${petBase()}${audioUrl}`;
      const a = await fetch(abs, { signal: controller.signal });
      if (a.ok) out.wav = Buffer.from(await a.arrayBuffer());
      else out.audioError = `音频 HTTP ${a.status}`;
    }
    return out;
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── WAV → Opus（板子要 60ms 一包、16k 单声道）────────────────────────

/** 解析 WAV，返回 {sampleRate, channels, bits, pcm:Buffer}。只处理 PCM。 */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('不是 WAV');
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    off += 8 + size + (size % 2); // chunk 按偶数字节对齐
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt/data 块');
  if (fmt.format !== 1) throw new Error(`不支持的 WAV 编码 ${fmt.format}（只处理 PCM）`);
  return { ...fmt, pcm: data };
}

/** 24k→16k 这类整数/非整数倍降采样：线性插值，够用且无依赖。 */
export function resamplePcm(pcm, from, to, channels = 1) {
  if (from === to) return pcm;
  const framesIn = Math.floor(pcm.length / 2 / channels);
  const framesOut = Math.floor((framesIn * to) / from);
  const out = Buffer.alloc(framesOut * 2);
  for (let i = 0; i < framesOut; i += 1) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, framesIn - 1);
    const frac = pos - i0;
    const s0 = pcm.readInt16LE(i0 * 2 * channels);
    const s1 = pcm.readInt16LE(i1 * 2 * channels);
    const v = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

/** 多声道取第一声道（板子是单声道） */
export function toMono(pcm, channels) {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / 2 / channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    out.writeInt16LE(pcm.readInt16LE(i * 2 * channels), i * 2);
  }
  return out;
}

/** WAV 字节 → 一包一包的 Opus（16k / 60ms） */
export function wavToOpusPackets(wav) {
  const { sampleRate, channels, pcm } = parseWav(wav);
  const mono = toMono(pcm, channels);
  const pcm16k = resamplePcm(mono, sampleRate, OUT_RATE, 1);

  const enc = new OpusScript(OUT_RATE, 1, OpusScript.Application.VOIP);
  const packets = [];
  try {
    for (let off = 0; off + FRAME_SAMPLES * 2 <= pcm16k.length; off += FRAME_SAMPLES * 2) {
      const frame = Buffer.alloc(FRAME_SAMPLES * 2);
      pcm16k.copy(frame, 0, off, off + FRAME_SAMPLES * 2);
      packets.push(enc.encode(frame, FRAME_SAMPLES));
    }
    // 尾巴不足一帧：补静音凑齐，避免最后一个字被切掉
    const rest = pcm16k.length % (FRAME_SAMPLES * 2);
    if (rest > 0) {
      const frame = Buffer.alloc(FRAME_SAMPLES * 2);
      pcm16k.copy(frame, 0, pcm16k.length - rest);
      packets.push(enc.encode(frame, FRAME_SAMPLES));
    }
  } finally {
    enc.delete();
  }
  return packets;
}


