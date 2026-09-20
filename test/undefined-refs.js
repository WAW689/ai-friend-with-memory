/**
 * 静态检查：有没有"用了但没导入"的函数。
 *
 * 为什么需要它：
 * node --check 只做语法检查，抓不到未定义的标识符。
 * 实测就踩过一次——在 engine.js 里用了 localDateKey() 却没导入，
 * 语法检查通过、服务正常启动，**只有真正发消息时才炸**。
 * 而且那条路径藏在"每日备份"里，很容易漏。
 *
 * 这个检查很朴素：把各模块导出的名字列出来，
 * 再看每个源文件里是不是调用了没导入的那些。
 *
 * 用法：node test/undefined-refs.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/** 收集一个模块导出的名字 */
function exportedNames(code) {
  const names = new Set()
  // export function foo / export async function foo
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // export const foo / export let foo
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // export { a, b as c }
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const asMatch = piece.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      names.add(asMatch ? asMatch[1] : piece.split(/\s+/)[0])
    }
  }
  return names
}

/** 收集一个文件导入的名字 */
function importedNames(code) {
  const names = new Set()
  for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const asMatch = piece.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      names.add(asMatch ? asMatch[1] : piece.split(/\s+/)[0])
    }
  }
  return names
}

/* ------------------------------------------------------------ 建立符号表 */

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))
const exportedByFile = new Map()

for (const file of files) {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8')
  exportedByFile.set(file, exportedNames(code))
}

// util.js 是最常用的，单独拿出来当重点
const utilExports = exportedByFile.get('util.js') ?? new Set()

console.log('\n未导入引用检查\n')

check('util.js 的导出能被正确解析', () => {
  assert(utilExports.size > 5, `只解析出 ${utilExports.size} 个导出，解析逻辑可能坏了`)
  return `${utilExports.size} 个导出`
})

check('没有文件漏掉 util.js 的导入', () => {
  const problems = []

  for (const file of files) {
    if (file === 'util.js') continue
    const code = fs.readFileSync(path.join(SRC, file), 'utf8')
    const imported = importedNames(code)

    // 只看 util.js 里导出的名字，别扫所有名字——那会误报（比如局部变量重名）
    for (const name of utilExports) {
      // 作为函数被调用，或者作为对象被取属性
      const callPattern = new RegExp(`(^|[^\\w.$])${name}\\s*\\(`, 'm')
      const propPattern = new RegExp(`(^|[^\\w.$])${name}\\.[a-z]`, 'm')
      const used = callPattern.test(code) || propPattern.test(code)
      if (!used) continue

      // 本文件自己定义了同名函数就不算
      const selfDefined = new RegExp(`(function|const|let|var)\\s+${name}\\b`).test(code)
      if (selfDefined) continue

      if (!imported.has(name)) problems.push(`${file}: ${name}`)
    }
  }

  assert(
    problems.length === 0,
    `以下地方用了却没导入：\n      ${problems.join('\n      ')}`,
  )
  return `${files.length - 1} 个文件都干净`
})

check('每个源文件的 import 路径都存在', () => {
  const problems = []
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8')
    for (const m of code.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.resolve(SRC, m[1])
      if (!fs.existsSync(target)) problems.push(`${file} → ${m[1]}`)
    }
  }
  assert(problems.length === 0, `找不到的模块：${problems.join('、')}`)
  return '全部存在'
})

check('每个源文件语法干净、没有顶层 await', () => {
  // 这一项只做静态部分：真正的加载由各模块自己的测试覆盖。
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8')
    // 这些模块是被 import 的，不该有顶层 await
    assert(!/^await /m.test(code), `${file} 里有顶层 await`)
  }
  return `${files.length} 个文件`
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
