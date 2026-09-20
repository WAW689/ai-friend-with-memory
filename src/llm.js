/**
 * DeepSeek 客户端。只用官方 REST 接口，不依赖任何 SDK。
 *
 * 两档模型：
 * - chatModel：真正聊天用的，追求活人感
 * - utilityModel：后台杂活（抽取记忆、决定要不要主动开口、滚动摘要），追求便宜稳定
 *   官方 deepseek-chat 同时支持 JSON Output，所以杂活也能拿到结构化结果。
 */
import { log } from './util.js'

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.body = body
  }
}

function endpoint(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`
}

/**
 * 发起一次请求，遇到限流/服务端错误自动重试。
 * @param {object} cfg
 * @param {string} path
 * @param {object} payload
 * @param {{ signal?: AbortSignal, retries?: number }} options
 */
async function request(cfg, path, payload, { signal, retries = 2 } = {}) {
  if (!cfg.model.apiKey) {
    throw new LlmError('还没有配置 DeepSeek API Key')
  }
  const url = endpoint(cfg.model.baseUrl, path)
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new LlmError('已取消')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.model.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal,
      })

      if (res.ok) return res

      const text = await res.text().catch(() => '')
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        const wait = 700 * 2 ** attempt
        log.warn(`DeepSeek ${res.status}，${wait}ms 后重试（第 ${attempt + 1} 次）`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw new LlmError(describeHttpError(res.status, text), { status: res.status, body: text })
    } catch (err) {
      if (err instanceof LlmError) throw err
      lastError = err
      if (attempt < retries && isTransientNetworkError(err)) {
        const wait = 700 * 2 ** attempt
        log.warn(`网络错误（${err.message}），${wait}ms 后重试`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw new LlmError(`请求 DeepSeek 失败：${err.message}`)
    }
  }
  throw new LlmError(`请求 DeepSeek 失败：${lastError?.message ?? '未知错误'}`)
}

function isTransientNetworkError(err) {
  const code = err?.cause?.code ?? err?.code
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
}

function describeHttpError(status, body) {
  if (status === 401) return 'DeepSeek API Key 无效或已过期（401）'
  if (status === 402) return 'DeepSeek 账户余额不足（402）'
  if (status === 429) return 'DeepSeek 触发限流（429），稍后再试'
  let detail = ''
  try {
    const parsed = JSON.parse(body)
    detail = parsed?.error?.message ?? parsed?.message ?? ''
  } catch {
    detail = String(body).slice(0, 200)
  }
  return `DeepSeek 返回 ${status}${detail ? `：${detail}` : ''}`
}

/**
 * 流式对话。逐段 yield 文本增量。
 * @param {object} cfg
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ signal?: AbortSignal, model?: string, temperature?: number, maxTokens?: number }} options
 */
export async function* streamChat(cfg, messages, options = {}) {
  const payload = {
    model: options.model ?? cfg.model.chatModel,
    messages,
    stream: true,
    temperature: options.temperature ?? cfg.model.temperature,
    max_tokens: options.maxTokens ?? cfg.model.maxTokens,
  }

  const res = await request(cfg, '/chat/completions', payload, { signal: options.signal })
  if (!res.body) throw new LlmError('DeepSeek 返回了空响应体')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let receivedAny = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE：事件之间用空行分隔
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let chunk
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }
          const delta = chunk?.choices?.[0]?.delta
          const piece = delta?.content
          if (typeof piece === 'string' && piece.length > 0) {
            receivedAny = true
            yield piece
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  if (!receivedAny) {
    log.warn('DeepSeek 流式响应里没有拿到任何文本')
  }
}

/**
 * 一次性（非流式）调用，用于后台杂活。
 * @returns {Promise<string>} 模型输出的纯文本
 */
export async function complete(cfg, messages, options = {}) {
  const payload = {
    model: options.model ?? cfg.model.utilityModel,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 700,
    ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  }
  const res = await request(cfg, '/chat/completions', payload, { signal: options.signal, retries: options.retries ?? 2 })
  const data = await res.json().catch(() => null)
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new LlmError('DeepSeek 返回结构异常，没找到 choices[0].message.content')
  }
  return content
}

/**
 * 让模型返回 JSON 并解析。
 * 开了 json_object 也不代表一定干净，所以还是做一层容错抽取。
 */
export async function completeJson(cfg, messages, options = {}) {
  const text = await complete(cfg, messages, { ...options, jsonMode: true })
  const parsed = extractJson(text)
  if (parsed === undefined) {
    throw new LlmError(`模型没返回可解析的 JSON：${text.slice(0, 200)}`)
  }
  return parsed
}

/** 从一段可能带 ```json 包裹或前后废话的文本里抠出 JSON 对象 */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], trimmed].filter(Boolean)

  for (const candidate of candidates) {
    const direct = tryParse(candidate)
    if (direct !== undefined) return direct

    // 退一步：找第一个 { 到最后一个 } 之间的片段
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end > start) {
      const sliced = tryParse(candidate.slice(start, end + 1))
      if (sliced !== undefined) return sliced
    }
  }
  return undefined
}

function tryParse(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** 检查 key 是否可用，用于启动自检和设置页 */
export async function verifyKey(cfg) {
  try {
    await complete(cfg, [{ role: 'user', content: '回复"ok"两个字符即可' }], { maxTokens: 8, temperature: 0, retries: 0 })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err.message }
  }
}
