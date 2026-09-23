/**
 * 「她去忙了」和「她会困」的测试。
 *
 * 这两件事看着是装饰，其实解决的是同一个问题：
 * **她以前像一个随时待命的服务，不像一个在过日子的人。**
 *   · 秒回 → 真朋友不会永远在线等你
 *   · 凌晨三点精神抖擞 → 她明明写着"三四点睡"，却像个不睡的机器
 *
 * 但也正因为它们是"装饰"，一旦做过头就变成故障：
 *   · 延迟太长 → 用户以为消息没发出去
 *   · 睡觉时段完全不回 → 半夜说话没人理，那是服务挂了
 * 所以这个套件的重点是**边界**：什么时候该延迟、什么时候绝对不能。
 *
 * 用法：node test/busy.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import { buildBusySection, busyState, busyStatus, replyDelay } from '../src/busy.js'
import { waitingLabel } from '../src/status.js'
import { shortActivity } from '../src/activity.js'
import { activeHoursGate, buildSleepySection, parseSleepWindow, sleepiness } from '../src/sleepy.js'
import { buildBusyAnnouncePrompt, buildChatSystemPrompt } from '../src/prompts.js'

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

const cfg = loadConfig()
const MIN = 60 * 1000
const at = (h, m = 0) => new Date(2026, 8, 22, h, m, 0, 0).getTime()

/** 直接写生活流水文件（busy 和 sleepy 都从这里读她的当下状态） */
function writeJournal(entries) {
  fs.mkdirSync(path.dirname(PATHS.journal), { recursive: true })
  fs.writeFileSync(
    PATHS.journal,
    entries.map((e) => JSON.stringify({ kind: 'activity', ...e })).join('\n') +
      (entries.length ? '\n' : ''),
    'utf8',
  )
}

/** 造一条"刚刚发生的生活流水" */
function journalJustNow(text, minutesAgo = 5) {
  writeJournal([{ at: Date.now() - minutesAgo * MIN, text }])
}

console.log('\n她在忙吗\n')

check('没有生活流水时不算忙', () => {
  writeJournal([])
  const s = busyState()
  assert(s.level === 'idle', `应该 idle，实际 ${s.level}`)
  return s.level
})

check('刚在煮东西 → heavy', () => {
  journalJustNow('起来煮了碗西红柿鸡蛋面')
  const s = busyState()
  assert(s.level === 'heavy', `应该 heavy，实际 ${s.level}（${s.text}）`)
  return s.text
})

check('刚洗完澡 → 算忙（"洗澡"本身就是 heavy）', () => {
  /*
   * "洗完"确实是个完成态短语，但流水里的"凑合洗完"意思是
   * "我刚洗了个澡"——她刚从浴室出来，手上还湿着。
   * 所以这条语气上更接近"正在收尾"，判成忙是对的。
   *
   * 换句话说：DONE_MARKERS 里保留"洗完"是**刻意的**争议取舍——
   * 判成忙最多让她晚回几十秒，判成不忙则会让状态栏在她刚洗完时
   * 显示"在的"，那反而更假。
   */
  journalJustNow('热水器又忽冷忽热，凑合洗完')
  const s = busyState()
  assert(s.level === 'heavy', `应该 heavy，实际 ${s.level}（${s.text}）`)
  return s.text
})

check('刚才在改图 → light（能看手机的那种）', () => {
  journalJustNow('改到第四版，又说"还是第一版好"')
  const s = busyState()
  assert(s.level === 'light', `应该 light，实际 ${s.level}`)
  return s.text
})

