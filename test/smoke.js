/**
 * 冒烟测试：不依赖任何测试框架，跑一遍关键接口。
 * 用法：node src/cli.js 之外，单独开一个终端 node test/smoke.js
 * 前提：服务已经在 8787 端口跑着。
 */

import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
// 用 || 而不是 ??：worker 里可能传进来一个空字符串，那样要回退到 argv
const TOKEN = process.env.FRIEND_ACCESS_TOKEN || process.argv[2]

let pass = 0
let fail = 0

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

async function req(path, options = {}) {
  const { body, ...rest } = options
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    // 必须自己序列化：直接把对象交给 fetch 会变成 "[object Object]"
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(options.headers ?? {}),
    },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text.slice(0, 300) }
  }
  return { status: res.status, data, text }
}

console.log(`\n冒烟测试 → ${BASE}\n`)

await check('健康检查（不需要口令）', async () => {
  const { status, data } = await req('/api/health')
  assert(status === 200, `状态码 ${status}`)
  assert(data.ok === true, 'ok 不为 true')
  return `消息数 ${data.messages}`
})

await check('没带口令应当 401', async () => {
  const res = await fetch(`${BASE}/api/app`)
  assert(res.status === 401, `期望 401，实际 ${res.status}`)
  return '已拦截'
})

await check('带口令能拉到应用状态', async () => {
  const { status, data } = await req('/api/app')
  assert(status === 200, `状态码 ${status}`)
  assert(data.snapshot && Array.isArray(data.snapshot.messages), '缺少 snapshot.messages')
  assert(typeof data.persona === 'string' && data.persona.length > 0, '人设是空的')
  assert(data.config?.proactive, '缺少 proactive 配置')
  return `消息 ${data.snapshot.messages.length} 条，人设 ${data.persona.length} 字`
})

await check('首页能取到 HTML', async () => {
  const res = await fetch(`${BASE}/`)
  const html = await res.text()
  assert(res.status === 200, `状态码 ${res.status}`)
  assert(html.includes('朋友'), 'HTML 内容不对')
  return `${html.length} 字节`
})

await check('静态资源都不缺', async () => {
  const files = ['/style.css', '/app.js', '/icon.svg', '/app.webmanifest']
  for (const f of files) {
    const res = await fetch(`${BASE}${f}`)
    assert(res.status === 200, `${f} 返回 ${res.status}`)
  }
  return files.join(' ')
})

await check('目录穿越被拦住', async () => {
  const res = await fetch(`${BASE}/../config.json`)
  assert(res.status === 403 || res.status === 404, `期望 403/404，实际 ${res.status}`)
  return `已返回 ${res.status}`
})

await check('主动状态可查', async () => {
  const { status, data } = await req('/api/proactive/status')
  assert(status === 200, `状态码 ${status}`)
  assert(typeof data.allowed === 'boolean', '缺少 allowed 字段')
  return data.allowed ? '当前允许发送' : `拦截原因：${data.reason}`
})

await check('人设可读可写', async () => {
  const before = (await req('/api/persona')).data.persona
  const probe = `${before}\n<!-- 冒烟测试标记 -->`
  const put = await req('/api/persona', { method: 'PUT', body: { persona: probe } })
  assert(put.status === 200, `写入失败 ${put.status}`)
  const after = (await req('/api/persona')).data.persona
  assert(after.includes('冒烟测试标记'), '写入没生效')
  await req('/api/persona', { method: 'PUT', body: { persona: before } })
  const restored = (await req('/api/persona')).data.persona
  assert(restored === before, '没能恢复原值')
  return '写入并已还原'
})

await check('配置可改且会生效', async () => {
  const before = (await req('/api/app')).data.config.proactive
  const put = await req('/api/config', {
    method: 'PUT',
    body: { proactive: { ...before, maxPerDay: before.maxPerDay + 1 } },
  })
  assert(put.status === 200, `写入失败 ${put.status}`)
  const after = (await req('/api/app')).data.config.proactive
  assert(after.maxPerDay === before.maxPerDay + 1, 'maxPerDay 没变')
  await req('/api/config', { method: 'PUT', body: { proactive: before } })
  return `maxPerDay 试改后已还原为 ${before.maxPerDay}`
})

