/**
 * 存储层：一个单用户的消息日志 + 一份状态快照。
 *
 * 设计取舍：
 * - 消息只追加（messages.jsonl），永不原地改写 → 崩溃最多丢最后一条，不会损坏历史。
 * - "已读/已送达"不改消息本身，只推进 state.json 里的游标 → 避免为了标记已读重写整个文件。
 * - 消息全量常驻内存。单人对聊量级完全够（几万条也就几 MB）。
 * - 状态落盘做了合并（debounce），一次对话只写一次盘。
 */
import fs from 'node:fs'
import { appendJsonl, ensureDir, localDateKey, log, now, readJson, readJsonl, writeJsonAtomic } from './util.js'
import { PATHS } from './config.js'

const EMPTY_STATE = {
  /** 我（用户）已经读到哪条消息的 seq */
  lastReadSeq: 0,
  /** 用户最后一次发消息的时间 */
  lastUserMessageAt: 0,
  /** 我最后一次发消息的时间（任意来源） */
  lastAssistantMessageAt: 0,
  /** 连续主动发了多少条而对方没回 */
  unansweredStreak: 0,
  /** 下一次允许主动开口的时间戳 */
  nextProactiveAt: 0,
  /** 主动消息计数：{ '2026-02-14': 3 } */
  proactiveByDay: {},
  /** 最近一次"决定不发"的原因，纯调试用 */
  lastHoldReason: '',
  /** 抽取记忆的进度（已处理到第几条消息） */
  memoryCursor: 0,
  /** 是否正在生成回复（重启时清理） */
  generating: false,
  /** 服务首次启动时间 */
  createdAt: 0,
}

class Store {
  constructor() {
    this.messages = []
    this.state = { ...EMPTY_STATE }
    this.seq = 0
    this.listeners = new Set()
    this.stateDirty = false
    this.stateTimer = null
  }

  load() {
    ensureDir(PATHS.data)
    this.messages = readJsonl(PATHS.messages).filter((m) => m && typeof m.seq === 'number')
    this.messages.sort((a, b) => a.seq - b.seq)
    this.seq = this.messages.length ? this.messages[this.messages.length - 1].seq : 0

    const saved = readJson(PATHS.state, {}) || {}
    this.state = { ...EMPTY_STATE, ...saved }
    // 进程崩溃时可能留下 generating=true，重启后清掉
    this.state.generating = false
    if (!this.state.createdAt) this.state.createdAt = now()
    this.saveStateNow()
    log.info(`已载入 ${this.messages.length} 条消息（seq=${this.seq}）`)
    return this
  }

  /* ------------------------------------------------------------ 状态落盘 */

