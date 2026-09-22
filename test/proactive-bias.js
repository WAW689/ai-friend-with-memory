/**
 * 主动开口倾向的抽样测试。
 *
 * 单次演练没有统计意义——同一个时间上下文跑一次，
 * 只能看到模型这一次的选择。所以这里在不同"隔了多久"的场景下各抽样多次，
 * 统计它开口的比例。
 *
 * 注意：每次抽样都会真的调用模型（有成本、也慢）。
 * 用法：node test/proactive-bias.js [每种场景的抽样次数]
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import { runProactiveCheck, proactiveGate, scheduleNextProactive } from '../src/engine.js'
import { store } from '../src/storage.js'

const SAMPLES = Number(process.argv[2] ?? 3)

/** 构造"距离上次对话已经过了 N 小时"的状态，其他条件保持不变 */
function setScenario(hoursAgo) {
  const at = Date.now() - hoursAgo * 3600 * 1000
  const state = JSON.parse(fs.readFileSync(PATHS.state, 'utf8'))

  // 只改时间相关的字段，其余（连发计数等）保持原样
  state.lastUserMessageAt = at
  state.lastAssistantMessageAt = at + 30000
  state.unansweredStreak = 0
  state.nextProactiveAt = 0 // 让硬性闸门放行，把判断权完全交给模型
  state.proactiveByDay = {}
  state.lastHoldReason = ''
  fs.writeFileSync(PATHS.state, JSON.stringify(state, null, 2) + '\n')
}

store.load()
const cfg = loadConfig()

const SCENARIOS = [
  { label: '刚聊完 30 分钟', hours: 0.5 },
  { label: '隔了 2 小时', hours: 2 },
  { label: '隔了 5 小时', hours: 5 },
  { label: '隔了 12 小时', hours: 12 },
  { label: '隔了 2 天', hours: 48 },
]

console.log(`\n主动开口倾向抽样（每个场景 ${SAMPLES} 次，仅演练不发送）\n`)
console.log(`  硬性闸门：静默时段 ${cfg.proactive.quietStart}-${cfg.proactive.quietEnd} 点，` +
  `间隔 ${cfg.proactive.minGapMinutes}-${cfg.proactive.maxGapMinutes} 分钟，` +
  `每日 ${cfg.proactive.maxPerDay} 次，连发上限 ${cfg.proactive.maxUnanswered}\n`)

const summary = []

for (const scenario of SCENARIOS) {
  const results = []
  for (let i = 0; i < SAMPLES; i++) {
    setScenario(scenario.hours)
    store.load()
    // dry 模式会跳过硬性闸门，只保留模型的判断
    const result = await runProactiveCheck({ dryRun: true })
    results.push(result)
  }

  const sent = results.filter((r) => r.dryRun && (r.wouldSend?.length ?? 0) > 0)
  const held = results.filter((r) => !r.dryRun || (r.wouldSend?.length ?? 0) === 0)
  const rate = Math.round((sent.length / results.length) * 100)
  summary.push({ scenario: scenario.label, rate, sent: sent.length, total: results.length })

  console.log(`  ${scenario.label}：愿意开口 ${sent.length}/${results.length}（${rate}%）`)
  for (const s of sent.slice(0, 2)) {
    console.log(`      → ${s.wouldSend.join(' ／ ')}`)
  }
  for (const h of held.slice(0, 2)) {
    console.log(`      ✗ ${h.reason ?? '(未说明)'}`)
  }
  console.log('')
}

/* ------------------------------------------------------------ 汇总 */

console.log('汇总\n')
for (const row of summary) {
  const bar = '█'.repeat(Math.round(row.rate / 10)).padEnd(10, '·')
  console.log(`  ${row.scenario.padEnd(18)} ${bar} ${String(row.rate).padStart(3)}%`)
}

// 期望的形状：隔得越久越愿意开口
const short = summary[0].rate
const long = summary[summary.length - 1].rate
console.log('')
if (long > short) {
  console.log(`  ✓ 倾向合理：隔得越久越愿意开口（${short}% → ${long}%）`)
} else {
  console.log(`  ✗ 倾向异常：隔久了反而不愿意开口（${short}% → ${long}%）`)
}

// 一个"朋友感"的参考区间：隔 5 小时以上应该大多愿意开口
const midLong = summary.filter((s) => /5 小时|12 小时|2 天/.test(s.scenario))
const avgLong = Math.round(midLong.reduce((a, b) => a + b.rate, 0) / midLong.length)
console.log(`  隔 5 小时以上的平均开口率：${avgLong}%`)
if (avgLong < 50) {
  console.log('  ⚠ 偏保守：隔了这么久还不愿意开口，会显得冷淡')
} else if (avgLong > 95) {
  console.log('  ⚠ 偏激进：几乎每次都发，可能显得黏人')
} else {
  console.log('  ✓ 落在"愿意开口但不黏人"的区间')
}
console.log('')
