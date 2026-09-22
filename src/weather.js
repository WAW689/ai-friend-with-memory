/**
 * 天气。
 *
 * 数据源：Open-Meteo。选它的三个理由：
 *   1. **不需要 API Key** —— 用户装完就能用，不用再去申请一样东西
 *   2. 免费
 *   3. 顺带给日出日落，正好用来判断"现在算白天还是晚上"
 *
 * 设计上最重要的一条原则：**天气绝不能每轮都塞进提示词**。
 *
 * 不是省 token，是怕她变成天气播报员。真朋友不会每句话后面都挂一句
 * "今天 26 度还挺舒服"——那样人设立刻就崩了。所以天气只在两个场合给她：
 *   · 主动开口时（"下雨了" 是一个很自然的搭话由头）
 *   · 对方问起时她才需要知道
 *
 * 另一条：**给她的天气要标清楚"这是你查到的，不是你感受到的"**。
 * 不标的话她会用预报数据编造亲身经历（整天没出门却说"外面真热"），
 * 前后一对就穿帮。这件事交给提示词去管，代码这边只负责给准确数据。
 *
 * 断网时静默降级：拿不到就不注入，绝不影响聊天。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from './config.js'
import { log, now, readJson, writeJsonAtomic } from './util.js'

/** 缓存多久算新鲜。天气变化没那么快，15 分钟够了。 */
const TTL_MS = 15 * 60 * 1000

/** 网络超时。天气是锦上添花，不能因为它把聊天拖慢。 */
const TIMEOUT_MS = 6000

/**
 * WMO 天气代码 → 中文。
 *
 * Open-Meteo 返回的是 WMO 标准码，没有中文，得自己映射。
 * 只翻成她能自然说出口的说法，不要"中度雷阵雨伴冰雹"这种气象台腔。
 */
const WMO = {
  0: '晴',
  1: '晴',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '有雾',
  51: '毛毛雨',
  53: '小雨',
  55: '雨不小',
  56: '冻雨',
  57: '冻雨',
  61: '小雨',
  63: '下雨',
  65: '雨挺大',
  66: '冻雨',
  67: '冻雨',
  71: '下雪',
  73: '下雪',
  75: '雪挺大',
  77: '下雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '阵雪',
  95: '打雷',
  96: '雷阵雨',
  99: '雷阵雨',
}

function weatherText(code) {
  return WMO[code] ?? null
}

/** 缓存文件。放 data/ 下，重启不用重新请求。 */
function cacheFile() {
  return path.join(PATHS.data, 'weather.json')
}

function readCache() {
  return readJson(cacheFile(), null)
}

/**
 * 取天气。
 *
 * @param {object} [cfg]
 * @param {{force?: boolean}} [opts] force 忽略缓存（界面上的"刷新"用）
 * @returns {Promise<object|null>} 拿不到就返回 null，绝不抛错
 */
export async function getWeather(cfg = loadConfig(), { force = false } = {}) {
  if (cfg.weather?.enabled === false) return null

  const cached = readCache()
  const age = cached?.at ? now() - cached.at : Infinity
  if (!force && cached && age < TTL_MS) {
    return { ...cached, stale: false, ageMs: age }
  }

  const lat = cfg.weather?.latitude
  const lon = cfg.weather?.longitude
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max' +
    '&timezone=Asia%2FShanghai&forecast_days=1'

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      log.warn(`取天气失败：HTTP ${res.status}`)
      return cached ? { ...cached, stale: true, ageMs: age } : null
    }

    const data = await res.json()
    const c = data.current ?? {}
    const d = data.daily ?? {}

    const snapshot = {
      at: now(),
      fetchedAt: c.time ?? null,
      temperature: c.temperature_2m ?? null,
      feelsLike: c.apparent_temperature ?? null,
      humidity: c.relative_humidity_2m ?? null,
      isDay: c.is_day === 1,
      precipitation: c.precipitation ?? null,
      windSpeed: c.wind_speed_10m ?? null,
      code: c.weather_code ?? null,
      text: weatherText(c.weather_code),
      high: Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max[0] : null,
      low: Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min[0] : null,
      rainChance: Array.isArray(d.precipitation_probability_max)
        ? d.precipitation_probability_max[0]
        : null,
      // 日出日落用 "HH:MM"，跨日的时候 Open-Meteo 给的是完整 ISO 串
      sunrise: shortTime(d.sunrise?.[0]),
      sunset: shortTime(d.sunset?.[0]),
    }

    try {
      writeJsonAtomic(cacheFile(), snapshot)
    } catch (err) {
      log.warn(`写天气缓存失败：${err.message}`)
    }

    return { ...snapshot, stale: false, ageMs: 0 }
  } catch (err) {
    // 断网、超时、DNS 挂了都会走到这里。用旧数据比没有好，但要标出来是旧的。
    log.warn(`取天气失败（用缓存兜底）：${err.message}`)
    return cached ? { ...cached, stale: true, ageMs: age } : null
  }
}

