/**
 * 她的"过去"。
 *
 * ── 要解决的问题 ──────────────────────────────────────
 * life.jsonl 是完整的流水，但它有两个毛病：
 *   1. 只有**最近 8 条**会被喂回给她，所以她记不住"上周三煮的那锅粥"
 *   2. 没有任何界面能看，所以用户也不知道"她这个月都干了什么"
 *
 * 结果就是她只有现在、没有过去——而人设里写着"自己住了一年半""猫是两年前
 * 捡的"，那些过去没有对应的记录支撑。
 *
 * 这个模块把流水按天压成**一天一句**。它不替代流水，而是给流水一个
 * "能被引用的摘要层"：
 *   · 她可以引用（"上周我不是还跟你说煮粥煮糊了"）
 *   · 用户可以回看（一条时间线：她这两个月都干了什么）
 *
 * 体量很小：一天一条，一年 365 行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from './config.js'
import { complete } from './llm.js'
import { buildDaySummaryPrompt } from './prompts.js'
import { localDateKey, log, now } from './util.js'
import { readJournal } from './life.js'

const FILE = PATHS.lifeDays
const DAY_MS = 24 * 60 * 60 * 1000

/** 时间线上最多留多少天（大约一年多）。超了丢最旧的。 */
const MAX_DAYS = 400

/** 喂回给她多少天。7 天够她"记得起来"，再多就只是烧 token。 */
const INJECT_DAYS = 7

/** 注入时每条摘要截到多少字（避免某天写太长把提示词撑起来） */
const INJECT_MAX_CHARS = 60

/* ------------------------------------------------------------ 读写 */

