/**
 * 顶部状态栏的测试。
 *
 * 这行字看起来只是个标签，但它决定用户**怎么理解"她没回消息"**：
 *   显示"在的"          → 她没回 = 可能不想理我
 *   显示"在煮面"        → 她没回 = 她在忙
 *
 * 所以这个套件的重点是两件事：
 *   1. **状态和延迟必须同源**。状态栏说"在煮面"、消息却秒回，比不显示更假。
 *   2. **几个状态的优先级和措辞**。"睡了"不能做成"勿扰"，
 *      那比没人理还让人难受。
 *
 * 用法：node test/status.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import { herState, shortActivity, stateForUI } from '../src/status.js'
import { replyDelay } from '../src/busy.js'
import { readLife } from '../src/life.js'

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
const MIN = 60 * 1000

/** 写一条生活流水（她"在忙"的依据） */
function writeJournal(entries) {
  fs.mkdirSync(path.dirname(PATHS.journal), { recursive: true })
  fs.writeFileSync(
    PATHS.journal,
    entries.map((e) => JSON.stringify({ kind: 'activity', ...e })).join('\n') +
      (entries.length ? '\n' : ''),
    'utf8',
  )
}

const justNow = (text, minutesAgo = 5) =>
  writeJournal([{ at: Date.now() - minutesAgo * MIN, text }])

const clearJournal = () => writeJournal([])

/** 造一个今天某点的绝对时间 */
const todayAt = (h, m = 0) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

console.log('\n清洗：流水 → 状态栏用语\n')

check('长的活动描述被提炼成"动宾"短语', () => {
  /*
   * 迭代了三轮才顺，三轮都是因为汉语动词短语没法靠截断得到：
   *   "起来煮了碗西红柿鸡蛋面" → 煮 + 面 = "煮面"（不是"起来煮了碗西红柿鸡蛋"）
   */
  const cases = [
    ['起来煮了碗西红柿鸡蛋面，面坨了', '煮面'],
    ['刚刚下楼拿快递，风挺大，冻脸', '下楼拿快递'],
    ['热水器又忽冷忽热，凑合洗完', '洗完'],
    ['改到第四版，又说还是第一版好', '改'],
  ]
  for (const [input, expect] of cases) {
    const got = shortActivity(input)
    assert(got === expect, `「${input}」得到「${got}」，期望「${expect}」`)
  }
  return `${cases.length} 句都对`
})

check('时间是噪音，要去掉', () => {
  assert(shortActivity('今天 10:30 下楼拿快递') === '下楼拿快递', '时间没去掉：' + shortActivity('今天 10:30 下楼拿快递'))
  assert(shortActivity('刚刚下楼拿快递') === '下楼拿快递', '「刚刚」没去掉')
  return '去干净了'
})

check('睡觉类返回"睡着了"，不套"在…"', () => {
  // "在睡到十二点半"不成话
  assert(shortActivity('今天 10:30 睡到十二点半') === '睡着了', '睡觉类没特判')
  assert(shortActivity('土豆踩我脸把我踩醒') !== '在', '不该产出半截话')
  return '睡着了'
})

check('虚词不能跟在动词后面（否则断在半截）', () => {
  /*
   * "改到第四版"取两个字会得到"改到第"——那个"第"是序数词开头，
   * 读起来像被剪断了，比只写"改"更难看。
   */
  const got = shortActivity('改到第四版')
  assert(!/第|了|的|着/.test(got), `动词后面跟了虚词：${got}`)
  return got
})

check('空输入不崩', () => {
  for (const bad of ['', null, undefined, '   ', '，。']) {
    const r = shortActivity(bad)
    assert(typeof r === 'string', `输入 ${JSON.stringify(bad)} 没返回字符串`)
  }
  return 'ok'
})

console.log('\n状态优先级\n')

check('正在打字最高优先（事实就是她在回你）', () => {
  clearJournal()
  const s = herState(cfg, { generating: true })
  assert(s.key === 'typing', `应该 typing，实际 ${s.key}`)
  assert(s.label === '正在输入…', '文案不对：' + s.label)
  return s.label
})

