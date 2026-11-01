/**
 * lib/bili.mjs —— 纯 Node 的 B站 API 客户端
 * ============================================================================
 * 给「小鲸鱼工具组」DSH 插件用。只用 Node 内置能力：fetch / crypto / child_process，
 * **不引任何第三方依赖**。ffmpeg / ffprobe 只用来从故事板拼图里裁帧。
 *
 * 只做只读接口（GET）。写操作（评论/点赞）不在这里。
 *
 * 几个必须记住的点：
 *   · 大量 web 接口现在要 WBI 签名（w_rid + wts），签错的症状是 code=-403/-412。
 *   · wbi keys 从 /x/web-interface/nav 的 data.wbi_img 拿 —— 游客态也能拿到，
 *     所以**没登录也能签**，只是业务接口会回 -101。keys 缓存 1 小时。
 *   · 故事板的 index 时间戳**秒/毫秒两种都出现过**，只能和视频时长比着判断；
 *     且 index 有概率为空，要用 pvdata 兜底（大端 uint16 秒数数组）。
 *   · 故事板可能有多张拼图，tile 下标要按「每张装几块」拆成 第几张 + 第几块。
 * ============================================================================
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

// ---------------------------------------------------------------- 常量

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const TIMEOUT_MS = 15000
const DEFAULT_CRED_PATH = '/root/.dsh/surfcore/bili/credentials.json'

const API = 'https://api.bilibili.com'

// WBI mixin 重排表（标准 64 项，顺序不能改 —— 改一个字符签名就全错）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

const WBI_TTL_MS = 60 * 60 * 1000 // keys 缓存 1 小时

const MAX_SUBTITLE_CHARS = 20000
const MAX_FRAMES = 6

// ---------------------------------------------------------------- 错误

/** 带上 code / httpStatus 的错误，message 一定是人能读懂的一句话 */
class BiliError extends Error {
  constructor(message, { code = null, status = null, url = '', hint = '' } = {}) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.status = status
    this.url = url
    this.hint = hint
  }
}

/** B站业务码 → 人话（只挑常见的，别的一律透传 code+message） */
function codeHint(code) {
  switch (Number(code)) {
    case -101:
      return '账号没登录或 cookie 已失效（SESSDATA 过期）'
    case -352:
      return '触发风控校验（wbi 签名或 cookie 有问题）'
    case -403:
      return '权限不足（可能要登录，或 wbi 签名不对）'
    case -400:
      return '请求参数不对'
    case -404:
      return '资源不存在（BVID/CID 写错了？）'
    case -412:
      return '请求被 B站 拦截（风控），先降频再试'
    case -799:
      return '请求过于频繁'
    case 62002:
      return '稿件不可见（已删除/仅粉丝可见/地区限制）'
    case 62012:
      return '稿件仅 UP 主自己可见'
    case 87008:
      return '视频不存在'
    default:
      return ''
  }
}

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------- HTTP

function timeoutText(e, timeoutMs) {
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return `请求超时（${timeoutMs}ms）`
  const c = e?.cause
  if (c?.code === 'ENOTFOUND') return '域名解析失败（容器没网/DNS 挂了）'
  if (c?.code === 'ECONNREFUSED') return '连接被拒绝'
  if (c?.code === 'ECONNRESET') return '连接被重置'
  if (c?.code === 'ETIMEDOUT') return `连接超时（${timeoutMs}ms）`
  if (c?.code) return `网络错误 ${c.code}`
  return e?.message || String(e)
}

