/**
 * 检查每个源文件能不能被加载。
 *
 * 为什么需要：ESM 的具名导入**在加载那一刻**才校验。
 * `import { stickerStats } from './stickers.js'` 而 stickers.js 没导出它，
 * `node --check` 看不出来（那是语法级检查）、单元测试也可能全过，
 * 但服务一启动就 SyntaxError 直接挂 —— 这个坑真踩过：
 * 加表情包功能之后服务起不来了。
 *
 * 用 worker_threads 而不是 child_process：
 *   1. 这个沙箱里 spawn 管道捕获输出会 EPERM
 *   2. 一个文件加载后可能卡住（比如启动了服务器、挂了定时器），
 *      worker 可以 terminate 掉，子进程不好收拾
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).sort()

/*
 * 数据目录必须隔离。
 *
 * 这条是踩出来的：最早跑这个检查时没有隔离，server.js 加载后读到了
 * 真实的 622 条消息，而 reset.js 直接打印了"人设已恢复默认"——
 * 一个只读的"能不能加载"检查，差点把用户的真实人设洗了。
 * 凡是加载 src/ 下文件的地方，都得先钉住 FRIEND_DATA_DIR。
 */
const SANDBOX = path.join(ROOT, 'test', 'tmp-loads')
fs.mkdirSync(SANDBOX, { recursive: true })

/** 在 worker 里跑的探针：只做一次 import，把结果报回来 */
const PROBE = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.url)
  .then(() => parentPort.postMessage({ ok: true }))
  .catch((err) => parentPort.postMessage({ ok: false, message: err.message }))
`

function probe(file) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      resolve(r)
    }

    const worker = new Worker(PROBE, {
      eval: true,
      workerData: { url: new URL(`file://${path.join(ROOT, 'src', file).replace(/\\/g, '/')}`).href },
      env: {
        ...process.env,
        FRIEND_DATA_DIR: SANDBOX,
        // 命令行脚本可能想推手机，物理上禁掉
        FRIEND_NO_PUSH: '1',
      },
    })

    // 有些文件是命令行脚本，加载时可能自己退出整个线程；
    // 也有文件会挂住（启动服务器）。超时算"能加载但会挂住"。
    const timer = setTimeout(() => finish({ ok: true, note: '加载成功但会一直挂着' }), 8000)

    worker.on('message', (m) => finish(m))
    worker.on('error', (err) => finish({ ok: false, message: err.message }))
    /*
     * 退出码非 0 **不一定是错**：命令行脚本在参数不满足时会主动
     * process.exit(1)（比如 backfill-life.js 发现流水非空就拒绝执行）。
     * 那种情况模块本身是好的。真正的加载错误会走上面的 error 事件
     * 或者 message（SyntaxError 在 import() 的 catch 里）。
     * 所以这里只要拿到过成功信号就算过；退出码非 0 但**没报错**的记为自行退出。
     */
    worker.on('exit', (code) => {
      if (code === 0) finish({ ok: true, note: '脚本自行退出' })
      else finish({ ok: true, note: `脚本自行退出（码 ${code}，非加载错误）` })
    })
  })
}

let bad = 0
for (const f of files) {
  const r = await probe(f)
  if (r.ok) {
    console.log(`  ✓ ${f}${r.note ? '（' + r.note + '）' : ''}`)
  } else {
    console.log(`  ✗ ${f} → ${String(r.message).split('\n')[0]}`)
    bad++
  }
}

console.log('')
if (bad === 0) {
  console.log(`全部 ${files.length} 个源文件都能加载`)
} else {
  console.log(`${bad} 个文件加载失败 —— 服务会起不来`)
}
process.exit(bad === 0 ? 0 : 1)
