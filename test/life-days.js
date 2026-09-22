/**
 * 她的"过去"（按天摘要）的测试。
 *
 * 要解决的问题：life.jsonl 是完整的，但只有最近 8 条会被喂回给她、
 * 也没有界面能看——所以她"只有现在、没有过去"。
 * 人设里写着"自己住了一年半""猫是两年前捡的"，那些过去没有记录支撑。
 *
 * 这个功能最容易出的四类问题：
 * 1. **当天就被摘要**。一天还没过完就写摘要，之后她的经历会变，
 *    摘要就过时了——白花钱，还留下一条不准的记录。
 * 2. **某天变成洞**。模型调用失败（断网、超时），那天在时间线上消失，
 *    用户会以为她那天什么都没做。所以必须有兜底。
 * 3. **把摘要当成刚发生的事说出去**。"我前天煮了面"没问题，
 *    "我刚煮了面"就错了——那是流水的事。
 * 4. **无限增长**。一天一条，一年 365 条，得有上限。
 *
 * 用法：node test/life-days.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import {
  activitiesOnDay,
  buildLifeDaysSection,
  catchUpDaySummaries,
  daysStats,
  daysTimeline,
  fallbackSummary,
  readDays,
  summarizedDates,
} from '../src/life-days.js'
import { buildDaySummaryPrompt } from '../src/prompts.js'

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

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
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

/** 造流水和摘要文件 */
function seed({ journal = [], days = [] } = {}) {
  fs.mkdirSync(path.dirname(PATHS.journal), { recursive: true })
  fs.writeFileSync(
    PATHS.journal,
    journal.map((e) => JSON.stringify({ kind: 'activity', ...e })).join('\n') +
      (journal.length ? '\n' : ''),
    'utf8',
  )
  if (days === null) {
    fs.rmSync(PATHS.lifeDays, { force: true })
  } else {
    fs.writeFileSync(
      PATHS.lifeDays,
      days.map((d) => JSON.stringify(d)).join('\n') + (days.length ? '\n' : ''),
      'utf8',
    )
  }
}

/** 今天往前 n 天的某个钟点 */
function daysAgo(n, hour = 15) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/** 那天的 dateKey */
function dayKey(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

console.log('\n按天分组\n')

check('能取出某一天的流水', () => {
  seed({
    journal: [
      { at: daysAgo(2, 10), text: '两点才起' },
      { at: daysAgo(2, 18), text: '煮了面' },
      { at: daysAgo(1, 12), text: '拿了快递' },
    ],
  })
  assert(activitiesOnDay(dayKey(2)).length === 2, '前两天应该有 2 条')
  assert(activitiesOnDay(dayKey(1)).length === 1, '昨天应该有 1 条')
  assert(activitiesOnDay('2020-01-01').length === 0, '没流水的日子应该是 0 条')
  return '按天分组正确'
})

check('空流水时一切都不崩', () => {
  seed({ journal: [], days: null })
  assert(readDays().length === 0, 'readDays 不为空')
  assert(activitiesOnDay(dayKey(1)).length === 0, 'activitiesOnDay 不为空')
  assert(buildLifeDaysSection() === '', 'buildLifeDaysSection 不为空')
  assert(daysTimeline().length === 0, 'daysTimeline 不为空')
  return 'ok'
})

console.log('\n兜底摘要（不调模型）\n')

check('把当天的流水压成一句', () => {
  const s = fallbackSummary([
    { text: '两点才起，土豆蹲窗台上看鸟' },
    { text: '把剩面热了吃' },
    { text: '改页面改到眼睛疼' },
  ])
  assert(s.includes('两点才起'), '没带上第一条：' + s)
  assert(s.includes('改页面'), '没带上最后一条：' + s)
  assert(!s.includes('。'), '不该有句号残留：' + s)
  return s
})

check('条数多时挑头中尾（不啰嗦）', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ text: `第 ${i} 件事` }))
  const s = fallbackSummary(many)
  const n = s.split('、').length
  assert(n <= 3, `应该最多 3 段，实际 ${n}：${s}`)
  assert(s.includes('第 0 件事'), '没取到第一条')
  assert(s.includes('第 9 件事'), '没取到最后一条')
  return `${n} 段`
})

check('空数组返回空串', () => {
  assert(fallbackSummary([]) === '', '空数组没返回空串')
  assert(fallbackSummary([{ text: '' }]) === '', '空文本没返回空串')
  return '空串'
})

console.log('\n生成摘要\n')

