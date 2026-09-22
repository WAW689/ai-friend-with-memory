/**
 * 对话引擎。整个产品的行为都在这里：
 * - respond(): 用户说话 → 流式回复 → 存盘 → 后台抽记忆/压缩摘要
 * - runProactiveCheck(): 定时醒来 → 判断该不该开口 → 发消息 + 推送
 * - 拟人化：打字延迟、偶尔连发两条、对方在看在就不推手机
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, DEFAULT_MEMORY, loadConfig } from './config.js'
import { complete, completeJson, extractJson, streamChat } from './llm.js'
import { push, recordPush } from './bark.js'
import { runBackup } from './backup.js'
import { readRecentImages, saveImage } from './images.js'
import { buildLifeSection, journalSince, readJournal, shouldLive, liveOneRound } from './life.js'
import { buildLifeDaysSection } from './life-days.js'
import { buildSelfSection, evolveSelf, renderExperiences } from './self.js'
import { markStickerUsed, stickerMenu } from './stickers.js'
import { describeNow } from './almanac.js'
import { buildWeatherSection, getWeather, peekSunTimes } from './weather.js'
import { buildRecallSection, dueRecalls, markAsked, pruneRecall, readRecall, addRecall } from './recall.js'
import { buildBusySection, busyState, replyDelay } from './busy.js'
import { activeHoursGate, buildSleepySection, sleepiness } from './sleepy.js'
import {
  buildBusyAnnouncePrompt,
  buildChatSystemPrompt,
  buildMemoryPrompt,
  buildProactiveDecisionPrompt,
  buildProactiveMessagePrompt,
  buildRecallPrompt,
  buildStickerSection,
  buildSummaryPrompt,
  renderTranscript,
} from './prompts.js'
import { store } from './storage.js'
import { HOUR, MINUTE, appendJsonl, humanAgo, humanDuration, localDateKey, log, now, randInt, readJson, readJsonl, sleep, truncate, writeJsonAtomic } from './util.js'

/* --------------------------------------------------------------- 文本资产 */

export function readPersona() {
  try {
    return fs.readFileSync(PATHS.persona, 'utf8')
  } catch {
    return ''
  }
}

export function writePersona(text) {
  fs.writeFileSync(PATHS.persona, String(text), 'utf8')
}

/**
 * 从人设里读出角色的名字，用于推送标题和聊天界面。
 *
 * 为什么从人设读而不是单独存一个字段：
 * 名字是**角色身份的一部分**，人设里必然写着"名字叫「XX」"。
 * 再存一份就一定会不一致——改了人设忘了改配置，界面和推送就自相矛盾。
 * 所以人设是唯一事实来源，这里只在展示时解析一次（按 mtime 缓存，改完立刻生效）。
 */
const FALLBACK_NAME = '朋友'
let nameCache = { mtime: -1, name: FALLBACK_NAME }

/* --------------------------------------------------------------- 表情包 */

/*
 * 标记格式：[表情包:3]。用中括号而不是别的，因为真人在微信里不会打这个，
 * 所以模型跟着照做的概率高；而且万一它忘了发、直接把标记写进正文，
 * 用户看到的也只是一串无害的文字，不会崩。
 *
 * 数字不限制位数：模型偶尔会写 100 这种越界编号，那时要**先抠出来**
 * 再判定越界。如果正则本身不认，标记会原样留在正文里发给用户，
 * 那比不发还难看。
 */
const STICKER_RE = /\[\s*表情包\s*[:：]\s*(\d{1,4})\s*\]/g

/**
 * 从模型的回复里抠出表情包标记，返回干净的正文和编号。
 *
 * 模型可能写得五花八门（全角冒号、多余空格、夹在句中），所以用宽松匹配，
 * 而且**允许一个回复里只认第一张**——真人也只发一张。
 */
export function parseStickerMark(text) {
  const raw = String(text ?? '')
  let pick = null
  const cleaned = raw
    .replace(STICKER_RE, (_m, n) => {
      if (pick === null) pick = Number(n)
      return ''
    })
    // 抠掉标记后可能留下空行，收一下
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text: cleaned, index: pick }
}

/** 今天发了几张表情包 */
function stickersToday(at = now()) {
  const byDay = store.state.stickersByDay ?? {}
  return byDay[localDateKey(at)] ?? 0
}

function noteStickerSent(at = now()) {
  const byDay = store.state.stickersByDay ?? {}
  const key = localDateKey(at)
  byDay[key] = (byDay[key] ?? 0) + 1
  // 只留最近 14 天，跟主动消息那边一个做法
  const keys = Object.keys(byDay).sort()
  while (keys.length > 14) delete byDay[keys.shift()]
  store.state.stickersByDay = byDay

  const mine = store.messages.filter((m) => m.role === 'assistant').length
  store.state.lastStickerAtSeq = mine
  store.state.lastStickerAt = at
  store.saveState()
}

/**
 * 现在允许发表情包吗。
 *
 * 这是整个功能最重要的一个函数。没有它，模型会**越用越多**——
 * 一旦发现"发表情包对方有反应"，它就会每句都配一张，
 * 几天后这个角色就变成表情包机器人了。
 *
 * 三道闸门：
 *   1. 距上次发表情包，我们自己已经又说了几条（默认 6 条）
 *   2. 今天没超过每日上限（默认 8 张）
 *   3. 总开关没关
 */
export function stickerGate(cfg, at = now()) {
  if (!cfg.sticker?.enabled) return { ok: false, reason: '表情包功能已关闭' }

  const mine = store.messages.filter((m) => m.role === 'assistant').length
  const lastSeq = store.state.lastStickerAtSeq
  const gap = cfg.sticker.minMessagesBetween ?? 6

  /*
   * lastStickerAtSeq 记的是"发那张时我已经说了几条"。
   * 刚重启时它是 undefined，这时不该拦（第一次总是允许的）。
   */
  if (typeof lastSeq === 'number') {
    const since = mine - lastSeq
    if (since < gap) {
      return { ok: false, reason: `距上次表情包才说了 ${since} 条，隔 ${gap} 条再说` }
    }
  }

  const today = stickersToday(at)
  if (today >= (cfg.sticker.maxPerDay ?? 8)) {
    return { ok: false, reason: `今天已经发过 ${today} 张了` }
  }

  return { ok: true }
}

/**
 * 把模型给出的编号兑成真实的图片 id。
 *
 * 编号是清单里的**位置**，不是 id——所以必须通过同一份清单来翻译。
 * 位置越界（模型自己编了个编号）就静默放弃：宁可不发，
 * 也不能随便抓一张不相干的图发出去，那比不发尴尬得多。
 *
 * 注意这里**只做校验和翻译，不记流水**。记账（markStickerUsed /
 * noteStickerSent）必须等消息真的 append 之后再做：noteStickerSent
 * 记的是"发那张时我已经说了几条"，提前记会少数一条，间隔闸门就偏了。
 */
function resolveSticker(cfg, index, menuList) {
  if (index === null || !Number.isFinite(index)) return null
  const pos = Number(index) - 1
  if (pos < 0 || pos >= menuList.length) {
    log.info(`表情包编号 ${index} 超出清单（共 ${menuList.length} 张），这次不发`)
    return null
  }

  const gate = stickerGate(cfg)
  if (!gate.ok) {
    log.info(`这次不发表情包：${gate.reason}`)
    return null
  }

  return menuList[pos]
}

/** 消息真的发出去之后再记账 */
function noteStickerDelivered(item) {
  if (!item) return
  markStickerUsed(item.id)
  noteStickerSent()
}

/** 表情包统计（给界面看） */
export function stickerStats() {
  return { today: stickersToday(), lastAt: store.state.lastStickerAt ?? 0 }
}

