/**
 * 二维码对拍测试。
 *
 * 思路：光看编码器输出"长得像二维码"没有意义。
 * 这里写一个**独立的解码器**，把生成的矩阵反着读回来，
 * 并用 RS 校验子验证纠错码字是否自洽——能还原出原文，说明整条链路是对的。
 *
 * 覆盖：版本选择、字节模式编码、填充、分块、RS 纠错、交错、
 *       矩阵构建、掩码选择、格式信息读写。
 *
 * 用法：node test/qr-roundtrip.js
 */
import { encode, toSvg, toTerminal } from '../src/qr.js'

/* ------------------------------------------------------------ GF(256) */

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function init() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/* ------------------------------------------------------------ 纠错签名 */

/**
 * 用生成多项式对"数据+纠错"整块做多项式求值。
 * 若纠错码字正确，所有校验子必须为 0。
 * 这是纠错码自洽性的硬性检查——算错了不可能碰巧全过。
 */
function syndromesAreZero(block, ecCount) {
  // 生成多项式 g(x) = Π(x - α^i), i = 0..ecCount-1
  let gen = [1]
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= gfMul(gen[j], EXP[i])
    }
    gen = next
  }
  // 用 α^0 .. α^(ecCount-1) 求值，全 0 即正确
  for (let i = 0; i < ecCount; i++) {
    const a = EXP[i]
    let acc = 0
    for (const coef of block) acc = gfMul(acc, a) ^ coef
    if (acc !== 0) return false
  }
  return true
}

/* ------------------------------------------------------------ 规格表 */

const EC_TABLE = {
  1: [[7, 1], [10, 1], [13, 1], [17, 1]],
  2: [[10, 1], [16, 1], [22, 1], [28, 1]],
  3: [[15, 1], [26, 1], [18, 2], [22, 2]],
  4: [[20, 1], [18, 2], [26, 2], [16, 4]],
  5: [[26, 1], [24, 2], [18, 4], [22, 4]],
  6: [[18, 2], [16, 4], [24, 4], [28, 4]],
  7: [[20, 2], [18, 4], [18, 6], [26, 5]],
  8: [[24, 2], [22, 4], [22, 6], [26, 6]],
  9: [[30, 2], [22, 5], [20, 8], [24, 8]],
  10: [[18, 4], [26, 5], [24, 8], [28, 8]],
}
const TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 }
const ALIGN_POSITIONS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}
const VERSION_INFO = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6,
  12: 0x0c762, 13: 0x0d847, 14: 0x0e60d, 15: 0x0f928, 16: 0x10b78,
}
const EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 }

/* ------------------------------------------------- 从格式信息反解掩码 */

/**
 * 格式信息是 {5 位数据 + 10 位 BCH} 再异或 0x5412。
 * 这里直接穷举 32 种合法组合，和从矩阵里读出来的 15 位比对，
 * 允许最多 3 位误差（格式信息本身带纠错能力）。
 */
function decodeFormatInfo(modules, size) {
  // 按写入的顺序读回 15 位
  const bits = []
  const get = (r, c) => modules[r][c]
  for (let i = 0; i <= 5; i++) bits.push(get(8, i))
  bits.push(get(8, 7))
  bits.push(get(8, 8))
  bits.push(get(7, 8))
  for (let i = 9; i <= 14; i++) bits.push(get(14 - i, 8))

  let read = 0
  for (let i = 0; i < 15; i++) read |= bits[i] << i

  let best = null
  for (let data = 0; data < 32; data++) {
    let value = data << 10
    for (let i = 14; i >= 10; i--) {
      if ((value >> i) & 1) value ^= 0b10100110111 << (i - 10)
    }
    const candidate = ((data << 10) | value) ^ 0b101010000010010
    let diff = candidate ^ read
    let distance = 0
    while (diff) {
      distance += diff & 1
      diff >>= 1
    }
    if (!best || distance < best.distance) best = { data, distance }
  }
  if (best.distance > 3) return null

  const ecBits = (best.data >> 3) & 0b11
  const mask = best.data & 0b111
  const ecLevel = { 0b01: 'L', 0b00: 'M', 0b11: 'Q', 0b10: 'H' }[ecBits]
  return { ecLevel, mask, distance: best.distance }
}

