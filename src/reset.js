/**
 * 把 data/ 下的文本资产恢复成出厂默认。
 *
 * 用法：node src/reset.js [persona|memory|summary|all] [--force]
 *
 * 聊天记录（messages.jsonl）不会被碰，要清空请手动删文件。
 *
 * ── 两处防护，都是踩出来的 ──────────────────────────────────
 *
 * 1. **只能在被直接运行时才执行**。
 *    原来这些写盘逻辑裸在模块顶层，于是"import 一下"就等于执行了重置。
 *    后果真实发生过：一个"检查所有源文件能不能加载"的工具会 import 整个
 *    src/，结果它每跑一次就把用户真实的 persona.md 洗成出厂的「阿岚」、
 *    memory.md 洗成空模板。用户的天狼星和几十条记忆就这么没了。
 *
 * 2. **对真实数据要多加一道 --force**。
 *    重置是不可逆的（除了翻备份）。而当 FRIEND_DATA_DIR 指向 test/tmp 时
 *    是测试，随便重置；指向真实 data/ 时必须显式确认。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MEMORY, DEFAULT_PERSONA, PATHS, ROOT } from './config.js'
import { log } from './util.js'

/** 这个文件是不是被直接执行的（而不是被 import 的） */
function isDirectRun() {
  try {
    if (!process.argv[1]) return false
    const invoked = path.resolve(process.argv[1])
    const self = fileURLToPath(import.meta.url)
    return path.resolve(self) === invoked
  } catch {
    return false
  }
}

/** 数据目录是不是项目里那个真实的 data/ */
function isRealDataDir() {
  return path.resolve(PATHS.data) === path.resolve(ROOT, 'data')
}

function main() {
  const what = process.argv[2] ?? 'all'
  const force = process.argv.includes('--force')

  if (isRealDataDir() && !force) {
    console.error('')
    console.error('  ✋ 停一下 —— 你要重置的是**真实的 data/ 目录**。')
    console.error('')
    console.error('     人设和记忆重置后不可逆（只能翻 backups/ 找回）。')
    console.error(`     目标：${PATHS.data}`)
    console.error('')
    console.error('     确实要重置就加 --force：')
    console.error(`       node src/reset.js ${what} --force`)
    console.error('')
    console.error('     只是想备份一下再重置：node src/cli.js backup --now')
    console.error('')
    process.exit(1)
  }

  if (what === 'persona' || what === 'all') {
    fs.writeFileSync(PATHS.persona, DEFAULT_PERSONA, 'utf8')
    log.info('人设已恢复默认')
  }
  if (what === 'memory' || what === 'all') {
    fs.writeFileSync(PATHS.memory, DEFAULT_MEMORY, 'utf8')
    log.info('记忆已恢复默认')
  }
  if (what === 'summary' || what === 'all') {
    fs.writeFileSync(PATHS.summary, JSON.stringify({ text: '', upToSeq: 0 }) + '\n', 'utf8')
    log.info('摘要已清空')
  }
}

if (isDirectRun()) {
  main()
}
