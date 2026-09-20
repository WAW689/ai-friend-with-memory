/**
 * Bark 推送（iPhone）。
 *
 * Bark 是 iOS 上的一个开源 App，它借苹果 APNs 下发通知，
 * 所以**不需要你的电脑开着**也能把消息送到手机上 —— 这正是我们要的效果。
 *
 * 用法：在 App 里复制首页那串 key，填进 config.json 的 bark.key。
 * 默认走官方服务器 api.day.app；如果你自建了 Bark 服务端，
 * 把 bark.server 改成你自己的域名即可。
 */
import path from 'node:path'
import { PATHS } from './config.js'
import { appendJsonl, log, now, sleep, truncate } from './util.js'

/**
 * 记录一次推送。
 *
 * 所有推送（主动消息、测试推送）都记进 data/push.log，一处不漏。
 * 之前测试推送没有记录，于是"测试期间到底有没有推手机"根本查不出来——
 * 实测用户在 Bark 历史里发现一长串重复的测试推送，而日志里一条都没有。
 */
export function recordPush(entry) {
  try {
    appendJsonl(path.join(PATHS.data, 'push.log'), { at: now(), ...entry })
  } catch (err) {
    log.warn(`写入推送日志失败：${err.message}`)
  }
}

/** 推送正文太长在锁屏上会被截断，这里先自己裁 */
const MAX_BODY = 240
const MAX_TITLE = 60

export class BarkError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'BarkError'
    this.status = status
    this.body = body
  }
}

/**
 * 发一条推送。
 * @param {object} cfg
 * @param {{ title?: string, body: string, subtitle?: string, url?: string, sound?: string, group?: string, level?: string }} push
 */
export async function push(cfg, { title, body, subtitle, url, sound, group, level } = {}) {
  const bark = cfg.bark ?? {}
  if (!bark.key) throw new BarkError('还没有配置 Bark Key')

  const payload = {
    title: truncate(String(title ?? bark.group ?? '消息'), MAX_TITLE),
    body: truncate(String(body ?? ''), MAX_BODY),
    ...(subtitle ? { subtitle: truncate(String(subtitle), MAX_TITLE) } : {}),
    ...(url ? { url } : {}),
    sound: sound ?? bark.sound ?? 'default',
    group: group ?? bark.group ?? '默认',
    level: level ?? bark.level ?? 'active',
  }

  const base = String(bark.server ?? 'https://api.day.app').replace(/\/+$/, '')
  const key = encodeURIComponent(bark.key)

  // 优先 POST JSON：中文和特殊字符不会被 URL 编码折腾
  try {
    return await postJson(`${base}/push`, key, payload)
  } catch (err) {
    if (err instanceof BarkError && (err.status === 404 || err.status === 405)) {
      // 老版本/自建服务端可能只支持 GET 风格路径
      log.warn('Bark 不支持 /push 接口，改用 GET 形式重试')
      return await getStyle(base, key, payload)
    }
    throw err
  }
}

async function postJson(urlPath, key, payload) {
  const res = await fetch(urlPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, device_key: key }),
  })
  return handleResponse(res)
}

async function getStyle(base, key, payload) {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'title' || k === 'body') continue
    if (v !== undefined && v !== null && v !== '') query.set(k, String(v))
  }
  const qs = query.toString()
  const url = `${base}/${key}/${encodeURIComponent(payload.title)}/${encodeURIComponent(payload.body)}${qs ? `?${qs}` : ''}`
  const res = await fetch(url, { method: 'GET' })
  return handleResponse(res)
}

async function handleResponse(res) {
  const text = await res.text().catch(() => '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }

  if (!res.ok) {
    throw new BarkError(describeBarkError(res.status, parsed, text), { status: res.status, body: text })
  }
  // Bark 正常返回 {"code":200,...}；有的自建版本 code 非 200 但 HTTP 是 200
  if (parsed && typeof parsed.code === 'number' && parsed.code !== 200) {
    throw new BarkError(`Bark 拒绝了这次推送：${parsed.message ?? `code=${parsed.code}`}`, { body: text })
  }
  return { ok: true, response: parsed ?? text }
}

function describeBarkError(status, parsed, text) {
  if (status === 404) return 'Bark 接口不存在（检查 bark.server 地址）'
  if (status === 400) return `Bark 参数有误：${parsed?.message ?? text.slice(0, 120)}`
  if (status === 401 || status === 403) return 'Bark Key 无效（401/403），请重新复制'
  return `Bark 返回 ${status}：${parsed?.message ?? text.slice(0, 120)}`
}

/**
 * 发一条测试推送，用于验证整条链路。
 * 会尝试两次，中间隔 800ms，避免偶发网络抖动误报失败。
 */
/**
 * 发一条测试推送，用于验证整条链路。
 *
 * 必须和 sendPushFor 一样受 FRIEND_NO_PUSH 控制。
 *
 * 这里踩过一个很难受的坑：testPush 直接调 push，**没有任何防护**，
 * 而 smoke.js 每次跑测试都会打 /api/test/bark —— 于是每跑一次测试，
 * 用户手机就响一次"连接成功。我随时能敲你一下"。
 * 实测他在 Bark 的历史消息里翻到一长串重复的测试推送。
 *
 * 测试绝对不该在用户手机上留痕，所以闸门装在这一层，谁调都绕不过去。
 */
export async function testPush(cfg) {
  if (process.env.FRIEND_NO_PUSH === '1') {
    return { ok: false, skipped: true, message: 'FRIEND_NO_PUSH=1，测试环境不发推送' }
  }
  if (!cfg?.bark?.key) {
    return { ok: false, message: '没有配置 Bark Key' }
  }

  const attempts = []
  for (let i = 0; i < 2; i++) {
    try {
      await push(cfg, {
        title: cfg.bark?.group ?? '朋友',
        subtitle: '测试推送',
        body: '连接成功。我随时能敲你一下 👋',
      })
      log.info('已发送测试推送')
      recordPush({ ok: true, kind: 'test', title: cfg.bark?.group ?? '朋友', body: '连接成功。我随时能敲你一下' })
      return { ok: true, attempts: i + 1 }
    } catch (err) {
      attempts.push(err.message)
      if (i === 0) await sleep(800)
    }
  }
  recordPush({ ok: false, kind: 'test', reason: attempts[attempts.length - 1] })
  return { ok: false, message: attempts[attempts.length - 1] }
}
