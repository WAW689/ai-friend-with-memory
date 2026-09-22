/**
 * 黄历和天气的测试。
 *
 * 这个功能最容易出的五类问题：
 *
 * 1. **农历算错**。模型不会算农历，所以全靠这张表；表错一位，
 *    某些年份的中秋就偏一天。而且错了很难发现——只有到那个节日才暴露。
 *    所以拿**国务院公布的春节/中秋日期**当标准答案硬对。
 * 2. **节假日/调休搞错**。她会说"周六要上班"或者说"放假好好休息"，
 *    而用户明确在意调休。数据必须来自官方。
 * 3. **昼夜判断按时钟猜**。上海夏至 5 点天亮、冬天 17 点天黑，
 *    按"6-18 点算白天"猜必然在傍晚和清晨说错话。
 * 4. **天气把她变成播报员**。天气只在主动开口时给，聊天回复里永远不带。
 * 5. **断网就崩**。天气是锦上添花，拿不到必须静默降级，绝不影响聊天。
 *
 * 用法：node test/almanac.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import {
  dayPhase,
  describeNow,
  holidayOn,
  holidayYears,
  lunarToSolar,
  nextHoliday,
  seasonOf,
  solarToLunar,
} from '../src/almanac.js'
import { buildWeatherSection, describeWeather, peekWeather, weatherStatus } from '../src/weather.js'
import { buildChatSystemPrompt, buildProactiveMessagePrompt, renderTranscript } from '../src/prompts.js'

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

const d = (y, m, day, h = 12, min = 0) => new Date(y, m - 1, day, h, min, 0, 0)

/**
 * 把提示词函数的返回值统一取成文本。
 *
 * 聊天提示词返回字符串，主动开口那两个返回 `[{role, content}]` 数组——
 * 测试里直接对返回值调 .includes() 会静默失败（数组没有这个方法，
 * 但这个项目里 assert 收到 undefined 才报错，很容易写成假通过）。
 */
const promptText = (result) =>
  Array.isArray(result) ? result.map((m) => m.content).join('\n') : String(result)

console.log('\n农历（拿官方节日日期当标准答案）\n')

check('春节：农历正月初一 → 官方公布的日期', () => {
  /*
   * 这些日期来自国务院公布的节假日安排，是权威的。
   * 我们对不上就说明数据表或算法有问题——而这类错误平时根本看不出来，
   * 只有到那个节日才会发现"中秋怎么早了一天"。
   */
  const cases = [
    [2024, '2024-02-10'],
    [2025, '2025-01-29'],
    [2026, '2026-02-17'],
    [2027, '2027-02-06'],
  ]
  for (const [year, expect] of cases) {
    const s = lunarToSolar(year, 1, 1)
    const got = `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`
    assert(got === expect, `${year} 春节算成 ${got}，应为 ${expect}`)
  }
  return `${cases.length} 年全对`
})

check('中秋：农历八月十五 → 官方公布的日期', () => {
  const cases = [
    [2024, '2024-09-17'],
    [2025, '2025-10-06'],
    [2026, '2026-09-25'],
    [2027, '2027-09-15'],
  ]
  for (const [year, expect] of cases) {
    const s = lunarToSolar(year, 8, 15)
    const got = `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`
    assert(got === expect, `${year} 中秋算成 ${got}，应为 ${expect}`)
  }
  return `${cases.length} 年全对`
})

check('公历 → 农历：官方节日当天应落在正确的农历日', () => {
  const cases = [
    ['2026-09-25', '八月十五'],
    ['2026-02-17', '正月初一'],
    ['2025-10-06', '八月十五'],
    ['2025-01-29', '正月初一'],
  ]
  for (const [dateKey, expect] of cases) {
    const [y, m, dd] = dateKey.split('-').map(Number)
    const l = solarToLunar(d(y, m, dd))
    assert(l.text === expect, `${dateKey} 换成农历是 ${l.text}，应为 ${expect}`)
  }
  return `${cases.length} 项`
})