  saveStateNow() {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer)
      this.stateTimer = null
    }
    this.stateDirty = false
    writeJsonAtomic(PATHS.state, this.state)
  }

  /** 合并写：短时间内多次变更只落一次盘 */
  saveState() {
    this.stateDirty = true
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      if (this.stateDirty) this.saveStateNow()
    }, 400)
    this.stateTimer.unref?.()
  }

  /* ---------------------------------------------------------- 消息读写 */

  /**
   * 追加一条消息。
   *
   * seq 必须重新读一次文件尾部来定，不能直接用内存里的计数器：
   * 服务端和 CLI 是两个独立进程，各自从文件加载后都从同一个 seq 往下加，
   * 两边同时写就会撞号（实测出现过 seq=37、38、220 各两条）。
   * 撞号本身不会丢数据，但会让"按 seq 定位消息""摘要覆盖范围"这类逻辑出错。
   *
   * @param {{ role: 'user'|'assistant', text: string, kind?: string, meta?: object, at?: number }} input
   */
  append(input) {
    const seq = this.nextSeqFromDisk()
    const message = {
      seq,
      at: input.at ?? now(),
      role: input.role,
      text: String(input.text ?? ''),
      kind: input.kind ?? 'chat',
      ...(input.meta ? { meta: input.meta } : {}),
    }
    this.messages.push(message)
    appendJsonl(PATHS.messages, message)
    this.notify()
    return message
  }

  /**
   * 读出当前文件里最大的 seq，再 +1。
   *
   * 只读文件**尾部**若干字节，不整份加载——聊天记录会越来越长，
   * 每次发消息都读全文是不行的。
   *
   * ── 一个踩到的坑（表现为 seq 碰撞）──────────────────────
   * 光"从后往前找第一个能 JSON 解析出 seq 的行"是不够的。
   * 如果尾部那行是**没写完的半行**（进程被杀、断电、磁盘满），
   * 它解析失败，于是继续往前找，最后拿到一条**旧消息**的 seq——
   * 新消息就拿到了旧号，和历史上那条撞在一起。
   *
   * 实测数据里发现过 3 处这样的碰撞（seq 37/38/220 各两条）。
   * 后果不致命（渲染按数组顺序，不按 seq），但会让"按 seq 排序"的逻辑错乱，
   * 而且很难查。
   *
   * 修法：只认**看起来完整的**行——必须有 seq，而且得有 role 或 text。
   * 半行通常只写出 `{"seq":38,"at":123,"ro`，缺字段，于是被跳过。
   */
  nextSeqFromDisk() {
    let fromDisk = 0
    try {
      const stat = fs.statSync(PATHS.messages)
      // 256KB 而不是 8KB：一条消息可能很长（带图占位的那条也不小），
      // 窗口太小会整个落在半行里，往前退太多条
      const tailBytes = Math.min(256 * 1024, stat.size)
      if (tailBytes > 0) {
        const fd = fs.openSync(PATHS.messages, 'r')
        try {
          const buffer = Buffer.alloc(tailBytes)
          fs.readSync(fd, buffer, 0, tailBytes, stat.size - tailBytes)
          const text = buffer.toString('utf8')
          const lines = text.split('\n')
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim()
            if (!line) continue
            try {
              const parsed = JSON.parse(line)
              // 必须是完整消息：有 seq，而且有 role 或 text
              const looksComplete =
                typeof parsed?.seq === 'number' && (parsed.role !== undefined || parsed.text !== undefined)
              if (looksComplete) {
                fromDisk = parsed.seq
                break
              }
            } catch {
              // 半行或坏行，继续往前找
            }
          }
        } finally {
          fs.closeSync(fd)
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`读取消息文件尾部失败：${err.message}`)
    }

    // 内存里可能已经有更大的号（比如本次进程刚 append 过）
    this.seq = Math.max(this.seq, fromDisk) + 1
    return this.seq
  }

  /** 取最近 n 条，按时间正序返回 */
  recent(n) {
    return n >= this.messages.length ? [...this.messages] : this.messages.slice(-n)
  }

  /** seq 严格大于 after 的所有消息 */
  since(after) {
    if (!after) return [...this.messages]
    let lo = 0
    let hi = this.messages.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.messages[mid].seq <= after) lo = mid + 1
      else hi = mid
    }
    return this.messages.slice(lo)
  }

  lastAssistantMessage() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') return this.messages[i]
    }
    return undefined
  }

  lastUserMessage() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') return this.messages[i]
    }
    return undefined
  }

  /* ---------------------------------------------------------- 状态迁移 */

  markUserMessage(at = now()) {
    this.state.lastUserMessageAt = at
    this.state.unansweredStreak = 0
    this.saveState()
  }

  markAssistantMessage(at = now()) {
    this.state.lastAssistantMessageAt = at
    this.saveState()
  }

  markRead(seq) {
    if (seq > this.state.lastReadSeq) {
      this.state.lastReadSeq = seq
      this.saveState()
    }
  }

  unreadCount() {
    return this.messages.reduce((n, m) => (m.seq > this.state.lastReadSeq && m.role === 'assistant' ? n + 1 : n), 0)
  }

  scheduleNextProactive(gapMinutes) {
    this.state.nextProactiveAt = now() + gapMinutes * 60 * 1000
    this.saveState()
    return this.state.nextProactiveAt
  }

  proactiveCountToday(at = now()) {
    return this.state.proactiveByDay[localDateKey(at)] ?? 0
  }

  /** 记一次主动开口 */
  noteProactive(at = now()) {
    const key = localDateKey(at)
    this.state.proactiveByDay[key] = (this.state.proactiveByDay[key] ?? 0) + 1
    // 只保留最近 14 天，别让状态文件无限增长
    const keys = Object.keys(this.state.proactiveByDay).sort()
    while (keys.length > 14) delete this.state.proactiveByDay[keys.shift()]
    this.state.lastAssistantMessageAt = at
    this.state.unansweredStreak += 1
    this.saveState()
  }

  /* --------------------------------------------------- 变更订阅（SSE） */

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        log.warn(`推送订阅者出错：${err.message}`)
      }
    }
  }

  /** 导出给前端的精简结构，绝不把整个状态对象直接吐出去 */
  snapshot() {
    return {
      messages: this.messages.slice(-200).map(toWireMessage),
      lastSeq: this.seq,
      lastReadSeq: this.state.lastReadSeq,
      unread: this.unreadCount(),
      proactive: {
        nextAt: this.state.nextProactiveAt,
        todayCount: this.proactiveCountToday(),
        unansweredStreak: this.state.unansweredStreak,
        lastHoldReason: this.state.lastHoldReason,
      },
    }
  }
}

/** 只暴露前端需要的字段 */
export function toWireMessage(m) {
  const images = Array.isArray(m.meta?.images) ? m.meta.images : []
  return {
    seq: m.seq,
    at: m.at,
    role: m.role,
    text: m.text,
    kind: m.kind,
    // 图片只传 id，前端自己去 /api/image/<id> 取——
    // 把 base64 塞进每次的 SSE 快照里会拖垮移动端
    ...(images.length ? { images } : {}),
    /*
     * 表情包标记。
     *
     * 它跟普通图片的区别在前端要体现在两处：
     *   1. 图要小得多（表情包是大图会很难看）
     *   2. 只有图没有正文时，那句"（发表情）"占位符不能显示出来
     * 所以这个标记必须传到前端，不能只留在服务端。
     */
    ...(m.meta?.sticker ? { sticker: true } : {}),
  }
}

export const store = new Store()
export { EMPTY_STATE }