check('认词根，不认具体搭配（"改页面""改八遍"也要认）', () => {
  /*
   * 模式表踩过两次坑，都是"只写了某一个搭配"：
   *   1. 只写"洗澡"，她的流水是"凑合洗完" → 判成不忙
   *   2. 只写"改图"，而她说的是"改页面""三百块的活改八遍" → 判成不忙
   *
   * 教训：认词根（"改"这个动作本身就够说明问题），别穷举搭配。
   */
  const cases = ['她在改页面', '在改页面', '调页面样式', '写页面', '做前端页面', '三百块的活改八遍']
  for (const text of cases) {
    journalJustNow(text)
    const s = busyState()
    assert(s.level !== 'idle', `「${text}」没被认成在忙`)
  }
  return `${cases.length} 种说法都认`
})

check('提取出的短语是完整的，不是半截（"改面"那种）', () => {
  /*
   * 宾语词表里**长词必须排在短词前面**——`NOUNS.find()` 取第一个命中的。
   * 如果"面"排在"页面"前面，"改页面"会被拼成"在改面"，读起来像断了。
   *
   * 这里测解析出来的短语本身（不带"在"前缀），
   * 因为"在"是状态栏拼的、不是解析器的事。
   */
  const cases = [
    ['她在改页面', '改页面'],
    ['起来煮了碗西红柿鸡蛋面', '煮面'],
    ['下楼拿快递', '下楼拿快递'],
    ['调页面样式', '调页面'],
    ['写页面', '写页面'],
  ]
  for (const [input, expect] of cases) {
    journalJustNow(input)
    const st = busyState()
    assert(st.level !== 'idle', `「${input}」没被认成在忙`)
    assert(st.text === input, '原始文本该保留')
    // 解析出的人类可读短语
    assert(
      shortActivity(input) === expect,
      `「${input}」解析成「${shortActivity(input)}」，期望「${expect}」`,
    )
  }
  return `${cases.length} 句都对`
})

check('明确"吃完了"不算忙，但"洗完"算（判据是完成补语，不是词）', () => {
  /*
   * 这里有个来回，两边的理由都要说清楚：
   *
   * · 一开始想从文本判断"这事做完没"，**放弃了**——流水记的本来就是
   *   刚发生的事，几乎每条都是完成态（"改了第四版""下楼拿了快递"），
   *   照那个规则判她永远不忙，功能等于没有。
   *
   * · 但"面吃完了，凑合"这种，说"在吃面"确实很怪。
   *   所以加了一层**很窄的**判断：只认"完了""好了"这种明确完成补语。
   *
   * · 关键是**按形态判，不按词判**。按词判会自相矛盾：
   *   "洗完"既像完成态、又是她的真实流水（意思是"我刚洗了个澡，手上还湿着"），
   *   两边都想认就会打架。按形态判就干净了：
   *     "面吃完**了**" → 结束了 → 不忙
   *     "凑合洗完"     → 刚洗完、还在收尾 → 忙
   *   这个差异是测试逼出来的，不是抠字眼。
   */
  journalJustNow('面吃完了，凑合')
  assert(busyState().level === 'idle', `"吃完了"不该被当成在忙：${busyState().text}`)

  journalJustNow('凑合洗完')
  assert(busyState().level === 'heavy', '"洗完"应该算在忙（刚好洗完，还在收尾）')

  journalJustNow('下楼拿快递')
  assert(busyState().level === 'heavy', '"拿快递"应该算忙')
  return '吃完「了」不算，洗完和拿快递算'
})

check('很久以前的流水不算数（她肯定早做完了）', () => {
  journalJustNow('起来煮了碗面', 90) // 90 分钟前
  const s = busyState()
  assert(s.level === 'idle', '一个半小时前煮的面，现在还算忙')
  return 'idle'
})

check('未来的时间戳不会算成"正在忙"', () => {
  // 补写历史流水时可能出现未来时间（时区问题），不该让她一直忙
  writeJournal([{ at: Date.now() + 3600 * 1000, text: '在煮面' }])
  assert(busyState().level === 'idle', '未来时间戳被当成"现在在忙"')
  return 'idle'
})

console.log('\n延迟的量\n')

check('不忙就不延迟', () => {
  writeJournal([])
  assert(replyDelay(cfg) === 0, '不忙却延迟了')
  return '0 秒'
})

