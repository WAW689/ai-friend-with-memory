/**
 * 命令行工具。不想手改 config.json 就用它。
 *
 *   node src/cli.js check                  看还缺什么
 *   node src/cli.js key sk-xxxx            设置 DeepSeek API Key
 *   node src/cli.js bark <bark-key>        设置 Bark Key
 *   node src/cli.js test-model             验证模型连通
 *   node src/cli.js test-bark              发一条测试推送
 *   node src/cli.js say "你好"             直接在服务端发一句话，看它怎么回
 *   node src/cli.js wake                   立刻跑一次主动判断
 *   node src/cli.js wake --force           跳过所有判断，强制它发一条
 *   node src/cli.js token                  显示访问口令
 */
import { checkReadiness, loadConfig, saveConfig, PATHS } from './config.js'
import { testPush, push } from './bark.js'
import { BACKUP_ROOT, listBackups, runBackup } from './backup.js'
import { imageStats } from './images.js'
import { hasLife, lastActivityAt, liveOneRound, readArcs, readJournal, readLife, shouldLive } from './life.js'
import { characterName, respond, runProactiveCheck, proactiveGate, extractMemory, readMemory, readProactiveEvents } from './engine.js'
import { verifyKey } from './llm.js'
import { store } from './storage.js'
import { appendJsonl, humanAgo, localDateKey, log, now } from './util.js'

const [command, ...args] = process.argv.slice(2)
const cfg = loadConfig()

function needStore() {
  store.load()
  return store
}

function mask(value, keep = 6) {
  const s = String(value ?? '')
  if (!s) return '（未设置）'
  if (s.length <= keep * 2) return `${s.slice(0, 3)}***`
  return `${s.slice(0, keep)}…${s.slice(-4)}`
}

/** cctl 的稳定输出格式：每行 "KEY|值"，多行值用 \n 转义 */
function out(key, value) {
  console.log(`${key}|${String(value ?? '').replace(/\r?\n/g, '\\n')}`)
}

