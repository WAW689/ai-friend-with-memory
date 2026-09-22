/**
 * 把一条生活流水解析成"她在干嘛"。
 *
 * 单独一个模块，是为了**避免循环依赖**：
 * busy.js 要按动词定档位，status.js 要给状态栏拼短话，
 * 两边都要这份解析。如果放在 status.js 里，busy → status → busy 就成环了。
 *
 * ── 为什么需要"解析"而不是截断 ────────────────────────
 * 汉语的动词短语没法靠切字符串得到。迭代了三轮：
 *   1. 只取第一个分句 → "热水器又忽冷忽热"（那是环境，动作在第二句）
 *   2. 取带动作词的分句 → "起来煮了碗西红柿鸡蛋面"太长、
 *      "改到第四版"放进"在…"里不成话
 *   3. 现在的做法：**认动词 + 认宾语核心**
 *      "起来煮了碗西红柿鸡蛋面" → 煮 + 面 = "煮面"
 *      "刚刚下楼拿快递"         → 下楼拿 + 快递 = "下楼拿快递"
 *      "三百块的活改八遍"       → 改（认不出宾语，就只用动词）
 *
 * 给 busy.js 的那个 `verb` 尤其重要：它让"忙不忙"的判断
 * 从"穷举搭配"变成"看动词"。穷举漏过两次——
 * 只写"洗澡"漏了"洗完"，只写"改图"漏了"改页面"，
 * 补上"改遍"还是漏，因为"改"和"遍"中间夹了个"八"。
 */

/** 动作词。**长词必须排在短词前面**（find 取第一个命中的）。 */
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
  '做',
  '投',
  '刷',
  '看',
  '调',
  '骑',
  '晾',
  '喂',
]

/** 宾语核心词。**长词必须排在短词前面**，否则"改页面"会拼成"在改面"（半截话）。 */
const NOUNS = [
  '页面',
  '样式',
  '代码',
  '快递',
  '外卖',
  '简历',
  '衣服',
  '车票',
  '土豆',
  '手机',
  '前端',
  '照片',
  '视频',
  '作业',
  '论文',
  '报名',
  '剧',
  '书',
  '面',
  '饭',
  '菜',
  '水',
  '澡',
  '觉',
  '图',
  '猫',
  '车',
  '药',
  '烟',
  '垃圾',
  '票',
]

/** 量词和助词，拼短语时要丢掉 */
const FILLER = /[了个着过碗杯盘份袋张支条只把次顿]/

/** 动词后面的补语/助词，拼短语前要跳过 */
const PARTICLES = /^[到完了过起来去出回住开走]+/

/** 虚词开头就不能再跟字了（"改到第四版"跟成"改到第"会断在半截） */
const STOP_TAIL = /^[第了的着把被给和跟对从为]/

/** 时间词和钟点前缀都是噪音："今天""10:30"出现在状态栏里很奇怪 */
const TIME_PREFIX = /^(今天|昨天|刚刚|刚才|早上|上午|中午|下午|晚上|夜里|凌晨)[，,]?\s*/

/**
 * @param {string} text 一条生活流水
 * @param {{max?: number}} [opts]
 * @returns {{verb: string, text: string}} verb 给 busy.js 定档位，text 是状态栏用语
 */
export function parseActivity(text, { max = 14 } = {}) {
  const raw = String(text ?? '')
    .replace(/^[-*•]\s*/, '')
    .replace(TIME_PREFIX, '')
    .replace(/^\d{1,2}[:：]\d{2}\s*/, '')
    .trim()

  if (!raw) return { verb: '', text: '' }

  /*
   * 先看整句里有没有"睡"。睡觉本来就是状态，不能套"在…"
   *（"在睡到十二点半"不成话）。而且流水里"睡"经常出现在后半句
   *（"土豆踩我脸把我踩醒"），只看选中的那个分句会漏掉。
   */
  if (/睡/.test(raw)) return { verb: '睡', text: '睡着了' }

  const clauses = raw
    .split(/[，,。；;！!？?]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (clauses.length === 0) return { verb: '', text: '' }

  // 挑带动作词的分句；都没有就用第一个
  const clause = clauses.find((c) => VERBS.some((v) => c.includes(v))) ?? clauses[0]

  const verb = VERBS.find((v) => clause.includes(v))
  if (!verb) {
    return { verb: '', text: clause.length <= max ? clause : clause.slice(0, max) }
  }

  /*
   * 动词后面可能还跟着补语/助词（"改**到**第四版"、"走**了**"），
   * 拼接前先跳过去，否则会得到"在改到第"这种断在半截上的话。
   */
  const tail = clause.slice(clause.indexOf(verb) + verb.length)
  const afterParticle = tail.replace(PARTICLES, '')

  // 在跳完虚词的部分里找宾语核心词
  const noun = NOUNS.find((n) => afterParticle.includes(n))
  if (noun) {
    const phrase = `${verb}${noun}`
    return { verb, text: phrase.length <= max ? phrase : verb }
  }

  // 找不到认识的宾语：只取一两个字，遇到虚词开头就不跟
  const blocked = STOP_TAIL.test(afterParticle)
  const extra = blocked ? '' : afterParticle.replace(FILLER, '').slice(0, 2)
  const phrase = `${verb}${extra}`
  return { verb, text: phrase.length <= max ? phrase : verb }
}

/** 只要短话 */
export function shortActivity(text, opts = {}) {
  return parseActivity(text, opts).text
}

export { VERBS, NOUNS }