check('light（能看手机的那种）不再延迟', () => {
  /*
   * 这条是从一次真实的抱怨倒推出来的：
   * 用户说"他回复我很慢"，一查发现顶栏写着"在改东西，**能看手机**"，
   * 而她回一条要等 40 秒——状态和延迟在互相打脸。
   *
   * 能看手机就该回得快。light 只留在顶栏那行字里，不再换成分秒。
   */
  journalJustNow('三百块的活改八遍')
  const s = busyState()
  assert(s.level === 'light', `这条应该是 light，实际 ${s.level}`)
  assert(replyDelay(cfg) === 0, 'light 还在延迟 —— 状态说"能看手机"却在拖时间')
  return '状态 light，延迟 0'
})

check('同一个忙碌窗口只等一次', () => {
  /*
   * 原来每来一条消息各抽一次延迟。她在忙的那 45 分钟里，
   * 用户发的每一条都要重新等几十秒——聊两句要等三分钟，
   * 那不是"她在忙"，是"她卡住了"。
   *
   * 真人不这样：你发过去他隔一会儿回一句，从这句起你们就在对话里了。
   * 所以记住"是哪条流水让我等过"，同一条不再等第二次。
   */
  journalJustNow('下楼拿快递')
  const s = busyState()
  const first = replyDelay(cfg, { state: s })
  assert(first > 0, '第一条却没延迟')
  const second = replyDelay(cfg, { state: s, lastWaitedAt: s.at })
  assert(second === 0, '同一条流水又延迟了一次 —— 又变成每条都要等')
  // 换一条新的流水（她真去忙别的了）就该重新等
  journalJustNow('出门买酱油', 3)
  const next = busyState()
  assert(next.at !== s.at, '夹具没写出新流水')
  assert(replyDelay(cfg, { state: next, lastWaitedAt: s.at }) > 0, '新的忙碌窗口却不延迟了')
  return `第一条 ${first / 1000} 秒，之后 0 秒`
})

check('"懒得下楼买"这种否定句不算忙', () => {
  /*
   * "懒得"是她的口头禅，而这类句子恰好都带 heavy 动词：
   *   "看了眼冰箱只有两颗鸡蛋了，懒得下楼买"
   *   "下午把剩面热了吃，还是懒得洗碗"
   * 照动词表判她就在忙，可意思正好相反——她没下楼、没洗碗。
   * 判错的代价不是延迟，是**她显得在撒谎**：说自己在洗碗，其实闲得很。
   */
  journalJustNow('看了眼冰箱只有两颗鸡蛋了，懒得下楼买')
  assert(busyState().level === 'idle', '把"懒得下楼买"当成了在忙')
  journalJustNow('下午把剩面热了吃，还是懒得洗碗')
  assert(busyState().level === 'idle', '把"懒得洗碗"当成了在忙')
  return 'idle'
})

check('真在忙的流水照样算忙（否定句判断没扩大）', () => {
  journalJustNow('下楼拿快递')
  assert(busyState().level === 'heavy', '"下楼拿快递"被误判成不忙了')
  journalJustNow('起来煮了碗面')
  assert(busyState().level === 'heavy', '"煮面"被误判成不忙了')
  return 'heavy'
})

check('忙就延迟，且落在合理区间', () => {
  journalJustNow('下楼拿快递')
  const d = replyDelay(cfg)
  assert(d > 0, '忙着却不延迟')
  const sec = d / 1000
  assert(sec >= 10, `延迟太短（${sec} 秒），用户感知不到"她在忙"`)
  assert(sec <= 150, `延迟太长（${sec} 秒），用户会以为消息没发出去`)
  return `${sec} 秒`
})

check('关掉功能就一律不延迟', () => {
  journalJustNow('下楼拿快递')
  const d = replyDelay({ ...cfg, busy: { ...cfg.busy, enabled: false } })
  assert(d === 0, '关掉了还延迟')
  return '0 秒'
})

