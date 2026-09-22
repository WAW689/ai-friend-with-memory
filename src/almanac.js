/**
 * 黄历：农历、节假日、调休、昼夜判定。
 *
 * 为什么必须由程序算，不能让模型自己推：
 *   农历和每年变动的节假日，语言模型**算不准也不该让它算**。
 *   它会把中秋说成随便一天、会说"周六要上班"。这类错误用户一眼就看出来，
 *   而且一旦说错，前面攒的"她像个真人"全塌了。
 *
 * 三个数据来源，可靠性不同：
 *   1. 农历表   —— 内置，1900-2100。从成熟实现取来，用国务院公布的
 *                  春节/中秋日期交叉验证过（8 项全对）。
 *   2. 节假日   —— 内置 2025-2026 官方安排（放假 + 调休），
 *                  数据来自 holiday-cn 公开数据集（跟着国务院通知更新）。
 *   3. 昼夜     —— 不用固定小时猜，用当天真实的日出日落（见 weather.js）。
 *                  上海夏天 5 点天亮、冬天 5 点天黑，按小时猜必然出错。
 */
import { localDateKey } from './util.js'

/* ------------------------------------------------------------ 农历数据 */

/**
 * 农历年份编码表，1900-2100，每年一个 17 位十六进制数。
 *
 * 位含义（标准约定）：
 *   bit 16      闰月是否 30 天（1 = 30 天，0 = 29 天）
 *   bit 15..4   正月到十二月是否 30 天（从高到低对应 1-12 月）
 *   bit 3..0    闰月月份，0 表示当年不闰
 *
 * 这张表不是手写的：从 solarlunar 取来后，用春节和中秋的官方日期
 * 校验过 2024-2027 共 8 项，全部吻合。改动它之前请先跑 test/almanac.js。
 */
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
]

const LUNAR_MIN_YEAR = 1900
const LUNAR_MAX_YEAR = 1900 + LUNAR_INFO.length - 1

/** 农历月份的写法 */
const LUNAR_MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']
/** 农历日子（1-30） */
const LUNAR_DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]

function leapMonth(year) {
  return LUNAR_INFO[year - LUNAR_MIN_YEAR] & 0xf
}

function leapDays(year) {
  if (leapMonth(year) === 0) return 0
  return LUNAR_INFO[year - LUNAR_MIN_YEAR] & 0x10000 ? 30 : 29
}

function monthDays(year, month) {
  if (month > 11) return 30
  return LUNAR_INFO[year - LUNAR_MIN_YEAR] & (0x10000 >> month) ? 30 : 29
}

function lunarYearDays(year) {
  let sum = 348
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += LUNAR_INFO[year - LUNAR_MIN_YEAR] & i ? 1 : 0
  return sum + leapDays(year)
}

