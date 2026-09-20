/**
 * 生成真正的 PNG（不依赖任何第三方库）。
 *
 * 用来造测试图：之前的"图片输入探测"用手写的 base64，结果是张坏图，
 * 白白浪费一轮。这里用 zlib 正经编码一张。
 */
import zlib from 'node:zlib'

/** CRC32（PNG 每个 chunk 都要） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

/**
 * 画一张图并编码成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} paint 返回 [r,g,b]
 * @returns {Buffer}
 */
export function makePng(width, height, paint) {
  // 原始像素：每行前面有一个 filter 字节（0 = None）
  const raw = Buffer.alloc(height * (1 + width * 3))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 纯色图 */
export function solidPng(width, height, [r, g, b]) {
  return makePng(width, height, () => [r, g, b])
}

/** 明确可辨的图形：蓝底 + 中央一个红圆 + 左上角绿方块 */
export function shapesPng(size = 200) {
  const c = size / 2
  const radius = size * 0.28
  return makePng(size, size, (x, y) => {
    // 左上角 30x30 的绿色方块
    if (x < size * 0.15 && y < size * 0.15) return [0, 180, 60]
    // 中央红色圆
    if ((x - c) ** 2 + (y - c) ** 2 < radius ** 2) return [220, 40, 40]
    // 底色蓝
    return [40, 90, 210]
  })
}

/** 转成 data URL */
export function toDataUrl(png, mime = 'image/png') {
  return `data:${mime};base64,${png.toString('base64')}`
}
