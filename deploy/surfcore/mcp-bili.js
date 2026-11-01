// B站互动 · 独立 MCP server（点赞视频 / 收藏视频 / 点赞评论 / 看评论回复）
//
// 为什么独立做，而不是往插件里加：
//   · `dsh-bili-scroll` 在 profiles/web/node_modules 下，重装即失效；
//   · 它的 Python 服务端 `/root/.dsh/bili-duty/mcp_server.py` 每次挂载都会被
//     `state.mjs` 从 `vendor/bilibili-mcp/mcp_server.py` 覆盖，改它等于白改；
//   · SurfCore 自己已有 mcp-qzone.js 等独立 MCP 的先例。
//
// 凭据：/root/.dsh/surfcore/bili/credentials.json（与 bili.mjs 同一份，600）
//
// 边界（写死在代码里）：
//   · 只做「点赞 / 收藏 / 读评论」，不做发评论、不发私信、不投币、不改配置；
//   · 发评论仍走插件的 bili_reply（那边有语感闸和判重表，别绕过）；
//   · 每个动作都有每日上限和最小间隔，撞风控自动冷却，超限明确报错而不是静默失败。
//
// 接口（都是从 surfcore tools 里核对过的）：
//   视频点赞   POST /x/web-interface/archive/like   {aid, like: 1 点赞 / 2 取消}
//   视频收藏   POST /x/v3/fav/resource/deal          {rid=aid, type=2, add_media_ids, del_media_ids}
//   收藏夹列表 GET  /x/v3/fav/folder/created/list-all?up_mid=<mid>
//   评论点赞   POST /x/v2/reply/action                {oid, type=1, rpid, action: 1/0}
//   楼中楼     GET  /x/v2/reply/reply?type=1&oid=&root=&ps=&pn=
//   回复我的   GET  /x/msgfeed/reply?platform=web&build=0&mobi_app=web&cursor=

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BILI_DIR = '/root/.dsh/surfcore/bili';
const CRED_FILE = `${BILI_DIR}/credentials.json`;
const CFG_FILE = '/root/.dsh/surfcore/bili.config.json';
const STATE_FILE = `${BILI_DIR}/action-state.json`;

// 每个动作的刹车
const LIMITS = {
  commentLike: {
    perDay: Number(process.env.BILI_COMMENT_LIKE_MAX_PER_DAY || 30),
    minGapMs: Number(process.env.BILI_COMMENT_LIKE_MIN_GAP_MS || 2000),
  },
  videoLike: { perDay: Number(process.env.BILI_VIDEO_LIKE_MAX_PER_DAY || 30), minGapMs: 2000 },
  favAdd: { perDay: Number(process.env.BILI_FAV_MAX_PER_DAY || 3), minGapMs: 3000 },
};
// B站 明显的风控/未登录码
const RISK_CODES = new Set([-509, -101, -111, -400, 12015, 12035, 12051, 12011]);
const COOLDOWN_MS = 30 * 60 * 1000;

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

