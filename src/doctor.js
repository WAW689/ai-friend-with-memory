/**
 * 提示词体检。
 *
 * 为什么需要这个：这个项目出过四次同类事故，全都是**"你以为给了她，其实没给"**：
 *
 *   1. life.md 的生活设定没进聊天提示词 → 改了职业她完全不知道
 *   2. life.md 没传给主动消息 → 她主动开口时看不见自己的生活
 *   3. .env.example 漏了新变量 → 用户自己发现才知道
 *   4. 提示词里那句话让她自己都觉得假
 *
 * 四次都是靠"用户用着觉得不对"才发现的，每次排查都要翻代码。
 * 这个模块把那份排查变成一条命令：**她这轮到底知道什么、缺什么。**
 *
 * 检查的粒度是"每一段都要在拼好的提示词里真的出现"——
 * 只检查"数据文件存在"是不够的，那正是前两次事故漏掉的地方：
 * 文件在、内容也在，就是没拼进去。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from './config.js'
import { buildSelfSection } from './self.js'
import { buildLifeSection, readJournal } from './life.js'
import { readLib, stickerMenu } from './stickers.js'
import { buildStickerSection } from './prompts.js'
import { describeNow } from './almanac.js'
import { describeWeather, peekSunTimes, peekWeather } from './weather.js'
import { peekPending } from './recall.js'
import { buildBusySection, busyState } from './busy.js'
import { buildSleepySection, sleepiness } from './sleepy.js'
import { shortActivity } from './activity.js'
import { buildLifeDaysSection, daysStats } from './life-days.js'

/** 粗略的 token 估算：中文一个字约 1 token，英文 4 字符约 1 token */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const rest = s.length - cjk
  return Math.round(cjk + rest / 4)
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function nonEmpty(text) {
  return String(text ?? '').trim().length > 0
}

/**
 * 跑一次完整体检。
 *
 * @param {object} [cfg]
 * @param {{nowText?: string, weather?: object, chatPrompt?: string, proactivePrompt?: string}} [opts]
 *   传 chatPrompt / proactivePrompt 时会额外核对每一段是否真的在里面。
 *   两份提示词要分别传：天气和待回访是**故意只在主动开口时给**的。
 */
