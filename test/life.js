/**
 * 生活流水功能的测试。
 *
 * 这个功能最容易出的三类问题：
 * 1. **时机不对**：用户正在聊天，它却"经历"了一件事——那是打断，不是生活
 * 2. **污染聊天**：把流水里的东西说成"你们共同的经历"
 * 3. **设定丢失**：只注入流水、不注入 life.md，她聊天时不知道自己是谁
 *    （职业改了也白改），或者反过来有流水却丢设定
 *
 * 用法：node test/life.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import {
  buildLifeSection,
  hasLife,
  lastActivityAt,
  readArcs,
  readJournal,
  readLife,
  recordActivity,
  writeArcs,
  writeLife,
} from '../src/life.js'
import { buildChatSystemPrompt } from '../src/prompts.js'

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

/* ------------------------------------------------------------ 隔离 */

/*
 * 必须用 PATHS 里的实际路径，不能自己算一个。
 *
 * 之前这里自己拼了 test/tmp 下的路径，而 PATHS 用的是
 * FRIEND_DATA_DIR 注入的目录——两者不一致，
 * 于是测试往 A 处写、代码从 B 处读，一堆"有内容却判为没有"的假失败。
 */
const LIFE_FILE = PATHS.life
const JOURNAL_FILE = PATHS.journal
const ARCS_FILE = PATHS.lifeArcs

for (const f of [LIFE_FILE, JOURNAL_FILE, ARCS_FILE]) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
}

/** 每条检查前重置成干净状态，避免互相影响 */
function reset({ withLife = true, journal = [] } = {}) {
  if (withLife) {
    fs.writeFileSync(LIFE_FILE, '# 我是谁\n\n23 岁，一个人在上海，自由职业程序员，养猫叫土豆。\n', 'utf8')
  } else {
    fs.rmSync(LIFE_FILE, { force: true })
  }
  fs.writeFileSync(JOURNAL_FILE, journal.map((e) => JSON.stringify(e)).join('\n') + (journal.length ? '\n' : ''), 'utf8')
  fs.writeFileSync(ARCS_FILE, '[]', 'utf8')
}

const HOUR = 3600 * 1000

console.log('\n生活设定\n')

check('没有设定时能识别出来', () => {
  reset({ withLife: false })
  assert(!hasLife(), '空设定应该被判为没有')
  return '已识别'
})

check('有设定时能被读到', () => {
  reset()
  assert(hasLife(), '有内容却判为没有')
  assert(readLife().includes('土豆'), '内容读不回来')
  return `${readLife().length} 字`
})

console.log('\n流水\n')

check('能记一件事', () => {
  reset()
  const e = recordActivity({ text: '下楼拿快递，风挺大', at: Date.now() - HOUR })
  assert(e && e.text, '没有返回记录')
  assert(readJournal().length === 1, '没有落盘')
  return e.text
})

check('空文本不会被记录', () => {
  reset()
  assert(recordActivity({ text: '   ' }) === null, '空文本应该返回 null')
  assert(readJournal().length === 0, '空文本被写进去了')
  return '已拒绝'
})

check('流水按时间正序读回', () => {
  const base = Date.now() - 10 * HOUR
  reset({
    journal: [
      { at: base + 3 * HOUR, text: '第三件' },
      { at: base, text: '第一件' },
      { at: base + HOUR, text: '第二件' },
    ],
  })
  const all = readJournal()
  const texts = all.map((e) => e.text)
  assert(texts[0] === '第一件' && texts[2] === '第三件', `顺序不对：${texts.join(',')}`)
  return texts.join(' → ')
})

check('lastActivityAt 取的是最后一条', () => {
  const base = Date.now() - 5 * HOUR
  reset({
    journal: [
      { at: base, text: '早的' },
      { at: base + 2 * HOUR, text: '晚的' },
    ],
  })
  assert(lastActivityAt() === base + 2 * HOUR, '取的不是最后一条')
  return '正确'
})

