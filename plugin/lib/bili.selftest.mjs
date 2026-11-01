/**
 * lib/bili.selftest.mjs —— bili.mjs 的自测脚本
 * ============================================================================
 * 在容器里直接跑：
 *   node /tmp/bili.selftest.mjs
 * 可选环境变量：
 *   BILI_TEST_BVID   指定测试用 BVID（不给就自己找）
 *   BILI_CRED_PATH   凭据路径（默认容器里那个）
 *
 * ⚠️ 只跑只读接口。saveCred 的验证写在 /tmp 下的临时路径，**绝不动线上凭据**。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeBili } from './bili.mjs'

const CRED_PATH = process.env.BILI_CRED_PATH || '/root/.dsh/surfcore/bili/credentials.json'
const STATE_DIR = '/root/.dsh/surfcore/state'

// 日志：模块自己打的日志收集起来，最后一起显示（不参与脱敏的只有我们自己打的）
const logs = []
const bili = makeBili({
  credentialsPath: CRED_PATH,
  log: (...a) => logs.push(a.map((x) => String(x)).join(' ')),
})

const C = {
  ok: (s) => `\u2705 ${s}`,
  bad: (s) => `\u274c ${s}`,
  warn: (s) => `\u26a0\ufe0f  ${s}`,
}
const results = [] // { name, ok, ms, detail }

async function timed(name, fn) {
  const t0 = Date.now()
  let out
  let ok = true
  let detail = ''
  try {
    out = await fn()
    ok = out?.ok !== false
    detail = out?.hint || ''
  } catch (e) {
    ok = false
    out = null
    detail = `抛异常：${e?.message || e}`
  }
  const ms = Date.now() - t0
  results.push({ name, ok, ms, detail })
  return { out, ok, ms, detail }
}

/** 脱敏：mid 只说存不存在；uname 只露首字 */
function maskMid(mid) {
  return mid ? `存在（不打印）` : '无'
}
function maskName(u) {
  const s = String(u || '')
  if (!s) return '空'
  return `${s.slice(0, 1)}***（长度 ${s.length}）`
}

function kb(n) {
  return `${(n / 1024).toFixed(1)}KB`
}

/** 从本地状态文件里捞一个最近出现过的 BVID */
function bvidFromLocalState() {
  const files = [
    path.join(STATE_DIR, 'social-v2.json'),
    path.join(STATE_DIR, 'qq-activity.log'),
    path.join(STATE_DIR, 'bili-memory.json'),
    path.join(STATE_DIR, 'bridge.log'),
  ]
  for (const f of files) {
    try {
      const txt = fs.readFileSync(f, 'utf8')
      const m = txt.match(/BV[0-9A-Za-z]{10}/g)
      if (m && m.length) return { bvid: m[m.length - 1], from: f }
    } catch {
      /* 没有就跳过 */
    }
  }
  return null
}

async function findBvid() {
  if (process.env.BILI_TEST_BVID) {
    return { bvid: process.env.BILI_TEST_BVID.trim(), from: 'env BILI_TEST_BVID' }
  }
  const local = bvidFromLocalState()
  if (local) return local
  // 实在找不到就搜一个
  for (const kw of ['DeepSeek Harness', 'DeepSeek']) {
    const r = await bili.search({ keyword: kw, num: 5 })
    const hit = r?.items?.find((x) => x.bvid)
    if (hit) return { bvid: hit.bvid, from: `search("${kw}")` }
  }
  return null
}

function line() {
  console.log('-'.repeat(72))
}