/** 全部按天摘要，按日期正序 */
export function readDays() {
  let text = ''
  try {
    text = fs.readFileSync(FILE, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        const o = JSON.parse(l)
        return o && typeof o.date === 'string' && typeof o.text === 'string' ? o : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function writeDays(list) {
  const trimmed = list.slice(-MAX_DAYS)
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  // 整体重写：一天一条，一年也就几十 KB，不值得为追加优化
  fs.writeFileSync(
    FILE,
    trimmed.map((d) => JSON.stringify(d)).join('\n') + (trimmed.length ? '\n' : ''),
    'utf8',
  )
  return trimmed
}

/** 某天的原始流水 */
export function activitiesOnDay(dateKey) {
  return readJournal().filter((e) => localDateKey(e.at) === dateKey)
}

/** 已经有摘要的日期集合 */
export function summarizedDates() {
  return new Set(readDays().map((d) => d.date))
}

/* ------------------------------------------------------------ 生成 */

/**
 * 兜底摘要：不调模型，把当天的流水压成一句。
 *
 * 为什么要兜底：模型调用会失败（断网、超时、key 不对）。
 * 没有兜底的话那天就在时间线上变成一个洞，而"有洞的时间线"比
 * "写得糙一点的摘要"更糟——用户会以为那天她什么都没做。
 *
 * 取法：每条流水取第一个分句，用"、"连起来，最多几条。
 */
export function fallbackSummary(activities) {
  const parts = activities
    .map((e) =>
      String(e.text ?? '')
        .split(/[，,。；;！!？?]/)[0]
        .trim(),
    )
    .filter(Boolean)

  if (parts.length === 0) return ''
  const picked = parts.length <= 3 ? parts : [parts[0], parts[Math.floor(parts.length / 2)], parts[parts.length - 1]]
  let out = picked.join('、')
  if (out.length > 60) out = out.slice(0, 60)
  return out
}

/**
 * 给某一天写摘要。
 *
 * @param {object} cfg
 * @param {string} dateKey YYYY-MM-DD
 * @param {{useModel?: boolean, at?: number}} [opts]
 */
export async function summarizeDay(cfg = loadConfig(), dateKey, opts = {}) {
  const activities = activitiesOnDay(dateKey)
  if (activities.length === 0) {
    return { ok: false, reason: '这天没有流水' }
  }

  const existing = readDays().find((d) => d.date === dateKey)
  if (existing && !opts.force) {
    return { ok: false, reason: '这天已经有摘要了' }
  }

  let text = ''
  let by = 'fallback'

  if (opts.useModel !== false) {
    try {
      const raw = await complete(
        cfg,
        buildDaySummaryPrompt({ dateKey, activities: activities.map((e) => e.text) }),
        { maxTokens: 120, temperature: 0.7 },
      )
      // 清洗：去引号、只取第一行、限长
      text = String(raw ?? '')
        .trim()
        .replace(/^["'“「]|["'”」]$/g, '')
        .split('\n')[0]
        .trim()
      if (text.length >= 4) by = 'model'
      else text = ''
    } catch (err) {
      log.warn(`生成 ${dateKey} 的日子摘要失败（用兜底）：${err.message}`)
    }
  }

  if (!text) text = fallbackSummary(activities)
  if (!text) return { ok: false, reason: '流水里提不出内容' }

  const entry = {
    date: dateKey,
    text: text.slice(0, 80),
    count: activities.length,
    at: opts.at ?? now(),
    by,
  }

  const list = readDays().filter((d) => d.date !== dateKey)
  list.push(entry)
  writeDays(list)

  log.info(`记下她的 ${dateKey}：${entry.text}`)
  return { ok: true, entry }
}

/**
 * 把已经过完、但还没摘要的日子补上。
 *
 * 每次调度 tick 跑一次（外面有节流）。它会：
 *   · 找出所有"有流水、日期已过、还没摘要"的日子
 *   · 按日期顺序补（一次最多补几天的量，避免一次调太多次模型）
 *
 * 已经过完 = dateKey < 今天。当天不摘要是刻意的：
 * 一天还没结束，摘要会随时间的推移变样，白花钱。
 */
export async function catchUpDaySummaries(cfg = loadConfig(), { at = now(), max = 3 } = {}) {
  const today = localDateKey(at)
  const done = summarizedDates()

  // 有流水的日子
  const days = new Set(readJournal().map((e) => localDateKey(e.at)))
  const pending = [...days].filter((d) => d < today && !done.has(d)).sort()

  if (pending.length === 0) return { added: 0, pending: 0 }

  let added = 0
  for (const dateKey of pending.slice(0, max)) {
    try {
      const r = await summarizeDay(cfg, dateKey)
      if (r.ok) added++
    } catch (err) {
      log.warn(`补 ${dateKey} 的摘要失败：${err.message}`)
    }
  }
  return { added, pending: pending.length }
}

/* ------------------------------------------------------------ 给提示词 */

/**
 * 拼"她这些天的日子"，注入聊天和主动开口的提示词。
 *
 * 位置和措辞都有讲究：它和"最近几天实际做过的事"（life.jsonl 那几条）
 * 是**两个粒度**——流水是"昨天下午三点煮了面"，这个是"那天大概什么样"。
 * 所以要写清楚这个区别，否则她会把摘要当成刚发生的事说出来。
 */
export function buildLifeDaysSection({ at = now(), days = INJECT_DAYS } = {}) {
  const all = readDays()
  if (all.length === 0) return ''

  const recent = all.slice(-days)
  if (recent.length === 0) return ''

  const lines = recent.map((d) => {
    const t = d.text.length > INJECT_MAX_CHARS ? d.text.slice(0, INJECT_MAX_CHARS) + '…' : d.text
    return `- ${d.date}：${t}`
  })

  return `【你这些天的日子（按天记的，是你自己的记忆）】
${lines.join('\n')}

怎么用：
- 这是**已经过去的日子**，不是刚刚发生的事。别把它说成"今天"。
- 它的用处是让你**记得起来**：对方提到某件事时，你可以说
  "上周我不是还跟你说…"。但**不要主动背时间线**，那是流水账。
- 别每次聊天都提"我前几天干嘛了"。它只是让你有个过去，不是话题。`
}

/** 给界面用：时间线 */
export function daysTimeline({ limit = 60 } = {}) {
  return readDays().slice(-limit).reverse()
}

/** 统计（给 doctor 和界面） */
export function daysStats() {
  const all = readDays()
  return {
    total: all.length,
    first: all[0]?.date ?? null,
    last: all[all.length - 1]?.date ?? null,
    byModel: all.filter((d) => d.by === 'model').length,
    byFallback: all.filter((d) => d.by === 'fallback').length,
  }
}

export { FILE as LIFE_DAYS_FILE, INJECT_DAYS, MAX_DAYS }
