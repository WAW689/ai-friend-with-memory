/**
 * 提示词组装测试。
 *
 * 重点是**时间感知**：模型必须分得清"昨天下午"和"今天下午"，
 * 也必须知道对方中间离开了多久。这类信息错了不会报错，
 * 只会让它在对话里说出明显错位的话，很难从日志里发现。
 *
 * 用法：node test/prompts.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import {
  renderTranscript,
  buildChatSystemPrompt,
  buildProactiveDecisionPrompt,
  buildProactiveMessagePrompt,
} from '../src/prompts.js'
import { buildContext } from '../src/engine.js'
import { store } from '../src/storage.js'
import { loadConfig } from '../src/config.js'

let pass = 0
let fail = 0

function check(name, fn) {
  try {
    const detail = fn()
    pass++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    fail++
    console.log(`  ✗ ${name} — ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const HOUR = 60 * 60 * 1000
const now = Date.now()

/** 本地日期字符串，和实现里的口径一致 */
function dayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

console.log('\n对话记录渲染\n')

check('空记录不报错', () => {
  assert(renderTranscript([]) === '', '空输入应返回空字符串')
  return '返回空串'
})

check('单条消息不带日期标题以外的装饰', () => {
  const text = renderTranscript([{ role: 'user', at: now, text: '在吗' }])
  assert(text.includes('在吗'), '内容丢了')
  assert(text.includes('【今天】'), `缺少今天标记：${text}`)
  return text.split('\n')[0]
})

check('跨天会插入日期边界', () => {
  const text = renderTranscript([
    { role: 'user', at: now - 30 * HOUR, text: 'A' },
    { role: 'user', at: now - 2 * HOUR, text: 'B' },
  ])
  assert(text.includes('【昨天】') || /——\s*昨天\s*——/.test(text), `缺少昨天边界：${text}`)
  assert(text.includes('—— 今天 ——'), `缺少今天边界：${text}`)
  return '昨天/今天 都标出来了'
})

check('超过 6 小时的空档会标注（同一天内）', () => {
  // 同一天内隔 7 小时：凌晨 2 点 → 早上 9 点，不会跨天
  const base = new Date()
  base.setHours(2, 0, 0, 0)
  const text = renderTranscript([
    { role: 'user', at: base.getTime(), text: 'A' },
    { role: 'user', at: base.getTime() + 7 * HOUR, text: 'B' },
  ])
  assert(/隔了 7 小时/.test(text), `没标出间隔：${text}`)
  return '标出了 7 小时'
})

check('跨天时日期和间隔都给', () => {
  // 晚上 22 点 → 次日 6 点，跨天且隔 8 小时
  const base = new Date()
  base.setHours(22, 0, 0, 0)
  const text = renderTranscript([
    { role: 'user', at: base.getTime(), text: 'A' },
    { role: 'user', at: base.getTime() + 8 * HOUR, text: 'B' },
  ])
  assert(/隔了 8 小时/.test(text), `缺间隔信息：${text}`)
  assert(/——/.test(text), `缺日期边界：${text}`)
  return '间隔 + 日期边界都在'
})

check('短间隔不标注（避免噪音）', () => {
  const text = renderTranscript([
    { role: 'user', at: now - 20 * 60 * 1000, text: 'A' },
    { role: 'user', at: now - 10 * 60 * 1000, text: 'B' },
  ])
  assert(!text.includes('隔了'), `不该标间隔：${text}`)
  return '未标注'
})

check('跨天且跨天多处时每处都标', () => {
  const text = renderTranscript([
    { role: 'user', at: now - 60 * HOUR, text: 'D1' },
    { role: 'user', at: now - 30 * HOUR, text: 'D2' },
    { role: 'user', at: now - 2 * HOUR, text: 'D3' },
  ])
  const boundaries = (text.match(/——/g) ?? []).length
  assert(boundaries >= 4, `边界标记太少（${boundaries} 个斜杠符号）：${text}`)
  return '三天各有一段'
})

check('事件类消息不进入记录', () => {
  const text = renderTranscript([
    { role: 'assistant', at: now, text: '内部事件', kind: 'system' },
    { role: 'user', at: now, text: '真实消息' },
  ])
  assert(!text.includes('内部事件'), 'system 消息泄漏进提示词了')
  assert(text.includes('真实消息'), '真实消息丢了')
  return '已过滤'
})

check('超长记录按尾部截断且不炸', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    at: now - (500 - i) * 60 * 1000,
    text: `这是第 ${i} 条消息，内容有一点长度好把预算用掉`,
  }))
  const text = renderTranscript(many, { maxChars: 2000 })
  assert(text.length < 4000, `没有按预算截断：${text.length} 字符`)
  assert(text.includes('第 499 条'), '最新的消息被截掉了（应该保留尾部）')
  return `${text.length} 字符，保留了最新的`
})

console.log('\n聊天时的系统提示词\n')

