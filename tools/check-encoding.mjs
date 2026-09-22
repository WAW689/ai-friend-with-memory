import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'backups', 'logs', '.dsh'])
const EXTS = new Set(['.js', '.mjs', '.json', '.md', '.txt', '.yml', '.yaml', '.ps1', '.cmd', '.html', '.css', '.svg', '.webmanifest', '.example'])

/*
 * 没有扩展名的文件也要查。
 *
 * 这个漏过一次：.env.example 就是双重编码的（原始 UTF-8 中文被当成 GBK
 * 解读后又存成 UTF-8），但因为 ".env.example" 被 path.extname 认成
 * 扩展名 ".example"、而它又不在白名单里，扫了 57 个文件一个都没报。
 * 所以这里改成"按内容判断是不是文本"，而不是靠扩展名列表。
 */
const ALWAYS_CHECK = new Set(['.gitignore', '.gitattributes', '.env', '.env.example', '.editorconfig', '.npmrc'])

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
    const keep = EXTS.has(ext) || ALWAYS_CHECK.has(it.name) || it.name.startsWith('.')
    if (!keep) continue

    const b = fs.readFileSync(p)

    // 二进制文件（图片等）跳过，不然会被误报成"非 UTF-8"
    if (b.includes(0)) continue

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
