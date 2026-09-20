/**
 * 头像。支持两种形式：
 *   1. 文字/emoji（比如 "狼" 或 "🐺"）
 *   2. 上传的图片（存成 data URL）
 *
 * 为什么存 data URL 而不是文件：
 * 头像是几十 KB 的小图，塞进一个 JSON 文件最省事——
 * 不用管目录权限、不用管清理旧文件、备份 data/ 时自动带上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.js'
import { log, writeJsonAtomic } from './util.js'

const AVATAR_FILE = path.join(PATHS.data, 'avatar.json')

/** 图片大小上限。再大就不是头像了，而且每次都随接口下发。 */
export const MAX_IMAGE_BYTES = 400 * 1024

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const DEFAULT = { kind: 'none', value: '' }

/**
 * @returns {{ kind: 'none'|'text'|'image', value: string }}
 *   kind=text  → value 是 1-2 个字符
 *   kind=image → value 是 data:image/...;base64,...
 */
export function readAvatar() {
  try {
    const raw = JSON.parse(fs.readFileSync(AVATAR_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...DEFAULT }
    if (raw.kind === 'image' && typeof raw.value === 'string' && raw.value.startsWith('data:image/')) {
      return { kind: 'image', value: raw.value }
    }
    if (raw.kind === 'text' && typeof raw.value === 'string' && raw.value.trim()) {
      return { kind: 'text', value: raw.value.slice(0, 4) }
    }
    return { ...DEFAULT }
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`读取头像失败：${err.message}`)
    return { ...DEFAULT }
  }
}

export function clearAvatar() {
  writeJsonAtomic(AVATAR_FILE, { ...DEFAULT })
  return { ...DEFAULT }
}

/**
 * 设置文字头像。
 * @param {string} value
 */
export function setTextAvatar(value) {
  const text = String(value ?? '').trim()
  if (!text) return clearAvatar()
  // 用 Array.from 按码点切，避免把 emoji 劈成两半
  const glyphs = Array.from(text).slice(0, 2).join('')
  const avatar = { kind: 'text', value: glyphs }
  writeJsonAtomic(AVATAR_FILE, avatar)
  return avatar
}

/** data URL 的实际字节数（base64 解开后的长度） */
function dataUrlByteLength(dataUrl) {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return 0
  const base64 = dataUrl.slice(comma + 1)
  // base64 每 4 个字符对应 3 字节，减去填充
  const padding = (base64.match(/=+$/) ?? [''])[0].length
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * 设置图片头像。
 * @param {string} dataUrl 形如 data:image/png;base64,....
 */
export function setImageAvatar(dataUrl) {
  const value = String(dataUrl ?? '')
  const match = value.match(/^data:([^;,]+);base64,/)
  if (!match) throw new Error('图片格式不对，需要是 data:image/...;base64,... 形式')

  const mime = match[1].toLowerCase()
  if (!ALLOWED_MIME.includes(mime)) {
    throw new Error(`不支持的图片格式：${mime}。请用 PNG / JPEG / WebP / GIF`)
  }

  const bytes = dataUrlByteLength(value)
  if (bytes === 0) throw new Error('图片内容为空')
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${Math.round(bytes / 1024)} KB），请压缩到 ${Math.round(MAX_IMAGE_BYTES / 1024)} KB 以内`)
  }

  const avatar = { kind: 'image', value }
  writeJsonAtomic(AVATAR_FILE, avatar)
  return { avatar, bytes }
}

/** 给界面一个可读的摘要，不要把整串 base64 塞进日志 */
export function describeAvatar(avatar = readAvatar()) {
  if (avatar.kind === 'image') {
    return `图片（约 ${Math.round(dataUrlByteLength(avatar.value) / 1024)} KB）`
  }
  if (avatar.kind === 'text') return `文字「${avatar.value}」`
  return '默认（取名字首字）'
}
