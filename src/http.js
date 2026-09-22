/**
 * HTTP 服务。手写路由，零依赖。
 *
 * 两条通道：
 * - REST：拉快照、发消息、改人设/记忆/配置
 * - SSE：服务端有新消息（尤其是它主动开口）立刻推给手机页面，不用轮询
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { authorize, extractToken } from './auth.js'
import { BACKUP_ROOT, listBackups, runBackup } from './backup.js'
import { findImage, imageStats, MAX_IMAGE_BYTES, parseDataUrl } from './images.js'
import {
  clearAvatar,
  describeAvatar,
  readAvatar,
  setImageAvatar,
  setTextAvatar,
} from './avatar.js'
import { PATHS, checkReadiness, loadConfig, reloadConfig, saveConfig } from './config.js'
import { testPush, push } from './bark.js'
import {
  activity,
  characterName,
  extractMemory,
  isUserWatchingScreen,
  noteAppActive,
  noteUserAction,
  proactiveGate,
  readMemory,
  readPersona,
  readProactiveEvents,
  readSummary,
  respond,
  rollSummary,
  runProactiveCheck,
  scheduleNextProactive,
  stickerStats,
  writeMemory,
  writePersona,
} from './engine.js'
import { verifyKey } from './llm.js'
import { renderTranscript } from './prompts.js'
import {
  evolveSelf,
  listSnapshots,
  readSelf,
  readSelfChanges,
  replaceSelf,
  restoreSelf,
} from './self.js'
import {
  STICKER_EXT_MIME,
  getSticker,
  readLib,
  stickerFile,
  syncStickers,
  writeLib,
} from './stickers.js'
import { store, toWireMessage } from './storage.js'
import { stateForUI, waitingLabel } from './status.js'
import {
  catchUpDaySummaries,
  daysStats,
  daysTimeline,
  summarizedDates,
} from './life-days.js'
import { readJournal } from './life.js'
import { appendJsonl, contentHash, ensureDir, localDateKey, log, now, truncate } from './util.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

/* ------------------------------------------------------------ SSE 广播 */

const sseClients = new Set()

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function broadcast(event, data) {
  for (const res of sseClients) {
    try {
      sseSend(res, event, data)
    } catch {
      sseClients.delete(res)
    }
  }
}

/** 有流水但已过完、还没摘要的天数 */
function countPendingDays() {
  try {
    const today = localDateKey()
    const done = summarizedDates()
    const withFlow = new Set(readJournal().map((e) => localDateKey(e.at)))
    return [...withFlow].filter((d) => d < today && !done.has(d)).length
  } catch {
    return 0
  }
}

/** store 有变化就通知所有在线页面 */
export function startStoreBroadcast() {
  store.subscribe(() => {
    /*
     * 消息和她的状态一起推。
     *
     * 状态必须跟着消息走——不然会出现"她已经在打字了，顶部还写着在煮面"。
     * store.notify() 在 append / markUser / saveState 时都会触发，
     * 而"她在不在打字"正是靠 state.generating 标记的，所以这里能同步上。
     */
    broadcast('messages', { ...store.snapshot(), state: stateForUI(loadConfig()) })
  })
}

/* ---------------------------------------------------------------- 工具 */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/* ------------------------------------------------------------ 静态文件 */

/**
 * 静态资源的版本号。
 *
 * 用 app.js / style.css 的修改时间当版本，拼进 HTML 里的引用：
 *   <script src="/app.js?v=1789873940550">
 *
 * 为什么必须这么干：手机上"添加到主屏幕"之后，iOS Safari 会缓存 JS，
 * 光靠 cache-control: no-cache 不保险。实测就踩过——
 * 新功能（发图片）在服务端明明已经就绪、接口也验证通过，
 * 但手机上点回形针毫无反应，因为跑的还是旧的 app.js。
 *
 * 代码一改，v 就变，浏览器必须重新下载。
 */
function assetVersion() {
  let newest = 0
  for (const name of ['app.js', 'style.css']) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(PATHS.public, name)).mtimeMs)
    } catch {
      /* 文件不在了就算了 */
    }
  }
  return String(Math.round(newest))
}

