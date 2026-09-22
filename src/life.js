/**
 * 生活流水。
 *
 * 让「朋友」在跟用户说话之外，自己也过着日子。
 *
 * 为什么需要：在这之前，它的所有"经历"都是聊天时现编的——
 * 你问它在干嘛，它说"刚下楼买咖啡"，但下次就自相矛盾。
 * 它没有连续性，每次开口都是新的一段独白。
 * 有了流水之后，它说的每件事都是**真的记下来过的**，
 * 你问"在干嘛"它答的是流水里那一行，聊到相关话题它还能想起来。
 *
 * 设计上的三个要点：
 *
 * 1. **设定与流水分开**。life.md 是"它是什么人"（可以改），
 *    life.jsonl 是"已经发生过的事"（不可改，改了就等于篡改记忆）。
 *    生成新活动时会带上设定 + 最近发生过的事，避免前后矛盾、避免重复。
 *
 * 2. **只在用户安静的时候"过日子"**。用户正在跟你聊天的时候，
 *    你突然"经历"了一件事，那叫打断，不叫生活。
 *
 * 3. **它不是聊天记录的一部分**。这是它自己的事，跟用户无关。
 *    所以必须硬性禁止它把流水里的东西说成"你们共同的经历"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from './config.js'
import { complete } from './llm.js'
import { appendJsonl, log, now, randInt, readJsonl, writeJsonAtomic } from './util.js'

// 路径统一放在 config.js 的 PATHS 里——测试也要用同一套，
// 各算各的会读写出两个地方，产生难查的假失败
const LIFE_FILE = PATHS.life
const JOURNAL_FILE = PATHS.journal
const ARCS_FILE = PATHS.lifeArcs

/** 最近多少条流水喂进聊天提示词 */
const RECENT_FOR_CHAT = 8
/** 生成新活动时，带上多少条近期流水来防重复 */
const RECENT_FOR_GEN = 12

/* ------------------------------------------------------------ 设定 */

export function readLife() {
  try {
    return fs.readFileSync(LIFE_FILE, 'utf8')
  } catch {
    return ''
  }
}

export function writeLife(text) {
  fs.writeFileSync(LIFE_FILE, String(text), 'utf8')
}

/**
 * 有没有生活设定。
 *
 * 阈值别按"字数"卡。中文一个字的信息量比英文一个字母大得多，
 * 20 个中文字已经是很具体的一两句了（"23 岁，在上海，做设计"）。
 * 之前卡在 40 字，把短而完整的设定误判成"没有"，很难查。
 * 这里只做"不是空白/占位"的判断，够用就行。
 */
export function hasLife() {
  return readLife().replace(/\s/g, '').length >= 8
}

/* ------------------------------------------------------------ 流水 */

/**
 * 全部流水（按时间正序）。
 *
 * 文件本来就是按时间追加的，正常情况下顺序已经对。
 * 但还是显式排一次：手工编辑过、或者补写过过去之后，
 * 文件里的顺序可能乱，而后面所有逻辑（"最近发生过什么""上次经历是什么时候"）
 * 都建立在"有序"这个前提上。排一次的代价可以忽略。
 */
export function readJournal() {
  return readJsonl(JOURNAL_FILE)
    .filter((e) => e && typeof e.at === 'number' && typeof e.text === 'string')
    .sort((a, b) => a.at - b.at)
}

/** 最近 n 条，返回时是"新的在前" */
export function recentJournal(n = RECENT_FOR_CHAT) {
  const all = readJournal()
  return all.slice(-n).reverse()
}

/**
 * 某个时刻之后新发生的经历（按时间正序）。
 *
 * 给"她的成长"用的：判断这一段她有没有经历值得内化的事。
 * after 传 0 就返回全部。
 */
export function journalSince(after = 0) {
  return readJournal().filter((e) => e.at > after)
}

/** 记一件事 */
export function recordActivity({ at, text, kind = 'activity' }) {
  const entry = { at: at ?? now(), text: String(text ?? '').trim(), kind }
  if (!entry.text) return null
  appendJsonl(JOURNAL_FILE, entry)
  return entry
}

/* ------------------------------------------------------------ 线索 */

/**
 * 推进中的线索。
 *
 * 没有它的话，流水就是一串互不相关的碎片。
 * 有了线索才能形成"这几天它在忙什么"——闲聊里最容易接上的也是这种东西。
 */
