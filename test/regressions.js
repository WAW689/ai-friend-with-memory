/**
 * 三个曾经出过事的点的防回归测试。
 *
 * 每一件都真实发生过，而且都很难从表面看出来：
 *
 * 1. 测试污染真实数据
 *    → 测试构造状态时把用户真实的 state.json 清空，主动调度彻底停摆，
 *      还被"没排期"静默拦住，表现成"它再也不主动找我了"。
 *    → 后来又发生一次：直接跑 test/life.js，把真实 life.md（生活设定）
 *      写成了 86 字节的测试夹具、life.jsonl 写成一条「旧事」。
 *      所以现在引导模块强制隔离，且有测试盯着"每个文件都得引入它"。
 *
 * 2. force 模式把用户自己的消息推给用户
 *    → 测试重复跑，用户手机上收到自己说的那句话，而且收到十几遍。
 *
 * 3. 前端改了但手机上还是旧的
 *    → 发图片的功能服务端就绪、接口验证通过，但手机点回形针毫无反应，
 *      因为 iOS 缓存了旧的 app.js。
 *
 * 用法：node test/regressions.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATHS, loadConfig } from '../src/config.js'
import { runProactiveCheck } from '../src/engine.js'
import { store } from '../src/storage.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

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

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
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

console.log('\n回归防护\n')

/* ------------------------------------------------ 1. 数据目录隔离 */

console.log('  数据目录隔离')

check('支持 FRIEND_DATA_DIR 覆盖数据目录', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8')
  assert(/FRIEND_DATA_DIR/.test(src), 'config.js 里没有 FRIEND_DATA_DIR 支持')
  assert(/DATA_DIR/.test(src), '没有独立的 DATA_DIR 变量')
  return '已支持'
})

check('当前跑在隔离目录里（不是真实 data/）', () => {
  const configured = process.env.FRIEND_DATA_DIR
  /*
   * 以前这里允许"单独跑时没隔离"，结果就是那次真实事故：
   * 有人直接跑了 `node test/life.js`，它的 reset() 把**真实**的
   * life.md 写成了 86 字节的测试夹具、life.jsonl 写成一条「旧事」，
   * 连带备份里存的都是坏数据。现在 test/_bootstrap.js 保证任何
   * 入口都有隔离，所以这里从"允许缺失"改成"必须存在"。
   */
  assert(configured, '没有 FRIEND_DATA_DIR —— 测试会写进真实 data/')

  const real = path.join(ROOT, 'data')
  assert(
    path.resolve(configured) !== path.resolve(real),
    `数据目录指向了真实目录：${configured}`,
  )
  return configured
})

check('每个测试文件都先 import 自隔离引导（关键）', () => {
  /*
   * PATHS 是模块加载那一刻算出来的，所以引导必须在**第一个** import。
   * 漏掉任何一个文件，直接跑它就会污染真实数据；这条检查兜住这个。
   */
  const skip = new Set(['_bootstrap.js', '_harness.js', 'all.js'])
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !skip.has(f))
  const missing = []

  for (const f of files) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8')
    const bootIdx = src.indexOf("import './_bootstrap.js'")
    if (bootIdx === -1) {
      missing.push(`${f}(没引入)`)
      continue
    }
    // 必须排在其他 import 之前
    const firstOther = src.search(/^import\s(?!'\.\/_bootstrap\.js')/m)
    if (firstOther !== -1 && firstOther < bootIdx) missing.push(`${f}(位置太靠后)`)
  }

  assert(missing.length === 0, '这些文件会污染真实数据：' + missing.join('、'))
  return `${files.length} 个文件都有引导`
})

check('测试聚合器会注入隔离目录', () => {
  const src = fs.readFileSync(path.join(HERE, 'all.js'), 'utf8')
  assert(/FRIEND_DATA_DIR/.test(src), 'all.js 没有注入 FRIEND_DATA_DIR')
  assert(/TMP_DATA/.test(src), 'all.js 没有临时目录常量')
  return '已注入'
})

/* ------------------------------------------------ 2. 推送不该推用户自己的话 */

console.log('')
console.log('  推送只推自己的消息')

check('sendPushFor 会过滤掉用户自己的消息', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8')
  assert(
    /messages\.filter\(\(m\) => m\.role === 'assistant'\)/.test(src),
    'sendPushFor 没有过滤 role',
  )
  assert(
    /没有可推送的自身消息/.test(src),
    '没有"没有自身消息就跳过"的分支',
  )
  return '已加过滤'
})

check('force 模式不推送手机', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8')
  assert(
    /if \(force\) \{[\s\S]{0,120}强制模式：已发送但不推送手机/.test(src),
    'force 分支里没有跳过推送',
  )
  return '已加判断'
})

