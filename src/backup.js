/**
 * 自动备份。
 *
 * 要保住的东西：聊天记录 + 记忆档案 + 人设 + 头像。
 * 这些是这个项目里唯一**无法重新生成**的资产——
 * 代码可以重装、配置可以重填，但 200 多条对话和它对你的记忆丢了就没了。
 *
 * 策略：每天一份，保留最近 N 份，按日期命名（同一天重复备份会覆盖，不会堆成一堆）。
 *
 * 为什么不用复制整个 data 目录：
 * data/ 里还有 push.log、summary.json 这类可再生的东西，
 * 而且直接复制文件可能撞上正在写入的瞬间。这里改为逐行读取——
 * 坏行会被跳过，备份不会因为一行半截数据而整体失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.js'
import { localDateKey, log, now, readJsonl, writeJsonAtomic } from './util.js'

/** 备份放在 data 之外：data 被误删时备份还能活着 */
const BACKUP_ROOT = path.join(PATHS.root, 'backups')
const KEEP_DAYS = 14

function backupDir(dateKey) {
  return path.join(BACKUP_ROOT, dateKey)
}

/**
 * 备份一次。
 * @param {{ force?: boolean }} options force=true 时同一天也重写
 * @returns {{ created: boolean, dir?: string, fileCount?: number, bytes?: number, reason?: string, dateKey: string }}
 */
export function runBackup(options = {}) {
  const dateKey = localDateKey()
  const dir = backupDir(dateKey)
  const marker = path.join(dir, 'manifest.json')

  if (!options.force && fs.existsSync(marker)) {
    return { created: false, reason: '今天已经备份过', dir, dateKey }
  }

  fs.mkdirSync(dir, { recursive: true })

  const copied = []
  let bytes = 0

  /** 逐行复制 JSONL，跳过坏行——避免把半截写入的数据带进备份 */
  const copyJsonl = (source, target) => {
    const rows = readJsonl(source)
    const text = rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : ''
    fs.writeFileSync(target, text, 'utf8')
    return { rows: rows.length, size: Buffer.byteLength(text) }
  }

  /* ---- 聊天记录（最重要） ---- */
  if (fs.existsSync(PATHS.messages)) {
    const result = copyJsonl(PATHS.messages, path.join(dir, 'messages.jsonl'))
    copied.push({ file: 'messages.jsonl', rows: result.rows, bytes: result.size })
    bytes += result.size
  }

  /* ---- 记忆、人设、摘要、头像、生活 ---- */
  const plainFiles = [
    ['memory.md', PATHS.memory],
    ['persona.md', PATHS.persona],
    ['summary.json', PATHS.summary],
    ['avatar.json', path.join(PATHS.data, 'avatar.json')],
    ['state.json', PATHS.state],
    /*
     * 它自己的生活。
     *
     * 流水跟聊天记录一样属于"发生过就不能重来"的东西——
     * 丢了它就会变回"今天才出生"，之前几天的经历全部作废。
     * 生活设定也一样，那是它这个人的底子。
     */
    ['life.md', PATHS.life],
    ['life-arcs.json', PATHS.lifeArcs],
    ['life.jsonl', PATHS.journal],
    /*
     * 她怎么看待自己。
     *
     * 这个比 life.jsonl 更该备份：它是**唯一一份会自动改写**的设定。
     * 流水是追加的，写坏了顶多丢几行；self.md 是整体覆盖写的，
     * 一旦长歪了又没有历史版本，就只能眼睁睁看着。
     * 变更流水也带上——那是"她是怎么一步步变成现在这样"的记录。
     */
    ['self.md', PATHS.self],
    ['self-changelog.jsonl', PATHS.selfChangelog],
  ]
  for (const [name, source] of plainFiles) {
    if (!fs.existsSync(source)) continue
    try {
      const content = fs.readFileSync(source, 'utf8')
      fs.writeFileSync(path.join(dir, name), content, 'utf8')
      copied.push({ file: name, bytes: Buffer.byteLength(content) })
      bytes += Buffer.byteLength(content)
    } catch (err) {
      log.warn(`备份 ${name} 失败：${err.message}`)
    }
  }

  /*
   * 她的自我快照目录（多个 .md）。
   *
   * 这是"回退任意一版"的底料，比当前版本更值钱——
   * self.md 只有现在，快照里有她这一路的样子。
   */
  try {
    if (fs.existsSync(PATHS.selfSnapshots)) {
      const names = fs.readdirSync(PATHS.selfSnapshots).filter((f) => f.endsWith('.md'))
      if (names.length) {
        const snapDir = path.join(dir, 'self-snapshots')
        fs.mkdirSync(snapDir, { recursive: true })
        let snapBytes = 0
        for (const n of names) {
          const content = fs.readFileSync(path.join(PATHS.selfSnapshots, n), 'utf8')
          fs.writeFileSync(path.join(snapDir, n), content, 'utf8')
          snapBytes += Buffer.byteLength(content)
        }
        copied.push({ file: `self-snapshots/（${names.length} 份）`, bytes: snapBytes })
        bytes += snapBytes
      }
    }
  } catch (err) {
    log.warn(`备份自我快照失败：${err.message}`)
  }

  writeJsonAtomic(marker, {
    at: now(),
    date: dateKey,
    files: copied,
    totalBytes: bytes,
    source: PATHS.data,
  })

  pruneOldBackups()

  log.info(`已备份 ${copied.length} 个文件到 backups/${dateKey}/（${Math.round(bytes / 1024)} KB）`)
  return { created: true, dir, fileCount: copied.length, bytes, dateKey }
}

/** 只保留最近 KEEP_DAYS 天 */
function pruneOldBackups() {
  let entries
  try {
    entries = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
  } catch {
    return
  }
  const days = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()

  while (days.length > KEEP_DAYS) {
    const oldest = days.shift()
    try {
      fs.rmSync(path.join(BACKUP_ROOT, oldest), { recursive: true, force: true })
      log.info(`已清理过期备份：${oldest}`)
    } catch (err) {
      log.warn(`清理备份 ${oldest} 失败：${err.message}`)
    }
  }
}

/** 列出所有备份，供 CLI / 接口展示 */
export function listBackups() {
  let entries
  try {
    entries = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => {
      const dir = path.join(BACKUP_ROOT, e.name)
      const manifestPath = path.join(dir, 'manifest.json')
      let manifest = null
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch {
        /* 没有 manifest 也照样列出来 */
      }
      let bytes = 0
      try {
        for (const f of fs.readdirSync(dir)) {
          bytes += fs.statSync(path.join(dir, f)).size
        }
      } catch {
        /* 忽略 */
      }
      return {
        date: e.name,
        dir,
        bytes,
        at: manifest?.at ?? null,
        files: manifest?.files?.length ?? null,
        messageRows: manifest?.files?.find((f) => f.file === 'messages.jsonl')?.rows ?? null,
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date))
}

export { BACKUP_ROOT, KEEP_DAYS }