/* ------------------------------------------------------- 重建预留图 */

function buildReserved(size, version) {
  const reserved = []
  for (let i = 0; i < size; i++) reserved.push(new Uint8Array(size))

  const markFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        reserved[rr][cc] = 1
      }
    }
  }
  markFinder(0, 0)
  markFinder(0, size - 7)
  markFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i++) {
    reserved[6][i] = 1
    reserved[i][6] = 1
  }

  for (const row of ALIGN_POSITIONS[version]) {
    for (const col of ALIGN_POSITIONS[version]) {
      const nearFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)
      if (nearFinder) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) reserved[row + r][col + c] = 1
      }
    }
  }

  // 格式信息
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = 1
    reserved[i][8] = 1
  }
  for (let i = 0; i < 8; i++) {
    reserved[size - 1 - i][8] = 1
    reserved[8][size - 1 - i] = 1
  }
  reserved[size - 8][8] = 1

  // 版本信息
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3)
      const c = i % 3
      reserved[size - 11 + c][r] = 1
      reserved[r][size - 11 + c] = 1
    }
  }

  return reserved
}

const MASK_FUNCTIONS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/* --------------------------------------------------------- 解码 */

function decode(qr) {
  const { size, modules } = qr
  const version = (size - 17) / 4
  if (!Number.isInteger(version) || version < 1 || version > 10) {
    throw new Error(`尺寸 ${size} 不是合法版本`)
  }

  const format = decodeFormatInfo(modules, size)
  if (!format) throw new Error('格式信息无法解析')
  if (format.ecLevel !== qr.ecLevel) {
    throw new Error(`纠错等级不符：读到 ${format.ecLevel}，期望 ${qr.ecLevel}`)
  }

  const reserved = buildReserved(size, version)

  // 按同样的之字形顺序读出比特
  const bits = []
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue
        bits.push(modules[row][c])
      }
    }
    upward = !upward
  }

  // 去掩码
  const maskFn = MASK_FUNCTIONS[format.mask]
  const unmasked = []
  let bitIndex = 0
  upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue
        let bit = bits[bitIndex++]
        if (maskFn(row, c)) bit ^= 1
        unmasked.push(bit)
      }
    }
    upward = !upward
  }

  // 拼回码字
  const codewords = []
  for (let i = 0; i + 8 <= unmasked.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | unmasked[i + j]
    codewords.push(byte)
  }

  const [ecPerBlock, blockCount] = EC_TABLE[version][EC_INDEX[format.ecLevel]]
  const totalData = TOTAL_CODEWORDS[version] - ecPerBlock * blockCount

  // 反交错：还原每个数据块
  const shortLen = Math.floor(totalData / blockCount)
  const numLong = totalData % blockCount
  const blockLengths = []
  for (let i = 0; i < blockCount; i++) blockLengths.push(shortLen + (i >= blockCount - numLong ? 1 : 0))

  const dataBlocks = blockLengths.map(() => [])
  let idx = 0
  const maxLen = Math.max(...blockLengths)
  for (let i = 0; i < maxLen; i++) {
    for (let b = 0; b < blockCount; b++) {
      if (i < blockLengths[b]) dataBlocks[b].push(codewords[idx++])
    }
  }

  const ecBlocks = Array.from({ length: blockCount }, () => [])
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blockCount; b++) ecBlocks[b].push(codewords[idx++])
  }

  // 用纠错签名验证每一块自洽
  for (let b = 0; b < blockCount; b++) {
    const full = [...dataBlocks[b], ...ecBlocks[b]]
    if (!syndromesAreZero(full, ecPerBlock)) {
      throw new Error(`第 ${b} 块的纠错码字不自洽（RS 签名非零）`)
    }
  }

  // 拼接数据码字
  const data = dataBlocks.flat()

  // 解析：模式指示符 + 字符计数 + 数据
  let bitPos = 0
  const readBits = (n) => {
    let value = 0
    for (let i = 0; i < n; i++) {
      value = (value << 1) | ((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1)
      bitPos++
    }
    return value
  }

  const mode = readBits(4)
  if (mode !== 0b0100) throw new Error(`模式指示符不是字节模式：${mode.toString(2)}`)
  const length = readBits(version <= 9 ? 8 : 16)
  const bytes = []
  for (let i = 0; i < length; i++) bytes.push(readBits(8))

  return {
    text: new TextDecoder().decode(Uint8Array.from(bytes)),
    version,
    ecLevel: format.ecLevel,
    mask: format.mask,
    blocks: blockCount,
    ecPerBlock,
  }
}