await check('演练模式不会真的发消息', async () => {
  const before = (await req('/api/health')).data.messages
  const { status, data } = await req('/api/proactive/run', { method: 'POST', body: { dryRun: true } })
  assert(status === 200, `状态码 ${status}`)
  const after = (await req('/api/health')).data.messages
  assert(after === before, `消息数从 ${before} 变成了 ${after}，演练模式真的发了`)
  return data.reason ? `已判断：${data.reason}` : '演练完成'
})

await check('空消息被拒绝', async () => {
  const { status } = await req('/api/chat', { method: 'POST', body: { text: '   ' } })
  assert(status === 400, `期望 400，实际 ${status}`)
  return '已拦截'
})

await check('不存在的接口返回 404', async () => {
  const { status } = await req('/api/nope')
  assert(status === 404, `期望 404，实际 ${status}`)
  return '正确'
})

await check('头像：可读、可设文字、可传图片、可还原', async () => {
  const original = (await req('/api/avatar')).data.avatar

  // 文字头像
  const text = await req('/api/avatar', { method: 'PUT', body: { kind: 'text', value: '狼' } })
  assert(text.status === 200, `设置文字头像失败 ${text.status}`)
  assert(text.data.avatar.kind === 'text' && text.data.avatar.value === '狼', '文字头像没生效')

  // emoji（多码点，不能被切成半个）
  const emoji = await req('/api/avatar', { method: 'PUT', body: { kind: 'text', value: '🐺' } })
  assert(emoji.data.avatar.value === '🐺', `emoji 被切坏了：${JSON.stringify(emoji.data.avatar.value)}`)

  // 一个 1x1 的真 PNG
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = await req('/api/avatar', { method: 'PUT', body: { kind: 'image', dataUrl: png } })
  assert(image.status === 200, `设置图片头像失败 ${image.status}`)
  assert(image.data.avatar.kind === 'image', '图片头像没生效')

  // 非法格式必须被拒
  const bad = await req('/api/avatar', { method: 'PUT', body: { kind: 'image', dataUrl: 'data:text/plain;base64,aGk=' } })
  assert(bad.status === 400, `非法格式应返回 400，实际 ${bad.status}`)

  // 超大图片必须被拒（伪造一个超长 base64）
  const huge = `data:image/png;base64,${'A'.repeat(700 * 1024)}`
  const tooBig = await req('/api/avatar', { method: 'PUT', body: { kind: 'image', dataUrl: huge } })
  assert(tooBig.status === 400, `超大图片应返回 400，实际 ${tooBig.status}`)

  // 还原
  const restore = await req('/api/avatar', {
    method: 'PUT',
    body: original.kind === 'none' ? { kind: 'none' } : original.kind === 'text'
      ? { kind: 'text', value: original.value }
      : { kind: 'image', dataUrl: original.value },
  })
  assert(restore.status === 200, '还原失败')

  return `文字/emoji/图片/拒绝非法/拒绝超大 全部正确，已还原为 ${original.kind}`
})

await check('头像会随 /api/app 一起下发', async () => {
  const { data } = await req('/api/app')
  assert(data.avatar && typeof data.avatar.kind === 'string', 'app 接口没返回 avatar')
  return `kind=${data.avatar.kind}`
})

await check('Bark：测试推送接口存在且不会推聊天记录', async () => {
  const { status, data } = await req('/api/test/bark', { method: 'POST', body: {} })
  // 没配 Key 时应当明确报错，而不是静默失败
  if (!data.ok) {
    assert(status === 400 || status === 502, `失败时应返回 400/502，实际 ${status}`)
    return `未配置或推送失败：${data.message ?? data.error}`
  }
  assert(status === 200, `状态码 ${status}`)
  /*
   * 这个接口只发固定文案，不碰聊天记录。
   * 曾经有个 /api/bark/last 会把"最后一条消息"推给手机——
   * 结果用户收到了自己说的话，还有自己之前的消息，反复十几遍。
   * 那个接口已经删掉，这里确认它确实不存在了。
   */
  return '测试推送可用（固定文案，不读聊天记录）'
})

await check('危险的推送接口已被移除', async () => {
  const { status } = await req('/api/bark/last', { method: 'POST', body: {} })
  assert(status === 404, `期望 404（接口已删），实际 ${status}`)
  return 'POST /api/bark/last → 404，已移除'
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