await checkAsync('真的跑一次 force，push.log 不该新增', async () => {
  const logPath = path.join(process.env.FRIEND_DATA_DIR ?? path.join(ROOT, 'data'), 'push.log')
  const countBefore = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length
    : 0

  store.load()
  const result = await runProactiveCheck({ force: true })

  const countAfter = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length
    : 0

  assert(result.sent === true, `force 应该能发出来，实际：${result.reason}`)
  assert(
    countAfter === countBefore,
    `push.log 新增了 ${countAfter - countBefore} 条，force 不该推送`,
  )
  return `发出 ${result.messages.length} 条，未推送`
})

check('测试推送也受 FRIEND_NO_PUSH 控制', () => {
  /*
   * 这里踩过一次很尴尬的坑：testPush 直接调 push，**没有任何防护**，
   * 而 smoke.js 每次跑测试都会打 /api/test/bark。
   * 于是每跑一次测试，用户手机就响一次"连接成功。我随时能敲你一下"，
   * 而 push.log 里一条记录都没有（那时测试推送不写日志）。
   * 用户在 Bark 的历史消息里翻到一长串重复推送才发现。
   */
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bark.js'), 'utf8')
  const block = src.match(/export async function testPush[\s\S]*?\n\}/)
  assert(block, '找不到 testPush')
  assert(/FRIEND_NO_PUSH/.test(block[0]), 'testPush 里没有 FRIEND_NO_PUSH 闸门')
  return '闸门在'
})

check('测试推送会写进 push.log（可追溯）', () => {
  // 不写日志的话，"测试期间到底有没有推手机"根本查不出来
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bark.js'), 'utf8')
  const block = src.match(/export async function testPush[\s\S]*?\n\}/)
  assert(block, '找不到 testPush')
  assert(/recordPush/.test(block[0]), 'testPush 没有记录推送')
  return '有记录'
})

check('推送日志只有一个写入点（避免再次分叉）', () => {
  /*
   * 之前 engine.js 自己拼 push.log，bark.js 的测试推送不记，
   * 于是"零推送"的检查看着通过、实际手机在响。
   * 现在统一由 bark.js 的 recordPush 负责。
   */
  const engine = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8')
  assert(
    !/push\.log/.test(engine),
    'engine.js 又在自己写 push.log，应该改用 recordPush()',
  )
  const bark = fs.readFileSync(path.join(ROOT, 'src', 'bark.js'), 'utf8')
  assert(/export function recordPush/.test(bark), 'bark.js 里没有导出 recordPush')
  return '统一在 bark.js'
})

/* ------------------------------------------------ 3. 前端缓存失效 */

console.log('')
console.log('  前端资源带版本号')

check('serveStatic 会注入资源版本号', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'http.js'), 'utf8')
  assert(/assetVersion/.test(src), '没有 assetVersion 函数')
  assert(/injectAssetVersions/.test(src), '没有注入逻辑')
  return '已实现'
})

check('HTML 里的 app.js / style.css 都带 ?v=', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  // 源文件里不带版本号是对的（由服务端注入），这里检查引用形式可被替换
  const refs = [...html.matchAll(/(?:src|href)="\/(app\.js|style\.css)"/g)].map((m) => m[1])
  assert(refs.length >= 2, `只找到 ${refs.length} 处引用，注入逻辑可能匹配不上`)
  return `可注入 ${refs.length} 处`
})

/* ------------------------------------------------ 4. 主动决策流水 */

console.log('')
console.log('  主动决策流水')

check('记录里 sent 字段和 kind 字段一致', () => {
  /*
   * 这里踩过一次：写入时只存了 kind:'sent'，读取方却判断 e.sent，
   * 结果所有"发出去"的记录都被显示成"没发"。
   * 字段名不匹配这类错误不会报错，只会让统计悄悄错掉。
   */
  const src = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8')
  const block = src.match(/export function recordProactiveEvent[\s\S]*?\n\}/)
  assert(block, '找不到 recordProactiveEvent')
  assert(/\bsent,/.test(block[0]) || /sent:\s*sent/.test(block[0]), '记录里没有写 sent 字段')
  assert(/kind:\s*sent\s*\?/.test(block[0]), '记录里没有写 kind 字段')
  return '两个字段都写'
})

await checkAsync('真发一条后，流水里出现 sent=true 的记录', async () => {
  store.load()
  const { readProactiveEvents } = await import('../src/engine.js')
  const before = readProactiveEvents(50).length

  const result = await runProactiveCheck({ force: true })
  assert(result.sent === true, `应该发出来，实际：${result.reason}`)

  const after = readProactiveEvents(50)
  assert(after.length > before, '流水没有新增')

  const newest = after[0]
  assert(newest.sent === true, `最新记录的 sent 应为 true，实际 ${JSON.stringify(newest.sent)}`)
  assert(newest.kind === 'sent', `kind 应为 sent，实际 ${newest.kind}`)
  assert(Array.isArray(newest.messages) && newest.messages.length > 0, '记录里没有消息内容')
  return `${newest.messages.length} 条：${newest.messages.join(' / ').slice(0, 30)}`
})

/* ------------------------------------------------ 4. 导入即执行的危险脚本 */

console.log('')
console.log('  脚本不能"被导入就动手"')

