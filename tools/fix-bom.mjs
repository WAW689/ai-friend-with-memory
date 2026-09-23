/**
 * 给缺 BOM 的 .ps1 补上 UTF-8 BOM。
 *
 * 为什么需要：Windows PowerShell 5.1 读没有 BOM 的文件时按系统 ANSI
 * 代码页解码（中文 Windows 上是 GBK），中文全部变乱码、报一串语法错误。
 * 文件本身是对的，人却会以为脚本写坏了。
 *
 * 这个补丁**只加三个字节**，不做任何重新编码——重新编码才是真正的
 * 事故来源（曾经用 Set-Content -Encoding UTF8 把 README 双重编码）。
 *
 * 用法：node tools/fix-bom.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'backups', 'logs', '.dsh'])
const dry = process.argv.includes('--dry')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const fixed = []

function walk(dir) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name)
    if (it.isDirectory()) {
      if (!SKIP_DIRS.has(it.name) && !it.name.startsWith('tmp')) walk(p)
      continue
    }
    if (path.extname(it.name).toLowerCase() !== '.ps1') continue

    const b = fs.readFileSync(p)
    const hasBom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
    // 纯 ASCII 的脚本不带 BOM 也没事——没有中文可乱码
    const hasNonAscii = b.some((x) => x > 0x7f)
    if (hasBom || !hasNonAscii) continue

    if (!dry) fs.writeFileSync(p, Buffer.concat([BOM, b]))
    fixed.push(p)
  }
}

walk('.')
console.log('')
if (fixed.length === 0) {
  console.log('  没有需要补 BOM 的 .ps1')
} else {
  for (const f of fixed) console.log(`  ${dry ? '· 需要补' : '✓ 已补'} ${f}`)
}
console.log('')
