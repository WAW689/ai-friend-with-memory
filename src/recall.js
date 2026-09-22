/**
 * 待回访的事。
 *
 * 现在她的记忆是**被动**的：你问她才想起来。真人朋友不是这样——
 * 一个真朋友会在毫不相关的时刻突然问一句：
 *
 *   「你上次说找实习那事，后来怎么样了」
 *   「对了，你上次说那门课最后选上了没」
 *
 * 这个模块就是干这个的：把"过几天该回头问问"的事记下来，
 * 到点了挑出来喂进她主动开口的候选话题。
 *
 * 跟 memory.md 的分工：
 *   memory.md   关于你的**长期事实**（你是谁、住哪、在意什么）——一直带着
 *   recall.json 关于你的**待跟进的事**（有下文没下文的）——到点了才用
 *
 * 存成 JSON 而不是 markdown，因为它是结构化的：每件事都有
 * "什么时候该问"和"问过没有"，这两样 markdown 表达不了。
 */
import fs from 'node:fs'
import { PATHS } from './config.js'
import { log, now, readJson, writeJsonAtomic } from './util.js'

/** 默认隔几天回访。太短像查岗，太长就不像"还记得"。 */
const DEFAULT_AFTER_DAYS = 3

/** 最多同时挂多少件。太多了会变成催办清单，不像聊天。 */
const MAX_ITEMS = 8

/** 一件"待回访的事"最多活多久，过期就丢掉（免得问三个月前的事） */
const MAX_AGE_DAYS = 30

export function readRecall() {
  const raw = readJson(PATHS.recall, { version: 1, items: [] })
  const items = Array.isArray(raw?.items) ? raw.items.filter((it) => it && it.text) : []
  return { version: 1, items }
}

export function writeRecall(data) {
  writeJsonAtomic(PATHS.recall, data)
}

/**
 * 记一件"该回头问问"的事。
 *
 * @param {{text: string, afterDays?: number, at?: number, source?: string}} input
 */
export function addRecall({ text, afterDays = DEFAULT_AFTER_DAYS, at = now(), source = '' }) {
  const clean = String(text ?? '').trim()
  if (clean.length < 4) return null

  const data = readRecall()

  // 同一件事不重复记（按文本判重，简单够用）
  if (data.items.some((it) => it.text === clean && !it.askedAt)) return null

  const item = {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    createdAt: at,
    // 到这个时间点之后才适合问
    dueAt: at + afterDays * 24 * 60 * 60 * 1000,
    askedAt: 0,
    source,
  }

  data.items.push(item)
  // 超出上限就丢最老的（已经问过的优先丢）
  if (data.items.length > MAX_ITEMS) {
    data.items.sort((a, b) => (a.askedAt ? 0 : 1) - (b.askedAt ? 0 : 1) || a.dueAt - b.dueAt)
    data.items = data.items.slice(-MAX_ITEMS)
  }

  writeRecall(data)
  return item
}

/**
 * 到点了、还没问过的事（新的在前）。
 *
 * @param {{at?: number, limit?: number}} [opts]
 */
export function dueRecalls({ at = now(), limit = 3 } = {}) {
  const data = readRecall()
  const fresh = data.items.filter(
    (it) => !it.askedAt && it.dueAt <= at && at - it.createdAt < MAX_AGE_DAYS * 86400000,
  )
  // 拖得越久越该问：先问最早到期的
  return fresh.sort((a, b) => a.dueAt - b.dueAt).slice(0, limit)
}

/** 标记问过了 */
export function markAsked(id, at = now()) {
  const data = readRecall()
  const item = data.items.find((it) => it.id === id)
  if (!item) return false
  item.askedAt = at
  writeRecall(data)
  return true
}

/** 清掉已经问过的和过期的 */
export function pruneRecall(at = now()) {
  const data = readRecall()
  const before = data.items.length
  data.items = data.items.filter(
    (it) => !it.askedAt || at - it.askedAt < 7 * 86400000,
  ).filter((it) => at - it.createdAt < MAX_AGE_DAYS * 86400000)
  if (data.items.length !== before) writeRecall(data)
  return before - data.items.length
}

/* ------------------------------------------------------------ 给提示词 */

/**
 * 拼成注入提示词的那一段。**没有到期的事就返回空串**，
 * 免得提示词里出现一段"（暂时没有）"让她困惑。
 */
export function buildRecallSection({ at = now() } = {}) {
  const due = dueRecalls({ at })
  if (due.length === 0) return ''

  return `【可以回头问问的事】
${due.map((it) => `- ${it.text}`).join('\n')}

怎么用：
- 这些是对方**以前提过**的事，现在过了几天，可以顺口问一句下文。
- 问的时候要像突然想起来，不要像在交作业：
  好："对了你那个实习后来有信儿没"
  差："关于你三天前提到的实习申请，进展如何"
- **一次只问一件**，别一口气全问一遍。
- 对方不想说就别追。他要是转移话题，就跟着聊别的。`
}

/** 读当前状态（给 doctor 用，不带副作用） */
export function peekPending({ at = now() } = {}) {
  const data = readRecall()
  const due = dueRecalls({ at })
  return {
    items: data.items.filter((it) => !it.askedAt),
    due,
    section: buildRecallSection({ at }),
  }
}

export { DEFAULT_AFTER_DAYS, MAX_ITEMS, MAX_AGE_DAYS }
