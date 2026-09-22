/**
 * 界面顶部那行状态。
 *
 * 为什么单独抽一个模块：这行字看起来只是个标签，但它决定用户**怎么理解
 * 她没回消息这件事**。
 *
 *   显示"在的" → 她没回 = 可能不想理我
 *   显示"在煮面，一会儿回你" → 她没回 = 她在忙
 *
 * 差别很大。而且它顺手兑现了我们做的另外两个功能：她会去忙、她会困——
 * 那两个功能在界面上本来**完全看不出来**，用户只会觉得"怎么卡了一下"。
 *
 * ── 一条铁律 ──────────────────────────────────────────
 * 这里的状态判断**必须和回复延迟用同一份**（busyState / sleepiness）。
 * 各算各的就会穿帮：状态栏说"在煮面"，消息却秒回——
 * 那比不显示状态更假。
 */
import { now } from './util.js'
import { busyState } from './busy.js'
import { sleepiness } from './sleepy.js'

/**
 * 一条流水 → 一句"她在干嘛"的短话，放在"在…"里能读通。
 *
 * 迭代了三轮才顺，三轮都是因为**汉语的动词短语没法靠截断得到**：
 *   1. 只取第一个分句 → "热水器又忽冷忽热"（那是环境，动作在第二句）
 *   2. 取带动作词的分句 → "起来煮了碗西红柿鸡蛋面"太长、
 *      "改到第四版"放进"在…"里不成话
 *   3. 现在的做法：**动词 + 宾语核心**
 *      "起来煮了碗西红柿鸡蛋面" → 煮 + 面 = "煮面"
 *      "刚刚下楼拿快递"         → 下楼拿 + 快递 = "下楼拿快递"
 *      "热水器忽冷忽热，凑合洗完" → 洗完
 *
 * 所以是"认动词、认宾语名词"，不是切字符串。
 */

/** 动作词。跟 busy.js 的模式对齐，免得状态栏说的事跟她"在忙"的理由对不上。 */
const VERBS = [
  '下楼拿',
  '上楼拿',
  '下楼',
  '上楼',
  '出门',
  '排队',
  '收拾',
  '做饭',
  '洗碗',
  '洗澡',
  '洗头',
  '洗完',
  '躺着',
  '躺下',
  '睡',
  '煮',
  '买',
  '拿',
  '取',
  '洗',
  '吃',
  '喝',
  '改',
  '写',
  '投',
  '刷',
  '看',
  '骑',
  '晾',
  '喂',
]

/**
 * 宾语核心词。只认这些，就是为了**避免把修饰语也带进去**——
 * "煮了碗西红柿鸡蛋面"里的"西红柿鸡蛋"是修饰，真正要说的是"面"。
 */
const NOUNS = ['快递', '外卖', '简历', '代码', '衣服', '猫', '土豆', '饭', '面', '碗', '菜', '水', '澡', '觉', '图', '手机', '剧', '书', '车', '药', '烟', '垃圾', '地', '车票', '票']

/** 量词和助词，拼短语时要丢掉 */
const FILLER = /[了个着过碗杯盘份袋张支条只把次顿]/

