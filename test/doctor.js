/**
 * 提示词体检和待回访的测试。
 *
 * 这个项目出过四次同类事故，全都是"以为给了她、其实没给"：
 *   life.md 没进提示词 · life.md 没传给主动消息 · .env 漏变量 ·
 *   提示词里有句话让她自己都觉得假
 *
 * 四次都是靠"用户用着觉得不对"才发现的。这个套件盯着那份自查能力，
 * 以及新加的"待回访"功能。
 *
 * 用法：node test/doctor.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import { runDoctor, doctorVerdict, estimateTokens } from '../src/doctor.js'
import {
  addRecall,
  buildRecallSection,
  dueRecalls,
  markAsked,
  peekPending,
  pruneRecall,
  readRecall,
  writeRecall,
} from '../src/recall.js'
import { buildRecallPrompt, buildProactiveMessagePrompt, buildChatSystemPrompt } from '../src/prompts.js'

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

const cfg = loadConfig()
const DAY = 24 * 60 * 60 * 1000

console.log('\ntoken 估算\n')

check('中文按字算，英文按 4 字符算', () => {
  // 中文信息密度高，一个字约一个 token；英文 4 字符约一个
  const zh = estimateTokens('你好世界')
  const en = estimateTokens('hello world')
  assert(zh >= 4 && zh <= 5, `4 个中文字应该约 4 token，实得 ${zh}`)
  assert(en >= 2 && en <= 4, `11 个英文字符应该约 3 token，实得 ${en}`)
  return `中文 4 字→${zh}，英文 11 字符→${en}`
})

check('空串返回 0，不报错', () => {
  assert(estimateTokens('') === 0, '空串不是 0')
  assert(estimateTokens(null) === 0, 'null 不是 0')
  return '0'
})

console.log('\n体检：逐段核对\n')

check('八段都在清单里，且标了该出现在哪份提示词', () => {
  const r = runDoctor(cfg)
  const ids = r.sections.map((s) => s.id)
  for (const expect of ['persona', 'memory', 'self', 'life', 'days', 'time', 'weather', 'sticker', 'recall']) {
    assert(ids.includes(expect), `缺段落 ${expect}`)
  }
  for (const s of r.sections) {
    assert(s.scope === 'chat' || s.scope === 'proactive', `${s.id} 的 scope 不合法：${s.scope}`)
    assert(typeof s.emptyHint === 'string' && s.emptyHint.length > 5, `${s.id} 缺空段落说明`)
  }
  return `${r.sections.length} 段`
})

check('天气的 scope 是 proactive（故意的，不是漏了）', () => {
  /*
   * 这条防的是"把设计报成故障"。
   * 天气故意不进聊天提示词（每句都提天气她会变成播报员）。
   * 如果 scope 标错了，doctor 会一直喊"天气没注入"——喊多了就没人看这个工具了。
   */
  const r = runDoctor(cfg)
  const w = r.sections.find((s) => s.id === 'weather')
  assert(w.scope === 'proactive', `天气的 scope 应该是 proactive，实际 ${w.scope}`)
  const recall = r.sections.find((s) => s.id === 'recall')
  assert(recall.scope === 'proactive', `待回访的 scope 应该是 proactive，实际 ${recall.scope}`)
  return '都是 proactive'
})

check('传了提示词就核对"在不在里面"', () => {
  const persona = fs.readFileSync(PATHS.persona, 'utf8')
  const r = runDoctor(cfg, { chatPrompt: persona })
  const p = r.sections.find((s) => s.id === 'persona')
  assert(p.inPrompt === true, '人设明明在提示词里，却报没注入')

  const r2 = runDoctor(cfg, { chatPrompt: '一段完全无关的文字' })
  const p2 = r2.sections.find((s) => s.id === 'persona')
  assert(p2.inPrompt === false, '人设不在提示词里，却报已注入')
  return '核对有效'
})

check('**没注入**会被判成坏，而且措辞说清为什么难发现', () => {
  const r = runDoctor(cfg, { chatPrompt: '无关内容', proactivePrompt: '无关内容' })
  const v = doctorVerdict(r)
  assert(v.level === 'bad', `应该判成 bad，实际 ${v.level}`)
  assert(/没.*拼进提示词|没有拼进提示词/.test(v.text), '结论没说清是"没拼进去"：' + v.text)
  return v.text.slice(0, 30) + '…'
})