console.log('\n注入聊天提示词\n')

/*
 * 这两条原来断言的是"没有流水就整段不注入"。
 *
 * 那个行为其实是 bug：life.md 是**她是谁**（职业、住哪、脾气），
 * 流水只是"她最近干了什么"。原来只注入流水、不注入设定，
 * 结果她聊天时根本不知道自己是干什么的——改了 life.md 里的职业，
 * 聊天里毫无变化，只有日志生成器知道。所以拆成两条各自独立的检查。
 */
check('没有流水时，设定仍然要注入（否则她不知道自己是谁）', () => {
  reset({ withLife: true, journal: [] })
  const section = buildLifeSection()
  assert(section.includes('自由职业程序员'), '没有流水就把设定一起丢了')
  assert(!/【你最近几天实际做过的事】/.test(section), '没有流水却出现了流水段落')
  return '只注入设定'
})

check('没有设定时，流水仍然要注入', () => {
  reset({ withLife: false, journal: [{ at: Date.now(), text: '某件事' }] })
  const section = buildLifeSection()
  assert(section.includes('某件事'), '没有设定就把流水一起丢了')
  assert(!/【你自己的生活设定/.test(section), '没有设定却出现了设定段落')
  return '只注入流水'
})

check('设定和流水都没有时，整段不注入（避免空段落）', () => {
  reset({ withLife: false, journal: [] })
  assert(buildLifeSection() === '', '什么都为空却注入了')
  return '空串'
})

check('职业设定真的进了聊天系统提示词（关键）', () => {
  /*
   * 这条是这次改动真正的目的：只测 buildLifeSection 不够，
   * 必须一路走到 buildChatSystemPrompt，确认职业能被模型看到。
   */
  reset({ withLife: true, journal: [] })
  const prompt = buildChatSystemPrompt({
    persona: '你是天狼星。',
    memory: '（无）',
    lifeSection: buildLifeSection(),
  })
  assert(prompt.includes('自由职业程序员'), '职业设定没有进系统提示词')
  assert(/【你自己的生活设定/.test(prompt), '缺少生活设定段落')
  return '已进入提示词'
})

check('有流水时注入，且带时间和用法说明', () => {
  reset({ journal: [{ at: Date.now() - 2 * HOUR, text: '番茄放多了有点酸' }] })
  const section = buildLifeSection()
  assert(section.includes('番茄放多了有点酸'), '没有带上流水内容')
  assert(/【你自己的生活/.test(section), '缺少段落标题')
  assert(/不要现编/.test(section), '缺少"不要现编"的指引')
  return `${section.length} 字`
})

check('注入内容里包含防混淆的硬规则（关键）', () => {
  /*
   * 这条是这功能最危险的副作用：它可能把流水里的事
   * 说成"你们一起经历过的"。用户会真的困惑"我什么时候去过？"
   */
  reset({ journal: [{ at: Date.now(), text: '买了杯咖啡' }] })
  const section = buildLifeSection()
  assert(/绝对不要.*共同的经历|绝对不要.*一起/.test(section), '缺少"不要说成共同经历"的硬规则')
  assert(/没见过面/.test(section), '缺少"没见过面"的说明')
  return '硬规则在'
})

check('线索会一起注入', () => {
  reset({ journal: [{ at: Date.now(), text: '改了遍图' }] })
  writeArcs([{ text: '这个月接的活老被拖尾款' }])
  const section = buildLifeSection()
  assert(section.includes('这个月接的活老被拖尾款'), '线索没有被注入')
  assert(/最近在推进/.test(section), '缺少线索段标题')
  return '已注入'
})

check('聊天提示词能接收 lifeSection', () => {
  const prompt = buildChatSystemPrompt({
    persona: '你叫天狼星',
    memory: '',
    lastExchangeAt: Date.now(),
    lifeSection: '【你自己的生活】\n- 今天 14:00 买了杯咖啡',
  })
  assert(prompt.includes('买了杯咖啡'), 'lifeSection 没有被用上')
  return '已接入'
})

