/**
 * 把 data/ 下的三个"文本资产"恢复成出厂默认（重新读 config.js 里的常量）。
 * 用法：node src/reset.js [persona|memory|summary|all]
 *
 * 聊天记录（messages.jsonl）不会被碰，要清空请手动删文件。
 */
import fs from 'node:fs'
import { DEFAULT_MEMORY, DEFAULT_PERSONA, PATHS } from './config.js'
import { log } from './util.js'

const what = process.argv[2] ?? 'all'

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
