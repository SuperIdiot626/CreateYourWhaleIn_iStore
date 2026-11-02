// 「从板子上说话」· 独立 MCP server
//
// 需求来由：主人在 QQ 跟她聊，但房间的 ESP32 板子上还有一只"同一个她"。
// QQ 侧的她原本**不知道板子存在** —— 没有提示词、也没有工具，所以永远不会主动从那说话。
// 这个 server 就是那个"出口"：给她一个 board_say(text) 的工具。
//
// 链路（为什么这么绕）：
//   这个工具跑在 iStore 上，voice-edge 只监听容器回环、不对外；
//   PC 端的板子后端够不到 voice-edge。
//   所以由**这边**合成语音（voice-edge 是本机），再把 WAV 推到 PC 的 /speak 播放。
//
//        工具 ──(本地)──> voice-edge 8765 ──WAV──> PC 192.168.31.119:8003/speak ──Opus──> 板子
//
// 板子空闲时是断开的（固件只在对话时连服务器），所以 PC 侧会**排队**：
// 主人下次喊「你好小智」时，把积压的那句放出来。
//
// 配置：/root/.dsh/surfcore/board.json  {"base": "http://192.168.31.119:8003"}
//   改 PC 地址只改这个文件，不用动代码（没有就退回默认值）。

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CFG_FILE = '/root/.dsh/surfcore/board.json';
const DEFAULT_BASE = 'http://192.168.31.119:8003';
const VOICE_EDGE = process.env.VOICE_EDGE_URL || 'http://127.0.0.1:8765';
const VOICE_ID = process.env.BOARD_VOICE || ''; // 留空 = voice-edge 用自己的默认音色（就是她的）
const SAMPLE_RATE = 24000;

function boardBase() {
  try {
    const raw = fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return String(j.base || DEFAULT_BASE).replace(/\/$/, '');
  } catch {
    return DEFAULT_BASE;
  }
}

/** 裸 PCM（audio/L16，24k 单声道 16bit）包一层 WAV 头 */
function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 调本机 voice-edge 合成一段语音，返回 WAV */
async function synthesize(text, timeoutMs = 20000) {
  const body = { text };
  if (VOICE_ID) body.voice = VOICE_ID;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${VOICE_EDGE}/v1/speak/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`voice-edge HTTP ${res.status}`);
    const pcm = Buffer.from(await res.arrayBuffer());
    if (!pcm.length) throw new Error('voice-edge 返回空音频');
    return pcmToWav(pcm);
  } finally {
    clearTimeout(timer);
  }
}

const server = new McpServer({ name: 'board', version: '0.1.0' });

server.tool(
  'board_say',
  '让房间里那块 ESP32 板子用你的声音说一句话（同一只鱼的另一个出口）。' +
    '只在主人就在房间里、或者有件事值得"当面"说的时候用；' +
    '不要把你已经在 QQ 里说过的话重复念一遍，也不要在深夜/主人可能睡着时用。' +
    '板子离线时这条话会被存起来，主人下次喊醒它时播出来。',
  {
    text: z.string().min(1).max(200).describe('要说的话，口语短句，最好 40 字以内'),
  },
  async ({ text }) => {
    const say = String(text).trim().slice(0, 200);
    try {
      const wav = await synthesize(say);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let data = {};
      try {
        const res = await fetch(`${boardBase()}/speak`, {
          method: 'POST',
          headers: {
            'content-type': 'audio/wav',
            'x-speak-text': encodeURIComponent(say).slice(0, 180),
          },
          body: wav,
          signal: controller.signal,
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
      if (data.poweredOff) {
        return { content: [{ type: 'text', text: '板子的总开关是关着的，这句没播（也没排队）。' }] };
      }
      const tip = data.played
        ? '已经让板子说出来了。'
        : `板子现在没连上，这句先存着（队列 ${data.queued ?? 1} 条），主人下次喊醒它会播。`;
      return { content: [{ type: 'text', text: `${tip}\n播放内容：「${say}」` }] };
    } catch (e) {
      const base = boardBase();
      // PC 关机 / 换 IP 都会走到这里 —— 要说清楚是"板子那边不可达"，不是她做错了
      return {
        content: [{
          type: 'text',
          text: `板子那边没连上（${base}）：${e.message}。可能主人电脑没开或换了 IP，这句没送出去。`,
        }],
      };
    }
  },
);

server.tool(
  'board_status',
  '查一下房间里那块板子现在在不在线、有没有积压没播的话。不确定要不要用 board_say 时可以先查。',
  {},
  async () => {
    try {
      const res = await fetch(`${boardBase()}/status`, { signal: AbortSignal.timeout(6000) });
      const j = await res.json();
      return {
        content: [{
          type: 'text',
          text: `板子：${j.devices > 0 ? '在线' : '不在线'}` +
            `，总开关${j.poweredOn ? '开着' : '关着'}` +
            `，积压 ${j.speakQueue ?? 0} 条。`,
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `板子那边不可达：${e.message}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