export function readArcs() {
  try {
    const raw = JSON.parse(fs.readFileSync(ARCS_FILE, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function writeArcs(list) {
  writeJsonAtomic(ARCS_FILE, Array.isArray(list) ? list : [])
}

/* ------------------------------------------------------------ 提示词片段 */

/** 把流水渲染成"我最近做过的事"，带相对时间 */
function renderActivities(entries) {
  if (!entries.length) return ''
  const lines = []
  for (const e of entries) {
    const d = new Date(e.at)
    const p = (n) => String(n).padStart(2, '0')
    const isToday = new Date().toDateString() === d.toDateString()
    const day = isToday ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`
    lines.push(`- ${day} ${p(d.getHours())}:${p(d.getMinutes())}  ${e.text}`)
  }
  return lines.join('\n')
}

/**
 * 拼出注入聊天提示词的「我自己的生活」那一段。
 *
 * 两部分：
 *   1. 生活设定（life.md）—— 这是**她是谁**：职业、住哪、作息、脾气。
 *      必须每次都注入，否则她聊天时根本不知道自己靠什么活着。
 *      （原来只注入了流水，设定没进来，结果"我是谁"跟"我昨天干了什么"对不上。）
 *   2. 近期流水 —— 她最近真经历过的事，带相对时间。
 *
 * 设定为空、又没有流水时返回空串，免得提示词里出现空段落。
 */
export function buildLifeSection() {
  const hasSetting = hasLife()
  const setting = hasSetting ? readLife().trim() : ''
  const arcs = readArcs().filter((a) => a && a.text)
  const recent = recentJournal(RECENT_FOR_CHAT)

  if (!setting && arcs.length === 0 && recent.length === 0) return ''

  const parts = []

  if (setting) {
    parts.push(`【你自己的生活设定（你就是这个人，以下都是真的）】
${setting}`)
  }

  if (recent.length) {
    parts.push(`【你最近几天实际做过的事】
${renderActivities(recent)}`)
  }

  if (arcs.length) {
    parts.push(`【你最近在推进的几件事】
${arcs.map((a) => `- ${a.text}`).join('\n')}`)
  }

  parts.push(`怎么用这些：
- 上面是你的真实情况。对方问你在干嘛、最近怎么样、靠什么生活，就照实说，**不要现编**。
- 有流水时优先讲流水里的具体事（"今天煮面忘了放盐"比"在家待着呢"好）。
- 上面是"今天/几月几号"，按标注的时间理解，别把几天前的事说成刚刚。
- 这设定是**你的**，不是拿来安慰对方的工具。不要主动大段自我介绍，对方问才说。
- **绝对不要**把这些说成"你们一起经历过的事"。你们是网上认识的、没见过面。
  说"我下午去买了咖啡"可以，说"我们上次去的那家咖啡店"不行。`)

  return parts.join('\n\n')
}

/* ------------------------------------------------------------ 生成 */

/** 当前时间段的说法，让活动符合作息 */
function timeOfDay(at = now()) {
  const h = new Date(at).getHours()
  if (h < 5) return '深夜'
  if (h < 9) return '清早'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '夜里'
}

/**
 * 生成 1-2 件新发生的事。
 *
 * 关键约束（都在提示词里）：
 * - 必须符合 life.md 的设定，不能突然冒出设定里没有的人或事
 * - 不能和最近发生过的事重复
 * - 只写平淡的小事，不编造严重事件
 * - 是"刚发生的"，不是"打算做的"
 */
async function generateActivities(cfg, count) {
  const life = readLife()
  const recent = readJournal().slice(-RECENT_FOR_GEN).map((e) => e.text)
  const arcs = readArcs()

  const messages = [
    {
      role: 'system',
      content: `你在为一个虚构角色"续写她的日常生活"。这个角色活在一个聊天应用里，
跟一个网友聊天；不在聊天的时候，她也过着自己的日子。
你要写的就是她**刚刚经历的**一两件小事。

【她是谁（这是她的全部设定，不能超出这个范围）】
${life}

${arcs.length ? `【她最近在推进的事】\n${arcs.map((a) => '- ' + a.text).join('\n')}\n` : ''}
【她最近已经经历过的事（不要重复，也不要换汤不换药地说同一类事）】
${recent.length ? recent.map((t) => '- ' + t).join('\n') : '（还没有记录，这是第一次）'}

【必须遵守】
- 只写**平淡的小事**：买东西、做饭、家务、出门、看手机、猫闯祸、天气、
  小烦小乐、突然想到什么。**不要写重大事件**——不生病、不出事、
  不跟人吵架、家里不变故。她是个普通人，过普通日子。
- 要符合上面设定：她的职业、作息、收入状况、家里的情况一律以【她是谁】为准，
  **不要套用设定里没写的身份**。别冒出设定里没有的人。
- 每件事都是**已经发生的**，写成一句陈述，不要写成计划或打算。
- 每条 8-25 个字，口语，不要书面语。
- 不要提到"对方"（那个网友）。这是她自己的日子。
- 时间点是${timeOfDay()}，事情要符合这个时间（凌晨不该去买菜）。

只输出 JSON，不要任何其他文字：
{"activities": ["第一件事", "第二件事"]}

写 ${count} 条。`
    },
    { role: 'user', content: '写吧。' },
  ]

  const text = await complete(cfg, messages, { maxTokens: 300, temperature: 1.2 })

  // 复用主动消息那套 JSON 容错：解析失败就按行切，再不行就打捞
  let list = []
  const parsed = extractJsonLoose(text)
  if (parsed && Array.isArray(parsed.activities)) {
    list = parsed.activities
  } else {
    list = text.split('\n')
  }

  return list
    .map((line) => String(line ?? '').trim())
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter((line) => line.length >= 6 && line.length <= 60)
    .filter((line) => !/^\{|^\}|"activities"|```/.test(line))
    .slice(0, count)
}

/** 宽松的 JSON 解析（避免和 llm.js 循环依赖，这里自己实现一份很小的） */
function extractJsonLoose(text) {
  const s = String(text ?? '')
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], s].filter(Boolean)
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      /* 继续试下一个 */
    }
  }
  return undefined
}