async function main() {
  console.log('=== bili.mjs 自测 ===')
  console.log(`node            : ${process.version}`)
  console.log(`platform        : ${process.platform} ${process.arch}`)
  console.log(`cwd             : ${process.cwd()}`)
  console.log(`凭据路径        : ${CRED_PATH}`)
  line()

  // ---------- 0. 凭据本地操作（用临时路径，不碰线上） ----------
  console.log('[0] 凭据读写（临时路径，不动线上文件）')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-credtest-'))
  const tmpCred = path.join(tmpDir, 'sub', 'cred.json')
  const b2 = makeBili({ credentialsPath: tmpCred, log: () => {} })
  try {
    const before = b2.hasCred()
    console.log(`    hasCred（文件不存在）= ${before}（应为 false）`)
    b2.saveCred({ sessdata: 'fake-sessdata', bili_jct: 'jct', buvid3: 'bv', dedeuserid: '42' })
    const after = b2.hasCred()
    const got = b2.loadCred()
    const mode = (fs.statSync(tmpCred).mode & 0o777).toString(8)
    const okAll =
      before === false &&
      after === true &&
      got?.sessdata === 'fake-sessdata' &&
      got?.dedeuserid === '42' &&
      mode === '600'
    console.log(`    hasCred（写入后）  = ${after}（应为 true）`)
    console.log(`    loadCred 字段回读  = ${got ? Object.keys(got).join(',') : 'null'}（应含 4 个字段）`)
    console.log(`    文件权限           = ${mode}（应为 600）`)
    console.log(`    ${okAll ? C.ok('凭据读写 OK') : C.bad('凭据读写有问题')}`)

    // 覆盖写也要能工作（原子 rename）
    b2.saveCred({ sessdata: 'fake2' })
    const got2 = b2.loadCred()
    console.log(`    覆盖写回读 sessdata = ${got2?.sessdata}（应为 fake2）`)
    console.log(`    其它字段保留        = ${got2?.dedeuserid}（应为 42，向前兼容）`)
    const ok2 = got2?.sessdata === 'fake2' && got2?.dedeuserid === '42'
    results.push({ name: 'saveCred/loadCred/hasCred', ok: okAll && ok2, ms: 0, detail: '' })
  } catch (e) {
    console.log(`    ${C.bad('凭据测试抛异常：' + (e?.message || e))}`)
    results.push({ name: 'saveCred/loadCred/hasCred', ok: false, ms: 0, detail: e?.message || '' })
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  line()

  // ---------- 1. whoami ----------
  console.log('[1] whoami（登录态）')
  const who = await timed('whoami', () => bili.whoami())
  if (who.out) {
    console.log(`    耗时   : ${who.ms}ms`)
    console.log(`    ok     : ${who.out.ok}`)
    console.log(`    已登录 : ${who.out.loggedIn}`)
    console.log(`    mid    : ${maskMid(who.out.mid)}`)
    console.log(`    uname  : ${maskName(who.out.uname)}`)
    console.log(`    头像   : ${who.out.avatarUrl ? '有（' + who.out.avatarUrl.length + ' 字符 URL）' : '无'}`)
    if (who.out.hint) console.log(`    hint   : ${who.out.hint}`)
    console.log(`    ${who.out.loggedIn ? C.ok('已登录') : C.warn('未登录（后面需要登录的接口可能失败）')}`)
  } else {
    console.log(`    ${C.bad('whoami 失败：' + who.detail)}（${who.ms}ms）`)
  }
  line()

  // ---------- 2. search ----------
  console.log('[2] search({keyword:"DeepSeek", num:3})')
  const search = await timed('search', () => bili.search({ keyword: 'DeepSeek', num: 3 }))
  if (search.out?.ok) {
    console.log(`    耗时   : ${search.ms}ms`)
    console.log(`    条数   : ${search.out.items.length}`)
    search.out.items.forEach((it, i) => {
      console.log(`    ${i + 1}. ${it.title}`)
      console.log(`       ${it.bvid} | ${it.author} | ${it.play} 播放 | ${it.duration}s`)
    })
  } else {
    console.log(`    ${C.bad('search 失败：' + (search.detail || '未知'))}（${search.ms}ms）`)
  }
  line()

  // ---------- 3. 找 BVID ----------
  console.log('[3] 选一个 BVID')
  const pick = await findBvid()
  if (!pick) {
    console.log(`    ${C.bad('找不到任何 BVID，后面全跳过')}`)
    return finish()
  }
  const BVID = pick.bvid
  console.log(`    BVID : ${BVID}`)
  console.log(`    来源 : ${pick.from}`)
  line()

  // ---------- 4. videoInfo ----------
  console.log('[4] videoInfo')
  const vi = await timed('videoInfo', () => bili.videoInfo(BVID))
  if (vi.out?.ok) {
    console.log(`    耗时   : ${vi.ms}ms`)
    console.log(`    标题   : ${vi.out.title}`)
    console.log(`    aid    : ${vi.out.aid ? '有' : '无'}  cid: ${vi.out.cid ? '有' : '无'}`)
    console.log(`    时长   : ${vi.out.duration}s`)
    console.log(`    UP     : ${vi.out.owner?.name || ''}`)
    console.log(`    封面   : ${vi.out.pic ? '有' : '无'}`)
    console.log(`    ${C.ok('videoInfo OK')}`)
  } else {
    console.log(`    ${C.bad('videoInfo 失败：' + vi.detail)}（${vi.ms}ms）`)
  }
  line()

  // ---------- 5. subtitle ----------
  console.log('[5] subtitle')
  const sub = await timed('subtitle', () => bili.subtitle(BVID))
  if (sub.out?.ok) {
    console.log(`    耗时   : ${sub.ms}ms`)
    console.log(`    语言   : ${sub.out.lang}`)
    console.log(`    行数   : ${sub.out.lines.length}`)
    console.log(`    字数   : ${sub.out.text.length}`)
    console.log(`    首行   : ${(sub.out.lines[0]?.content || '').slice(0, 40)}`)
    if (sub.out.hint) console.log(`    hint   : ${sub.out.hint}`)
    // 校验 text 确实是 lines 拼起来的（未截断时）
    const joined = sub.out.lines.map((l) => l.content).join('\n')
    const consistent = sub.out.hint ? sub.out.text.length === 20000 : sub.out.text === joined
    console.log(`    text 与 lines 一致 : ${consistent}`)
    console.log(`    ${consistent ? C.ok('subtitle OK') : C.bad('subtitle 文本拼接不一致')}`)
    results[results.length - 1].ok = consistent
  } else {
    console.log(`    耗时   : ${sub.ms}ms`)
    if (sub.out) {
      console.log(`    主视频 : ${C.warn('没有字幕（正常结果，不算失败）')}`)
      console.log(`    hint   : ${sub.out.hint}`)
      results[results.length - 1].ok = true
      results[results.length - 1].detail = '主视频无字幕（正常）'
    } else {
      console.log(`    ${C.bad('subtitle 抛异常：' + sub.detail)}`)
    }

    // 无字幕时不能证明「成功路径」通 —— 从搜索结果里再找有字幕的补测
    console.log('    找一个有字幕的视频补测成功路径…')
    const cands = []
    for (const kw of ['DeepSeek', 'AI 编程', '科技']) {
      const s = await bili.search({ keyword: kw, num: 10 })
      for (const it of s.items || []) if (!cands.find((c) => c.bvid === it.bvid)) cands.push(it)
      if (cands.length >= 12) break
    }
    let hit = null
    const t1 = Date.now()
    for (const c of cands.slice(0, 12)) {
      const r = await bili.subtitle(c.bvid)
      if (r.ok) {
        hit = { bvid: c.bvid, r, ms: Date.now() - t1 }
        break
      }
    }
    if (hit) {
      const r = hit.r
      const joined = r.lines.map((l) => l.content).join('\n')
      const consistent = r.hint ? r.text.length === 20000 : r.text === joined
      console.log(`    ✓ ${hit.bvid} lang=${r.lang} ${r.text.length}字 ${r.lines.length}行 耗时=${hit.ms}ms`)
      console.log(`      首行: ${(r.lines[0]?.content || '').slice(0, 50)}`)
      console.log(`      from/to: ${JSON.stringify(r.lines.slice(0, 2).map((l) => [l.from, l.to]))}`)
      console.log(`      文本拼接一致: ${consistent}`)
      if (r.hint) console.log(`      hint: ${r.hint}`)
      console.log(`      ${consistent ? C.ok('subtitle 成功路径 OK') : C.bad('subtitle 文本拼接不一致')}`)
      results.push({ name: 'subtitle(有字幕样本)', ok: consistent, ms: hit.ms, detail: `${r.text.length}字/${r.lines.length}行` })
    } else {
      console.log(`    ${C.warn(`看了 ${Math.min(cands.length, 12)} 个视频都没字幕，成功路径未验证`)}`)
      results.push({ name: 'subtitle(有字幕样本)', ok: true, ms: 0, detail: '未找到有字幕样本（跳过）' })
    }
  }
  line()

  // ---------- 6. comments ----------
  console.log('[6] comments({num:30})')
  const cm = await timed('comments', () => bili.comments({ bvid: BVID, num: 30 }))
  if (cm.out?.ok) {
    console.log(`    耗时   : ${cm.ms}ms`)
    console.log(`    条数   : ${cm.out.items.length}`)
    if (cm.out.items[0]) {
      const f = cm.out.items[0]
      console.log(`    第一条 : 点赞=${f.like} 回复=${f.rcount} 用户=${maskName(f.uname)}`)
      console.log(`    内容   : ${f.message.replace(/\s+/g, ' ').slice(0, 60)}`)
    }
    console.log(`    ${C.ok('comments OK')}`)
  } else {
    console.log(`    ${C.bad('comments 失败：' + cm.detail)}（${cm.ms}ms）`)
  }
  line()

  // ---------- 7. coverBuffer ----------
  console.log('[7] coverBuffer')
  const cv = await timed('coverBuffer', () => bili.coverBuffer(BVID))
  if (cv.out?.ok) {
    console.log(`    耗时   : ${cv.ms}ms`)
    console.log(`    字节   : ${cv.out.buffer.length}（${kb(cv.out.buffer.length)}）`)
    console.log(`    mime   : ${cv.out.mimeType}`)
    console.log(`    ${C.ok('coverBuffer OK')}`)
  } else {
    console.log(`    ${C.bad('coverBuffer 失败：' + cv.detail)}（${cv.ms}ms）`)
  }
  line()

  // ---------- 8. frames ----------
  console.log('[8] frames({num:3})')
  const fr = await timed('frames', () => bili.frames({ bvid: BVID, num: 3 }))
  if (fr.out?.ok) {
    console.log(`    耗时   : ${fr.ms}ms`)
    console.log(`    帧数   : ${fr.out.frames.length}`)
    fr.out.frames.forEach((f, i) => {
      console.log(`    #${i} ${f.buffer.length} 字节（${kb(f.buffer.length)}） ${f.mimeType} atMs=${f.atMs}`)
      // 顺便校验真的是 JPEG
      const isJpeg = f.buffer[0] === 0xff && f.buffer[1] === 0xd8 && f.buffer[2] === 0xff
      if (!isJpeg) console.log(`       ${C.bad('不是 JPEG 魔数')}`)
    })
    if (fr.out.hint) console.log(`    hint   : ${fr.out.hint}`)
    const allJpeg = fr.out.frames.every((f) => f.buffer[0] === 0xff && f.buffer[1] === 0xd8)
    console.log(`    ${allJpeg ? C.ok('frames OK（都是合法 JPEG）') : C.bad('frames 有帧不是 JPEG')}`)
  } else {
    console.log(`    ${C.bad('frames 失败：' + fr.detail)}（${fr.ms}ms）`)
  }
  line()

  // ---------- 9. at 模式 ----------
  if (fr.out?.ok && vi.out?.ok) {
    const mid = Math.max(1, Math.round((vi.out.duration || 10) / 2))
    console.log(`[9] frames({at:[${mid}]}) —— 指定时点取帧`)
    const fa = await timed('frames(at)', () => bili.frames({ bvid: BVID, at: [mid] }))
    if (fa.out?.ok) {
      console.log(`    耗时   : ${fa.ms}ms`)
      console.log(`    帧数   : ${fa.out.frames.length}`)
      fa.out.frames.forEach((f, i) => {
        const sec = (f.atMs / 1000).toFixed(1)
        const diff = Math.abs(f.atMs / 1000 - mid).toFixed(1)
        console.log(`    #${i} ${kb(f.buffer.length)} atMs=${f.atMs}（${sec}s，离目标 ${mid}s 差 ${diff}s）`)
      })
      console.log(`    ${C.ok('frames(at) OK')}`)
    } else {
      console.log(`    ${C.bad('frames(at) 失败：' + fa.detail)}（${fa.ms}ms）`)
    }
    line()
  }

  await mockTests()

  return finish()
}

/**
 * 不打网络的确定性测试：WBI 签名过期重试、412 风控报错。
 * 做法是把 globalThis.fetch 换掉（模块里用的是全局 fetch，运行期解析）。
 */
async function mockTests() {
  const realFetch = globalThis.fetch

  console.log('[10] WBI 签名过期 → 刷新 keys 重试一次（mock fetch，不联网）')
  let navCount = 0
  let searchCount = 0
  const rids = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/x/web-interface/nav')) {
      navCount++
      // 每次 nav 给不同的 key，这样才能验证"确实换了新 key 重签"
      const k = String(navCount).repeat(32)
      return new Response(
        JSON.stringify({
          code: 0,
          data: { isLogin: true, mid: 1, uname: 'x', face: '', wbi_img: { img_url: `https://x/a/${k}.png`, sub_url: `https://x/b/${k}.png` } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (u.includes('/wbi/search/type')) {
      searchCount++
      rids.push(/w_rid=([0-9a-f]+)/.exec(u)?.[1] || '')
      // 第一次故意回 -403（签名过期典型症状），第二次成功
      if (searchCount === 1) {
        return new Response(JSON.stringify({ code: -403, message: '访问权限不足' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          code: 0,
          message: '0',
          data: { result: [{ bvid: 'BV1Rbxg6WER5', title: 'x', author: 'a', play: 1, duration: '01:02', pubdate: 1, description: 'd' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const b = makeBili({ credentialsPath: CRED_PATH, log: () => {} })
    const r = await b.search({ keyword: 'x', num: 1 })
    const okNav = navCount === 2 // 初始 1 次 + 重试前刷新 1 次
    const okRedo = searchCount === 2
    const okResign = rids.length === 2 && rids[0] && rids[1] && rids[0] !== rids[1]
    console.log(`    结果 ok=${r.ok} 条数=${r.items?.length}`)
    console.log(`    nav 次数=${navCount}（应为 2，说明刷新过 keys）`)
    console.log(`    search 次数=${searchCount}（应为 2，说明重试了一次）`)
    console.log(`    w_rid 换了=${okResign}（说明用新 key 重签）`)
    console.log(`    时长归一 "01:02" → ${r.items?.[0]?.duration}s（应为 62）`)
    const pass = r.ok && okNav && okRedo && okResign && r.items[0].duration === 62
    console.log(`    ${pass ? C.ok('WBI 重试 OK') : C.bad('WBI 重试不符合预期')}`)
    results.push({ name: 'WBI 重试(mock)', ok: pass, ms: 0, detail: '' })
  } catch (e) {
    console.log(`    ${C.bad('mock 测试抛异常：' + (e?.message || e))}`)
    results.push({ name: 'WBI 重试(mock)', ok: false, ms: 0, detail: e?.message || '' })
  }
  line()

  console.log('[11] HTTP 412 → 风控报错要能看懂（mock fetch）')
  globalThis.fetch = async () =>
    new Response('<html>blocked</html>', { status: 412, statusText: 'Precondition Failed' })
  try {
    const b = makeBili({ credentialsPath: CRED_PATH, log: () => {} })
    const r = await b.search({ keyword: 'x', num: 1 })
    console.log(`    ok=${r.ok}（应为 false）`)
    console.log(`    hint=${r.hint}`)
    const good = r.ok === false && /412/.test(r.hint || '') && /风控/.test(r.hint || '')
    console.log(`    ${good ? C.ok('412 报错可读') : C.bad('412 报错不可读')}`)
    results.push({ name: '412 风控报错(mock)', ok: good, ms: 0, detail: '' })
  } catch (e) {
    console.log(`    ${C.bad('mock 测试抛异常：' + (e?.message || e))}`)
    results.push({ name: '412 风控报错(mock)', ok: false, ms: 0, detail: e?.message || '' })
  } finally {
    globalThis.fetch = realFetch
  }
  line()
}

function finish() {
  console.log('=== 汇总 ===')
  let bad = 0
  for (const r of results) {
    const mark = r.ok ? '\u2705' : '\u274c'
    console.log(`${mark} ${r.name.padEnd(26)} ${String(r.ms).padStart(6)}ms  ${r.detail || ''}`)
    if (!r.ok) bad++
  }
  line()
  const total = results.reduce((s, r) => s + r.ms, 0)
  console.log(`共 ${results.length} 项，失败 ${bad} 项，累计耗时 ${total}ms`)
  if (logs.length) {
    console.log('--- 模块日志 ---')
    for (const l of logs) console.log(l)
  }
  process.exitCode = bad ? 1 : 0
}

main().catch((e) => {
  console.error('自测脚本崩了：', e?.stack || e)
  process.exitCode = 2
})