check('农历往返回得来（公历 → 农历 → 公历）', () => {
  for (const date of [d(2026, 9, 22), d(2026, 3, 1), d(2025, 12, 31), d(2024, 2, 10)]) {
    const l = solarToLunar(date)
    const back = lunarToSolar(l.year, l.month, l.day, l.isLeap)
    assert(
      back.year === date.getFullYear() && back.month === date.getMonth() + 1 && back.day === date.getDate(),
      `${date.toDateString()} 往返后变成 ${back.year}-${back.month}-${back.day}`,
    )
  }
  return '4 个日期'
})

check('超出数据范围时返回 null 而不是算错', () => {
  assert(solarToLunar(d(1899, 1, 1)) === null, '1899 年没返回 null')
  assert(solarToLunar(d(2101, 1, 1)) === null, '2101 年没返回 null')
  assert(lunarToSolar(1850, 1, 1) === null, 'lunarToSolar 越界没返回 null')
  return 'ok'
})

console.log('\n节假日与调休\n')

check('元旦、春节、清明、劳动、端午、国庆都在表里', () => {
  const names = new Set()
  for (const y of holidayYears()) {
    for (let m = 1; m <= 12; m++) {
      for (let day = 1; day <= 31; day++) {
        const h = holidayOn(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
        if (h) names.add(h.name)
      }
    }
  }
  for (const expect of ['元旦', '春节', '清明节', '劳动节', '端午节']) {
    assert([...names].some((n) => n.includes(expect)), `缺 ${expect}`)
  }
  assert([...names].some((n) => n.includes('国庆')), '缺国庆')
  assert([...names].some((n) => n.includes('中秋')), '缺中秋')
  return [...names].join('、')
})

check('调休日被标成"要上班"，不是放假', () => {
  /*
   * 这条是用户明确在意的事。2026-02-28 是春节调休（周六上班），
   * 如果标成放假日，她会说"周末好好休息"，用户一看就知道她在瞎说。
   */
  const cases = ['2026-02-28', '2026-01-04', '2026-05-09', '2026-10-10', '2025-01-26']
  for (const key of cases) {
    const h = holidayOn(key)
    assert(h, `${key} 不在表里`)
    assert(h.offDay === false, `${key} 应该标成调休上班，实际 offDay=${h.offDay}`)
  }
  return `${cases.length} 个调休日都对`
})

check('放假日被标成放假', () => {
  const cases = ['2026-10-01', '2026-09-25', '2026-02-17', '2026-01-01']
  for (const key of cases) {
    const h = holidayOn(key)
    assert(h, `${key} 不在表里`)
    assert(h.offDay === true, `${key} 应该是放假日`)
  }
  return `${cases.length} 个放假日都对`
})

check('表里只有 2025 和 2026（其他年份宁可不提，不能瞎说）', () => {
  const years = holidayYears()
  assert(years.length === 2, `应该有 2 个年份，实际 ${years.join('、')}`)
  assert(years.includes(2025) && years.includes(2026), `年份不对：${years.join('、')}`)
  // 没有数据的年份要返回 null，而不是编一个
  assert(holidayOn('2027-10-01') === null, '2027 年没数据却返回了东西')
  return years.join('、')
})

check('下一个节日：能找到、算对天数、带上放假跨度', () => {
  // 从 2026-09-22 看，下一个放假的节日是中秋（9/25），还有 3 天
  const next = nextHoliday(d(2026, 9, 22))
  assert(next, '没找到下一个节日')
  assert(next.name === '中秋节', `应该是中秋，实际 ${next.name}`)
  assert(next.daysAway === 3, `应该是 3 天后，实际 ${next.daysAway}`)
  assert(next.span === 3, `中秋应该放 3 天，实际 ${next.span}`)
  return `${next.name} ${next.dateKey}，${next.daysAway} 天后，放 ${next.span} 天`
})

check('自己在节日当天时，找的是"下一个"，不是今天', () => {
  const next = nextHoliday(d(2026, 9, 25))
  assert(next, '没找到')
  assert(next.name !== '中秋节', `还在报中秋，应该往后找了：${next.name}`)
  return `下一个是 ${next.name}`
})

check('没有节日数据时返回 null 而不是崩', () => {
  const next = nextHoliday(d(2030, 1, 1))
  assert(next === null, '2030 年没有数据却找到了节日')
  return 'null'
})

console.log('\n昼夜判断（不能按时钟猜）\n')

check('夏天 19:00 天还亮着（按小时猜会说"晚上"）', () => {
  /*
   * 这是不能用固定小时判断的原因。上海夏至日落接近 19:00，
   * 19 点应该还算"傍晚"，而不是"晚上"。
   */
  const p = dayPhase(d(2026, 6, 21, 19, 0), { sunrise: '04:52', sunset: '19:02' })
  assert(p.phase === '傍晚', `夏天 19:00 应该算傍晚，实际「${p.phase}」`)
  return p.phase
})

check('冬天 17:30 已经黑了（按小时猜会说"下午"）', () => {
  const p = dayPhase(d(2026, 12, 21, 17, 30), { sunrise: '06:48', sunset: '16:56' })
  assert(p.phase !== '下午', `冬天 17:30 不该算下午，实际「${p.phase}」`)
  assert(/天刚黑|晚上/.test(p.phase), `应该已经黑了，实际「${p.phase}」`)
  return p.phase
})

check('日出前的时刻算深夜，不是清早', () => {
  const p = dayPhase(d(2026, 6, 21, 4, 0), { sunrise: '04:52', sunset: '19:02' })
  assert(p.phase === '深夜', `日出前应算深夜，实际「${p.phase}」`)
  return p.phase
})

check('正午算中午', () => {
  const p = dayPhase(d(2026, 6, 21, 12, 0), { sunrise: '04:52', sunset: '19:02' })
  assert(p.phase === '中午', `应算中午，实际「${p.phase}」`)
  return p.phase
})

check('拿不到日出日落时退回保守分段，且不报错', () => {
  const p = dayPhase(d(2026, 6, 21, 14, 0), {})
  assert(p.phase, '没给出时段')
  assert(p.sunrise === null && p.sunset === null, '不该编造日出日落')
  return `退回分段：${p.phase}`
})

check('季节判断', () => {
  assert(seasonOf(d(2026, 4, 1)) === '春天', '4 月应该是春天')
  assert(seasonOf(d(2026, 7, 1)) === '夏天', '7 月应该是夏天')
  assert(seasonOf(d(2026, 10, 1)) === '秋天', '10 月应该是秋天')
  assert(seasonOf(d(2026, 1, 1)) === '冬天', '1 月应该是冬天')
  return '四季都对'
})

console.log('\n给模型的时间描述\n')

check('包含日期、星期、农历、季节、昼夜', () => {
  const text = describeNow(d(2026, 9, 22, 18, 15), { sunrise: '05:42', sunset: '17:51' })
  assert(/2026-09-22/.test(text), '缺日期')
  assert(/周二/.test(text), '缺星期')
  assert(/农历/.test(text), '缺农历')
  assert(/秋天/.test(text), '缺季节')
  assert(/天刚黑|傍晚|晚上/.test(text), '缺昼夜：' + text)
  return text.split('\n')[0]
})

check('节日当天会说明，调休会明确警告要上班', () => {
  const onHoliday = describeNow(d(2026, 10, 1, 12, 0), { sunrise: '05:50', sunset: '17:40' })
  assert(/国庆/.test(onHoliday), '国庆当天没提：' + onHoliday)

  const onMakeup = describeNow(d(2026, 10, 10, 12, 0), { sunrise: '05:58', sunset: '17:30' })
  assert(/调休/.test(onMakeup), '调休日没提：' + onMakeup)
  assert(/上班|上课/.test(onMakeup), '调休日没说清要上班：' + onMakeup)
  return '节假日和调休都提到了'
})

check('临近节日会提前说还有几天', () => {
  const text = describeNow(d(2026, 9, 22, 12, 0), { sunrise: '05:42', sunset: '17:51' })
  assert(/中秋/.test(text), '没提中秋：' + text)
  assert(/还有 3 天/.test(text), '没说还有几天：' + text)
  return '提前提醒了'
})

check('很远之后的节日就不提了（避免每天唠叨）', () => {
  // 2026-12-01 距离元旦还有约 31 天，超过 45 天阈值才不提
  const text = describeNow(d(2026, 12, 1, 12, 0), { sunrise: '06:40', sunset: '16:53' })
  assert(!/还有 \d+ 天/.test(text) || /还有 [1-4]\d 天/.test(text), '不该提太远的节日：' + text)
  return '没提太远的'
})

console.log('\n对话记录里的时间账（她说"快点收拾"太早的那个 bug）\n')

check('每条消息都带上"多久之前"', () => {
  /*
   * 这条盯的是一个真实的抱怨：对方说"我六点上课"，她在四点就催人收拾。
   *
   * 根因是对话记录里**只有绝对钟点**（"（15:00）"），没有"多久之前"，
   * 所以模型做不了时间减法——它算不出"现在 16:00，离六点还有一个多小时"。
   * 只能凭感觉，而感觉一律偏向"快来不及了"。
   *
   * 修法是两个时间都给：绝对钟点用于对齐，相对时间用于算账。
   */
  const base = d(2026, 9, 22, 15, 0).getTime()
  const msgs = [
    { role: 'user', text: '我六点上课', at: base, kind: 'chat' },
    { role: 'assistant', text: '哦', at: base + 5 * 60000, kind: 'chat' },
  ]
  const text = renderTranscript(msgs, { now: d(2026, 9, 22, 16, 0).getTime() })
  assert(/15:00，1 小时前/.test(text), `缺相对时间：${text}`)
  assert(/15:05，55 分钟前/.test(text), `第二条的相对时间不对：${text}`)
  return '都有'
})

check('绝不能出现 NaN（参数重名踩过的坑）', () => {
  /*
   * 踩过一次：函数签名把参数重命名成 refTs，函数体里却写 `now ?? Date.now()`，
   * 而 `now` 是从 util 导入的**函数**——于是减法算出 NaN，
   * 界面上显示成"（NaN 小时 NaN 分钟前）"。这条就是盯这个。
   */
  const base = d(2026, 9, 22, 15, 0).getTime()
  const text = renderTranscript([{ role: 'user', text: 'x', at: base, kind: 'chat' }], {
    now: d(2026, 9, 22, 16, 0).getTime(),
  })
  assert(!/NaN/.test(text), '出现了 NaN：' + text)
  return '没有 NaN'
})

check('不传 now 时用真实时钟兜底，不报错', () => {
  const text = renderTranscript([
    { role: 'user', text: 'x', at: Date.now() - 60000, kind: 'chat' },
  ])
  assert(!/NaN/.test(text), '缺省参数也出现了 NaN：' + text)
  assert(/刚刚|分钟前/.test(text), '缺省情况下没给出相对时间：' + text)
  return '兜住了'
})

check('太久以前的消息不挂相对时间（避免记录很吵）', () => {
  const base = d(2026, 9, 22, 8, 0).getTime()
  const text = renderTranscript([{ role: 'user', text: '早上说的', at: base, kind: 'chat' }], {
    now: d(2026, 9, 22, 22, 0).getTime(),
  })
  assert(!/小时前|分钟前/.test(text), '14 小时前的消息不该挂相对时间：' + text)
  return '没挂'
})

check('提示词里明确给了"该不该催"的时间账规则', () => {
  /*
   * 光有时间数据不够，还得明确告诉她怎么用。
   * 不写这段，模型看着"1 小时前"也照样会催。
   */
  const prompt = buildChatSystemPrompt({
    persona: '你是阿岚',
    memory: '',
    lastExchangeAt: Date.now(),
  })
  assert(/时间账要自己算一遍/.test(prompt), '缺少时间账那一段')
  assert(/1 小时以上.*绝对不要催|还剩 \*\*1 小时以上\*\*/.test(prompt), '没写清"1 小时以上不要催"')
  assert(/先看那句话是多久以前说的/.test(prompt), '没强调要结合"多久之前"一起看')
  assert(/不要拿一句话反复催/.test(prompt), '没禁止反复催')
  return '规则在'
})

console.log('\n天气\n')

check('能读缓存（同步、不联网）', () => {
  // peekWeather 不该发网络请求；没缓存就返回 null
  const w = peekWeather()
  assert(w === null || typeof w === 'object', 'peekWeather 返回了奇怪的东西')
  return w ? '有缓存' : '没缓存（正常）'
})

check('describeWeather 说人话，不说气象台腔', () => {
  const text = describeWeather({
    temperature: 26.2,
    // 体感差 4 度（真实会出现的闷热天）。差 3 度以上才提，否则是废话。
    feelsLike: 30,
    high: 29.2,
    low: 21.9,
    text: '阴',
    rainChance: 55,
    stale: false,
  })
  assert(/阴/.test(text), '缺天气描述：' + text)
  assert(/26 度/.test(text), '缺温度：' + text)
  assert(/体感/.test(text), '体感差 3 度以上应该提：' + text)
  assert(/55%/.test(text), '降雨概率够高应该提：' + text)
  return text
})

check('体感差得不多就不提（少说废话）', () => {
  // 差 2 度以内说了等于没说
  const text = describeWeather({ temperature: 26, feelsLike: 27.5, text: '阴' })
  assert(!/体感/.test(text), '差 1.5 度却提了体感：' + text)
  return text
})

check('降雨概率低就不提（少说废话）', () => {
  const text = describeWeather({ temperature: 20, feelsLike: 20, text: '晴', rainChance: 10 })
  assert(!/降雨/.test(text), '概率低却提了：' + text)
  return text
})

check('数据过期会标出来，不冒充实时', () => {
  const text = describeWeather({ temperature: 20, text: '晴', stale: true, ageMs: 90 * 60000 })
  assert(/分钟前查的/.test(text), '过期没标注：' + text)
  return text
})

check('没有数据时返回空串，不注入空段落', () => {
  assert(describeWeather(null) === '', 'null 没返回空串')
  assert(buildWeatherSection(null) === '', '没数据却生成了段落')
  assert(buildWeatherSection({}) === '', '空对象却生成了段落')
  return '空串'
})

check('天气段落里必须写明"这是查到的，不是感受到的"（关键）', () => {
  /*
   * 这条是整个天气功能最关键的一行。不写它，她会用预报数据编造亲身经历：
   * 整天没出门却说"外面真热"。用户一旦发现这种前后矛盾，
   * 前面攒的"她像个真人"就全塌了。
   */
  const s = buildWeatherSection({ temperature: 26, text: '阴', feelsLike: 26 })
  assert(s.length > 0, '没生成段落')
  assert(/查到的/.test(s), '没说明是"查到的"')
  assert(/不是你感受到的/.test(s), '没区分"查到"和"感受到"')
  assert(/没出门/.test(s), '没给出"没出门就别说热"的具体约束')
  return '有'
})

check('天气段落里有"别主动报天气"的克制要求', () => {
  const s = buildWeatherSection({ temperature: 26, text: '阴', feelsLike: 26 })
  assert(/别主动报天气/.test(s), '缺少克制要求，她会变成天气播报员')
  return '有'
})

check('weatherStatus 不崩', () => {
  assert(weatherStatus(null).ok === false, 'null 应该返回 ok:false')
  const st = weatherStatus({ temperature: 20, text: '晴' })
  assert(st.ok === true && typeof st.text === 'string', '有数据时应该给出文本')
  return st.text
})

console.log('\n注入位置（防止她变成天气播报员）\n')

check('聊天提示词里**不该**有天气', () => {
  /*
   * 这是刻意的设计，不是遗漏。
   * 聊天回复里带天气，她会每句话都挂一句"今天 26 度挺舒服"，
   * 人设立刻崩。天气只在主动开口那条路上给。
   */
  const prompt = buildChatSystemPrompt({
    persona: '你是阿岚',
    memory: '',
    lastExchangeAt: Date.now(),
  })
  assert(!/【天气/.test(prompt), '聊天提示词里出现了天气段落 —— 她会变成天气播报员')
  return '没有（符合设计）'
})

check('聊天提示词里**该**有完整的时间信息', () => {
  const prompt = buildChatSystemPrompt({
    persona: '你是阿岚',
    memory: '',
    lastExchangeAt: Date.now(),
  })
  assert(/【现在是什么时候/.test(prompt), '缺时间段落')
  assert(/农历/.test(prompt), '缺农历 —— 她算不出中秋')
  assert(/季节/.test(prompt), '缺季节')
  assert(/节假日一律以上面写的为准/.test(prompt), '缺"节假日不许自己算"的约束')
  return '农历/季节/约束都在'
})

check('主动开口的提示词里**可以**有天气', () => {
  const prompt = promptText(
    buildProactiveMessagePrompt({
      persona: '你是阿岚',
      memory: '',
      transcript: '（无）',
      lastUserAgo: '3 小时前',
      lastAssistantAgo: '2 小时前',
      unansweredStreak: 0,
      todayCount: 1,
      weatherSection: buildWeatherSection({ temperature: 26, text: '阴', feelsLike: 26 }),
    }),
  )
  assert(/【天气/.test(prompt), '主动开口时应该能看到天气')
  return '有'
})

check('主动开口的提示词里有完整时间信息', () => {
  const prompt = promptText(
    buildProactiveMessagePrompt({
      persona: '你是阿岚',
      memory: '',
      transcript: '（无）',
      lastUserAgo: '3 小时前',
      lastAssistantAgo: '2 小时前',
      unansweredStreak: 0,
      todayCount: 1,
    }),
  )
  assert(/【时间信息/.test(prompt), '缺时间信息段')
  assert(/20\d\d-\d\d-\d\d/.test(prompt), '缺具体日期')
  assert(/农历/.test(prompt), '缺农历')
  assert(/节假日一律以/.test(prompt), '缺"节假日不许自己算"的约束')
  return '有'
})

console.log('\n配置与隔离\n')

check('天气可以关掉，关了就不查', () => {
  const cfg = loadConfig()
  assert(cfg.weather.enabled !== undefined, '缺 weather.enabled')
  assert(cfg.weather.enabled === false || cfg.weather.enabled === true, 'enabled 不是布尔')
  return String(cfg.weather.enabled)
})

check('位置默认是上海的经纬度', () => {
  const cfg = loadConfig()
  assert(Number.isFinite(cfg.weather.latitude), '缺纬度')
  assert(Number.isFinite(cfg.weather.longitude), '缺经度')
  assert(Math.abs(cfg.weather.latitude - 31.2304) < 0.01, `纬度不对：${cfg.weather.latitude}`)
  assert(Math.abs(cfg.weather.longitude - 121.4737) < 0.01, `经度不对：${cfg.weather.longitude}`)
  return `${cfg.weather.latitude}, ${cfg.weather.longitude}`
})

check('写入的不是真实 data 目录', () => {
  assert(
    path.resolve(PATHS.data) === path.resolve(process.env.FRIEND_DATA_DIR),
    `PATHS.data 指向了 ${PATHS.data}`,
  )
  return PATHS.data
})

check('天气缓存坏了不会让它崩', () => {
  const file = path.join(PATHS.data, 'weather.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  assert(peekWeather() === null, '坏缓存没兜住')
  assert(weatherStatus(null).ok === false, '坏缓存让 weatherStatus 崩了')
  return '已兜住'
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