/** 发一个 GET 并把 body 交给 consume 处理；超时/断网都翻译成人话 */
async function request(url, { headers = {}, timeoutMs = TIMEOUT_MS, what = '请求' } = {}, consume) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Referer: REFERER, ...headers },
      signal: ac.signal,
      redirect: 'follow',
    })
    const out = await consume(res)
    return out
  } catch (e) {
    if (e instanceof BiliError) throw e
    throw new BiliError(`${what}失败：${timeoutText(e, timeoutMs)}`, { url })
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url, opts = {}) {
  return request(url, opts, async (res) => {
    const text = await res.text()
    if (res.status === 412) {
      throw new BiliError(`${opts.what || '请求'}被 B站 风控拦截（HTTP 412），这一小段时间内别重试`, {
        status: 412,
        url,
        hint: '风控拦截：降低请求频率，换 IP 或等几分钟',
      })
    }
    if (!res.ok) {
      throw new BiliError(`${opts.what || '请求'}失败：HTTP ${res.status} ${res.statusText || ''}`.trim(), {
        status: res.status,
        url,
      })
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      // 常见原因：接口改版返回 HTML，或被劫持
      const head = text.slice(0, 120).replace(/\s+/g, ' ')
      throw new BiliError(`${opts.what || '请求'}返回的不是 JSON（HTTP ${res.status}）：${head}`, {
        status: res.status,
        url,
      })
    }
    return json
  })
}