/**
 * 只读缓存，**不联网**（同步）。
 *
 * 为什么需要这么一个东西：buildContext 是同步的，而"现在算白天还是晚上"
 * 需要当天的日出日落。如果为了这个把整条聊天路径改成异步，改动面太大、
 * 而且每次聊天都要等一次网络请求——那是不能接受的。
 *
 * 所以：后台（主动开口那条路）负责刷新缓存，聊天路径只读缓存里的日出日落。
 * 缓存没有（刚装好、或断网很久）就返回 null，almanac 会退回到
 * 保守的小时分段判断——不如真实数据准，但不会说错得离谱。
 */
export function peekWeather() {
  const cached = readCache()
  if (!cached?.at) return null
  return { ...cached, stale: true, ageMs: now() - cached.at }
}

/** 日出日落（同步、不联网版本） */
export function peekSunTimes() {
  const w = peekWeather()
  return { sunrise: w?.sunrise ?? null, sunset: w?.sunset ?? null }
}

/** "2026-09-22T05:42" → "05:42" */
function shortTime(iso) {
  const m = /T(\d{2}:\d{2})/.exec(String(iso ?? ''))
  return m ? m[1] : null
}

/**
 * 日出日落（给 almanac 的昼夜判断用）。
 * 单独拿出来是因为 almanac 不该依赖整个天气对象。
 */
export async function getSunTimes(cfg = loadConfig()) {
  const w = await getWeather(cfg)
  return { sunrise: w?.sunrise ?? null, sunset: w?.sunset ?? null }
}

/**
 * 把天气说成一句人话，给模型看。
 *
 * 刻意**不写成"今天晴，26 度"**这种播报格式，而是写成一个人
 * 打开手机看一眼天气会看到的样子（体感、要不要带伞）。
 * 另外明确标注"这是你查到的"——防止她拿它编造亲身经历。
 */
export function describeWeather(w) {
  if (!w || w.temperature === null || w.temperature === undefined) return ''

  const parts = []
  const t = Math.round(w.temperature)
  parts.push(w.text ? `${w.text}，${t} 度` : `${t} 度`)

  // 体感差得多才提，否则是废话
  if (Number.isFinite(w.feelsLike) && Math.abs(w.feelsLike - w.temperature) >= 3) {
    parts.push(`体感 ${Math.round(w.feelsLike)} 度`)
  }
  if (Number.isFinite(w.high) && Number.isFinite(w.low)) {
    parts.push(`今天 ${Math.round(w.low)}~${Math.round(w.high)} 度`)
  }
  if (Number.isFinite(w.rainChance) && w.rainChance >= 40) {
    parts.push(`降雨概率 ${Math.round(w.rainChance)}%`)
  }

  const stale = w.stale ? `（这是 ${Math.round((w.ageMs ?? 0) / 60000)} 分钟前查的）` : ''
  return `${parts.join('，')}${stale}`
}

/**
 * 拼成注入提示词的那一段。
 *
 * 里面那句"这是你查到的，不是你感受到的"是整个天气功能最关键的一行：
 * 不写它，她会把预报当成亲身经历来说（"外面热死了"——可她整天没出门）。
 * 用户一旦发现这种矛盾，前面攒的真实感就没了。
 */
export function buildWeatherSection(w) {
  const line = describeWeather(w)
  if (!line) return ''

  return `【天气（你刚从手机上查的）】
上海：${line}

怎么用：
- 天气是你**查到的**，不是你感受到的。差别很大：
  你整天没出门就不能说"外面真热"，只能说"看预报今天挺热"。
  想说得像亲身经历，前提是你今天真的出过门（你的生活流水里有出门的记录）。
- 别主动报天气。真朋友不这样说话。它只是给你一个开口的由头，
  或者对方问起"今天冷吗"的时候你能答上来。
- 天气主要影响两件事：你自己今天过得舒不舒服（下雨就不想出门），
  以及提醒对方（降温、下雨、很热）。提醒要轻，一句就够，别唠叨。`
}

/** 天气状态（给界面看） */
export function weatherStatus(w) {
  if (!w) return { ok: false, text: '没有天气数据' }
  return {
    ok: true,
    text: describeWeather(w),
    at: w.at,
    stale: Boolean(w.stale),
    sunrise: w.sunrise,
    sunset: w.sunset,
  }
}

export { TTL_MS as WEATHER_TTL_MS }
