// 小智开发板对接 · 第一阶段「假后端」
//
// 目的不是做产品，是把三个未知数钉死：
//   ① 板子能不能连上我们自己的服务器（OTA + WS 握手）
//   ② 音频能不能往返（收 Opus / 回 Opus）
//   ③ **服务端主动推 TTS，板子会不会播**  ← 最关键，决定"她能不能主动说话"
//
// 所以这里故意不做 ASR / 不做 LLM：听到话就回一段测试音，让你专心判断
// "连没连上、响不响"。协议细节全部按实际情况打日志，遇到不认识的帧一律打印，
// 方便对着真机把协议补齐（我不靠猜）。
//
// 跑法：npm start   （默认 0.0.0.0:8003）

import http from 'node:http';
import { WebSocketServer } from 'ws';
import OpusScript from 'opusscript';
import os from 'node:os';

const PORT = Number(process.env.PORT || 8003);
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_MS = 60;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
const TOKEN = String(process.env.XZ_TOKEN || '').trim(); // 留空 = 不校验

// ── 日志：带时间戳，方便对时 ────────────────────────────────────────────
const t0 = Date.now();
function log(tag, ...args) {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(7);
  console.log(`[+${t}s] [${tag}]`, ...args);
}

// ── 测试音：16k 单声道正弦，编成 60ms 一包的 Opus ──────────────────────
function makeTonePackets({ freq = 660, ms = 2500 } = {}) {
  const enc = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  const total = Math.floor((SAMPLE_RATE * ms) / 1000);
  const packets = [];
  for (let off = 0; off < total; off += FRAME_SAMPLES) {
    const pcm = Buffer.alloc(FRAME_SAMPLES * CHANNELS * 2);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const n = off + i;
      // 前后各 10ms 淡入淡出，避免爆音。
      // 坑：最后一帧的 off+i 会超过 total（循环条件是 off < total），
      // 于是 (total-n) 变负 → amp 变负 → 采样值冲到 int16 范围外，
      // Buffer.writeInt16LE 直接抛 RangeError，整个进程起不来。必须 clip 到 0。
      const fadeIn = Math.max(0, Math.min(1, n / (SAMPLE_RATE * 0.01)));
      const fadeOut = Math.max(0, Math.min(1, (total - n) / (SAMPLE_RATE * 0.01)));
      const amp = 0.7 * Math.min(fadeIn, fadeOut);
      const v = Math.max(-32767, Math.min(32767,
        Math.round(Math.sin((2 * Math.PI * freq * n) / SAMPLE_RATE) * amp * 32767)));
      pcm.writeInt16LE(v, i * 2);
    }
    packets.push(enc.encode(pcm, FRAME_SAMPLES));
  }
  enc.delete();
  return packets;
}

const TONE = makeTonePackets();

// 主动推送的次数上限：验证阶段够用，避免误触发刷屏
let pushCount = 0;

// 兜底：设备不发 listen:stop 时，收够这么多包（60ms/包）就当"说完了"。
// 50 包 ≈ 3 秒；调小会更灵敏，但容易在人家还没说完时就打断。
const ENUF_FRAMES = 50;

/** 一次"回话"：先报 stt 文本，再推一段测试音。一次唤醒只回一次。 */
async function replyOnce(ws, info, reason) {
  if (!info.armed || info.answered || info.busy) return;
  info.answered = true;
  info.busy = true;
  info.armed = false; // 回完就解除武装：等下一次唤醒词，避免自问自答死循环
  log('REPLY', `开始回话（${reason}），本轮收到 ${info.turnFrames} 包`);
  try {
    sendJson(ws, { type: 'stt', text: '（实验后端：还没接 ASR，先回一段测试音）' });
    await pushTts(ws, '实验后端测试音');
  } finally {
    info.busy = false;
  }
}

// ── 连上来的设备 ──────────────────────────────────────────────────────
const devices = new Set();

function sendJson(ws, obj) {
  const s = JSON.stringify(obj);
  log('SEND', s.length > 200 ? s.slice(0, 200) + '…' : s);
  ws.send(s);
}