function headersFor(account, referer = 'https://www.bilibili.com/') {
  const cookie = [
    `SESSDATA=${account.sessdata}`,
    `bili_jct=${account.biliJct}`,
    account.buvid3 ? `buvid3=${account.buvid3}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return { 'user-agent': UA, cookie, referer, origin: 'https://www.bilibili.com' };
}

function dayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function loadState() {
  const raw = readJson(STATE_FILE, {}) ?? {};
  const today = dayKey();
  const actions = {};
  for (const key of Object.keys(LIMITS)) {
    const prev = raw.day === today ? raw.actions?.[key] ?? {} : {};
    actions[key] = { count: Number(prev.count ?? 0) || 0, lastAt: Number(prev.lastAt ?? 0) || 0 };
  }
  const blockedUntil = raw.day === today ? raw.blockedUntil ?? {} : {};
  return { day: today, actions, blockedUntil };
}

function saveState(state) {
  try {
    fs.mkdirSync(BILI_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, day: dayKey() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // 落盘失败不影响主流程
  }
}

/** 检查额度与节奏，返回 null 表示放行，否则返回拒绝说明。 */
function checkBudget(state, key, write = true) {
  if (!write) return null;
  const limit = LIMITS[key];
  const slot = state.actions[key];
  const now = Date.now();
  const blocked = Number(state.blockedUntil?.[key] ?? 0) || 0;
  if (blocked > now) {
    return { reason: `冷却中，约 ${Math.ceil((blocked - now) / 60000)} 分钟后可再试`, blockedUntil: new Date(blocked).toISOString() };
  }
  if (slot.count >= limit.perDay) {
    return { reason: `今天的额度已用完（${limit.perDay} 次）`, used: slot.count, limit: limit.perDay };
  }
  if (slot.lastAt && now - slot.lastAt < limit.minGapMs) {
    return { reason: `操作太频繁，至少间隔 ${Math.round(limit.minGapMs / 1000)} 秒`, retryAfterMs: limit.minGapMs - (now - slot.lastAt) };
  }
  return null;
}

function spend(state, key, ok) {
  if (ok) {
    state.actions[key].count += 1;
    state.actions[key].lastAt = Date.now();
  }
}

function penalize(state, key, code) {
  if (RISK_CODES.has(Number(code))) {
    state.blockedUntil[key] = Date.now() + COOLDOWN_MS;
    return true;
  }
  return false;
}

async function callJson(url, { account, referer, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...headersFor(account, referer),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: body.toString() } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return res.json().catch(() => ({}));
}

async function resolveAid(account, { bvid, oid }) {
  if (oid) return { aid: String(oid), bvid: bvid || '', title: '' };
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid ?? ''))) throw new Error('需要合法的 bvid 或 oid');
  const j = await callJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    account,
    referer: `https://www.bilibili.com/video/${bvid}/`,
  });
  if (j?.code !== 0 || !j?.data?.aid) throw new Error(`解析 aid 失败：code=${j?.code ?? '?'} ${j?.message ?? ''}`);
  return { aid: String(j.data.aid), bvid, title: String(j.data.title ?? '') };
}

