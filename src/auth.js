/**
 * 单用户鉴权。
 *
 * 这不是多租户系统，就你一个人用。所以策略很简单：
 * 一个随机长口令，客户端存在 localStorage，每次请求带上。
 * 口令写在 config.json 里，你可以随时改（也可以设成你记得住的）。
 */
import crypto from 'node:crypto'

/** 恒定时间比较，避免通过响应时间猜口令 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8')
  const bufB = Buffer.from(String(b), 'utf8')
  if (bufA.length !== bufB.length) {
    // 长度不同也要走一遍比较，避免长度泄露
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

/** 从请求里取出口令：优先 Authorization 头，其次 query */
export function extractToken(req, url) {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim()
  const fromQuery = url?.searchParams?.get('token')
  if (fromQuery) return fromQuery
  return ''
}

/** 校验请求是否通过。返回 true 表示放行。 */
export function authorize(req, url, cfg) {
  const expected = cfg.accessToken
  if (!expected) return true // 没设口令就不拦（只适合本机自用）
  const provided = extractToken(req, url)
  if (!provided) return false
  return safeEqual(provided, expected)
}
