/**
 * 图片输入的端到端测试。
 *
 * 会真的调用模型（有成本），所以**默认不跑**。
 * 需要时显式开：node test/vision.js
 *
 * 验证的是整条链路：图片存盘 → 消息里记 id → 取图接口能读回 → 模型真的看懂了。
 * 只测"接口返回 200"是不够的——那只能说明没报错，不能说明它看见了。
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import { PATHS, loadConfig } from '../src/config.js'
import { saveImage, findImage, readImageAsDataUrl, imageStats, parseDataUrl } from '../src/images.js'
import { shapesPng, solidPng, toDataUrl, makePng } from '../src/png.js'
import { respond } from '../src/engine.js'
import { store } from '../src/storage.js'

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

console.log('\n图片存储\n')

const RED = toDataUrl(solidPng(64, 64, [220, 30, 30]))
const SHAPES = toDataUrl(shapesPng(200))

check('能保存一张图', () => {
  const meta = saveImage(RED)
  assert(meta.id && meta.id.length >= 6, '没有生成 id')
  assert(meta.mime === 'image/png', `mime 不对：${meta.mime}`)
  assert(meta.bytes > 0, '字节数为 0')
  return `${meta.id}，${meta.bytes} 字节，${meta.file}`
})

check('保存后能按 id 找回来', () => {
  const meta = saveImage(RED)
  const file = findImage(meta.id)
  assert(file && fs.existsSync(file), '找不回来')
  return file.replace(PATHS.data, 'data')
})

check('能读成 data URL 给模型用', () => {
  const meta = saveImage(SHAPES)
  const url = readImageAsDataUrl(meta.id)
  assert(url && url.startsWith('data:image/'), `不是 data URL：${String(url).slice(0, 30)}`)
  return `${Math.round(url.length / 1024)} KB`
})

check('拒绝非图片', () => {
  let threw = false
  try {
    saveImage('data:text/plain;base64,aGk=')
  } catch (err) {
    threw = true
    assert(/不支持的图片格式/.test(err.message), `错误信息不清楚：${err.message}`)
  }
  assert(threw, '应该抛错')
  return '已拒绝'
})

check('拒绝伪造的 data URL', () => {
  let threw = false
  try {
    saveImage('iVBORw0KGgo=')
  } catch (err) {
    threw = true
  }
  assert(threw, '应该抛错')
  return '已拒绝'
})

check('超大图片被拒绝', () => {
  const huge = `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`
  let threw = false
  try {
    saveImage(huge)
  } catch (err) {
    threw = true
    assert(/太大/.test(err.message), `错误信息不清楚：${err.message}`)
  }
  assert(threw, '应该抛错')
  return '已拒绝'
})

check('id 里有路径穿越字符时直接拒绝（不拼路径）', () => {
  assert(findImage('../../config.json') === null, '有穿越风险')
  assert(findImage('..') === null, '有穿越风险')
  assert(findImage('') === null, '空 id 应返回 null')
  return '已拦截'
})

check('能统计占用', () => {
  const stats = imageStats()
  assert(stats.count > 0, '统计到 0 张图')
  return `${stats.count} 张，${Math.round(stats.bytes / 1024)} KB`
})

/* ------------------------------------------------------------ 真调模型 */

console.log('\n真实视觉理解（会调模型）\n')

const cfg = loadConfig()

await checkAsync('模型能看出纯色图的颜色', async () => {
  const meta = saveImage(RED)
  const url = readImageAsDataUrl(meta.id)
  const res = await askModel(url, '这张图是什么颜色？只回答颜色，两个字以内。')
  assert(/红/.test(res), `模型回答：「${res}」，期望"红色"`)
  return `回答「${res.trim().slice(0, 20)}」`
})

await checkAsync('模型能数出图形和颜色', async () => {
  const meta = saveImage(SHAPES)
  const url = readImageAsDataUrl(meta.id)
  // 实拍：蓝底 + 红圆 + 左上角绿方块
  const res = await askModel(url, '图里有哪几种颜色的形状？分别是什么形状？一句话回答。')
  const hit = /红/.test(res) && /绿/.test(res) && /(圆|球)/.test(res)
  assert(hit, `模型回答：「${res}」，没同时认出红色圆形和绿色方块`)
  return `回答「${res.trim().slice(0, 50)}」`
})

await checkAsync('走完整对话流程（respond 带图）', async () => {
  const before = store.messages.length
  // 用"蓝底 + 红圆 + 绿方块"这种有明确特征的图，
  // 而且问题要问得具体——只发一句"看看这个"是测不出东西的，
  // 模型没法从上下文判断你要它干嘛。
  const meta = saveImage(SHAPES)
  const { message } = await respond('这张图里有什么？说一下颜色和形状。', {
    images: [readImageAsDataUrl(meta.id)],
  })

  assert(store.messages.length > before, '消息没有落库')
  // 用户那条消息应该带上图片 id
  const userMsg = store.messages[store.messages.length - 2]
  assert(Array.isArray(userMsg.meta?.images) && userMsg.meta.images.length === 1,
    '用户消息里没有记录图片 id')
  assert(message.text && message.text.length > 0, '回复是空的')

  // 关键：回复里必须出现图里真实有的东西，否则它就是没看见
  const sawRed = /红/.test(message.text)
  const sawGreen = /绿/.test(message.text)
  const sawShape = /(圆|球|方|矩)/.test(message.text)
  assert(sawRed && sawGreen && sawShape,
    `回复里没有图里的特征（红/绿/形状）：「${message.text.trim()}」`)

  return `回复「${message.text.trim().slice(0, 50)}」`
})

/* ------------------------------------------------------------ 收尾 */

/** 直接问模型，绕开对话流程，方便单独验证视觉能力 */
async function askModel(imageDataUrl, question) {
  const res = await fetch(`${cfg.model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.model.apiKey}` },
    body: JSON.stringify({
      model: cfg.model.chatModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: 60,
      temperature: 0,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  return data.choices?.[0]?.message?.content ?? ''
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
console.log('说明：这个测试会真的调用模型并写入真实对话记录，')
console.log('      跑完后如果想清掉那两轮测试对话，手动编辑 data/messages.jsonl 即可。\n')
process.exit(fail === 0 ? 0 : 1)