/** 推一段测试音（含完整的 tts start / stop 包） */
async function pushTts(ws, text = '主动推送测试') {
  sendJson(ws, { type: 'llm', emotion: 'neutral' });
  sendJson(ws, { type: 'tts', state: 'start' });
  sendJson(ws, { type: 'tts', state: 'sentence_start', text });
  for (const p of TONE) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(p);
    await new Promise((r) => setTimeout(r, FRAME_MS)); // 按实时速度发，否则设备端缓冲会乱
  }
  sendJson(ws, { type: 'tts', state: 'stop' });
  log('PUSH', `已推完 ${TONE.length} 包（约 ${((TONE.length * FRAME_MS) / 1000).toFixed(1)}s）`);
}

// ── HTTP：OTA 下发 + 调试入口 ─────────────────────────────────────────
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a && a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * 选出下发给设备的地址。
 *
 * 坑：这台 PC 同时挂着 tailscale（100.x）和一块 Windows 热点网卡（192.168.137.1），
 * 直接取「第一个非 internal 地址」会抓到 100.x —— 板子根本连不上。
 * 所以优先挑真正的家庭局域网网段；再用 PUBLIC_HOST 给一个明确覆盖。
 */
function pickHost() {
  const forced = String(process.env.PUBLIC_HOST || '').trim();
  if (forced) return forced;
  const ips = lanIps();
  const isPrivateLan = (ip) =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  // 192.168.137.x 是 Windows 移动热点，优先排到后面
  const lan = ips.filter(isPrivateLan).sort((a, b) => {
    const bad = (ip) => (ip.startsWith('192.168.137.') ? 1 : 0);
    return bad(a) - bad(b);
  });
  return lan[0] || ips[0] || '127.0.0.1';
}

