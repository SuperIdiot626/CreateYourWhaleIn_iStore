/**
 * dsh-xiaojingyu-tools —— 小鲸鱼工具组（host 半端）
 * ============================================================================
 * 它是什么：给 SurfCore 上的小鲸鱼（QQ）用的**工具组插件**。
 *   · 只**提供工具** + 一个设置页；**自己不主动做事**（没有定时器、没有刷一轮、没有日报、没有私信监听）。
 *   · B站 能力全部由本插件自己用 Node 实现（不依赖 Python venv、不依赖 bilibili_api）。
 *   · 工具名保持 `bili_*`，跟 SurfCore 的 QQ 桥接白名单（SAFE_EXACT）兼容 —— 迁移时白名单不用改。
 *
 * 提醒：这个插件的价值是"把工具交给 agent，由她想用再用"，
 *   所以所有写操作默认关闭，额度/冷却写死在 lib/limits.mjs。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { makeBili } from './lib/bili.mjs'
import { makeLimits } from './lib/limits.mjs'
import { loginStart, loginPoll } from './lib/login.mjs'

export const name = 'whale-tools'
export const inject = ['tools', 'settings']

/** 设置页字段：每个都必须 `.extra('volatile', true)`，否则 DSH 写设置时会抛。 */
export const Config = !z ? undefined : z.object({
  /* ── 工具组开关（改完立刻生效，不用重启）── */
  readTools: z.boolean().default(true).extra('volatile', true),
  loginTools: z.boolean().default(true).extra('volatile', true),
  writeTools: z.boolean().default(false).extra('volatile', true),
  dynamicTools: z.boolean().default(false).extra('volatile', true),

  /* ── 写操作闸门 ── */
  commentEnabled: z.boolean().default(false).extra('volatile', true),
  mentionName: z.string().default('').extra('volatile', true),
  commentPerDay: z.natural().default(3).extra('volatile', true),
  likePerDay: z.natural().default(30).extra('volatile', true),
  favPerDay: z.natural().default(3).extra('volatile', true),
  dynamicPerDay: z.natural().default(3).extra('volatile', true),
  minGapMs: z.natural().default(2000).extra('volatile', true),
  cooldownMin: z.natural().default(30).extra('volatile', true),

  /* ── 只读偏好 ── */
  searchOrder: z.string().default('totalrank').extra('volatile', true),
  coverWidth: z.natural().default(512).extra('volatile', true),
  framesMax: z.natural().default(6).extra('volatile', true),
  subtitleMaxChars: z.natural().default(20000).extra('volatile', true),

  /* ── 凭据 ── */
  credentialsPath: z.string().default('/root/.dsh/surfcore/bili/credentials.json').extra('volatile', true),
})

const LOCAL_LIMIT_DEFAULTS = {
  comment: 'commentPerDay',
  like: 'likePerDay',
  fav: 'favPerDay',
  dynamic: 'dynamicPerDay',
}