async function listFavFolders(account) {
  const j = await callJson(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(account.mid)}`,
    { account },
  );
  if (j?.code !== 0) throw new Error(`读取收藏夹失败：code=${j?.code ?? '?'} ${j?.message ?? ''}`);
  return (j?.data?.list ?? []).map((f) => ({ id: String(f.id), title: String(f.title ?? ''), count: Number(f.media_count ?? 0) }));
}

function pickFolder(folders, wanted) {
  if (!folders.length) throw new Error('这个号没有任何收藏夹');
  if (wanted) {
    const w = String(wanted).trim();
    const hit = folders.find((f) => f.id === w) || folders.find((f) => f.title === w) || folders.find((f) => f.title.includes(w));
    if (!hit) throw new Error(`没有名为「${w}」的收藏夹；现有：${folders.map((f) => f.title).join('、')}`);
    return hit;
  }
  return folders.find((f) => f.title.includes('默认')) ?? folders[0];
}

const textResult = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });

const server = new McpServer({ name: 'bili', version: '0.2.0' });

// ── 评论点赞 ────────────────────────────────────────────────────────────────
server.tool(
  'comment_like',
  '给 B站视频评论区的一条评论点赞（status=false 取消点赞）。rpid 先用 bili_comments 拿到。只支持视频评论区。可逆。',
  {
    rpid: z.number().int().positive().describe('评论 rpid（来自 bili_comments）'),
    bvid: z.string().optional().describe('视频 BV 号；给了就不用给 oid'),
    oid: z.number().int().positive().optional().describe('视频 aid'),
    status: z.boolean().optional().describe('true=点赞（默认），false=取消'),
  },
  async ({ rpid, bvid, oid, status }) => {
    const account = loadAccount();
    if (!account.hasCred) return textResult({ ok: false, error: '没有 B站凭据（缺失 sessdata/bili_jct）' });
    const like = status !== false;
    const state = loadState();
    const denied = checkBudget(state, 'commentLike', like);
    if (denied) return textResult({ ok: false, error: denied.reason, ...denied });

    let aid = String(oid ?? '');
    try {
      if (!aid) aid = (await resolveAid(account, { bvid })).aid;
    } catch (error) {
      return textResult({ ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }

    let json = {};
    try {
      json = await callJson('https://api.bilibili.com/x/v2/reply/action', {
        account,
        referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
        method: 'POST',
        body: new URLSearchParams({ oid: aid, type: '1', rpid: String(rpid), action: like ? '1' : '0', csrf: account.biliJct }),
      });
    } catch (error) {
      return textResult({ ok: false, error: `请求失败：${String(error?.message ?? error).slice(0, 200)}` });
    }
    const ok = Number(json?.code) === 0;
    spend(state, 'commentLike', ok && like);
    const cooldown = penalize(state, 'commentLike', json?.code);
    saveState(state);
    return textResult({
      ok,
      action: like ? 'like' : 'unlike',
      scope: 'comment',
      rpid: String(rpid),
      oid: aid,
      code: Number.isFinite(Number(json?.code)) ? Number(json.code) : null,
      message: String(json?.message ?? ''),
      ...(cooldown ? { hint: '疑似风控，已冷却 30 分钟' } : {}),
      todayCount: state.actions.commentLike.count,
      dailyLimit: LIMITS.commentLike.perDay,
    });
  },
);

// ── 视频点赞 ────────────────────────────────────────────────────────────────
server.tool(
  'video_like',
  '给一个 B站视频点赞（status=false 取消点赞）。注意接口的取消值是 2，本工具已处理好，你只需要传 true/false。',
  {
    bvid: z.string().optional().describe('视频 BV 号，如 BV1KYxi6mEx5'),
    oid: z.number().int().positive().optional().describe('视频 aid（没有 bvid 时用）'),
    status: z.boolean().optional().describe('true=点赞（默认），false=取消'),
  },
  async ({ bvid, oid, status }) => {
    const account = loadAccount();
    if (!account.hasCred) return textResult({ ok: false, error: '没有 B站凭据（缺失 sessdata/bili_jct）' });
    const like = status !== false;
    const state = loadState();
    const denied = checkBudget(state, 'videoLike', like);
    if (denied) return textResult({ ok: false, error: denied.reason, ...denied });

    let info;
    try {
      info = await resolveAid(account, { bvid, oid });
    } catch (error) {
      return textResult({ ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }

    let json = {};
    try {
      json = await callJson('https://api.bilibili.com/x/web-interface/archive/like', {
        account,
        referer: `https://www.bilibili.com/video/${info.bvid || bvid || ''}/`,
        method: 'POST',
        // ⚠️ 取消点赞是 like=2（不是 0），这是最容易写错的一处
        body: new URLSearchParams({ aid: info.aid, like: like ? '1' : '2', csrf: account.biliJct }),
      });
    } catch (error) {
      return textResult({ ok: false, error: `请求失败：${String(error?.message ?? error).slice(0, 200)}` });
    }
    const ok = Number(json?.code) === 0;
    spend(state, 'videoLike', ok && like);
    const cooldown = penalize(state, 'videoLike', json?.code);
    saveState(state);
    return textResult({
      ok,
      action: like ? 'like' : 'unlike',
      scope: 'video',
      bvid: info.bvid || bvid || '',
      oid: info.aid,
      title: info.title,
      code: Number.isFinite(Number(json?.code)) ? Number(json.code) : null,
      message: String(json?.message ?? ''),
      ...(cooldown ? { hint: '疑似风控，已冷却 30 分钟' } : {}),
      todayCount: state.actions.videoLike.count,
      dailyLimit: LIMITS.videoLike.perDay,
    });
  },
);

