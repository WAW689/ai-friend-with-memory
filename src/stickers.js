/**
 * 表情包。
 *
 * 让「朋友」在聊天里发发表情包——这是真人聊天里最自然的一种"说不出来就发表情"。
 *
 * 为什么不做"AI 生成照片"：DeepSeek 没有文生图接口（/images/generations 是 404），
 * 要做得接第三方画图服务，一张一毛到五毛。而表情包**零成本、不联网、
 * 而且更像真人**——真人聊天里发的本来就是表情包，不是自己拍的照片。
 *
 * 三个设计要点：
 *
 * 1. **她自己挑，不是随机发**。所以提示词里要给她一份"有哪些表情包"的清单。
 *    但清单不能太长（每轮对话都要带上），所以描述截断到十几个字，
 *    并且最多只带 30 张（按用得少的优先轮换，避免永远是前几张被选中）。
 *
 * 2. **描述由模型看图自动生成**。你只管把图丢进 data/stickers/，
 *    不用手写每张是什么——手写 30 张描述这事没人会做，那功能就废了。
 *    识图只在**添加时**跑一次（一张约 1000 token），之后一直是文本。
 *
 * 3. **id 是内容哈希**。同一张图不管叫什么名字，id 都一样：
 *    自动去重、浏览器可以永久缓存、重启也不会重新生成描述。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from './config.js'
import { complete } from './llm.js'
import { contentHash, ensureDir, log, now, readJson, writeJsonAtomic } from './util.js'

const DIR = PATHS.stickers
const LIB_FILE = PATHS.stickerLib

/** 支持的图片格式。跟聊天收图保持一致，另外补 bmp（老表情包常见）。 */
const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** 单张上限。表情包都很小，超过这个尺寸的说明不是表情包。 */
const MAX_BYTES = 2 * 1024 * 1024

/**
 * 提示词里最多列几张。
 *
 * 不是"库里最多几张"——库可以很大，但每轮对话都带上清单是要花 token 的。
 * 30 张 × 每条 14 字 ≈ 400 字，可以接受。
 */
const MAX_IN_PROMPT = 30

/** 描述在提示词里的长度上限。太长会把清单撑爆，而挑表情包不需要那么详细。 */
const DESC_MAX = 14

/* ------------------------------------------------------------ 读 */

export function readLib() {
  const raw = readJson(LIB_FILE, { version: 1, items: [] })
  const items = Array.isArray(raw?.items) ? raw.items.filter((it) => it && it.id) : []
  return { version: 1, items }
}

/**
 * 写回索引。
 *
 * 导出是因为界面要改描述/停用/删除，那些操作不该再抄一遍读写逻辑——
 * 抄了就会出现两处对不上（比如一处忘了排序）。
 */
export function writeLib(lib) {
  ensureDir(path.dirname(LIB_FILE))
  writeJsonAtomic(LIB_FILE, lib)
}

export function getSticker(id) {
  return readLib().items.find((it) => it.id === id) ?? null
}

/** 表情包文件的实际路径（id 是内容哈希，文件名里带它） */
export function stickerFile(item) {
  if (!item?.file) return null
  // 只允许 data/stickers 下的相对路径，挡掉 ../ 穿越
  const full = path.resolve(DIR, item.file)
  if (!full.startsWith(path.resolve(DIR) + path.sep)) return null
  return fs.existsSync(full) ? full : null
}

/* ------------------------------------------------------------ 扫描文件夹 */

/** 递归列出目录下所有支持的图片 */
function listImages(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...listImages(p))
      continue
    }
    const ext = path.extname(e.name).toLowerCase()
    if (!EXT_MIME[ext]) continue
    try {
      const stat = fs.statSync(p)
      if (stat.size > 0 && stat.size <= MAX_BYTES) out.push(p)
    } catch {
      /* 读不到就跳过 */
    }
  }
  return out
}

/* ------------------------------------------------------------ 自动描述 */

/**
 * 让模型看一眼这张图，说一句"这是什么表情、什么场合用"。
 *
 * 这是整个功能里唯一需要花钱的地方：一张图一次，约 1000 token。
 * 而且只在**添加时**跑一次——之后挑表情包全程是文本，
 * 因为判断的时候模型看不见图（DeepSeek 的视觉是另一条接口，
 * 混进每次判断既贵又没必要）。
 */
