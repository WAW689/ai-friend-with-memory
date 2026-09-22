/**
 * 她在忙吗。
 *
 * 要解决的问题：以前你发消息她**秒回**。这恰恰是最不像真人的地方——
 * 真朋友不会永远在线等你。而且她本来就有生活（你安静的时候她真的在过日子），
 * 只是那条生活和聊天完全隔离，两边互不知道对方存在。
 *
 * 三个产出：
 *   1. **回复延迟**：在忙就等几十秒再回，不是立刻
 *   2. **交代一句**：她开口时会说"等下，我在煮东西"——这样延迟就不像卡顿
 *   3. **主动报备**：她要去忙（或去睡）时，主动说一句"我去忙了"
 *
 * 第 3 条对用户其实最值钱：真人朋友之间这句话很重要，它把"你没回我"
 * 从"他不想理我"变成"他在忙"。用户会因为"看到她在线没回"多想，
 * 而一句报备能省掉那部分内耗。
 *
 * 判断方式是**启发式**，不额外调模型：
 * 她最近一条生活流水如果是"正在做某件事"的形态（煮面、骑车、洗澡、写代码），
 * 就认为还在忙；"做完了"的形态（吃完了、洗完了、睡醒了）就认为不忙。
 *
 * 为什么不上模型判断：每来一条消息都多调一次模型，成本和延迟都不划算，
 * 而这件事的精度要求不高——判错了最多是"她晚回了几十秒"或者
 * "她说自己在忙但其实没忙"，都不致命。
 */
import { now, randInt } from './util.js'
import { parseActivity } from './activity.js'
import { readJournal } from './life.js'

/**
 * 忙的形态。
 *
 * 分两档，因为"忙多久"差别很大：
 *   heavy  手上占着、一时半会停不下来（做饭、洗澡、骑车、睡觉）
 *   light  在做但随时能看手机（看剧、刷手机、写代码、打游戏）
 *
 * 每档给一个秒数区间。数字是刻意这么选的：
 *   - 低于 15 秒感知不到"她在忙"，那不如不延迟
 *   - 高于 3 分钟用户会以为消息没发出去，开始怀疑服务挂了
 */
/**
 * 忙的档位。**判据是动词，不是整句话的模式。**
 *
 * 这里踩过两次坑，都是同一个毛病：穷举具体搭配。
 *   1. 只写了"洗澡"，而她的流水是"凑合洗完" → 判成不忙
 *   2. 只写了"改图"，她说的是"改页面""三百块的活改八遍" → 判成不忙
 *      （第二次更隐蔽：补上"改遍"之后还是漏——
 *        因为"改"和"遍"中间夹了个"八"，模式永远追不上自然语言）
 *
 * 所以现在拿 status.js 解析出来的**动词**去比对。
 * 动词是最稳的那一层："改八遍""改到第四版""改页面"都归到"改"。
 */
const VERB_LEVEL = {
  // 手上占着、一时半会停不下来
  heavy: new Set([
    '煮', '做饭', '洗碗', '洗澡', '洗头', '洗完', '洗',
    '出门', '下楼', '上楼', '下楼拿', '上楼拿', '排队',
    '睡', '躺下', '躺着', '骑车', '骑', '买', '喂', '晾',
  ]),
  // 在做，但能看手机
  light: new Set(['改', '写', '做', '看', '刷', '投', '收拾', '拿', '取', '吃', '喝', '调']),
}

/**
 * 明确"这件事已经结束了"的信号。命中就不算忙。
 *
 * 判据刻意**又窄又自洽**：只认"吃完**了**""洗完**了**"这种
 * 带完成补语的形态，而不是认"吃完""洗完"这两个词本身。
 *
 * 这个区别不是抠字眼，是被测试逼出来的：
 *   · "凑合洗完"  ← 她的流水，意思是"我刚洗了个澡"，手上还湿着 → 算忙
 *   · "面吃完了"  ← 明确吃完了，还说"在吃面"很怪 → 不算忙
 * 两者的差别就在那个"了"上。按词判会自相矛盾（"洗完"既在完成表里、
 * 又在"算忙"的动词表里），按形态判就干净了。
 *
 * 另外刻意**不扩大**成"一切完成态"：流水记的本来就是刚发生的事，
 * 几乎每条都是完成态（"改了第四版""下楼拿了快递"），
 * 那样判她永远不忙，功能等于没有。
 */
const DONE_MARKERS = /完了|好了/

/**
 * 兜底：动词认不出来时，再从整句里找"明确的忙碌信号"。
 *
 * 保留这一层是因为她有些话没有动词，
 * 比如"土豆把纸巾刨得满地都是"——那明显是手上有事。
 */
const EXTRA_PATTERNS = [
  { level: 'heavy', re: /电动车|路上|超市|买菜|快递|在楼下/ },
  { level: 'light', re: /看剧|刷手机|打游戏|写代码|改图|接活|返工|投简历|看书|听歌|发呆|猫|土豆/ },
]

/**
 * 忙的档位 → 延迟秒数区间。
 *
 * 数字是刻意选的：
 *   - 低于 10 秒感知不到"她在忙"，那不如不延迟
 *   - 高于 3 分钟用户会以为消息没发出去，开始怀疑服务挂了
 */
