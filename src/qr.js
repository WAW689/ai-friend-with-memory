/**
 * 二维码生成器（完全离线，零依赖）。
 *
 * 为什么自己写：
 * 在线二维码网站会拿到你粘进去的内容。Tailscale 邀请链接是一次性令牌，
 * 手机访问地址里还带访问口令，都不该发给第三方服务器。
 *
 * 实现范围：字节模式（byte mode）、版本 1-10、纠错等级 L/M/Q/H、掩码 0-7。
 * 这对网址、短文本完全够用（版本 10 + 纠错 M 能装 213 字节）。
 *
 * 输出：SVG（矢量，任意放大都不糊，用浏览器就能看/打印）
 */

/* ------------------------------------------------------------ 有限域 GF(256) */

// 本原多项式 0x11D，二维码规范指定的
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

;(function initGaloisField() {
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

/** 生成 degree 次的生成多项式 */
function rsGeneratorPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    // 乘以 (x - α^i)，在 GF(256) 里减法就是加法
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1)
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/**
 * 计算 data 的 RS 纠错码字。
 *
 * 用最直白的多项式长除法：整体左移 ecCount 位，然后逐位约掉最高次项，
 * 最后剩下不满 ecCount 次的部分就是余数（也就是纠错码字）。
 *
 * 不用移位寄存器那套写法——省不了多少事，但下标一错就全盘皆输，
 * 而且错了从输出上完全看不出来（矩阵照样"像个二维码"）。
 */
function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount)
  const buf = new Array(data.length + ecCount).fill(0)
  for (let i = 0; i < data.length; i++) buf[i] = data[i]

  for (let i = 0; i < data.length; i++) {
    const coef = buf[i]
    if (coef === 0) continue
    // gen[0] 恒为 1（首一多项式），buf[i] 会被这一轮约掉
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j], coef)
    }
  }

  return Uint8Array.from(buf.slice(data.length))
}

/* ------------------------------------------------------------ 规格表 */

// 每个版本的 (每块纠错码字数, 块数)，按纠错等级索引 [L, M, Q, H]
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

// 每个版本的总码字数（数据 + 纠错）
const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134,
  6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
}

// 每个版本的对齐图案中心坐标
const ALIGN_POSITIONS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

// 版本信息（版本 >= 7 需要），BCH(18,6)
const VERSION_INFO = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6,
  12: 0x0c762, 13: 0x0d847, 14: 0x0e60d, 15: 0x0f928, 16: 0x10b78,
}

const EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 }

/* ------------------------------------------------------------ 数据编码 */

/** 字节模式编码 + 填充到数据容量 */
function encodeData(text, version, ecLevel) {
  const bytes = new TextEncoder().encode(text)
  const [ecPerBlock, blockCount] = EC_TABLE[version][EC_INDEX[ecLevel]]
  const dataCapacity = TOTAL_CODEWORDS[version] - ecPerBlock * blockCount

  // 模式指示符 0100（字节模式）
  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }

  push(0b0100, 4)
  // 版本 1-9 用 8 位字符计数，版本 10-26 用 16 位
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)

  // 结束符最多 4 个 0
  const capacityBits = dataCapacity * 8
  const terminator = Math.min(4, capacityBits - bits.length)
  for (let i = 0; i < terminator; i++) bits.push(0)
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0)

  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    data.push(byte)
  }

  // 交替填充 0xEC / 0x11
  const padBytes = [0xec, 0x11]
  let padIndex = 0
  while (data.length < dataCapacity) {
    data.push(padBytes[padIndex++ % 2])
  }

  return { data: Uint8Array.from(data), dataCapacity, ecPerBlock, blockCount }
}

/** 分块、算纠错、按规范交错排列 */
function interleave(encoded) {
  const { data, ecPerBlock, blockCount } = encoded
  const totalData = data.length
  // 短块数量：让数据尽可能均分
  const shortBlockLen = Math.floor(totalData / blockCount)
  const numLongBlocks = totalData % blockCount

  const dataBlocks = []
  const ecBlocks = []
  let offset = 0

  for (let i = 0; i < blockCount; i++) {
    const len = shortBlockLen + (i >= blockCount - numLongBlocks ? 1 : 0)
    const block = data.slice(offset, offset + len)
    offset += len
    dataBlocks.push(block)
    ecBlocks.push(rsEncode(block, ecPerBlock))
  }

  const result = []
  // 先交错数据码字
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i])
    }
  }
  // 再交错纠错码字
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      result.push(block[i])
    }
  }

  return Uint8Array.from(result)
}