const commands = {
  async check() {
    store.load()
    console.log('')
    console.log('配置状态')
    console.log(`  DeepSeek Key   ${mask(cfg.model.apiKey)}`)
    console.log(`  聊天模型       ${cfg.model.chatModel}`)
    console.log(`  Bark Key       ${mask(cfg.bark.key)}`)
    console.log(`  Bark 服务      ${cfg.bark.server}`)
    console.log(`  监听地址       ${cfg.host}:${cfg.port}`)
    console.log(`  访问口令       ${cfg.accessToken}`)
    console.log(`  历史消息       ${store.messages.length} 条`)
    console.log(`  主动消息       ${cfg.proactive.enabled ? '开' : '关'}`)
    const gate = proactiveGate(cfg)
    console.log(`  现在能不能发   ${gate.allowed ? '可以' : `不行（${gate.reason}）`}`)
    const problems = checkReadiness(cfg)
    console.log('')
    if (problems.length) {
      console.log('还缺：')
      for (const p of problems) console.log(`  · ${p}`)
    } else {
      console.log('✓ 配置完整')
    }
    console.log('')
  },

  async key() {
    const value = args[0]
    if (!value) return console.error('用法：node src/cli.js key sk-xxxx')
    saveConfig({ model: { apiKey: value } })
    console.log('已保存 DeepSeek API Key。')
  },

  async bark() {
    const value = args[0]
    if (!value) return console.error('用法：node src/cli.js bark <Bark Key>')
    saveConfig({ bark: { key: value } })
    console.log('已保存 Bark Key。发一条测试推送…')
    const result = await testPush(loadConfig())
    console.log(result.ok ? '✓ 推送成功，看下手机' : `✗ 推送失败：${result.message}`)
  },

  async token() {
    console.log(cfg.accessToken)
  },

  async 'test-model'() {
    console.log('正在请求 DeepSeek…')
    const result = await verifyKey(cfg)
    console.log(result.ok ? '✓ 模型可用' : `✗ ${result.message}`)
  },

  async 'test-bark'() {
    const result = await testPush(cfg)
    console.log(result.ok ? '✓ 推送成功' : `✗ ${result.message}`)
  },

  /*
   * 这里曾经有 bark-last 和 bark-preview 两个命令，
   * 作用是把聊天记录里的消息推到手机预览效果。
   *
   * 删掉的原因：它们会把**用户自己说的话**推回给用户，
   * 而且因为是手动命令，很容易在调试时反复执行。
   * 实测用户手机上收到了自己发的"看我的猫"，连收十几遍。
   *
   * 要确认推送效果，用 test-bark（推固定文案，不碰聊天记录），
   * 或者等一次真实的主动消息。
   */

  /** 在服务端直接聊一句，方便不开浏览器时验证 */
  async say() {
    const text = args.join(' ').trim()
    if (!text) return console.error('用法：node src/cli.js say "你好"')
    needStore()
    process.stdout.write('它：')
    const { message } = await respond(text, {
      onChunk: (delta) => process.stdout.write(delta),
    })
    process.stdout.write('\n')
    if (!message.text) console.log('（空回复）')
  },

  async wake() {
    needStore()
    const force = args.includes('--force')
    const dryRun = args.includes('--dry-run')
    const result = await runProactiveCheck({ force, dryRun })
    if (result.sent) {
      console.log(`✓ 已发出 ${result.messages.length} 条：`)
      for (const m of result.messages) console.log(`    ${m}`)
    } else if (result.dryRun) {
      console.log('（演练模式）本来会发：')
      for (const m of result.wouldSend ?? []) console.log(`    ${m}`)
    } else {
      console.log(`这次没发。原因：${result.reason}`)
    }
  },

  async memory() {
    needStore()
    console.log(readMemory())
  },

  async 'extract-memory'() {
    needStore()
    const result = await extractMemory(cfg)
    console.log(result.updated ? '✓ 记忆已更新：\n' : `没更新：${result.reason}`)
    if (result.updated) console.log(result.memory)
  },

  /**
   * 给 DSH 动态插件用的结构化入口。
   * 插件不能直接发 HTTP（沙箱里没有 fetch），所以它 spawn 这个命令，
   * 由 CLI 去调本地服务，再把结果以稳定格式打印出来。
   * 每行以 "KEY|" 开头，插件负责解析。
   */
  async cctl() {
    const entity = args[0]
    const token = cfg.accessToken
    const base = `http://127.0.0.1:${cfg.port}`

    const call = async (path, options = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      })
      const text = await res.text()
      let data
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { raw: text.slice(0, 300) }
      }
      if (!res.ok) throw new Error(data.error ?? `服务返回 ${res.status}`)
      return data
    }

    if (entity === 'status') {
      const data = await call('/api/app')
      const snap = data.snapshot ?? {}
      const policy = data.config?.proactive ?? {}
      const pro = snap.proactive ?? {}
      out('OK', '1')
      out('UNREAD', snap.unread ?? 0)
      out('TOTAL', snap.lastSeq ?? 0)
      out('ENABLED', policy.enabled ? '1' : '0')
      out('QUIET', `${policy.quietStart}-${policy.quietEnd}`)
      out('GAP', `${policy.minGapMinutes}-${policy.maxGapMinutes}`)
      out('TODAY', pro.todayCount ?? 0)
      out('TODAY_MAX', policy.maxPerDay ?? 0)
      out('STREAK', pro.unansweredStreak ?? 0)
      out('STREAK_MAX', policy.maxUnanswered ?? 0)
      out('NEXT_AT', pro.nextAt ?? 0)
      out('HOLD', pro.lastHoldReason ?? '')
      out('MISSING', (data.readiness ?? []).join('；'))
      out('PERSONA', (data.persona ?? '').replace(/\s+/g, ' ').slice(0, 400))
      return
    }

    if (entity === 'persona') {
      if (args[1] === 'set') {
        const value = args.slice(2).join(' ')
        await call('/api/persona', { method: 'PUT', body: { persona: value } })
        out('OK', '1')
        out('LENGTH', value.length)
      } else {
        const data = await call('/api/persona')
        out('OK', '1')
        out('PERSONA', data.persona ?? '')
      }
      return
    }

    if (entity === 'memory') {
      if (args[1] === 'set') {
        const value = args.slice(2).join(' ')
        await call('/api/memory', { method: 'PUT', body: { memory: value } })
        out('OK', '1')
      } else if (args[1] === 'extract') {
        const data = await call('/api/memory/extract', { method: 'POST', body: {} })
        out('OK', '1')
        out('UPDATED', data.updated ? '1' : '0')
        out('MEMORY', data.memory ?? '')
        out('REASON', data.reason ?? '')
      } else {
        const data = await call('/api/memory')
        out('OK', '1')
        out('MEMORY', data.memory ?? '')
        out('SUMMARY', data.summary?.text ?? '')
      }
      return
    }

    if (entity === 'push-test') {
      const data = await call('/api/test/bark', { method: 'POST', body: {} })
      out('OK', data.ok ? '1' : '0')
      out('MESSAGE', data.message ?? '')
      return
    }

    if (entity === 'send') {
      const value = args.slice(1).join(' ')
      if (!value.trim()) throw new Error('send 需要正文')
      const data = await call('/api/send', { method: 'POST', body: { text: value } })
      out('OK', '1')
      out('REPLY', data.reply ?? '')
      return
    }

    if (entity === 'wake') {
      const mode = args[1] ?? 'auto'
      const data = await call('/api/proactive/run', {
        method: 'POST',
        body: { force: mode === 'force', dryRun: mode === 'dry' },
      })
      out('OK', '1')
      out('SENT', data.sent ? '1' : '0')
      out('DRY', data.dryRun ? '1' : '0')
      out('REASON', data.reason ?? '')
      out('MESSAGES', (data.messages ?? []).join(' ||| '))
      out('WOULD_SEND', (data.wouldSend ?? []).join(' ||| '))
      return
    }

    if (entity === 'proactive') {
      const data = await call('/api/app')
      const current = data.config?.proactive ?? {}
      const allowed = ['enabled', 'quietStart', 'quietEnd', 'minGapMinutes', 'maxGapMinutes', 'maxPerDay', 'maxUnanswered', 'minIdleMinutes', 'doubleTextChance', 'letModelDecide']
      const patch = {}
      for (const pair of args.slice(1)) {
        const idx = pair.indexOf('=')
        if (idx === -1) continue
        const key = pair.slice(0, idx)
        const rawValue = pair.slice(idx + 1)
        if (!allowed.includes(key)) continue
        patch[key] = rawValue === 'true' ? true : rawValue === 'false' ? false : Number(rawValue)
      }
      if (Object.keys(patch).length > 0) {
        await call('/api/config', { method: 'PUT', body: { proactive: { ...current, ...patch } } })
      }
      const after = await call('/api/app')
      const next = after.config?.proactive ?? {}
      out('OK', '1')
      for (const key of allowed) out(key.toUpperCase(), next[key] ?? '')
      return
    }

    throw new Error(`cctl 不认识这个对象：${entity}`)
  },

  /** 图片占用情况 */
  async images() {
    const stats = imageStats()
    console.log('')
    console.log(`  图片目录    ${stats.dir}`)
    console.log(`  张数        ${stats.count}`)
    console.log(`  占用        ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`)
    console.log(`  天数        ${stats.days} 个日期目录`)
    console.log('')
    if (stats.count === 0) {
      console.log('  还没有发过图片。')
    } else {
      console.log('  清理：直接删 data/images/ 下不需要的日期目录即可。')
      console.log('  注意：删掉图片后，聊天记录里对应的消息只剩文字，模型也就看不到那张图了。')
    }
    console.log('')
  },

  /** 看它自己在过什么日子 */
  async life() {
    const lifeText = readLife()
    const journal = readJournal()
    const arcs = readArcs()

    console.log('')
    if (!lifeText.trim()) {
      console.log('  还没有生活设定。它现在没有"自己的生活"。')
      console.log('  文件位置：data/life.md')
      console.log('')
      return
    }

    console.log(`  生活设定   ${lifeText.length} 字（data/life.md）`)
    console.log(`  流水       ${journal.length} 件事`)
    console.log(`  推进中     ${arcs.length} 条线索`)
    console.log('')

    if (arcs.length) {
      console.log('  它最近在推进的事：')
      for (const a of arcs) console.log(`    · ${a.text}`)
      console.log('')
    }

    const recent = journal.slice(-15).reverse()
    if (recent.length) {
      console.log('  最近经历的事（新的在前）：')
      for (const e of recent) {
        const d = new Date(e.at)
        const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        const day = new Date().toDateString() === d.toDateString()
          ? '今天'
          : `${d.getMonth() + 1}/${d.getDate()}`
        console.log(`    ${day} ${t}  ${e.text}`)
      }
    } else {
      console.log('  流水是空的——它还没有经历过任何事。')
      console.log('  跑 node src/cli.js live-now 立刻让它过一段日子。')
    }
    console.log('')
  },

  /** 立刻让它过一段日子（会调用模型） */
  async 'live-now'() {
    const cfg = loadConfig()
    const count = Number(args[0]) || 1
    console.log(`  正在生成 ${count} 件事…`)
    const result = await liveOneRound({ count })
    if (!result.ok) {
      console.log(`  ✗ ${result.reason}`)
      return
    }
    console.log('  ✓ 记下了：')
    for (const e of result.activities) console.log(`      ${e.text}`)
    console.log('')
  },

  /** 看现在该不该"过日子"，以及为什么 */
  async 'life-status'() {
    const cfg = loadConfig()
    needStore()
    const verdict = shouldLive(cfg, store.state)
    console.log('')
    console.log(`  生活功能     ${cfg.life.enabled ? '开启' : '关闭'}`)
    console.log(`  有没有设定   ${hasLife() ? '有' : '没有（data/life.md）'}`)
    console.log(`  流水条数     ${readJournal().length}`)
    const last = lastActivityAt()
    console.log(`  上次经历     ${last ? humanAgo(last) : '从未'}`)
    console.log(`  对方上次说话 ${store.state.lastUserMessageAt ? humanAgo(store.state.lastUserMessageAt) : '从未'}`)
    console.log('')
    console.log(`  现在该过吗   ${verdict.ok ? '✓ 该' : '✗ 不该（' + verdict.reason + '）'}`)
    console.log('')
    console.log('  触发条件：对方安静足够久、距上次经历够久、且不在静默时段')
    console.log('')
  },

  /**
   * 看"她眼里的现在"是什么样。
   *
   * 这个命令的价值在于：她会不会说错日期、会不会把中秋说成别的日子、
   * 会不会在大白天说"大半夜的"——这些都能在这里一眼看出来，
   * 不用去翻提示词拼装代码。
   */
  async now() {
    const cfg = loadConfig()
    const { describeNow, solarToLunar, nextHoliday, holidayOn } = await import('./almanac.js')
    const { getWeather, describeWeather, peekSunTimes } = await import('./weather.js')

    // 命令行下可以真的联网取一次（比聊天路径更宽松）
    const w = await getWeather(cfg, { force: args.includes('--refresh') })
    const sun = w?.sunrise ? { sunrise: w.sunrise, sunset: w.sunset } : peekSunTimes()

    console.log('')
    console.log('  ── 她眼里的现在 ──')
    for (const line of describeNow(new Date(), sun).split('\n')) console.log('  ' + line)
    console.log('')

    console.log('  ── 天气 ──')
    if (!cfg.weather.enabled) {
      console.log('  已关闭（FRIEND_WEATHER=0）')
    } else if (describeWeather(w)) {
      console.log('  ' + describeWeather(w))
      if (w.sunrise) console.log(`  日出 ${w.sunrise}  日落 ${w.sunset}`)
      console.log(`  位置 ${cfg.weather.latitude}, ${cfg.weather.longitude}`)
      console.log('  加 --refresh 强制重新拉一次')
    } else {
      console.log('  没取到（断网或接口不可用）')
      console.log('  她不会因此说错话——拿不到就完全不提天气。')
    }
    console.log('')

    console.log('  ── 接下来几个节日 ──')
    /*
     * 迭代方式要小心：不能把游标直接挪到"这个假期结束后的第一天"。
     *
     * 因为 nextHoliday 对"已经在放、或放到一半的假期"是**整段跳过**的
     * （那是它该有的行为——站在假期里问"下一个节日"不该回答正在过的这个）。
     * 但拿它来列清单时，从 9/28 往后看就会把国庆（10/1-10/7）当成
     * "从 10/1 开始的新假期"，于是显示"还有 3 天"而不是真实的 9 天。
     *
     * 所以这里改成一天一天往前挪游标：跳过已经列过的那个假期的最后一天，
     * 而不是跳到"假期结束的下一天"。
     */
    let cursor = new Date()
    const listed = []
    for (let i = 0; i < 4; i++) {
      const next = nextHoliday(cursor)
      if (!next) {
        console.log('  内置数据只覆盖 2025-2026，往后的没有了（那就什么都不提）')
        break
      }
      if (listed.includes(next.dateKey)) break
      listed.push(next.dateKey)

      const span = next.span > 1 ? `，放假 ${next.span} 天（到 ${next.last}）` : ''
      console.log(`  ${next.name}  ${next.dateKey}  还有 ${next.daysAway} 天${span}`)

      // 游标挪到"这个假期的最后一天"，下一次调用就会去找它之后的假期
      cursor = new Date(new Date(next.last + 'T12:00:00').getTime())
    }
    console.log('')
  },

  /** 列出 / 触发备份 */
  async backup() {
    const force = args.includes('--force')
    if (args.includes('--now') || force) {
      const result = runBackup({ force: true })
      console.log(result.created
        ? `✓ 已备份 ${result.fileCount} 个文件到 backups/${result.dateKey}/（${Math.round(result.bytes / 1024)} KB）`
        : `未备份：${result.reason}`)
    }
    const list = listBackups()
    console.log('')
    if (list.length === 0) {
      console.log('  还没有任何备份。跑 node src/cli.js backup --now 立刻备一份。')
      return
    }
    console.log(`  现有备份（${list.length} 份，位于 ${BACKUP_ROOT}）：`)
    for (const b of list) {
      const when = b.at ? new Date(b.at).toLocaleString('zh-CN') : '(无记录)'
      console.log(`    ${b.date}   ${String(Math.round(b.bytes / 1024)).padStart(5)} KB   ` +
        `${b.messageRows ?? '?'} 条消息   ${when}`)
    }
    console.log('')
    console.log('  恢复方法：把某一份备份里的文件复制回 data/ 即可（先停服务）。')
  },

  /**
   * 看主动决策的历史。
   *
   * status 只显示"最近一次"拒绝理由，看不到一整天的模式。
   * 而"它为什么总不找我"恰恰要看历史：是经常被闸门拦住，
   * 还是模型每次都判断"没必要"。
   */
  async history() {
    needStore()
    const limit = Number(args[0]) || 25
    const events = readProactiveEvents(limit)

    if (events.length === 0) {
      console.log('')
      console.log('  还没有任何主动决策记录。')
      console.log('  等它跑过一次判断之后再看（或者跑 node src/cli.js wake 立刻触发一次）。')
      console.log('')
      return
    }

    console.log('')
    console.log(`  最近 ${events.length} 次主动决策（新的在前）`)
    console.log('')

    const today = localDateKey()
    let todaySent = 0
    let todayHold = 0

    for (const e of events) {
      const t = new Date(e.at)
      const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
      const day = localDateKey(e.at) === today ? '' : `${t.getMonth() + 1}/${t.getDate()} `

      if (e.dryRun) {
        console.log(`  ${day}${time}  [演练] ${(e.messages ?? []).join(' / ') || '(没内容)'}`)
      } else if (e.sent) {
        console.log(`  ${day}${time}  ✓ 发出  ${(e.messages ?? []).join(' / ')}${e.forced ? '（强制）' : ''}`)
        if (localDateKey(e.at) === today) todaySent++
      } else {
        console.log(`  ${day}${time}  · 没发  ${e.reason}`)
        if (localDateKey(e.at) === today) todayHold++
      }
    }

    console.log('')
    console.log(`  今天：发出 ${todaySent} 次，没发 ${todayHold} 次`)
    console.log('')

    // 统计一下最常见的拒绝理由，方便判断瓶颈在哪
    const holds = events.filter((e) => !e.sent && !e.dryRun)
    if (holds.length >= 4) {
      const gateHold = holds.filter((e) => String(e.reason).startsWith('[闸门]')).length
      console.log('  没发的原因分布：')
      console.log(`    闸门拦截（时间没到/静默时段/达上限）  ${gateHold} 次`)
      console.log(`    模型判断"现在没必要"                ${holds.length - gateHold} 次`)
      console.log('')
      if (gateHold > holds.length / 2) {
        console.log('  → 主要是被闸门拦的。想更频繁就把「两次间隔」调小。')
      } else {
        console.log('  → 主要是模型自己判断不发。这说明它觉得时机不对，')
        console.log('    不是配置问题——可以把「刚聊完冷静期」调小试试。')
      }
      console.log('')
    }
  },

  /** 立刻让下一次主动窗口到来，并当场判断一次。
   * 不想干等排期时用这个。 */
  async 'wake-now'() {
    needStore()
    store.scheduleNextProactive(0)
    store.state.unansweredStreak = 0
    store.saveStateNow()
    console.log('已把下次窗口拉到当前时刻，并清空"连续未回"计数')
    console.log('调度器会在下一次 tick（最多 60 秒）内处理')
    console.log('想立刻看结果的话，直接跑：node src/cli.js wake')
  },

  /** 清空"连续未回"计数（有时手动测试会把它顶满，导致它一直不肯发） */
  async 'reset-streak'() {
    needStore()
    const before = store.state.unansweredStreak
    store.state.unansweredStreak = 0
    store.saveStateNow()
    console.log(`连续未回计数：${before} → 0`)
  },

  async status() {
    needStore()
    const lastUser = store.lastUserMessage()
    const gate = proactiveGate(cfg)
    console.log('')
    console.log(`  现在            ${new Date().toLocaleString()}`)
    console.log(`  消息总数        ${store.seq}`)
    console.log(`  未读            ${store.unreadCount()}`)
    console.log(`  对方上次说话    ${lastUser ? humanAgo(lastUser.at) : '从未'}`)
    console.log(`  连续没回        ${store.state.unansweredStreak} 条`)
    console.log(`  今天已主动      ${store.proactiveCountToday()} 次`)
    console.log(`  下次窗口        ${store.state.nextProactiveAt ? new Date(store.state.nextProactiveAt).toLocaleString() : '未排期'}`)
    console.log(`  上次没发的原因  ${store.state.lastHoldReason || '（无）'}`)
    console.log(`  现在能发吗      ${gate.allowed ? '能' : `不能（${gate.reason}）`}`)
    console.log('')
  },
}

async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`
朋友 · 命令行工具

  check              检查配置是否完整
  now                看"她眼里的现在"：日期、农历、节日、天气、昼夜
  status             看当前主动消息的排期和拦截原因
  key <sk-xxx>       设置 DeepSeek API Key
  bark <key>         设置 Bark Key 并发一条测试推送
  token              显示访问口令
  test-model         验证模型连通
  test-bark          发一条测试推送
  say "内容"         在服务端直接说一句，看它怎么回
  wake [--force]     立刻跑一次主动判断（--force 跳过所有拦截）
  memory             打印当前的记忆档案
  extract-memory     立刻抽取一次记忆

配置也可以全部用环境变量：DEEPSEEK_API_KEY / BARK_KEY / FRIEND_PORT / FRIEND_ACCESS_TOKEN
`)
    return
  }

  const handler = commands[command]
  if (!handler) {
    console.error(`没有这个命令：${command}（试试 node src/cli.js help）`)
    process.exitCode = 1
    return
  }

  try {
    await handler()
  } catch (err) {
    log.error(err.message)
    process.exitCode = 1
  }
  // 有些命令会留下待写的状态，强制落盘
  try {
    store.saveStateNow()
  } catch {
    /* 没 load 过 store 就忽略 */
  }
}

main()