await checkAsync('给过完的一天写摘要（用兜底，不调模型）', async () => {
  /*
   * 这里故意 useModel:false——测试环境不该花钱调模型。
   * 兜底路径是必须有的：模型调用会失败（断网、超时、key 不对），
   * 没有兜底那天就在时间线上变成洞，用户会以为她那天什么都没做。
   */
  seed({
    journal: [
      { at: daysAgo(1, 10), text: '两点才起' },
      { at: daysAgo(1, 20), text: '改页面改到眼睛疼' },
    ],
    days: [],
  })
  const { summarizeDay } = await import('../src/life-days.js')
  const r = await summarizeDay(cfg, dayKey(1), { useModel: false })
  assert(r.ok, '没写成：' + r.reason)
  assert(r.entry.by === 'fallback', '应该标记成兜底')
  assert(r.entry.count === 2, '条数不对：' + r.entry.count)
  assert(readDays().length === 1, '没落盘')
  return r.entry.text
})

await checkAsync('同一天重复写会覆盖，不会出现两条', async () => {
  const { summarizeDay } = await import('../src/life-days.js')
  const r = await summarizeDay(cfg, dayKey(1), { useModel: false, force: true })
  assert(r.ok, '重写失败')
  assert(readDays().length === 1, `应该还是 1 条，实际 ${readDays().length}`)
  return '覆盖正确'
})

await checkAsync('没有流水的日子不写（不留空条目）', async () => {
  const { summarizeDay } = await import('../src/life-days.js')
  const before = readDays().length
  const r = await summarizeDay(cfg, '2020-01-01', { useModel: false })
  assert(!r.ok, '没流水却写了')
  assert(/没有流水/.test(r.reason), '理由不对：' + r.reason)
  assert(readDays().length === before, '条数变了')
  return r.reason
})

console.log('\n补摘要（catchUp）\n')

await checkAsync('只补"已经过完"的日子，当天不补（关键）', async () => {
  /*
   * 当天不摘要是刻意的：一天还没结束，她的经历还会变，
   * 现在写的摘要过几小时就不准了——白花钱，还留下一条错记录。
   */
  seed({
    journal: [
      { at: daysAgo(0, 10), text: '今天的事' }, // 今天
      { at: daysAgo(1, 10), text: '昨天的事' },
    ],
    days: [],
  })
  const r = await catchUpDaySummaries(cfg, { max: 10 })
  assert(r.added === 1, `应该只补 1 天，实际 ${r.added}`)
  const dates = [...summarizedDates()]
  assert(dates.length === 1, `应该只有 1 天，实际 ${dates.length}`)
  assert(dates[0] === dayKey(1), `补的应该是昨天，实际 ${dates[0]}`)
  assert(!dates.includes(dayKey(0)), '把今天也补了 —— 一天还没过完')
  return `补了 ${dates[0]}，没补今天`
})

await checkAsync('已经有摘要的日子不会重复补', async () => {
  const r = await catchUpDaySummaries(cfg, { max: 10 })
  assert(r.added === 0, `不该再补，实际补了 ${r.added}`)
  return '没有重复'
})

await checkAsync('一次最多补 max 天（避免一次调太多次模型）', async () => {
  seed({
    journal: [
      { at: daysAgo(1, 10), text: 'a' },
      { at: daysAgo(2, 10), text: 'b' },
      { at: daysAgo(3, 10), text: 'c' },
      { at: daysAgo(4, 10), text: 'd' },
      { at: daysAgo(5, 10), text: 'e' },
    ],
    days: [],
  })
  const r = await catchUpDaySummaries(cfg, { max: 2 })
  assert(r.added === 2, `应该只补 2 天，实际 ${r.added}`)
  assert(r.pending >= 3, `应该还剩至少 3 天，实际 ${r.pending}`)
  return `补了 ${r.added}，还剩 ${r.pending}`
})

await checkAsync('补的顺序是从早到晚（时间线才连贯）', async () => {
  seed({
    journal: [
      { at: daysAgo(1, 10), text: 'a' },
      { at: daysAgo(2, 10), text: 'b' },
      { at: daysAgo(3, 10), text: 'c' },
    ],
    days: [],
  })
  await catchUpDaySummaries(cfg, { max: 3 })
  const dates = readDays().map((d) => d.date)
  const sorted = [...dates].sort()
  assert(JSON.stringify(dates) === JSON.stringify(sorted), `readDays 没按日期正序：${dates}`)
  return dates.join(' → ')
})

console.log('\n注入提示词\n')

check('有摘要时注入，并说清"这是过去、不是刚发生"', () => {
  /*
   * 这条措辞是关键：摘要和"最近几天的流水"是两个粒度。
   * 不说清的话她会把"前天煮了面"说成"我刚煮了面"。
   */
  seed({
    journal: [{ at: daysAgo(1, 10), text: 'x' }],
    days: [
      { date: '2026-09-20', text: '睡到十二点半，改页面改到眼睛疼', count: 3, by: 'model' },
      { date: '2026-09-21', text: '煮面煮坨了，下楼拿快递', count: 2, by: 'model' },
    ],
  })
  const s = buildLifeDaysSection()
  assert(s.includes('2026-09-20'), '没带上日期')
  assert(s.includes('改页面改到眼睛疼'), '没带上内容')
  assert(/你这些天的日子/.test(s), '缺段落标题')
  assert(/已经过去的日子/.test(s), '没说清这是过去的事')
  assert(/别把它说成"今天"/.test(s), '没禁止说成今天')
  assert(/不要主动背时间线/.test(s), '没禁止背流水账')
  return `${s.length} 字`
})

