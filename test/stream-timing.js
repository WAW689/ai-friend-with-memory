/**
 * 量一下服务端流式输出的实际节奏。
 * 如果文字是攒成一大块发过来的，前端无论怎么做动画都会显得"突然跳出"。
 *
 * 用法：node test/stream-timing.js <token> "测试内容"
 */
const token = process.argv[2]
const text = process.argv[3] ?? '随便聊两句，看看你打字快不快'

if (!token) {
  console.error('用法：node test/stream-timing.js <token> "内容"')
  process.exit(1)
}

const started = Date.now()
const res = await fetch('http://127.0.0.1:8787/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ text }),
})

if (!res.ok || !res.body) {
  console.error('请求失败', res.status)
  process.exit(1)
}

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let deltas = 0
let lastLen = 0
let firstAt = 0
const events = []

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })

  let idx
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 2)

    const eventMatch = raw.match(/^event:\s*(.+)$/m)
    const dataMatch = raw.match(/^data:\s*(.+)$/m)
    if (!eventMatch || !dataMatch) continue
    const type = eventMatch[1].trim()
    let payload
    try {
      payload = JSON.parse(dataMatch[1])
    } catch {
      continue
    }
    if (type !== 'delta') continue

    deltas++
    const at = Date.now() - started
    if (!firstAt) firstAt = at
    const grew = payload.full.length - lastLen
    lastLen = payload.full.length
    events.push({ at, grew, total: payload.full.length })
  }
}

const total = lastLen
console.log('')
console.log(`总字符数      ${total}`)
console.log(`增量包数      ${deltas}`)
console.log(`首字节到达    ${firstAt} ms`)
console.log(`全部结束      ${Date.now() - started} ms`)
console.log('')

if (events.length > 0) {
  console.log('前 15 个增量的节奏：')
  for (const e of events.slice(0, 15)) {
    console.log(`  ${String(e.at).padStart(6)} ms   本包 +${String(e.grew).padStart(3)} 字符   累计 ${e.total}`)
  }
  const sizes = events.map((e) => e.grew)
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length
  console.log('')
  console.log(`平均每包      ${avg.toFixed(1)} 字符`)
  console.log(`最大单包      ${Math.max(...sizes)} 字符`)
  console.log('')
  if (avg > 8) {
    console.log('⚠ 每包字符数偏大：说明模型是攒一批才发，前端逐字动画会比较吃力。')
  } else {
    console.log('✓ 增量粒度正常，逐字动画有条件做得平滑。')
  }
}