/** 给 HTML 里的静态资源引用加上版本号 */
function injectAssetVersions(html) {
  const v = assetVersion()
  return html
    .replace(/(src|href)="\/(app\.js|style\.css)(\?[^"]*)?"/g, (_m, attr, file) => `${attr}="/${file}?v=${v}"`)
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.resolve(PATHS.public, rel)

  // 防目录穿越：解析后的路径必须仍在 public 目录内
  if (!target.startsWith(PATHS.public + path.sep) && target !== path.join(PATHS.public, 'index.html')) {
    return sendError(res, 403, '不允许的路径')
  }

  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return sendError(res, 404, '页面不存在')
  }
  if (!stat.isFile()) return sendError(res, 404, '页面不存在')

  const ext = path.extname(target).toLowerCase()
  const isHtml = ext === '.html'

  // 带版本号（?v=...）的资源可以长缓存：改了文件，v 就变，URL 也就变了
  const versioned = /[?&]v=\d+/.test(req.url ?? '')

  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    ...(isHtml ? {} : { 'content-length': stat.size }),
    'cache-control': isHtml || !versioned
      ? 'no-cache'
      : 'private, max-age=31536000, immutable',
  })

  if (isHtml) {
    // HTML 要注入版本号，不能再走流式管道
    try {
      res.end(injectAssetVersions(fs.readFileSync(target, 'utf8')))
    } catch (err) {
      log.warn(`读取 ${rel} 失败：${err.message}`)
      res.end()
    }
    return undefined
  }

  fs.createReadStream(target).pipe(res)
  return undefined
}

/* ---------------------------------------------------------------- 路由 */

function publicConfig(cfg) {
  return {
    proactive: cfg.proactive,
    bark: { group: cfg.bark.group, configured: Boolean(cfg.bark.key), server: cfg.bark.server },
    model: { chatModel: cfg.model.chatModel, configured: Boolean(cfg.model.apiKey) },
    context: cfg.context,
    memory: cfg.memory,
  }
}