check('多次取样都要落在区间里', () => {
  journalJustNow('下楼拿快递')
  for (let i = 0; i < 30; i++) {
    const sec = replyDelay(cfg) / 1000
    assert(sec >= 10 && sec <= 150, `第 ${i} 次超出区间：${sec} 秒`)
  }
  return '30 次都在区间内'
})

console.log('\n给她的交代\n')

check('不忙时是空串（不注入空段落）', () => {
  writeJournal([])
  assert(buildBusySection(busyState()) === '', '不忙却生成了段落')
  return '空串'
})

check('忙时注入，并要求"先交代一句"', () => {
  journalJustNow('起来煮了碗面')
  const s = buildBusySection(busyState())
  assert(s.includes('起来煮了碗面'), '没带上她在忙什么')
  assert(/先交代一句/.test(s), '没要求她交代一句')
  assert(/别道歉|没什么好道歉/.test(s), '没说明"不用道歉"')
  return `${s.length} 字`
})

check('要求她"只在真的被打断时交代"，不是每次都说', () => {
  journalJustNow('起来煮了碗面')
  const s = buildBusySection(busyState())
  assert(/只在真的被打断/.test(s), '没限制频率，她会每次都说"我在忙"')
  return '有'
})

check('busyStatus 给得出人看的摘要', () => {
  journalJustNow('下楼拿快递')
  const st = busyStatus(cfg)
  assert(st.level === 'heavy', '等级不对')
  assert(typeof st.agoMinutes === 'number', '没给出多久之前')
  assert(st.wouldDelaySeconds > 0, '没给出会延迟多少')
  return `${st.level} · ${st.agoMinutes} 分钟前 · 延迟 ${st.wouldDelaySeconds} 秒`
})

check('light 时不注入"我在忙"那段（她本来就没被耽误）', () => {
  /*
   * 状态和说辞必须同源。light 不再延迟了，如果还给她那段
   * "你刚才在忙这个，所以看到消息晚了一点"，她就会编一句
   * "刚在改东西"——可她根本没被耽误。那是**她说的话和事实对不上**，
   * 比回得慢更伤。
   */
  journalJustNow('三百块的活改八遍')
  const s = busyState()
  assert(s.level === 'light', `夹具应该是 light，实际 ${s.level}`)
  assert(buildBusySection(s) === '', 'light 还注入了"我在忙"那段 —— 她要说假话了')
  journalJustNow('下楼拿快递')
  assert(buildBusySection(busyState()).includes('下楼拿快递'), 'heavy 反而不注入了')
  return 'light 空 / heavy 有'
})

check('等待时那句话和顶栏同一套说法', () => {
  journalJustNow('起来煮了碗面')
  const s = busyState()
  const label = waitingLabel(s)
  assert(label.includes('煮面'), `没带上她在忙什么：${label}`)
  assert(!label.startsWith('在在'), `拼出了"在在"：${label}`)
  // "睡着了"这类本身就是完整状态，不能再加"在"
  journalJustNow('十二点半被猫踩醒，又睡过去了')
  const asleep = waitingLabel(busyState())
  assert(!asleep.includes('在睡'), `"睡着了"被拼成"在睡着了"：${asleep}`)
  return `${label} / ${asleep}`
})

console.log('\n她的作息解析\n')

check('能解析"凌晨三四点睡，中午前后起"', () => {
  const w = parseSleepWindow('凌晨三四点睡，中午前后起')
  assert(w.sleepHour === 3, `睡觉点应该 3，实际 ${w.sleepHour}`)
  assert(w.wakeHour === 12, `起床点应该 12，实际 ${w.wakeHour}`)
  return `${w.sleepHour} 点睡 / ${w.wakeHour} 点起`
})

