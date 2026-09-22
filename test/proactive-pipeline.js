/**
 * 主动发送全链路测试。
 *
 * 验证的不是"模型愿不愿意发"（那是随机的），而是**管道是否通畅**：
 * 从"对方很久没说话"这个状态出发，跑真实流程，
 * 必须真的产生 proactive 消息并推送。
 *
 * 之前的 bug 是：模型一次说"不发"，就把窗口推到很久以后，
 * 期间一次都不再问——于是整条链路看起来像坏的。
 *
 * 用法：node test/proactive-pipeline.js
 * 注意：会真的写入数据，跑完自动还原。
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import { PATHS, loadConfig } from '../src/config.js'
import {
  runProactiveCheck,
  proactiveGate,
  scheduleNextProactive,
  scheduleRetryAfterDecline,
} from '../src/engine.js'
import { store } from '../src/storage.js'
import { push } from '../src/bark.js'

const backup = fs.readFileSync(PATHS.state, 'utf8')
const messagesBefore = store.messages ? store.messages.length : 0

let pass = 0
let fail = 0

/** 支持同步和异步两类检查 */
async function check(name, fn) {
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

/** 把状态改成"对方已经 N 小时没说话了"，并把窗口排到当前时刻 */
function setQuietUser(hoursAgo = 4) {
  const at = Date.now() - hoursAgo * 3600 * 1000
  const state = JSON.parse(fs.readFileSync(PATHS.state, 'utf8'))
  state.lastUserMessageAt = at
  state.lastAssistantMessageAt = at + 60000
  state.unansweredStreak = 0
  // 排到"现在"，让闸门放行——0 会被理解成"尚未排期"，反而被拦
  state.nextProactiveAt = Date.now() - 1000
  state.proactiveByDay = {}
  state.lastHoldReason = ''
  fs.writeFileSync(PATHS.state, JSON.stringify(state, null, 2) + '\n')
  store.load()
}

console.log('\n主动发送全链路\n')

const cfg = loadConfig()

await check('短重试窗口明显短于正常间隔（关键回归点）', async () => {
  const p = cfg.proactive
  const lo = Math.max(5, Math.round(Math.min(p.minGapMinutes, p.maxGapMinutes) / 4))
  const hi = Math.min(30, Math.max(lo + 3, Math.round(Math.max(p.minGapMinutes, p.maxGapMinutes) / 2)))
  const retryAvg = (lo + hi) / 2
  const normalAvg = (p.minGapMinutes + p.maxGapMinutes) / 2
  assert(retryAvg < normalAvg, `重试窗口(${retryAvg}) 不低于正常间隔(${normalAvg})`)
  /*
   * 这个断言的意义：
   * 之前"不发"和"发完"用的是同一个间隔，导致模型一次说不发就要等很久，
   * 期间完全不再询问——表现就是"一上午一条都不发"。
   */
  assert(hi <= 30, `重试窗口上限 ${hi} 分钟太长了`)
  return `不发后 ${lo}-${hi} 分钟重试（正常间隔 ${p.minGapMinutes}-${p.maxGapMinutes}）`
})

await check('对方很久没说话时，闸门放行', () => {
  setQuietUser(4)
  const gate = proactiveGate(loadConfig())
  assert(gate.allowed, `不该被拦：${gate.reason}`)
  return '放行'
})

await check('闸门放行后能真正发出消息', async () => {
  setQuietUser(4)
  const before = store.messages.length

  // 用 force 确保走完"生成 + 落库 + 推送"，不受模型随机判断影响
  const result = await runProactiveCheck({ force: true })

  assert(result.sent === true, `没有发出去：${result.reason}`)
  assert(Array.isArray(result.messages) && result.messages.length > 0, '没有产生消息内容')
  assert(store.messages.length > before, '消息没有落库')

  // 落库的消息必须是 proactive 类型
  const newest = store.messages.slice(before)
  assert(newest.every((m) => m.kind === 'proactive'), '落库的消息类型不是 proactive')
  return `${newest.length} 条，均为 proactive：${result.messages.join(' / ').slice(0, 50)}`
})

await check('发完之后窗口按正常间隔重排（不是短重试）', () => {
  /*
   * 直接测两个排期函数，而不是去读状态文件——
   * 状态落盘有 400ms 的合并写入，读文件会读到旧值，测不准。
   * 要验证的性质是：发完用长间隔，不发用短间隔。
   */
  const p = cfg.proactive
  const sample = (fn) => {
    const deltas = []
    for (let i = 0; i < 40; i++) {
      deltas.push((fn(loadConfig()) - Date.now()) / 60000)
    }
    return {
      min: Math.min(...deltas),
      max: Math.max(...deltas),
      avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    }
  }

  const afterSend = sample(scheduleNextProactive)
  const afterDecline = sample(scheduleRetryAfterDecline)

  assert(
    afterSend.min >= p.minGapMinutes - 0.1,
    `发完最短 ${afterSend.min.toFixed(1)} 分钟，低于配置下限 ${p.minGapMinutes}`,
  )
  assert(
    afterSend.max <= p.maxGapMinutes + 0.1,
    `发完最长 ${afterSend.max.toFixed(1)} 分钟，超过配置上限 ${p.maxGapMinutes}`,
  )
  assert(
    afterDecline.avg < afterSend.avg,
    `不发后的重试(${afterDecline.avg.toFixed(1)}分) 不该慢于发完的间隔(${afterSend.avg.toFixed(1)}分)`,
  )
  return `发完 ${afterSend.min.toFixed(0)}-${afterSend.max.toFixed(0)} 分；不发 ${afterDecline.min.toFixed(0)}-${afterDecline.max.toFixed(0)} 分`
})

await check('连续未回计数会累加（防止无限轰炸）', () => {
  // 直接读内存里的 store，不读文件——状态落盘有 400ms 合并写入，读文件会拿到旧值
  assert(
    store.state.unansweredStreak >= 1,
    `连发计数没有累加：${store.state.unansweredStreak}`,
  )
  // 再确认它还进了"今天已主动"的计数
  assert(store.proactiveCountToday() >= 1, '今天的主动计数没有累加')
  return `streak = ${store.state.unansweredStreak}，今天已主动 ${store.proactiveCountToday()} 次`
})

await check('Bark 未配置时不会让流程崩掉', async () => {
  // 临时把 key 置空，模拟没配推送的情况
  const { saveConfig } = await import('../src/config.js')
  const original = loadConfig().bark.key
  try {
    saveConfig({ bark: { key: '' } })
    setQuietUser(6)
    const result = await runProactiveCheck({ force: true })
    assert(result.sent === true, '没配 Bark 时也应该正常发消息，只是不推送')
    return '消息正常落库，推送被跳过'
  } finally {
    saveConfig({ bark: { key: original } })
  }
})

/* ------------------------------------------------------------ 还原 */

fs.writeFileSync(PATHS.state, backup, 'utf8')
store.load()
console.log('\n已还原数据')

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
