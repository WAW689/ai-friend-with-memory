/**
 * 她的成长（会变的自我）的测试。
 *
 * 这个功能最容易出的四类问题：
 *
 * 1. **改了声音**。她"变温柔了""话变多了"——那是 persona.md 的地盘。
 *    这是最危险的：漂移是渐进的，你只会觉得"她怎么变了"，查不出哪一步变的。
 * 2. **一次换一个人**。模型重写整篇而不是增量修订，一轮下来面目全非。
 * 3. **为了改而改**。明明没什么事发生，它硬要产出点变化，几天就写满废话。
 * 4. **改坏了回不去**。没有快照/回退，长歪了只能整份重写。
 *
 * 用法：node test/self.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import {
  buildSelfSection,
  hasSelf,
  listSnapshots,
  readSelf,
  readSelfChanges,
  readSnapshot,
  renderExperiences,
  replaceSelf,
  restoreSelf,
  snapshotSelf,
  stripVoiceLines,
  writeSelf,
} from '../src/self.js'
import { buildSelfUpdatePrompt } from '../src/prompts.js'
import { journalSince } from '../src/life.js'

const SELF_FILE = PATHS.self
const SNAP_DIR = PATHS.selfSnapshots
const CHANGELOG = PATHS.selfChangelog

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

/** 每条检查前重置成干净状态 */
function reset(text = '') {
  fs.mkdirSync(path.dirname(SELF_FILE), { recursive: true })
  fs.writeFileSync(SELF_FILE, text, 'utf8')
  fs.rmSync(SNAP_DIR, { recursive: true, force: true })
  fs.rmSync(CHANGELOG, { force: true })
}

const SAMPLE = `# 我对自己的一些想法

## 我最近发现的事
- 发现自己其实挺怕接电话的

## 我现在的看法
- 接活虽然烦，但比上班自由，暂时不想改

## 我最近的样子
- 最近老想着要不要换个地方住
`

console.log('\n自我文件\n')

check('空文件算"没有自我"', () => {
  reset('')
  assert(!hasSelf(), '空文件却判为有自我')
  return '已识别'
})

check('有内容算"有自我"', () => {
  reset(SAMPLE)
  assert(hasSelf(), '有内容却判为没有')
  return `${readSelf().replace(/\s/g, '').length} 字`
})

check('只有标题没有条目，不算有自我', () => {
  // 出厂模板就是这样：结构在，内容是空的
  reset('# 我对自己的一些想法\n\n## 我最近发现的事\n\n## 我现在的看法\n\n## 我最近的样子\n')
  assert(!hasSelf(), '只有标题却判为有自我——出厂模板会导致一上线就注入空段落')
  return '已识别'
})

check('出厂模板（标题 + 括号说明）也不算有自我', () => {
  /*
   * 这条抓的是一个真踩过的坑：模板里那句
   * "（这些是我自己慢慢想明白的，不是谁给我定的。会变。）"
   * 以「（」开头，之前被当成"一个条目"算进内容里，
   * 于是 hasSelf() 立刻为真，聊天里注入一段只有标题的空段落。
   */
  reset(
    '# 我对自己的一些想法\n\n' +
      '（这些是我自己慢慢想明白的，不是谁给我定的。会变。）\n\n' +
      '## 我最近发现的事\n\n## 我现在的看法\n\n## 我最近的样子\n',
  )
  assert(!hasSelf(), '括号说明被当成内容了——出厂模板会被误判为"有自我"')
  assert(buildSelfSection() === '', '模板状态就注入了空段落')
  return '已识别'
})

console.log('\n防漂移：不许改声音（关键）\n')

check('删掉"话变多"这类条目', () => {
  /*
   * 这条是整个功能最重要的一道闸。
   * 一旦"话比以前多了一点"被写进设定，它会自我强化，几周后她的声音就变了。
   */
  const bad = `# 我对自己的一些想法

## 我最近发现的事
- 发现自己其实挺怕接电话的
- 我最近好像话比以前多了一点
- 愿意多说两句了`
  const { text, dropped } = stripVoiceLines(bad)
  assert(dropped.length === 2, `应该删掉 2 行，实际删了 ${dropped.length} 行`)
  assert(!/话比以前多/.test(text), '越界内容没有被删掉')
  assert(/怕接电话/.test(text), '正常内容被误删了')
  return `删掉 ${dropped.length} 行`
})