// ── 视频收藏 ────────────────────────────────────────────────────────────────
server.tool(
  'video_fav',
  [
    '收藏一个 B站视频到收藏夹（status=false 从收藏夹移除）。',
    '不指定 folder 时进「默认收藏夹」。collection 有每日上限（默认 3 条），移除不算额度。',
    '理由 reason 建议写一句——她的收藏是有判据的，写下来以后能复盘。',
  ].join(''),
  {
    bvid: z.string().optional().describe('视频 BV 号'),
    oid: z.number().int().positive().optional().describe('视频 aid'),
    status: z.boolean().optional().describe('true=收藏（默认），false=取消收藏'),
    folder: z.string().optional().describe('收藏夹名称或 id；不填则用默认收藏夹'),
    reason: z.string().optional().describe('为什么收（一句话）'),
  },
  async ({ bvid, oid, status, folder, reason }) => {
    const account = loadAccount();
    if (!account.hasCred) return textResult({ ok: false, error: '没有 B站凭据（缺失 sessdata/bili_jct）' });
    const add = status !== false;
    const state = loadState();
    const denied = checkBudget(state, 'favAdd', add);
    if (denied) return textResult({ ok: false, error: denied.reason, ...denied });

    let info;
    let target;
    try {
      info = await resolveAid(account, { bvid, oid });
      const folders = await listFavFolders(account);
      target = pickFolder(folders, folder);
    } catch (error) {
      return textResult({ ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }

    let json = {};
    try {
      json = await callJson('https://api.bilibili.com/x/v3/fav/resource/deal', {
        account,
        referer: `https://www.bilibili.com/video/${info.bvid || bvid || ''}/`,
        method: 'POST',
        body: new URLSearchParams({
          rid: info.aid,
          type: '2',
          add_media_ids: add ? target.id : '',
          del_media_ids: add ? '' : target.id,
          csrf: account.biliJct,
        }),
      });
    } catch (error) {
      return textResult({ ok: false, error: `请求失败：${String(error?.message ?? error).slice(0, 200)}` });
    }
    const ok = Number(json?.code) === 0;
    spend(state, 'favAdd', ok && add);
    const cooldown = penalize(state, 'favAdd', json?.code);
    saveState(state);
    return textResult({
      ok,
      action: add ? 'favorite' : 'unfavorite',
      scope: 'video',
      bvid: info.bvid || bvid || '',
      oid: info.aid,
      title: info.title,
      folder: target.title,
      folderId: target.id,
      reason: String(reason ?? ''),
      code: Number.isFinite(Number(json?.code)) ? Number(json.code) : null,
      message: String(json?.message ?? ''),
      ...(cooldown ? { hint: '疑似风控，已冷却 30 分钟' } : {}),
      todayCount: state.actions.favAdd.count,
      dailyLimit: LIMITS.favAdd.perDay,
    });
  },
);

// ── 看某条评论下的回复（楼中楼）────────────────────────────────────────────
server.tool(
  'comment_replies',
  '读某条评论下面的回复（楼中楼）。root 是楼主的 rpid（一级评论），bvid/oid 定位视频。只读。',
  {
    root: z.number().int().positive().describe('楼主的 rpid（一级评论 id）'),
    bvid: z.string().optional().describe('视频 BV 号'),
    oid: z.number().int().positive().optional().describe('视频 aid'),
    page: z.number().int().positive().optional().describe('页码，默认 1'),
    limit: z.number().int().positive().optional().describe('最多返回几条，默认 20'),
  },
  async ({ root, bvid, oid, page, limit }) => {
    const account = loadAccount();
    let aid = String(oid ?? '');
    try {
      if (!aid) aid = (await resolveAid(account, { bvid })).aid;
    } catch (error) {
      return textResult({ ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }
    const ps = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const url = `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${encodeURIComponent(aid)}&root=${encodeURIComponent(root)}&ps=${ps}&pn=${Math.max(Number(page) || 1, 1)}`;
    let j = {};
    try {
      j = await callJson(url, { account, referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/' });
    } catch (error) {
      return textResult({ ok: false, error: `请求失败：${String(error?.message ?? error).slice(0, 200)}` });
    }
    if (Number(j?.code) !== 0) {
      return textResult({ ok: false, code: j?.code ?? null, message: String(j?.message ?? ''), error: '读取楼中楼失败' });
    }
    // 接口在没有子回复时会把她自己那条 root 也塞回来，过滤掉避免误读
    const replies = (j?.data?.replies ?? [])
      .filter((r) => String(r?.rpid ?? '') !== String(root))
      .map((r) => ({
        rpid: String(r.rpid ?? ''),
        user: String(r?.member?.uname ?? ''),
        mid: String(r?.member?.mid ?? ''),
        text: String(r?.content?.message ?? ''),
        ctime: Number(r?.ctime ?? 0) || 0,
        likes: Number(r?.like ?? 0) || 0,
      }));
    return textResult({
      ok: true,
      oid: aid,
      root: String(root),
      page: Math.max(Number(page) || 1, 1),
      // apiCount 是接口自己报的数（没有子回复时它会把 root 算进 1），count 是过滤后的真实条数
      apiCount: Number(j?.data?.page?.count ?? 0) || 0,
      count: replies.length,
      replies,
      ...(replies.length === 0 ? { hint: '这条评论下面还没有人回复' } : {}),
    });
  },
);

// ── 谁回复了我（收件箱）─────────────────────────────────────────────────────
server.tool(
  'received_replies',
  [
    '看「谁回复了我 / 谁 @了我」——B站收件箱，只读。kind=reply 是回复我的，kind=at 是 @我的。',
    '⚠️ 收件箱里的 title/source_content 语义不可靠（实测会出现多条同一句），',
    '  要确认对方到底说了什么，用返回的 root/parent 配 comment_replies 回读楼层。',
  ].join(''),
  {
    kind: z.enum(['reply', 'at']).optional().describe('reply=回复我的（默认），at=@我的'),
    limit: z.number().int().positive().optional().describe('最多返回几条，默认 20'),
    hours: z.number().positive().optional().describe('只看最近多少小时，默认不限'),
  },
  async ({ kind, limit, hours }) => {
    const account = loadAccount();
    if (!account.hasCred) return textResult({ ok: false, error: '没有 B站凭据（缺失 sessdata/bili_jct）' });
    const k = kind === 'at' ? 'at' : 'reply';
    const url = `https://api.bilibili.com/x/msgfeed/${k}?platform=web&build=0&mobi_app=web`;
    let j = {};
    try {
      j = await callJson(url, { account });
    } catch (error) {
      return textResult({ ok: false, error: `请求失败：${String(error?.message ?? error).slice(0, 200)}` });
    }
    if (Number(j?.code) !== 0) {
      return textResult({ ok: false, code: j?.code ?? null, message: String(j?.message ?? ''), error: '读取收件箱失败' });
    }
    const since = hours ? Date.now() / 1000 - Number(hours) * 3600 : 0;
    // 19 位 id 超过 JS 安全整数，JSON.parse 已经丢了精度 → 优先从 uri 里取字符串 id
    const idFromUri = (uri) => (/(?:t\.bilibili\.com|bilibili\.com\/opus)\/(\d{6,22})/.exec(String(uri ?? '')) || [])[1] || '';
    const items = (j?.data?.items ?? [])
      .map((it) => {
        const uri = String(it?.item?.uri ?? '');
        const subjectId = it?.item?.subject_id;
        return {
          id: String(it.id ?? ''),
          at: Number(it.reply_time ?? it.at_time ?? 0) || 0,
          user: String(it?.user?.nickname ?? ''),
          mid: String(it?.user?.mid ?? ''),
          // 两个字段都留（语义不可靠，谁有内容用谁）
          title: String(it?.item?.title ?? ''),
          source: String(it?.item?.source_content ?? ''),
          target: String(it?.item?.target_reply_content ?? ''),
          root: String(it?.item?.root_id ?? ''),
          parent: String(it?.item?.source_id ?? ''),
          oid: idFromUri(uri) || (Number.isSafeInteger(Number(subjectId)) ? String(subjectId) : ''),
          uri,
        };
      })
      .filter((x) => !since || x.at >= since)
      .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 50));
    return textResult({ ok: true, kind: k, count: items.length, lastViewAt: Number(j?.data?.last_view_at ?? 0) || 0, items });
  },
);

await server.connect(new StdioServerTransport());
