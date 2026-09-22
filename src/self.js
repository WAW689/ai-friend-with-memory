/**
 * 会变的她自己。
 *
 * 跟另外两个"关于她"的文件分工：
 *
 *   persona.md  她是谁 —— 名字、说话多短、要不要劝人、硬边界。**锁死，不自动改。**
 *   life.md     她过着什么日子 —— 职业、住哪、作息、脾气。**你改，不改就一直是那样。**
 *   self.md     她怎么看待自己 —— 这篇文件。**它自己会慢慢改。**
 *
 * 为什么要单独开一层，而不是让模型直接改 persona.md：
 *
 *   让模型反复"改自己的人设"，它每次都会往**更通用、更讨好**的方向偏一点：
 *   说话变长、开始给建议、开始"我理解你的感受"。几十次之后她就不是她了，
 *   而且这种漂移是渐进的，你只会觉得"她怎么变了"，查不出是哪一步变的。
 *
 *   所以她的成长**不体现在声音上，而体现在看法上**。真人也是这样：
 *   四十岁的人还是那个说话方式，但想法变了。
 *
 * 三条硬约束（对应三个最容易出事的地方）：
 *
 * 1. **不能改声音**。self.md 里禁止出现关于"说话长度/语气/要不要反问"的内容，
 *    那是 persona.md 的领域。清理函数会主动删掉越界的行。
 * 2. **改动必须小**。一次最多改几行，超过阈值整次拒绝并留档。
 * 3. **不能凭空长**。涉及"我们"的内容必须基于真实对话，不能编造共同经历
 *    （这条和 life.md 的硬边界一致：你们是网上认识的，没见过面）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from './config.js'
import { complete } from './llm.js'
import { buildSelfUpdatePrompt } from './prompts.js'
import { log, now } from './util.js'

const SELF_FILE = PATHS.self
const SNAPSHOT_DIR = PATHS.selfSnapshots
const CHANGELOG_FILE = PATHS.selfChangelog

/** 有多少内容才算"有自我"（空文件/占位不算） */
const MIN_CHARS = 8

/**
 * 改动上限：一次最多新增/修改几行。
 *
 * 卡的是"净变化行数"而不是"总行数"。卡太死会让成长停滞，
 * 卡太松会一次换个人。3 行是试出来的——一天一次、一次 2-3 行，
 * 一个月下来是几十处小变化，感觉得到在长，但不会突变。
 */
const MAX_CHANGED_LINES = 3

/* ------------------------------------------------------------ 读写 */

export function readSelf() {
  try {
    return fs.readFileSync(SELF_FILE, 'utf8')
  } catch {
    return ''
  }
}

export function writeSelf(text) {
  fs.writeFileSync(SELF_FILE, String(text), 'utf8')
}

/**
 * 这一行算不算"真内容"。
 *
 * 标题（#）和括号说明（"（这些是我自己慢慢想明白的…）"）都不算——
 * 出厂模板就是"标题齐全 + 一段括号说明"，如果把它当成内容，
 * hasSelf() 会立刻为真，聊天里就会注入一段只有标题的空段落。
 * 这个坑真的踩过一次。
 */
function isContentLine(line) {
  const t = line.trim()
  if (!t) return false
  if (t.startsWith('#')) return false
  if (/^[（(].*[)）]$/.test(t)) return false
  return true
}

/** 只看"有内容"的行，并剥掉列表符号和标题（用来比较改动量） */
function contentLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter(isContentLine)
    .map((l) => l.trim())
    .map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.、)]\s*/, '').trim())
    .filter(Boolean)
}

/**
 * 有没有形成"自我"。
 *
 * **必须看"有没有条目"，不能只看字符数。**
 *
 * 出厂模板是"标题齐全、内容全空"的（三个 ## 加一段括号说明）。
 * 按字符数算它早就过阈值了，于是刚装好的实例一开口就往提示词里
 * 注入一段只有标题的空段落——buildSelfSection 那句
 * "没有自我就不注入"也就永远不生效。
 *
 * 阈值按中文字数，别按字节：一个中文字的信息量比一个字母大得多。
 */
export function hasSelf() {
  const lines = contentLines(readSelf())
  if (lines.length === 0) return false
  return lines.join('').replace(/\s/g, '').length >= MIN_CHARS
}

