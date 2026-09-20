/**
 * 调度器：定期醒来，问一次"要不要主动找对方"。
 *
 * 为什么用固定 tick + 随机窗口，而不是 cron：
 * - 真人不会准点发消息。随机窗口 + 模型二次判断，才不会有闹钟感。
 * - tick 只负责"该醒了"，具体发不发交给引擎。
 */
import { loadConfig } from './config.js'
import { runProactiveCheck, scheduleNextProactive } from './engine.js'
import { store } from './storage.js'
import { log, now } from './util.js'

const TICK_MS = 60 * 1000

let timer = null
let running = false

export function startScheduler() {
  if (timer) return
  const cfg = loadConfig()
  if (!store.state.nextProactiveAt) scheduleNextProactive(cfg)

  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  timer.unref?.()
  log.info(`调度器已启动（每 ${TICK_MS / 1000} 秒检查一次；下次窗口 ${new Date(store.state.nextProactiveAt).toLocaleString()}）`)
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

/** 跑一次检查。running 防重入，避免慢请求把检查堆起来。 */
export async function tick() {
  if (running) return { skipped: '上一次检查还没结束' }
  running = true
  try {
    const cfg = loadConfig()
    if (!cfg.proactive.enabled) return { skipped: '主动消息已关闭' }

    // 数据被删空过（nextProactiveAt 为 0）就重新排期，别一直卡住
    if (!store.state.nextProactiveAt) {
      scheduleNextProactive(cfg)
      return { skipped: '重新排期' }
    }
    if (now() < store.state.nextProactiveAt) {
      return { skipped: '还没到窗口', waitMs: store.state.nextProactiveAt - now() }
    }

    return await runProactiveCheck()
  } catch (err) {
    log.error(`调度器出错：${err.message}`)
    // 出错也要排下一次，否则一次异常就永久静音了
    try {
      scheduleNextProactive()
    } catch {
      /* 忽略 */
    }
    return { error: err.message }
  } finally {
    running = false
  }
}