check('删掉"变得更温柔/更会安慰人"这类方向', () => {
  const bad = `## 我最近的样子
- 最近变得更温柔了
- 好像更会安慰人了
- 觉得自己更主动了一点`
  const { text, dropped } = stripVoiceLines(bad)
  assert(dropped.length === 3, `应该删掉 3 行，实际 ${dropped.length}`)
  assert(!/温柔|安慰|主动/.test(text), '越界内容残留')
  return `删掉 ${dropped.length} 行`
})

check('删掉"说话方式/回复长度"这类描述', () => {
  const bad = `## 我最近发现的事
- 我的说话方式好像变了
- 回复的长度比以前短
- 发现自己挺在意别人怎么看我`
  const { text, dropped } = stripVoiceLines(bad)
  assert(dropped.length === 2, `应该删掉 2 行，实际 ${dropped.length}`)
  assert(/在意别人怎么看/.test(text), '正常内容被误删')
  return `删掉 ${dropped.length} 行`
})

check('保留正常内容（不误删）', () => {
  const good = `# 我对自己的一些想法

## 我最近发现的事
- 发现自己其实挺怕接电话的
- 原来我不太能接受别人对我失望

## 我现在的看法
- 接活虽然烦，但比上班自由

## 我最近的样子
- 最近老想着要不要换个地方住`
  const { text, dropped } = stripVoiceLines(good)
  assert(dropped.length === 0, `误删了 ${dropped.length} 行：${dropped.join(' / ')}`)
  assert(text.trim() === good.trim(), '内容被改动了')
  return '0 行误删'
})