/**
 * 让它"过一段日子"——生成若干件事并记进流水。
 * @param {{ count?: number, at?: number, silent?: boolean }} options
 */
export async function liveOneRound(options = {}) {
  const cfg = loadConfig()
  if (!hasLife()) {
    return { ok: false, reason: '还没有生活设定（data/life.md）' }
  }

  const count = options.count ?? 1
  let activities
  try {
    activities = await generateActivities(cfg, count)
  } catch (err) {
    log.warn(`生成生活活动失败：${err.message}`)
    return { ok: false, reason: err.message }
  }

  if (activities.length === 0) {
    return { ok: false, reason: '模型没有产出可用的事' }
  }

  /*
   * 时间戳要散开，不能都取"现在"。
   *
   * 之前一次生成两件事，两条的时间戳是同一分钟——
   * 流水里出现"今天 10:17 / 今天 10:17"，读起来像重复记录。
   * 现在按顺序往前推：最后一件是"刚刚"，前一件早 40-150 分钟。
   * 这样既真实，也顺手限定了一次经历的时间跨度（不会横跨一整天）。
   */
  const base = options.at ?? now()
  const count2 = activities.length
  const stamps = []
  let cursor = base
  for (let i = 0; i < count2; i++) {
    stamps.unshift(cursor)
    cursor -= randInt(40, 150) * 60 * 1000
  }

  const recorded = []
  for (let i = 0; i < activities.length; i++) {
    const entry = recordActivity({ text: activities[i], at: stamps[i] })
    if (entry) recorded.push(entry)
  }

  if (!options.silent && recorded.length) {
    for (const e of recorded) log.info(`生活：${e.text}`)
  }
  return { ok: true, activities: recorded }
}

/* ------------------------------------------------------------ 调度判断 */

/** 上次"过日子"是什么时候 */
export function lastActivityAt() {
  const all = readJournal()
  return all.length ? all[all.length - 1].at : 0
}

/**
 * 现在该不该让它"过一段日子"。
 *
 * 四个条件都满足才生成：
 * - 功能开着
 * - 用户已经安静够久（默认 1 小时）
 * - 距上次经历够久（2-4 小时随机）
 * - 不在静默时段（它也要睡觉）
 *
 * @param {object} cfg
 * @param {{ lastUserMessageAt: number }} state
 * @param {number} [at]
 * @param {{background?: boolean}} [opts]
 *   background=true 时**跳过"对方安静够久"这一条**，其余照旧。
 *   见下面 why 的说明。
 */
export function shouldLive(cfg, state, at = now(), opts = {}) {
  const life = cfg.life
  if (!life?.enabled) return { ok: false, reason: '生活功能已关闭' }
  if (!hasLife()) return { ok: false, reason: '还没有生活设定' }

  // 静默时段它也睡觉
  const hour = new Date(at).getHours()
  const { quietStart, quietEnd } = cfg.proactive
  if (quietStart !== quietEnd) {
    const inQuiet = quietStart < quietEnd
      ? hour >= quietStart && hour < quietEnd
      : hour >= quietStart || hour < quietEnd
    if (inQuiet) return { ok: false, reason: '静默时段' }
  }

  /*
   * 对方正在说话的时候，默认不"过日子"——那是打断：
   * 你刚说完话，她突然回一句"我刚刚下楼买了包烟"，很怪。
   *
   * ── 但这条和状态栏有个矛盾（用户报过）──────────────
   * 顶部那行状态读的是"最近 45 分钟内有没有流水"。
   * 而这条规则保证了**你聊天的时候她恰好不产生流水**——
   * 于是"在忙"这个状态你几乎永远看不到：你看到她的时候，
   * 多半正是在跟她说话的时候。
   *
   * 解法是区分两件事：
   *   · **过日子**（会写流水、可能被聊天引用）→ 要等用户安静，别打断
   *   · **背景活动**（只为了让"她此刻在干嘛"有据可依）→ 不用等
   * 后者传 background=true。
   *
   * 这不会破坏"别打断"的初衷：判断她会不会在聊天里提起，
   * 靠的是"生成那一刻用户安静不安静"，不是"历史上有没有在聊天时生成过"。
   */
  if (!opts.background && state.lastUserMessageAt) {
    const idleMin = (at - state.lastUserMessageAt) / 60000
    if (idleMin < life.minIdleMinutes) {
      return { ok: false, reason: `对方 ${Math.round(idleMin)} 分钟前还在说话` }
    }
  }

  // 两次经历之间的间隔
  const last = lastActivityAt()
  if (last) {
    const gapMin = (at - last) / 60000
    if (gapMin < life.minGapMinutes) {
      return { ok: false, reason: `距上次经历 ${Math.round(gapMin)} 分钟` }
    }
  }

  return { ok: true }
}

export { LIFE_FILE, JOURNAL_FILE, ARCS_FILE, renderActivities }
