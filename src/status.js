/**
 * 界面顶部那行状态。
 *
 * 为什么单独抽一个模块：这行字看起来只是个标签，但它决定用户**怎么理解
 * 她没回消息这件事**。
 *
 *   显示"在的" → 她没回 = 可能不想理我
 *   显示"在煮面，一会儿回你" → 她没回 = 她在忙
 *
 * 差别很大。而且它顺手兑现了我们做的另外两个功能：她会去忙、她会困——
 * 那两个功能在界面上本来**完全看不出来**，用户只会觉得"怎么卡了一下"。
 *
 * ── 一条铁律 ──────────────────────────────────────────
 * 这里的状态判断**必须和回复延迟用同一份**（busyState / sleepiness）。
 * 各算各的就会穿帮：状态栏说"在煮面"，消息却秒回——
 * 那比不显示状态更假。
 */
import { now } from './util.js'
import { busyState } from './busy.js'
import { parseActivity, shortActivity } from './activity.js'
import { sleepiness } from './sleepy.js'

/*
 * 活动解析（parseActivity / shortActivity）**搬到了 activity.js**。
 *
 * 搬家的原因：busy.js 也要用它（按动词定档位），
 * 而 busy.js 已经被 status.js 依赖——放在这里会成环。
 * 现在两边都从 activity.js 取，这里只 re-export 给老调用方。
 */
export { parseActivity, shortActivity } from './activity.js'

/**
 * 这些话本身就是完整状态，不用加"在"。
 * 拼成"在睡着了"会很好笑。
 */
const STANDALONE_ACTIVITY = /^(睡着了|睡了|已睡着)$/

/**
 * 她现在的状态。
 *
 * 优先级：正在打字 > 睡着 > 忙 > 空闲。
 * "正在打字"最高——那一刻**事实就是**她在回你，别的都不重要。
 *
 * @param {object} cfg
 * @param {{at?: number, generating?: boolean}} [opts]
 * @returns {{key: string, label: string, detail: string, since: number}}
 */
export function herState(cfg, { at = now(), generating = false } = {}) {
  // 1) 正在打字
  if (generating) {
    return { key: 'typing', label: '正在输入…', detail: '', since: at }
  }

  const sleepy = sleepiness({ at })
  const busy = busyState({ at })

  /*
   * 2) 睡着。
   *
   * 措辞要留余地，不能像"勿扰模式"。
   * 半夜想说话却发现对方"已开启勿扰"，那比没人理还难受。
   * "有事留着我醒来看"是邀请，不是拒绝。
   */
  if (cfg?.sleepy?.enabled !== false && sleepy.isAsleepPeriod) {
    return {
      key: 'asleep',
      label: '睡了',
      detail: `一般 ${sleepy.wakeHour} 点起，有事留着我醒来看`,
      since: at,
    }
  }

  /*
   * 3) 快睡了。
   *
   * 门槛是 0.5 而不是 0.9。踩过一次：0.9 对应"睡前 45 分钟"，
   * 而她 3 点睡，所以只有凌晨 2:15 之后才显示困——
   * 用户 22:00、0:00、1:00 看到的全是"在的"，这个状态等于不存在。
   *
   * 0.5 对应"睡前两小时"（凌晨 1 点之后），那时候确实该困了。
   */
  if (cfg?.sleepy?.enabled !== false && sleepy.level >= 0.5) {
    return { key: 'sleepy', label: '困得不行了', detail: '回得会慢，别嫌我', since: at }
  }

  // 4) 手上有事
  if (cfg?.busy?.enabled !== false && busy.level !== 'idle') {
    const what = shortActivity(busy.text)
    const mins = Math.round((busy.ageMs ?? 0) / 60000)
    const ago = mins < 1 ? '刚记下' : `${mins} 分钟前记下`
    if (what) {
      /*
       * "睡着了"这类本身就是完整状态，不用加"在"。
       * 拼成"在睡着了"会很好笑。
       */
      const isStandalone = STANDALONE_ACTIVITY.test(what)
      const label = isStandalone
        ? what
        : busy.level === 'heavy'
          ? `在${what}`
          : `在${what}，能看手机`
      /*
       * 只有 heavy 才敢写"回得可能慢一点"。
       *
       * light 不延迟了（能看手机就该回得快），如果这里还写着"回得可能慢"，
       * 那就成了**界面在替她许一个不会兑现的承诺**——用户等不到那个"慢"，
       * 只会觉得这行字是假的。宁可少说一句。
       */
      return {
        key: busy.level === 'heavy' ? 'busy' : 'around',
        label,
        detail: busy.level === 'heavy' ? (isStandalone ? '回得可能慢一点' : `${ago} · 回得可能慢一点`) : ago,
        since: busy.at,
      }
    }
  }

  /*
   * 5) 空闲。
   *
   * 写"在的"而不是"在线"。
   * "在线"是 IM 的词，暗示"我随时待命"——那正是我们一直在摆脱的东西。
   */
  return { key: 'here', label: '在的', detail: '', since: at }
}

/** 给界面用的一份完整快照 */
export function stateForUI(cfg, opts = {}) {
  const state = herState(cfg, opts)
  return {
    key: state.key,
    label: state.label,
    detail: state.detail,
    since: state.since,
    at: opts.at ?? now(),
  }
}

/**
 * "她为什么还没开始回"那句话（消息区里顶在三点动画位置上的）。
 *
 * 和顶栏那行**必须同一套说法**，所以放在同一个文件里：
 * 两处措辞不一样的话，用户会以为在讲两件事。
 * 而这一句存在的意义就是把等待从悬念变成信息——
 * 三点动画转四十秒是在骗人（她还没动笔），一句实话不是。
 */
export function waitingLabel(state) {
  const what = shortActivity(state?.text ?? '')
  if (!what) return '手上有点事，等一下'
  return STANDALONE_ACTIVITY.test(what) ? `${what}，等一下` : `在${what}，等一下`
}