async function getBytes(url, opts = {}) {
  return request(url, opts, async (res) => {
    if (res.status === 412) {
      throw new BiliError(`${opts.what || '下载'}被 B站 风控拦截（HTTP 412）`, { status: 412, url })
    }
    if (!res.ok) {
      throw new BiliError(`${opts.what || '下载'}失败：HTTP ${res.status} ${res.statusText || ''}`.trim(), {
        status: res.status,
        url,
      })
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  })
}

/** 统一调 B站 JSON 接口：返回 data，code!=0 抛 BiliError（headers 由调用方给） */
async function api(url, { what = '接口', headers = {} } = {}) {
  const json = await getJson(url, { what, headers })
  const code = json?.code
  if (code !== 0) {
    const msg = json?.message || json?.msg || '无 message'
    const hint = codeHint(code)
    throw new BiliError(
      `${what}失败：code=${code} ${msg}${hint ? `（${hint}）` : ''}`,
      { code, url, hint },
    )
  }
  return json.data
}

// ---------------------------------------------------------------- WBI 签名

/** 从 img_key/sub_key 拼出 32 位 mixin key */
function mixinKeyOf(imgKey, subKey) {
  const orig = String(imgKey || '') + String(subKey || '')
  let out = ''
  for (const i of MIXIN_KEY_ENC_TAB) out += orig[i] ?? ''
  return out.slice(0, 32)
}

/** 从 wbi_img 的 url 里抠出文件名（去扩展名） */
function keyFromUrl(u) {
  const base = String(u || '').split('/').pop() || ''
  return base.replace(/\.(png|jpg|jpeg|webp|gif)$/i, '')
}

// 参数里这几个字符要剔掉，否则签名对不上（B站 官方 JS 同款规则）
const CHR_FILTER = /[!'()*]/g

/** 对参数做 WBI 签名，返回带 w_rid 的查询串（key 已排序） */
function encWbi(params, mixinKey) {
  const withWts = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(withWts)
    .sort()
    .map((k) => {
      const v = String(withWts[k] ?? '').replace(CHR_FILTER, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  return `${query}&w_rid=${md5(query + mixinKey)}`
}

// ---------------------------------------------------------------- 图片魔数

/** 按魔数判断图片类型（不信任 content-type，B站 CDN 有时给 text/plain） */
function sniffMime(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return 'application/octet-stream'
}

/** 补全 // 开头的协议相对 URL */
function httpsUrl(u) {
  const s = String(u || '').trim()
  if (!s) return ''
  if (s.startsWith('//')) return `https:${s}`
  if (s.startsWith('http://')) return s // 故事板就是 http 的 i0.hdslb.com，照用
  return s
}

/** "12:34" / "1:02:03" / 754 → 秒数 */
function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  const s = String(v ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** 搜索结果标题里带 <em class="keyword">，要剥标签 + 解几个常见实体 */
function cleanText(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

// ---------------------------------------------------------------- 主入口

export function makeBili({ credentialsPath = DEFAULT_CRED_PATH, log = console.log } = {}) {
  const credPath = credentialsPath || DEFAULT_CRED_PATH
  let wbiCache = null // { imgKey, subKey, mixinKey, at }
  let ffPaths = null // ffmpeg/ffprobe 探测结果缓存

  const say = (...a) => {
    try {
      log?.(...a)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  // ---------------- 凭据

  /** 读凭据；没有/坏了都返回 null（绝不抛异常，也绝不打印内容） */
  function loadCred() {
    let raw
    try {
      raw = fs.readFileSync(credPath, 'utf8')
    } catch (e) {
      if (e?.code !== 'ENOENT') say(`[bili] 读凭据失败：${e?.code || e?.message}`)
      return null
    }
    let j
    try {
      j = JSON.parse(raw)
    } catch {
      say('[bili] 凭据文件不是合法 JSON，按未登录处理')
      return null
    }
    if (!j || typeof j !== 'object') return null
    const sessdata = String(j.sessdata ?? '')
    if (!sessdata) return null
    return {
      sessdata,
      bili_jct: String(j.bili_jct ?? ''),
      buvid3: String(j.buvid3 ?? ''),
      dedeuserid: String(j.dedeuserid ?? ''),
    }
  }

  function hasCred() {
    return loadCred() !== null
  }

  /** 原子写：同目录临时文件 → chmod 600 → rename 覆盖 */
  function saveCred(obj) {
    if (!obj || typeof obj !== 'object') throw new BiliError('saveCred 需要一个对象')
    const dir = path.dirname(credPath)
    fs.mkdirSync(dir, { recursive: true })

    // 保留文件里已有的其它字段（向前兼容），只覆盖我们管的四个
    let merged = {}
    try {
      const old = JSON.parse(fs.readFileSync(credPath, 'utf8'))
      if (old && typeof old === 'object') merged = old
    } catch {
      /* 没有或坏了都无所谓，直接覆盖 */
    }
    for (const k of ['sessdata', 'bili_jct', 'buvid3', 'dedeuserid']) {
      if (obj[k] !== undefined) merged[k] = String(obj[k] ?? '')
    }

    const tmp = `${credPath}.tmp-${process.pid}-${Date.now()}`
    try {
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, credPath) // 同一文件系统内 rename 是原子的
      try {
        fs.chmodSync(credPath, 0o600)
      } catch {
        /* Windows 上不生效，忽略 */
      }
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 清不掉就算了 */
      }
      throw new BiliError(`写凭据失败：${e?.message || e}`)
    }
  }

  /** 组 Cookie 头（缺哪个就少哪个，不补空值） */
  function cookieHeader() {
    const c = loadCred()
    if (!c) return ''
    const parts = []
    if (c.sessdata) parts.push(`SESSDATA=${c.sessdata}`)
    if (c.bili_jct) parts.push(`bili_jct=${c.bili_jct}`)
    if (c.buvid3) parts.push(`buvid3=${c.buvid3}`)
    if (c.dedeuserid) parts.push(`DedeUserID=${c.dedeuserid}`)
    return parts.join('; ')
  }

  /** 带凭据的接口都要这个头 */
  function authHeaders() {
    const cookie = cookieHeader()
    return cookie ? { Cookie: cookie } : {}
  }

  /**
   * 业务接口统一入口：**默认带上 Cookie**。
   * ⚠️ 这里必须带凭据 —— 不带时 /x/player/wbi/v2 会按游客返回空 subtitles（踩过），
   *    评论、字幕都会静默变成"没有"。
   */
  const apiAuth = (url, opts = {}) =>
    api(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } })

  // ---------------- WBI

  /**
   * 取 wbi keys。游客态 nav 返回 code=-101，但 data.wbi_img 照样有 —— 所以不看 code。
   * 缓存 1 小时；force=true 强制刷新（签名报错时重试一次用）。
   */
  async function getWbiKeys(force = false) {
    if (!force && wbiCache && Date.now() - wbiCache.at < WBI_TTL_MS) return wbiCache
    const json = await getJson(`${API}/x/web-interface/nav`, {
      headers: authHeaders(),
      what: '取 WBI 签名密钥（nav）',
    })
    const img = json?.data?.wbi_img
    const imgKey = keyFromUrl(img?.img_url)
    const subKey = keyFromUrl(img?.sub_url)
    if (!imgKey || !subKey) {
      // -101 也可能真的没给 wbi_img（极少），这时给明确错误
      throw new BiliError(
        `拿不到 WBI 签名密钥（nav 返回 code=${json?.code ?? '?'} ${json?.message || ''}，没有 data.wbi_img）`.trim(),
        { code: json?.code ?? null, url: `${API}/x/web-interface/nav` },
      )
    }
    wbiCache = { imgKey, subKey, mixinKey: mixinKeyOf(imgKey, subKey), at: Date.now() }
    say('[bili] WBI keys 已刷新（缓存 1 小时）')
    return wbiCache
  }

  /** 签名后的 URL */
  async function signedUrl(base, params, force = false) {
    const { mixinKey } = await getWbiKeys(force)
    return `${base}?${encWbi(params, mixinKey)}`
  }

  /**
   * 调一个需要 WBI 签名的接口。
   * 签名过期/风控时刷新 keys 重试一次（实测 keys 轮换后典型症状就是 -403）。
   */
  async function apiSigned(base, params, { what = '接口', retry = true } = {}) {
    const run = async (force) => {
      const url = await signedUrl(base, params, force)
      return apiAuth(url, { what })
    }
    try {
      return await run(false)
    } catch (e) {
      const code = Number(e?.code)
      const stale = code === -403 || code === -412 || code === -352 || e?.status === 412
      if (!retry || !stale) throw e
      say(`[bili] ${what} 签名疑似过期（${e.code}），刷新 keys 重试一次`)
      await sleep(300)
      return run(true)
    }
  }

  // ---------------- 视频基础信息（内部用原始 data）

  async function viewRaw(bvid) {
    if (!bvid || !/^BV[0-9A-Za-z]{8,}$/.test(String(bvid))) {
      throw new BiliError(`BVID 格式不对：${bvid}`)
    }
    return apiAuth(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      what: '取视频信息',
    })
  }

  // ---------------- 对外接口

  /** 当前登录态（mid/uname/头像；不返回任何 cookie） */
  async function whoami() {
    try {
      const json = await getJson(`${API}/x/web-interface/nav`, {
        headers: authHeaders(),
        what: '查询登录状态',
      })
      const code = json?.code
      const d = json?.data || {}
      if (code !== 0) {
        const hint = codeHint(code) || json?.message || `code=${code}`
        return { ok: false, loggedIn: false, mid: 0, uname: '', avatarUrl: '', hint }
      }
      const loggedIn = Boolean(d.isLogin)
      if (!loggedIn) {
        return {
          ok: true,
          loggedIn: false,
          mid: 0,
          uname: '',
          avatarUrl: '',
          hint: hasCred() ? 'cookie 已过期或无效，需要重新扫码登录' : '还没登录（没有凭据文件）',
        }
      }
      return {
        ok: true,
        loggedIn: true,
        mid: Number(d.mid) || 0,
        uname: String(d.uname || ''),
        avatarUrl: httpsUrl(d.face) || '',
      }
    } catch (e) {
      return { ok: false, loggedIn: false, mid: 0, uname: '', avatarUrl: '', hint: e?.message || String(e) }
    }
  }

  /** 搜索视频（WBI 签） */
  async function search({ keyword, num = 10, order = 'totalrank' } = {}) {
    const kw = String(keyword ?? '').trim()
    if (!kw) return { ok: false, items: [], hint: 'keyword 不能为空' }
    const n = Math.max(1, Math.min(50, Math.floor(Number(num) || 10)))
    try {
      const data = await apiSigned(
        `${API}/x/web-interface/wbi/search/type`,
        { search_type: 'video', keyword: kw, order: order || 'totalrank', page: 1, page_size: n },
        { what: '搜索视频' },
      )
      const list = Array.isArray(data?.result) ? data.result : []
      const items = list
        .filter((x) => x && x.bvid)
        .slice(0, n)
        .map((x) => ({
          bvid: String(x.bvid),
          title: cleanText(x.title),
          author: String(x.author ?? ''),
          play: Number(x.play) || 0,
          duration: parseDuration(x.duration), // 接口给的是 "12:34" 这种串，这里归一成秒
          pubdate: Number(x.pubdate) || 0,
          desc: cleanText(x.description ?? ''),
        }))
      return { ok: true, items }
    } catch (e) {
      return { ok: false, items: [], hint: e?.message || String(e) }
    }
  }

  /** 视频信息（对外形状固定） */
  async function videoInfo(bvid) {
    const d = await viewRaw(bvid)
    return {
      ok: true,
      aid: Number(d.aid) || 0,
      cid: Number(d.cid) || Number(d?.pages?.[0]?.cid) || 0,
      bvid: String(d.bvid || bvid),
      title: String(d.title ?? ''),
      pic: httpsUrl(d.pic),
      duration: Number(d.duration) || 0,
      owner: { mid: Number(d?.owner?.mid) || 0, name: String(d?.owner?.name ?? '') },
      desc: String(d.desc ?? ''),
    }
  }

  /** 字幕：选中文优先，拼成全文（最多 2 万字） */
  async function subtitle(bvid) {
    try {
      const v = await videoInfo(bvid)
      const cid = v.cid
      if (!cid) return { ok: false, title: v.title, lang: '', text: '', lines: [], hint: '拿不到 cid（视频可能已下架）' }

      const p = await apiSigned(
        `${API}/x/player/wbi/v2`,
        { aid: v.aid, cid },
        { what: '取字幕列表' },
      )
      const subs = Array.isArray(p?.subtitle?.subtitles) ? p.subtitle.subtitles : []
      if (!subs.length) {
        return {
          ok: false,
          title: v.title,
          lang: '',
          text: '',
          lines: [],
          hint: '该视频没有字幕（UP 没传、也没开 AI 字幕；直播回放通常没有）',
        }
      }
      // 中文优先：zh-Hans / zh-CN，其次 ai-zh（AI 生成），最后取第一条
      const order = (lan) => {
        const s = String(lan || '')
        if (s === 'zh-Hans') return 0
        if (s === 'zh-CN') return 1
        if (s === 'ai-zh') return 2
        if (s.startsWith('zh')) return 3
        return 9
      }
      const target = [...subs].sort((a, b) => order(a?.lan) - order(b?.lan))[0]

      const url = httpsUrl(target?.subtitle_url)
      if (!url) {
        // 新版接口只给 subtitle_url_v2（加密格式），我们不解析 —— 给个能看懂的提示
        const onlyV2 = Boolean(target?.subtitle_url_v2)
        return {
          ok: false,
          title: v.title,
          lang: String(target?.lan_doc || target?.lan || ''),
          text: '',
          lines: [],
          hint: onlyV2
            ? '该视频只提供新版字幕格式（subtitle_url_v2），本模块只支持旧版 JSON 字幕'
            : '字幕条目里没有 subtitle_url',
        }
      }
      // subtitle_url 自带 auth_key（时效很短），必须马上用
      // 少数视频 need_login_subtitle=true，字幕文件也要带 Cookie —— 失败了带 Cookie 再来一次
      let json
      try {
        json = await getJson(url, { what: '下载字幕 JSON' })
      } catch (e) {
        say(`[bili] 字幕直接下载失败（${e?.message || e}），带 Cookie 重试一次`)
        json = await getJson(url, { what: '下载字幕 JSON', headers: authHeaders() })
      }
      const body = Array.isArray(json?.body) ? json.body : []
      if (!body.length) {
        return { ok: false, title: v.title, lang: String(target?.lan || ''), text: '', lines: [], hint: '字幕文件是空的' }
      }
      const lines = body.map((x) => ({
        from: Number(x?.from) || 0,
        to: Number(x?.to) || 0,
        content: String(x?.content ?? '').trim(),
      }))

      let text = lines.map((l) => l.content).join('\n')
      let hint
      if (text.length > MAX_SUBTITLE_CHARS) {
        text = text.slice(0, MAX_SUBTITLE_CHARS)
        hint = `字幕太长，已截断到 ${MAX_SUBTITLE_CHARS} 字（原文 ${lines.map((l) => l.content).join('\n').length} 字）`
      }
      return {
        ok: true,
        title: v.title,
        lang: String(target?.lan_doc || target?.lan || ''),
        text,
        lines,
        ...(hint ? { hint } : {}),
      }
    } catch (e) {
      return { ok: false, title: '', lang: '', text: '', lines: [], hint: e?.message || String(e) }
    }
  }

  /** 热门评论 */
  async function comments({ bvid, num = 30 } = {}) {
    try {
      const v = await videoInfo(bvid)
      if (!v.aid) return { ok: false, items: [], hint: '拿不到 aid' }
      const ps = Math.max(1, Math.min(50, Math.floor(Number(num) || 30)))
      const data = await apiSigned(
        `${API}/x/v2/reply/wbi/main`,
        {
          type: 1,
          oid: v.aid,
          mode: 3, // 3 = 按热度
          ps,
          pn: 1,
          plat: 1,
          web_location: 1315875,
        },
        { what: '取评论' },
      )
      const list = Array.isArray(data?.replies) ? data.replies : []
      const items = list.slice(0, ps).map((r) => ({
        rpid: Number(r?.rpid) || 0,
        uname: String(r?.member?.uname ?? ''),
        message: String(r?.content?.message ?? ''),
        like: Number(r?.like) || 0,
        rcount: Number(r?.rcount) || 0,
        ctime: Number(r?.ctime) || 0,
      }))
      return { ok: true, items }
    } catch (e) {
      return { ok: false, items: [], hint: e?.message || String(e) }
    }
  }

  /** 封面原图字节（上层再缩放） */
  async function coverBuffer(bvid) {
    try {
      const v = await videoInfo(bvid)
      if (!v.pic) return { ok: false, buffer: null, mimeType: '', hint: '视频没有封面字段' }
      const buf = await getBytes(v.pic, { what: '下载封面' })
      return { ok: true, buffer: buf, mimeType: sniffMime(buf) }
    } catch (e) {
      return { ok: false, buffer: null, mimeType: '', hint: e?.message || String(e) }
    }
  }

  // ---------------- ffmpeg 辅助

  function resolveFfmpeg() {
    if (ffPaths) return ffPaths
    const cands = {
      ffmpeg: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'],
      ffprobe: ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe'],
    }
    const pick = (arr) => {
      for (const p of arr) {
        if (!p.includes('/')) return p // 裸命令名交给 PATH 去找
        try {
          fs.accessSync(p, fs.constants.X_OK)
          return p
        } catch {
          /* 下一个 */
        }
      }
      return arr[arr.length - 1]
    }
    ffPaths = { ffmpeg: pick(cands.ffmpeg), ffprobe: pick(cands.ffprobe) }
    return ffPaths
  }

  function execFileP(cmd, args, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', error: err })
      })
    })
  }

  /** 用 ffprobe 读图片宽高（不引图像库） */
  async function imageSize(file) {
    const { ffprobe } = resolveFfmpeg()
    const r = await execFileP(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      file,
    ])
    if (!r.ok) throw new BiliError(`ffprobe 读图片尺寸失败：${(r.stderr || '').trim().slice(0, 200)}`)
    const [w, h] = String(r.stdout).trim().split(',').map((x) => Number(x))
    if (!(w > 0 && h > 0)) throw new BiliError(`ffprobe 没读出宽高：${String(r.stdout).trim().slice(0, 120)}`)
    return { w, h }
  }

  /** 从拼图里裁一块到 jpg，返回字节 */
  async function cropTile(sheetPath, outPath, { tw, th, col, row }) {
    const { ffmpeg } = resolveFfmpeg()
    const vf = `crop=${tw}:${th}:${col * tw}:${row * th}`
    const r = await execFileP(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', sheetPath,
      '-vf', vf,
      '-q:v', '3',
      outPath,
    ])
    if (!r.ok) throw new BiliError(`ffmpeg 裁帧失败：${(r.stderr || '').trim().slice(0, 300)}`)
    return fsp.readFile(outPath)
  }

  // ---------------- 故事板归一

  /**
   * 把 videoshot 的 index 归一成 [{ sec, tile }]。
   * 时间单位秒/毫秒都出现过 —— 只跟视频时长比：超过时长 1.5 倍才当毫秒。
   * （别用"数值大就是毫秒"这种判据，长视频的秒数会被误判）
   */
  function snapshotEntries(data, duration) {
    const raws = []
    const arr = Array.isArray(data?.index) ? data.index : []
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      const ts = item && typeof item === 'object' ? item.timestamp : item
      const n = Number(ts)
      if (Number.isFinite(n)) raws.push({ v: n, tile: i })
    }
    if (!raws.length) return []
    const biggest = Math.max(...raws.map((x) => x.v))
    const looksMs = duration > 0 && biggest > duration * 1.5
    const scale = looksMs ? 1000 : 1
    return raws.map((x) => ({ sec: x.v / scale, tile: x.tile }))
  }

  /** index 为空时的兜底：pvdata 指向大端 uint16 秒数数组 */
  async function entriesFromPvdata(data, headers) {
    const url = httpsUrl(data?.pvdata)
    if (!url) return []
    try {
      const raw = await getBytes(url, { headers, what: '下载故事板时间索引（pvdata）' })
      if (!raw || raw.length % 2 !== 0) return []
      const count = raw.length / 2
      if (count > 20000) return [] // 明显不对
      const out = []
      for (let i = 0; i < count; i++) out.push({ sec: raw.readUInt16BE(i * 2), tile: i })
      return out
    } catch {
      return []
    }
  }

  /**
   * 故事板抽帧。
   * @param {object} o
   * @param {string} o.bvid
   * @param {number} [o.num=3] 1..6
   * @param {number[]|null} [o.at] 指定秒级时间点；给了就忽略 num
   */
  async function frames({ bvid, num = 3, at = null } = {}) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bili-frames-'))
    const cleanup = async () => {
      try {
        await fsp.rm(tmpDir, { recursive: true, force: true })
      } catch {
        /* 删不掉不影响结果 */
      }
    }
    // 故事板图在 i0/bimp.hdslb.com 这个 CDN 上，不需要登录 —— 别把 bilibili 的 Cookie 发过去
    const headers = {}
    try {
      const raw = await viewRaw(bvid)
      const duration = Number(raw?.duration) || 0
      const pages = Array.isArray(raw?.pages) ? raw.pages : []
      const cid = Number(raw?.cid) || Number(pages?.[0]?.cid) || 0
      if (!cid) return { ok: false, frames: [], hint: '拿不到 cid（视频可能已下架）' }

      // 故事板一般只覆盖第 1P
      let covered = pages.length ? Number(pages[0]?.duration) || duration : duration
      if (!covered) covered = duration

      // ⚠️ index 有概率返回空，试两次 + pvdata 兜底
      let snap = {}
      let entries = []
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          snap = await apiAuth(
            `${API}/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&cid=${cid}&index=1`,
            { what: '取故事板（videoshot）' },
          )
          lastErr = null
        } catch (e) {
          snap = {}
          lastErr = e
        }
        entries = snapshotEntries(snap, covered)
        if (!entries.length) entries = await entriesFromPvdata(snap, headers)
        if (entries.length && Array.isArray(snap?.image) && snap.image.length) break
        if (attempt === 0) await sleep(800)
      }

      const sheets = Array.isArray(snap?.image) ? snap.image.map(httpsUrl).filter(Boolean) : []
      if (!entries.length || !sheets.length) {
        const detail = lastErr?.message ? `（最后一次错误：${lastErr.message}）` : ''
        return { ok: false, frames: [], hint: `取不到故事板（试了 2 次）${detail}` }
      }

      // 以故事板实测到的最后一刻为准，通常比标称时长短 1~10%
      const storyMax = Math.max(...entries.map((e) => e.sec))
      if (storyMax > 0) covered = Math.min(covered || storyMax, storyMax)
      if (!(covered > 0)) covered = storyMax

      // 目标时间点
      let targets
      if (Array.isArray(at) && at.length) {
        targets = at
          .map((t) => Number(t))
          .filter((n) => Number.isFinite(n))
          .slice(0, MAX_FRAMES)
          .map((t) => Math.min(Math.max(0, t), Math.max(0, covered - 0.1)))
      } else {
        const n = Math.max(1, Math.min(MAX_FRAMES, Math.floor(Number(num) || 3)))
        targets = []
        for (let i = 0; i < n; i++) targets.push((covered * (i + 1)) / (n + 1))
      }
      if (!targets.length) return { ok: false, frames: [], hint: '没有可用的取帧时间点' }

      // 下载第一张拼图，探尺寸 → 决定 tile 大小和每张装几块
      const sheetCache = new Map()
      const sheetFile = async (no) => {
        if (sheetCache.has(no)) return sheetCache.get(no)
        if (no >= sheets.length) throw new BiliError(`故事板第 ${no} 张不存在（共 ${sheets.length} 张）`)
        const buf = await getBytes(sheets[no], { headers, what: `下载故事板第 ${no} 张` })
        const f = path.join(tmpDir, `sheet-${no}.img`)
        await fsp.writeFile(f, buf)
        const meta = { file: f, size: await imageSize(f) }
        sheetCache.set(no, meta)
        return meta
      }

      const first = await sheetFile(0)
      const { w: sheetW, h: sheetH } = first.size

      // tile 尺寸：优先接口给的 img_x_size/img_y_size
      let tw = Number(snap?.img_x_size) || 0
      let th = Number(snap?.img_y_size) || 0
      let cols = Number(snap?.img_x_len) || 0
      let rows = Number(snap?.img_y_len) || 0
      if (!tw || !th) {
        // 缺尺寸时用拼图实际宽高反推（有 len 就用 len，没有就按 5x5 推断）
        if (!cols || !rows) {
          cols = cols || 5
          rows = rows || 5
        }
        tw = Math.floor(sheetW / cols) || 160
        th = Math.floor(sheetH / rows) || 90
      }
      if (!cols) cols = Math.max(1, Math.floor(sheetW / tw))
      if (!rows) rows = Math.max(1, Math.floor(sheetH / th))
      const cap = Math.max(1, cols * rows) // 每张拼图装几块

      const out = []
      let lastFail = null
      for (const t of targets) {
        // 找时间上最近的一块
        let best = entries[0]
        let bestDiff = Infinity
        for (const e of entries) {
          const d = Math.abs(e.sec - t)
          if (d < bestDiff) {
            bestDiff = d
            best = e
          }
        }
        try {
          const sheetNo = Math.floor(best.tile / cap)
          const pos = best.tile % cap
          const col = pos % cols
          const row = Math.floor(pos / cols)
          const meta = await sheetFile(sheetNo)
          // 越界保护（个别视频给的 len 和实际拼图不一致）
          if ((col + 1) * tw > meta.size.w || (row + 1) * th > meta.size.h) {
            throw new BiliError(
              `裁切越界：tile=${best.tile} col=${col} row=${row} tw=${tw} th=${th} sheet=${meta.size.w}x${meta.size.h}`,
            )
          }
          const outPath = path.join(tmpDir, `frame-${out.length}.jpg`)
          const buf = await cropTile(meta.file, outPath, { tw, th, col, row })
          out.push({ buffer: buf, mimeType: sniffMime(buf) || 'image/jpeg', atMs: Math.round(best.sec * 1000) })
        } catch (e) {
          lastFail = e
        }
      }

      if (!out.length) {
        return { ok: false, frames: [], hint: `一帧都没裁出来${lastFail ? `：${lastFail.message}` : ''}` }
      }
      const hint = lastFail ? `有 ${targets.length - out.length} 帧失败：${lastFail.message}` : undefined
      return { ok: true, frames: out, ...(hint ? { hint } : {}) }
    } catch (e) {
      return { ok: false, frames: [], hint: e?.message || String(e) }
    } finally {
      await cleanup()
    }
  }

  // ---------------- 返回

  return {
    loadCred,
    saveCred,
    hasCred,
    whoami,
    search,
    videoInfo,
    subtitle,
    comments,
    coverBuffer,
    frames,
  }
}

export default makeBili
