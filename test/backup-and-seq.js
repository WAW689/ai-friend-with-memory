/**
 * 备份与消息序号的安全网测试。
 *
 * 这两件事都属于"平时不显眼，出事就很严重"：
 * - 备份写坏了，等你真需要恢复时才发现是空的
 * - seq 撞号，等你按序号定位消息时才发现对不上
 *
 * 用法：node test/backup-and-seq.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import { runBackup, listBackups, BACKUP_ROOT, KEEP_DAYS } from '../src/backup.js'
import { store } from '../src/storage.js'

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

console.log('\n备份\n')

check('能生成一份备份', () => {
  const result = runBackup({ force: true })
  assert(result.created === true, `没有创建：${result.reason}`)
  assert(fs.existsSync(result.dir), '备份目录不存在')
  return `${result.fileCount} 个文件，${Math.round(result.bytes / 1024)} KB`
})

check('备份里有关键文件，而且不是空的', () => {
  const result = runBackup({ force: true })
  const required = ['messages.jsonl', 'memory.md', 'persona.md']
  for (const name of required) {
    const target = path.join(result.dir, name)
    assert(fs.existsSync(target), `缺少 ${name}`)
    const size = fs.statSync(target).size
    assert(size > 0, `${name} 是空文件`)
  }
  return required.join(' / ') + ' 都在且非空'
})

check('备份的消息条数和原始一致', () => {
  const result = runBackup({ force: true })
  const backupFile = path.join(result.dir, 'messages.jsonl')
  const rows = fs.readFileSync(backupFile, 'utf8').trim().split('\n').filter(Boolean)
  const original = fs.readFileSync(PATHS.messages, 'utf8').trim().split('\n').filter(Boolean)
  assert(rows.length === original.length, `条数不一致：备份 ${rows.length} / 原始 ${original.length}`)
  // 抽查第一条能解析
  const first = JSON.parse(rows[0])
  assert(typeof first.seq === 'number', '备份里的消息缺 seq')
  return `${rows.length} 条一致`
})

check('同一天重复备份不会堆出多份', () => {
  const before = listBackups().length
  runBackup({ force: true })
  runBackup({ force: true })
  const after = listBackups().length
  assert(after === before, `备份份数从 ${before} 变成 ${after}`)
  return `${after} 份（按日期覆盖）`
})

check('备份目录独立于 data，删 data 不会连带删掉备份', () => {
  assert(!BACKUP_ROOT.startsWith(PATHS.data), `备份放在了 data 里面：${BACKUP_ROOT}`)
  return BACKUP_ROOT
})

check('备份清单能读出条数', () => {
  const list = listBackups()
  assert(list.length >= 1, '读不到任何备份')
  const newest = list[0]
  assert(typeof newest.messageRows === 'number', '清单里没有消息条数')
  return `${newest.date}：${newest.messageRows} 条`
})

console.log('\n消息序号\n')

check('seq 从文件尾部读取，别的进程写过也不会撞号', () => {
  store.load()
  const original = fs.readFileSync(PATHS.messages, 'utf8')

  try {
    const lastSeq = store.messages[store.messages.length - 1].seq
    // 模拟另一个进程（比如 CLI）先写了一条更大的号
    const foreign = { seq: lastSeq + 100, at: Date.now(), role: 'assistant', text: '（外来消息）', kind: 'chat' }
    fs.appendFileSync(PATHS.messages, `${JSON.stringify(foreign)}\n`)

    const mine = store.append({ role: 'user', text: '（本进程写入）' })
    assert(mine.seq > foreign.seq, `seq 回退了：${mine.seq} <= ${foreign.seq}`)
    return `外来 seq=${foreign.seq}，本进程拿到 ${mine.seq}`
  } finally {
    // 还原文件，别把测试数据留在真实记录里
    fs.writeFileSync(PATHS.messages, original, 'utf8')
    store.load()
  }
})

check('seq 单调递增', () => {
  const original = fs.readFileSync(PATHS.messages, 'utf8')
  try {
    const a = store.append({ role: 'user', text: '（测试1）' })
    const b = store.append({ role: 'assistant', text: '（测试2）' })
    const c = store.append({ role: 'user', text: '（测试3）' })
    assert(b.seq > a.seq && c.seq > b.seq, `没有递增：${a.seq}, ${b.seq}, ${c.seq}`)
    return `${a.seq} → ${b.seq} → ${c.seq}`
  } finally {
    fs.writeFileSync(PATHS.messages, original, 'utf8')
    store.load()
  }
})

check('文件尾部有半截坏行时仍能取到正确序号', () => {
  const original = fs.readFileSync(PATHS.messages, 'utf8')
  try {
    store.load()
    const before = store.messages[store.messages.length - 1].seq
    // 追加一个被截断的半行（模拟写入过程中断电）
    fs.appendFileSync(PATHS.messages, '{"seq":999999,"at":123,"role":"user","te')
    const mine = store.append({ role: 'user', text: '（坏行之后写入）' })
    assert(mine.seq === before + 1, `序号不对：期望 ${before + 1}，得到 ${mine.seq}`)
    return `坏行被跳过，序号 ${before} → ${mine.seq}`
  } finally {
    fs.writeFileSync(PATHS.messages, original, 'utf8')
    store.load()
  }
})

check('删除消息文件后仍能正常工作', () => {
  const original = fs.readFileSync(PATHS.messages, 'utf8')
  try {
    fs.writeFileSync(PATHS.messages, '', 'utf8')
    store.load()
    const msg = store.append({ role: 'user', text: '（空文件后的第一条）' })
    assert(msg.seq === 1, `空文件后第一条应为 seq=1，得到 ${msg.seq}`)
    return '从 1 重新开始'
  } finally {
    fs.writeFileSync(PATHS.messages, original, 'utf8')
    store.load()
  }
})

console.log('\n保留策略\n')

check(`最多保留 ${KEEP_DAYS} 天`, () => {
  const list = listBackups()
  assert(list.length <= KEEP_DAYS, `有 ${list.length} 份，超过了 ${KEEP_DAYS}`)
  return `当前 ${list.length} 份`
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