/* ------------------------------------------------------------ 快照与流水 */

function snapshotStamp(at = now()) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/**
 * 改之前存一份快照。
 *
 * 这是"能回退"的基础。没有它，她改坏了自己就再也回不去了——
 * 一个会自己改自己、又回不去的东西，跑偏了只能整份重写。
 */
export function snapshotSelf(at = now(), tag = '') {
  const current = readSelf()
  if (!current.trim()) return null

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  let file = path.join(SNAPSHOT_DIR, `${snapshotStamp(at)}${tag ? '-' + tag : ''}.md`)

  // 同一秒内多次快照不能互相覆盖
  let n = 1
  while (fs.existsSync(file)) {
    file = path.join(SNAPSHOT_DIR, `${snapshotStamp(at)}${tag ? '-' + tag : ''}-${n++}.md`)
  }

  fs.writeFileSync(file, current, 'utf8')
  return file
}

/** 所有快照，新的在前 */
export function listSnapshots() {
  try {
    return fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .map((f) => ({ name: f, at: f.slice(0, 8), path: path.join(SNAPSHOT_DIR, f) }))
  } catch {
    return []
  }
}

export function readSnapshot(name) {
  // 只允许读快照目录里的文件，避免 ../ 穿越
  const safe = path.basename(String(name))
  if (!safe.endsWith('.md')) return ''
  try {
    return fs.readFileSync(path.join(SNAPSHOT_DIR, safe), 'utf8')
  } catch {
    return ''
  }
}