/** 农历 → 公历 */
export function lunarToSolar(lunarYear, lunarMonth, lunarDay, isLeap = false) {
  if (lunarYear < LUNAR_MIN_YEAR || lunarYear > LUNAR_MAX_YEAR) return null

  let offset = 0
  for (let y = LUNAR_MIN_YEAR; y < lunarYear; y++) offset += lunarYearDays(y)

  const leap = leapMonth(lunarYear)
  let added = false
  for (let m = 1; m <= 12; m++) {
    if (leap > 0 && m === leap + 1 && !added) {
      if (isLeap && lunarMonth === leap) break
      offset += leapDays(lunarYear)
      added = true
    }
    if (m === lunarMonth) break
    offset += monthDays(lunarYear, m)
  }
  offset += lunarDay - 1

  const d = new Date(Date.UTC(1900, 0, 31) + offset * 86400000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** 公历 → 农历。返回 { year, month, day, isLeap, text } */
export function solarToLunar(date = new Date()) {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()

  if (y < LUNAR_MIN_YEAR || y > LUNAR_MAX_YEAR) return null

  // 用公历算和 1900-01-31 相差多少天
  const base = Date.UTC(1900, 0, 31)
  const target = Date.UTC(y, m - 1, d)
  let offset = Math.floor((target - base) / 86400000)
  if (offset < 0) return null

  let lunarYear = LUNAR_MIN_YEAR
  while (lunarYear <= LUNAR_MAX_YEAR) {
    const days = lunarYearDays(lunarYear)
    if (offset < days) break
    offset -= days
    lunarYear++
  }
  if (lunarYear > LUNAR_MAX_YEAR) return null

  const leap = leapMonth(lunarYear)
  let isLeap = false
  let lunarMonth = 1

  for (let mm = 1; mm <= 12; mm++) {
    let days
    if (leap > 0 && mm === leap + 1) {
      // 先过闰月
      days = leapDays(lunarYear)
      if (offset < days) {
        isLeap = true
        lunarMonth = leap
        break
      }
      offset -= days
    }
    days = monthDays(lunarYear, mm)
    if (offset < days) {
      lunarMonth = mm
      break
    }
    offset -= days
  }

  const lunarDay = offset + 1
  return {
    year: lunarYear,
    month: lunarMonth,
    day: lunarDay,
    isLeap,
    text: `${isLeap ? '闰' : ''}${LUNAR_MONTH_NAMES[lunarMonth - 1]}月${LUNAR_DAY_NAMES[lunarDay - 1] ?? lunarDay}`,
  }
}

/* ------------------------------------------------------------ 节假日 */

/**
 * 官方放假和调休安排。
 *
 * 格式：[日期, 节日名, 类型]，类型 1 = 放假，0 = **调休要上班**
 *
 * 数据来自 holiday-cn（跟着国务院通知更新的公开数据集），
 * 已覆盖 2025 和 2026 两年——这两年的安排都已正式公布，是确定的。
 *
 * 为什么要把调休单独标出来：用户明确说过不喜欢调休。
 * 她如果不知道哪天要补班，就可能说出"周末好好休息"这种假话。
 *
 * 2027 年之后怎么办：这里没有的话就不提节假日（宁可不提，不能说错），
 * 想支持新一年就把那一年的数据补进来。
 */
const HOLIDAYS = new Map()
const HOLIDAY_TABLE = [
  // 2025
  ['2025-01-01', '元旦', 1],
  ['2025-01-26', '春节', 0],
  ['2025-01-28', '春节', 1],
  ['2025-01-29', '春节', 1],
  ['2025-01-30', '春节', 1],
  ['2025-01-31', '春节', 1],
  ['2025-02-01', '春节', 1],
  ['2025-02-02', '春节', 1],
  ['2025-02-03', '春节', 1],
  ['2025-02-04', '春节', 1],
  ['2025-02-08', '春节', 0],
  ['2025-04-04', '清明节', 1],
  ['2025-04-05', '清明节', 1],
  ['2025-04-06', '清明节', 1],
  ['2025-04-27', '劳动节', 0],
  ['2025-05-01', '劳动节', 1],
  ['2025-05-02', '劳动节', 1],
  ['2025-05-03', '劳动节', 1],
  ['2025-05-04', '劳动节', 1],
  ['2025-05-05', '劳动节', 1],
  ['2025-05-31', '端午节', 1],
  ['2025-06-01', '端午节', 1],
  ['2025-06-02', '端午节', 1],
  ['2025-09-28', '国庆节、中秋节', 0],
  ['2025-10-01', '国庆节、中秋节', 1],
  ['2025-10-02', '国庆节、中秋节', 1],
  ['2025-10-03', '国庆节、中秋节', 1],
  ['2025-10-04', '国庆节、中秋节', 1],
  ['2025-10-05', '国庆节、中秋节', 1],
  ['2025-10-06', '国庆节、中秋节', 1],
  ['2025-10-07', '国庆节、中秋节', 1],
  ['2025-10-08', '国庆节、中秋节', 1],
  ['2025-10-11', '国庆节、中秋节', 0],

  // 2026
  ['2026-01-01', '元旦', 1],
  ['2026-01-02', '元旦', 1],
  ['2026-01-03', '元旦', 1],
  ['2026-01-04', '元旦', 0],
  ['2026-02-14', '春节', 0],
  ['2026-02-15', '春节', 1],
  ['2026-02-16', '春节', 1],
  ['2026-02-17', '春节', 1],
  ['2026-02-18', '春节', 1],
  ['2026-02-19', '春节', 1],
  ['2026-02-20', '春节', 1],
  ['2026-02-21', '春节', 1],
  ['2026-02-22', '春节', 1],
  ['2026-02-23', '春节', 1],
  ['2026-02-28', '春节', 0],
  ['2026-04-04', '清明节', 1],
  ['2026-04-05', '清明节', 1],
  ['2026-04-06', '清明节', 1],
  ['2026-05-01', '劳动节', 1],
  ['2026-05-02', '劳动节', 1],
  ['2026-05-03', '劳动节', 1],
  ['2026-05-04', '劳动节', 1],
  ['2026-05-05', '劳动节', 1],
  ['2026-05-09', '劳动节', 0],
  ['2026-06-19', '端午节', 1],
  ['2026-06-20', '端午节', 1],
  ['2026-06-21', '端午节', 1],
  ['2026-09-20', '国庆节', 0],
  ['2026-09-25', '中秋节', 1],
  ['2026-09-26', '中秋节', 1],
  ['2026-09-27', '中秋节', 1],
  ['2026-10-01', '国庆节', 1],
  ['2026-10-02', '国庆节', 1],
  ['2026-10-03', '国庆节', 1],
  ['2026-10-04', '国庆节', 1],
  ['2026-10-05', '国庆节', 1],
  ['2026-10-06', '国庆节', 1],
  ['2026-10-07', '国庆节', 1],
  ['2026-10-10', '国庆节', 0],
]

for (const [date, name, off] of HOLIDAY_TABLE) {
  HOLIDAYS.set(date, { name, offDay: off === 1 })
}

/** 这一天的节假日情况。没有就返回 null（周末不算节假日，那是算出来的） */
export function holidayOn(dateKey) {
  return HOLIDAYS.get(dateKey) ?? null
}

/** 内置数据覆盖的年份 */
export function holidayYears() {
  const years = new Set()
  for (const key of HOLIDAYS.keys()) years.add(Number(key.slice(0, 4)))
  return [...years].sort()
}

/**
 * 往前找下一个"还没开始"的放假节日。
 *
 * 两个容易做错的地方：
 *
 * 1. **节日当天要跳过。** 中秋放假 9/25-9/27，如果 9/25 那天还在报
 *    "还有 0 天就是中秋"，她会说"马上中秋了"——而今天就是中秋。
 *    所以只认那些**从明天开始**的假期段。
 * 2. **要认得出连续的假期段。** "放假 3 天"这个信息比"还有 3 天"有用得多，
 *    她知道"放假 3 天"才能说出"那你是不是能歇几天"。
 *
 * 返回 { dateKey, name, daysAway, span, last } 或 null。
 */
export function nextHoliday(from = new Date(), maxDays = 400) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const startKey = localDateKey(start.getTime())

  // 先扫出所有"放假日"，按日期排序
  const offDays = []
  for (let i = 1; i <= maxDays; i++) {
    const key = localDateKey(start.getTime() + i * 86400000)
    const h = HOLIDAYS.get(key)
    if (h?.offDay) offDays.push({ key, name: h.name, offset: i })
  }
  if (offDays.length === 0) return null

  /*
   * 找出"假期段"：名字相同、日期连续的放假日算一段。
   * 名字会变（比如"国庆节、中秋节"和"国庆节"），所以名字只用来取展示名，
   * 分段的依据是**日期连续**。
   */
  const runs = []
  let current = null
  for (const day of offDays) {
    const prev = current?.days[current.days.length - 1]
    const contiguous =
      prev && new Date(prev.key).getTime() + 86400000 === new Date(day.key).getTime()
    if (contiguous) {
      current.days.push(day)
      // 用第一个非空名字里最靠前的，避免后面被覆盖成"国庆节"
      if (!current.name) current.name = day.name
    } else {
      current = { name: day.name, days: [day] }
      runs.push(current)
    }
  }

  /*
   * 只考虑"还没开始"的假期段。
   *
   * 难点在于：假期是一段连续的放假日，从中间某天看过去，
   * 剩下的几天仍然算同一次假期。中秋放 9/25-9/27，如果 9/26 那天
   * 还把 9/27 报成"下一个中秋"，她就会说"马上中秋了"——可中秋都过了。
   *
   * 所以：如果今天正在放假（或今天就是某个假期的一部分），
   * 把**跟今天连着的那一段**整段划掉，从它后面找。
   */
  const todayOff = HOLIDAYS.get(startKey)?.offDay === true
  const startedToday = []
  if (todayOff) {
    // 往前追，把跟今天连着的这段假期的起点找出来
    let cursor = start
    let guard = 0
    while (guard++ < 60) {
      const prevKey = localDateKey(cursor.getTime() - 86400000)
      if (HOLIDAYS.get(prevKey)?.offDay) cursor = new Date(cursor.getTime() - 86400000)
      else break
    }
    // 这段假期本身不是一个"未来的假期"，所以要跳过它的全部日子
    startedToday.push(localDateKey(cursor.getTime()))
  }

  for (const run of runs) {
    const first = run.days[0]
    if (first.key <= startKey) continue

    /*
     * 如果这一段和"今天正在放的那一段"是连着的，说明它属于同一次假期，
     * 只是被今天的边界切开了。跳过。
     */
    if (startedToday.length) {
      const runStart = new Date(first.key).getTime()
      const todayRunStart = new Date(startedToday[0]).getTime()
      // 今天这段假期一直延伸到 run 的起点前，说明是同一段
      const bridge = localDateKey(runStart - 86400000)
      if (HOLIDAYS.get(bridge)?.offDay && runStart > todayRunStart) {
        // 继续往后找
        continue
      }
    }

    return {
      dateKey: first.key,
      name: run.name,
      daysAway: first.offset,
      span: run.days.length,
      last: run.days[run.days.length - 1].key,
    }
  }
  return null
}

/* ------------------------------------------------------------ 昼夜 */

/**
 * 按太阳位置说"现在算什么时段"，而不是按固定小时。
 *
 * 为什么不能用小时猜：上海夏至 5 点就亮、冬天 17 点就黑。
 * 按"6-18 点算白天"猜，冬天傍晚 17:30 她会说"天还亮着呢"，
 * 夏天早上 5:30 会说"大半夜的"——都会被用户当场发现。
 *
 * @param {Date} date
 * @param {{sunrise?: string, sunset?: string}} sun 当天的日出日落（"HH:MM"）
 */
export function dayPhase(date = new Date(), sun = {}) {
  const minutes = date.getHours() * 60 + date.getMinutes()
  const toMin = (s) => {
    const m = /^(\d{2}):(\d{2})$/.exec(String(s ?? ''))
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }

  const rise = toMin(sun.sunrise)
  const set = toMin(sun.sunset)

  // 拿不到日出日落就退回保守的分段（不如真实数据准，但不会太离谱）
  if (rise === null || set === null) {
    const h = date.getHours()
    if (h < 5) return { phase: '深夜', sunrise: null, sunset: null }
    if (h < 9) return { phase: '清早', sunrise: null, sunset: null }
    if (h < 12) return { phase: '上午', sunrise: null, sunset: null }
    if (h < 14) return { phase: '中午', sunrise: null, sunset: null }
    if (h < 18) return { phase: '下午', sunrise: null, sunset: null }
    if (h < 22) return { phase: '晚上', sunrise: null, sunset: null }
    return { phase: '夜里', sunrise: null, sunset: null }
  }

  let phase
  /*
   * "天快亮了"的窗口要是**小**的（40 分钟）。
   *
   * 原来用 60 分钟，结果 4:00（日出 4:52）就被算成"天快亮了"——
   * 那时候外面还是全黑的，她会说"天快亮了"，用户看一眼窗外就知道不对。
   */
  if (minutes < rise - 40) phase = '深夜'
  else if (minutes < rise) phase = '天快亮了'
  else if (minutes < rise + 120) phase = '清早'
  else if (minutes < 11 * 60) phase = '上午'
  else if (minutes < 13 * 60) phase = '中午'
  else if (minutes < set - 90) phase = '下午'
  else if (minutes < set) phase = '傍晚'
  else if (minutes < set + 90) phase = '天刚黑'
  else if (minutes < 23 * 60) phase = '晚上'
  else phase = '深夜'

  return { phase, sunrise: sun.sunrise, sunset: sun.sunset }
}

/** 一年里的季节 */
export function seasonOf(date = new Date()) {
  const m = date.getMonth() + 1
  if (m >= 3 && m <= 5) return '春天'
  if (m >= 6 && m <= 8) return '夏天'
  if (m >= 9 && m <= 11) return '秋天'
  return '冬天'
}

/* ------------------------------------------------------------ 给模型的描述 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 拼出让模型"知道现在是什么时候"的那一段。
 *
 * 这是她所有时间概念的唯一来源。模型对时间非常不可靠——
 * 它会从对话记录里抓一个钟点当成"现在"，也会把中秋说成随便一天。
 * 所以这里要把话说到不留余地：这是唯一准确的时间，别处说的都不算。
 *
 * @param {Date} date
 * @param {{sunrise?: string, sunset?: string}} sun
 */
export function describeNow(date = new Date(), sun = {}) {
  const key = localDateKey(date.getTime())
  const weekday = WEEKDAYS[date.getDay()]
  const p = (n) => String(n).padStart(2, '0')
  const clock = `${p(date.getHours())}:${p(date.getMinutes())}`

  const lines = [`现在是 ${key}（${weekday}）${clock}。`]

  const lunar = solarToLunar(date)
  if (lunar) lines.push(`农历${lunar.text}。`)

  lines.push(`季节：${seasonOf(date)}。`)

  const phase = dayPhase(date, sun)
  if (phase.sunrise && phase.sunset) {
    lines.push(`现在算"${phase.phase}"（今天日出 ${phase.sunrise}、日落 ${phase.sunset}）。`)
  } else {
    lines.push(`现在算"${phase.phase}"。`)
  }

  const today = HOLIDAYS.get(key)
  if (today) {
    lines.push(
      today.offDay
        ? `今天是${today.name}，放假。`
        : `注意：今天是${today.name}的调休，**要上班/上课**（不是休息日）。`,
    )
  }

  const next = nextHoliday(date)
  if (next && next.daysAway <= 45) {
    const span = next.span > 1 ? `，放假 ${next.span} 天（到 ${next.last}）` : ''
    lines.push(`下一个放假的节日：${next.name} ${next.dateKey}，还有 ${next.daysAway} 天${span}。`)
  }

  return lines.join('\n')
}
