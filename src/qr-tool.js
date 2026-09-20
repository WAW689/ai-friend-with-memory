/**
 * 二维码生成工具。
 *
 *   node src/qr-tool.js "https://example.com"
 *   node src/qr-tool.js "https://example.com" -o qr.svg
 *   node src/qr-tool.js "https://example.com" --term       只打字符画
 *   node src/qr-tool.js "https://example.com" -o qr.svg --term
 *
 * 完全离线，不联网、不依赖任何第三方库。
 * 之所以不让你用在线二维码网站：那类网址会拿到你粘进去的内容，
 * 而这里面可能是 Tailscale 邀请链接（一次性令牌）或带访问口令的地址。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toSvg, toTerminal, encode } from './qr.js'
import { log } from './util.js'

function usage() {
  console.log(`
二维码生成器（离线）

  node src/qr-tool.js <内容> [选项]

选项
  -o, --out <文件>     写成 SVG 文件（默认：如果不给就只打字符画）
  -t, --term           在终端里打字符画，方便直接用手机扫
  -e, --ec <L|M|Q|H>   纠错等级，默认 M。内容越长越容易撑到高版本
  -s, --scale <n>      SVG 每模块像素数，默认 10
  --no-margin          SVG 不要白边（默认留 4 模块白边，扫码更稳）
  -h, --help           看这个

例子
  node src/qr-tool.js "http://100.64.1.2:8787/?token=abc"
  node src/qr-tool.js "http://100.64.1.2:8787/?token=abc" -o D:\\qr.svg --term
`)
}

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  usage()
  process.exit(0)
}

let content = ''
let out = ''
let term = false
let ecLevel = 'M'
let scale = 10
let margin = 4

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '-o' || arg === '--out') {
    out = args[++i] ?? ''
  } else if (arg === '-t' || arg === '--term') {
    term = true
  } else if (arg === '-e' || arg === '--ec') {
    ecLevel = (args[++i] ?? 'M').toUpperCase()
    if (!['L', 'M', 'Q', 'H'].includes(ecLevel)) {
      log.error(`纠错等级只能是 L/M/Q/H，收到 ${ecLevel}`)
      process.exit(1)
    }
  } else if (arg === '-s' || arg === '--scale') {
    scale = Number(args[++i])
    if (!Number.isFinite(scale) || scale <= 0) {
      log.error('scale 必须是正数')
      process.exit(1)
    }
  } else if (arg === '--no-margin') {
    margin = 0
  } else if (!content) {
    content = arg
  } else {
    log.error(`多余的参数：${arg}`)
    process.exit(1)
  }
}

if (!content) {
  log.error('没给内容。用法：node src/qr-tool.js "内容"')
  process.exit(1)
}

// 先探测一下容量，给出有用的大小提示
let info
try {
  info = encode(content, { ecLevel })
} catch (err) {
  log.error(err.message)
  process.exit(1)
}

const byteLength = new TextEncoder().encode(content).length
console.log('')
console.log(`  内容长度     ${content.length} 字符 / ${byteLength} 字节（UTF-8）`)
console.log(`  编码版本     ${info.version}（${info.size}×${info.size} 模块）`)
console.log(`  纠错等级     ${ecLevel}（约可损坏 ${({ L: 7, M: 15, Q: 25, H: 30 })[ecLevel]}% 仍能扫出）`)
console.log(`  选用掩码     ${info.mask}`)

if (out) {
  const svg = toSvg(content, { scale, margin, ecLevel })
  const target = path.resolve(out)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, svg, 'utf8')
  console.log(`  已写入       ${target}`)
  console.log(`              用浏览器打开这个文件，或者打印出来`)
}

if (term || !out) {
  console.log('')
  console.log(toTerminal(content, { ecLevel, margin: 1 }))
  console.log('   ↑ 把终端背景调成白色、字号调小，然后用手机相机直接扫')
  console.log('')
}

if (!out && !term) {
  console.log('  提示：加 -o 文件名.svg 可以导出成图片文件')
  console.log('')
}