/* --------------------------------------------------------- 跑测试 */

const CASES = [
  // 短内容，各种纠错等级
  { text: 'HI', ec: 'L', note: '最短' },
  { text: 'https://tailscale.com/download', ec: 'M', note: '典型网址' },
  {
    text: 'https://login.tailscale.com/admin/invite/abc123XYZdef456ghi789',
    ec: 'M',
    note: '较长的邀请链接',
  },
  {
    // 用明显是假的令牌，绝不拿真实访问口令当测试数据
    text: 'http://100.101.102.103:8787/?token=EXAMPLE-TEST-TOKEN-NOT-REAL-0000',
    ec: 'M',
    note: '带口令的访问地址',
  },
  { text: 'https://example.com/a', ec: 'H', note: '最高纠错等级' },
  { text: 'https://example.com/a', ec: 'Q', note: 'Q 等级' },
  { text: 'a'.repeat(200), ec: 'L', note: '接近版本 10 上限' },
  { text: '中文测试：这是一段包含多字节字符的内容', ec: 'M', note: 'UTF-8 多字节' },
  { text: 'emoji 🎉 和符号 ✓', ec: 'Q', note: '四字节 UTF-8' },
]

let pass = 0
let fail = 0

console.log('\n二维码环路测试（生成 → 解码还原）\n')

for (const testCase of CASES) {
  const label = `${testCase.ec} · ${testCase.note}`
  try {
    const qr = encode(testCase.text, { ecLevel: testCase.ec })
    const decoded = decode(qr)

    if (decoded.text !== testCase.text) {
      throw new Error(`内容不符\n    期望: ${JSON.stringify(testCase.text.slice(0, 60))}\n    实得: ${JSON.stringify(decoded.text.slice(0, 60))}`)
    }
    if (decoded.version !== qr.version || decoded.mask !== qr.mask) {
      throw new Error(`元信息不符：版本 ${decoded.version}/${qr.version}，掩码 ${decoded.mask}/${qr.mask}`)
    }

    pass++
    console.log(`  ✓ ${label}  →  版本 ${qr.version}、掩码 ${qr.mask}、${decoded.blocks} 块、${testCase.text.length} 字符`)
  } catch (err) {
    fail++
    console.log(`  ✗ ${label}  →  ${err.message}`)
  }
}

/* ------------------------------------------------- 结构合规性检查 */

console.log('\n结构检查\n')

