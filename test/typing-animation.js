/**
 * 逐字显示算法的模拟测试。
 *
 * 目的：验证"收到 done 时还剩多少字没显示"。
 * 这个数字就是用户看到的"突然跳出一大段"的量——越接近 0 越好。
 *
 * 用服务端实测过的真实节奏来跑，而不是假设一个理想的流。
 * 用法：node test/typing-animation.js
 */
import { renderTranscript } from '../src/prompts.js'

/* ------------------------------------------------ 复刻前端算法（保持同步） */

const TYPING_CATCH_UP_MIN_MS = 60
const TYPING_CATCH_UP_MAX_MS = 150
const TYPING_MIN_LEAD = 2
const TYPING_DEFAULT_MS_PER_CHAR = 4

function createTyping() {
  return {
    target: '',
    shown: 0,
    msPerChar: TYPING_DEFAULT_MS_PER_CHAR,
    observedChars: 0,
    lastFrame: 0,
    frames: 0,
  }
}

function feed(state, full, elapsedMs) {
  const previousLen = state.target.length
  state.target = full
  const grew = full.length - previousLen
  if (elapsedMs > 0 && grew > 0) {
    state.observedChars += grew
    if (state.observedChars >= 12) {
      const sample = elapsedMs / grew
      state.msPerChar = state.msPerChar * 0.7 + sample * 0.3
    }
  }
}

function tick(state, now, elapsed) {
  state.frames++
  const targetLen = state.target.length
  if (state.shown >= targetLen) return
  const remainingChars = targetLen - state.shown
  const remainMs = state.msPerChar * remainingChars

  // 自适应追平阈值（与前端保持一致）
  const progress = targetLen === 0 ? 1 : state.shown / targetLen
  const catchUpMs = TYPING_CATCH_UP_MIN_MS + (TYPING_CATCH_UP_MAX_MS - TYPING_CATCH_UP_MIN_MS) * progress

  let step
  if (remainMs <= catchUpMs) {
    step = remainingChars
  } else {
    step = Math.ceil((remainingChars * Math.max(elapsed, 32)) / remainMs)
    step = Math.max(1, Math.min(step, remainingChars))
    if (state.shown === 0) step = Math.max(step, Math.min(TYPING_MIN_LEAD, remainingChars))
  }
  state.shown = Math.min(targetLen, state.shown + step)
}

/**
 * 跑一次模拟。
 * @param {Array<{at:number, len:number}>} chunks 每个增量：到达时刻 + 累计字符数
 * @param {number} frameMs 帧间隔
 * @param {number} doneAfterLastMs 最后一包到 done 之间的间隔（真实协议里 done 总在后面）
 */
function simulate(chunks, frameMs = 16.7, doneAfterLastMs = 40) {
  const state = createTyping()
  const lastChunkAt = chunks.length ? chunks[chunks.length - 1].at : 0
  const endAt = lastChunkAt + doneAfterLastMs

  let chunkIndex = 0
  let previousChunkAt = 0
  let now = 0
  let lastFrame = 0
  let ticks = 0
  /** 第一次显示出内容的时刻，用来判断"开头干等了多久" */
  let firstShownAt = 0
  const firstChunkAt = chunks.length ? chunks[0].at : 0

  while (now <= endAt + 2000) {
    while (chunkIndex < chunks.length && chunks[chunkIndex].at <= now) {
      const chunk = chunks[chunkIndex]
      feed(state, 'x'.repeat(chunk.len), chunk.at - previousChunkAt)
      previousChunkAt = chunk.at
      chunkIndex++
    }

    if (now >= endAt) break

    if (lastFrame !== 0) tick(state, now, now - lastFrame)
    if (!firstShownAt && state.shown > 0) firstShownAt = now
    lastFrame = now
    ticks++
    now += frameMs
  }

  const atDone = state.shown
  const total = chunks.length ? chunks[chunks.length - 1].len : 0

  // done 之后再跑，测"剩余部分多久补完"
  let afterDone = atDone
  let finishAt = total === 0 || atDone >= total ? now : 0
  while (afterDone < total && now < endAt + 2000) {
    if (lastFrame !== 0) tick(state, now, now - lastFrame)
    lastFrame = now
    afterDone = state.shown
    now += frameMs
    ticks++
    if (!finishAt && afterDone >= total) finishAt = now
  }

  return {
    total,
    atDone,
    backlogAtDone: total - atDone,
    /** done 之后把剩余内容补完花了多久 */
    finishAfterDoneMs: finishAt ? Math.max(0, finishAt - endAt) : 0,
    /** 第一包到达后，多久看到第一个字 —— 这才是动画本身的响应速度 */
    firstShownAfterChunkMs: firstShownAt ? Math.max(0, firstShownAt - firstChunkAt) : 0,
    framesToFinish: ticks,
  }
}

/* ------------------------------------------------ 构造几组真实节奏 */

