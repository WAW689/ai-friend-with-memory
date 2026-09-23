/**
 * 基础工具：时间、随机、文件读写、日志。
 * 这个项目刻意做到零第三方依赖，所以这里的东西都是手写的。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 同步睡一会儿（给重试用；sleep 是异步的，这里不能 await） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 原子写：先写临时文件再 rename。
 * 断电/崩溃时不会留下半个 JSON 文件。
 *
 * Windows 上 rename 会偶发 EPERM：杀毒软件、搜索索引、
 * 资源管理器预览都可能在这一瞬间占着目标文件。
 * 这类占用通常几毫秒就释放，所以**必须重试**——
 * 原来不重试，测试里出现过 "EPERM rename life-arcs.json.tmp-1234"
 * 这种难复现的偶发失败。
 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

  const RETRIES = 10
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      // 只有"被占用"才值得重试；其他错误（如目录不存在）重试也是白等
      const transient = err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY'
      if (!transient || i >= RETRIES) {
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* 清理失败就算了，别盖住真正的错误 */
        }
        throw err
      }
      sleepSync(5 + i * 5)
    }
  }
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

/** 本地时区的时间戳，形如 2026-09-23 09:58:12 */
function stamp(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/*
 * 日志往哪儿写。
 *
 * 日志目录默认是项目下的 logs/（和 data/ 平级）。测试会把它指到隔离目录，
 * 免得跑一遍测试就往真实日志里灌几百行。
 * 这里**不能**去 import config.js —— config.js 自己要用 log，会成环。
 */
const LOG_DIR = process.env.FRIEND_LOG_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs')

/**
 * 往 stdout 写会不会**卡死**。
 *
 * 这是本项目最阴的一个故障，现象是"服务还活着，但网页打不开、消息也不回"：
 *
 *   服务由计划任务拉起时没有控制台，stdout 是一个**没人读的管道**。
 *   Windows 上往管道写是同步的（POSIX 上不是），管道缓冲满了以后
 *   console.log 就会**永远阻塞**——进程在、端口在监听、CPU 是 0，
 *   但整个事件循环停住了。日志越多，死得越快（约两小时后）。
 *
 * 而因为它没重定向，那一刻连一行日志都没留下，只能靠猜。
 *
 * 所以：只有**确定安全**才往屏幕打——终端（TTY）或者重定向到文件；
 * 管道、坏句柄一律只写文件。
 */
function stdoutIsSafe() {
  try {
    if (process.stdout.isTTY) return true
    return fs.fstatSync(1).isFile()
  } catch {
    return false
  }
}

const CONSOLE_OK = stdoutIsSafe()

/** 落文件的日志路径（每天一个文件，和界面/文档里说的一致） */
export function logFilePath(ts = Date.now()) {
  return path.join(LOG_DIR, `friend-${localDateKey(ts)}.log`)
}

/** 写一行日志：一定进文件；stdout 安全时同时打屏幕 */
function writeLine(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(logFilePath(), line + '\n', 'utf8')
  } catch {
    /* 日志写不进去也不能影响正事 */
  }
  if (CONSOLE_OK) {
    try {
      process.stdout.write(line + '\n')
    } catch {
      /* 同上 */
    }
  }
}

/** 把任意值拼成一行能读的文本 */
function fmt(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export const log = {
  info: (...args) => writeLine(`[${stamp()}] ${args.map(fmt).join(' ')}`),
  warn: (...args) => writeLine(`[${stamp()}] ⚠ ${args.map(fmt).join(' ')}`),
  error: (...args) => writeLine(`[${stamp()}] ✖ ${args.map(fmt).join(' ')}`),
  /** 原样写一段（启动横幅这种多行文本用），不带时间戳前缀 */
  line: (text) => {
    for (const l of String(text ?? '').split('\n')) writeLine(l)
  },
}

/* ------------------------------------------------------------------ 其他 */

/** 生成一个足够随机的 token，用于单用户鉴权 */
export function randomToken(bytes = 24) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 文件内容的短哈希（16 个十六进制字符）。
 *
 * 用来给表情包做**内容寻址的 id**：
 *   - 同一张图不管叫什么文件名、放哪个子目录，id 都一样 → 自动去重
 *   - id 跟着内容走，所以浏览器可以永久缓存（内容变了 id 就变了）
 *   - 不依赖随机数，重启、换机器都稳定，不会每次启动都重新算一遍描述
 */
export function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
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
