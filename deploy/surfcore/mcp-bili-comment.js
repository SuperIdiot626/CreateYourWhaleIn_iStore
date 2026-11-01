// B站评论区 · 点赞（独立 MCP server）
//
// 为什么单独做一个 MCP，而不是往 dsh-bili-scroll 插件里加：
//   · 插件在 profiles/web/node_modules 下，任何 npm/pnpm 重装都会冲掉；
//   · SurfCore 自己已经有 mcp-qzone.js / mcp-host-server.js 这种独立 MCP 的先例；
//   · 点赞是「写」但可逆（取消点赞即还原），边界小，适合单独一个 server 便于审计。
//
// 凭据来源：/root/.dsh/surfcore/bili/credentials.json（与 bili.mjs 同一份，600 权限）
//   { sessdata, bili_jct, buvid3 }
//
// 接口：POST https://api.bilibili.com/x/v2/reply/action
//   oid=<aid>&type=1&rpid=<rpid>&action=1|0&csrf=<bili_jct>
//
// 边界：
//   · 只做「点赞 / 取消点赞」，不做评论、不做私信、不改配置；
//   · 自带每日上限与最小间隔，防被模型连点（B站 对点赞也有风控）；
//   · 不写日志正文里的凭据，不回显 cookie。

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BILI_DIR = '/root/.dsh/surfcore/bili';
const CRED_FILE = `${BILI_DIR}/credentials.json`;
const CFG_FILE = '/root/.dsh/surfcore/bili.config.json';
const STATE_FILE = `${BILI_DIR}/comment-like.json`;

// 风控/限额参数（可从环境变量覆盖，便于临时调）
const MAX_PER_DAY = Number(process.env.BILI_COMMENT_LIKE_MAX_PER_DAY || 30);
const MIN_GAP_MS = Number(process.env.BILI_COMMENT_LIKE_MIN_GAP_MS || 2000);
// B站 明显是风控/未登录的错误码
const RISK_CODES = new Set([-509, -101, -111, 12015, 12035, 12051, 12011]);

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function loadAccount() {
  const cred = readJson(CRED_FILE, {}) ?? {};
  const cfg = readJson(CFG_FILE, {}) ?? {};
  const sessdata = String(cred.sessdata ?? '').trim();
  const biliJct = String(cred.bili_jct ?? '').trim();
  const buvid3 = String(cred.buvid3 ?? '').trim();
  const mid = String(cfg?.self?.mid ?? cred.dedeuserid ?? '').trim();
  return { sessdata, biliJct, buvid3, mid, hasCred: Boolean(sessdata && biliJct) };
}

