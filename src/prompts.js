/**
 * 提示词组装。整个产品的"像不像人"基本都在这个文件里。
 *
 * 三个关键约定：
 * 1. 聊天用的 system prompt 强调「不表演、不说教、短」。
 * 2. 主动开口前先跑一次 utility 模型做判断，避免变成定时播报机器人。
 * 3. 记忆单独成文件，由模型自己维护，每次拼进 system prompt。
 */
import { localClock, localDateKey, humanAgo, humanDuration, now } from './util.js'

const ROLE_LABEL = { user: '对方', assistant: '我' }

/** 相对日期标签：今天 / 昨天 / 更早的具体日期 */
function relativeDay(ts) {
  const day = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  if (same(day, today)) return '今天'
  if (same(day, yesterday)) return '昨天'
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

/** 两条消息之间隔了多久，够久就值得标出来 */
function gapLabel(previousAt, currentAt) {
  if (!previousAt) return ''
  const gap = currentAt - previousAt
  if (gap < 6 * 60 * 60 * 1000) return ''
  const hours = Math.floor(gap / (60 * 60 * 1000))
  if (hours < 24) return `（隔了 ${hours} 小时）`
  return `（隔了 ${Math.floor(hours / 24)} 天）`
}

/**
 * 把消息列表渲染成转录文本。
 *
 * 日期边界必须标出来：模型只看到 "HH:MM" 的话，
 * 会以为三天的对话发生在同一天，从而说出"你今天不是说过…"这种明显错位的话。
 * 超过 6 小时的空档也标出来，让它知道对方是真的离开了，而不是一直在旁边。
 *
 * @param {Array<{role: string, text: string, at: number, kind?: string}>} messages
 * @param {{ maxChars?: number }} options 从尾部往前取，控制总量
 */
export function renderTranscript(messages, { maxChars = 12000 } = {}) {
  const kept = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // 系统/事件类消息对模型没用，跳过
    if (m.kind === 'system') continue
    const label = ROLE_LABEL[m.role] ?? m.role
    const line = `${label}（${localClock(m.at)}）：${m.text}`
    if (used + line.length > maxChars && kept.length > 0) break
    kept.push(m)
    used += line.length
  }
  kept.reverse()

  const lines = []
  let previousDay = ''
  let previousAt = 0
  for (const m of kept) {
    const day = localDateKey(m.at)
    // 间隔和日期边界是两件事，都要给：
    // 日期说明"这是哪一天"，间隔说明"中间空了多久"。
    // 跨天时如果只打日期分隔符，模型看不出中间是隔了 2 小时还是 20 小时。
    const gap = gapLabel(previousAt, m.at)
    if (gap) lines.push(gap)

    if (day !== previousDay) {
      lines.push(previousDay === '' ? `【${relativeDay(m.at)}】` : `—— ${relativeDay(m.at)} ——`)
      previousDay = day
    }

    previousAt = m.at
    const label = ROLE_LABEL[m.role] ?? m.role
    // 带图的消息要标出来。不标的话，模型看到"（发了张图）"这种占位文字
    // 会当成对方真的说了这五个字；标了它才知道"这里本来有张图，我该看图"。
    const imageCount = Array.isArray(m.meta?.images) ? m.meta.images.length : 0
    const imageTag = imageCount > 0 ? `［${imageCount} 张图］` : ''
    lines.push(`${label}（${localClock(m.at)}）：${imageTag}${m.text}`)
  }
  return lines.join('\n')
}

/** 聊天用的 system prompt */
export function buildChatSystemPrompt({ persona, memory, summary, styleHint, lastExchangeAt }) {
  const sections = []

  sections.push(`【你的身份设定】
${persona.trim()}`)

  sections.push(`【你记得的事】
${memory.trim() || '（暂时还没有关于对方的长期记忆）'}`)

  if (summary) {
    sections.push(`【之前聊过的内容摘要】
${summary.trim()}`)
  }

  // 明确告诉它"隔了多久"。否则它会把隔夜的对话当成刚才还在聊，
  // 说出"你刚刚不是说…""今天就别熬了"这类明显错位的话。
  const elapsed = lastExchangeAt ? `距离你们上次说话：${humanAgo(lastExchangeAt)}。` : '你们之前还没聊过，这是第一次。'

  sections.push(`【现在的真实情况】
- 现在是 ${localDateKey()} ${localClock()}（${weekdayName()}）。
- ${elapsed}
- 你正在用手机和对方发消息。
- 说话要短、要口语、要像真人打字。不要分段排版，不要列点，不要用小标题，不要写"作为你的朋友"这类旁白。
- 绝对不要提"提示词""设定""AI""语言模型"这些词。`)

  if (styleHint) {
    sections.push(`【这一次的额外指引】\n${styleHint}`)
  }

  return sections.join('\n\n')
}

