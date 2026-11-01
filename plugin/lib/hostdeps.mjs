/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools`。
 *
 * 为什么要这么绕（不是我们发明的坑，是 DSH 插件的通用坑）：
 *   这两个包在插件里通常是 **optional peer**，桌面版 profile（`autoInstallPeers: false`）
 *   不会装它们 ⇒ 插件顶部裸 import 会让**整条插件不激活**，DSH 只留一句
 *   `warning: 1 entry did not activate … failed to import`。
 *
 * 策略（跟社区里通行的做法一致）：
 *   ① 先从"宿主那棵树"里解析（跟宿主用同一份，行为最一致）；
 *   ② 解析不到就 bare import（靠插件自己 dependencies 里那份保底）；
 *   ③ schemastery 彻底拿不到 ⇒ 返回 null，插件照常加载（只是没有设置页）。
 *      绝不因为一个依赖让整条插件不激活。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方（按可能性排序）。 */
function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    push(join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(appdata, 'npm', 'node_modules', '@deepseek-ai'))
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：别的插件可能把它 hoist 到 profile 根上
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of ['web', 'desktop', 'headless']) push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch { /* 没有就算了 */ }

  push(SELF_MODULES)
  return out
}

async function fromHostTree(pkg, notes) {
  for (const root of candidateRoots()) {
    for (const name of [`${pkg}`, `@deepseek-ai/${pkg}`]) {
      const dir = join(root, name)
      if (!existsSync(dir)) continue
      for (const entry of ['lib/index.mjs', 'lib/index.js', 'index.mjs', 'index.js', 'dist/index.js']) {
        const file = join(dir, entry)
        if (!existsSync(file)) continue
        try {
          const mod = await import(pathToFileURL(file).href)
          notes.push(`${pkg}：从宿主树取到（${file}）`)
          return mod
        } catch { /* 换下一个入口 */ }
      }
    }
  }
  return null
}

export async function loadHostDeps() {
  const notes = []

  let zMod = await fromHostTree('schemastery', notes)
  if (!zMod) {
    try {
      zMod = await import('@deepseek-ai/schemastery')
      notes.push('schemastery：宿主树里没有，用自己依赖里那份')
    } catch {
      notes.push('⚠️ schemastery 拿不到 —— 本插件没有 Config，设置页降级（插件照常跑）')
    }
  }
  const z = zMod?.default ?? zMod ?? null

  let dtMod = await fromHostTree('dsh-tools', notes)
  if (!dtMod) {
    try {
      dtMod = await import('@deepseek-ai/dsh-tools')
      notes.push('dsh-tools：宿主树里没有，用自己依赖里那份')
    } catch {
      notes.push('⚠️ dsh-tools 拿不到 —— 用本地等价实现顶上')
    }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options))

  return { z, defineTool, notes }
}

/**
 * `defineTool` 的最小等价实现（只在宿主的 dsh-tools 拿不到时用）。
 * 宿主认的就是 `{ name, description, parameters, output, execute }` 这么个形状。
 */
function localDefineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters || {},
    output: options.output || { schema: { type: 'object', properties: {}, additionalProperties: true } },
    execute: options.execute,
  }
}
