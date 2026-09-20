/**
 * 用真实的 API 验证图片输入能不能用。
 *
 * 为什么先做这个：文档说支持，但你的 key、你的账户是否真的可用，
 * 只有发一次请求才知道。先花几秒钟验证，别写完一整套上传 UI 才发现模型不认。
 *
 * 用法：node test/vision-probe.js
 */
import { loadConfig } from '../src/config.js'
import { shapesPng, solidPng, toDataUrl } from '../src/png.js'

const cfg = loadConfig()

/*
 * 测试图用代码生成，不要手写 base64。
 * 第一次探测时我手写了一张"红色方块"的 base64，结果是坏图，
 * 服务端报"图片格式不支持"，白白浪费一轮排查。
 */
const RED_SQUARE = toDataUrl(solidPng(64, 64, [220, 30, 30]))
const SHAPES = toDataUrl(shapesPng(200))

async function ask(model, imageDataUrl, question) {
  const content = imageDataUrl
    ? [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : question

  const started = Date.now()
  const res = await fetch(`${cfg.model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.model.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      max_tokens: 60,
      temperature: 0,
    }),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - started,
    reply: data?.choices?.[0]?.message?.content ?? null,
    error: data?.error?.message ?? (res.ok ? null : text.slice(0, 250)),
    usage: data?.usage ?? null,
  }
}

function show(title, result) {
  console.log(`  ${title}`)
  console.log(`     状态 ${result.status}  ${result.ms}ms`)
  console.log(`     回复：${(result.reply ?? result.error ?? '').trim().slice(0, 100)}`)
  if (result.usage) {
    console.log(`     token：prompt ${result.usage.prompt_tokens}，completion ${result.usage.completion_tokens}`)
  }
  console.log('')
}

console.log('')
console.log(`  API：${cfg.model.baseUrl}`)
console.log(`  配置的模型：${cfg.model.chatModel}`)
console.log('')

// 1) 纯文字基线
const textOnly = await ask(cfg.model.chatModel, null, '回复"通了"两个字')
show('1. 纯文字请求（基线）', textOnly)

// 2) 纯色图
const solid = await ask(cfg.model.chatModel, RED_SQUARE, '这张图是什么颜色？只回答颜色。')
show('2. 纯色图（应为红色）', solid)

// 3) 带形状的图，测真实视觉理解
const shapes = await ask(
  cfg.model.chatModel,
  SHAPES,
  '这张图里有几个形状？分别是什么颜色？简短回答。',
)
show('3. 几何图形（应为：红色圆 + 绿色方块，蓝底）', shapes)

// 4) 如果配置的模型不认图片，试官方文档点名的 deepseek-flash
if (!shapes.ok && cfg.model.chatModel !== 'deepseek-flash') {
  console.log('  配置的模型不认图片，换官方文档点名的 deepseek-flash 再试：')
  console.log('')
  const fallback = await ask('deepseek-flash', SHAPES, '这张图里有几个形状？分别是什么颜色？简短回答。')
  show('4. deepseek-flash + 图片', fallback)
}

/* ------------------------------------------------------------ 结论 */

console.log('  ' + '─'.repeat(56))
if (shapes.ok && shapes.reply) {
  console.log('  ✓ 图片输入可用，可以做这个功能')
  const t = shapes.usage?.prompt_tokens
  if (t) console.log(`    一张 200x200 的图约占 ${t} prompt token（官方上限 1024/张）`)
} else if (!shapes.ok) {
  console.log('  ✗ 图片输入不可用')
  console.log(`    ${shapes.error}`)
  console.log('')
  if (textOnly.ok) {
    console.log('  纯文字是通的，所以不是 key 或网络的问题。')
    console.log('  把这个错误原文发我，我来判断是模型选择还是账户权限的问题。')
  } else {
    console.log('  连纯文字都不通，先解决基础连通性：node src/cli.js test-model')
  }
} else {
  console.log('  ⚠ 请求成功但回复为空，需要人工看一眼')
}
console.log('')