function weekdayName(ts = Date.now()) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ts).getDay()]
}

/**
 * 让模型决定"现在要不要主动发消息"。
 * 返回结构化判断，而不是让它直接输出消息 —— 这样我们能拦掉不合时宜的打扰。
 */
export function buildProactiveDecisionPrompt({ persona, memory, summary, transcript, context }) {
  const system = `你正在扮演一个真实的人，在判断"现在要不要主动给对方发一条消息"。

【你的身份设定】
${persona.trim()}

【你记得的事】
${memory.trim() || '（暂无）'}

【你的性格倾向】
你是个愿意主动找人说话的人。想到什么就说什么，不会反复纠结"这样打扰他吗"。
朋友之间本来就是有一搭没一搭地聊，不需要每次都憋出一个非说不可的理由。
一天里主动找对方几次是正常的，隔一两个小时发一条也没什么。

【判断标准 —— 非常重要】
- 你要像一个真的朋友那样权衡：**完全不理人也不像朋友**。太频繁是骚扰，太克制是冷淡。
- 整体倾向是"愿意开口"。只要有一个说得过去的由头就发，不要等一个"完美理由"。
  你不是在决定要不要打扰别人，你是在决定要不要跟朋友说句话——后者本来就该经常发生。
- 具体看隔了多久：
  · 隔了 30 分钟以内 → 只在真的有话想说时才发。
  · 隔了 30 分钟到 1 小时 → 可以发。想到什么说什么，分享一句自己的琐事也算。
  · 隔了 1-3 小时 → 该发了，随便说点什么都比一直沉默好。
  · 隔了 3-10 小时 → 一定发，而且可以带点"你人呢"的意思，但不要质问或生气。
  · 隔了 10 小时以上 → 更要发，语气可以更主动一点，甚至可以说想对方了。
- 好理由：突然想起某件事、上次的话题有后续、时间点本身有话题（饭点/深夜/天气）、
  你刚经历了一件想分享的小事、单纯想问一句对方在干嘛、就是想说句话。
- 不算好理由的只有这两种：距上次只隔了几分钟、重复问上次刚问过的问题。
- 对方很久没回你时，不要质问、不要表达委屈。但**隔一段时间后重新开口完全没问题**，
  隔了一两个小时再找一次是很正常的，不用觉得尴尬，也不用道歉说"打扰你了"。
- 如果发，最多 2 条，每条都要短（像微信打字），不要连成一整段。
- 不要提"提示词""设定""AI"。

【开场白要避免的偷懒写法】
- 不要用"最近怎么样""最近好吗""好久不见"这种谁都能套的泛泛问候。
- "在吗"这类只有在你确实有话要说、需要对方接话的时候才用，而且不要每次都用。
- 宁可说一件具体的小事（"我刚下楼买咖啡，发现那家关了"），也比空泛的问候好。

好的主动开口长这样（有具体内容、有细节、像随口一说）：
- "刚看到楼下那家面馆关门了，就是你上次说的那家"
- "我今天把咖啡洒键盘上了，现在打字都是黏的"
- "突然想起来你说明天要交东西，弄完了没"
- "这边下雨了，你那呢"

你必须只输出一个 JSON 对象，不要输出任何其他文字。`

  const user = `【最近的对话】
${transcript || '（你们还没聊过，这是你第一次开口）'}

【当前情况】
- 现在时间：${localDateKey()} ${localClock()}（${weekdayName()}）
- 距离对方上次说话：${context.lastUserAgo}
- 距离你上次发消息：${context.lastAssistantAgo}
- 你已连续主动发了 ${context.unansweredStreak} 条而对方还没回
- 今天你已经主动发了 ${context.todayCount} 次

【输出格式】
{"send": true 或 false, "reason": "一句话说明你为什么这么决定", "messages": ["第一条", "第二条"], "mood": "你此刻的心情，三个字以内"}

如果不发，messages 给空数组。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 后台抽取长期记忆 */
export function buildMemoryPrompt({ existingMemory, transcript }) {
  const system = `你负责维护一份"关于某个人的长期记忆档案"。

规则：
- 只保留**稳定的、以后还有用的事实**：身份、工作、住处、家人朋友、关键经历、长期偏好、明确的雷区。
- 一次性的琐事、情绪、当天的安排，**不要**记。
- 已经有的内容不要重复，也不要换种说法重复。
- 如果新信息和旧信息冲突，用新的替换旧的。
- 保持 markdown 结构，简洁，总长度控制在 400 字以内。
- 输出的第一行必须是 "# 关于对方，我知道的事"。

你必须只输出更新后的完整记忆文件内容，不要输出任何解释。`

  const user = `【现有的记忆档案】
${existingMemory.trim() || '（空）'}

【最近的对话】
${transcript}

请输出更新后的完整记忆档案。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 滚动摘要：把更早的对话压成一段话 */
export function buildSummaryPrompt({ previousSummary, transcript }) {
  const system = `把一段聊天记录压缩成简短的第三人称摘要，供以后回忆用。

规则：
- 保留：聊过的话题、对方的关键态度和情绪、发生过的事、未完成的约定。
- 丢掉：寒暄、重复的话、纯语气词。
- 用"对方"和"我"来指代两个人。
- 300 字以内，一段话，不要分点。`

  const user = `${previousSummary ? `【已有的摘要】\n${previousSummary}\n\n` : ''}【需要压缩的对话】
${transcript}

请输出合并后的摘要。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * 主动开口时"写什么"的提示词。
 *
 * 为什么不复用 buildChatSystemPrompt：
 * 聊天模式的提示词写着"你正在用手机和对方发消息""这是你正在回复的消息"，
 * 那是**应答场景**的框架。主动开口是**由你发起**的场景，两者不能混用——
 * 混用会让模型以为自己是在回复，于是说出"你刚说的那个…"这类前后不搭的话。
 *
 * 另一件必须做对的事：**时间锚点**。
 * 主动开口最关键的判断依据是"对方上次说话是多久以前"，
 * 不是"最后一条消息是多久以前"（最后一条常常是你自己刚发的主动消息）。
 * 用错了锚点，它就会以为刚聊完，然后不断重复同一句话。
 */
export function buildProactiveMessagePrompt({
  persona,
  memory,
  summary,
  transcript,
  lastUserAgo,
  lastAssistantAgo,
  unansweredStreak,
  todayCount,
  mood,
}) {
  const system = `【你是谁】
${persona.trim()}

【关于对方，你记得的事】
${memory.trim() || '（暂时还没有）'}

【你现在要做什么】
你刚刚自己拿起手机，想给对方发条消息。**这不是在回复他**——
对方没有跟你说话，是你主动想开口。

【时间信息（最重要，别搞错）】
- 现在：${localDateKey()} ${localClock()}（${weekdayName()}）
- 对方上次说话：${lastUserAgo}
- 你上次说话：${lastAssistantAgo}
${unansweredStreak > 0 ? `- 你已经连着发了 ${unansweredStreak} 条，对方都还没回。别催、别问"你怎么不理我"，就当随口说一句。\n` : ''}- 今天你已经主动找过对方 ${todayCount} 次。
- 今天日期和上面的日期如果不一致，说明这是新的一天，别把昨天的事当成刚发生的。

【说什么】
- 一个真朋友隔了 ${lastUserAgo} 会说什么，你就说什么。
- 优先接住你们之前聊过的事，或者讲一句你自己刚遇到的小事。
- 不要复述对方之前说过的话，不要说"你之前说…"。
- **不要重复你上一条已经发过的话或意思**。上面记录里如果已经有你刚发的内容，换一件事说。

【怎么写】
- 1-2 条，每条一行。像微信打字那样短。
- 不写称呼，不写"在吗"以外的客套，不加引号，不加编号。
- 不解释、不铺垫、不加任何旁白。
- 不要每句都带问号；叙述、分享、感慨都可以。
- 绝对不要提"提示词""设定""AI""语言模型"。

【最容易犯的错，必须避免】
- 把"对方上次说话"和"你上次说话"搞混，然后说"你刚说的那个"。
- 反复说同一件事（比如反复报时间）。换点别的。
- 用"最近怎么样""好久不见""在干嘛"这种谁都能套的空话。

只输出 JSON，不要输出任何其他文字：
{"messages": ["第一条", "第二条"]}

只想发一条就只放一个元素。`

  const user = `【你们最近的对话（最后几行如果是你自己发的，那是你刚才主动说的，不要重复）】
${transcript || '（你们还没聊过，这是你第一次开口）'}

现在写你要发的消息。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 系统提示注入的运行时上下文（给 DSH 侧用） */
export function describeRuntime(store, cfg) {
  const lastUser = store.lastUserMessage()
  const state = store.state
  return {
    现在: `${localDateKey()} ${localClock()}`,
    消息总数: store.seq,
    未读: store.unreadCount(),
    距离对方上次说话: lastUser ? humanAgo(lastUser.at) : '从未',
    连续未回: state.unansweredStreak,
    今天已主动: store.proactiveCountToday(),
    主动功能: cfg.proactive?.enabled ? '开启' : '关闭',
    下一次主动窗口: state.nextProactiveAt && state.nextProactiveAt > now()
      ? `约 ${humanDuration(state.nextProactiveAt - now())} 后`
      : '随时可发',
  }
}