function checkStructure(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ✗ ${name} —— ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

checkStructure('三个定位图案位置正确', () => {
  for (const [ecLevel, expect] of [['M', null]]) {
    const qr = encode('TEST', { ecLevel })
    const m = qr.modules
    const size = qr.size
    // 定位图案的外圈必须是暗的
    for (let i = 0; i < 7; i++) {
      assert(m[0][i] === 1 && m[6][i] === 1, '左上定位图案外圈不完整')
      assert(m[i][0] === 1 && m[i][6] === 1, '左上定位图案外圈不完整')
      assert(m[0][size - 1 - i] === 1, '右上定位图案外圈不完整')
      assert(m[size - 1][i] === 1, '左下定位图案外圈不完整')
    }
    // 内圈 3x3 必须是暗的，中间环必须有一圈亮的
    assert(m[2][2] === 1 && m[4][4] === 1, '定位图案核心不对')
    assert(m[1][1] === 0, '定位图案第二圈应该是亮的')
  }
})

checkStructure('时序图案黑白交替', () => {
  const qr = encode('TEST', { ecLevel: 'M' })
  const m = qr.modules
  // 第 6 行/列，从 8 到 size-9，偶数位置暗
  for (let i = 8; i < qr.size - 8; i++) {
    assert(m[6][i] === (i % 2 === 0 ? 1 : 0), `时序行第 ${i} 位不对`)
    assert(m[i][6] === (i % 2 === 0 ? 1 : 0), `时序列第 ${i} 位不对`)
  }
})

checkStructure('固定暗模块存在', () => {
  const qr = encode('TEST', { ecLevel: 'M' })
  assert(qr.modules[qr.size - 8][8] === 1, '固定暗模块丢失')
})

checkStructure('所有版本都能生成并还原', () => {
  for (let targetVersion = 1; targetVersion <= 10; targetVersion++) {
    // 用填充量刚好把版本顶到 targetVersion
    const caps = {}
    for (const ec of ['L', 'M', 'Q', 'H']) {
      const [ecPerBlock, blockCount] = EC_TABLE[targetVersion][EC_INDEX[ec]]
      caps[ec] = TOTAL_CODEWORDS[targetVersion] - ecPerBlock * blockCount
    }
    for (const ec of ['L', 'M', 'Q', 'H']) {
      const payload = 'x'.repeat(Math.max(1, caps[ec] - 3))
      const qr = encode(payload, { ecLevel: ec, minVersion: targetVersion })
      assert(qr.version === targetVersion, `期望版本 ${targetVersion}，实得 ${qr.version}（${ec}，${payload.length} 字节）`)
      const decoded = decode(qr)
      assert(decoded.text === payload, `版本 ${targetVersion} + ${ec} 还原失败`)
    }
  }
})

checkStructure('超长内容会明确报错而不是产出坏码', () => {
  let threw = false
  try {
    encode('x'.repeat(500), { ecLevel: 'H' })
  } catch (err) {
    threw = true
    assert(/装不下/.test(err.message), `错误信息不清楚：${err.message}`)
  }
  assert(threw, '超长内容没有报错')
})

checkStructure('SVG 输出结构合法', () => {
  const svg = toSvg('https://example.com', { scale: 4 })
  assert(svg.startsWith('<svg'), 'SVG 开头不对')
  assert(svg.trimEnd().endsWith('</svg>'), 'SVG 结尾不对')
  assert(/<path d="M/.test(svg), '缺少绘制路径')
  assert(svg.includes('viewBox'), '缺少 viewBox，无法缩放')
  // 尺寸应等于 (模块数 + 边距*2) * scale
  const qr = encode('https://example.com', {})
  const expected = (qr.size + 4 * 2) * 4
  assert(svg.includes(`width="${expected}"`), `宽度不对，期望 ${expected}`)
})

checkStructure('终端字符画行宽一致', () => {
  const art = toTerminal('https://example.com', { margin: 2 })
  const lines = art.split('\n')
  const widths = new Set(lines.map((l) => l.length))
  assert(widths.size === 1, `行宽不一致：${[...widths].join(', ')}`)
  const qr = encode('https://example.com', {})
  assert(lines.length === qr.size + 4, `行数不对：${lines.length}，期望 ${qr.size + 4}`)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)

if (fail === 0) {
  // 打印一个可扫的样例，方便用手机实测
  const demo = 'http://100.101.102.103:8787/?token=demo'
  console.log('下面是编码 "' + demo + '" 的字符画，可以用手机相机直接扫一下做最终验证：\n')
  console.log(toTerminal(demo, { margin: 1 }))
  console.log('')
}

process.exit(fail === 0 ? 0 : 1)