check('自己拼一份完整提示词，八段都该能核对通过', () => {
  /*
   * 这是这个套件最有价值的一条：**端到端核对拼装**。
   * 前两次事故（life.md 没进提示词、没传给主动消息）都会在这里暴露。
   *
   * 注意：这里拼的提示词必须把**所有** scope='chat' 的段落都喂进去，
   * 少给一段，只要那段恰好有内容，这条就会报"没拼进提示词"——
   * 那是在报测试自己的漏，不是在报代码的错。
   */
  const r = runDoctor(cfg)
  const seg = (id) => r.sections.find((s) => s.id === id).text
  const chatPrompt = buildChatSystemPrompt({
    persona: seg('persona'),
    memory: seg('memory'),
    summary: '',
    lastExchangeAt: 0,
    selfSection: seg('self'),
    lifeSection: seg('life'),
    lifeDaysSection: seg('days'),
    stickerSection: seg('sticker'),
    nowText: seg('time'),
    // 这两段只在"她此刻在忙/在困"时才有内容。少给一段，
    // 只要它恰好非空，这条就会误报成"没拼进提示词"。
    busySection: seg('busy'),
    sleepySection: seg('sleepy'),
  })
  const pro = (() => {
    const m = buildProactiveMessagePrompt({
      persona: 'p',
      memory: 'm',
      transcript: '（无）',
      lastUserAgo: '1 小时前',
      lastAssistantAgo: '1 小时前',
      unansweredStreak: 0,
      todayCount: 0,
      weatherSection: seg('weather'),
      recallSection: seg('recall'),
      lifeDaysSection: seg('days'),
    })
    return Array.isArray(m) ? m.map((x) => x.content).join('\n') : String(m)
  })()

  const r2 = runDoctor(cfg, { chatPrompt, proactivePrompt: pro })
  const missing = r2.sections.filter((s) => s.hasContent && s.inPrompt === false)
  assert(
    missing.length === 0,
    `这些段有内容却没拼进提示词：${missing.map((s) => s.name).join('、')}`,
  )
  return '八段全部核对通过'
})

check('空段落有专门的说明，不是只显示空白', () => {
  const r = runDoctor(cfg)
  const empty = r.sections.filter((s) => !s.hasContent)
  for (const s of empty) {
    assert(s.emptyHint && s.emptyHint.length > 5, `${s.name} 是空的，但没有说明该怎么办`)
  }
  return `空的有 ${empty.length} 段，都有说明`
})

console.log('\n待回访：记账\n')

function resetRecall() {
  writeRecall({ version: 1, items: [] })
}

check('能记一件待回访的事', () => {
  resetRecall()
  const it = addRecall({ text: '他那个实习面试，说等通知' })
  assert(it, '没记上')
  assert(it.dueAt > it.createdAt, 'dueAt 应该在未来')
  assert(readRecall().items.length === 1, '没落盘')
  return it.text
})

check('太短的文本不记（避免记进一堆碎片）', () => {
  resetRecall()
  assert(addRecall({ text: '嗯' }) === null, '太短的被记上了')
  assert(addRecall({ text: '' }) === null, '空文本被记上了')
  assert(readRecall().items.length === 0, '不该有内容')
  return '已拒绝'
})

check('同一件事不重复记', () => {
  resetRecall()
  addRecall({ text: '他那个实习面试，说等通知' })
  addRecall({ text: '他那个实习面试，说等通知' })
  assert(readRecall().items.length === 1, `应该只有 1 条，实际 ${readRecall().items.length}`)
  return '去重了'
})

check('到点之前不出现，到点之后才出现', () => {
  resetRecall()
  const t0 = Date.now()
  addRecall({ text: '他那个面试等通知', afterDays: 3, at: t0 })

  assert(dueRecalls({ at: t0 }).length === 0, '刚记上就到期了')
  assert(dueRecalls({ at: t0 + 2 * DAY }).length === 0, '两天就到期了')
  assert(dueRecalls({ at: t0 + 3 * DAY }).length === 1, '三天还没到期')
  assert(dueRecalls({ at: t0 + 10 * DAY }).length === 1, '十天没到期')
  return '时间点正确'
})

check('太老的事自动过期（不该问一个月前的事）', () => {
  resetRecall()
  const t0 = Date.now()
  addRecall({ text: '他那个面试等通知', afterDays: 1, at: t0 })
  assert(dueRecalls({ at: t0 + 40 * DAY }).length === 0, '40 天前的还在问')
  return '会过期'
})

check('问过之后就不再出现', () => {
  resetRecall()
  const t0 = Date.now()
  const it = addRecall({ text: '他那个面试等通知', afterDays: 1, at: t0 })
  assert(dueRecalls({ at: t0 + 2 * DAY }).length === 1, '到期了却没出现')
  markAsked(it.id, t0 + 2 * DAY)
  assert(dueRecalls({ at: t0 + 2 * DAY }).length === 0, '问过了还出现')
  assert(dueRecalls({ at: t0 + 5 * DAY }).length === 0, '问过了过几天又出现')
  return '问过就收口'
})

check('到期越久的越先问', () => {
  resetRecall()
  const t0 = Date.now()
  addRecall({ text: '后到期的那件事', afterDays: 5, at: t0 })
  addRecall({ text: '先到期的那件事', afterDays: 1, at: t0 })
  const due = dueRecalls({ at: t0 + 6 * DAY })
  assert(due.length === 2, `应该 2 件，实际 ${due.length}`)
  assert(due[0].text === '先到期的那件事', '没按到期时间排序：' + due[0].text)
  return '排序正确'
})