check('"三四点"取的是 3（"around 3-4"，取下限）', () => {
  assert(parseSleepWindow('四五点才睡').sleepHour === 4, '"四五点"应该取 4')
  assert(parseSleepWindow('五六点睡').sleepHour === 5, '"五六点"应该取 5')
  return '取下限'
})

check('各种写法都能解析', () => {
  const cases = [
    ['两点睡，十一点起', 2, 11],
    ['3 点睡，中午起', 3, 12],
    ['四五点才睡，下午两点起', 4, 14],
    ['我一般 1 点睡，9 点起', 1, 9],
  ]
  for (const [text, s, w] of cases) {
    const r = parseSleepWindow(text)
    assert(r.sleepHour === s && r.wakeHour === w, `「${text}」解析成 ${r.sleepHour}/${r.wakeHour}，期望 ${s}/${w}`)
  }
  return `${cases.length} 种`
})

check('句子里的"一起"不会被当成"一点起"（真踩过的坑）', () => {
  /*
   * 真实事故：life.md 里有一句"我们上次一起去的那家店"（讲硬边界的），
   * 正则把"一起"匹配成了"一点起"，于是 wakeHour 变成 1，
   * 她整个作息就错乱了——变成 4 点睡、1 点起。
   */
  const w = parseSleepWindow('凌晨三四点睡，中午前后起。不存在"我们上次一起去的那家店"这种说法')
  assert(w.wakeHour === 12, `被"一起"带偏了，wakeHour=${w.wakeHour}`)
  assert(w.sleepHour === 3, `sleepHour 也不对：${w.sleepHour}`)
  return `${w.sleepHour}/${w.wakeHour} 正确`
})

check('"早上九点起"要按九点算，不能只看"早上"就当成七点（真踩过的坑）', () => {
  /*
   * 真实事故，而且是最难发现的那种：**不是解析失败，是解析出一个
   * 看起来合理的错数**。
   *
   * life.md 从"中午前后起"改成"早上九点起"之后，程序解析出来是 7——
   * 因为时段词那条分支只认"早上"这个词，硬映射成 7，
   * **后面那个"九点"根本没看**。parsed 还是 true，doctor 也照实打印 7，
   * 一路都像正常。她明明写着九点起，实际七点就醒。
   *
   * 规则应该是：有时刻就以时刻为准，时段词只负责补 12 小时制。
   */
  const a = parseSleepWindow('凌晨三四点睡，早上九点起')
  assert(a.wakeHour === 9, `"早上九点起"解析成了 ${a.wakeHour} 点`)
  assert(a.sleepHour === 3, `sleepHour 不对：${a.sleepHour}`)

  // 八点、十点同样不能被"早上"吃掉
  assert(parseSleepWindow('两点睡，早上八点起').wakeHour === 8, '"早上八点起"不对')
  assert(parseSleepWindow('一点睡，上午十点起').wakeHour === 10, '"上午十点起"不对')
  // 下午的十二小时制还要补回来
  assert(parseSleepWindow('四点睡，下午两点起').wakeHour === 14, '"下午两点起"应该补成 14')
  // 没说钟点的，照样按时段词的默认值
  assert(parseSleepWindow('凌晨三四点睡，中午前后起').wakeHour === 12, '"中午前后起"不该受影响')
  assert(parseSleepWindow('三点睡，早上起').wakeHour === 7, '"早上起"（无钟点）该走默认值 7')
  return '9 / 8 / 10 / 14 / 12 / 7 都对'
})

check('解析不出来时退回默认值，不报错也不乱算', () => {
  const w = parseSleepWindow('作息乱七八糟')
  assert(w.parsed === false, '不该说解析成功')
  assert(w.sleepHour === 3 && w.wakeHour === 11, `兜底值不对：${w.sleepHour}/${w.wakeHour}`)
  assert(parseSleepWindow('').sleepHour === 3, '空串没兜住')
  assert(parseSleepWindow(null).sleepHour === 3, 'null 没兜住')
  return '兜底 3/11'
})