async function handleApi(req, res, url, cfg) {
  const route = `${req.method} ${url.pathname}`

  /* ---- 健康检查：不鉴权，方便反代/云平台探活 ---- */
  if (route === 'GET /api/health') {
    return sendJson(res, 200, { ok: true, at: now(), messages: store.seq })
  }

  /* ---- 除此之外全部需要口令 ---- */
  if (!authorize(req, url, cfg)) {
    return sendError(res, 401, '口令不对，或者还没带口令')
  }

  switch (route) {
    /* ---------------- 初始化：一次拿齐所有状态 ---------------- */
    case 'GET /api/app': {
      // 注意：这里**不**调 noteAppActive()。
      // 拉取状态不等于"人在看屏幕"——脚本、SSE 重连、后台刷新都会打这个接口，
      // 把它当成"在看"会误压掉本该发出的推送。
      // "在看"只由前端主动发的心跳（POST /api/ping）来标记。
      return sendJson(res, 200, {
        snapshot: store.snapshot(),
        /*
         * 她此刻的状态。顶部那行字靠它。
         *
         * 放在这里而不是塞进 snapshot 里，是因为 snapshot 是**消息**快照
         * （storage 的事），而这是"她这个人现在怎么样"（status 的事）。
         */
        state: stateForUI(cfg),
        config: publicConfig(cfg),
        persona: readPersona(),
        // 界面顶部的名字：从人设里解析，人设改了这里就跟着改
        characterName: characterName(),
        avatar: readAvatar(),
        memory: readMemory(),
        // 她怎么看待自己（会变的那一层）。流水和快照列表在 /api/self 里单独拉。
        self: readSelf(),
        selfEnabled: cfg.self?.enabled !== false,
        summary: readSummary(),
        readiness: checkReadiness(cfg),
        serverTime: now(),
      })
    }

    /* ---------------- SSE 长连接 ---------------- */
    case 'GET /api/events': {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      sseSend(res, 'messages', store.snapshot())

      // 注意：这里**绝对不能**调 noteAppActive()。
      // 这个心跳是服务端自己的定时器，只要连接没断就会一直跑；
      // 如果用它来标记"用户在看在"，那推送就永远被自己压掉——
      // 人不在手机跟前时，恰恰是最需要推送的时候。
      // "在不在看"只由页面发起的真实请求（打开、切回前台、发消息）来标记。
      const beat = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(beat)
        }
      }, 20_000)
      beat.unref?.()

      const cleanup = () => {
        clearInterval(beat)
        sseClients.delete(res)
      }
      req.on('close', cleanup)
      req.on('error', cleanup)
      return undefined
    }

    /* ---------------- 心跳：标记用户在看在用 ---------------- */
    case 'POST /api/ping': {
      const body = await readBody(req)
      // only the page's own heartbeat counts as presence;
      // userAction additionally records a real interaction
      if (body.userAction) noteUserAction()
      else noteAppActive()
      return sendJson(res, 200, { ok: true, unread: store.unreadCount() })
    }

    /* ---------------- 标记已读 ---------------- */
    case 'POST /api/read': {
      const body = await readBody(req)
      store.markRead(Number(body.seq) || store.seq)
      return sendJson(res, 200, { ok: true, lastReadSeq: store.state.lastReadSeq })
    }

    /* ---------------- 发消息（流式） ---------------- */
    case 'POST /api/chat': {
      const body = await readBody(req, 40_000_000)
      const text = String(body.text ?? '')
      const images = Array.isArray(body.images) ? body.images.slice(0, 4) : []
      if (!text.trim() && images.length === 0) return sendError(res, 400, '消息不能为空')

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      const controller = new AbortController()
      req.on('close', () => controller.abort())

      try {
        const { message } = await respond(text, {
          signal: controller.signal,
          images,
          onChunk: (delta, full) => {
            res.write(`event: delta\ndata: ${JSON.stringify({ delta, full })}\n\n`)
          },
          /*
           * 她要在忙里等一会儿时，先把"为什么等"告诉页面。
           *
           * 不说的话，用户看到的就是三点动画转四十秒——那和卡住没区别，
           * 而这里明明有一句实话可以说。这一条正好是"把'她没回我'
           * 从悬念变成信息"的同一个思路，只不过发生在消息区而不是顶栏。
           */
          onDelay: (ms, busy) => {
            res.write(
              `event: waiting\ndata: ${JSON.stringify({
                seconds: Math.round(ms / 1000),
                label: waitingLabel(busy),
              })}\n\n`,
            )
          },
        })
        res.write(`event: done\ndata: ${JSON.stringify({ message: toWireMessage(message), snapshot: store.snapshot() })}\n\n`)
      } catch (err) {
        log.error(`对话失败：${err.message}`)
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`)
      } finally {
        res.end()
      }
      return undefined
    }

    /* ---------------- 发消息（非流式，给插件/脚本用） ---------------- */
    case 'POST /api/send': {
      const body = await readBody(req, 40_000_000)
      const text = String(body.text ?? '')
      const images = Array.isArray(body.images) ? body.images.slice(0, 4) : []
      if (!text.trim() && images.length === 0) return sendError(res, 400, '消息不能为空')
      const { message } = await respond(text, { images })
      return sendJson(res, 200, {
        ok: true,
        reply: message.text,
        message: toWireMessage(message),
        snapshot: store.snapshot(),
      })
    }

    /* ---------------- 取图片 ---------------- */
    case 'GET /api/image': {
      const id = url.searchParams.get('id') ?? ''
      const file = findImage(id)
      if (!file) return sendError(res, 404, '图片不存在')
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        return sendError(res, 404, '图片读不到')
      }
      const ext = path.extname(file).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      res.writeHead(200, {
        'content-type': mime,
        'content-length': stat.size,
        // 图片内容不会变（id 唯一），可以长缓存
        'cache-control': 'private, max-age=31536000, immutable',
      })
      fs.createReadStream(file).pipe(res)
      return undefined
    }

    /* ---------------- 客户端诊断上报 ---------------- */
    /*
     * 手机上出问题我看不到控制台，只能靠猜。
     * 前端把关键步骤（选图、压缩、渲染预览、发送）报到这里，
     * 我读服务端日志就知道卡在哪一步。
     *
     * 记到独立文件，不污染主日志，也方便一次看完整个流程。
     */
    case 'POST /api/client-error': {
      const body = await readBody(req, 200_000).catch(() => ({}))
      const where = String(body.where ?? '(未说明)')
      const message = String(body.message ?? '(无消息)')
      log.info(`[客户端] ${where}：${message}`)
      appendJsonl(`${PATHS.data}/client.log`, {
        at: now(),
        where,
        message,
        ...(body.extra ? { extra: body.extra } : {}),
        ...(body.ua ? { ua: body.ua } : {}),
      })
      return sendJson(res, 200, { ok: true })
    }

    /* ---------------- 图片占用统计 ---------------- */
    case 'GET /api/images/stats':
      return sendJson(res, 200, imageStats())

    /* ---------------- 主动开口：手动触发 ---------------- */
    case 'POST /api/proactive/run': {
      const body = await readBody(req)
      const result = await runProactiveCheck({ force: Boolean(body.force), dryRun: Boolean(body.dryRun) })
      return sendJson(res, 200, result)
    }

    /** 查看当前是否允许主动开口（不实际发送） */
    case 'GET /api/proactive/status': {
      const gate = proactiveGate(cfg)
      return sendJson(res, 200, {
        ...gate,
        nextAt: store.state.nextProactiveAt,
        todayCount: store.proactiveCountToday(),
        unansweredStreak: store.state.unansweredStreak,
        lastHoldReason: store.state.lastHoldReason,
        // 排查"为什么不推手机"用：是否认为对方正在看屏幕
        watching: isUserWatchingScreen(),
        lastSeenAgoMs: activity.lastSeenAt ? now() - activity.lastSeenAt : null,
      })
    }

    /**
     * 主动决策的历史流水。
     * 手机设置页用它显示"最近它想找你几次、为什么没发"。
     */
    case 'GET /api/proactive/history': {
      const limit = Number(url.searchParams.get('limit')) || 25
      return sendJson(res, 200, {
        events: readProactiveEvents(limit),
        todayCount: store.proactiveCountToday(),
      })
    }

    /**
     * 把下一次主动窗口拉到现在，让它马上去判断一次。
     * 用途：不想干等排期，想立刻看它会不会开口。
     */
    case 'POST /api/proactive/reset-window': {
      store.scheduleNextProactive(0)
      // 顺便清掉"连续未回"计数：手动催它的时候不该被这个拦住
      const body = await readBody(req).catch(() => ({}))
      if (body.clearStreak !== false) {
        store.state.unansweredStreak = 0
        store.saveState()
      }
      return sendJson(res, 200, { ok: true, nextAt: store.state.nextProactiveAt })
    }

    /* ---------------- 备份 ---------------- */
    case 'GET /api/backup': {
      return sendJson(res, 200, { root: BACKUP_ROOT, backups: listBackups() })
    }

    case 'POST /api/backup': {
      const result = runBackup({ force: true })
      return sendJson(res, 200, result)
    }

    /* ---------------- 头像 ---------------- */
    case 'GET /api/avatar':
      return sendJson(res, 200, { avatar: readAvatar() })

    case 'PUT /api/avatar': {
      const body = await readBody(req, 2_000_000)
      try {
        let avatar
        if (body.kind === 'image') {
          const result = setImageAvatar(String(body.dataUrl ?? ''))
          avatar = result.avatar
          log.info(`头像已更新：${describeAvatar(avatar)}`)
        } else if (body.kind === 'text') {
          avatar = setTextAvatar(body.value)
          log.info(`头像已更新：${describeAvatar(avatar)}`)
        } else if (body.kind === 'none') {
          avatar = clearAvatar()
          log.info('头像已恢复默认')
        } else {
          return sendError(res, 400, 'kind 只能是 image / text / none')
        }
        return sendJson(res, 200, { ok: true, avatar })
      } catch (err) {
        return sendError(res, 400, err.message)
      }
    }

    /* ---------------- 人设 ---------------- */
    case 'GET /api/persona':
      return sendJson(res, 200, { persona: readPersona() })

    case 'PUT /api/persona': {
      const body = await readBody(req)
      writePersona(String(body.persona ?? ''))
      return sendJson(res, 200, { ok: true, persona: readPersona() })
    }

    /* ---------------- 表情包 ---------------- */
    /*
     * 入口设计成"丢图进去就行"：用户可以把图直接拷到 data/stickers/，
     * 也可以从这个面板上传。两条路最后都汇到 syncStickers()。
     *
     * 描述由模型看图自动生成——**这是刻意的**：如果每加一张都要
     * 手写一句"这是什么表情"，没人会加满三十张，这功能就废了。
     */
    case 'GET /api/stickers': {
      const lib = readLib()
      const stats = stickerStats()
      return sendJson(res, 200, {
        enabled: cfg.sticker?.enabled !== false,
        items: lib.items.map((it) => ({
          id: it.id,
          mime: it.mime,
          bytes: it.bytes,
          desc: it.desc ?? '',
          enabled: it.enabled !== false,
          uses: it.uses ?? 0,
          addedAt: it.addedAt ?? 0,
        })),
        todayUsed: stats.today,
        maxPerDay: cfg.sticker?.maxPerDay ?? 8,
        minMessagesBetween: cfg.sticker?.minMessagesBetween ?? 6,
      })
    }

    /** 扫描文件夹：新图入库 + 自动生成描述 */
    case 'POST /api/stickers/sync': {
      const result = await syncStickers(cfg)
      return sendJson(res, 200, { ok: true, ...result })
    }

    /** 上传一张（前端已把图压成 data URL） */
    case 'POST /api/stickers': {
      const body = await readBody(req, 4_000_000)
      const dataUrl = String(body.dataUrl ?? '')
      if (!dataUrl.startsWith('data:image/')) {
        return sendError(res, 400, '需要一张图片')
      }

      let parsed
      try {
        parsed = parseDataUrl(dataUrl)
      } catch (err) {
        return sendError(res, 400, err.message)
      }

      const ext = Object.entries(STICKER_EXT_MIME).find(([, m]) => m === parsed.mime)?.[0]
      if (!ext) return sendError(res, 400, `不支持的格式：${parsed.mime}`)

      ensureDir(PATHS.stickers)
      const buf = Buffer.from(parsed.base64, 'base64')
      /*
       * 文件名用内容哈希 → 同一张图重复上传只会得到同一个文件，
       * 自动去重。也不用担心文件名冲突或者奇怪的中文名。
       */
      const id = contentHash(buf)
      fs.writeFileSync(path.join(PATHS.stickers, `sticker-${id}${ext}`), buf)

      const result = await syncStickers(cfg)
      const item = getSticker(id)
      return sendJson(res, 200, { ok: true, id, desc: item?.desc ?? '', ...result })
    }

    /** 改描述 / 启用停用 */
    case 'PUT /api/stickers': {
      const body = await readBody(req)
      const id = String(body.id ?? '')
      if (!/^[a-f0-9]{6,32}$/.test(id)) return sendError(res, 400, 'id 不合法')

      const lib = readLib()
      const item = lib.items.find((it) => it.id === id)
      if (!item) return sendError(res, 404, '没有这张表情包')

      if (typeof body.desc === 'string') item.desc = body.desc.trim().slice(0, 40)
      if (typeof body.enabled === 'boolean') item.enabled = body.enabled

      writeStickerLib(lib)
      return sendJson(res, 200, { ok: true, item })
    }

    /** 删掉一张（同时删文件） */
    case 'DELETE /api/stickers': {
      const id = url.searchParams.get('id') ?? ''
      const item = getSticker(id)
      if (!item) return sendError(res, 404, '没有这张表情包')

      const file = stickerFile(item)
      if (file) {
        try {
          fs.rmSync(file, { force: true })
        } catch (err) {
          log.warn(`删表情包文件失败：${err.message}`)
        }
      }
      const lib = readLib()
      lib.items = lib.items.filter((it) => it.id !== id)
      writeStickerLib(lib)
      return sendJson(res, 200, { ok: true })
    }

    /* ---------------- 她的日子（时间线） ---------------- */
    /*
     * 她的过去。
     *
     * 流水（life.jsonl）本身是完整的，但只有最近 8 条会被喂回去、
     * 也没有界面能看——所以她"只有现在、没有过去"。
     * 按天压成一天一句之后，既能被她引用，也能在这里回看。
     */
    case 'GET /api/life/days': {
      const limit = Math.min(400, Number(url.searchParams.get('limit')) || 60)
      return sendJson(res, 200, {
        days: daysTimeline({ limit }),
        stats: daysStats(),
        // 有流水但已过完、还没摘要的天数——界面上提示"还在补"
        pending: countPendingDays(),
      })
    }

    /** 手动补一次（界面上的"补上"按钮） */
    case 'POST /api/life/days/catchup': {
      const result = await catchUpDaySummaries(cfg, { max: 10 })
      return sendJson(res, 200, { ok: true, ...result })
    }

    /* ---------------- 她的自我（会变的那一层） ---------------- */
    /*
     * 这几个接口的存在本身就是这个功能的一部分。
     *
     * "会自己改自己"最大的风险不是改坏，而是**改了你不知道**。
     * 所以除了读和写，还要能看变更流水、能看历史快照、能回退。
     * 没有这些，她跑偏了你只会觉得"她怎么变了"，查不出是哪一步变的。
     */
    case 'GET /api/self':
      return sendJson(res, 200, {
        self: readSelf(),
        enabled: cfg.self?.enabled !== false,
        snapshots: listSnapshots().slice(0, 30).map((s) => s.name),
      })

    case 'PUT /api/self': {
      const body = await readBody(req)
      const result = replaceSelf(String(body.self ?? ''))
      return sendJson(res, 200, { ok: true, ...result, self: readSelf() })
    }

    /** 她改过自己什么（新的在前） */
    case 'GET /api/self/changes': {
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50)
      return sendJson(res, 200, { changes: readSelfChanges(limit) })
    }

    /** 回退。不传 name 就退到上一个快照。 */
    case 'POST /api/self/restore': {
      const body = await readBody(req)
      const result = restoreSelf(body.name ? String(body.name) : undefined)
      return sendJson(res, 200, { ok: true, ...result, self: readSelf() })
    }

    /** 立刻让她更新一次（调试/手动用） */
    case 'POST /api/self/evolve': {
      if (cfg.self?.enabled === false) {
        return sendJson(res, 200, { updated: false, reason: '成长功能已关闭' })
      }
      const body = await readBody(req).catch(() => ({}))
      const transcript =
        typeof body.transcript === 'string' && body.transcript.trim()
          ? body.transcript
          : renderTranscript(store.recent(40), { maxChars: 9000 })
      const result = await evolveSelf(cfg, { transcript })
      return sendJson(res, 200, { ...result, self: readSelf() })
    }

    /* ---------------- 记忆 ---------------- */
    case 'GET /api/memory':
      return sendJson(res, 200, { memory: readMemory(), summary: readSummary() })

    case 'PUT /api/memory': {
      const body = await readBody(req)
      if (typeof body.memory === 'string') writeMemory(body.memory)
      return sendJson(res, 200, { ok: true, memory: readMemory() })
    }

    /** 手动跑一次记忆抽取 */
    case 'POST /api/memory/extract': {
      const result = await extractMemory(cfg)
      return sendJson(res, 200, result)
    }

    /** 手动压缩一次摘要 */
    case 'POST /api/summary/roll': {
      const result = await rollSummary(cfg)
      return sendJson(res, 200, result)
    }

    /* ---------------- 配置 ---------------- */
    case 'PUT /api/config': {
      const body = await readBody(req)
      const allowed = ['proactive', 'bark', 'model', 'context', 'memory']
      const patch = {}
      for (const key of allowed) {
        if (body[key] !== undefined) patch[key] = body[key]
      }
      const next = saveConfig(patch)
      // 改了间隔就重排下一次窗口
      if (patch.proactive) scheduleNextProactive(next)
      return sendJson(res, 200, { ok: true, config: publicConfig(next) })
    }

    case 'POST /api/config/reload': {
      const next = reloadConfig()
      return sendJson(res, 200, { ok: true, config: publicConfig(next) })
    }

    /* ---------------- 连通性测试 ---------------- */
    /*
     * 发一条固定的测试文案，只用来确认通道通不通。
     * 它推的是写死的文字，绝不是聊天记录里的内容。
     *
     * 这里曾经有一个 POST /api/bark/last：把"最后一条消息"推到手机。
     * 那是我为了调试加的，但它是**纯粹的坏事**——
     * 它会把用户自己说的话推回给用户，而且谁都能调。
     * 实测用户手机上收到了自己发的"看我的猫"，还是十几遍。
     * 已经删掉。要测推送就只推固定文案。
     */
    case 'POST /api/test/bark': {
      const result = await testPush(cfg)
      return sendJson(res, result.ok ? 200 : 502, result)
    }

    case 'POST /api/test/model': {
      const result = await verifyKey(cfg)
      return sendJson(res, result.ok ? 200 : 502, result)
    }

    default:
      return sendError(res, 404, `没有这个接口：${route}`)
  }
}

/* ------------------------------------------------------------ 启动入口 */

export function createServer() {
  const cfg = loadConfig()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // 本机以外的来源要不要放开由你决定；这里允许局域网直连
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    const handle = async () => {
      if (url.pathname.startsWith('/api/')) {
        return handleApi(req, res, url, loadConfig())
      }
      return serveStatic(req, res, url.pathname)
    }

    handle().catch((err) => {
      log.error(`请求处理失败 ${url.pathname}：${err.stack ?? err.message}`)
      if (!res.headersSent) sendError(res, 500, err.message)
      else res.end()
    })
  })

  return { server, cfg }
}

/**
 * 打印启动横幅。
 * 局域网地址很重要 —— 你手机就是通过它访问这个服务的。
 */
export function printBanner(cfg, port) {
  const readiness = checkReadiness(cfg)
  const lines = []
  lines.push('')
  lines.push('  ┌──────────────────────────────────────────────┐')
  lines.push('  │            朋友 · 已启动                      │')
  lines.push('  └──────────────────────────────────────────────┘')
  lines.push('')
  lines.push(`  本机访问：   http://127.0.0.1:${port}/?token=${cfg.accessToken}`)
  for (const addr of lanAddresses()) {
    lines.push(`  手机访问：   http://${addr}:${port}/?token=${cfg.accessToken}`)
  }
  lines.push('')
  lines.push(`  访问口令：   ${cfg.accessToken}`)
  lines.push(`  角色名字：   ${characterName()}`)
  lines.push(`  聊天模型：   ${cfg.model.chatModel}`)
  lines.push(`  主动消息：   ${cfg.proactive.enabled ? '已开启' : '已关闭'}`)
  lines.push(`  静默时段：   ${cfg.proactive.quietStart}:00 - ${cfg.proactive.quietEnd}:00`)
  lines.push(`  下次窗口：   ${store.state.nextProactiveAt ? new Date(store.state.nextProactiveAt).toLocaleString() : '未排期'}`)
  if (readiness.length) {
    lines.push('')
    lines.push('  还差这些才能完整工作：')
    for (const problem of readiness) lines.push(`    · ${problem}`)
  } else {
    lines.push('')
    lines.push('  ✓ 模型和推送都配好了')
  }
  lines.push('')
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** 找出本机所有局域网 IPv4 地址 */
function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address)
    }
  }
  return out
}
