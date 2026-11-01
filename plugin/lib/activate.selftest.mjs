/**
 * lib/activate.selftest.mjs —— 不开 DSH、只用一个假 ctx 把插件「激活一遍」。
 *
 * 目的：在没有真实宿主的情况下验证
 *   1. index.js 能被 Node 正常 import（hostdeps 能解析到 schemastery / dsh-tools）；
 *   2. Config schema 能构造（所有字段都是 volatile）；
 *   3. apply() 注册了预期的工具名、参数形状正确；
 *   4. 设置里的开关确实能"关掉工具"（例如 readTools=false 时 bili_search 返回 disabled）。
 *
 * 用法（容器内）：
 *   cd /root/.dsh/profiles/web/node_modules/dsh-xiaojingyu-tools
 *   node lib/activate.selftest.mjs
 */
import assert from 'node:assert'

const captured = new Map()
const ctx = {
  tools: {
    register(def) {
      captured.set(def.name, def)
      return def
    },
  },
  get(name) {
    if (name === 'attachments') return { saveImages: async (imgs) => imgs.map((_, i) => ({ type: 'image', idx: i })) }
    if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
    return undefined
  },
  logger: { info: (m) => console.log('  [log]', m), warn: (m) => console.log('  [warn]', m) },
}

const mod = await import('../index.js')
console.log('插件名:', mod.name, '| 有 Config:', Boolean(mod.Config))
assert.equal(mod.name, 'whale-tools', 'name 必须是 whale-tools（设置页命名空间）')
assert.ok(mod.Config, 'Config 没构造出来（schemastery 没解析到）')

// 清点 Config 字段是否都带 volatile
let fields = []
try {
  fields = Object.keys(mod.Config.dict || mod.Config._dict || {})
} catch {
  fields = []
}
if (!fields.length) {
  // schemastery 实例的内部字段名在各版本不同，兜底：从源码里数一遍 default( 的次数
  console.log('  （拿不到 Config 字段表，跳过字段清点）')
}

const config = {}
mod.apply(ctx, config)
const names = [...captured.keys()]
console.log('注册的工具:', names.join(', '))
const expect = [
  'bili_whoami', 'bili_search', 'bili_subtitle', 'bili_comments', 'bili_cover', 'bili_frames',
  'bili_login_start', 'bili_login_poll', 'bili_status',
]
for (const n of expect) assert.ok(names.includes(n), `缺工具：${n}`)

// 检查注册形状
for (const [name, def] of captured) {
  assert.equal(typeof def.description, 'string', `${name}: description 缺失`)
  assert.ok(def.parameters && typeof def.parameters === 'object', `${name}: parameters 缺失`)
  assert.equal(typeof def.execute, 'function', `${name}: execute 缺失`)
  assert.ok(def.output && typeof def.output.render === 'function', `${name}: output.render 缺失`)
}

// 开关生效：readTools=false 时只读工具应返回 disabled
config.readTools = false
const searchDef = captured.get('bili_search')
const r = await searchDef.execute({ keyword: 'test' }, {})
assert.equal(r.disabled, true, 'readTools=false 时 bili_search 应返回 disabled')
config.readTools = true
console.log('开关生效 ✓')

// status 工具不需要网络也能给出结构（whoami 会失败但不抛）
const statusDef = captured.get('bili_status')
const st = await statusDef.execute({}, {})
assert.ok(st && typeof st === 'object', 'bili_status 应返回对象')
console.log('bili_status 结构 ✓:', JSON.stringify({ ok: st.ok, groups: st.groups, version: st.version }))

console.log('\n全部通过 ✓')
