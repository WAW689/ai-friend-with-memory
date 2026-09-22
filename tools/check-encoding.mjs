import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'backups', 'logs', '.dsh'])
const EXTS = new Set(['.js', '.mjs', '.json', '.md', '.txt', '.yml', '.yaml', '.ps1', '.cmd', '.html', '.css', '.svg', '.webmanifest', '.example'])

const bad = []
const crlfFiles = []
const bomFiles = []
let checked = 0

function walk(dir) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name)
    if (it.isDirectory()) {
      if (!SKIP_DIRS.has(it.name) && !it.name.startsWith('tmp')) walk(p)
      continue
    }
    const ext = path.extname(it.name).toLowerCase()
    if (!EXTS.has(ext) && it.name !== '.gitignore' && it.name !== '.gitattributes') continue

    const b = fs.readFileSync(p)
    checked++

    let ok = true
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b)
    } catch {
      ok = false
    }
    if (!ok) bad.push(p)

    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bomFiles.push(p)

    const s = b.toString('latin1')
    const crlf = (s.match(/\r\n/g) ?? []).length
    const lf = (s.match(/\n/g) ?? []).length
    if (crlf > 0 && crlf < lf) crlfFiles.push(`${p} (CRLF ${crlf} / LF ${lf})`)
  }
}

walk('.')

console.log('检查了 ' + checked + ' 个文本文件')
console.log('')
console.log('=== 非 UTF-8 编码（会破坏 git diff / 编辑器）===')
if (bad.length === 0) console.log('  无')
else for (const f of bad) console.log('  ! ' + f)

console.log('')
console.log('=== 混合行尾 ===')
if (crlfFiles.length === 0) console.log('  无')
else for (const f of crlfFiles) console.log('  ! ' + f)

console.log('')
console.log('=== UTF-8 BOM（.ps1 需要，其他不需要）===')
if (bomFiles.length === 0) console.log('  无')
else for (const f of bomFiles) console.log('  · ' + f)