/* ------------------------------------------------------------ 矩阵构建 */

function createMatrix(version) {
  const size = version * 4 + 17
  const modules = []
  const reserved = []
  for (let i = 0; i < size; i++) {
    modules.push(new Uint8Array(size))
    reserved.push(new Uint8Array(size))
  }
  return { size, modules, reserved }
}

function placeFinderPattern(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r
      const cc = col + c
      if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6
      const isDark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
      m.modules[rr][cc] = isDark ? 1 : 0
      m.reserved[rr][cc] = 1
    }
  }
}

function placeAlignmentPattern(m, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isDark = Math.max(Math.abs(r), Math.abs(c)) !== 1
      m.modules[row + r][col + c] = isDark ? 1 : 0
      m.reserved[row + r][col + c] = 1
    }
  }
}

/** 时序图案 */
function placeTimingPatterns(m) {
  for (let i = 8; i < m.size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0
    m.modules[6][i] = dark
    m.reserved[6][i] = 1
    m.modules[i][6] = dark
    m.reserved[i][6] = 1
  }
}

/** 格式信息（纠错等级 + 掩码），BCH(15,5) + 固定掩码 0x5412 */
function formatInfoBits(ecLevel, mask) {
  const ecBits = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }[ecLevel]
  let data = (ecBits << 3) | mask
  let value = data << 10
  // BCH 除法
  for (let i = 14; i >= 10; i--) {
    if ((value >> i) & 1) value ^= 0b10100110111 << (i - 10)
  }
  return ((data << 10) | value) ^ 0b101010000010010
}

function placeFormatInfo(m, ecLevel, mask) {
  const bits = formatInfoBits(ecLevel, mask)
  const get = (i) => (bits >> i) & 1

  // 第一份：左上角，沿第 8 行和第 8 列铺开（跳过第 6 行/列）
  for (let i = 0; i <= 5; i++) {
    m.modules[8][i] = get(i)
    m.reserved[8][i] = 1
  }
  m.modules[8][7] = get(6)
  m.reserved[8][7] = 1
  m.modules[8][8] = get(7)
  m.reserved[8][8] = 1
  m.modules[7][8] = get(8)
  m.reserved[7][8] = 1
  for (let i = 9; i <= 14; i++) {
    m.modules[14 - i][8] = get(i)
    m.reserved[14 - i][8] = 1
  }

  // 第二份：右上角（第 8 行末尾 8 格）+ 左下角（第 8 列末尾 7 格）
  //
  // 这里必须把 reserved 标全。格式信息一共 15 位，分两处存放：
  //   (8, size-8) .. (8, size-1)   ← 8 位
  //   (size-7, 8) .. (size-1, 8)   ← 7 位
  // 漏标的话，placeData 会把这些格子当成数据区覆盖掉，
  // 结果是格式信息被破坏、数据比特整体错位——而矩阵看起来仍然"像个二维码"。
  for (let i = 0; i <= 7; i++) {
    m.modules[m.size - 1 - i][8] = get(i)
    m.reserved[m.size - 1 - i][8] = 1
  }
  for (let i = 8; i <= 14; i++) {
    m.modules[8][m.size - 15 + i] = get(i)
    m.reserved[8][m.size - 15 + i] = 1
  }

  // 固定的暗模块
  m.modules[m.size - 8][8] = 1
  m.reserved[m.size - 8][8] = 1
}

/** 版本信息（版本 >= 7） */
function placeVersionInfo(m, version) {
  if (version < 7) return
  const bits = VERSION_INFO[version]
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1
    const r = Math.floor(i / 3)
    const c = i % 3
    m.modules[m.size - 11 + c][r] = bit
    m.reserved[m.size - 11 + c][r] = 1
    m.modules[r][m.size - 11 + c] = bit
    m.reserved[r][m.size - 11 + c] = 1
  }
}

