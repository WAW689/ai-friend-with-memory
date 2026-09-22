/**
 * 图片存储。
 *
 * 关键设计：**图片不塞进 messages.jsonl**。
 * 一张手机截图 base64 后就有 1-3 MB，几百条对话下来消息文件会涨到几百 MB，
 * 而它每次都要整个读进内存。所以图片单独存文件，消息里只记 id。
 *
 * 存在 data/images/ 下，按日期分子目录，方便按时间清理。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.js'
import { ensureDir, log, now, randomToken } from './util.js'

const IMAGE_DIR = path.join(PATHS.data, 'images')
/** 单张图上限。官方允许 32 MiB，但没必要，聊天看图 8 MB 足够。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** 按日期分目录，方便以后按时间清理 */
function dirForDate(ts = now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return path.join(IMAGE_DIR, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
}

/**
 * 表情包文件按 id 定位。
 *
 * 这里**故意不 import stickers.js**，而是自己读那份索引 JSON：
 *   - 避免循环依赖（stickers.js 那边要 PATHS，将来也可能要用到图片工具）
 *   - 这个函数在每次取图时都会走，逻辑必须自包含、看得懂
 *
 * 索引很小（几十条），而且只在表情包命中时才读一次，开销可以忽略。
 * 路径必须校验前缀，挡掉 `../` 穿越——索引文件虽然是自己写的，
 * 但用户手工编辑过就不好说了。
 */
function findStickerFile(id) {
  let lib
  try {
    lib = JSON.parse(fs.readFileSync(PATHS.stickerLib, 'utf8'))
  } catch {
    return null
  }

  const item = Array.isArray(lib?.items) ? lib.items.find((it) => it && it.id === id) : null
  if (!item?.file) return null

  const root = path.resolve(PATHS.stickers)
  const full = path.resolve(root, String(item.file))
  if (!full.startsWith(root + path.sep)) return null
  if (!fs.existsSync(full)) return null
  return full
}

/** base64 解出来的实际字节数 */
function base64Bytes(base64) {
  const padding = (base64.match(/=+$/) ?? [''])[0].length
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * 解析 data URL。
 * @returns {{ mime: string, base64: string, bytes: number }}
 */
export function parseDataUrl(dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:([^;,]+);base64,(.+)$/s)
  if (!match) throw new Error('图片格式不对，需要 data:image/...;base64,... 形式')

  const mime = match[1].toLowerCase()
  const base64 = match[2]

  if (!ALLOWED_MIME.has(mime)) {
    throw new Error(`不支持的图片格式：${mime}。请用 JPEG / PNG / GIF / WebP`)
  }
  const bytes = base64Bytes(base64)
  if (bytes === 0) throw new Error('图片内容为空')
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${Math.round(bytes / 1024 / 1024 * 10) / 10} MB），请压到 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 以内`)
  }

  return { mime, base64, bytes }
}

/**
 * 保存一张图。
 * @param {string} dataUrl
 * @returns {{ id: string, mime: string, bytes: number, file: string, at: number }}
 */
export function saveImage(dataUrl) {
  const { mime, base64, bytes } = parseDataUrl(dataUrl)
  const at = now()
  const dir = dirForDate(at)
  ensureDir(dir)

  const id = randomToken(8)
  const file = path.join(dir, `${id}.${EXT_BY_MIME[mime]}`)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))

  return {
    id,
    mime,
    bytes,
    at,
    file: path.relative(IMAGE_DIR, file).replace(/\\/g, '/'),
  }
}

/**
 * 按 id 找出图片文件。
 *
 * 两个来源，都会找：
 *   1. data/images/按日期/ —— 聊天里发的照片，文件名是随机 id
 *   2. data/stickers/     —— 表情包，文件名是用户原来的文件名，
 *                            靠 stickers.json 里的 id → file 映射定位
 *
 * 为什么第二个必须找：消息里两类图都只记一个 id，前端统一用
 * `/api/image?id=xxx` 取。如果这里只认 images/，表情包就会 404，
 * 手机上是加载不出来的破图。这个坑真踩过。
 *
 * 不信任调用方给的路径：只按 id 在已知目录里查，不做路径拼接穿越。
 */
export function findImage(id) {
  const key = String(id ?? '')
  if (!/^[a-f0-9]{6,32}$/.test(key)) return null

  // 表情包：id 是内容哈希，跟文件名没关系，必须查索引
  const sticker = findStickerFile(key)
  if (sticker) return sticker

  let days
  try {
    days = fs.readdirSync(IMAGE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return null
  }
  // 新的在前，最近发的图优先命中
  for (const day of days.sort((a, b) => b.name.localeCompare(a.name))) {
    const dir = path.join(IMAGE_DIR, day.name)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    const hit = files.find((f) => f.startsWith(key))
    if (hit) return path.join(dir, hit)
  }
  return null
}

/** 读成 data URL，喂给模型用 */
export function readImageAsDataUrl(id) {
  const file = findImage(id)
  if (!file) return null
  const ext = path.extname(file).slice(1).toLowerCase()
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  const base64 = fs.readFileSync(file).toString('base64')
  return `data:${mime};base64,${base64}`
}

/**
 * 读成 data URL，但限制总大小。
 *
 * 为什么要限制：图片按维度计费，一张最多 1024 token。
 * 如果一次带上十几张历史图片，prompt 会爆掉，而且很贵。
 * 所以只带最近几张，超预算就放弃（文字里仍有"[图片]"占位，不会完全失忆）。
 */
export function readRecentImages(ids, { maxCount = 4, maxBytes = 6 * 1024 * 1024 } = {}) {
  const out = []
  let total = 0
  for (const id of [...ids].reverse()) {
    if (out.length >= maxCount) break
    const file = findImage(id)
    if (!file) continue
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      continue
    }
    if (total + size > maxBytes) break
    const url = readImageAsDataUrl(id)
    if (!url) continue
    total += size
    out.unshift({ id, url, bytes: size })
  }
  return out.reverse()
}

/** 统计占用，给 CLI / 设置页看 */
export function imageStats() {
  let count = 0
  let bytes = 0
  let days = []
  try {
    days = fs.readdirSync(IMAGE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return { count: 0, bytes: 0, days: 0, dir: IMAGE_DIR }
  }
  for (const day of days) {
    const dir = path.join(IMAGE_DIR, day.name)
    try {
      for (const f of fs.readdirSync(dir)) {
        count++
        bytes += fs.statSync(path.join(dir, f)).size
      }
    } catch {
      /* 忽略读不到的子目录 */
    }
  }
  return { count, bytes, days: days.length, dir: IMAGE_DIR }
}

export { IMAGE_DIR }
