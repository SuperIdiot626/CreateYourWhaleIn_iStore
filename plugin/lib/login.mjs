/**
 * lib/login.mjs —— B站 扫码登录（纯 Node，不依赖 Python）。
 *
 * 流程（B站 passport 网页端那套）：
 *   1. `GET /x/passport-login/web/qrcode/generate` → { url, qrcode_key }
 *   2. 把 url 画成 PNG 给主人扫（qrcode 包）
 *   3. `GET /x/passport-login/web/qrcode/poll?qrcode_key=...`
 *      code: 0=成功 / 86101=未扫码 / 86090=扫了待确认 / 86038=过期
 *   4. ⭐ **凭证在轮询响应的 `Set-Cookie` 头里**，不在 `data.url` 里
 *      （data.url 是跨域跳转地址，里面没有 SESSDATA）—— 这是参考实现踩过的坑，别再试 data.url。
 *
 * buvid3 有时不在这一跳的 Set-Cookie 里，补一次 nav 请求从它的 Set-Cookie 里捞。
 * 二维码约 180 秒有效；本模块只负责"出码/查结果/存凭据"，催人扫码由上层 agent 负责。
 */
import fs from 'node:fs'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const REFERER = 'https://www.bilibili.com/'

/** 发起请求：保留 Set-Cookie（fetch 的 headers 有 getSetCookie 就用它）。 */
async function rawRequest(url, { timeoutMs = 15000, redirect = 'manual' } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: REFERER },
      signal: ctrl.signal,
      redirect,
    })
    let setCookies = []
    try {
      setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    } catch { setCookies = [] }
    let json = null
    try { json = await res.json() } catch { json = null }
    return { status: res.status, json, setCookies }
  } finally {
    clearTimeout(timer)
  }
}

const COOKIE_NAME_MAP = {
  sessdata: 'sessdata',
  bili_jct: 'bili_jct',
  buvid3: 'buvid3',
  dedeuserid: 'dedeuserid',
}

/** 从 `Set-Cookie` 数组里抠出我们要的四个字段（大小写不敏感）。 */
export function pickCredentials(setCookies) {
  const out = { sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '' }
  for (const line of Array.isArray(setCookies) ? setCookies : []) {
    const pair = String(line).split(';')[0]
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim().toLowerCase()
    const target = COOKIE_NAME_MAP[name]
    if (!target) continue
    let value = pair.slice(eq + 1).trim()
    // SESSDATA 在 cookie 里是 URL 编码过的（%2C 之类），存的时候解掉
    if (target === 'sessdata') {
      try { value = decodeURIComponent(value) } catch { /* 解不开就用原值 */ }
    }
    out[target] = value
  }
  return out
}

/** 兜底：从成功回调 URL 的查询串里抠（正常用不上，留作双保险）。 */
export function parseCredentialFromUrl(url) {
  const out = { sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '' }
  try {
    const u = new URL(url, 'https://www.bilibili.com/')
    for (const key of ['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID']) {
      const v = u.searchParams.get(key) || u.searchParams.get(key.toLowerCase()) || ''
      if (!v) continue
      const target = key === 'DedeUserID' ? 'dedeuserid' : key.toLowerCase()
      out[target] = v
    }
  } catch { /* 解析不了就返回空 */ }
  return out
}

/** buvid3 不在登录那一跳的 Set-Cookie 里时，用一次 nav 把它捞出来。 */
async function ensureBuvid3(cred) {
  if (cred.buvid3) return cred
  try {
    const nav = await rawRequest('https://api.bilibili.com/x/web-interface/nav')
    const more = pickCredentials(nav.setCookies)
    if (more.buvid3) cred.buvid3 = more.buvid3
  } catch { /* 捞不到就不带（大部分接口不强制要 buvid3） */ }
  return cred
}

export async function loginStart({ stateDir }) {
  const { status, json, setCookies } = await rawRequest(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
  )
  const data = json?.data || {}
  if (status !== 200 || !data.url || !data.qrcode_key) {
    throw new Error(`生成二维码失败（HTTP ${status}，code=${json?.code}）：${json?.message || '无返回'}`)
  }
  // 出码这一跳有时也会塞 buvid3（不是必须，但可以顺手留着）
  const seed = pickCredentials(setCookies)
  let png = ''
  try {
    const QRCode = (await import('qrcode')).default
    fs.mkdirSync(stateDir, { recursive: true })
    png = path.join(stateDir, `bili-qr-${String(data.qrcode_key).slice(0, 8)}.png`)
    await QRCode.toFile(png, String(data.url), { margin: 1, width: 480 })
  } catch {
    png = '' // 画不出 PNG 不算致命：上层还能把 url 交出去
  }
  return { qrcodeKey: String(data.qrcode_key), url: String(data.url), png, seedBuvid3: seed.buvid3 || '' }
}

const POLL_MAP = {
  0: 'ok',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
}

export async function loginPoll({ qrcodeKey, seedBuvid3 = '' }) {
  const key = String(qrcodeKey || '').trim()
  if (!key) throw new Error('qrcode_key 不能为空')
  const { status, json, setCookies } = await rawRequest(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
  )
  const data = json?.data || {}
  const code = Number(data.code)
  const state = POLL_MAP[code] || (status === 200 ? 'unknown' : 'error')

  if (state === 'ok') {
    const cred = pickCredentials(setCookies)
    // 双保险：万一日后 Set-Cookie 没了，从回调 URL 里再抠一次
    if (!cred.sessdata) {
      const fromUrl = parseCredentialFromUrl(String(data.url || ''))
      for (const k of Object.keys(cred)) if (!cred[k] && fromUrl[k]) cred[k] = fromUrl[k]
    }
    if (!cred.buvid3 && seedBuvid3) cred.buvid3 = seedBuvid3
    if (cred.sessdata && !cred.buvid3) await ensureBuvid3(cred)
    const complete = Boolean(cred.sessdata && cred.bili_jct)
    return {
      state,
      credential: complete ? cred : null,
      hint: complete ? '' : '登录成功了，但响应里没拿到完整 cookie（SESSDATA/bili_jct）——重试一次或换登录方式',
    }
  }

  const hint = state === 'expired'
    ? '二维码已过期，重新申请一张'
    : state === 'scanned'
      ? '已扫码，等手机确认'
      : state === 'waiting'
        ? '还没扫'
        : `未知状态（code=${code}，message=${json?.message || ''}）`
  return { state, hint }
}
