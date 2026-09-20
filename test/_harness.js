/**
 * 极简测试框架。
 *
 * 为什么要专门写一个：测试文件需要能被两种方式运行——
 *   1. 单独跑：node test/xxx.js
 *   2. 被聚合器同进程导入：node test/all.js
 *
 * 用子进程聚合是行不通的：这个环境（以及很多沙箱）不允许
 * 通过管道捕获子进程输出（spawn 会 EPERM）。
 * 所以聚合器只能同进程 import，而模块级常量拿不到结果——
 * 状态必须挂在一个能被导入方读到的对象上。
 *
 * 数据目录的隔离不在这里做，由 test/all.js 通过 FRIEND_DATA_DIR
 * 环境变量注入（PATHS 是模块加载时计算的，所以必须在 import 之前设好）。
 */

/** 每个套件的统计挂在这里，聚合器读它 */
export const results = new Map()

/**
 * 建一个套件。
 * @param {string} name 套件名，聚合器会显示
 */
export function suite(name) {
  const state = { name, pass: 0, fail: 0, failures: [] }
  results.set(name, state)

  return {
    state,

    /** 跑一项检查。fn 可以返回一段说明文字，也可以抛错表示失败。 */
    check(label, fn) {
      try {
        const detail = fn()
        state.pass++
        console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
      } catch (err) {
        state.fail++
        state.failures.push({ label, message: err.message })
        console.log(`  ✗ ${label} — ${err.message}`)
      }
    },

    /** 异步版的 check */
    async checkAsync(label, fn) {
      try {
        const detail = await fn()
        state.pass++
        console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
      } catch (err) {
        state.fail++
        state.failures.push({ label, message: err.message })
        console.log(`  ✗ ${label} — ${err.message}`)
      }
    },

    /** 打印小结，返回是否有失败 */
    finish() {
      console.log(`\n结果：${state.pass} 通过 / ${state.fail} 失败\n`)
      return state.fail === 0
    },
  }
}

/** 断言，失败就抛错 */
export function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/**
 * 这个文件是不是被直接执行的（而不是被 import 的）。
 *
 * 不能用 import.meta.main：Node 24 里默认导出下不可靠。
 * 用 argv 比对既简单又不会误判。
 */
export function isMain(importMetaUrl) {
  try {
    if (!process.argv[1]) return false
    const current = new URL(importMetaUrl)
    const invoked = new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`)
    return current.pathname.toLowerCase() === invoked.pathname.toLowerCase()
  } catch {
    return false
  }
}

/** 直接执行时的收尾：打印小结并按失败数设置退出码 */
export function exitWith(state) {
  const ok = state.fail === 0
  process.exit(ok ? 0 : 1)
}