/** 把码字按之字形从下往上填进矩阵 */
function placeData(m, codewords) {
  let bitIndex = 0
  const totalBits = codewords.length * 8
  let upward = true

  for (let col = m.size - 1; col > 0; col -= 2) {
    // 第 6 列是时序列，跳过
    if (col === 6) col = 5
    for (let i = 0; i < m.size; i++) {
      const row = upward ? m.size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (m.reserved[row][c]) continue
        if (bitIndex < totalBits) {
          const byte = codewords[bitIndex >> 3]
          m.modules[row][c] = (byte >> (7 - (bitIndex & 7))) & 1
          bitIndex++
        } else {
          m.modules[row][c] = 0
        }
      }
    }
    upward = !upward
  }
}

/* ------------------------------------------------------------ 掩码 */

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

function applyMask(m, maskIndex) {
  const fn = MASK_FUNCTIONS[maskIndex]
  const out = m.modules.map((row) => Uint8Array.from(row))
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.reserved[r][c] && fn(r, c)) out[r][c] ^= 1
    }
  }
  return out
}

/** 掩码评分：分数越低越好（按规范的四个惩罚规则） */
function scoreMask(modules, size) {
  let score = 0

  // 规则 1：同色连续 5 个以上
  const runPenalty = (line) => {
    let total = 0
    let run = 1
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        run++
      } else {
        if (run >= 5) total += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) total += 3 + (run - 5)
    return total
  }
  for (let r = 0; r < size; r++) score += runPenalty(modules[r])
  for (let c = 0; c < size; c++) {
    score += runPenalty(Array.from({ length: size }, (_, r) => modules[r][c]))
  }

  // 规则 2：2x2 同色方块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c]
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3
    }
  }

  // 规则 3：出现 10111010000 或 00001011101 这类类定位图案
  const pattern1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const pattern2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const matchAt = (line, start, pattern) => pattern.every((p, i) => line[start + i] === p)
  const scanLine = (line) => {
    let total = 0
    for (let i = 0; i + 11 <= line.length; i++) {
      if (matchAt(line, i, pattern1) || matchAt(line, i, pattern2)) total += 40
    }
    return total
  }
  for (let r = 0; r < size; r++) score += scanLine(modules[r])
  for (let c = 0; c < size; c++) {
    score += scanLine(Array.from({ length: size }, (_, r) => modules[r][c]))
  }

  // 规则 4：明暗比例偏离 50%
  let dark = 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) dark += modules[r][c]
  }
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10

  return score
}

/* ------------------------------------------------------------ 对外接口 */

/**
 * 标记所有"非数据"模块。
 *
 * 必须在 placeData 之前调用，而且必须一次标全。
 * 漏标一处，placeData 就会把那个格子当数据写进去，
 * 结果是图案被破坏、后续比特整体错位——而矩阵从外观上完全看不出来。
 */
function markReservedPatterns(m, version) {
  const size = m.size

  // 三个定位图案（含分隔符，各占 8x8）
  const markFinderBlock = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        m.reserved[rr][cc] = 1
      }
    }
  }
  markFinderBlock(0, 0)
  markFinderBlock(0, size - 7)
  markFinderBlock(size - 7, 0)

  // 格式信息第一份：第 8 行左侧 (0..8) + 第 8 列上方 (0..8)
  for (let i = 0; i <= 8; i++) {
    m.reserved[8][i] = 1
    m.reserved[i][8] = 1
  }

  // 格式信息第二份：第 8 行右侧 (size-8 .. size-1) + 第 8 列下方 (size-7 .. size-1)
  for (let i = 0; i < 8; i++) {
    m.reserved[8][size - 1 - i] = 1
    m.reserved[size - 1 - i][8] = 1
  }

  // 固定暗模块
  m.reserved[size - 8][8] = 1

  // 版本信息（版本 >= 7）：两块 3x6
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3)
      const c = i % 3
      m.reserved[size - 11 + c][r] = 1
      m.reserved[r][size - 11 + c] = 1
    }
  }
}

/**
 * 生成二维码矩阵。
 * @param {string} text
 * @param {{ ecLevel?: 'L'|'M'|'Q'|'H', minVersion?: number }} options
 * @returns {{ size: number, modules: Uint8Array[], version: number, mask: number }}
 */