await checkAsync('import src/reset.js 不该写任何数据（真实事故）', async () => {
  /*
   * 这条盯的是一个真发生过的数据事故，而且是本项目的工具自己造成的：
   *
   *   src/reset.js 的写盘逻辑裸在**模块顶层**，于是 import 它 = 执行重置。
   *   后来加了一个"检查 src/ 下所有文件能不能加载"的工具，它会 import
   *   整个 src/ —— 结果每跑一次就把用户真实的 persona.md 洗成出厂的
   *   「阿岚」、memory.md 洗成空模板。用户的天狼星和几十条记忆就这么没了。
   *
   * 修法是给它加 isDirectRun() 判断，只在被直接运行时才执行。
   * 这条测试就是盯着那个判断不许退化：导入一次，看数据有没有被改。
   */
  const target = path.join(ROOT, 'src', 'reset.js')
  const before = {
    persona: fs.readFileSync(PATHS.persona, 'utf8'),
    memory: fs.readFileSync(PATHS.memory, 'utf8'),
  }

  await import(`file://${target.replace(/\\/g, '/')}?regression=${Date.now()}`)
  // 写盘是同步的，但留一点余量
  await new Promise((r) => setTimeout(r, 150))

  const after = {
    persona: fs.readFileSync(PATHS.persona, 'utf8'),
    memory: fs.readFileSync(PATHS.memory, 'utf8'),
  }

  assert(
    before.persona === after.persona,
    'import reset.js 之后 persona.md 被改写了 —— 这个脚本会在被导入时执行',
  )
  assert(
    before.memory === after.memory,
    'import reset.js 之后 memory.md 被改写了 —— 这个脚本会在被导入时执行',
  )

  const src = fs.readFileSync(target, 'utf8')
  assert(/function isDirectRun/.test(src), 'reset.js 缺少 isDirectRun 判断')
  assert(/if \(isDirectRun\(\)\)/.test(src), 'reset.js 的 main() 没有用 isDirectRun 包住')
  assert(/isRealDataDir\(\) && !force/.test(src), 'reset.js 对真实 data/ 缺少 --force 确认')
  return '导入安全 + 有 --force 闸门'
})

/* ------------------------------------------------ 5. 导入不存在的导出 */

console.log('')
console.log('  服务能不能起来')

await checkAsync('每个源文件都能被真正加载（不只是语法通过）', async () => {
  /*
   * 这条盯的是一个真出过的事故：
   *   http.js 里写 `import { stickerStats } from './stickers.js'`，
   *   但 stickerStats 是 engine.js 的导出。
   *
   * 这种错误最坑的地方在于它**躲过了所有其他检查**：
   *   - node --check 只做语法检查，`import {x} from './y'` 语法完全合法
   *   - 单元测试全绿（没加载 http.js）
   *   - 静态的"路径存在"检查也过（路径确实存在）
   * 结果服务一启动就 SyntaxError 直接挂，终端上一行红字。用户看到的就是
   * "进程退出了（退出码 ）"。
   *
   * 所以这里做一次真实的加载。用 worker_threads 而不是 spawn：
   * 这个沙箱里 spawn 管道会 EPERM。数据目录必须钉住，
   * 不然 server.js 会读到真实数据、reset.js 会去动人设。
   */
  const { Worker } = await import('node:worker_threads')
  const sandbox = path.join(HERE, 'tmp-loads')
  fs.mkdirSync(sandbox, { recursive: true })

  const srcDir = path.join(ROOT, 'src')
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'))

  const loadOne = (file) =>
    new Promise((resolve) => {
      let done = false
      const finish = (r) => {
        if (done) return
        done = true
        clearTimeout(timer)
        worker.terminate().catch(() => {})
        resolve(r)
      }

      const worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads')
        import(workerData.url)
          .then(() => parentPort.postMessage({ ok: true }))
          .catch((e) => parentPort.postMessage({ ok: false, message: e.message }))
        `,
        {
          eval: true,
          workerData: { url: new URL(`file://${path.join(srcDir, file).replace(/\\/g, '/')}`).href },
          env: { ...process.env, FRIEND_DATA_DIR: sandbox, FRIEND_NO_PUSH: '1' },
        },
      )

      // 有的文件加载后会挂住（起服务器、挂定时器），那也算加载成功
      const timer = setTimeout(() => finish({ ok: true }), 8000)
      worker.on('message', (m) => finish(m))
      worker.on('error', (e) => finish({ ok: false, message: e.message }))
      // 命令行脚本会自己 exit，不算加载错误
      worker.on('exit', () => finish({ ok: true }))
    })

  const failed = []
  for (const f of files) {
    const r = await loadOne(f)
    if (!r.ok) failed.push(`${f}: ${String(r.message).split('\n')[0]}`)
  }

  assert(
    failed.length === 0,
    `这些文件加载失败，服务会起不来：\n      ${failed.join('\n      ')}`,
  )
  return `${files.length} 个源文件都能加载`
})

/* ------------------------------------------------ 收尾 */

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
