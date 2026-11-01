/**
 * lib/login.selftest.mjs —— 扫码登录模块自测。
 *
 * 能测的（不需要真的扫码）：
 *   1. `pickCredentials` 从 Set-Cookie 里抠凭据（含 SESSDATA 的 URL 解码）；
 *   2. `parseCredentialFromUrl` 兜底路径；
 *   3. 真实出码 + 一次轮询（state 应为 waiting 或 scanned）。
 * 不能测的：扫码成功那一刻 —— 需要人拿手机扫，留给真机验收。
 */
import assert from 'node:assert'
import { pickCredentials, parseCredentialFromUrl, loginStart, loginPoll } from './login.mjs'

// 1) Set-Cookie → 凭据
const setCookies = [
  'SESSDATA=abc%2Cdef%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
  'bili_jct=JCT123; Path=/; Domain=.bilibili.com',
  'DedeUserID=50739937; Path=/; Domain=.bilibili.com',
  'buvid3=BUVID3-XYZ; Path=/',
  'bili_ticket=OTHER; Path=/',
]
const cred = pickCredentials(setCookies)
assert.equal(cred.sessdata, 'abc,def,123', 'SESSDATA 要解码')
assert.equal(cred.bili_jct, 'JCT123')
assert.equal(cred.dedeuserid, '50739937')
assert.equal(cred.buvid3, 'BUVID3-XYZ')
console.log('✅ pickCredentials: ', JSON.stringify({ ...cred, sessdata: '***' }))

// 2) 空数组 / 缺字段
assert.deepEqual(pickCredentials([]), { sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '' })
assert.equal(pickCredentials(['SESSDATA=only; Path=/']).bili_jct, '')
console.log('✅ 缺字段/空输入不炸')

// 3) 兜底 URL 解析
const fromUrl = parseCredentialFromUrl('https://passport.biligame.com/crossDomain?DedeUserID=42&SESSDATA=s%2C1&bili_jct=j&buvid3=b')
assert.equal(fromUrl.dedeuserid, '42')
assert.equal(fromUrl.sessdata, 's,1')
console.log('✅ parseCredentialFromUrl 兜底')

// 4) 真·出码 + 一次轮询
const r = await loginStart({ stateDir: '/tmp/whale-login-selftest' })
assert.ok(r.qrcodeKey && r.url, '出码应返回 key + url')
console.log(`✅ loginStart: key=${r.qrcodeKey.slice(0, 8)}… png=${r.png || '(无)'} seedBuvid3=${r.seedBuvid3 ? '有' : '无'}`)
const p = await loginPoll({ qrcodeKey: r.qrcodeKey, seedBuvid3: r.seedBuvid3 })
assert.ok(['waiting', 'scanned'].includes(p.state), `poll 状态异常：${p.state} ${p.hint || ''}`)
console.log(`✅ loginPoll: state=${p.state} hint=${p.hint || ''}`)

console.log('\n全部通过 ✓（扫码成功那一步需要真机扫一次）')