/** 记一笔变更（改前 / 改后 / 为什么） */
export function recordSelfChange({ before, after, reason = '', at = now() }) {
  /*
   * 差异要拿 contentLines（去掉标题和 "- " 前缀的裸内容）来比。
   * 直接拿 after 的原始行跟 beforeLines 比是错的——原始行带着
   * "- " 前缀和缩进，永远匹配不上，于是 added 恒为空、removed 恒为全部。
   */
  const beforeLines = contentLines(before)
  const afterLines = contentLines(after)

  const entry = {
    at,
    reason,
    before,
    after,
    // 只存差异行，面板要展示"她改了什么"，存整份太吵
    added: afterLines.filter((l) => !beforeLines.includes(l)),
    removed: beforeLines.filter((l) => !afterLines.includes(l)),
  }
  try {
    fs.mkdirSync(path.dirname(CHANGELOG_FILE), { recursive: true })
    fs.appendFileSync(CHANGELOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    log.warn(`记录自我变更失败：${err.message}`)
  }
  return entry
}

/** 变更流水，新的在前 */
export function readSelfChanges(limit = 50) {
  let text = ''
  try {
    text = fs.readFileSync(CHANGELOG_FILE, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .slice(-limit)
    .reverse()
}

/* ------------------------------------------------------------ 越界清理 */

/**
 * 说话方式相关的词。
 *
 * 这些一旦出现在 self.md 里，就说明模型跑到 persona.md 的地盘上去了。
 * 「话变多了一点」这种条目最危险——它会被写进设定然后自我强化，
 * 几周后她的声音就变了。所以见到就删。
 *
 * 注意每条都要容忍中间夹字：「话比以前多了一点」里"话"和"多"隔了四个字，
 * 所以不能用死板的相邻匹配——测试就是靠这条抓出漏网的。
 */
const VOICE_PATTERNS = [
  /说话(?:的)?(?:方式|风格|长度|长短|语气|习惯)/,
  /(?:回复|回话|打字)(?:的)?(?:长度|长短|语气|风格)/,
  /(?:要|该|应该|可以|尽量)(?:多|少)?(?:反问|追问|劝|安慰|共情|建议)/,
  // "话比以前多了一点""话变少了"——允许"话"和"多/少"之间夹任意短词；
  // "愿意多说两句了"这种没写"话"字的也要抓（她说话变主动了，同样是声音）
  /话.{0,6}(?:多|少)(?:了|一点|一些|起来)?/,
  /(?:愿意|肯|开始)(?:多|主动)(?:说|聊|讲)/,
  /(?:变得|比以前|越来越)?(?:更)?(?:温柔|体贴|会安慰|会共情|话多|话少|热情|主动)(?:了|一点|一些)?/,
  /(?:说话|回复|表达|语气)(?:变得|越来越|比以前)?.{0,4}(?:更长|更短|更多|更少)/,
  /(?:不要|别)(?:每次都)?(?:反问|劝|安慰|给建议)/,
  /(?:emoji|表情包|标点)/,
]

/**
 * 删掉越界的行。
 *
 * 只删不报错：模型偶尔越界是正常的，整次更新因此失败反而更糟
 * （那会让她该长的时候长不出来）。但删了什么要记下来。
 */
export function stripVoiceLines(text) {
  const kept = []
  const dropped = []

  for (const line of String(text ?? '').split('\n')) {
    const body = line.trim().replace(/^[-*•]\s*/, '')
    // 标题行永远保留（那是结构）
    if (line.trim().startsWith('#')) {
      kept.push(line)
      continue
    }
    if (body && VOICE_PATTERNS.some((re) => re.test(body))) {
      dropped.push(body)
      continue
    }
    kept.push(line)
  }

  return { text: kept.join('\n'), dropped }
}

/* ------------------------------------------------------------ 经历 */

/**
 * 把她这段时间的经历渲染成给模型看的文本。
 *
 * 关键是**带上相对时间**（"三天前"而不是"9/19"）。她是在回忆，
 * 不是在查日志——"三天前那件事"才是人回想事情的方式，
 * 而时间的远近直接影响一件事的分量：昨天的事和两周前的事，
 * 在心里留下的东西完全不一样。
 */
export function renderExperiences(entries, at = now()) {
  if (!Array.isArray(entries) || entries.length === 0) return ''

  const lines = []
  for (const e of entries) {
    if (!e || typeof e.at !== 'number' || typeof e.text !== 'string') continue
    const gap = at - e.at
    const day = Math.floor(gap / (24 * 60 * 60 * 1000))
    let when
    if (day <= 0) {
      const h = Math.floor(gap / (60 * 60 * 1000))
      when = h <= 0 ? '刚刚' : h < 6 ? `${h} 小时前` : '今天早些时候'
    } else if (day === 1) {
      when = '昨天'
    } else if (day < 7) {
      when = `${day} 天前`
    } else {
      when = `${Math.floor(day / 7)} 周前`
    }
    lines.push(`- ${when}：${e.text}`)
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------ 生成 */

/**
 * 让她根据**经历**更新对自己的看法。
 *
 * 触发条件是"她又经历了什么"，不是"过了多久"。所以这里要同时给她两样东西：
 *
 *   - experiences：她这段时间自己过的日子（生活会话流水）
 *   - transcript：这段时间你们的对话
 *
 * 两者都可能让她对自己有新的认识：
 *   日志里"甲方拖了半个月的款终于结了"可能让她想明白"我不想再这样接活了"；
 *   对话里你说了句什么，可能让她意识到"我好像挺在意这个人怎么看我的"。
 *
 * 允许它什么都不改——提示词里明确写了"没有值得改的就原样返回"，
 * 上游也据此判断"这次没成长"。硬逼它每次产出点变化，那叫表演成长。
 *
 * @param {object} [cfg]
 * @param {number} [at]
 * @param {string} [transcript] 这段时间的对话
 * @param {string} [experiences] 这段时间她自己经历的事
 */
export async function evolveSelf(cfg = loadConfig(), { at = now(), transcript, experiences } = {}) {
  const before = readSelf()
  const history = String(transcript ?? '').trim()
  const lived = String(experiences ?? '').trim()

  // 两边都空的才跳过。只有对话没有日志也算经历——
  // 有些变化是聊出来的，不需要她先出门买趟菜。
  if (!history && !lived) return { updated: false, reason: '没有可用的经历' }

  if (!hasSelf()) {
    log.info('她还没有形成自我，这次先建立起来')
  }

  const text = await complete(
    cfg,
    buildSelfUpdatePrompt({ currentSelf: before, transcript: history, experiences: lived }),
    { maxTokens: 700 },
  )

  let next = String(text ?? '').trim()
  if (!next) return { updated: false, reason: '模型没返回内容' }

  // 1) 先删越界内容（声音相关）
  const { text: cleaned, dropped } = stripVoiceLines(next)
  next = cleaned.trim()
  if (dropped.length) {
    log.warn(`她的自我更新里有 ${dropped.length} 行越界（说话方式），已删掉`)
  }

  if (next.replace(/\s/g, '').length < MIN_CHARS) {
    return { updated: false, reason: '清理后内容太短' }
  }

  // 2) 再看改动量。改动太大说明它在"重写"而不是"成长"，整次拒绝。
  const beforeLines = contentLines(before)
  const afterLines = contentLines(next)
  const added = afterLines.filter((l) => !beforeLines.includes(l))
  const removed = beforeLines.filter((l) => !afterLines.includes(l))
  const changed = added.length + removed.length

  const maxChanged = cfg.self?.maxChangedLines ?? MAX_CHANGED_LINES

  if (beforeLines.length > 0 && changed > maxChanged) {
    log.warn(
      `她的自我更新改动过大（${changed} 行 > ${maxChanged} 行），这次不采纳——` +
        `一次换一个人不叫成长`,
    )
    return { updated: false, reason: `改动 ${changed} 行，超过上限 ${maxChanged}`, added, removed }
  }

  if (before.trim() === next) {
    // 这是**正常结果**，不是失败：这段时间确实没什么值得她改变看法的。
    return { updated: false, reason: '这段时间没有让她改变看法的事' }
  }

  // 3) 存快照再写盘。顺序不能反——先写就丢掉了回退点。
  const snap = snapshotSelf(at, 'auto')
  writeSelf(next.endsWith('\n') ? next : `${next}\n`)
  const entry = recordSelfChange({ before, after: next, reason: '经历之后自己改的', at })

  log.info(`她经历了一些事，对自己有了新的想法（+${added.length} / -${removed.length} 行）`)
  return { updated: true, changed, added, removed, dropped, snapshot: snap, entry }
}

/**
 * 手动替换 self.md（用户从面板改）。
 *
 * 手动改**不做越界清理**——这是你的文件，你说了算。
 * 但同样存快照，所以手动改坏了也能退回去。
 */
export function replaceSelf(text, { at = now(), reason = '手动编辑' } = {}) {
  const before = readSelf()
  const after = String(text ?? '')
  if (before.trim() === after.trim()) return { updated: false, reason: '没有变化' }

  const snap = snapshotSelf(at, 'manual')
  writeSelf(after)
  recordSelfChange({ before, after, reason, at })
  return { updated: true, snapshot: snap }
}

/** 回退到某个快照。不传名字就退到上一个。 */
export function restoreSelf(name, { at = now() } = {}) {
  const snaps = listSnapshots()
  if (snaps.length === 0) return { updated: false, reason: '还没有任何快照' }

  const target = name ? readSnapshot(name) : readSnapshot(snaps[0].name)
  if (!target.trim()) return { updated: false, reason: '快照内容为空或不存在' }

  // 回退本身也存一份快照——否则"回退错了"就退不回来了
  const before = readSelf()
  const snap = snapshotSelf(at, 'before-restore')
  writeSelf(target)
  recordSelfChange({ before, after: target, reason: `回退到 ${name ?? snaps[0].name}`, at })

  return { updated: true, snapshot: snap, restoredFrom: name ?? snaps[0].name }
}

/* ------------------------------------------------------------ 注入聊天 */

/**
 * 拼出注入聊天提示词的那一段。
 *
 * 语气上刻意用"你最近想过的一些事"，而不是"你的性格设定"——
 * 后者会让模型把它当成需要表演的人设，前者更像一个人在聊天时
 * 自然带着的自我认知。
 */
export function buildSelfSection() {
  if (!hasSelf()) return ''

  return `【你最近对自己的一些想法（这些是你自己慢慢形成的，不是别人给你设的）】
${readSelf().trim()}

怎么用：
- 这是**你自己的想法**，不是拿来念的台词。别主动大段分享，别把它当话题。
- 对方问到相关的事（比如"你最近怎么样""你是不是不想上班"），可以自然地带出来。
- 想法可能跟以前不一样了，这很正常，不用解释"我以前不是这样"。
- 这些想法**只关于你自己**。不要拿它去分析对方、给对方下判断。
- 里面如果提到"我们"，那是你真实的感受，但**不要**因此编造你们一起做过的事
  （你们是网上认识的，没见过面）。`
}
