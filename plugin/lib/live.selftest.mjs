/**
 * lib/live.selftest.mjs —— 用真实 B站 接口把 9 个工具各跑一遍（只读，不发任何写操作）。
 *
 * 用法（容器内）：
 *   cd /root/.dsh/profiles/web/node_modules/dsh-xiaojingyu-tools
 *   node lib/live.selftest.mjs [bvid]
 */
const captured = new Map()
const saved = []
const ctx = {
  tools: { register: (def) => { captured.set(def.name, def); return def } },
  get(name) {
    if (name === 'attachments') {
      return { saveImages: async (imgs) => { saved.push(...imgs); return imgs.map((_, i) => ({ type: 'image', idx: i })) } }
    }
    if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
    return undefined
  },
  logger: { info: () => {}, warn: () => {} },
}

const mod = await import('../index.js')
const config = {}
mod.apply(ctx, config)

const bvid = process.argv[2] || 'BV1VkgK6NEZS'
const t = (label, fn) => {
  const t0 = Date.now()
  return fn().then((r) => {
    const brief = JSON.stringify({
      ok: r?.ok,
      disabled: r?.disabled,
      chars: typeof r?.text === 'string' ? r.text.length : undefined,
      items: Array.isArray(r?.items) ? r.items.length : undefined,
      images: Array.isArray(r?.images) ? r.images.length : undefined,
      image: r?.image ? 1 : undefined,
      state: r?.state,
      hint: r?.hint,
      err: r?.error,
    })
    console.log(`${label.padEnd(16)} ${String(Date.now() - t0).padStart(5)}ms  ${brief}`)
    return r
  }).catch((e) => console.log(`${label.padEnd(16)} ERR ${e.message}`))
}

console.log(`bvid = ${bvid}\n`)
await t('bili_whoami', () => captured.get('bili_whoami').execute({}, {}))
await t('bili_search', () => captured.get('bili_search').execute({ keyword: 'DeepSeek', num: 3 }, {}))
await t('bili_subtitle', () => captured.get('bili_subtitle').execute({ bvid }, {}))
await t('bili_comments', () => captured.get('bili_comments').execute({ bvid, num: 5 }, {}))
await t('bili_cover', () => captured.get('bili_cover').execute({ bvid }, {}))
await t('bili_frames', () => captured.get('bili_frames').execute({ bvid, num: 3 }, {}))
await t('bili_frames@', () => captured.get('bili_frames').execute({ bvid, at: [1, 5] }, {}))
await t('bili_status', () => captured.get('bili_status').execute({}, {}))

// 登录工具：只测"出码 + 查一次"，不扫码
const start = await t('bili_login_start', () => captured.get('bili_login_start').execute({}, {}))
if (start?.key) await t('bili_login_poll', () => captured.get('bili_login_poll').execute({ key: start.key }, {}))

console.log(`\n附件服务收到图片 ${saved.length} 张（封面/帧都走它）`)
process.exit(0)
