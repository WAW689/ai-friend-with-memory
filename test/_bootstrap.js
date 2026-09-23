/**
 * 测试自隔离引导 —— 每个测试文件的**第一个 import** 必须是它。
 *
 * 为什么需要：
 *   PATHS（config.js）是在**模块加载那一刻**算出来的。单独跑
 *   `node test/life.js` 时没人设 FRIEND_DATA_DIR，PATHS 就指向真实的
 *   data/ 目录；而 test/life.js 的 reset() 会写 life.md / life.jsonl ——
 *   于是**真实数据被测试夹具覆盖**。
 *
 *   这个坑真的发生过：life.md（生活设定）被写成了 86 字节的测试夹具，
 *   life.jsonl 被写成一条「旧事」，备份里存的也是坏数据。
 *
 * 做法：在被测模块加载**之前**把 FRIEND_DATA_DIR 指到一个隔离目录。
 *   - 聚合器（test/all.js）自己已经设好了 → 这里不动它
 *   - 单独跑某个测试 → 隔离到 test/tmp-<套件名>，互不干扰
 *   - 显式设过 FRIEND_DATA_DIR → 尊重它，绝不覆盖
 *
 * ESM 的 import 是**按书写顺序求值**的，所以只要这个 import 排第一，
 * 它设的环境变量就一定早于 config.js 被读到。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = process.argv[1] ? path.basename(process.argv[1], '.js') : ''

// 聚合器自己有隔离策略（共享 test/tmp），不要插手
const isAggregator = entry === 'all'

if (!isAggregator && !process.env.FRIEND_DATA_DIR) {
  const dir = path.join(here, 'tmp-' + (entry || 'unknown'))
  fs.mkdirSync(dir, { recursive: true })
  process.env.FRIEND_DATA_DIR = dir
}

// 测试绝不允许推送到用户手机（bark.js 也有一层，这里是双保险）
process.env.FRIEND_NO_PUSH = '1'

/*
 * 日志也要隔离。
 *
 * 日志默认写在项目下的 logs/，而测试会跑几十个进程、每个都写几行——
 * 不隔离的话，真实的 logs/friend-<今天>.log 会被测试输出灌满，
 * 出问题时真正有用的那几行反而淹掉了。
 *
 * 放在**数据目录里面**（<隔离目录>/logs）：数据目录是测试自己的地盘，
 * 聚合器每次跑之前会整份删掉，日志也就跟着干净了。
 * 不要再按 process.argv 猜目录名——聚合器是在 worker 线程里跑各个套件的，
 * 那里的 argv 是空的，猜出来会变成 tmp-unknown，跨次运行一直追加。
 */
if (!process.env.FRIEND_LOG_DIR) {
  // 兜一层：万一没人设 FRIEND_DATA_DIR，也不能让这里抛异常
  const base = process.env.FRIEND_DATA_DIR || path.join(here, 'tmp')
  const logDir = path.join(base, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  process.env.FRIEND_LOG_DIR = logDir
}

export const DATA_DIR = process.env.FRIEND_DATA_DIR ?? '(聚合器共享目录)'
export const LOG_DIR = process.env.FRIEND_LOG_DIR
