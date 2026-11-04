// 「小黑盒」· 独立 MCP server
//
// 需求来由：主人让小鱼能逛小黑盒（游戏社区）。
// 官方插件 dsh-heybox 只做「设置页 + 生物钟自己逛」，**不暴露 agent 工具**，
// 所以她的预设里没有小黑盒能力。这个 server 把插件的 CLI 包成几个 MCP 工具。
//
// 链路：工具 → node dsh-heybox/tools/heybox.mjs <cmd> --json → 返回文本
//
// 设计约束（跟 mcp-board.js 一致）：
//   · 只读为主：feed/post/comments/search/games/topic/whoami
//   · 写操作只有 like，且**默认预演**（go=false），要显式 go=true 才真发
//   · 凭据由插件自己管（~/.heybox-ai/credentials.json），这里不碰
//   · 输出统一截断，避免一条帖子把上下文撑爆

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const NODE = process.env.HEYBOX_NODE || '/usr/local/bin/node';
const CLI = process.env.HEYBOX_CLI
  || '/root/.dsh/profiles/web/node_modules/dsh-heybox/tools/heybox.mjs';

const MAX_CHARS = 6000;   // 单次返回上限（纯文本模式，够用且不撑爆上下文）
const TIMEOUT_MS = 30000; // 单条命令超时

function clip(text, max = MAX_CHARS) {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字）` : s;
}

// 默认用 CLI 的**人类可读输出**（比 --json 省约 5 倍 token，也不会被截断成半截 JSON）；
// 只有需要结构化的写操作（点赞）才加 --json。
function runCli(args, { json = false } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CLI)) {
      resolve({ ok: false, text: `找不到小黑盒 CLI：${CLI}` });
      return;
    }
    execFile(
      NODE,
      [CLI, ...args, ...(json ? ['--json'] : [])],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errText = String(stderr || '').trim();
        if (err) {
          // 超时 / 未登录 / 需要 token 之类，原样带出来让模型知道原因
          const reason = errText || out || err.message || '执行失败';
          resolve({ ok: false, text: clip(`小黑盒请求失败：${reason}`) });
          return;
        }
        resolve({ ok: true, text: clip(out || '(空)') });
      },
    );
  });
}

const server = new McpServer({ name: 'heybox-tools', version: '1.0.0' });

function textResult(r) {
  return { content: [{ type: 'text', text: r.text }] };
}

server.tool(
  'heybox_whoami',
  '看小黑盒登录的是谁（确认有没有登录/登录过期）。逛之前可以先确认一下。',
  {},
  async () => textResult(await runCli(['whoami'])),
);

server.tool(
  'heybox_feed',
  '看小黑盒信息流（按你关注的游戏/订阅）。返回一批帖子标题、作者、热度。',
  { limit: z.number().int().min(1).max(30).optional().describe('要几条，默认跟设置一致') },
  async ({ limit }) => {
    const args = ['feed'];
    if (limit) args.push('--limit', String(limit));
    return textResult(await runCli(args));
  },
);

server.tool(
  'heybox_post',
  '打开小黑盒某条帖子的正文（link_id 从信息流/搜索结果里拿；链接形如 xiaoheihe.cn/.../link/xxxx 时取最后那段数字）。',
  { link_id: z.string().min(1).describe('帖子 id') },
  async ({ link_id }) => textResult(await runCli(['link', String(link_id).trim()])),
);

server.tool(
  'heybox_comments',
  '看小黑盒某条帖子的评论。',
  { link_id: z.string().min(1).describe('帖子 id') },
  async ({ link_id }) => textResult(await runCli(['comment', String(link_id).trim()])),
);

server.tool(
  'heybox_search',
  '在小黑盒搜帖子（关键词）。',
  { keyword: z.string().min(1).describe('搜索关键词') },
  async ({ keyword }) => textResult(await runCli(['search', String(keyword).trim()])),
);

server.tool(
  'heybox_games',
  '查小黑盒的游戏库/搜游戏（不传关键词就是我的游戏库）。',
  { keyword: z.string().optional().describe('游戏名关键词，可选') },
  async ({ keyword }) => {
    const args = ['game'];
    if (keyword && String(keyword).trim()) args.push('--q', String(keyword).trim());
    return textResult(await runCli(args));
  },
);

server.tool(
  'heybox_topic',
  '看小黑盒的话题/圈子（关键词）。',
  { keyword: z.string().min(1).describe('话题关键词') },
  async ({ keyword }) => textResult(await runCli(['topic', String(keyword).trim()])),
);

server.tool(
  'heybox_like',
  '给小黑盒帖子点赞。**默认只预演**，要真发必须 go=true（一天有上限，别刷）。',
  {
    link_id: z.string().min(1).describe('帖子 id'),
    go: z.boolean().optional().describe('true 才真的发出去；默认 false 只预演'),
  },
  async ({ link_id, go }) => {
    const args = ['like', String(link_id).trim()];
    if (go) args.push('--go');
    // 点赞是写操作，要结构化结果（成功/已赞/超限）才好判断
    return textResult(await runCli(args, { json: true }));
  },
);

await server.connect(new StdioServerTransport());