/**
 * 让她主动交代一句"我去忙了"。
 *
 * 为什么这条比延迟更有价值：真人朋友之间"我去忙了"很重要，
 * 它把"你没回我"从"他不想理我"变成"他在忙"。
 * 用户会因为"看到她在线没回"多想，一句报备能省掉那部分内耗。
 *
 * 三道闸门，都是防"报备变成刷屏"：
 *   1. 只有 **heavy** 档（做饭、洗澡、骑车、睡觉）才报备。
 *      "在刷手机"不用报备——那本来就是能聊天的状态。
 *   2. 距上次报备至少 4 小时。真人不会一天报备八次。
 *   3. 对方正在聊（10 分钟内说过话）就不单独报备，
 *      让正常回复去交代——连着两条消息会显得很吵。
 */
export async function maybeAnnounceBusy(cfg = loadConfig(), { at = now() } = {}) {
  if (cfg.busy?.enabled === false) return { sent: false, reason: '在忙功能已关闭' }
  if (cfg.busy?.announce === false) return { sent: false, reason: '报备已关闭' }

  const state = busyState({ at })
  if (state.level !== 'heavy') {
    return { sent: false, reason: state.level === 'light' ? '这种忙不用报备' : '她现在没在忙什么' }
  }

  const lastAnnounce = store.state.lastBusyAnnounceAt ?? 0
  if (at - lastAnnounce < 4 * 60 * 60 * 1000) {
    return { sent: false, reason: '四小时内已经报备过了' }
  }

  const lastUser = store.state.lastUserMessageAt ?? 0
  if (at - lastUser < 10 * 60 * 1000) {
    return { sent: false, reason: '对方正在聊，让正常回复去交代' }
  }

  let text = ''
  try {
    const ctx = buildContext(cfg)
    text = String(
      await complete(
        cfg,
        buildBusyAnnouncePrompt({ persona: ctx.persona, activity: state.text, nowText: ctx.nowText }),
        { maxTokens: 60, temperature: cfg.model.temperature },
      ),
    ).trim()
  } catch (err) {
    log.warn(`生成报备消息失败：${err.message}`)
    return { sent: false, reason: err.message }
  }

  // 清洗：去引号、只取第一行、限长。模型偶尔会写一整段
  text = text
    .replace(/^["'“「]|["'”」]$/g, '')
    .split('\n')[0]
    .trim()
    .slice(0, 40)

  if (text.length < 2) return { sent: false, reason: '模型没给出可用的一句话' }

  const message = store.append({ role: 'assistant', text, kind: 'proactive' })
  store.noteProactive(message.at)
  store.state.lastBusyAnnounceAt = at
  store.saveState()

  log.info(`她报备去忙了：${text}`)
  return { sent: true, message, text }
}

export function characterName() {
  try {
    const stat = fs.statSync(PATHS.persona)
    if (stat.mtimeMs === nameCache.mtime) return nameCache.name

    let name = ''
    const lines = fs.readFileSync(PATHS.persona, 'utf8').split('\n').slice(0, 12)
    for (const line of lines) {
      // 只认"名字叫/叫做/名字是「XX」"这类明确写法，避免误抓正文
      const match = line.match(/名字(?:叫做|叫|是)\s*[「『"“\[]?([^」』"”\]。，,、\s]+)/)
      if (match) {
        name = match[1].trim()
        break
      }
    }
    nameCache = { mtime: stat.mtimeMs, name: name || FALLBACK_NAME }
    return nameCache.name
  } catch {
    return FALLBACK_NAME
  }
}

export function readMemory() {
  try {
    return fs.readFileSync(PATHS.memory, 'utf8')
  } catch {
    return DEFAULT_MEMORY
  }
}

export function writeMemory(text) {
  fs.writeFileSync(PATHS.memory, String(text), 'utf8')
}

export function readSummary() {
  const file = readJson(PATHS.summary, {}) || {}
  return { text: file.text ?? '', upToSeq: file.upToSeq ?? 0 }
}

export function writeSummary(text, upToSeq) {
  writeJsonAtomic(PATHS.summary, { text, upToSeq, updatedAt: now() })
}

/* ----------------------------------------------------------- 运行时活动 */

/**
 * 记录"用户此刻在不在线"。
 * 前端每次心跳/发消息都会刷新；主动判断会参考它，
 * 对方正在盯着屏幕时就别推手机了。
 */
const activity = {
  lastSeenAt: 0,
  lastUserActionAt: 0,
}

export function noteAppActive() {
  activity.lastSeenAt = now()
}

export function noteUserAction() {
  const ts = now()
  activity.lastSeenAt = ts
  activity.lastUserActionAt = ts
}

function isUserWatchingScreen(windowMs = 90 * 1000) {
  return activity.lastSeenAt > 0 && now() - activity.lastSeenAt < windowMs
}

/* --------------------------------------------------------------- 上下文 */

/**
 * 拼出这一轮要喂给她的所有材料。
 *
 * 已经导出（见文件末尾的 export 列表）给 doctor 用：
 * 体检必须跑**同一份**拼装逻辑，自己再实现一遍就失去意义了——
 * 那样只会检查到"我以为的拼装方式"。
 */
function buildContext(cfg) {
  const summary = readSummary()
  // 摘要已经覆盖的部分不重复喂给模型
  const fresh = summary.upToSeq ? store.since(summary.upToSeq) : [...store.messages]
  const recent = attachImages(fresh.slice(-cfg.context.recentMessages), {
    maxCount: cfg.context.maxImagesInContext ?? 4,
  })

  /*
   * 时间锚点一定要取"对方上次说话"，不能取"最后一条消息"。
   *
   * 主动发过消息之后，最后一条消息就是你自己刚发的那条，
   * 于是"距离上次说话"永远显示"刚刚"——模型会以为自己刚聊完，
   * 然后不断重复同一句话。这是之前 force 路径记忆混乱的主因之一。
   */
  const lastUser = store.lastUserMessage()
  const lastAssistant = store.lastAssistantMessage()

  /*
   * 表情包清单。
   *
   * menu.list 必须跟着 text 一起传下去：模型回的编号是"清单里的第几个"，
   * 而清单是**轮换**的（用得少的排前面），所以只有拿同一份 list
   * 才能把编号翻译回真实的图片 id。分开生成两次就会错位。
   */
  const menu = stickerMenu()
  const stickerSection = cfg.sticker?.enabled ? buildStickerSection(menu.text) : ''

  /*
   * 时间描述。这是她所有时间概念的唯一来源。
   *
   * 日出日落从天气缓存里同步读（peekSunTimes），不在这里联网——
   * 聊天路径上多一次网络请求是不能接受的，会直接拖慢每条回复。
   * 缓存由主动开口那条路负责刷新；没有缓存时 almanac 会退回
   * 保守的小时分段判断。
   */
  const nowText = describeNow(new Date(), peekSunTimes())

  /*
   * 她在忙吗。判断是启发式的（看她最近一条生活流水的形态），不额外调模型。
   *
   * 这里只算一次、同时给三个地方用：延迟、提示词里那句交代、主动报备。
   * 分三次算会不一致——比如延迟按"忙"算、提示词却按"不忙"给，
   * 那她晚回了几十秒却一个字不解释，用户只会觉得卡。
   */
  const busy = busyState()

  /*
   * 她困不困。
   *
   * 她的设定里写着"凌晨三四点睡、中午前后起"，但那以前只是一句**背景描述**，
   * 从来没影响过她说话——所以凌晨三点找她，她精神抖擞地陪你聊，
   * 看起来像一个永远有精力的服务，而不是一个会困的人。
   *
   * 这里算出来注入提示词：快睡时回得更短、语气发懒；
   * 真在睡时段被吵醒就应一声、别开新话题。注意**不拦回复**——
   * 让她消息发不出去是服务故障，不是真人感。
   */
  const sleepy = sleepiness()

  return {
    persona: readPersona(),
    memory: readMemory(),
    summary: summary.text,
    // 完整的时间/日期/农历/节假日/昼夜描述
    nowText,
    // 她手上正在忙的事（不忙时是空串）
    busySection: buildBusySection(busy),
    busy,
    // 她的困劲儿（清醒时是空串）
    sleepySection: buildSleepySection(sleepy),
    sleepy,
    // 它对自己的看法（会慢慢变），还没形成时是空串
    selfSection: buildSelfSection(),
    // 它自己的生活（不在聊天时也过日子），没有流水时是空串
    lifeSection: buildLifeSection(),
    /*
     * 她"这些天的日子"（按天压过的过去）。
     *
     * 跟 lifeSection 是两个粒度：那个是"昨天下午三点煮了面"（细节），
     * 这个是"那天大概什么样"（概览）。有了它她才**记得起来**上周的事，
     * 而不是只有最近 8 条流水。
     */
    lifeDaysSection: buildLifeDaysSection(),
    // 表情包清单 + 用法（没有表情包时是空串）
    stickerSection,
    stickerList: menu.list,
    recent,
    lastUserMessageAt: lastUser?.at ?? 0,
    lastAssistantMessageAt: lastAssistant?.at ?? 0,
    transcript: renderTranscript(recent, { now: now() }),
  }
}

