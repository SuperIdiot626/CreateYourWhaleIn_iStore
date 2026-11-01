/**
 * 把 QQ 收到的图片/动图/表情包归一化成「模型能看的几张小 JPEG」。
 *
 * 为什么需要：
 *   1. QQ 的动图表情动辄 >8MB，桥接原来的媒体上限是 8MB，直接取不到
 *      （2026-11-01 实测：`图片超过大小限制（8388608 字节）`）；
 *   2. 就算取到了，模型能看到的也只是**一帧**——动图在视觉模型眼里永远是静止的，
 *      所以"她看不出这个动作"其实是模型侧的固有限制，不是她笨；
 *   3. 原始 GIF/WebP 像素大、字节大，base64 塞进上下文很贵。
 *
 * 做法：用 ffmpeg/ffprobe 探一下是不是动图；动图等距抽 N 帧、静态图缩一张，
 * 统一编码成小 JPEG（长边 ≤ 960、单张 ≤ 900KB），再交给上层当多张图片附件。
 *
 * 这个模块不做网络、不读配置，纯字节进字节出，方便单测。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

export const DEFAULT_MAX_SIDE = 960;
export const DEFAULT_MAX_FRAMES = 3;
export const DEFAULT_MAX_BYTES_PER_FRAME = 900 * 1024;

function tmpPath(suffix) {
  return path.join(
    os.tmpdir(),
    `media-norm-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${suffix}`,
  );
}

function sniffExt(buf) {
  if (!buf || buf.length < 12) return 'bin';
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.slice(0, 6).toString('latin1') === 'GIF87a' || b.slice(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'bin';
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  return '';
}

function rmQuiet(p) {
  try {
    fs.rmSync(p, { force: true, recursive: true });
  } catch {}
}

function probe(src) {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=nb_frames,width,height', '-of', 'json', src],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const j = JSON.parse(out || '{}');
    const stream = (j.streams || [])[0] || {};
    const fmt = (j.format || {}) || {};
    return {
      formatName: String(fmt.format_name || ''),
      duration: Number(fmt.duration) || 0,
      frames: Number(stream.nb_frames) || 0,
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
    };
  } catch {
    return { formatName: '', duration: 0, frames: 0, width: 0, height: 0 };
  }
}

function runFfmpeg(args) {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { timeout: 30000, stdio: ['ignore', 'ignore', 'pipe'] });
}

function encodeStill(src, dst, maxSide) {
  runFfmpeg([
    '-i', src,
    '-vf', `scale='min(${maxSide}\\,iw)':-2:flags=lanczos`,
    '-frames:v', '1',
    '-q:v', '4',
    dst,
  ]);
}

function encodeAnimatedFrames(src, outDir, count, maxSide, duration) {
  const fps = Math.max(0.1, count / Math.max(0.4, duration || 2));
  runFfmpeg([
    '-i', src,
    '-vf', `fps=${fps.toFixed(3)},scale='min(${maxSide}\\,iw)':-2:flags=lanczos`,
    '-frames:v', String(count),
    '-q:v', '4',
    path.join(outDir, 'f%02d.jpg'),
  ]);
  return fs
    .readdirSync(outDir)
    .filter((f) => /^f\d+\.jpg$/i.test(f))
    .sort()
    .map((f) => path.join(outDir, f));
}

/**
 * @param {{buffer: Buffer, mimeType?: string, maxSide?: number, maxFrames?: number,
 *          maxBytesPerFrame?: number}} input
 * @returns {{frames: Array<{buffer: Buffer, mediaType: string}>, animated: boolean,
 *            note: string, source: {format: string, frames: number, duration: number}}}
 */
export function normalizeImageForAgent({
  buffer,
  mimeType = '',
  maxSide = DEFAULT_MAX_SIDE,
  maxFrames = DEFAULT_MAX_FRAMES,
  maxBytesPerFrame = DEFAULT_MAX_BYTES_PER_FRAME,
} = {}) {
  const empty = { frames: [], animated: false, note: '', source: { format: '', frames: 0, duration: 0 } };
  if (!buffer || !buffer.length) return empty;

  const ext = extFromMime(mimeType) || sniffExt(buffer);
  const src = tmpPath(ext);
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frames-'));
  try {
    fs.writeFileSync(src, buffer);
    const meta = probe(src);
    const isAnim = /gif|webp|apng/.test(meta.formatName) && (meta.frames > 1 || meta.duration > 0.3);
    const source = { format: meta.formatName || ext, frames: meta.frames, duration: meta.duration };

    let files = [];
    if (isAnim) {
      try {
        files = encodeAnimatedFrames(src, frameDir, Math.max(2, Math.min(maxFrames, 6)), maxSide, meta.duration);
      } catch {
        files = [];
      }
    }
    if (!files.length) {
      const still = path.join(frameDir, 'still.jpg');
      try {
        encodeStill(src, still, maxSide);
        files = [still];
      } catch {
        return { ...empty, source };
      }
    }

    const frames = [];
    for (const f of files) {
      let buf = fs.readFileSync(f);
      // 单帧还是太大就再缩一档（极少见：超长竖图）
      if (buf.length > maxBytesPerFrame) {
        const smaller = path.join(frameDir, `small-${path.basename(f)}`);
        try {
          encodeStill(f, smaller, Math.max(320, Math.round(maxSide * 0.6)));
          buf = fs.readFileSync(smaller);
        } catch {}
      }
      if (buf.length) frames.push({ buffer: buf, mediaType: 'image/jpeg' });
    }

    const animated = isAnim && frames.length > 1;
    const note = animated
      ? `[动图，已抽 ${frames.length} 帧，按顺序看]`
      : '';
    return { frames, animated, note, source };
  } catch {
    return empty;
  } finally {
    rmQuiet(src);
    rmQuiet(frameDir);
  }
}

export default { normalizeImageForAgent };