export function encode(text, options = {}) {
  const ecLevel = options.ecLevel ?? 'M'
  const bytes = new TextEncoder().encode(text)

  // 选一个装得下的最小版本
  let version = 0
  for (let v = options.minVersion ?? 1; v <= 10; v++) {
    const [ecPerBlock, blockCount] = EC_TABLE[v][EC_INDEX[ecLevel]]
    const dataCapacity = TOTAL_CODEWORDS[v] - ecPerBlock * blockCount
    // 4 位模式 + 计数位 + 数据 + 最多 4 位结束符
    const countBits = v <= 9 ? 8 : 16
    const needed = Math.ceil((4 + countBits + bytes.length * 8) / 8)
    if (needed <= dataCapacity) {
      version = v
      break
    }
  }
  if (version === 0) {
    throw new Error(`内容太长，版本 10 + 纠错 ${ecLevel} 装不下（${bytes.length} 字节）`)
  }

  const encoded = encodeData(text, version, ecLevel)
  const codewords = interleave(encoded)

  const base = createMatrix(version)
  placeFinderPattern(base, 0, 0)
  placeFinderPattern(base, 0, base.size - 7)
  placeFinderPattern(base, base.size - 7, 0)
  placeTimingPatterns(base)
  for (const row of ALIGN_POSITIONS[version]) {
    for (const col of ALIGN_POSITIONS[version]) {
      // 跳过和定位图案重叠的位置
      const nearFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= base.size - 9) ||
        (row >= base.size - 9 && col <= 8)
      if (nearFinder) continue
      placeAlignmentPattern(base, row, col)
    }
  }
  placeVersionInfo(base, version)
  // 先把所有非数据模块标全，再填数据——顺序不能反
  markReservedPatterns(base, version)
  placeData(base, codewords)

  // 试用 8 种掩码，选评分最低的
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    // 格式信息也要参与评分，所以每个掩码都完整重建一次
    const candidate = { size: base.size, modules: base.modules, reserved: base.reserved }
    const masked = applyMask(candidate, mask)
    const withFormat = masked.map((row) => Uint8Array.from(row))
    const holder = { size: base.size, modules: withFormat, reserved: base.reserved }
    placeFormatInfo(holder, ecLevel, mask)
    const score = scoreMask(withFormat, base.size)
    if (!best || score < best.score) best = { score, mask, modules: withFormat }
  }

  return { size: base.size, modules: best.modules, version, mask: best.mask, ecLevel }
}

/**
 * 渲染成 SVG 字符串。
 * @param {string} text
 * @param {{ scale?: number, margin?: number, dark?: string, light?: string, ecLevel?: string }} options
 */
export function toSvg(text, options = {}) {
  const scale = options.scale ?? 8
  const margin = options.margin ?? 4
  const dark = options.dark ?? '#000000'
  const light = options.light ?? '#ffffff'
  const qr = encode(text, { ecLevel: options.ecLevel })
  const dim = (qr.size + margin * 2) * scale

  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`)
  if (light !== 'transparent') {
    parts.push(`<rect width="${dim}" height="${dim}" fill="${light}"/>`)
  }
  // 把连续的暗模块合并成一条 path，文件更小
  const segments = []
  for (let r = 0; r < qr.size; r++) {
    let runStart = -1
    for (let c = 0; c <= qr.size; c++) {
      const isDark = c < qr.size && qr.modules[r][c] === 1
      if (isDark && runStart === -1) runStart = c
      if (!isDark && runStart !== -1) {
        const x = (runStart + margin) * scale
        const y = (r + margin) * scale
        const w = (c - runStart) * scale
        segments.push(`M${x} ${y}h${w}v${scale}h-${w}z`)
        runStart = -1
      }
    }
  }
  parts.push(`<path d="${segments.join('')}" fill="${dark}"/>`)
  parts.push('</svg>')
  return parts.join('\n')
}

/** 渲染成终端里能直接扫的字符画 */
export function toTerminal(text, options = {}) {
  const qr = encode(text, { ecLevel: options.ecLevel })
  const margin = options.margin ?? 2
  const lines = []
  // 用两个字符宽表示一个模块，这样终端里接近正方形
  const white = '  '
  const black = '██'
  for (let i = 0; i < margin; i++) lines.push(white.repeat(qr.size + margin * 2))
  for (let r = 0; r < qr.size; r++) {
    let line = white.repeat(margin)
    for (let c = 0; c < qr.size; c++) line += qr.modules[r][c] ? black : white
    line += white.repeat(margin)
    lines.push(line)
  }
  for (let i = 0; i < margin; i++) lines.push(white.repeat(qr.size + margin * 2))
  return lines.join('\n')
}