async function describeSticker(cfg, dataUrl) {
  const messages = [
    {
      role: 'system',
      content: `你在给一张聊天表情包写"索引卡"，供以后挑图时参考。

看这张图，用**一句中文**说清楚两件事：
1. 画面上是什么
2. 适合在什么场合发

要求：
- 一共不超过 30 个字，越短越好（它会被塞进一份长清单里）
- 口语，不要"该图片展示了"这种描述腔
- 如果是文字表情包，把上面的字直接写出来
- 只输出这一句，不要引号、不要编号、不要解释

例：
猫躺着不动，配字"不想动"，适合表示摆烂
一个人捂脸，适合表示无语或者没眼看
"你说的都对"，适合不想争了的时候敷衍一下`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张是什么表情包？' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]

  const text = await complete(cfg, messages, { maxTokens: 120, temperature: 0.3 })
  return String(text ?? '')
    .trim()
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
}

/** 读成 data URL，给识图用 */
function toDataUrl(file, mime) {
  const buf = fs.readFileSync(file)
  return `data:${mime};base64,${buf.toString('base64')}`
}

/* ------------------------------------------------------------ 同步 */

/**
 * 扫描 data/stickers/，把新图加进库、把已删除的清掉。
 *
 * **你只管往文件夹里丢图**，不用改任何配置文件。这是刻意的：
 * 如果每加一张都要手写一句描述，没人会加满 30 张，功能就废了。
 *
 * @param {object} [cfg]
 * @param {boolean} [describe] 要不要给新图生成描述（识图要花钱，默认要）
 * @returns {Promise<{added: number, removed: number, described: number, errors: string[]}>}
 */
export async function syncStickers(cfg = loadConfig(), { describe = true } = {}) {
  ensureDir(DIR)
  const lib = readLib()
  const files = listImages(DIR)
  const result = { added: 0, removed: 0, described: 0, errors: [] }

  const seen = new Set()
  const byId = new Map(lib.items.map((it) => [it.id, it]))

  for (const file of files) {
    let buf
    try {
      buf = fs.readFileSync(file)
    } catch (err) {
      result.errors.push(`${path.basename(file)}: ${err.message}`)
      continue
    }
    const id = contentHash(buf)
    seen.add(id)
    const rel = path.relative(DIR, file).replace(/\\/g, '/')

    const exist = byId.get(id)
    if (exist) {
      // 文件被挪了位置（或改了名），更新路径，不重复描述
      if (exist.file !== rel) exist.file = rel
      continue
    }

    const ext = path.extname(file).toLowerCase()
    const item = {
      id,
      file: rel,
      mime: EXT_MIME[ext],
      bytes: buf.length,
      desc: '',
      enabled: true,
      uses: 0,
      addedAt: now(),
    }

    if (describe) {
      try {
        item.desc = await describeSticker(cfg, toDataUrl(file, item.mime))
        if (item.desc) result.described++
      } catch (err) {
        // 描述失败不影响入库——以后可以手动补，或者再同步一次
        result.errors.push(`${rel} 描述失败: ${err.message}`)
      }
    }

    lib.items.push(item)
    byId.set(id, item)
    result.added++
  }

  // 文件已经不在了的，从库里删掉（避免清单里挂着一堆点不开的图）
  const before = lib.items.length
  lib.items = lib.items.filter((it) => seen.has(it.id))
  result.removed = before - lib.items.length

  // 按加入时间排序，让清单顺序稳定（不然每次都可能不一样）
  lib.items.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))

  writeLib(lib)
  return result
}

/* ------------------------------------------------------------ 清单 */

/** 启用的表情包 */
export function enabledStickers() {
  return readLib().items.filter((it) => it.enabled !== false)
}

/**
 * 拼给模型看的清单。
 *
 * 三个刻意的处理：
 *
 * 1. **没有描述的不进清单**。清单的作用是让模型区分这些图，
 *    而一堆长得一样的"（还没写描述）"是没法区分的——它会瞎挑一张，
 *    比不发更糟。宁可不给这张，逼出一条明确的补救动作
 *    （重新扫描生成描述，或者手写一句）。
 * 2. **用得少的排前面**。不然模型会永远盯着清单开头那几张，
 *    后面一堆表情包永远轮不上——那等于白准备了。
 * 3. **描述截断**。每轮对话都要带这份清单，token 得省着花。
 */
export function stickerMenu() {
  const items = enabledStickers().filter((it) => String(it.desc ?? '').trim())
  if (items.length === 0) return { text: '', list: [] }

  const rotated = [...items].sort((a, b) => {
    const du = (a.uses ?? 0) - (b.uses ?? 0)
    if (du !== 0) return du
    return (a.addedAt ?? 0) - (b.addedAt ?? 0)
  })

  const picked = rotated.slice(0, MAX_IN_PROMPT)
  const lines = picked.map((it, i) => `${i + 1}. ${String(it.desc).trim().slice(0, DESC_MAX)}`)

  return { text: lines.join('\n'), list: picked }
}

/** 记一次使用（用于轮换和统计"她最爱用哪张"） */
export function markStickerUsed(id) {
  const lib = readLib()
  const it = lib.items.find((x) => x.id === id)
  if (!it) return false
  it.uses = (it.uses ?? 0) + 1
  it.lastUsedAt = now()
  writeLib(lib)
  return true
}

/** 库里最多能容纳多少张（防止无限增长拖慢每次扫描） */
export const STICKER_LIMITS = { maxInPrompt: MAX_IN_PROMPT, descMax: DESC_MAX, maxBytes: MAX_BYTES }

export { DIR as STICKER_DIR, EXT_MIME as STICKER_EXT_MIME }