check('睡着 > 忙（她睡着了就不该说在煮面）', () => {
  // 造一条"在煮面"的流水，但时间设在凌晨 5 点——她该在睡
  writeJournal([{ at: todayAt(5, 0), text: '在煮面', kind: 'activity' }])
  const s = herState(cfg, { at: todayAt(5, 30) })
  assert(s.key === 'asleep', `凌晨该显示睡觉，实际 ${s.key}（${s.label}）`)
  return s.label
})

check('忙 > 空闲', () => {
  justNow('起来煮了碗西红柿鸡蛋面')
  const s = herState(cfg)
  assert(s.key === 'busy' || s.key === 'around', `应该在忙，实际 ${s.key}`)
  return s.label
})

check('都不满足时是"在的"（不是"在线"）', () => {
  /*
   * 刻意不用"在线"：那是 IM 的词，暗示"我随时待命"——
   * 那正是我们一直在摆脱的东西。
   */
  clearJournal()
  const s = herState(cfg, { at: todayAt(15, 0) })
  assert(s.key === 'here', `应该 here，实际 ${s.key}`)
  assert(s.label === '在的', `文案该是"在的"，实际「${s.label}」`)
  return s.label
})

console.log('\n措辞（这几个字决定用户怎么理解）\n')

check('睡着时不能说成"勿扰"（那是拒绝感）', () => {
  /*
   * 半夜想说话却发现对方"已开启勿扰"，比没人理还难受。
   * "有事留着我醒来看"是邀请，不是拒绝。
   */
  clearJournal()
  const s = herState(cfg, { at: todayAt(5, 0) })
  assert(s.key === 'asleep', '凌晨应该显示睡着')
  assert(!/勿扰|请勿|谢绝|免打扰/.test(s.detail), '用了拒绝性的措辞：' + s.detail)
  assert(/留着|醒来|醒了/.test(s.detail), '没写成"留着我醒来看"这种邀请语气：' + s.detail)
  assert(/点起/.test(s.detail), '没告诉她你几点会醒：' + s.detail)
  return s.detail
})

check('忙时给出"多久之前记下的"', () => {
  justNow('起来煮了碗面', 12)
  const s = herState(cfg)
  assert(/\d+ 分钟前/.test(s.detail), '没给出多久之前：' + s.detail)
  return s.detail
})

check('heavy 和 light 的措辞不同（区别是"能不能看手机"）', () => {
  justNow('下楼拿快递')
  const heavy = herState(cfg)
  justNow('改到第四版')
  const light = herState(cfg)

  assert(/^在/.test(heavy.label), 'heavy 应该以"在"开头：' + heavy.label)
  assert(!/能看手机/.test(heavy.label), 'heavy 不该说能看手机：' + heavy.label)
  assert(/能看手机/.test(light.label), 'light 应该说能看手机：' + light.label)
  return `${heavy.label} ／ ${light.label}`
})

console.log('\n铁律：状态和延迟必须同源（关键）\n')

check('状态说"在忙"（heavy）时，延迟**必须**大于 0', () => {
  /*
   * 这条是整个方案最容易穿帮的地方。
   * 状态栏说"在煮面"、消息却秒回——那比不显示状态更假。
   * 所以两者必须用同一份 busyState()。
   */
  const cases = ['起来煮了碗西红柿鸡蛋面', '刚刚下楼拿快递']
  for (const text of cases) {
    justNow(text)
    const s = herState(cfg)
    const delay = replyDelay(cfg)
    assert(s.key === 'busy', `「${text}」该显示在忙，实际 ${s.key}（${s.label}）`)
    assert(delay > 0, `状态显示「${s.label}」但延迟是 0 —— 会穿帮`)
    assert(/慢/.test(s.detail), `说在忙却没说会慢一点：${s.detail}`)
  }
  return `${cases.length} 种情况都对得上`
})