check('没有摘要时是空串（不注入空段落）', () => {
  seed({ journal: [], days: null })
  assert(buildLifeDaysSection() === '', '没摘要却注入了')
  return '空串'
})

check('只带最近 7 天（避免长期烧 token）', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    text: `第 ${i} 天的事`,
    count: 1,
    by: 'model',
  }))
  seed({ journal: [], days: many })
  const s = buildLifeDaysSection()
  const lines = s.split('\n').filter((l) => l.startsWith('- 2026'))
  assert(lines.length === 7, `应该只带 7 天，实际 ${lines.length}`)
  return `${lines.length} 天`
})

check('单条摘要过长会截断', () => {
  seed({
    journal: [],
    days: [{ date: '2026-09-20', text: '很长'.repeat(80), count: 1, by: 'model' }],
  })
  const s = buildLifeDaysSection()
  const line = s.split('\n').find((l) => l.startsWith('- '))
  assert(line.length < 80, `没截断，长度 ${line.length}`)
  assert(line.endsWith('…'), '没加省略号')
  return `${line.length} 字`
})

console.log('\n时间线与上限\n')

check('时间线是新的在前（界面上一眼看到最近的）', () => {
  seed({
    journal: [],
    days: [
      { date: '2026-09-19', text: '早的', count: 1, by: 'model' },
      { date: '2026-09-21', text: '晚的', count: 1, by: 'model' },
      { date: '2026-09-20', text: '中的', count: 1, by: 'model' },
    ],
  })
  const t = daysTimeline()
  assert(t[0].date === '2026-09-21', `第一条应该是最新的，实际 ${t[0].date}`)
  assert(t[2].date === '2026-09-19', '最后一条应该是最早的')
  return t.map((d) => d.date).join(' → ')
})

check('daysStats 报得准', () => {
  const st = daysStats()
  assert(st.total === 3, `total 不对：${st.total}`)
  assert(st.first === '2026-09-19', `first 不对：${st.first}`)
  assert(st.last === '2026-09-21', `last 不对：${st.last}`)
  assert(st.byModel === 3, `byModel 不对：${st.byModel}`)
  return JSON.stringify(st)
})

check('坏行不会让整个文件读不出来', () => {
  fs.writeFileSync(
    PATHS.lifeDays,
    '{"date":"2026-09-21","text":"好的","count":1}\n{ 这不是 JSON\n{"date":"2026-09-22","text":"也是好的","count":1}\n',
    'utf8',
  )
  const list = readDays()
  assert(list.length === 2, `应该跳过坏行、留 2 条，实际 ${list.length}`)
  assert(list[0].text === '好的', '第一条内容不对')
  return '坏行被跳过'
})

check('缺字段的条目被忽略', () => {
  fs.writeFileSync(
    PATHS.lifeDays,
    '{"date":"2026-09-21"}\n{"text":"没有日期"}\n{"date":"2026-09-22","text":"完整的"}\n',
    'utf8',
  )
  const list = readDays()
  assert(list.length === 1, `应该只留 1 条，实际 ${list.length}`)
  assert(list[0].text === '完整的', '留下的不是完整那条')
  return '缺字段的忽略了'
})

console.log('\n提示词约束\n')

check('摘要提示词要求"一句话、40 字以内、像回想"', () => {
  const msgs = buildDaySummaryPrompt({ dateKey: '2026-09-21', activities: ['煮面', '拿快递'] })
  const t = msgs.map((m) => m.content).join('\n')
  assert(/一句话，40 字以内/.test(t), '没限制长度')
  assert(/像事后回想/.test(t), '没说语气')
  assert(/不像工作汇报/.test(t), '没排除汇报腔')
  assert(/不要罗列全部/.test(t), '没要求挑代表性的')
  assert(/不提"对方"/.test(t), '没排除那个网友')
  assert(/煮面/.test(t), '没把当天的流水带进去')
  return '约束齐全'
})

check('写入的不是真实 data 目录', () => {
  assert(
    path.resolve(PATHS.data) === path.resolve(process.env.FRIEND_DATA_DIR),
    `PATHS.data 指向了 ${PATHS.data}`,
  )
  return PATHS.data
})

// 收尾
seed({ journal: [], days: [] })

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