check('最多同时挂 8 件，超出丢最老的', () => {
  resetRecall()
  const t0 = Date.now()
  for (let i = 0; i < 15; i++) addRecall({ text: `第 ${i} 件要回访的事`, afterDays: 1, at: t0 + i })
  const n = readRecall().items.length
  assert(n <= 8, `应该最多 8 件，实际 ${n}`)
  return `${n} 件`
})

check('清掉问过的和过期的', () => {
  resetRecall()
  const t0 = Date.now()
  const a = addRecall({ text: '问过的那件事', afterDays: 1, at: t0 })
  addRecall({ text: '还没问的那件事', afterDays: 1, at: t0 })
  markAsked(a.id, t0)

  // 问过不足 7 天 → 还留着；过 8 天 → 清掉
  assert(readRecall().items.length === 2, '不该提前清')
  const removed = pruneRecall(t0 + 8 * DAY)
  assert(removed >= 1, '没清掉问过的')
  return `清掉 ${removed} 件`
})

check('索引坏掉时不崩', () => {
  fs.mkdirSync(path.dirname(PATHS.recall), { recursive: true })
  fs.writeFileSync(PATHS.recall, '{ 这不是 JSON', 'utf8')
  assert(readRecall().items.length === 0, '坏文件没兜住')
  assert(dueRecalls().length === 0, '坏文件让 dueRecalls 崩了')
  return '已兜住'
})

console.log('\n待回访：给她的那段话\n')

check('没有到期的事就不注入（不留空段落）', () => {
  resetRecall()
  assert(buildRecallSection() === '', '没内容却生成了段落')
  assert(peekPending().section === '', 'peekPending 也应该是空串')
  return '空串'
})

check('有到期的事就注入，并说清怎么问', () => {
  resetRecall()
  const t0 = Date.now()
  addRecall({ text: '他那个实习面试，说等通知', afterDays: 1, at: t0 })
  const s = buildRecallSection({ at: t0 + 2 * DAY })
  assert(s.includes('他那个实习面试'), '没带上内容')
  assert(/回头问问/.test(s), '缺段落标题')
  assert(/像突然想起来/.test(s), '没说清语气（要说成像突然想起来，不是交作业）')
  assert(/一次只问一件/.test(s), '没限制一次问一件')
  assert(/不想说就别追/.test(s), '没写"对方不想说就别追"')
  return `${s.length} 字`
})

check('抽取提示词里明确说了"空数组是正常的"', () => {
  /*
   * 不写这句，模型会硬凑——每次都给你编几件"该回访的事"，
   * 于是她开始问一些你根本没提过的事，那比不问糟得多。
   */
  const msgs = buildRecallPrompt({ transcript: '对方：今天天气不错' })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/空数组是正常的/.test(text), '没说明空数组正常')
  assert(/不要硬凑/.test(text), '没禁止硬凑')
  assert(/不要重复/.test(text) || /不要重复/.test(text), '没说要避开已有的')
  assert(/只挑\*\*对方\*\*的|只挑\*\*对方\*\*/.test(text) || /你自己说过的事/.test(text), '没排除"她自己说过的事"')
  return '有'
})

check('抽取提示词要求 20 字以内、给建议天数', () => {
  const msgs = buildRecallPrompt({ transcript: 'x' })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/20 字以内/.test(text), '没限制长度')
  assert(/afterDays/.test(text), '没说输出格式里有 afterDays')
  return '有'
})

console.log('\n待回访：只在主动开口时给\n')

check('聊天提示词里没有待回访段落', () => {
  /*
   * 跟天气同理：聊天回复里塞"该问问这些"会让她像在交作业。
   */
  const prompt = buildChatSystemPrompt({
    persona: 'p',
    memory: 'm',
    lastExchangeAt: Date.now(),
  })
  assert(!/【可以回头问问的事】/.test(prompt), '聊天提示词里出现了待回访段落')
  return '没有（符合设计）'
})

check('主动开口的提示词里可以有，而且被要求优先说', () => {
  resetRecall()
  const t0 = Date.now()
  addRecall({ text: '他那个实习面试，说等通知', afterDays: 1, at: t0 })
  const m = buildProactiveMessagePrompt({
    persona: 'p',
    memory: 'm',
    transcript: '（无）',
    lastUserAgo: '1 天前',
    lastAssistantAgo: '1 天前',
    unansweredStreak: 0,
    todayCount: 0,
    recallSection: buildRecallSection({ at: t0 + 2 * DAY }),
  })
  const text = Array.isArray(m) ? m.map((x) => x.content).join('\n') : String(m)
  assert(/【可以回头问问的事】/.test(text), '主动提示词里没有待回访段落')
  assert(/最该优先说的/.test(text), '没告诉她这件事优先说')
  return '有'
})

check('写入的不是真实 data 目录', () => {
  assert(
    path.resolve(PATHS.data) === path.resolve(process.env.FRIEND_DATA_DIR),
    `PATHS.data 指向了 ${PATHS.data}`,
  )
  return PATHS.data
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