check('状态说"能看手机"（light）时，延迟**必须**是 0，文案也不能说会慢', () => {
  /*
   * 这条是反方向的穿帮，比上一条更隐蔽，而且**真的发生了一回**：
   *
   *   顶栏写着「在改东西，能看手机」，用户回一条消息却要等 40 秒。
   *   用户看到的是"她说能看手机，却拖了我 40 秒"——
   *   那比不显示状态更像在敷衍。
   *
   * 现在 light 只反映"她在干嘛"，不换成分秒；相应地，文案里也不能
   * 再出现"回得可能慢一点"——那是界面在替她许一个不兑现的承诺。
   */
  justNow('三百块的活改八遍')
  const s = herState(cfg)
  const delay = replyDelay(cfg)
  assert(s.key === 'around', `该显示 around，实际 ${s.key}（${s.label}）`)
  assert(/能看手机/.test(s.label), 'light 该说能看手机：' + s.label)
  assert(delay === 0, `说"能看手机"却延迟了 ${delay / 1000} 秒 —— 又穿帮了`)
  assert(!/慢/.test(s.detail), `说能看手机却暗示会慢：${s.detail}`)
  return `${s.label} · ${s.detail} · 延迟 0`
})

check('状态说"在的"时，延迟**必须**是 0', () => {
  clearJournal()
  // 找一个她清醒、不忙的时刻
  const s = herState(cfg, { at: todayAt(15, 0) })
  const d = replyDelay(cfg, { at: todayAt(15, 0) })
  if (s.key === 'here') {
    assert(d === 0, `状态是"在的"却延迟了 ${d / 1000} 秒`)
  }
  return `状态 ${s.key}，延迟 ${d / 1000} 秒`
})

check('同一时刻算两次结果一致（没有随机性）', () => {
  // 状态栏不能被随机数影响，否则每次刷新都可能变
  justNow('下楼拿快递')
  const at = Date.now()
  const a = herState(cfg, { at })
  const b = herState(cfg, { at })
  const c = herState(cfg, { at })
  assert(a.key === b.key && b.key === c.key, '同一时刻算出不同结果')
  assert(a.label === c.label, '标签不稳定')
  return `${a.label}（3 次一致）`
})

console.log('\n给界面的一份快照\n')

check('stateForUI 的字段齐全', () => {
  clearJournal()
  const ui = stateForUI(cfg)
  for (const k of ['key', 'label', 'detail', 'since', 'at']) {
    assert(k in ui, `缺字段 ${k}`)
  }
  assert(typeof ui.label === 'string' && ui.label.length > 0, 'label 不能是空的')
  return JSON.stringify(ui).slice(0, 60) + '…'
})

check('关掉在忙功能后不再显示在忙', () => {
  justNow('下楼拿快递')
  const s = herState({ ...cfg, busy: { ...cfg.busy, enabled: false } })
  assert(s.key !== 'busy' && s.key !== 'around', '关掉了还显示在忙：' + s.label)
  return s.label
})

check('关掉困劲儿后不再显示睡了', () => {
  clearJournal()
  const s = herState({ ...cfg, sleepy: { ...cfg.sleepy, enabled: false } }, { at: todayAt(5, 0) })
  assert(s.key !== 'asleep', '关掉了还显示睡了：' + s.label)
  return s.label
})

check('life.md 的作息解析失败时也不会崩', () => {
  // 状态依赖 sleepiness，而它要读 life.md 解析作息。
  // 解析不出来时会退回默认值，状态仍然要能给出。
  const life = readLife()
  assert(typeof life === 'string', 'life.md 读不到')
  const s = herState(cfg, { at: todayAt(15, 0) })
  assert(s.label, '没给出状态')
  return s.label
})

check('写入的不是真实 data 目录', () => {
  assert(
    path.resolve(PATHS.data) === path.resolve(process.env.FRIEND_DATA_DIR),
    `PATHS.data 指向了 ${PATHS.data}`,
  )
  return PATHS.data
})

clearJournal()

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