export function runDoctor(cfg = loadConfig(), opts = {}) {
  const persona = readTextFile(PATHS.persona)
  const memory = readTextFile(PATHS.memory)
  const selfText = readTextFile(PATHS.self)
  const lifeText = readTextFile(PATHS.life)
  const journal = readJournal()
  const lib = readLib()
  const menu = stickerMenu()

  const selfSection = buildSelfSection()
  const lifeSection = buildLifeSection()
  const stickerSection = cfg.sticker?.enabled ? buildStickerSection(menu.text) : ''
  const nowText = opts.nowText ?? describeNow(new Date(), peekSunTimes())
  const weather = opts.weather ?? peekWeather()
  const weatherText = cfg.weather?.enabled === false ? '' : describeWeather(weather)
  const pending = peekPending()
  const busy = busyState()
  const busySection = buildBusySection(busy)
  const sleepy = sleepiness()
  const sleepySection = buildSleepySection(sleepy)
  /*
   * 作息是从哪来的，这段话两个分支都要用。
   * parsed=false 是**兜底值**，得显眼地说出来——她明明写着"早上九点起"，
   * 而程序用的是兜底作息时，表现会莫名地不对，却没有任何报错。
   */
  const sleepOrigin =
    `作息解析成 ${sleepy.sleepHour} 点睡、${sleepy.wakeHour} 点起` +
    (sleepy.parsed ? '' : '，⚠ 是从兜底值来的——data/life.md 里的作息没解析出来')
  const lifeDaysSection = buildLifeDaysSection()
  const dayStats = daysStats()

  /**
   * 每一段：叫什么、来自哪个文件、内容、是不是"启用了但没内容"。
   *
   * scope 说明它该出现在哪份提示词里：
   *   'chat'      聊天回复（默认）
   *   'proactive' 只有她主动开口时才带
   *
   * 这个字段是必须的，否则会把**故意的设计**报成故障：
   * 天气就故意不进聊天提示词（每句话都提天气她会变成播报员），
   * 不区分的话 doctor 会一直喊"天气没注入"，
   * 喊多了这个工具就没人看了——那它就白做了。
   */
  const sections = [
    {
      id: 'persona',
      name: '身份设定',
      source: 'data/persona.md',
      text: persona,
      scope: 'chat',
      // 身份设定是硬要求，空了会直接退化成通用助手
      required: true,
      emptyHint: '人设是空的 —— 她没有身份，会退化成通用 AI 助手。跑 node src/reset.js persona --force 恢复出厂，或者自己写。',
    },
    {
      id: 'memory',
      name: '记得你的事',
      source: 'data/memory.md',
      text: memory,
      scope: 'chat',
      required: true,
      // 出厂模板有标题没内容，那种也算"还没记住什么"
      emptyHint: '还没记住关于你的任何事。多聊一些，或者跑 node src/cli.js extract-memory 立刻整理一次。',
      contentOnly: true,
    },
    {
      id: 'self',
      name: '她怎么看自己',
      source: 'data/self.md',
      text: selfSection,
      raw: selfText,
      scope: 'chat',
      required: false,
      emptyHint: '她还没形成对自己的看法（这是正常的——自我是长出来的，不是发下来的）。由经历触发，攒够经历会自己长。',
    },
    {
      id: 'life',
      name: '她的生活',
      source: 'data/life.md + data/life.jsonl',
      text: lifeSection,
      raw: lifeText,
      scope: 'chat',
      required: false,
      emptyHint: `还没有生活设定或流水（流水 ${journal.length} 条）。写 data/life.md，或者跑 node src/backfill-life.js 补几天历史。`,
    },
    {
      id: 'days',
      name: '她的过去（按天）',
      source: 'data/life-days.jsonl',
      text: lifeDaysSection,
      scope: 'chat',
      required: false,
      emptyHint: `还没收过任何一天（流水 ${journal.length} 条）。她会在每天过完后自己收；想立刻补就跑 node src/cli.js days catchup。`,
    },
    {
      id: 'time',
      name: '时间/农历/节日',
      source: '程序算出',
      text: nowText,
      scope: 'chat',
      required: true,
      emptyHint: '时间描述是空的 —— 她会不知道今天几号。这是最严重的退化，检查 src/almanac.js。',
    },
    {
      id: 'weather',
      name: '天气',
      source: 'Open-Meteo',
      text: weatherText,
      // 故意只在主动开口时给：聊天里带天气她会变成天气播报员
      scope: 'proactive',
      required: false,
      emptyHint: cfg.weather?.enabled === false
        ? '天气功能已关闭（FRIEND_WEATHER=0）。昼夜判断会退回保守的小时分段。'
        : '没取到天气（断网或接口不可用）。她不会因此说错话 —— 拿不到就完全不提。跑 node src/cli.js now --refresh 试试。',
    },
    {
      id: 'sticker',
      name: '表情包清单',
      source: 'data/stickers.json',
      text: stickerSection,
      scope: 'chat',
      required: false,
      emptyHint: lib.items.length === 0
        ? '还没有表情包。把图拷进 data/stickers/ 再点界面上的「重新扫描文件夹」。'
        : `${lib.items.length} 张表情包，但清单是空的 —— 多半是都还没有描述。没描述的图模型无法区分，所以故意不进候选。`,
    },
    {
      id: 'recall',
      name: '待回访的事',
      source: 'data/recall.json',
      text: pending?.section ?? '',
      scope: 'proactive',
      required: false,
      emptyHint: '暂时没有该回头问的事（这是正常的）。聊天里出现"过几天该问问"的事时，会自动进这个清单。',
    },
    /*
     * 下面两段是"当下状态"，不是"她是谁"。
     * 它们大部分时候是空的——那是正常的（她不忙、不困）。
     * 但空的时候要能看出**为什么空**，否则你会以为功能坏了。
     */
    {
      id: 'busy',
      name: '在忙（当下）',
      source: 'data/life.jsonl 最近一条',
      text: busySection,
      scope: 'chat',
      required: false,
      /*
       * 三种情况都得有话，不能拿"——"占位。
       *
       * light（能看手机）那档现在**故意不注入**——它不延迟回复，
       * 给她这段反而会让她编一句"刚在忙"。这里是把这个"故意的空"
       * 说清楚，不然体检会把它报成故障。
       */
      emptyHint: cfg.busy?.enabled === false
        ? '在忙功能已关闭（FRIEND_BUSY=0），她会秒回。'
        : busy.level === 'idle'
          ? '她这会儿不忙（最近 45 分钟内没有新流水）。这是正常的——大部分时候她都没在忙。'
          : `她这会儿「${shortActivity(busy.text) || busy.text}」，属于"在做但能看手机"：` +
            '不延迟回复，所以这段故意不注入（免得她说"刚在忙"，可她根本没被耽误）。',
    },
    {
      id: 'sleepy',
      name: '困劲儿（当下）',
      source: 'data/life.md 的作息',
      text: sleepySection,
      scope: 'chat',
      required: false,
      emptyHint: cfg.sleepy?.enabled === false
        ? '困劲儿已关闭（FRIEND_SLEEPY=0）。'
        : `她这会儿${sleepy.label}（${sleepOrigin}）。`,
    },
  ]

  /*
   * 逐段核对：在不在**它该在的那份**提示词里。
   *
   * opts.chatPrompt / opts.proactivePrompt 由调用方传进来（医生不自己拼——
   * 那样只会检查"我以为的拼装方式"）。没传就跳过核对。
   */
  for (const s of sections) {
    s.chars = s.text.length
    s.tokens = estimateTokens(s.text)
    s.hasContent = nonEmpty(s.contentOnly ? stripHeadings(s.text) : s.text)

    const target = s.scope === 'proactive' ? opts.proactivePrompt : opts.chatPrompt
    if (target) {
      const probe = probeOf(s.text)
      s.inPrompt = probe ? target.includes(probe) : null
    }
  }

  const present = sections.filter((s) => s.hasContent)
  const missingRequired = sections.filter((s) => s.required && !s.hasContent)
  const missingOptional = sections.filter((s) => !s.required && !s.hasContent)
  const notInjected = sections.filter((s) => s.hasContent && s.inPrompt === false)

  const totalTokens = sections.reduce((n, s) => n + s.tokens, 0)

  return {
    sections,
    present,
    missingRequired,
    missingOptional,
    notInjected,
    totalTokens,
    journalCount: journal.length,
    dayCount: dayStats.total,
    stickerCount: lib.items.length,
    stickerWithDesc: lib.items.filter((i) => String(i.desc ?? '').trim()).length,
    pendingCount: pending?.items?.length ?? 0,
    weatherEnabled: cfg.weather?.enabled !== false,
  }
}

