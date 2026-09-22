/**
 * 她的困劲儿。
 *
 * 要解决的问题：凌晨三点你找她，她精神抖擞地陪你聊。她**没有生物钟**。
 *
 * 而她的设定里写得清清楚楚——"凌晨三四点睡，中午前后起"。这条以前只是
 * 一句**背景描述**，从来没影响过她说话。所以她看起来不像一个会困的人，
 * 而像一个永远有精力的服务。
 *
 * 为什么这件事重要：一个永远能陪你到天亮的存在，本质上没有自己的生活。
 * 反过来，**她会困、她要睡了，才是"她是个真人"最有力的证据**。
 * 而且它对用户也有好处——它给了一个自然的理由去睡，
 * 比任何一句"早点休息"都有效。
 *
 * 实现上分两半：
 *   · 话变少、语气变懒 → 注入提示词（这部分是"像真人"）
 *   · 在睡觉时段**不主动开口** → 调度闸门（这部分是"她真在睡"）
 *
 * 刻意**不打断已完成请求的回复**：用户半夜说话，她还是会回，
 * 只是回得又短又困。让消息发不出去是服务故障，不是真人感。
 */
import { localHour, now } from './util.js'
import { readLife } from './life.js'

/**
 * 从生活设定里解析她的睡觉时段。
 *
 * life.md 里写的是"凌晨三四点睡，中午前后起"这种自然语言。
 * 用正则抓不到就退回默认值（3 点睡、11 点起），别因为解析失败就丢掉整个功能。
 */
export function parseSleepWindow(lifeText) {
  const text = String(lifeText ?? '')
  const fallback = { sleepHour: 3, wakeHour: 11, parsed: false }

  const cn = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

  /**
   * 中文钟点 → 小时数。
   *
   * 三类写法：
   *   "三四"   → 3   取**第一个**字。"三四点睡"是"三点多四点"，主体是 3 点
   *   "十一"   → 11  特殊：十X 要合成
   *   "两点"   → 2   "两"当二
   */
  const toHour = (raw) => {
    const s = String(raw ?? '').trim()
    if (!s) return null
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      return n >= 0 && n <= 23 ? n : null
    }
    if (s === '十') return 10
    const shi = s.match(/^十([零一二三四五六七八九])$/)
    if (shi) return 10 + cn[shi[1]]
    // "三四""四五""五六" 取第一个字
    return cn[s[0]] ?? null
  }

  /*
   * 按**分句**找，并去掉行首的列表符号（"- "）。
   *
   * 踩过两次，都是这里：
   *   1. 整段匹配会让"三四点睡"和后面的"起"配上，把睡觉点当成起床点
   *   2. "我们上次**一起**去的那家店"里的"一起"会被当成"一点起"，
   *      于是 wakeHour = 1
   * 所以既按标点分句，又把"一起"这种明显是词的排除掉。
   */
  const clauses = text
    .split(/[，,。；;\n]/)
    .map((s) => s.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)

  let sleepHour = null
  for (const c of clauses) {
    const m = c.match(/([零一二三四五六七八九十两\d]{1,3})\s*点?(?:多|左右)?\s*(?:才)?\s*睡/)
    if (m) {
      sleepHour = toHour(m[1])
      if (sleepHour !== null) break
    }
  }

  /*
   * 起床点：**先认"中午/上午/下午"这类词，再退回数字**。
   *
   * 顺序不能反。反了的话，"一起"那种垃圾数字匹配会抢先命中，
   * 让本来能靠"中午前后起"正确解析的情况退化成错的。
   */
  let wakeHour = null
  /*
   * 时段词允许中间夹一个钟点："下午两点起"里的"下午"和"起"隔了"两点"。
   * 不允许夹的话就漏了——实测"四五点才睡，下午两点起"会被解析成 5/2，
   * 把下午两点当成凌晨两点。
   */
  const noonMatch = text.match(/(中午|上午|下午|早上|凌晨)\s*[前后左右]*\s*(?:[零一二三四五六七八九十两\d]{1,3}\s*点\s*[前后左右]*\s*)?(?:起|醒)/)
  if (noonMatch) {
    wakeHour = { 中午: 12, 上午: 10, 下午: 14, 早上: 7, 凌晨: 5 }[noonMatch[1]] ?? null
  }

  if (wakeHour === null) {
    for (const c of clauses) {
      // "一起""上午"这类词里的"一"不算钟点
      if (/[^零一二三四五六七八九十两\d]一\s*(?:起|醒)/.test(c)) continue
      const m = c.match(/([零一二三四五六七八九十两\d]{1,3})\s*点\s*(?:左右|前后)?\s*(?:起|醒)/)
      if (m) {
        const h = toHour(m[1])
        // "一点起"没人这么说，多半还是误匹配
        if (h !== null && h !== 1) {
          wakeHour = h
          break
        }
      }
    }
  }

  const ok = sleepHour !== null && wakeHour !== null
  return {
    sleepHour: sleepHour ?? fallback.sleepHour,
    wakeHour: wakeHour ?? fallback.wakeHour,
    parsed: ok,
  }
}