export function shortActivity(text, { max = 14 } = {}) {
  const raw = String(text ?? '')
    .replace(/^[-*•]\s*/, '')
    // 时间词和钟点前缀都是噪音："今天""10:30"出现在状态栏里很奇怪
    .replace(/^(今天|昨天|刚刚|刚才|早上|上午|中午|下午|晚上|夜里|凌晨)[，,]?\s*/, '')
    .replace(/^\d{1,2}[:：]\d{2}\s*/, '')
    .trim()
  if (!raw) return ''

  const clauses = raw
    .split(/[，,。；;！!？?]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (clauses.length === 0) return ''

  /*
   * 先看整句里有没有"睡"。
   * 睡觉本来就是状态，不能套"在…"——"在睡到十二点半"不成话。
   * 而且流水里"睡"经常出现在后半句（"土豆踩我脸把我踩醒"），
   * 只看选中的那个分句会漏掉。
   */
  if (/睡/.test(raw)) return '睡着了'

  // 挑带动作词的分句；都没有就用第一个
  const clause = clauses.find((c) => VERBS.some((v) => c.includes(v))) ?? clauses[0]

  const verb = VERBS.find((v) => clause.includes(v))
  if (!verb) {
    return clause.length <= max ? clause : clause.slice(0, max)
  }

  /*
   * 动词后面可能还跟着补语/助词（"改**到**第四版"、"走**了**"），
   * 拼接前要先跳过去，否则会得到"在改到第"这种断在半截上的话。
   *
   * 注意跳过的范围比 tail 的判断更靠前：VERBS 里只有"改"没有"改到"，
   * 所以 tail 会是"到第四版"，那个"到"得在这一步吃掉。
   */
  const tail = clause.slice(clause.indexOf(verb) + verb.length)
  const afterParticle = tail.replace(/^[到完了过起来去出回住开走]+/, '')

  // 在跳完虚词的部分里找宾语核心词
  const noun = NOUNS.find((n) => afterParticle.includes(n))
  if (noun) {
    const phrase = `${verb}${noun}`
    return phrase.length <= max ? phrase : verb
  }

  // 找不到认识的宾语：只取一两个字，遇到虚词开头的就不跟
  const blocked = /^[第了的着把被给和跟对从为]/.test(afterParticle)
  const extra = blocked ? '' : afterParticle.replace(FILLER, '').slice(0, 2)
  const phrase = `${verb}${extra}`
  return phrase.length <= max ? phrase : verb
}

/**
 * 她现在的状态。
 *
 * 优先级：正在打字 > 睡着 > 忙 > 空闲。
 * "正在打字"最高——那一刻**事实就是**她在回你，别的都不重要。
 *
 * @param {object} cfg
 * @param {{at?: number, generating?: boolean}} [opts]
 * @returns {{key: string, label: string, detail: string, since: number}}
 */
export function herState(cfg, { at = now(), generating = false } = {}) {
  // 1) 正在打字
  if (generating) {
    return { key: 'typing', label: '正在输入…', detail: '', since: at }
  }

  const sleepy = sleepiness({ at })
  const busy = busyState({ at })

  /*
   * 2) 睡着。
   *
   * 措辞要留余地，不能像"勿扰模式"。
   * 半夜想说话却发现对方"已开启勿扰"，那比没人理还难受。
   * "有事留着我醒来看"是邀请，不是拒绝。
   */
  if (cfg?.sleepy?.enabled !== false && sleepy.isAsleepPeriod) {
    return {
      key: 'asleep',
      label: '睡了',
      detail: `一般 ${sleepy.wakeHour} 点起，有事留着我醒来看`,
      since: at,
    }
  }

  // 3) 快睡了——不拦消息，只是让你知道她状态
  if (cfg?.sleepy?.enabled !== false && sleepy.level >= 0.9) {
    return { key: 'sleepy', label: '困得不行了', detail: '回得会慢，别嫌我', since: at }
  }

  // 4) 手上有事
  if (cfg?.busy?.enabled !== false && busy.level !== 'idle') {
    const what = shortActivity(busy.text)
    const mins = Math.round((busy.ageMs ?? 0) / 60000)
    const ago = mins < 1 ? '刚记下' : `${mins} 分钟前记下`
    if (what) {
      /*
       * "睡着了"这类本身就是完整状态，不用加"在"。
       * 拼成"在睡着了"会很好笑。
       */
      const isStandalone = /^(睡着了|睡了|已睡着)$/.test(what)
      const label = isStandalone
        ? what
        : busy.level === 'heavy'
          ? `在${what}`
          : `在${what}，能看手机`
      return {
        key: busy.level === 'heavy' ? 'busy' : 'around',
        label,
        detail: isStandalone ? '回得可能慢一点' : `${ago} · 回得可能慢一点`,
        since: busy.at,
      }
    }
  }

  /*
   * 5) 空闲。
   *
   * 写"在的"而不是"在线"。
   * "在线"是 IM 的词，暗示"我随时待命"——那正是我们一直在摆脱的东西。
   */
  return { key: 'here', label: '在的', detail: '', since: at }
}

/** 给界面用的一份完整快照 */
export function stateForUI(cfg, opts = {}) {
  const state = herState(cfg, opts)
  return {
    key: state.key,
    label: state.label,
    detail: state.detail,
    since: state.since,
    at: opts.at ?? now(),
  }
}