const DELAY_RANGE = {
  heavy: [35, 150],
  light: [12, 60],
}

/**
 * 同一条流水最多算它"还在忙"多久。
 *
 * 超过这个时间她肯定已经做完了——没见过谁拿个快递拿两小时。
 */
const FRESHNESS_MS = 45 * 60 * 1000

/**
 * 现在她在忙吗。
 *
 * ── 一个刻意放弃的判断 ──────────────────────────────
 * 本来想从流水文本里判断"这件事做完了没"（有"洗完""吃完""回来"就不算忙）。
 * **放弃了**，因为那个信号本身太弱：流水记的本来就是"刚发生的事"，
 * 所以几乎每条都是完成态（"改了第四版""下楼拿了快递"），
 * 照那个规则判，她永远不忙，功能等于没有。
 *
 * 时间才是可靠的信号：最近 45 分钟内有新流水 → 她多半还在做那件事。
 * 万一她已经做完了，也不会出问题——提示词里写着
 * "如果已经弄完了，那就正常说，不用提'我刚在忙'"，
 * 她按实际内容自己判断就好。
 *
 * @param {{at?: number}} [opts]
 * @returns {{level: 'heavy'|'light'|'idle', text: string, at: number, ageMs: number}}
 */
export function busyState({ at = now() } = {}) {
  const idle = { level: 'idle', text: '', at: 0, ageMs: 0 }

  const journal = readJournal()
  if (journal.length === 0) return idle

  // 只看最近一条：更早的事不能说明她现在在干什么
  const last = journal[journal.length - 1]
  const ageMs = at - last.at
  // 未来时间戳（补写历史流水的时区问题）不算"正在忙"
  if (ageMs < 0 || ageMs > FRESHNESS_MS) return idle

  /*
   * 先按**动词**定档——这是最稳的一层。
   * "改八遍""改到第四版""改页面"都会归到"改"，
   * 不必穷举搭配（穷举漏过两次）。
   */
  const { verb } = parseActivity(last.text)

  /*
   * 但明确"做完了"的就不算忙。
   * 注意这个判断是**窄的**（只认"吃完""洗完"这种无歧义短语），
   * 原因见 DONE_MARKERS 的注释。
   */
  const done = DONE_MARKERS.test(last.text)
  if (!done) {
    for (const level of ['heavy', 'light']) {
      if (VERB_LEVEL[level].has(verb)) {
        return { level, text: last.text, at: last.at, ageMs, verb }
      }
    }
  }

  // 动词认不出来（或者本来就没动词）时退回整句模式
  for (const { level, re } of EXTRA_PATTERNS) {
    if (re.test(last.text)) {
      return { level, text: last.text, at: last.at, ageMs, verb }
    }
  }
  return idle
}

/**
 * 这一轮该延迟多久（毫秒）。
 *
 * 三条硬约束，都是"别把真人感做成卡顿"：
 *   - 从不延迟（idle）
 *   - 上限压得比较死（最忙也就两分半），超了用户会怀疑消息没发出去
 *   - 关掉功能就一律 0
 *
 * @param {object} cfg
 * @param {{state?: object, at?: number}} [opts]
 */
export function replyDelay(cfg, { state, at = now() } = {}) {
  if (cfg?.busy?.enabled === false) return 0

  const s = state ?? busyState({ at })
  if (s.level === 'idle') return 0

  const [lo, hi] = DELAY_RANGE[s.level] ?? DELAY_RANGE.light
  const seconds = randInt(lo, hi)
  return seconds * 1000
}

/**
 * 拼成注入提示词的那一小段。
 *
 * 只在真的忙时给。措辞的重点是让她**说一句交代**，
 * 而不是变得冷淡——延迟本身用户看不见原因，一句话就把"卡顿"变成"她在忙"。
 */
export function buildBusySection(state) {
  if (!state || state.level === 'idle') return ''

  const minutes = Math.round((state.ageMs ?? 0) / 60000)
  const ago = minutes < 1 ? '刚刚' : `${minutes} 分钟前`

  return `【你手上正在忙的事】
${ago}你：${state.text}

你刚才在忙这个，所以看到消息晚了一点。回话的时候：
- 如果这件事还占着手，**先交代一句再聊**（"等下，我在煮东西"、"刚骑上车"）。
  就一句，别解释太多，也别道歉——你在过自己的日子，没什么好道歉的。
- 如果已经弄完了，那就正常说，不用提"我刚在忙"。
- 不要每次都说。**只在真的被打断的时候交代。**`
}

/** 给界面和 doctor 看的状态 */
export function busyStatus(cfg, at = now()) {
  const s = busyState({ at })
  return {
    level: s.level,
    text: s.text,
    agoMinutes: s.text ? Math.round((s.ageMs ?? 0) / 60000) : null,
    enabled: cfg?.busy?.enabled !== false,
    wouldDelaySeconds: Math.round(replyDelay(cfg, { state: s, at }) / 1000),
  }
}

export { FRESHNESS_MS, DELAY_RANGE, VERB_LEVEL, EXTRA_PATTERNS }