/**
 * 把一条消息整理成喂给模型的形状。
 *
 * 有图的消息，content 要写成块数组（官方格式）：
 *   [{type:'text',text:...}, {type:'image_url',image_url:{url:'data:...'}}]
 * 没图的仍然用纯字符串——省 token，也让大多数消息保持简单。
 *
 * 图片只能放在 user 消息里：官方对 system / assistant 里的图片直接返回 400。
 */
export function toModelMessage(m) {
  const urls = Array.isArray(m.imageUrls) ? m.imageUrls : []
  if (m.role !== 'user' || urls.length === 0) {
    return { role: m.role, content: m.text }
  }
  return {
    role: 'user',
    content: [
      ...(m.text ? [{ type: 'text', text: m.text }] : []),
      ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  }
}

/**
 * 给最近的消息补上图片的 data URL。
 *
 * 只给最近几张配图，更早的图在文字里只留"[图片]"占位——
 * 图片按维度计费（一张最多 1024 token），全带上会把 prompt 撑爆，也很贵。
 */
function attachImages(recent, { maxCount = 4 } = {}) {
  const budget = new Map()
  let used = 0

  // 从后往前挑，优先保证最近发的图能看到
  for (let i = recent.length - 1; i >= 0 && used < maxCount; i--) {
    const ids = recent[i].meta?.images
    if (!Array.isArray(ids) || ids.length === 0) continue
    const take = []
    for (const id of ids) {
      if (used >= maxCount) break
      take.push(id)
      used++
    }
    if (take.length) budget.set(recent[i].seq, take)
  }

  return recent.map((m) => {
    const ids = budget.get(m.seq)
    if (!ids) return m
    const found = readRecentImages(ids, { maxCount: ids.length })
    if (found.length === 0) return m
    return { ...m, imageUrls: found.map((f) => f.url) }
  })
}

/* ------------------------------------------------------------ 用户说话 */

/**
 * 用户发来一句话（可带图），流式生成回复。
 *
 * @param {string} text
 * @param {{ onChunk?: (delta: string, full: string) => void, signal?: AbortSignal, images?: string[] }} hooks
 *        images 是若干 data URL
 * @returns {Promise<{ message: object, full: string }>}
 */
export async function respond(text, hooks = {}) {
  const cfg = loadConfig()
  const content = String(text ?? '').trim()
  const incoming = Array.isArray(hooks.images) ? hooks.images : []

  if (!content && incoming.length === 0) throw new Error('消息内容不能为空')

  noteUserAction()

  // 图片先落盘，消息里只记 id
  const saved = []
  for (const dataUrl of incoming.slice(0, 4)) {
    try {
      saved.push(saveImage(dataUrl))
    } catch (err) {
      log.warn(`一张图片没能保存：${err.message}`)
    }
  }

  const userMessage = store.append({
    role: 'user',
    text: content || '（发了张图）',
    ...(saved.length ? { meta: { images: saved.map((s) => s.id) } } : {}),
  })
  store.markUserMessage(userMessage.at)

  const ctx = buildContext(cfg)

  /*
   * 聊天场景的"距上次说话"要取**当前这条之前**的那条消息。
   * ctx.recent 的最后一条就是刚存进去的这句话，直接用它算会永远是"刚刚"，
   * 模型就不知道对方是隔了一天回来还是一直在聊。
   */
  const previous = ctx.recent.length >= 2 ? ctx.recent[ctx.recent.length - 2] : undefined

  const messages = [
    {
      role: 'system',
      content: buildChatSystemPrompt({ ...ctx, lastExchangeAt: previous?.at ?? 0 }),
    },
    ...ctx.recent.map(toModelMessage),
  ]

  /*
   * 她在忙就晚点回。
   *
   * 位置很关键：**放在拼完提示词之后、发请求之前**。
   * 放前面的话用户发完消息会先干等一下才看到"正在输入"，很像卡顿；
   * 放这里则是"消息发出去了（前端立刻显示），过一会儿她才开始打字"——
   * 那正是真人被占用时的样子。
   *
   * hook 是给调用方标记状态用的（前端可以显示"她可能在忙"），
   * 不传也不影响。
   *
   * ── 为什么要把 lastBusyWaitedAt 记下来 ──────────────
   * 同一个忙碌窗口里只等一次。不然她在忙的那 45 分钟里，
   * 用户发的每一条都要重新等几十秒，聊两句要等三分钟——
   * 那不是"她在忙"，那是"她卡住了"。
   * 标记先落，再睡：这样用户等的时候又发一条，第二条不用再等。
   */
  const delayMs = replyDelay(cfg, {
    state: ctx.busy,
    lastWaitedAt: store.state.lastBusyWaitedAt,
  })
  if (delayMs > 0) {
    store.state.lastBusyWaitedAt = ctx.busy.at
    store.saveState()
    hooks.onDelay?.(delayMs, ctx.busy)
    log.info(`她在忙（${truncate(ctx.busy.text, 24)}），${Math.round(delayMs / 1000)} 秒后再回`)
    await sleep(delayMs)
    // 等待期间对方可能撤回了 / 断线了
    if (hooks.signal?.aborted) {
      /*
       * 这一条没送到，那"等过了"就不算数：把标记退回去，
       * 下一条还会正常等一次。不然刷新一次页面就把那一次等待
       * 白白吃掉了，用户永远等不到解释。
       */
      store.state.lastBusyWaitedAt = 0
      store.saveState()
      throw new Error('已取消')
    }
  }

  store.state.generating = true
  store.saveState()

  let full = ''
  let lastShownLen = 0
  try {
    for await (const delta of streamChat(cfg, messages, { signal: hooks.signal })) {
      full += delta
      /*
       * 给前端的是**清洗过**的版本，不是原文。
       *
       * 关键是清洗的是 `full`（累计全文），不是单个 delta——
       * 前端用的也是 payload.full（它要显示整段并做逐字动画）。
       * 而双空格恰恰产生在分片边界上：模型分两次吐出 "a\n" 和 "\nb"，
       * 单独清洗各得 "a " 和 " b"，拼起来就是 "a  b"。
       * 在累计全文上清洗，' {2,}' 那一步才能把它收掉。
       */
      const shown = sanitizeFull(full)
      hooks.onChunk?.(shown.slice(lastShownLen), shown)
      lastShownLen = shown.length
    }
  } finally {
    store.state.generating = false
    store.saveState()
  }

  const cleaned = cleanupReply(full)
  if (!cleaned) {
    // 空回复也要留个痕迹，不然前端会一直转圈
    const fallback = store.append({ role: 'assistant', text: '（刚刚走神了，你说啥）', kind: 'chat' })
    store.markAssistantMessage(fallback.at)
    scheduleBackgroundWork(cfg)
    return { message: fallback, full: fallback.text }
  }

  /*
   * 表情包标记要在存消息**之前**抠掉。
   *
   * 抠掉的原因不只是好看：[表情包:3] 是给程序看的坐标，留在这条消息里，
   * 下一轮模型会在历史记录里看见自己上次写过它，于是更容易照抄格式，
   * 甚至以为"我上次已经发过这张了"。正文干净了，历史才干净。
   */
  const parsed = parseStickerMark(cleaned)
  const sticker = resolveSticker(cfg, parsed.index, ctx.stickerList)

  const message = store.append({
    role: 'assistant',
    text: parsed.text || '（发表情）',
    // 表情包复用图片通道：消息里只记 id，前端用 /api/image?id= 取
    ...(sticker ? { meta: { images: [sticker.id], sticker: true } } : {}),
  })
  noteStickerDelivered(sticker)
  store.markAssistantMessage(message.at)
  scheduleBackgroundWork(cfg)
  return { message, full: parsed.text, stickerId: sticker?.id ?? null }
}

/**
 * 清掉模型偶尔带的引号、旁白，以及**换行**。
 *
 * 换行是后加的，因为实测发现她会把回复写成带空行的多段：
 *
 *   "就是排队。\n\n你是新来的，先让你进最快的队。……\n\n快队排的人少，……"
 *
 * 在气泡里渲染出来就是段落之间空一行，像文档不像微信。
 * 统计过 400 条回复：39 条带换行，而且**全是 `\n\n`，单个 `\n` 一处都没有**——
 * 说明她确实在用"空行"分段，不是偶发。
 *
 * 为什么是"换行变空格"而不是"把 `\n\n` 收成一个 `\n`"：
 * 气泡是 white-space: pre-wrap，单个 `\n` 照样断行。
 * 而微信/iMessage 里连发两句话也是**一条连着显示**，不是两条。
 * 她的人设要的是"一次 1-2 句像打字"，那就该是一行。所以合成一句。
 */
function cleanupReply(text) {
  let out = String(text ?? '').trim()
  // 去掉整体包裹的引号
  if (/^["“][\s\S]*["”]$/.test(out) && out.length > 2) {
    out = out.slice(1, -1).trim()
  }
  // 去掉偶发的旁白式开头
  out = out.replace(/^(（[^）]*）|\([^)]*\))\s*/, '').trim()
  // 换行 → 空格（见上面说明）
  out = out.replace(/\s*\n+\s*/g, ' ').trim()
  return out
}