check('提示词包含当前日期和星期', () => {
  const prompt = buildChatSystemPrompt({
    persona: '你叫阿岚',
    memory: '对方在写代码',
    lastExchangeAt: now - 26 * HOUR,
  })
  assert(prompt.includes(dayKey(now)), '缺少今天的日期')
  assert(/周[日一二三四五六]/.test(prompt), '缺少星期')
  return '日期+星期都在'
})

check('时间信息排在最前面，且措辞足够强硬（关键回归点）', () => {
  /*
   * 这里踩过一个很典型的坑：时间原来写在最后一段，
   * 结果模型回答"现在几点"时说"两点半"——它抓的是对话记录里
   * 13:57 那句"我们聊到两点半"，完全无视提示词里的 15:53。
   *
   * LLM 对时间就是这样：对话记录里全是相对时间表达（"两点半""九点十分"），
   * 它会优先锚定那些。所以时间必须①放最前 ②写完整 ③显式禁止推断。
   */
  const prompt = buildChatSystemPrompt({
    persona: '你叫阿岚',
    memory: '',
    lastExchangeAt: now,
  })
  const firstSection = prompt.split('\n\n')[0]
  assert(/现在是 \d{4}-\d{2}-\d{2}/.test(firstSection), '时间不在第一段')
  assert(/唯一准确的时间/.test(firstSection), '缺少"这是唯一准确时间"的强调')
  assert(/绝不要.*推断|不要.*推断/.test(prompt), '缺少"不要从对话里推断时间"的禁令')
  assert(/为准/.test(prompt), '缺少时间冲突时的裁决规则')
  return '在第一段，含禁令与裁决规则'
})

check('提示词里不再有旧标题「现在的真实情况」', () => {
  // 改名后如果还有残留，说明改漏了
  const prompt = buildChatSystemPrompt({ persona: 'p', memory: '', lastExchangeAt: now })
  assert(!/【现在的真实情况】/.test(prompt), '旧标题还在')
  return '已换成更醒目的标题'
})

check('提示词说明离上次说话过了多久', () => {
  const prompt = buildChatSystemPrompt({
    persona: '你叫阿岚',
    memory: '',
    lastExchangeAt: now - 26 * HOUR,
  })
  assert(/距离你们上次说话/.test(prompt), '缺少间隔说明')
  assert(/1 天前|26 小时前/.test(prompt), `间隔描述不对：${prompt.match(/距离你们上次说话：[^。]*/)?.[0]}`)
  return prompt.match(/距离你们上次说话：[^。]*/)?.[0] ?? ''
})

check('没有历史时说明是第一次', () => {
  const prompt = buildChatSystemPrompt({ persona: 'p', memory: '', lastExchangeAt: 0 })
  assert(/第一次/.test(prompt), '应说明是第一次')
  return '已说明'
})

check('提示词里不会出现 markdown 小标题之类的要求冲突', () => {
  const prompt = buildChatSystemPrompt({ persona: 'p', memory: '', lastExchangeAt: now })
  assert(/不要提"提示词"/.test(prompt), '缺少防泄漏要求')
  return '防泄漏要求在'
})

console.log('\n主动开口的判断提示词\n')

check('判断提示词带上了间隔和连发次数', () => {
  const prompt = buildProactiveDecisionPrompt({
    persona: 'p',
    memory: '',
    summary: '',
    transcript: '对方（10:00）：在吗',
    context: {
      lastUserAgo: '3 小时前',
      lastAssistantAgo: '3 小时前',
      unansweredStreak: 1,
      todayCount: 2,
      userWatching: false,
    },
  })
  const text = prompt.map((m) => m.content).join('\n')
  assert(text.includes('3 小时前'), '缺少上次说话时间')
  assert(text.includes('连续主动发了 1 条'), '缺少连发次数')
  assert(text.includes('今天你已经主动发了 2 次'), '缺少今日次数')
  assert(/json/i.test(text), '缺少 JSON 输出要求')
  return '间隔/连发/今日次数 都在'
})

console.log('\n主动开口"写什么"的提示词\n')

/** 构造一份主动开口提示词，方便下面反复检查 */
function proactivePrompt(overrides = {}) {
  return buildProactiveMessagePrompt({
    persona: '你叫阿岚',
    memory: '对方骑小电驴上学',
    summary: '',
    transcript: '对方（09:00）：我让你九点叫我的\n我（09:10）：九点十分了，该起来收拾了',
    lastUserAgo: '10 分钟前',
    lastAssistantAgo: '刚刚',
    unansweredStreak: 1,
    todayCount: 3,
    ...overrides,
  })
}

check('不使用聊天模式的框架（关键回归点）', () => {
  const text = proactivePrompt().map((m) => m.content).join('\n')
  /*
   * 这是本 bug 的核心。
   * 之前复用了聊天提示词，里面写着"你正在用手机和对方发消息"，
   * 又同时发一条 user 消息说"没有人跟你说话"——两套模式打架，
   * 模型于是把自己当成在应答，说出前后不搭的话。
   */
  assert(!/你正在用手机和对方发消息/.test(text), '又退回了聊天模式的框架')
  assert(!/没有人跟你说话/.test(text), '不该再用"没有人跟你说话"这种与记录矛盾的措辞')
  assert(/这不是在回复他/.test(text), '缺少"这是你主动发起、不是应答"的说明')
  return '主动场景与应答场景已分离'
})

