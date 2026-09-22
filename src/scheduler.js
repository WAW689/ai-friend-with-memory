/**
 * 调度器：定期醒来，做两件事。
 *
 * 1. **主动开口**：问一次"要不要找对方说话"
 * 2. **过自己的日子**：对方安静的时候，让它经历点小事，记进生活流水
 *
 * 为什么用固定 tick + 随机窗口，而不是 cron：
 * - 真人不会准点发消息，也不会准点过日子。随机窗口 + 模型二次判断才没有闹钟感。
 * - tick 只负责"该醒了"，具体做不做交给各自的判断函数。
 */
import { loadConfig } from './config.js'
import { maybeAnnounceBusy, runProactiveCheck, scheduleNextProactive } from './engine.js'
import { liveOneRound, shouldLive } from './life.js'
import { store } from './storage.js'
import { log, now, randInt } from './util.js'

const TICK_MS = 60 * 1000

let timer = null
let running = false
/** 生活流水是否正在生成（避免叠加多次调用） */
let livingNow = false

export function startScheduler() {
  if (timer) return
  const cfg = loadConfig()
  if (!store.state.nextProactiveAt) scheduleNextProactive(cfg)

  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  timer.unref?.()
  log.info(`调度器已启动（每 ${TICK_MS / 1000} 秒检查一次）`)
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * 该不该让它过一段日子。
 *
 * 独立于主动开口：即使主动消息关着，它也应该继续生活——
 * 否则重新打开主动时它会显得"消失了一段时间"。
 */
async function maybeLive(cfg) {
  if (livingNow) return { skipped: '上一次生活生成还没结束' }

  const verdict = shouldLive(cfg, store.state)
  if (!verdict.ok) return { skipped: verdict.reason }

  livingNow = true
  try {
    // 每次 1 到 maxPerRun 件，随机，别每次都一样多
    const count = randInt(1, Math.max(1, cfg.life.maxPerRun))
    const result = await liveOneRound({ count })
    if (result.ok) {
      log.info(`生活：记下 ${result.activities.length} 件事`)

      /*
       * 刚"经历"了要去忙的事，顺手交代一句"我去忙了"。
       *
       * 位置在这里有讲究：必须在 liveOneRound **之后**——
       * 报备要引用她刚要去做的那件事（"我去洗个澡"），
       * 放在前面就没有那件事可引用，只能说一句空泛的"我去忙了"。
       *
       * 报备成功就跳过这一轮的主动开口：两条消息连着发很吵，
       * 而且"我去忙了"本身就是一次主动开口了。
       */
      try {
        const announced = await maybeAnnounceBusy(cfg)
        if (announced.sent) return { ...result, announced: true }
      } catch (err) {
        log.warn(`报备失败（不影响生活流水）：${err.message}`)
      }
    }
    return result
  } catch (err) {
    log.warn(`生活生成失败：${err.message}`)
    return { ok: false, reason: err.message }
  } finally {
    livingNow = false
  }
}

/** 跑一次检查。running 防重入，避免慢请求把检查堆起来。 */
export async function tick() {
  if (running) return { skipped: '上一次检查还没结束' }
  running = true
  try {
    const cfg = loadConfig()

    /*
     * 先过日子，再考虑找对方说话。
     *
     * 顺序有意义：如果它刚"经历"了一件事，紧接着主动开口时就能引用那件事，
     * 而不是开口时才现编。反过来的话，主动消息只能引用上一次的旧事。
     */
    const liveResult = await maybeLive(cfg)

    /*
     * 她刚报备了"我去忙了"，这一轮就不再主动开口。
     *
     * 两条消息连着发很吵；而且"我去忙了"本身已经是一次开口了。
     * 报备也算用掉了这一轮的主动窗口，所以照样排下一次。
     */
    if (liveResult?.announced) {
      scheduleNextProactive(cfg)
      return { skipped: '刚报备去忙了', live: liveResult }
    }

    if (!cfg.proactive.enabled) return { skipped: '主动消息已关闭', live: liveResult }

    // 数据被删空过（nextProactiveAt 为 0）就重新排期，别一直卡住
    if (!store.state.nextProactiveAt) {
      scheduleNextProactive(cfg)
      return { skipped: '重新排期', live: liveResult }
    }
    if (now() < store.state.nextProactiveAt) {
      return { skipped: '还没到窗口', waitMs: store.state.nextProactiveAt - now(), live: liveResult }
    }

    const proactive = await runProactiveCheck()
    return { ...proactive, live: liveResult }
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