/**
 * 流式输出时给前端看的版本。
 *
 * 跟 cleanupReply 的差别：这里**不能 trim**，因为正文还没结束——
 * trim 会把正在打的空格吃掉，后面接上的字就黏在一起了。
 *
 * 三条：
 *   1. 换行变空格（否则屏幕上先空出一行、结束时又缩回去）
 *   2. 连续空格收成一个。**必须在累计全文上做**：双空格产生于分片边界
 *      （"a\n" + "\nb" 各自清洗成 "a " 和 " b"），单看一片是发现不了的
 *   3. 因为输入是累计全文，返回的也是全量——调用方自己算增量
 */
export function sanitizeFull(text) {
  return String(text ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
}

/**
 * 保留这个名字给单个分片用（测试和 __debug 在用）。
 * 只做换行处理，不做空格收敛——单片的空格收敛在跨片时没有意义。
 */
export function sanitizeChunk(delta) {
  return String(delta ?? '').replace(/\s*\n+\s*/g, ' ')
}

/* -------------------------------------------------------- 主动开口逻辑 */

/** 判断现在是否处于静默时段 */
export function inQuietHours(cfg, at = now()) {
  const { quietStart, quietEnd } = cfg.proactive
  const hour = new Date(at).getHours()
  if (quietStart === quietEnd) return false
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd
  // 跨零点，例如 22 → 9
  return hour >= quietStart || hour < quietEnd
}

/**
 * 硬性条件检查。任何一条不满足就直接不发，连模型都不用叫。
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function proactiveGate(cfg, at = now()) {
  const p = cfg.proactive
  if (!p.enabled) return { allowed: false, reason: '主动消息已关闭' }
  if (inQuietHours(cfg, at)) return { allowed: false, reason: '静默时段' }
  if (store.proactiveCountToday(at) >= p.maxPerDay) return { allowed: false, reason: `今天已达上限 ${p.maxPerDay} 次` }
  if (store.state.unansweredStreak >= p.maxUnanswered) {
    return { allowed: false, reason: `已连发 ${store.state.unansweredStreak} 条没回，先安静` }
  }
  const lastUser = store.lastUserMessage()
  if (lastUser && at - lastUser.at < p.minIdleMinutes * MINUTE) {
    return { allowed: false, reason: `对方刚说过话（${humanAgo(lastUser.at, at)}）` }
  }
  if (!store.state.nextProactiveAt || at < store.state.nextProactiveAt) {
    const wait = store.state.nextProactiveAt ? humanDuration(store.state.nextProactiveAt - at) : '尚未排期'
    return { allowed: false, reason: `距下次窗口还有 ${wait}` }
  }
  return { allowed: true }
}

/**
 * 记一次主动决策的流水。
 *
 * 为什么需要：state.json 里只存"最近一次"的拒绝理由，
 * 看不到一整天的模式。而"它为什么总不找我"这类问题，
 * 恰恰要看历史——是经常被闸门拦住，还是模型总说没必要。
 *
 * 只保留最近 N 条，且按天存文件，不做无限增长。
 */
export function recordProactiveEvent(event) {
  const sent = Boolean(event.sent)
  const line = {
    at: now(),
    // 两个都存：sent 给读取方判断，kind 给人看日志时一眼分清
    sent,
    kind: sent ? 'sent' : 'hold',
    reason: event.reason ?? '',
    messages: event.messages ?? [],
    forced: Boolean(event.forced),
    dryRun: Boolean(event.dryRun),
  }
  try {
    appendJsonl(path.join(PATHS.data, 'proactive.jsonl'), line)
    pruneProactiveLog()
  } catch (err) {
    log.warn(`写入主动决策流水失败：${err.message}`)
  }
  return line
}

/** 读最近 N 条主动决策流水（新的在前） */
export function readProactiveEvents(limit = 30) {
  const rows = readJsonl(path.join(PATHS.data, 'proactive.jsonl'))
  return rows.slice(-limit).reverse()
}

/** 日志超过这个行数就裁掉最旧的，避免无限增长 */
const PROACTIVE_LOG_MAX = 2000

function pruneProactiveLog() {
  const file = path.join(PATHS.data, 'proactive.jsonl')
  try {
    const rows = readJsonl(file)
    if (rows.length <= PROACTIVE_LOG_MAX) return
    const kept = rows.slice(-Math.floor(PROACTIVE_LOG_MAX * 0.8))
    writeJsonAtomic(file, kept)
    log.info(`主动决策流水已裁剪到 ${kept.length} 条`)
  } catch (err) {
    log.warn(`裁剪主动决策流水失败：${err.message}`)
  }
}

/** 排下一次主动窗口（随机间隔，避免准点报到） */
export function scheduleNextProactive(cfg = loadConfig()) {
  const { minGapMinutes, maxGapMinutes } = cfg.proactive
  const lo = Math.max(5, Math.min(minGapMinutes, maxGapMinutes))
  const hi = Math.max(lo, Math.max(minGapMinutes, maxGapMinutes))
  return store.scheduleNextProactive(randInt(lo, hi))
}

/**
 * 模型判断"现在不发"之后的重排。
 *
 * 必须比"发完"的间隔短得多。
 * 否则一旦模型连续几次说"不发"，每次都要再等 25-60 分钟才能问下一次，
 * 结果就是一上午一条都不发——这正是之前实测到的现象：
 * 09:12 判断不发之后，整整 94 分钟没有再检查过。
 *
 * 用户配的间隔是"两条消息之间至少隔多久"，不是"每次询问之间隔多久"。
 */
export function scheduleRetryAfterDecline(cfg = loadConfig()) {
  const { minGapMinutes, maxGapMinutes } = cfg.proactive
  // 取配置间隔的 1/4 到 1/2，并夹在 5-30 分钟之间
  const lo = Math.max(5, Math.round(Math.min(minGapMinutes, maxGapMinutes) / 4))
  const hi = Math.min(30, Math.max(lo + 3, Math.round(Math.max(minGapMinutes, maxGapMinutes) / 2)))
  return store.scheduleNextProactive(randInt(lo, hi))
}

/**
 * 醒来一次，决定要不要主动找对方。
 * @param {{ force?: boolean, dryRun?: boolean }} options force 用于手动测试，跳过所有硬性拦截
 */
export async function runProactiveCheck(options = {}) {
  const cfg = loadConfig()
  const at = now()
  const { force = false, dryRun = false } = options
  // 演练模式要能看到"本来会发什么"，所以跳过硬性拦截，但绝不落盘
  const bypassGate = force || dryRun

  const gate = proactiveGate(cfg, at)
  if (!gate.allowed && !bypassGate) {
    store.state.lastHoldReason = gate.reason
    store.saveState()
    // 流水也记一条：闸门拦截（比如"距下次窗口还有 8 分钟"）
    if (!dryRun) recordProactiveEvent({ sent: false, reason: `[闸门] ${gate.reason}` })
    return { sent: false, reason: gate.reason }
  }

  /*
   * 她睡觉的时候不主动找人说话。
   *
   * 这是四道闸门之外的第五道，跟"静默时段"不同：
   * 静默时段是**用户配的**（"晚上 22 点到早上 7 点别打扰我"），
   * 这道是**她自己的作息**（她一般 3 点睡、12 点起）。
   * 两者可以不一样：用户可能允许半夜被打扰，但那时候她自己在睡。
   *
   * 只拦主动开口。对方先说话她还是会回——只是回得又短又困
   * （见 sleepySection）。让她消息发不出去是服务故障，不是真人感。
   */
  const sleepGate = activeHoursGate(cfg, at)
  if (!sleepGate.ok && !bypassGate) {
    store.state.lastHoldReason = sleepGate.reason
    store.saveState()
    if (!dryRun) recordProactiveEvent({ sent: false, reason: `[睡觉] ${sleepGate.reason}` })
    return { sent: false, reason: sleepGate.reason }
  }

  const ctx = buildContext(cfg)

  /*
   * 天气只在**主动开口**这条路上给。
   *
   * 这是刻意的：聊天回复里带天气，她会每句话都挂一句"今天 26 度挺舒服"，
   * 立刻变成天气播报员，人设全崩。而主动开口时提天气是最自然的——
   * "下雨了"本身就是个很好的搭话由头。
   *
   * getWeather 内部有 15 分钟缓存，而且断网/超时会静默返回缓存或 null，
   * 不会让主动检查失败。
   */
  const weather = cfg.weather?.inProactive === false ? null : await getWeather(cfg)
  ctx.weatherSection = buildWeatherSection(weather)
  // 拿到新鲜数据后重算一次时间描述（日出日落可能比缓存里更准）
  if (weather?.sunrise) {
    ctx.nowText = describeNow(new Date(at), { sunrise: weather.sunrise, sunset: weather.sunset })
  }

  /*
   * 待回访的事。
   *
   * 这是记忆第一次变成**主动行为**：以前她只会在你问起时想起来，
   * 现在到期的事会进主动开口的候选话题——"你上次说实习那事后来怎么样了"。
   * 一个真朋友会这样，一个只会应答的系统不会。
   *
   * 只在主动开口时给。聊天回复里塞这个会让她显得像在"交作业"。
   */
  const due = dueRecalls({ at })
  ctx.recallSection = buildRecallSection({ at })
  ctx.dueRecallIds = due.map((it) => it.id)

  const context = {
    lastUserAgo: humanAgo(store.state.lastUserMessageAt, at),
    lastAssistantAgo: humanAgo(store.state.lastAssistantMessageAt, at),
    unansweredStreak: store.state.unansweredStreak,
    todayCount: store.proactiveCountToday(at),
    userWatching: isUserWatchingScreen(),
  }

  const decisionPrompt = buildProactiveDecisionPrompt({ ...ctx, context })

  // 什么时候让模型先做判断、什么时候直接生成：
  // - 手动 force：跳过判断，直接发
  // - dryRun：让它真的判一次，这样演练结果才有参考价值
  // - 配置关掉 letModelDecide：直接生成
  let decision
  if (cfg.proactive.letModelDecide && !force) {
    try {
      decision = await completeJson(cfg, decisionPrompt, { maxTokens: 500 })
    } catch (err) {
      log.warn(`主动判断失败，这次跳过：${err.message}`)
      if (!dryRun) scheduleRetryAfterDecline(cfg)
      if (!dryRun) recordProactiveEvent({ sent: false, reason: `[判断失败] ${err.message}` })
      return { sent: false, reason: `判断失败：${err.message}` }
    }
  } else {
    decision = { send: true, reason: force ? '手动触发' : '配置为每次都发', messages: [] }
  }

  const wantsSend = decision?.send === true
  if (!wantsSend) {
    const reason = String(decision?.reason ?? '模型认为现在不适合开口')
    store.state.lastHoldReason = reason
    store.saveState()
    // 关键：只是"这次不发"，不是"接下来一小时都别再问"。
    // 用短重试窗口，让它过十来分钟还有机会再看一眼。
    if (!dryRun) scheduleRetryAfterDecline(cfg)
    if (!dryRun) recordProactiveEvent({ sent: false, reason })
    log.info(`主动检查：不发（${truncate(reason, 50)}）→ 下次窗口重新排期`)
    return { sent: false, reason, mood: decision?.mood, dryRun }
  }

  // 模型可能只给了 send=true 却没给内容，那就让它正经写一条
  let queue = normalizeMessages(decision?.messages)
  /*
   * 走"决策里直接给了消息"这条路时，没有表情包——清单只在
   * 生成提示词里，决策提示词里不带清单（决策阶段不该操心发哪张图）。
   * 想让她主动时也能发表情包，得走下面生成那条路。
   */
  let sticker = null
  if (queue.length === 0) {
    const generated = await generateProactiveMessages(cfg, ctx, decision?.mood)
    queue = generated.messages ?? []
    sticker = generated.sticker ?? null
  }
  if (queue.length === 0) {
    if (!dryRun) scheduleRetryAfterDecline(cfg)
    if (!dryRun) recordProactiveEvent({ sent: false, reason: '[空内容] 模型没有产出可用的消息' })
    return { sent: false, reason: '模型没有产出可用的消息' }
  }

  if (dryRun) {
    recordProactiveEvent({ sent: false, dryRun: true, reason: decision?.reason, messages: queue })
    return { sent: false, dryRun: true, wouldSend: queue, reason: decision?.reason, mood: decision?.mood }
  }

  const sent = []
  for (let i = 0; i < queue.length; i++) {
    /*
     * 整条只有一张表情包（正文为空）的情况。
     *
     * 这是主动开口里很自然的一种：没什么可说，就想发个表情。
     * 但文字为空的消息在前端会渲染成一个空气泡，所以正文给个占位符，
     * 同时打上 sticker 标记让前端只画图、不画那个占位文字。
     */
    const onlySticker = Boolean(queue[i]?.stickerOnly)
    if (onlySticker && !sticker) continue

    if (i > 0) {
      // 连发第二条前先"打一会儿字"
      await sleep(randInt(1200, 3200))
    }

    /*
     * 表情包挂在**第一条**上，而且必须在 append 那一刻就带上。
     *
     * 试过先 append 再改 meta，不行：messages.jsonl 是只追加的，
     * 改内存里的对象不会落盘，重启后表情包就丢了。
     * 所以这里先算好要不要挂，再一次性 append。
     */
    const attach = Boolean(sticker) && i === 0
    const message = store.append({
      role: 'assistant',
      text: onlySticker ? '（发表情）' : queue[i],
      ...(attach || onlySticker ? { meta: { images: [sticker.id], sticker: true } } : {}),
      kind: 'proactive',
    })
    store.noteProactive(message.at)
    sent.push(message)
    log.info(
      `主动发送（${i + 1}/${queue.length}）：` +
        `${truncate(onlySticker ? '[表情包]' : queue[i], 40)}` +
        `${attach && !onlySticker ? '（带表情包）' : ''}`,
    )
  }

  if (sent.length === 0) {
    if (!dryRun) scheduleRetryAfterDecline(cfg)
    recordProactiveEvent({ sent: false, reason: '只有表情包但没能兑出图片' })
    return { sent: false, reason: '只有表情包但没能兑出图片' }
  }

  // 消息真的发出去了才记账
  noteStickerDelivered(sticker)

  /*
   * 待回访的事也标记成"问过了"。
   *
   * 刻意不判断"她到底问没问"（那要再调一次模型，不值）。
   * 理由是：这些事已经作为话题给她了，过期再喂一次反而会让她反复问同一件事——
   * 那比"漏问一次"更像机器人。宁可少问，不要重问。
   *
   * force/dryRun 不标记：那是调试路径，不该消耗掉真实的话题。
   */
  if (!force && Array.isArray(ctx.dueRecallIds) && ctx.dueRecallIds.length) {
    for (const id of ctx.dueRecallIds) markAsked(id)
    pruneRecall()
  }

  store.state.lastHoldReason = ''
  store.state.lastAssistantMessageAt = now()
  store.saveState()

  // 对方不在看屏幕才推手机。
  //
  // force 模式（手动触发、以及测试）**不推送**：
  // 那是调试用的路径，不该在用户手机上留痕。
  // 之前没有这道判断，测试重复跑就把同一条消息推了十几遍，
  // 而且推的还是用户自己说的那句话。
  if (force) {
    log.info('强制模式：已发送但不推送手机')
  } else if (!context.userWatching) {
    await sendPushFor(sent)
  } else {
    log.info('对方正在应用里，跳过推送')
  }

  scheduleNextProactive(cfg)
  recordProactiveEvent({ sent: true, messages: sent.map((m) => m.text), forced: force, reason: decision?.reason })
  return { sent: true, messages: sent.map((m) => m.text), reason: decision?.reason, mood: decision?.mood }
}

/**
 * 生成主动开口的内容。
 *
 * 走的是**专用的主动提示词**，不是聊天提示词。
 * 用聊天提示词会让模型以为自己是在回复，从而说出前后不搭的话。
 *
 * 时间锚点取"对方上次说话"，不是"最后一条消息"——
 * 否则主动发过几条之后，它看到的永远是"刚刚"，然后不停重复同一句话。
 */
async function generateProactiveMessages(cfg, ctx, mood) {
  const at = now()
  const messages = buildProactiveMessagePrompt({
    persona: ctx.persona,
    memory: ctx.memory,
    summary: ctx.summary,
    transcript: ctx.transcript,
    lastUserAgo: humanAgo(ctx.lastUserMessageAt, at),
    lastAssistantAgo: humanAgo(ctx.lastAssistantMessageAt, at),
    unansweredStreak: store.state.unansweredStreak,
    todayCount: store.proactiveCountToday(at),
    mood,
    /*
     * 这两段原来漏传了——buildProactiveMessagePrompt 的签名里收，
     * 但调用处没给，所以它主动开口时**看不见自己的生活和自我认知**，
     * 只能靠聊天记录瞎猜。主动消息比回复更容易"没话找话"，
     * 恰恰最需要这两份材料。
     */
    selfSection: ctx.selfSection,
    lifeSection: ctx.lifeSection,
    lifeDaysSection: ctx.lifeDaysSection,
    stickerSection: ctx.stickerSection,
    nowText: ctx.nowText,
    weatherSection: ctx.weatherSection,
    recallSection: ctx.recallSection,
  })

  try {
    const text = await complete(cfg, messages, {
      temperature: cfg.model.temperature,
      maxTokens: 600,
    })

    return finishProactiveText(cfg, text, ctx)
  } catch (err) {
    log.warn(`主动消息生成失败：${err.message}`)
    return { messages: [], stickerId: null }
  }
}

/**
 * 把模型给的原文变成"要发的消息 + 可选的一张表情包"。
 *
 * 三条解析路径（JSON / 打捞 / 纯文本）原来各自 return，现在统一收口——
 * 因为表情包标记的抠取对三条路径是同一件事，分开写迟早漏一条。
 */
function finishProactiveText(cfg, text, ctx) {
  let list = []

  // 1) 正常路径：期望模型返回 {"messages": [...]}
  const parsed = extractJson(text)
  if (parsed && Array.isArray(parsed.messages)) {
    list = normalizeMessages(parsed.messages)
  } else if (/^\s*(?:```json)?\s*\{/.test(text) || /"messages"\s*:/.test(text)) {
    // 2) 解析失败但看得出是 JSON → 打捞里面已经写好的字符串，
    //    绝不能把 JSON 原文当成消息发出去
    list = normalizeMessages(salvageJsonStrings(text))
    if (list.length > 0) {
      log.warn(`主动消息的 JSON 不完整，已打捞 ${list.length} 条内容`)
    } else {
      log.warn('主动消息的 JSON 无法解析且打捞不到内容，这次跳过')
      return { messages: [], stickerId: null }
    }
  } else {
    // 3) 模型直接给了纯文本（没走 JSON）→ 按行切
    list = normalizeMessages(text.split('\n'))
  }

  /*
   * 表情包标记可能出现在任意一条里（模型经常单独占一行写它）。
   * 逐条抠掉，只认第一张——真人也只发一张。
   */
  let index = null
  const cleaned = []
  for (const line of list) {
    const p = parseStickerMark(line)
    if (p.index !== null && index === null) index = p.index
    if (p.text) cleaned.push(p.text)
  }

  /*
   * 全被标记吃掉了（模型只回了一行 [表情包:3]，没有正文）——
   * 这是很自然的一种：想发个表情包但没什么可说。允许。
   */
  const item = resolveSticker(cfg, index, ctx.stickerList)
  if (cleaned.length === 0 && item) {
    return { messages: [{ text: '', stickerOnly: true }], sticker: item }
  }

  /*
   * 只有标记、但表情包没兑出来（编号越界或撞了闸门）→ 这次什么都不发。
   * 不能退化成发一条空消息。
   */
  if (cleaned.length === 0) return { messages: [], sticker: null }

  return { messages: cleaned, sticker: item }
}

/**
 * 清洗模型给出的消息数组：去编号、去空行、最多两条。
 *
 * 还要防一类很难发现的错误：模型想返回 JSON，但因为 token 截断等原因
 * 输出不完整，于是解析失败、回退到按行切分，结果 **整段 JSON 原文被当成消息发出去**。
 * 用户会看到 `{"messages": ["..."]` 这种东西。
 */
function normalizeMessages(input) {
  const list = Array.isArray(input) ? input : []
  return list
    // 一条消息内部不该再有换行——主动开口的每条都是独立的一行
    .map((line) => String(line ?? '').replace(/\s*\n+\s*/g, ' ').trim())
    .map(stripListPrefix)
    .filter((line) => line.length > 0 && !looksLikeJsonGarbage(line))
    .slice(0, 2)
}

/** 去掉行首的编号或项目符号 */
function stripListPrefix(line) {
  return line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim()
}

/** 这行是不是"JSON 残渣"（不该被当成聊天内容发出去） */
function looksLikeJsonGarbage(line) {
  if (/^\s*\{\s*"?(messages|text|content)"?\s*:/i.test(line)) return true
  if (line.startsWith('```')) return true
  return false
}

/**
 * 从一段残缺的 JSON 里把已经写好的字符串捞出来。
 *
 * 例：'{"messages": ["十一点去吃饭", "然后回' → ['十一点去吃饭']
 * 比"整段丢弃"好得多：至少保住已经生成的完整内容。
 */
function salvageJsonStrings(text) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let match
  while ((match = re.exec(text)) !== null) {
    const raw = match[1]
    // 跳掉 JSON 的键名
    if (raw === 'messages' || raw === 'message' || raw === 'text' || raw === 'content') continue
    // 跳过被截断的最后一个字符串：它后面不是引号或 , ] }
    const after = text.slice(re.lastIndex).trimStart()
    const complete = after.startsWith(',') || after.startsWith(']') || after.startsWith('}')
    if (!complete) continue
    try {
      out.push(JSON.parse(`"${raw}"`))
    } catch {
      out.push(raw)
    }
  }
  return out
}

/**
 * 推送主动消息到手机。
 *
 * 只推**自己刚发出的**消息。
 *
 * 之前没有这道检查，而 force 模式和测试走的是同一条推送路径，
 * 于是把"用户自己说的最后一句话"也推给了用户——
 * 实测用户手机上收到了自己发的"挺不错的，我十二点零五才下课"，
 * 而且因为测试重复跑，同一条推了好几遍。
 */
async function sendPushFor(messages) {
  /*
   * 硬开关：FRIEND_NO_PUSH=1 时物理上不可能推送。
   *
   * 为什么需要这个：测试会跑真实代码路径，而推送会真的响用户手机。
   * 光靠"force 模式不推"这种逻辑判断不够——实测还是漏了，
   * 用户手机收到过自己发的消息，而且是十几遍。
   * 与其靠判断，不如给测试一把总闸。
   */
  if (process.env.FRIEND_NO_PUSH === '1') {
    log.info('FRIEND_NO_PUSH=1，跳过推送（测试环境）')
    return
  }

  const cfg = loadConfig()

  // 只推 assistant 发的。任何情况下都不该把用户自己的话推回给用户。
  const own = messages.filter((m) => m.role === 'assistant')
  if (own.length === 0) {
    log.warn('没有可推送的自身消息（避免把用户自己的话推回去），跳过推送')
    return
  }

  const body = own.map((m) => m.text).join('\n')

  if (!cfg.bark.key) {
    log.info('未配置 Bark Key，跳过推送')
    recordPush({ ok: false, kind: 'proactive', reason: 'no-key', body: truncate(body, 80) })
    return
  }

  // 标题优先用显式配置的 group；没配就用人设里的角色名。
  // 不要在这里写死名字——改人设必须能带出正确的标题。
  const title = (cfg.bark.group && String(cfg.bark.group).trim()) || characterName()

  try {
    await push(cfg, { body, title })
    log.info(`已推送 Bark（标题：${title}）`)
    recordPush({ ok: true, kind: 'proactive', title, body: truncate(body, 80) })
  } catch (err) {
    log.warn(`Bark 推送失败：${err.message}（消息已存下来，打开应用就能看到）`)
    recordPush({ ok: false, kind: 'proactive', reason: err.message, title, body: truncate(body, 80) })
  }
}

/* --------------------------------------------------- 后台：记忆与摘要 */

/**
 * 每次对话结束后，在后台做两件慢活：
 * 1. 攒够消息就抽取长期记忆
 * 2. 对话太长就滚动压缩成摘要
 *
 * 两件事都必须有节流，否则每来一条消息就会各调一次模型——
 * 既费钱又拖慢响应，日志里会看到"已压缩摘要"刷屏。
 */
const bg = {
  lastSummaryAt: 0,
  lastSummarySeq: 0,
  lastMemoryAt: 0,
  memoryInFlight: false,
  summaryInFlight: false,
  lastBackupDay: '',
  backupInFlight: false,
  lastSelfCheckAt: 0,
  selfInFlight: false,
}

/** 摘要在覆盖这么多条新消息之前不再重算 */
const SUMMARY_MIN_NEW_MESSAGES = 20
/** 两次摘要之间至少隔这么久（毫秒） */
const SUMMARY_MIN_INTERVAL_MS = 10 * 60 * 1000
/** 两次记忆抽取之间至少隔这么久 */
const MEMORY_MIN_INTERVAL_MS = 5 * 60 * 1000

/* ------------------------------------------------------------ 她在长大 */

/**
 * 她会慢慢改变对自己的看法。
 *
 * **由经历触发，不由时间触发。** 这是这个功能的核心：
 * 真人不会因为"过了一天"就想通什么事，是因为**遇到了什么**才想通。
 * 所以这里不问"多久没长了"，而是问"她又经历了多少新东西"：
 *
 *   - 她自己过了若干段日子（日志新增 cfg.self.evolveAfterExperiences 条）
 *   - 或者你们聊了若干条新消息（cfg.self.evolveAfterMessages 条）
 *
 * 两条任满足就去看一眼。**看了不代表会改**——提示词里明确允许它
 * 原样返回。什么都没发生的话，聊 200 条她也不变。
 *
 * minCheckIntervalMs 不是成长频率，是防抖：没有它，连发 12 条消息
 * 就会触发一次模型调用。
 *
 * 游标存在 state.json 里（落盘），所以重启不会让它重复消化同一段经历，
 * 也不会因为重启就"白捡一次成长"。
 */
function maybeEvolveSelf(cfg) {
  if (!cfg.self?.enabled) return
  if (bg.selfInFlight) return

  const total = store.messages.length
  const seenAt = store.state.selfSeenAt ?? 0

  /*
   * 第一次运行：把游标对齐到"现在"。
   *
   * 不对齐的话，一个已经聊了几百条、生活流水也写了不少的存量用户，
   * 升级后第一次对话就会把全部历史当成"新经历"喂进去——
   * 那可能一次性消化掉几个月的事，长出一个莫名其妙的人。
   * 成长从现在开始，不追溯。
   */
  if (!seenAt) {
    store.state.selfSeenAt = now()
    store.state.selfSeenMessages = total
    store.saveState()
    return
  }

  const newExperiences = journalSince(seenAt).length
  const newMessages = total - (store.state.selfSeenMessages ?? total)

  const due =
    newExperiences >= cfg.self.evolveAfterExperiences ||
    newMessages >= cfg.self.evolveAfterMessages
  const cooled = now() - (bg.lastSelfCheckAt ?? 0) >= cfg.self.minCheckIntervalMs
  if (!due || !cooled) return

  const experiences = renderExperiences(journalSince(seenAt))
  const transcript = renderTranscript(store.recent(40), { maxChars: 9000, now: now() })
  if (!experiences.trim() && !transcript.trim()) return

  bg.lastSelfCheckAt = now()
  bg.selfInFlight = true

  void evolveSelf(cfg, { experiences, transcript })
    .then((r) => {
      /*
       * 游标只在**看过之后**才推进，而且不管改没改都推进。
       *
       * 改没改都要推进是刻意的：如果只在"改了"的时候推进，
       * 那么一段没什么可内化的经历会被反复喂进去，每次都想找点东西改，
       * 最后逼出一堆为了改而改的废话。
       */
      store.state.selfSeenAt = now()
      store.state.selfSeenMessages = total
      store.saveState()

      if (r.updated) {
        log.info(`她经历了一些事，对自己有了新的想法（+${r.added?.length ?? 0} / -${r.removed?.length ?? 0} 行）`)
      } else {
        log.info(`她经历了一些事，但没什么改变看法的：${r.reason}`)
      }
    })
    .catch((err) => log.warn(`自我更新失败：${err.message}`))
    .finally(() => {
      bg.selfInFlight = false
    })
}

function scheduleBackgroundWork(cfg) {
  const total = store.messages.length

  /* ---------- 她的成长 ---------- */
  // 放在最前面：它最贵也最慢，让它先排上队
  maybeEvolveSelf(cfg)

  /* ---------- 记忆抽取 ---------- */
  const memoryDue = total - store.state.memoryCursor >= cfg.memory.extractEveryMessages
  const memoryCooled = now() - bg.lastMemoryAt >= MEMORY_MIN_INTERVAL_MS
  if (memoryDue && memoryCooled && !bg.memoryInFlight) {
    store.state.memoryCursor = total
    store.saveState()
    bg.memoryInFlight = true
    bg.lastMemoryAt = now()
    void extractMemory(cfg)
      .catch((err) => log.warn(`记忆抽取失败：${err.message}`))
      .finally(() => {
        bg.memoryInFlight = false
      })
  }

  /* ---------- 摘要压缩 ---------- */
  // 摘要覆盖到的位置
  const covered = readSummary().upToSeq
  const newSinceSummary = total - covered
  const summaryDue =
    total > cfg.context.summarizeAbove && newSinceSummary >= SUMMARY_MIN_NEW_MESSAGES
  const summaryCooled = now() - bg.lastSummaryAt >= SUMMARY_MIN_INTERVAL_MS

  if (summaryDue && summaryCooled && !bg.summaryInFlight) {
    bg.summaryInFlight = true
    bg.lastSummaryAt = now()
    bg.lastSummarySeq = total
    void rollSummary(cfg)
      .catch((err) => log.warn(`摘要压缩失败：${err.message}`))
      .finally(() => {
        bg.summaryInFlight = false
      })
  }

  /* ---------- 每日备份 ---------- */
  // 用"今天备份过没有"判断，而不是定时器——
  // 电脑睡眠/重启后定时器会错乱，日期判断不会。
  const today = localDateKey()
  if (bg.lastBackupDay !== today && !bg.backupInFlight) {
    bg.backupInFlight = true
    try {
      const result = runBackup()
      // 无论这次是不是真的写了盘（可能今天已经备过），都记下日期，
      // 避免每次对话都去查一遍文件系统
      bg.lastBackupDay = today
      if (!result.created && result.reason) {
        // 今天已经备过，静默跳过
      }
    } catch (err) {
      log.warn(`备份失败：${err.message}`)
    } finally {
      bg.backupInFlight = false
    }
  }
}

/** 让模型更新长期记忆档案 */
export async function extractMemory(cfg = loadConfig()) {
  const existing = readMemory()
  const transcript = renderTranscript(store.recent(40), { maxChars: 9000, now: now() })
  if (!transcript) return { updated: false, reason: '没有可用对话' }

  /*
   * 记忆和"待回访的事"一起抽，但用两次独立调用。
   *
   * 不合成一次的原因：记忆那份的输出必须是**干净的 markdown 文件**，
   * 混进 JSON 会把文件弄脏。而且两者性质不同——记忆是长期事实，
   * 回访是几天内有效的临时跟进。
   *
   * 回访那次失败不影响记忆：那只是锦上添花。
   */
  const [memoryResult, recallResult] = await Promise.allSettled([
    complete(cfg, buildMemoryPrompt({ existingMemory: existing, transcript }), { maxTokens: 800 }),
    extractRecalls(cfg, transcript),
  ])

  const recalls = recallResult.status === 'fulfilled' ? recallResult.value : { added: 0 }
  if (recallResult.status === 'rejected') {
    log.warn(`抽取待回访事项失败：${recallResult.reason?.message ?? recallResult.reason}`)
  }

  if (memoryResult.status === 'rejected') {
    return { updated: false, reason: `记忆抽取失败：${memoryResult.reason?.message}` }
  }

  const cleaned = String(memoryResult.value ?? '').trim()
  if (!cleaned || cleaned.length < 10) return { updated: false, reason: '模型返回内容太短' }

  writeMemory(cleaned)
  log.info(
    `已更新长期记忆档案${recalls.added ? `，新增 ${recalls.added} 件待回访的事` : ''}`,
  )
  return { updated: true, memory: cleaned, recalls }
}

/**
 * 从最近的对话里挑出"过几天该回头问问"的事。
 *
 * 这是记忆第一次变成**主动行为**：以前她只在你问起时想起来，
 * 现在这些事会到期进她主动开口的候选话题。
 */
async function extractRecalls(cfg, transcript) {
  const existing = readRecall().items.filter((it) => !it.askedAt).map((it) => it.text)

  const text = await complete(cfg, buildRecallPrompt({ transcript, existing }), {
    maxTokens: 400,
    // 这件事要的是"判断"，不是"发挥"——温度高了会硬凑
    temperature: 0.3,
  })

  const parsed = extractJson(text)
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  let added = 0
  for (const it of items) {
    const entry = addRecall({
      text: it?.text,
      afterDays: Number.isFinite(it?.afterDays) ? Math.min(14, Math.max(1, it.afterDays)) : undefined,
      source: 'chat',
    })
    if (entry) added++
  }
  return { added, considered: items.length }
}

/** 把早期对话压进摘要 */
export async function rollSummary(cfg = loadConfig()) {
  const total = store.messages.length
  const keepRecent = cfg.context.recentMessages
  const cutoffIndex = Math.max(0, total - keepRecent)
  if (cutoffIndex <= 0) return { updated: false, reason: '消息还不够多' }

  const toCompress = store.messages.slice(0, cutoffIndex).filter((m) => m.kind !== 'system')
  if (toCompress.length < 10) return { updated: false, reason: '待压缩内容太少' }

  const previous = readSummary()
  const transcript = renderTranscript(toCompress, { maxChars: 14000, now: now() })
  const text = await complete(cfg, buildSummaryPrompt({ previousSummary: previous.text, transcript }), { maxTokens: 600 })
  const cleaned = text.trim()
  if (!cleaned) return { updated: false, reason: '模型返回空摘要' }

  const upToSeq = toCompress[toCompress.length - 1].seq
  writeSummary(cleaned, upToSeq)
  log.info(`已压缩摘要（覆盖到第 ${upToSeq} 条）`)
  return { updated: true, summary: cleaned, upToSeq }
}

export { isUserWatchingScreen, buildContext, activity }

/** 仅供测试使用，不要在生产路径里调用 */
export const __debug = {
  normalizeMessages,
  salvageJsonStrings,
  looksLikeJsonGarbage,
  // cleanupReply 没导出（它是 respond 的内部步骤），但换行清洗是这次的重点，
  // 必须有测试盯着——所以通过 __debug 暴露出来
  cleanupReply,
  sanitizeChunk,
  sanitizeFull,
}