/** 去掉标题和括号说明，只留"真内容"——判断"她到底记住东西没" */
function stripHeadings(text) {
  return String(text ?? '')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (!t) return false
      if (t.startsWith('#')) return false
      if (/^[（(].*[)）]$/.test(t)) return false
      return true
    })
    .join('')
}

/** 从一段文本里挑一个有辨识度的片段，用来核对它有没有进提示词 */
function probeOf(text) {
  const s = String(text ?? '')
  if (!s.trim()) return ''
  // 取最长的一行，去掉首尾空白和列表符号
  const line = s
    .split('\n')
    .map((l) => l.trim().replace(/^[-*•]\s*/, ''))
    .filter((l) => l.length > 6)
    .sort((a, b) => b.length - a.length)[0]
  return line ? line.slice(0, 40) : ''
}

/** 一句话结论，给界面和命令行复用 */
export function doctorVerdict(report) {
  const total = report.sections.length
  const have = report.present.length
  const missing = [...report.missingRequired, ...report.missingOptional]

  if (report.notInjected.length > 0) {
    return {
      level: 'bad',
      text:
        `有 ${report.notInjected.length} 段内容存在但**没有拼进提示词**：` +
        report.notInjected.map((s) => s.name).join('、') +
        '。这是最难发现的一类问题——数据都在，她就是不知道。',
    }
  }
  if (report.missingRequired.length > 0) {
    return {
      level: 'bad',
      text: `缺了必需的段落：${report.missingRequired.map((s) => s.name).join('、')}。这会让她的表现明显退化。`,
    }
  }
  if (missing.length > 0) {
    return {
      level: 'ok',
      text: `她能正常对话。${have}/${total} 段有内容，暂时没有：${missing.map((s) => s.name).join('、')}（都是可选的，见下面各自的说明）。`,
    }
  }
  return { level: 'ok', text: `全部 ${total} 段都有内容 —— 她这轮该知道的都知道。` }
}

export { PATHS }