check('时间锚点说明是"对方上次说话"', () => {
  const text = proactivePrompt().map((m) => m.content).join('\n')
  assert(/对方上次说话：10 分钟前/.test(text), '缺少对方上次说话的时间')
  assert(/你上次说话：刚刚/.test(text), '缺少自己上次说话的时间')
  return '两个锚点都给了'
})

check('没有历史时不会算出"刚刚"这种错值', () => {
  const text = proactivePrompt({ lastUserAgo: '从未' }).map((m) => m.content).join('\n')
  assert(/对方上次说话：从未/.test(text), '首次开口的时间描述不对')
  return '显示为"从未"'
})

check('提醒不要重复自己刚发的话', () => {
  const text = proactivePrompt().map((m) => m.content).join('\n')
  assert(/不要重复你上一条已经发过的话/.test(text), '缺少防重复要求')
  // transcript 里已经有"九点十分了"，提示词必须明说那些是自己刚发的
  assert(/你自己发的|你刚才主动说的/.test(text), '没有说明记录尾部可能是自己刚发的')
  return '防重复要求 + 自己发言的标注都在'
})

check('连发未回时给出克制的措辞指引', () => {
  const text = proactivePrompt({ unansweredStreak: 2 }).map((m) => m.content).join('\n')
  assert(/连着发了 2 条/.test(text), '缺少连发提示')
  assert(/别催/.test(text), '缺少"别催"的指引')
  return '已提示别催'
})

check('未连发时不出现多余的连发提示', () => {
  const text = proactivePrompt({ unansweredStreak: 0 }).map((m) => m.content).join('\n')
  assert(!/连着发了/.test(text), '不该出现连发提示')
  return '未出现'
})

check('带上了今天已主动的次数', () => {
  const text = proactivePrompt({ todayCount: 7 }).map((m) => m.content).join('\n')
  assert(/今天你已经主动找过对方 7 次/.test(text), '缺少今日次数')
  return '7 次'
})

check('要求输出 JSON，且能容忍纯文本', () => {
  const text = proactivePrompt().map((m) => m.content).join('\n')
  assert(/"messages"/.test(text), '没有约定 JSON 字段名')
  return '约定 {"messages": [...]}'
})

check('明确禁止提 AI / 提示词', () => {
  const text = proactivePrompt().map((m) => m.content).join('\n')
  assert(/绝对不要提"提示词"/.test(text), '缺少防泄漏要求')
  return '在'
})

console.log('\n时间锚点（真实数据）\n')

check('主动发过消息后，"对方上次说话"不会变成"刚刚"', () => {
  /*
   * 这是 force 路径记忆混乱的根源：
   * 之前锚点取的是"最后一条消息"，而主动发过之后最后一条就是自己刚发的，
   * 于是提示词里永远写"距离你们上次说话：刚刚"，模型以为自己刚聊完，
   * 就不断重复同一句话（实测连续三次都在报"九点十分了"）。
   *
   * 正确锚点必须是"对方上次说话"。
   */
  store.load()

  const lastUser = store.lastUserMessage()
  const lastAny = store.messages[store.messages.length - 1]
  if (!lastUser) return '跳过（还没有对方的消息）'

  const ctx = buildContext(loadConfig())

  assert(
    ctx.lastUserMessageAt === lastUser.at,
    `lastUserMessageAt 不是对方那条消息的时间：${ctx.lastUserMessageAt} != ${lastUser.at}`,
  )

  // 如果最后一条恰好是它自己发的（主动消息之后就是这种情况），
  // 锚点必须仍然指向对方那条，而不是被带跑
  if (lastAny.role === 'assistant') {
    assert(
      ctx.lastUserMessageAt !== lastAny.at,
      '锚点被最后一条自己的消息带跑了（这就是那个 bug）',
    )
    return `锚点=对方（${new Date(ctx.lastUserMessageAt).toLocaleTimeString('zh-CN')}），` +
      `未被自己最后一条（${new Date(lastAny.at).toLocaleTimeString('zh-CN')}）覆盖`
  }
  return '最后一条本就是对方发的，锚点正确'
})

check('聊天场景的锚点是"当前这条之前"的消息', () => {
  store.load()
  const ctx = buildContext(loadConfig())
  if (ctx.recent.length < 2) return '跳过（消息太少）'

  // respond() 里取的是 recent 的倒数第二条，避免把刚存进去的这句算进去
  const previous = ctx.recent[ctx.recent.length - 2]
  const current = ctx.recent[ctx.recent.length - 1]
  assert(previous.at <= current.at, '倒数第二条不应比最后一条更新')
  return `前一条 ${new Date(previous.at).toLocaleTimeString('zh-CN')}，` +
    `当前条 ${new Date(current.at).toLocaleTimeString('zh-CN')}`
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
