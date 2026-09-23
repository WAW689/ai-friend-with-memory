/**
 * 一次跑完所有测试。
 *
 *   node test/all.js
 *
 * 实现要点：每个测试文件跑在一个 **worker 线程**里，而不是子进程。
 * 原因：这个环境不允许通过管道捕获子进程输出（spawn 直接 EPERM）。
 * worker 是同进程内的线程，不受那条限制，而且继承 stdout——
 * 所以测试的输出照常打印到你的终端。
 *
 * worker 里调用 process.exit(code) 只会终止那个 worker，
 * 正好用来收每个测试文件的退出码。
 */
import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/**
 * 测试专用数据目录。
 *
 * 必须隔离：很多测试会直接构造状态（把 nextProactiveAt 置零、
 * 伪造 lastUserMessageAt 等）。如果跑在真实 data/ 上，
 * 就会把用户真实的状态清掉——实测发生过，后果是主动调度彻底停摆，
 * 而且被"没排期"静默拦住，表现成"它再也不主动找我了"。
 *
 * 隔离靠 FRIEND_DATA_DIR 环境变量（见 src/config.js）。
 */
const TMP_DATA = path.join(HERE, 'tmp')

/** 准备一份干净的测试数据：复制真实的人设/记忆，但状态和消息用种子数据 */
function prepareTestData() {
  fs.rmSync(TMP_DATA, { recursive: true, force: true })
  fs.mkdirSync(TMP_DATA, { recursive: true })

  // 人设和记忆复制一份，让测试有个像样的上下文
  for (const name of ['persona.md', 'memory.md']) {
    const from = path.join(ROOT, 'data', name)
    if (fs.existsSync(from)) {
      try {
        fs.copyFileSync(from, path.join(TMP_DATA, name))
      } catch {
        /* 复制失败也无所谓 */
      }
    }
  }

  /*
   * 生活设定必须给一份**固定的**，不能让它落空。
   *
   * 落空会走兜底作息（3 点睡 / 11 点起），于是"她这会儿在不在睡"
   * 变成随测试运行时刻变化的东西：同一条测试，晚上跑是绿的，
   * 早上十点跑就红——而它其实什么都没测错。这个套件就在上午十点
   * 集体红过一次，查了半天才发现是兜底作息撞上了上午。
   *
   * 注意这里只解决"有个确定的作息"；真正和时间有关的断言，
   * 还得像 test/busy.js 那样显式传 at/window。
   */
  fs.writeFileSync(
    path.join(TMP_DATA, 'life.md'),
    '# 测试用生活设定\n\n- 23 岁，在上海，自由职业程序员\n- 凌晨三点睡，中午十二点起\n',
    'utf8',
  )

  /*
   * 消息记录必须有内容。
   * 空文件会让 store.messages[messages.length - 1] 变成 undefined，
   * 而"从文件尾部读 seq"是 backup-and-seq 的核心用例，那样就测不了。
   */
  const base = Date.now() - 60 * 60 * 1000
  const seed = [
    { seq: 1, at: base, role: 'user', text: '（测试种子消息）', kind: 'chat' },
    { seq: 2, at: base + 30000, role: 'assistant', text: '（测试种子回复）', kind: 'chat' },
  ]
  fs.writeFileSync(
    path.join(TMP_DATA, 'messages.jsonl'),
    `${seed.map((m) => JSON.stringify(m)).join('\n')}\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(TMP_DATA, 'state.json'),
    JSON.stringify(
      {
        lastReadSeq: 2,
        lastUserMessageAt: seed[0].at,
        lastAssistantMessageAt: seed[1].at,
        nextProactiveAt: Date.now() + 3600_000,
        proactiveByDay: {},
      },
      null,
      2,
    ),
    'utf8',
  )
}

/** 离线：不调模型、不需要服务在跑 */
const OFFLINE = [
  ['未导入引用检查', 'undefined-refs.js'],
  ['消息清洗', 'message-clean.js'],
  ['提示词与时间感知', 'prompts.js'],
  ['生活流水', 'life.js'],
  ['她的过去（按天）', 'life-days.js'],
  ['会变的自我', 'self.js'],
  ['表情包', 'stickers.js'],
  ['黄历与天气', 'almanac.js'],
  ['体检与待回访', 'doctor.js'],
  ['在忙与困劲儿', 'busy.js'],
  ['顶栏状态', 'status.js'],
  ['备份与消息序号', 'backup-and-seq.js'],
  ['逐字动画算法', 'typing-animation.js'],
  ['头像', 'avatar.js'],
  ['二维码编解码', 'qr-roundtrip.js'],
  ['前端接线', 'frontend-wiring.js'],
  ['回归防护', 'regressions.js'],
]

/** 在线：需要服务在跑 */
const ONLINE = [['接口冒烟', 'smoke.js']]

/*
 * 需要花钱的测试（真调模型），默认不跑。
 * 想跑：node test/vision.js
 * 之所以不放进聚合器：跑一次要好几秒、花 token，
 * 而它验证的能力已经被其他测试覆盖了。
 */

const WORKER_SOURCE = `
import { workerData } from 'node:worker_threads'
try {
  await import(workerData.file)
} catch (err) {
  console.error('加载失败：' + (err && err.stack ? err.stack : err))
  process.exit(2)
}
`

/** 在一个 worker 里跑一个测试文件，返回退出码 */
function runInWorker(file, env = {}) {
  const url = new URL(file, `file:///${HERE.replace(/\\/g, '/')}/`)
  return new Promise((resolve) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
      workerData: { file: url.href },
      // 用环境变量传参：worker 的 argv 会被 workerData 机制覆盖，不靠谱。
      // 两个关键变量都在这里注入：
      //   FRIEND_DATA_DIR  隔离数据，绝不碰真实 data/
      //   FRIEND_NO_PUSH   物理上禁止推送，绝不响用户手机
      env: {
        ...process.env,
        FRIEND_DATA_DIR: TMP_DATA,
        FRIEND_NO_PUSH: '1',
        ...env,
      },
      stdout: false, // 继承父进程的 stdout，直接打印
      stderr: false,
    })
    worker.on('exit', (code) => resolve(code ?? 0))
    worker.on('error', (err) => {
      console.error(`worker 出错：${err.message}`)
      resolve(1)
    })
  })
}