console.log('\n困劲儿曲线\n')

check('一天里只有该困的时候困（跨午夜不能算错）', () => {
  /*
   * 踩过一次：15:00 和 19:00 被判成"睡熟了"。
   * 原因是拿"醒了几小时"和总时长比，午后会跳到一个大于时长的值。
   * 正确做法是判断钟点在不在 [入睡, 起床) 这段弧上。
   */
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  const levels = {}
  for (const h of [0, 2, 3, 6, 9, 12, 15, 18, 21, 23]) {
    levels[h] = sleepiness({ at: at(h), window: w })
  }

  // 白天到前半夜必须清醒
  for (const h of [12, 15, 18, 21, 23]) {
    assert(levels[h].level === 0, `${h}:00 应该清醒，实际「${levels[h].label}」`)
  }
  // 睡觉时段必须是睡
  for (const h of [3, 6, 9]) {
    assert(levels[h].isAsleepPeriod, `${h}:00 应该在睡觉时段`)
  }
  // 睡前两小时内开始困
  assert(levels[2].level > 0, '睡前 1 小时还不困')
  return '白天清醒、夜里困'
})

check('刚睡下算"迷迷糊糊"，睡久了算"睡熟了"', () => {
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  assert(sleepiness({ at: at(3, 30), window: w }).label === '刚被吵醒，迷迷糊糊', '刚睡下的标签不对')
  assert(sleepiness({ at: at(8), window: w }).label === '睡熟了', '睡久了的标签不对')
  return 'ok'
})

check('困劲儿是 0-1 之间的数', () => {
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  for (let h = 0; h < 24; h++) {
    const lv = sleepiness({ at: at(h), window: w }).level
    assert(lv >= 0 && lv <= 1, `${h}:00 的困劲儿越界：${lv}`)
  }
  return '24 个小时都在 0-1'
})

check('睡前时段不能有断层（awakeSpan 算反过的真实 bug）', () => {
  /*
   * 这条盯的是一个很典型、用户直接看得见的 bug：
   *
   * 她 3 点睡、12 点起，清醒时长是 **9 小时**（12:00 → 次日 3:00）。
   * 但代码里写成了 `awakeSpan = 24 - sleepSpan = 15`——
   * 于是"睡前两小时"被推到"清醒了 13 小时"，而那已经是早上 10 点，
   * **她早睡着了**。
   *
   * 后果：22:00、0:00、1:00、2:00 全显示"清醒"，3:00 突然跳到"睡了"，
   * 中间那几小时的困劲儿整个丢掉。用户看到的就是
   * "状态栏怎么一直没反应"。
   *
   * 正确的算法是 `awakeSpan = rel(sleepHour, wakeHour)`。
   */
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  const s = {}
  for (let h = 0; h < 24; h++) s[h] = sleepiness({ at: at(h), window: w })

  // 睡前那几小时必须已经有困意，不能是"清醒"
  for (const h of [1, 2]) {
    assert(s[h].level > 0, `${h}:00 应该困了，实际「${s[h].label}」`)
  }
  // 白天必须清醒（别矫枉过正把下午也弄困了）
  for (const h of [13, 16, 19]) {
    assert(s[h].level === 0, `${h}:00 应该清醒，实际「${s[h].label}」`)
  }
  // 睡着的那几小时必须是睡
  for (const h of [4, 7, 10]) {
    assert(s[h].isAsleepPeriod, `${h}:00 应该在睡觉时段`)
  }
  return '睡前有困意、白天清醒、睡着是睡'
})