/**
 * 现在有多困。0 = 完全清醒，1 = 已经睡着了。
 *
 * 不是简单的"在时段内/外"，而是平滑过渡——真人不会在某个整点突然断电，
 * 是越来越撑不住。所以睡前两小时开始困，睡后两小时才算彻底睡着。
 *
 * @param {{at?: number, window?: object}} [opts]
 */
export function sleepiness({ at = now(), window, wakeHour: wakeOverride } = {}) {
  const w = window ?? parseSleepWindow(readLife())
  const hour = localHour(at) + new Date(at).getMinutes() / 60
  const { sleepHour, wakeHour } = w

  /*
   * 判断"现在是不是睡觉时段"。
   *
   * 关键是**别去算"醒了几小时"再和时长比**——那样跨午夜会算错。
   * 实测踩过一次：15:00 和 19:00 被判成"睡熟了"，
   * 因为 `(时长 - 距下次起床 + 24) % 24` 在午后会跳到一个大于时长的值。
   *
   * 换成直接判断"这个钟点在不在 [入睡点, 起床点) 这段弧上"，
   * 用一次取模就够，跨不跨午夜都对。
   */
  const rel = (h, base) => (h - base + 24) % 24
  const hoursSinceSleep = rel(hour, sleepHour)
  const sleepSpan = rel(wakeHour, sleepHour)
  // sleepSpan 是"从入睡到起床"的时长；为 0 说明作息写得等于没睡，按 8 小时兜底
  const span = sleepSpan === 0 ? 8 : sleepSpan
  const isAsleepPeriod = hoursSinceSleep < span
  // 醒来多久了。起床时刻往前推就是"距下次起床还有多久"
  const hoursUntilWake = span - hoursSinceSleep

  let level
  let label
  if (!isAsleepPeriod) {
    // 距下次入睡还有多久：从起床到现在走了多久，离总清醒时长还差多少
    const awakeSpan = 24 - span
    const hoursAwake = rel(hour, wakeHour)
    const untilSleep = awakeSpan - hoursAwake

    if (untilSleep <= 0.75) {
      level = 0.95
      label = '已经困得不行了'
    } else if (untilSleep <= 2) {
      level = 0.6
      label = '开始困了'
    } else {
      level = 0
      label = '清醒'
    }
  } else {
    // 本该在睡：刚睡下两小时内算"半梦半醒"，往后算睡熟
    level = hoursSinceSleep < 2 ? 0.85 : 1
    label = hoursSinceSleep < 2 ? '刚被吵醒，迷迷糊糊' : '睡熟了'
  }

  return {
    level,
    label,
    hour: Math.floor(hour),
    sleepHour,
    wakeHour: wakeOverride ?? wakeHour,
    isAsleepPeriod,
    parsed: w.parsed,
  }
}

/**
 * 拼成注入提示词的那一段。
 *
 * 措辞上防两件事：
 *   - 别让她宣布"我困了要睡了"然后照样长篇大论
 *   - 别让她拒绝回话——用户半夜说话她还是要回，只是又短又困
 */
export function buildSleepySection(state) {
  if (!state || state.level <= 0) return ''

  const lines = [`【你现在的状态：${state.label}】`]

  if (state.isAsleepPeriod) {
    lines.push(
      `按你的作息现在本该睡着了（你一般 ${state.sleepHour} 点睡、${state.wakeHour} 点起）。`,
      `对方这时候找你，说明他还没睡。你可以回，但：`,
    )
  } else {
    lines.push(`快到你的睡觉点了（你一般 ${state.sleepHour} 点睡、${state.wakeHour} 点起）。`)
  }

  lines.push(
    `- **回得很短**，一句话，甚至就两三个字。脑子转不动了，别组织长句子。`,
    `- 语气发懒、发飘，可以有"困""眼睛睁不开""明天说"这类意思。`,
    `- **别主动开新话题**，别追问，别讲你自己的事。你现在的状态只想睡。`,
    `- 如果对方没什么要紧事，可以说睡了直接断——真人就是这样。`,
    `- 但**不要不回**。他找你你就应一声，只是应得很短。`,
    `- 不要说"作为AI我"或者任何关于自己是程序的话。`,
  )

  return lines.join('\n')
}

/** 给界面和 doctor 看的状态 */
export function sleepStatus(at = now()) {
  const w = parseSleepWindow(readLife())
  const s = sleepiness({ at, window: w })
  return {
    ...s,
    label: s.label,
    sleepHour: w.sleepHour,
    wakeHour: w.wakeHour,
  }
}

/**
 * 现在该不该由她主动开口。
 *
 * 睡觉时段不该主动找人说话——那正是"她真在睡"的体现。
 * 注意这只拦**主动**开口；对方先说话她还是会回（见 sleepiness 的说明）。
 */
export function activeHoursGate(cfg, at = now()) {
  if (cfg?.sleepy?.respectInProactive === false) return { ok: true }
  const s = sleepiness({ at })
  if (s.isAsleepPeriod) {
    return { ok: false, reason: `按她的作息现在在睡觉（${s.sleepHour} 点睡、${s.wakeHour} 点起）` }
  }
  return { ok: true }
}

export { now }