/** 按服务端实测的节奏造增量：平均每个包 1.4 字符 */
function chunksFromRealShape(totalChars, durationMs, chunkChars = 1.4) {
  const chunkCount = Math.max(1, Math.round(totalChars / chunkChars))
  const step = durationMs / chunkCount
  const chunks = []
  let len = 0
  for (let i = 1; i <= chunkCount; i++) {
    len = Math.round((totalChars * i) / chunkCount)
    chunks.push({ at: Math.round(step * i), len })
  }
  return chunks
}

const SCENARIOS = [
  { name: '短回复（18 字，实测节奏）', chunks: chunksFromRealShape(18, 250) },
  { name: '典型回复（64 字，实测节奏）', chunks: chunksFromRealShape(64, 370) },
  { name: '长回复（200 字，1.2 秒）', chunks: chunksFromRealShape(200, 1200) },
  { name: '一次性到达（80 字全在首包）', chunks: [{ at: 30, len: 80 }] },
  { name: '两包到达（40 + 40）', chunks: [{ at: 200, len: 40 }, { at: 420, len: 80 }] },
  { name: '极慢的流（120 字，5 秒）', chunks: chunksFromRealShape(120, 5000) },
  { name: '超短（4 字）', chunks: chunksFromRealShape(4, 120, 1) },
]

console.log('\n逐字显示算法模拟\n')

let pass = 0
let fail = 0

for (const scenario of SCENARIOS) {
  const result = simulate(scenario.chunks)
  /*
   * 判据用两个时间指标，而不是"积压多少字"。
   * 积压字数本身没有意义：80 字里只剩 20 字没显示，和 8 字里只剩 2 字没显示，
   * 观感完全不同。真正决定观感的是"补完要多久"。
   */
  const finishOk = result.finishAfterDoneMs <= 200
  const latencyOk = result.firstShownAfterChunkMs <= 120
  const ok = finishOk && latencyOk
  if (ok) pass++
  else fail++

  console.log(`  ${ok ? '✓' : '✗'} ${scenario.name}`)
  console.log(
    `      共 ${result.total} 字；首包后 ${result.firstShownAfterChunkMs.toFixed(0)}ms 出现首字；` +
      `done 时已显示 ${result.atDone} 字；剩余补完 ${result.finishAfterDoneMs.toFixed(0)}ms`,
  )
  if (!finishOk) console.log(`      ✗ 收尾超过 200ms，会看到"剩下的一段突然补齐"`)
  if (!latencyOk) console.log(`      ✗ 首字延迟超过 120ms，会感觉内容到了却不显示`)
}

/* ------------------------------------------------ 关键性质检查 */

console.log('\n性质检查\n')

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

check('首帧不是空的（不会先蹦出 0 个字）', () => {
  const state = createTyping()
  feed(state, '一二三四五六七八九十', 50)
  tick(state, 16, 16)
  assert(state.shown >= TYPING_MIN_LEAD, `首帧只显示了 ${state.shown} 个字`)
  return `首帧显示 ${state.shown} 个字`
})

check('所有内容一次到达时会快速追上而不是慢慢爬', () => {
  const state = createTyping()
  feed(state, '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸', 30)
  // 模拟 10 帧（约 160ms）
  let elapsed = 16
  for (let i = 0; i < 10; i++) tick(state, elapsed, 16)
  assert(state.shown === state.target.length, `10 帧后还剩 ${state.target.length - state.shown} 字没显示`)
  return `160ms 内全部显示完`
})

check('文字永远是目标的前缀（不会乱序或跳字）', () => {
  const state = createTyping()
  const text = '这是一段用来验证前缀性质的文字内容'
  const seen = []
  for (let i = 1; i <= text.length; i += 3) {
    feed(state, text.slice(0, i), 20)
    tick(state, 16 * i, 16)
    seen.push(state.shown)
  }
  // 显示量必须单调不减，且不超过已到达的长度
  for (let i = 1; i < seen.length; i++) {
    assert(seen[i] >= seen[i - 1], `显示量倒退了：${seen[i - 1]} → ${seen[i]}`)
  }
  assert(Math.max(...seen) <= text.length, '显示量超过了内容长度')
  return `单调递增，最大 ${Math.max(...seen)}`
})

check('慢流不会提前把没到的内容显示出来', () => {
  const state = createTyping()
  feed(state, '前四个字', 500)
  tick(state, 16, 16)
  assert(state.shown <= '前四个字'.length, `显示了不存在的字符：${state.shown}`)
  return `已到 ${state.target.length} 字，显示 ${state.shown} 字`
})

check('实测流速被正确采样（每包字符少时不采信噪声）', () => {
  const state = createTyping()
  // 每包只涨 1 个字，样本量不够，不该被采信
  feed(state, '一', 100)
  assert(state.observedChars === 1, '样本计数不对')
  assert(state.msPerChar === TYPING_DEFAULT_MS_PER_CHAR, '样本不足时不该改变流速估计')
  // 攒够样本后应采信
  for (let i = 2; i <= 20; i++) feed(state, 'x'.repeat(i), 10)
  assert(state.observedChars >= 12, '样本没攒够')
  assert(state.msPerChar !== TYPING_DEFAULT_MS_PER_CHAR, '样本足够后应该更新估计')
  return `估计 ${state.msPerChar.toFixed(2)} ms/字`
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