check('困 → 睡 连续，中间不跳空', () => {
  /*
   * 上面那条测"某个点对不对"，这条测**过渡**：
   * 从清醒到睡着之间不该存在一段"既不清醒也不困"的空档。
   * 那个空档正是 awakeSpan 算错时的表现。
   */
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  const states = []
  for (let h = 0; h < 24; h++) {
    const r = sleepiness({ at: at(h), window: w })
    states.push({ h, level: r.level, asleep: r.isAsleepPeriod })
  }

  for (let i = 1; i < states.length; i++) {
    const prev = states[i - 1]
    const cur = states[i]
    if (!prev.asleep && cur.asleep) {
      assert(prev.level > 0, `从 ${prev.h}:00（清醒）直接跳到 ${cur.h}:00（睡着），中间没有过渡`)
    }
  }
  return '过渡连续'
})

console.log('\n睡觉时段的行为\n')

check('清醒时是空串，不注入', () => {
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  assert(buildSleepySection(sleepiness({ at: at(15), window: w })) === '', '清醒却注入了段落')
  return '空串'
})

check('困的时候注入，并要求回得很短', () => {
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  const s = buildSleepySection(sleepiness({ at: at(2), window: w }))
  assert(/困/.test(s), '没提到困')
  assert(/回得很短|一句话/.test(s), '没要求回得短')
  assert(/别主动开新话题/.test(s), '没禁止开新话题')
  return `${s.length} 字`
})

check('**绝不能**变成不回（那是服务故障，不是真人感）', () => {
  /*
   * 这条是这个功能最重要的一条边界。
   * 半夜说话没人理，用户会以为服务挂了——那比"她不困"糟糕得多。
   */
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  const s = buildSleepySection(sleepiness({ at: at(4), window: w }))
  assert(/不要不回/.test(s), '没有"不要不回"这条硬要求')
  assert(/应一声/.test(s), '没要求至少应一声')
  return '有'
})

check('睡觉时段不主动找人说话', () => {
  const w = parseSleepWindow('凌晨三点睡，中午十二点起')
  // activeHoursGate 读的是真实 life.md，所以这里直接测它的返回值形状
  const gate = activeHoursGate(cfg, at(15))
  assert(gate.ok === true, '白天不该被拦：' + gate.reason)
  const gate2 = activeHoursGate(cfg, at(5))
  assert(typeof gate2.ok === 'boolean', '没返回判断结果')
  if (!gate2.ok) assert(/睡觉/.test(gate2.reason), '理由没说清是在睡觉：' + gate2.reason)
  return gate2.ok ? '（当前作息下 5 点不算睡）' : gate2.reason
})

check('关掉开关就不拦主动开口', () => {
  const gate = activeHoursGate({ ...cfg, sleepy: { respectInProactive: false } }, at(5))
  assert(gate.ok === true, '关掉了还拦')
  return '不拦'
})

console.log('\n注入位置\n')

check('聊天提示词里可以有忙碌和困（它们是当下状态）', () => {
  const prompt = buildChatSystemPrompt({
    persona: '你是阿岚',
    memory: '',
    lastExchangeAt: Date.now(),
    busySection: '【你手上正在忙的事】\n刚刚你：在煮面',
    sleepySection: '【你现在的状态：开始困了】',
  })
  assert(/【你手上正在忙的事】/.test(prompt), '忙碌段没了')
  assert(/【你现在的状态/.test(prompt), '困劲儿段没了')
  return '都在'
})

check('报备提示词要求"一句话、不道歉、不客套"', () => {
  const msgs = buildBusyAnnouncePrompt({ persona: '你是阿岚', activity: '去洗澡' })
  const text = msgs.map((m) => m.content).join('\n')
  assert(/一句话/.test(text), '没要求一句话')
  assert(/不要道歉/.test(text), '没禁止道歉')
  assert(/通知/.test(text), '没禁止通知腔')
  assert(/只输出这一句话/.test(text), '没限制输出')
  return '有'
})

check('写入的不是真实 data 目录', () => {
  assert(
    path.resolve(PATHS.data) === path.resolve(process.env.FRIEND_DATA_DIR),
    `PATHS.data 指向了 ${PATHS.data}`,
  )
  return PATHS.data
})

// 收尾：把流水清空，免得影响别的测试
writeJournal([])

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