/** OTA 应答：告诉设备该连哪个 WS。GET / POST 共用。 */
function sendOta(res) {
  const host = pickHost();
  const body = {
    firmware: { version: '2.5.3', url: '' },
    websocket: {
      url: `ws://${host}:${PORT}/xiaozhi/v1/`,
      token: TOKEN,
    },
    server_time: { timestamp: Date.now(), timezone_offset: 480 },
    // 注意：**不要**返回 activation 块。
    // 固件（main/ota.cc L137）只要看到 activation.code 就进激活流程 ——
    // 屏幕上顶着一串 6 位码等绑定，根本不会去连 WS。实验阶段直接跳过。
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  log('OTA', `已下发 ws://${host}:${PORT}/xiaozhi/v1/`);
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  log('HTTP', req.method, url.pathname);

  // 小智固件启动时先打这个，拿到 WS 地址
  //
  // 坑：**GET 和 POST 都要接**。固件 main/ota.cc L104 是
  //   std::string method = data.length() > 0 ? "POST" : "GET";
  // 也就是"带设备信息（Device-Id / Client-Id / 序列号）的时候用 POST"。
  // 只写 GET 会让板子拿到 404，然后无限重试、永远不连 WS —— 现场就是卡在这。
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname.startsWith('/xiaozhi/ota')) {
    // POST 的 body 里是设备自报家门，记下来便于排查
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        log('OTA', '设备上报：', raw.slice(0, 300));
        sendOta(res);
      });
      return;
    }
    sendOta(res);
    return;
  }

  // 手动触发一次"主动说话"（浏览器/curl 都行）
  if (req.method === 'POST' && url.pathname === '/test/push') {
    if (devices.size === 0) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '当前没有设备连着' }));
      return;
    }
    pushCount += 1;
    for (const ws of devices) void pushTts(ws, `主动推送 #${pushCount}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, devices: devices.size, pushCount }));
    return;
  }

  // 状态页：一眼看清连了谁、收了多少帧
  if (req.method === 'GET' && url.pathname === '/') {
    const body = {
      ok: true,
      port: PORT,
      ips: lanIps(),
      host: pickHost(),
      devices: [...devices].map((ws) => ws.__info ?? {}),
      pushCount,
      frameMs: FRAME_MS,
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

// ── WebSocket：小智协议 v1 ────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  log('WS', 'upgrade', url.pathname, 'headers=', {
    'device-id': req.headers['device-id'],
    'client-id': req.headers['client-id'],
    authorization: req.headers['authorization'] ? '有' : '无',
    'protocol-version': req.headers['protocol-version'],
  });
  if (TOKEN) {
    const auth = String(req.headers['authorization'] || '');
    if (auth !== `Bearer ${TOKEN}`) {
      log('WS', '令牌不匹配，拒绝');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const info = {
    at: new Date().toISOString(),
    deviceId: String(req.headers['device-id'] || ''),
    clientId: String(req.headers['client-id'] || ''),
    framesIn: 0,        // 累计收包（只用于日志）
    turnFrames: 0,      // 本轮聆听的收包数，每轮清零
    armed: false,       // 只有被唤醒词唤醒过才允许回话
    answered: false,    // 本轮是否已经回过
    busy: false,        // 是否正在推音频
  };
  ws.__info = info;
  ws.__audioBuf = 0;
  devices.add(ws);
  log('WS', `设备已连接（共 ${devices.size} 台）`, info.deviceId || '(无 device-id)');

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // 设备发来的 Opus 音频；逐包打日志会刷屏，只统计
      info.framesIn += 1;
      info.turnFrames += 1;
      if (info.framesIn <= 3 || info.framesIn % 50 === 0) {
        log('AUDIO-IN', `第 ${info.framesIn} 包，${data.length} 字节`);
      }
      // 兜底：设备不发 listen:stop，收够就自己判定"说完了"。
      // 注意必须用 turnFrames（本轮计数）+ armed（唤醒过），否则回完一次后
      // 累计计数仍然很大，会立刻再次触发 —— 现场就是"一直嘀嘀嘀"的死循环。
      if (info.armed && !info.answered && !info.busy && info.turnFrames >= ENUF_FRAMES) {
        void replyOnce(ws, info, `本轮收到 ${info.turnFrames} 包（约定 ${ENUF_FRAMES} 包即当作说完了）`);
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log('RECV', '非 JSON：', data.toString().slice(0, 200));
      return;
    }
    log('RECV', JSON.stringify(msg));

    // 握手
    if (msg.type === 'hello') {
      ws.__hello = msg;
      sendJson(ws, {
        type: 'hello',
        transport: 'websocket',
        session_id: `lab-${Date.now()}`,
        audio_params: {
          format: 'opus',
          sample_rate: SAMPLE_RATE,
          channels: CHANNELS,
          frame_duration: FRAME_MS,
        },
      });
      return;
    }

    // 设备开始/结束说话
    //
    // 实测发现：wake 之后设备会「listen:detect → listen:start」，然后**连续推音频，
    // 却不发 listen:stop**（mode=auto 时结束判断在设备侧，它没触发）。
    // 如果只等 stop，后端永远不回应，板子等 9 秒左右就 code=1006 断开。
    // 所以这里加兜底：收够 ENUF_FRAMES 包（约 3 秒）就当"说完了"，主动回。
    if (msg.type === 'listen') {
      if (msg.state === 'start') {
        info.turnFrames = 0;
        log('LISTEN', `开始说话（mode=${msg.mode || '?'}，armed=${info.armed}）`);
        // 没被唤醒过就进来的聆听（回话后设备自动重启监听）不允许再回话
        if (!info.armed) info.answered = true;
      } else if (msg.state === 'stop') {
        log('LISTEN', `说完了，本轮 ${info.turnFrames} 包`);
        void replyOnce(ws, info, '收到 listen:stop');
      } else if (msg.state === 'detect') {
        log('LISTEN', `唤醒词命中：${msg.text ?? ''}`);
        info.armed = true;
        info.answered = false;
        info.turnFrames = 0;
      }
      return;
    }

    if (msg.type === 'abort') {
      log('ABORT', '设备请求打断');
      return;
    }

    if (msg.type === 'mcp') {
      log('MCP', '设备侧 MCP 消息（先不处理）');
      return;
    }

    log('RECV', `未处理的类型：${msg.type}`);
  });

  ws.on('close', (code) => {
    devices.delete(ws);
    log('WS', `断开 code=${code}，剩余 ${devices.size} 台`);
  });
  ws.on('error', (e) => log('WS', '错误：', e.message));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  log('BOOT', `实验后端已启动  http://0.0.0.0:${PORT}`);
  log('BOOT', `局域网地址：${lanIps().map((ip) => `http://${ip}:${PORT}`).join('  ')}`);
  log('BOOT', 'OTA: GET /xiaozhi/ota/   主动推送: POST /test/push   状态: GET /');
});



