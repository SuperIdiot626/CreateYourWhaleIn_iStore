/**
 * lib/limits.mjs —— 写操作的「每日额度 + 最小间隔 + 风控冷却」。
 *
 * 只做三件事，但每件都写死：
 *   1. 每个动作每天有上限（跨天按 Asia/Shanghai 零点重置）；
 *   2. 同类动作之间有最小间隔（防手滑连点）；
 *   3. 撞风控（B站 返回 -352 / 412 / "请求过于频繁"）⇒ 冷却 N 分钟，冷却里直接拒。
 *
 * 状态文件是普通 JSON，坏了就当空账（宁可少数一次，也不要因为状态坏了永远写不了）。
 */
import fs from 'node:fs'
import path from 'node:path'

function todayKey() {
  try {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

export function makeLimits({ stateFile }) {
  const empty = () => ({ day: todayKey(), counts: {}, lastAt: {}, cooldownUntil: 0 })

  const load = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (!raw || typeof raw !== 'object') return empty()
      if (raw.day !== todayKey()) return { ...empty(), cooldownUntil: Number(raw.cooldownUntil) || 0 }
      return {
        day: raw.day,
        counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
        lastAt: raw.lastAt && typeof raw.lastAt === 'object' ? raw.lastAt : {},
        cooldownUntil: Number(raw.cooldownUntil) || 0,
      }
    } catch {
      return empty()
    }
  }

  const save = (st) => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
      fs.renameSync(tmp, stateFile)
    } catch { /* 写不了就下次再说 */ }
  }

  /** 现在能不能做 kind；不能就返回原因（can 只读，不记账）。 */
  const can = (kind, { perDay, minGapMs }) => {
    const st = load()
    const now = Date.now()
    if (st.cooldownUntil > now) {
      const mins = Math.ceil((st.cooldownUntil - now) / 60000)
      return { ok: false, reason: 'cooldown', hint: `撞风控冷却中，还要 ${mins} 分钟` }
    }
    const used = Number(st.counts[kind]) || 0
    const limit = Math.max(0, Number(perDay) || 0)
    if (limit <= 0) return { ok: false, reason: 'disabled', hint: '该动作的每日额度是 0（设置里关着）' }
    if (used >= limit) return { ok: false, reason: 'quota', hint: `今天已经用满（${used}/${limit}）` }
    const last = Number(st.lastAt[kind]) || 0
    const gap = Math.max(0, Number(minGapMs) || 0)
    if (last && now - last < gap) {
      return { ok: false, reason: 'too_fast', hint: `太快了，至少隔 ${Math.round(gap / 1000)} 秒` }
    }
    return { ok: true, used, limit }
  }

  /** 记一次成功动作。 */
  const note = (kind) => {
    const st = load()
    st.counts[kind] = (Number(st.counts[kind]) || 0) + 1
    st.lastAt[kind] = Date.now()
    save(st)
  }

  /** 撞风控：进入冷却。 */
  const cooldown = (minutes) => {
    const st = load()
    st.cooldownUntil = Date.now() + Math.max(1, Number(minutes) || 30) * 60_000
    save(st)
  }

  /** 给 bili_status 用的快照。 */
  const snapshot = () => {
    const st = load()
    return { day: st.day, counts: st.counts, cooldownUntil: st.cooldownUntil, cooling: st.cooldownUntil > Date.now() }
  }

  return { can, note, cooldown, snapshot, todayKey }
}