export function apply(ctx, config) {
  const cfg = () => (config && typeof config === 'object' ? config : {})
  const pluginDir = path.dirname(new URL(import.meta.url).pathname)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const stateDir = path.join(dshHome, 'whale-tools')

  const log = (msg) => {
    try { ctx.logger?.info?.(`[whale-tools] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }
  for (const note of hostDeps.notes || []) log(note)

  // 凭据路径可以在设置页改 ⇒ 路径一变就重建客户端（配置是活对象，每次调用现读）
  const DEFAULT_CRED = '/root/.dsh/surfcore/bili/credentials.json'
  let biliClient = null
  let biliPath = ''
  const bili = () => {
    const want = cfg().credentialsPath || DEFAULT_CRED
    if (!biliClient || biliPath !== want) {
      biliClient = makeBili({ credentialsPath: want, log })
      biliPath = want
    }
    return biliClient
  }
  const limits = makeLimits({ stateFile: path.join(stateDir, 'action-state.json') })
  // 登录流程里"出码那一跳带出来的 buvid3"先记着，poll 成功时补进凭据（凭据在 Set-Cookie 里，buvid3 有时缺）
  const loginSeeds = new Map()

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  const imageOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => {
      const src = value && typeof value === 'object' ? value : { value }
      const { image, images, ...rest } = src
      const parts = [{ type: 'text', text: JSON.stringify(rest, null, 2) }]
      for (const ref of [...(image ? [image] : []), ...(Array.isArray(images) ? images : [])]) {
        parts.push({ type: 'image', attachment: ref })
      }
      return parts
    },
  }

  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: spec.output || textOutput,
    async execute(args, exec) {
      try {
        return safe(await spec.execute(args || {}, exec))
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  }))

  const disabled = (what) => ({ ok: false, disabled: true, hint: `设置页里「${what}」关着，先打开再用` })

  /** 把图片字节交给宿主附件服务，返回引用数组（模型不支持图片时退化）。 */
  const attachImages = async (exec, images) => {
    const attachments = ctx.get('attachments')
    if (!attachments?.saveImages) {
      return { ok: false, reason: 'attachments', hint: '宿主的图片服务不可用' }
    }
    const llm = ctx.get('llm')
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (llm?.resolveModelInfo) {
      try {
        const info = await llm.resolveModelInfo(provider, model, exec?.signal)
        const modalities = info?.inputModalities
        if (Array.isArray(modalities) && !modalities.includes('image')) {
          return { ok: false, reason: 'model_no_image', hint: `当前模型（${provider}/${model}）不支持图片输入` }
        }
      } catch { /* 查不到就照常尝试 */ }
    }
    try {
      const refs = await attachments.saveImages(images.map((i) => ({ data: i.buffer, mediaType: i.mimeType || 'image/jpeg' })))
      return { ok: true, refs }
    } catch (error) {
      return { ok: false, reason: 'save_failed', hint: `存图片失败：${String(error?.message ?? error)}` }
    }
  }

  /** 把图片缩到指定宽度（ffmpeg），失败就原样返回。 */
  const resizeWidth = (buffer, width) => {
    const w = Math.max(64, Math.min(Number(width) || 512, 1920))
    const dir = path.join(os.tmpdir(), `whale-tools-${process.pid}`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const src = path.join(dir, `src-${Date.now()}.img`)
      const dst = path.join(dir, `dst-${Date.now()}.jpg`)
      fs.writeFileSync(src, buffer)
      execFileSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${w}:-2`, '-q:v', '4', dst], { timeout: 20000 })
      const out = fs.readFileSync(dst)
      fs.rmSync(src, { force: true })
      fs.rmSync(dst, { force: true })
      return { buffer: out, mimeType: 'image/jpeg' }
    } catch {
      return { buffer, mimeType: 'image/jpeg' }
    }
  }

  /* ══════════════════════ 只读工具 ══════════════════════ */

  tool({
    name: 'bili_whoami',
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。没登录时去设置页扫码。',
    parameters: {},
    async execute() {
      return await bili().whoami()
    },
  })

  tool({
    name: 'bili_search',
    description: '搜 B站 视频（可排序）。返回标题 / BV号 / 播放量 / UP / 时长 等。\n'
      + '看内容判断要靠 bili_subtitle（字幕原文），别看标题下结论。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ click=播放 / pubdate=最新 / dm=弹幕' },
    },
    async execute(args) {
      if (cfg().readTools === false) return disabled('只读工具')
      return await bili().search({
        keyword: String(args.keyword ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 10, 50)),
        order: String(args.order || cfg().searchOrder || 'totalrank'),
      })
    },
  })

  tool({
    name: 'bili_subtitle',
    description: '取一个视频的字幕（AI 字幕）全文。判断内容主要靠它；没有字幕会明确说没有。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) {
      if (cfg().readTools === false) return disabled('只读工具')
      const r = await bili().subtitle(String(args.bvid ?? ''))
      // 模块内硬上限 20000：配置设更大也没用，这里先夹住，免得设置页给人错觉
      const max = Math.min(20000, Math.max(500, Number(cfg().subtitleMaxChars) || 20000))
      if (r?.text && r.text.length > max) return { ...r, text: `${r.text.slice(0, max)}\n…（已截断，共 ${r.text.length} 字）` }
      return r
    },
  })

  tool({
    name: 'bili_comments',
    description: '取一个视频的热门评论（含点赞/回复数）。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) {
      if (cfg().readTools === false) return disabled('只读工具')
      return await bili().comments({ bvid: String(args.bvid ?? ''), num: Math.max(1, Math.min(Number(args.num) || 30, 100)) })
    },
  })

  tool({
    name: 'bili_cover',
    description: '看一个视频的封面（等比缩到设置里的宽度，默认 512）。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    output: imageOutput,
    async execute(args, exec) {
      if (cfg().readTools === false) return disabled('只读工具')
      const r = await bili().coverBuffer(String(args.bvid ?? ''))
      if (!r?.ok) return r
      const img = resizeWidth(r.buffer, cfg().coverWidth)
      const a = await attachImages(exec, [img])
      return a.ok
        ? { ok: true, bvid: String(args.bvid ?? ''), image: a.refs[0], image_attached: true }
        : { ok: false, image_attached: false, image_skip_reason: a.reason, hint: a.hint }
    },
  })

  tool({
    name: 'bili_frames',
    description: '看视频里的画面（从 B站 自带故事板裁 1~6 帧）。字幕告诉你说什么，画面告诉你拍的是什么。\n'
      + '默认按时长均匀取 3 帧；想盯某个时刻就传 at。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几帧，1-6，默认 3' },
      at: { type: 'array', items: { type: 'number' }, description: '指定时间点（秒）列表；传了就以它为准' },
    },
    output: imageOutput,
    async execute(args, exec) {
      if (cfg().readTools === false) return disabled('只读工具')
      const at = Array.isArray(args.at) ? args.at.map(Number).filter(Number.isFinite) : undefined
      const maxFrames = Math.max(1, Math.min(Number(cfg().framesMax) || 6, 6))
      const r = await bili().frames({
        bvid: String(args.bvid ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 3, maxFrames)),
        ...(at && at.length ? { at } : {}),
      })
      if (!r?.ok) return r
      const a = await attachImages(exec, r.frames || [])
      return a.ok
        ? { ok: true, bvid: String(args.bvid ?? ''), count: (r.frames || []).length, images: a.refs, image_attached: true }
        : { ok: false, image_attached: false, image_skip_reason: a.reason, hint: a.hint }
    },
  })

  /* ══════════════════════ 登录 / 状态 ══════════════════════ */

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：生成二维码 PNG（存在插件家目录），返回图片路径和 key。\n'
      + '⚠️ 二维码约 180 秒有效，出码后要尽快递给主人扫（手机上确认时选「记住我」）。',
    parameters: {},
    async execute() {
      if (cfg().loginTools === false) return disabled('登录工具')
      const r = await loginStart({ stateDir })
      if (r?.qrcodeKey) loginSeeds.set(String(r.qrcodeKey), String(r.seedBuvid3 || ''))
      return {
        ok: true,
        key: r.qrcodeKey,
        url: r.url,
        png: r.png,
        hint: r.png ? '用 present 把这张 PNG 推给主人扫，扫完调 bili_login_poll' : '没画出 PNG（缺 qrcode 依赖），可以把 url 交给主人',
      }
    },
  })

  tool({
    name: 'bili_login_poll',
    description: '查扫码结果：waiting 未扫 / scanned 已扫待确认 / ok 成功 / expired 过期。',
    parameters: { key: { type: 'string', description: 'bili_login_start 返回的 key' } },
    async execute(args) {
      if (cfg().loginTools === false) return disabled('登录工具')
      const key = String(args.key ?? '')
      const r = await loginPoll({ qrcodeKey: key, seedBuvid3: loginSeeds.get(key) || '' })
      if (r.state !== 'waiting' && r.state !== 'scanned') loginSeeds.delete(key)
      if (r.state === 'ok' && r.credential) {
        bili().saveCred(r.credential)
        return { ok: true, state: 'ok', saved: cfg().credentialsPath, hint: '登录成功，凭证已保存' }
      }
      return { ok: r.state === 'waiting' || r.state === 'scanned', state: r.state, hint: r.hint }
    },
  })

  tool({
    name: 'bili_status',
    description: '看这个工具组现在的状态：B站登录的是谁、凭据什么时候写的、今天写操作用掉多少、哪些工具组开着。',
    parameters: {},
    async execute() {
      const credPath = cfg().credentialsPath || '/root/.dsh/surfcore/bili/credentials.json'
      let credMtime = null
      try { credMtime = fs.statSync(credPath).mtime.toISOString() } catch { credMtime = null }
      const who = await bili().whoami().catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
      return {
        ok: true,
        version: readVersion(pluginDir),
        groups: {
          readTools: cfg().readTools !== false,
          loginTools: cfg().loginTools !== false,
          writeTools: cfg().writeTools === true,
          dynamicTools: cfg().dynamicTools === true,
        },
        credentials: { path: credPath, mtime: credMtime },
        bili: who,
        usage: limits.snapshot(),
        note: '本插件不主动做事：没有定时刷、没有日报、没有私信监听',
      }
    },
  })

  log(`已加载（${readVersion(pluginDir)}）：只读=${cfg().readTools !== false} 登录=${cfg().loginTools !== false} 写=${cfg().writeTools === true} 动态=${cfg().dynamicTools === true}`)
}

function readVersion(pluginDir) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}
