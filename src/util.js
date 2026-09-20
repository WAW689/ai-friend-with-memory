/**
 * 基础工具：时间、随机、文件读写、日志。
 * 这个项目刻意做到零第三方依赖，所以这里的东西都是手写的。
 */
import fs from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------------ 时间 */

/** 当前时间戳（毫秒） */
export function now() {
  return Date.now()
}

/** 本地时区的 YYYY-MM-DD */
export function localDateKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时区的 HH:MM */
export function localClock(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 本地时区的小时数（0-23），用于静默时段判断 */
export function localHour(ts = Date.now()) {
  return new Date(ts).getHours()
}

export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE

/**
 * 把时间差说成人话，喂给模型时比裸时间戳有用得多。
 * 例：刚刚 / 12 分钟前 / 3 小时前 / 2 天前
 */
export function humanAgo(ts, from = Date.now()) {
  if (!ts) return '从未'
  const diff = from - ts
  if (diff < 0) return '刚刚'
  const m = Math.floor(diff / MINUTE)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

/** 把毫秒数说成"2 小时 15 分钟"这种人话 */
export function humanDuration(ms) {
  const m = Math.max(0, Math.floor(ms / MINUTE))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分钟`
}

/* ------------------------------------------------------------------ 随机 */

/** [min, max] 闭区间整数 */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 从一个数组里随机取一个 */
export function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

/* ------------------------------------------------------------------ 文件 */

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function readJson(file, fallback = undefined) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text)
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    log.warn(`读取 ${path.basename(file)} 失败，使用默认值：${err.message}`)
    return fallback
  }
}

/**
 * 原子写：先写临时文件再 rename。
 * 断电/崩溃时不会留下半个 JSON 文件。
 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** 追加一行 JSONL */
export function appendJsonl(file, value) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/** 逐行读 JSONL，坏行直接跳过（宁可丢一行，不要让整个服务起不来） */
export function readJsonl(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // 忽略损坏的行
    }
  }
  return out
}

/* ------------------------------------------------------------------ 日志 */

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

export const log = {
  info: (...args) => console.log(`[${stamp()}]`, ...args),
  warn: (...args) => console.warn(`[${stamp()}] ⚠`, ...args),
  error: (...args) => console.error(`[${stamp()}] ✖`, ...args),
}

/* ------------------------------------------------------------------ 其他 */

/** 生成一个足够随机的 token，用于单用户鉴权 */
export function randomToken(bytes = 24) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 截断字符串，用于日志 */
export function truncate(text, max = 60) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

/** 睡一会儿 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