function headersFor(account, bvid = '') {
  const cookie = [
    `SESSDATA=${account.sessdata}`,
    `bili_jct=${account.biliJct}`,
    account.buvid3 ? `buvid3=${account.buvid3}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return {
    'user-agent': UA,
    cookie,
    origin: 'https://www.bilibili.com',
    referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
  };
}

/** 北京时间（UTC+8）日期，用来切"每一天"的额度。 */
function dayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function loadState() {
  const s = readJson(STATE_FILE, {}) ?? {};
  const today = dayKey();
  return {
    day: s.day === today ? today : today,
    count: s.day === today ? Number(s.count ?? 0) || 0 : 0,
    lastAt: Number(s.lastAt ?? 0) || 0,
    blockedUntil: Number(s.blockedUntil ?? 0) || 0,
  };
}

function saveState(state) {
  try {
    fs.mkdirSync(BILI_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, day: dayKey() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // 状态落盘失败不该影响主流程
  }
}

async function aidFromBvid(bvid, account) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid ?? ''))) throw new Error('BV 号格式不对');
  const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: headersFor(account, bvid),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  if (json?.code !== 0 || !json?.data?.aid) {
    throw new Error(`解析 aid 失败：code=${json?.code ?? '?'} ${json?.message ?? ''}`);
  }
  return String(json.data.aid);
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer({ name: 'bili-comment', version: '0.1.0' });

server.tool(
  'comment_like',
  [
    '给 B站视频评论区的一条评论点赞（status=false 则取消点赞）。',
    '需要 rpid：先调用 bili_comments 看评论列表，每条里带 rpid。',
    '只支持视频评论区（type=1）。可逆：取消点赞即还原。',
    '有每日上限与最小间隔，超了会直接拒绝而不是偷偷失败。',
  ].join(''),
  {
    rpid: z.number().int().positive().describe('要点赞的评论 rpid（来自 bili_comments）'),
    bvid: z.string().optional().describe('视频 BV 号，例如 BV1KYxi6mEx5（给了 bvid 就不用给 oid）'),
    oid: z.number().int().positive().optional().describe('视频 aid；没有 bvid 时用它'),
    status: z.boolean().optional().describe('true=点赞（默认），false=取消点赞'),
  },
  async ({ rpid, bvid, oid, status }) => {
    const account = loadAccount();
    if (!account.hasCred) {
      return textResult({
        ok: false,
        error: '没有 B站凭据：/root/.dsh/surfcore/bili/credentials.json 缺少 sessdata/bili_jct',
      });
    }

    const like = status !== false;
    const state = loadState();
    const now = Date.now();

    if (state.blockedUntil > now) {
      return textResult({
        ok: false,
        error: `点赞风控冷却中，约 ${Math.ceil((state.blockedUntil - now) / 60000)} 分钟后可再试`,
        blockedUntil: new Date(state.blockedUntil).toISOString(),
      });
    }
    if (like) {
      if (state.count >= MAX_PER_DAY) {
        return textResult({ ok: false, error: `今天点赞额度已用完（${MAX_PER_DAY} 条）`, used: state.count, limit: MAX_PER_DAY });
      }
      if (state.lastAt && now - state.lastAt < MIN_GAP_MS) {
        return textResult({
          ok: false,
          error: `连着点太快了，至少间隔 ${Math.round(MIN_GAP_MS / 1000)} 秒`,
          retryAfterMs: MIN_GAP_MS - (now - state.lastAt),
        });
      }
    }

    let aid = oid ? String(oid) : '';
    try {
      if (!aid) {
        if (!bvid) return textResult({ ok: false, error: '需要 bvid 或 oid 来定位视频' });
        aid = await aidFromBvid(bvid, account);
      }
    } catch (error) {
      return textResult({ ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }

    const body = new URLSearchParams({
      oid: aid,
      type: '1',
      rpid: String(rpid),
      action: like ? '1' : '0',
      csrf: account.biliJct,
    });

    let json = {};
    try {
      const res = await fetch('https://api.bilibili.com/x/v2/reply/action', {
        method: 'POST',
        headers: { ...headersFor(account, bvid || ''), 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });
      json = await res.json().catch(() => ({}));
    } catch (error) {
      return textResult({ ok: false, error: `请求失败：${String(error?.message ?? error).slice(0, 200)}` });
    }

    const code = Number(json?.code ?? NaN);
    const ok = code === 0;

    if (like && ok) {
      state.count += 1;
      state.lastAt = now;
    }
    if (!ok && RISK_CODES.has(code)) {
      // 撞风控就歇半小时，别继续戳
      state.blockedUntil = now + 30 * 60 * 1000;
    }
    saveState(state);

    return textResult({
      ok,
      action: like ? 'like' : 'unlike',
      rpid: String(rpid),
      oid: aid,
      bvid: bvid || '',
      code: Number.isFinite(code) ? code : null,
      message: String(json?.message ?? ''),
      ...(ok ? {} : { hint: RISK_CODES.has(code) ? '疑似触发 B站 风控/登录失效，已冷却 30 分钟' : '接口返回失败，详见 code/message' }),
      todayLikes: state.count,
      dailyLimit: MAX_PER_DAY,
    });
  },
);

await server.connect(new StdioServerTransport());
