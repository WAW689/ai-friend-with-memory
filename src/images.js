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
 * 不信任调用方给的路径，只在 images 目录下按 id 前缀搜索——
 * 避免路径穿越。
 */
export function findImage(id) {
  if (!/^[a-f0-9]{6,32}$/.test(String(id ?? ''))) return null
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
    const hit = files.find((f) => f.startsWith(id))
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