check('不传 lifeSection 时提示词也正常（向后兼容）', () => {
  const prompt = buildChatSystemPrompt({ persona: 'p', memory: '', lastExchangeAt: Date.now() })
  assert(!/你自己的生活/.test(prompt), '不该出现生活段')
  assert(/【你的身份设定】/.test(prompt), '基本结构丢了')
  return '正常'
})

console.log('\n触发时机\n')

// shouldLive 需要 config，这里单独 import 避免和上面的隔离打架
const { shouldLive } = await import('../src/life.js')
const cfg = loadConfig()

check('用户刚说过话时不触发生成（关键）', () => {
  /*
   * 用户正在聊天，它却"经历"了一件事——那是打断，不是生活。
   * 这条规则如果不生效，会出现"你刚说完话它突然说刚才去买了菜"这种诡异情况。
   */
  reset({ journal: [{ at: Date.now() - 5 * HOUR, text: '旧事' }] })
  const verdict = shouldLive(cfg, { lastUserMessageAt: Date.now() - 5 * 60 * 1000 })
  assert(!verdict.ok, `不该触发，实际：${JSON.stringify(verdict)}`)
  assert(/还在说话/.test(verdict.reason), `理由不对：${verdict.reason}`)
  return verdict.reason
})

check('距上次经历太近时不触发', () => {
  reset({ journal: [{ at: Date.now() - 10 * 60 * 1000, text: '刚发生' }] })
  const verdict = shouldLive(cfg, { lastUserMessageAt: Date.now() - 10 * HOUR })
  assert(!verdict.ok, '不该触发')
  assert(/距上次经历/.test(verdict.reason), `理由不对：${verdict.reason}`)
  return verdict.reason
})

check('功能关掉时不触发', () => {
  reset({ journal: [{ at: Date.now() - 10 * HOUR, text: '旧事' }] })
  const off = { ...cfg, life: { ...cfg.life, enabled: false } }
  const verdict = shouldLive(off, { lastUserMessageAt: Date.now() - 10 * HOUR })
  assert(!verdict.ok, '关掉了还触发')
  assert(/关闭/.test(verdict.reason), `理由不对：${verdict.reason}`)
  return verdict.reason
})

check('没有设定时不触发', () => {
  reset({ withLife: false, journal: [] })
  const verdict = shouldLive(cfg, { lastUserMessageAt: Date.now() - 10 * HOUR })
  assert(!verdict.ok, '没有设定还触发')
  return verdict.reason
})

check('该触发的时候确实触发', () => {
  reset({ journal: [{ at: Date.now() - 6 * HOUR, text: '半天前的事' }] })
  // 造一个"用户很久没说话、上次经历很久以前、且不在静默时段"的时刻
  // 静默时段是 22:00-7:00，所以挑一个中午
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const verdict = shouldLive(cfg, { lastUserMessageAt: noon.getTime() - 5 * HOUR }, noon.getTime())
  // 只有当 cfg.life.enabled 为真时才应该通过
  if (!cfg.life.enabled) return '（配置里生活功能是关的，跳过）'
  assert(verdict.ok, `该触发却没触发：${verdict.reason}`)
  return '触发'
})

check('静默时段不触发（它也要睡觉）', () => {
  reset({ journal: [{ at: Date.now() - 6 * HOUR, text: '旧事' }] })
  const night = new Date()
  night.setHours(3, 0, 0, 0)
  // 静默时段是 22:00-7:00，凌晨 3 点在里面
  const verdict = shouldLive(cfg, { lastUserMessageAt: night.getTime() - 5 * HOUR }, night.getTime())
  assert(!verdict.ok, '静默时段还触发')
  assert(/静默/.test(verdict.reason), `理由不对：${verdict.reason}`)
  return verdict.reason
})

/* ------------------------------------------------------------ 收尾 */

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