check('标题永远保留', () => {
  const { text } = stripVoiceLines('## 我现在的看法\n- 一条正常内容')
  assert(/## 我现在的看法/.test(text), '标题被删了')
  return '标题在'
})

console.log('\n快照与回退\n')

check('改之前能存快照', () => {
  reset(SAMPLE)
  const file = snapshotSelf(Date.now(), 'test')
  assert(file && fs.existsSync(file), '快照文件没写出来')
  assert(fs.readFileSync(file, 'utf8') === SAMPLE, '快照内容不对')
  return path.basename(file)
})

check('空内容不产生快照（没意义）', () => {
  reset('')
  assert(snapshotSelf() === null, '空文件也存了快照')
  return '已跳过'
})

check('同一秒多次快照不会互相覆盖', () => {
  reset(SAMPLE)
  const at = Date.now()
  const a = snapshotSelf(at, 'x')
  const b = snapshotSelf(at, 'x')
  const c = snapshotSelf(at, 'x')
  assert(a !== b && b !== c, '快照被覆盖了')
  assert(listSnapshots().length === 3, `应该有 3 份，实际 ${listSnapshots().length}`)
  return '3 份独立'
})

check('能回退到上一版', () => {
  reset(SAMPLE)
  replaceSelf('# 改坏了\n\n## 我最近发现的事\n- 一条错的内容')
  assert(readSelf().includes('改坏了'), '替换没生效')

  const r = restoreSelf()
  assert(r.updated, '回退失败：' + r.reason)
  assert(readSelf().trim() === SAMPLE.trim(), '回退后内容不对')
  return '已还原'
})

check('回退本身也存快照（否则退错了就回不来）', () => {
  reset(SAMPLE)
  replaceSelf('# 第二版\n\n## 我最近的样子\n- 换了个内容')
  const beforeCount = listSnapshots().length
  restoreSelf()
  assert(listSnapshots().length > beforeCount, '回退没有留下快照')
  return `${beforeCount} → ${listSnapshots().length} 份`
})

check('没有快照时回退不报错，只是不做事', () => {
  reset(SAMPLE)
  const r = restoreSelf()
  assert(!r.updated, '没有快照却回退了')
  assert(readSelf().trim() === SAMPLE.trim(), '内容被改动了')
  return r.reason
})

check('快照名不能穿越目录', () => {
  reset(SAMPLE)
  snapshotSelf()
  const evil = readSnapshot('../../../config.json')
  assert(evil === '', '目录穿越没有被拦住')
  return '已拦住'
})

console.log('\n变更流水\n')

check('手动改会记一笔', () => {
  reset(SAMPLE)
  replaceSelf('# 新的\n\n## 我最近发现的事\n- 新的一条')
  const changes = readSelfChanges()
  assert(changes.length === 1, `应该有 1 条，实际 ${changes.length}`)
  assert(changes[0].reason === '手动编辑', '原因不对：' + changes[0].reason)
  return changes[0].reason
})

check('流水里带"改了什么"的差异，而不是整份内容', () => {
  reset(SAMPLE)
  replaceSelf('# 新的\n\n## 我最近发现的事\n- 新的一条')
  const c = readSelfChanges()[0]
  assert(Array.isArray(c.added), '没有 added 字段')
  assert(Array.isArray(c.removed), '没有 removed 字段')
  assert(c.added.includes('新的一条'), 'added 里没有新内容')
  assert(c.removed.length > 0, 'removed 是空的（旧内容应该被记为删除）')
  return `+${c.added.length} / -${c.removed.length}`
})

check('内容没变就不记流水', () => {
  reset(SAMPLE)
  const r = replaceSelf(SAMPLE)
  assert(!r.updated, '没变却算更新了')
  assert(readSelfChanges().length === 0, '没变却记了流水')
  return r.reason
})

console.log('\n注入聊天\n')

check('有自我时注入，且带用法说明', () => {
  reset(SAMPLE)
  const s = buildSelfSection()
  assert(s.includes('怕接电话'), '没有带上自我内容')
  assert(/【你最近对自己的一些想法/.test(s), '缺少段落标题')
  assert(/不是拿来念的台词/.test(s), '缺少"别当台词念"的指引')
  return `${s.length} 字`
})

check('没有自我时整段不注入', () => {
  reset('# 我对自己的一些想法\n\n## 我最近发现的事\n')
  assert(buildSelfSection() === '', '只有标题却注入了')
  return '空串'
})

check('出厂模板状态下不注入（新装实例第一句话不能带空段落）', () => {
  reset(
    '# 我对自己的一些想法\n\n' +
      '（这些是我自己慢慢想明白的，不是谁给我定的。会变。）\n\n' +
      '## 我最近发现的事\n\n## 我现在的看法\n\n## 我最近的样子\n',
  )
  assert(buildSelfSection() === '', '出厂模板被注入了')
  return '空串'
})

check('注入内容里有防编造的硬规则', () => {
  reset(SAMPLE)
  const s = buildSelfSection()
  assert(/没见过面/.test(s), '缺少"没见过面"的硬边界')
  assert(/不要.*编造/.test(s), '缺少"不要编造"的约束')
  return '有'
})

console.log('\n经历渲染（成长由经历触发）\n')

check('带相对时间，而不是日期', () => {
  const at = Date.now()
  const H = 3600 * 1000
  const out = renderExperiences(
    [
      { at: at - 2 * H, text: '刚发生的事' },
      { at: at - 30 * H, text: '昨天的事' },
      { at: at - 4 * 24 * H, text: '四天前的事' },
    ],
    at,
  )
  assert(/2 小时前/.test(out), '缺小时级相对时间：' + out)
  assert(/昨天/.test(out), '缺"昨天"：' + out)
  assert(/4 天前/.test(out), '缺"N 天前"：' + out)
  return out.split('\n').length + ' 条'
})

check('空数组返回空串', () => {
  assert(renderExperiences([], Date.now()) === '', '空数组没返回空串')
  assert(renderExperiences(undefined, Date.now()) === '', 'undefined 没返回空串')
  return '空串'
})

check('坏数据不会让它崩', () => {
  const out = renderExperiences([null, {}, { at: 'x', text: 'y' }, { at: Date.now(), text: '好的' }], Date.now())
  assert(out.includes('好的'), '正常条目被跳过了')
  assert(out.split('\n').length === 1, '坏数据没有被过滤：' + out)
  return '已过滤'
})

check('journalSince 只返回某时刻之后的经历', () => {
  const journal = PATHS.journal
  fs.mkdirSync(path.dirname(journal), { recursive: true })
  const base = Date.now() - 10 * 3600 * 1000
  fs.writeFileSync(
    journal,
    [
      { at: base, text: '旧的' },
      { at: base + 3600 * 1000, text: '中间的' },
      { at: base + 5 * 3600 * 1000, text: '新的' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
    'utf8',
  )
  const got = journalSince(base + 2 * 3600 * 1000)
  assert(got.length === 1, `应该只有 1 条，实际 ${got.length}`)
  assert(got[0].text === '新的', '取错了条目：' + got[0].text)
  return '1 条'
})

console.log('\n提示词约束\n')

check('更新提示词里，说话方式被列为不许改', () => {
  const msgs = buildSelfUpdatePrompt({ currentSelf: SAMPLE, transcript: '（无）', experiences: '- 昨天：接了个活' })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/说话方式/.test(text), '没有提到"说话方式"')
  assert(/话比以前多/.test(text), '没有明确禁止"话变多"这类条目')
  assert(/一个字都不许写进/.test(text), '禁止语气不够强')
  return '有'
})

check('更新提示词明确允许"什么都不改"（防为了改而改）', () => {
  const msgs = buildSelfUpdatePrompt({ currentSelf: SAMPLE, transcript: '（无）', experiences: '- 昨天：接了个活' })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/一字不改地返回/.test(text), '没有允许原样返回')
  assert(/不要为了显得有产出而硬加条目/.test(text), '没有禁止"为了改而改"')
  assert(/正常的结果，不是失败/.test(text), '没有说明"不改"是正常结果')
  return '有'
})

check('更新提示词要求增量修订、限制行数', () => {
  const msgs = buildSelfUpdatePrompt({ currentSelf: SAMPLE, transcript: '（无）', experiences: '- 昨天：接了个活' })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/最多动 3 行/.test(text), '没有限制改动行数')
  assert(/不要重写整篇/.test(text), '没有禁止整篇重写')
  return '有'
})

