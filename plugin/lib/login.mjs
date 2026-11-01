/**
 * lib/login.mjs —— B站 扫码登录（纯 Node，不依赖 Python）。
 *
 * 流程（B站 passport 网页端那套）：
 *   1. `GET /x/passport-login/web/qrcode/generate` → { url, qrcode_key }
 *   2. 把 url 画成 PNG 给主人扫（qrcode 包）
 *   3. `GET /x/passport-login/web/qrcode/poll?qrcode_key=...`
 *      code: 0=成功 / 86101=未扫码 / 86090=扫了待确认 / 86038=过期
 *   4. 成功时返回的 data.url 里带着 SESSDATA / bili_jct / buvid3 / dedeuserid，抠出来存凭证
 *
 * 二维码约 180 秒有效；本模块只负责"出码/查结果/存凭据"，催人扫码由上层 agent 负责。
 */
import fs from 'node:fs'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function getJson(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    if (!json) throw new Error(`返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`)
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

/** 从 B站 成功回调 URL 的查询串里抠凭据 */
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

export async function loginStart({ stateDir }) {
  const { status, json } = await getJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
  const data = json?.data || {}
  if (status !== 200 || !data.url || !data.qrcode_key) {
    throw new Error(`生成二维码失败（HTTP ${status}，code=${json?.code}）：${json?.message || '无返回'}`)
  }
  let png = ''
  try {
    const QRCode = (await import('qrcode')).default
    fs.mkdirSync(stateDir, { recursive: true })
    png = path.join(stateDir, `bili-qr-${data.qrcode_key.slice(0, 8)}.png`)
    await QRCode.toFile(png, String(data.url), { margin: 1, width: 480 })
  } catch (error) {
    png = ''
    // 画不出 PNG 不算致命：还能把 url 交出去让上层自己想办法
    if (error) { /* 交给上层提示 */ }
  }
  return { qrcodeKey: String(data.qrcode_key), url: String(data.url), png }
}

const POLL_MAP = {
  0: 'ok',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
}

export async function loginPoll({ qrcodeKey }) {
  const key = String(qrcodeKey || '').trim()
  if (!key) throw new Error('qrcode_key 不能为空')
  const { status, json } = await getJson(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
  )
  const data = json?.data || {}
  const code = Number(data.code)
  const state = POLL_MAP[code] || (status === 200 ? 'unknown' : 'error')
  if (state === 'ok') {
    const cred = parseCredentialFromUrl(String(data.url || ''))
    const complete = Boolean(cred.sessdata && cred.bili_jct)
    return { state, credential: complete ? cred : null, hint: complete ? '' : '登录成功但没解析到完整 cookie，请重试一次' }
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