async function main() {
  const started = Date.now()
  const results = []

  console.log('')
  console.log('  朋友 · 全部测试')
  console.log('')

  // 隔离测试数据：所有测试跑在 test/tmp/ 下，绝不碰真实 data/
  prepareTestData()
  console.log(`  测试数据目录：${TMP_DATA}`)
  console.log('  （真实 data/ 不会被读写）')
  console.log('')

  console.log('  离线（不调模型、不依赖服务）')

  for (const [name, file] of OFFLINE) {
    const code = await runInWorker(file)
    results.push({ name, ok: code === 0, code })
    console.log(`    ${code === 0 ? '✓' : '✗'} ${name}\n`)
  }

  console.log('  在线（需要服务在跑）')
  let token = ''
  try {
    token = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).accessToken ?? ''
  } catch {
    /* 忽略 */
  }

  if (!token) {
    console.log('    ⚠ 读不到 config.json 里的口令，跳过在线测试')
  } else {
    for (const [name, file] of ONLINE) {
      // smoke.js 从 argv[2] 或 FRIEND_ACCESS_TOKEN 取口令
      const code = await runInWorker(file, { FRIEND_ACCESS_TOKEN: token })
      results.push({ name, ok: code === 0, code })
      console.log(`    ${code === 0 ? '✓' : '✗'} ${name}\n`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  console.log('  ' + '─'.repeat(46))
  console.log(`  ${results.length - failed.length} / ${results.length} 个套件通过（${seconds}s）`)
  if (failed.length) {
    console.log('')
    console.log('  失败：' + failed.map((f) => `${f.name}(exit ${f.code})`).join('、'))
  }
  console.log('')

  process.exit(failed.length === 0 ? 0 : 1)
}

main()