check('更新提示词里带上了经历和对话', () => {
  const msgs = buildSelfUpdatePrompt({
    currentSelf: SAMPLE,
    transcript: '对方说：你最近怎么样',
    experiences: '- 昨天：接了新活',
  })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/接了新活/.test(text), '经历没进提示词——那就退回"按时间成长"了')
  assert(/你最近怎么样/.test(text), '对话没进提示词')
  return '都在'
})

check('行为和对话都为空时，提示词也说清楚', () => {
  const msgs = buildSelfUpdatePrompt({ currentSelf: SAMPLE, transcript: '', experiences: '' })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/这段时间她没记下什么/.test(text), '缺"没有经历"的说明')
  assert(/这段时间没聊什么/.test(text), '缺"没聊什么"的说明')
  return '有'
})

console.log('\n配置语义（按经历，不按时间）\n')

check('成长参数按"经历"命名，没有按时间的字段', () => {
  const cfg = loadConfig()
  assert(cfg.self.evolveAfterExperiences > 0, '缺 evolveAfterExperiences')
  assert(cfg.self.evolveAfterMessages > 0, '缺 evolveAfterMessages')
  assert(
    cfg.self.evolveEveryMessages === undefined && cfg.self.minIntervalMs === undefined,
    '旧的"按时间/按条数"字段还在，语义会混',
  )
  return `${cfg.self.evolveAfterExperiences} 段经历 / ${cfg.self.evolveAfterMessages} 条消息`
})

check('防抖间隔存在，但不叫"成长间隔"', () => {
  const cfg = loadConfig()
  assert(cfg.self.minCheckIntervalMs > 0, '缺防抖间隔')
  assert(cfg.self.minCheckIntervalMs <= 60 * 60 * 1000, '防抖间隔太长（超过 1 小时就不像防抖了）')
  return `${cfg.self.minCheckIntervalMs / 60000} 分钟`
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
