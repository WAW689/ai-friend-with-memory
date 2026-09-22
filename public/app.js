/* ==========================================================================
   朋友 · 前端逻辑。纯手写，无框架。
   ========================================================================== */
'use strict'

/* --------------------------------------------------------------- 全局状态 */

const S = {
  token: '',
  messages: [],
  config: null,
  persona: '',
  characterName: '朋友',
  avatar: { kind: 'none', value: '' },
  memory: '',
  summary: { text: '', upToSeq: 0 },
  // 她会变的那一层自我
  self: '',
  selfChanges: [],
  selfSnapshots: [],
  selfEnabled: true,
  // 她此刻的状态（服务端算好给的）+ SSE 是否断开
  state: null,
  esDown: false,
  // 表情包
  stickers: [],
  stickerEnabled: true,
  stickerTodayUsed: 0,
  stickerMaxPerDay: 8,
  stickerMinGap: 6,
  // 她的日子（时间线）
  lifeDays: [],
  lifeDaysStats: {},
  lifeDaysPending: 0,
  readiness: [],
  lastSeq: 0,
  streaming: false,
  activeTab: 'proactive',
  es: null,
}

const $ = (id) => document.getElementById(id)

/**
 * 滚动跟随状态。
 * - follow：用户是否贴着底部（true 时新消息自动滚到底）
 * - until：在这个时间戳之前，忽略 scroll 事件（因为是我们自己触发的滚动）
 */
const Scrolling = { follow: true, until: 0, frame: 0, pendingSmooth: false }

/**
 * 流式文字的显示状态。
 *
 * 核心是**跟着实测流速走**，而不是固定速度、也不是固定预算。
 *
 * 为什么不能用固定速度：模型常在几百毫秒内把一整句吐完
 * （实测 64 字约 370ms）。若固定 45 字/秒，显示完要 1.4 秒——
 * 收到 done 时还剩一大半没显示，只能一次性贴出来，看起来就是"突然跳出"。
 *
 * 所以每帧都用最近的实测流速重算：我还能显示多久？
 * 快结束时就加速追上，绝不拖到 flush 才一次跳出。
 */
const Typing = {
  target: '',
  shown: 0,
  /** 最近实测：每多显示 1 个字，流大约还要跑多少毫秒 */
  msPerChar: 6,
  /** 已经观察到多少个字符，用来判断流速估计是否可信 */
  observedChars: 0,
  lastFrame: 0,
  frame: 0,
  node: null,
  onFirstGlyph: null,
}

/** 落后到这个毫秒数以内就直接追平，不再逐字显示。
    这个阈值不是固定的：动画刚开始、内容还是"新的一大段"时立刻追平，
    越往后越允许逐字显示——既不会攒一大批一次跳出，也不会全程一闪而过。 */
const TYPING_CATCH_UP_MIN_MS = 60
const TYPING_CATCH_UP_MAX_MS = 150
/** 第一帧至少显示这么多字，避免气泡"空了半拍" */
const TYPING_MIN_LEAD = 2
/** 流速估计的初始值（毫秒/字），偏快一点，宁快勿慢 */
const TYPING_DEFAULT_MS_PER_CHAR = 4

/** 收到一次增量：更新目标文本，并用实测节奏修正流速估计 */
function typewriterFeed(full, elapsedMs) {
  const previousLen = Typing.target.length
  Typing.target = full

  const grew = full.length - previousLen
  // 每包字符太少时这个比值噪声很大（除以 1 会得到很离谱的数），
  // 所以攒够一定样本量再采信。
  if (elapsedMs > 0 && grew > 0) {
    Typing.observedChars += grew
    if (Typing.observedChars >= 12) {
      const sample = elapsedMs / grew
      // 指数平滑，避免单次抖动把节奏带偏
      Typing.msPerChar = Typing.msPerChar * 0.7 + sample * 0.3
    }
  }

  if (!Typing.frame) Typing.frame = requestAnimationFrame(typewriterTick)
}

/** 立刻显示全部剩余文字（收到 done 或出错时用） */
function typewriterFlush() {
  if (Typing.frame) {
    cancelAnimationFrame(Typing.frame)
    Typing.frame = 0
  }
  if (Typing.node && Typing.shown < Typing.target.length) {
    Typing.shown = Typing.target.length
    Typing.node.textContent = Typing.target
    if (Scrolling.follow) scrollToBottom(false)
  }
}

function typewriterReset(node, onFirstGlyph) {
  if (Typing.frame) cancelAnimationFrame(Typing.frame)
  Typing.target = ''
  Typing.shown = 0
  Typing.msPerChar = TYPING_DEFAULT_MS_PER_CHAR
  Typing.observedChars = 0
  Typing.lastFrame = 0
  Typing.frame = 0
  Typing.node = node
  Typing.onFirstGlyph = onFirstGlyph ?? null
}

/**
 * 每帧只做一次 DOM 写入。
 *
 * 之前是每收到一个网络增量就写一次 textContent 并滚一次屏，
 * 一条消息下来上百次强制重排 —— 这是"发送时卡顿"的主因之一。
 */
function typewriterTick(now) {
  Typing.frame = 0

  if (Typing.lastFrame === 0) Typing.lastFrame = now
  const elapsed = Math.max(0, now - Typing.lastFrame)
  Typing.lastFrame = now

  const targetLen = Typing.target.length
  if (Typing.shown < targetLen) {
    const remainingChars = targetLen - Typing.shown
    // 按实测流速，这些还没显示的字大约还要等多久
    const remainMs = Typing.msPerChar * remainingChars

    // 自适应追平阈值：开头紧（尽快把新段落显示出来），后面松（保留逐字观感）
    const progress = targetLen === 0 ? 1 : Typing.shown / targetLen
    const catchUpMs = TYPING_CATCH_UP_MIN_MS + (TYPING_CATCH_UP_MAX_MS - TYPING_CATCH_UP_MIN_MS) * progress

    let step
    if (remainMs <= catchUpMs) {
      // 快结束了（或刚收到一大段）：直接全部显示，绝不拖到 flush 那一刻才跳出
      step = remainingChars
    } else {
      // 按剩余时间均匀分配；用 max(elapsed, 32) 是因为两帧间隔抖动时
      // 单帧步长会算成 0，看起来就像卡住了
      step = Math.ceil((remainingChars * Math.max(elapsed, 32)) / remainMs)
      step = Math.max(1, Math.min(step, remainingChars))
      // 第一帧多给一点，让开头不至于慢半拍
      if (Typing.shown === 0) step = Math.max(step, Math.min(TYPING_MIN_LEAD, remainingChars))
    }

    Typing.shown = Math.min(targetLen, Typing.shown + step)
    if (Typing.node) {
      Typing.node.textContent = Typing.target.slice(0, Typing.shown)
    }
    if (Typing.shown > 0 && Typing.onFirstGlyph) {
      Typing.onFirstGlyph()
      Typing.onFirstGlyph = null
    }
    if (Scrolling.follow) scrollToBottom(false)
  }

  if (Typing.shown < Typing.target.length) {
    Typing.frame = requestAnimationFrame(typewriterTick)
  }
}

/**
 * 她在忙、要等一会儿时，把三点动画换成一句实话。
 *
 * 三点动画表示"正在输入"，可她这时候还没开始动笔——等四十秒的话，
 * 那三点就是在骗人。换成"在洗碗，等一下"之后，等待从**悬念**变成**信息**，
 * 这也是整个项目一直在做的事（顶栏那行字是同一个思路）。
 *
 * 第一个字吐出来时逐字动画会 replaceChildren()，这块自动消失，
 * 所以这里不用管"什么时候撤掉"。
 */
function showWaitingHint(bubble, payload) {
  if (!bubble) return
  const line = document.createElement('span')
  line.className = 'typing-hint'
  // 措辞由服务端给（和顶栏那行同源），这里不放自己的版本
  line.textContent = String(payload?.label ?? '').trim() || '手上有点事，等一下'
  bubble.replaceChildren(line)
}

/* ------------------------------------------------------------- 发图片 */
/** 待发送的图片（data URL）。发送或移除后清空。 */
const Pending = { images: [] }

/** 单张图上传前的上限。服务端允许 8 MB，这里留点余量。 */
const CHAT_IMAGE_MAX_BYTES = 6 * 1024 * 1024
/** 长边压到这个尺寸。聊天看图这个分辨率绰绰有余，还能省 token。 */
const CHAT_IMAGE_MAX_EDGE = 1280

/*
 * 表情包：长边上限和字节上限。
 *
 * 必须和服务端 stickers.js 里的 MAX_BYTES（2 MB）一致——
 * 不一致会出现"前端以为压好了、后端拒收"的假失败，很难查。
 */
const STICKER_MAX_EDGE = 720
const STICKER_MAX_BYTES = 2 * 1024 * 1024

/**
 * 每次点击都新建一个文件选择框。
 *
 * 为什么不能复用页面上那个固定的 input：
 * iOS Safari 上重复使用同一个 file input，第二次之后会返回**空的 FileList**——
 * change 事件正常触发，但 files.length === 0。
 * 实测日志：'选图:进入 收到 0 个文件'。
 * 新建一个干净的 input 就绕过了这个状态问题。
 *
 * 另外不用 multiple：iOS 在多选模式下要多按一次"添加"，
 * 单选用户点一下照片就结束了，路径更短、出错机会更少。
 * 想发多张就点多次回形针——反正一次最多也就 4 张。
 */
function createFilePicker() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  // 视觉上不可见，但仍参与布局：iOS 对 display:none 的 file input 不打开选择器
  input.className = 'file-overlay'
  input.setAttribute('aria-hidden', 'true')

  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : []
    sendClientDiag('选图:change 触发', `拿到 ${files.length} 个文件`, {
      types: files.map((f) => `${f.type || '(无type)'}:${f.size}`).join(','),
    })
    if (files.length === 0) {
      // 空 FileList：iOS 上偶发。给用户一句明确提示，别让他以为程序坏了。
      toast('没有读到图片，请再试一次')
      input.remove()
      return
    }
    void handleImageFiles(files)
    input.remove()
  })

  input.addEventListener('cancel', () => {
    sendClientDiag('选图:取消', '用户取消了选择')
    input.remove()
  })

  return input
}

/**
 * 压缩一张图再发。
 *
 * 为什么必须在客户端压：手机直出的照片 3-8 MB，
 * 而且图片是按维度计费 token 的——原图直接发既慢又贵。
 * 压到 1280 长边通常只剩一两百 KB，视觉上完全够看。
 *
 * 全程在浏览器里完成，原图不会上传。
 */
async function prepareImage(file) {
  const original = await readFileAsDataUrl(file)

  const image = await loadImage(original).catch(() => {
    throw new Error('这张图读不出来，换一张试试')
  })

  // iOS 上偶发拿不到尺寸（比如 HEIC 刚转换完），这时直接退回原图，
  // 至少能发出去，而不是整个流程失败
  if (!image.width || !image.height) {
    reportClientError('prepareImage', new Error('图片尺寸为 0'), {
      w: image.width,
      h: image.height,
      type: file.type,
    })
    return original
  }

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    // 拿不到 2d 上下文就直接发原图
    reportClientError('prepareImage', new Error('拿不到 canvas 2d 上下文'))
    return original
  }

  for (const edge of [CHAT_IMAGE_MAX_EDGE, 1024, 800, 640]) {
    const ratio = Math.min(edge / image.width, edge / image.height, 1)
    const w = Math.max(1, Math.round(image.width * ratio))
    const h = Math.max(1, Math.round(image.height * ratio))
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(image, 0, 0, w, h)

    for (const quality of [0.85, 0.7, 0.55]) {
      let out
      try {
        out = canvas.toDataURL('image/jpeg', quality)
      } catch (err) {
        // iOS 在内存吃紧时 toDataURL 会抛错
        reportClientError('canvas.toDataURL', err, { w, h, quality })
        return original
      }
      // 编码失败时返回的是 "data:,"，长度极短，一眼能认出来
      if (!out || out.length < 128) {
        reportClientError('canvas.toDataURL', new Error('编码结果为空'), {
          w,
          h,
          quality,
          length: out ? out.length : 0,
        })
        return original
      }
      if (dataUrlBytes(out) <= CHAT_IMAGE_MAX_BYTES) return out
    }
  }

  // 兜底：最小尺寸最低质量
  try {
    const out = canvas.toDataURL('image/jpeg', 0.45)
    if (out && out.length >= 128) return out
  } catch (err) {
    reportClientError('canvas.toDataURL(兜底)', err)
  }
  return original
}

function renderPreviews() {
  const box = $('composer-previews')
  if (Pending.images.length === 0) {
    box.classList.add('hidden')
    box.replaceChildren()
    return
  }
  box.classList.remove('hidden')
  const frag = document.createDocumentFragment()
  Pending.images.forEach((dataUrl, index) => {
    const item = document.createElement('div')
    item.className = 'preview-item'
    /*
     * 用真正的 <img> 而不是 div 的 background-image。
     * iOS 上 background-image 放 data URL 偶发不渲染；
     * <img> 还能监听 load/error —— 万一渲染失败我们至少知道。
     */
    const img = document.createElement('img')
    img.src = dataUrl
    img.alt = `待发送图片 ${index + 1}`
    img.addEventListener('error', () => {
      sendClientDiag('预览:渲染失败', `第 ${index + 1} 张预览加载失败`, {
        length: dataUrl.length,
      })
    })
    item.appendChild(img)

    const remove = document.createElement('button')
    remove.className = 'preview-remove'
    remove.type = 'button'
    remove.textContent = '×'
    remove.title = '移除'
    remove.addEventListener('click', () => {
      Pending.images.splice(index, 1)
      renderPreviews()
    })
    item.appendChild(remove)
    frag.appendChild(item)
  })
  box.replaceChildren(frag)
}

function clearPending() {
  Pending.images = []
  renderPreviews()
}

/** 从相册选图 / 拍照 */
async function handleImageFiles(fileList) {
  // 每一步都上报，这样手机上出问题时服务端日志能直接看到走到哪一步
  const raw = Array.from(fileList ?? [])
  sendClientDiag('选图:进入', `收到 ${raw.length} 个文件`, {
    types: raw.map((f) => `${f.type || '(无type)'}:${f.size}`).join(','),
  })

  const files = raw.filter((f) => f.type.startsWith('image/'))
  if (files.length === 0) {
    if (raw.length > 0) {
      toast('选中的不是图片文件')
      sendClientDiag('选图:非图片', '选中的文件不是图片', {
        types: raw.map((f) => f.type).join(','),
      })
    }
    return
  }

  const room = 4 - Pending.images.length
  if (room <= 0) {
    toast('最多一次发 4 张')
    return
  }

  toast(`正在处理 ${Math.min(files.length, room)} 张图…`)
  for (const file of files.slice(0, room)) {
    try {
      const prepared = await prepareImage(file)
      Pending.images.push(prepared)
      sendClientDiag('选图:压缩完成', '一张处理完成', {
        bytes: dataUrlBytes(prepared),
        type: file.type,
        size: file.size,
      })
    } catch (err) {
      toast(`图片处理失败：${err.message}`)
      sendClientDiag('选图:压缩失败', err.message, {
        name: file.name,
        type: file.type,
        size: file.size,
      }, err.stack)
    }
  }

  try {
    renderPreviews()
    sendClientDiag('选图:预览已渲染', `待发 ${Pending.images.length} 张`)
  } catch (err) {
    sendClientDiag('选图:预览失败', err.message, null, err.stack)
  }
}

/* ------------------------------------------------------------- 网络封装 */

/**
 * 把客户端的错误报给服务端，记进日志。
 *
 * 为什么需要：手机上出问题我只能靠猜——看不到控制台，用户也很难描述。
 * 有了这个，"点回形针没反应"这类问题在服务端日志里就能直接看到。
 */
function reportClientError(where, error, extra) {
  sendClientDiag(where, error?.message ?? String(error), extra, error?.stack)
}

/**
 * 把客户端诊断信息报给服务端。
 *
 * 手机上出问题我只能靠猜——看不到控制台，用户也很难描述。
 * 有了这个，"选完图没反应"这类问题在服务端日志里能直接看到走到哪一步。
 *
 * @param {string} where 位置
 * @param {string} message 消息
 * @param {object} [extra] 附加信息
 * @param {string} [stack] 调用栈
 */
function sendClientDiag(where, message, extra, stack) {
  try {
    const payload = {
      where,
      message,
      ...(stack ? { stack: String(stack).slice(0, 600) } : {}),
      ...(extra ? { extra } : {}),
      ua: navigator.userAgent.slice(0, 160),
    }
    // keepalive：页面正在跳转/关闭时也能发出去
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}` },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* 上报本身失败就算了，绝不能因为上报再抛错 */
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (S.token) headers.authorization = `Bearer ${S.token}`
  if (options.body !== undefined && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json'
    options.body = JSON.stringify(options.body)
  }
  const res = await fetch(path, { ...options, headers })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok) {
    const err = new Error(data.error ?? `请求失败（${res.status}）`)
    err.status = res.status
    throw err
  }
  return data
}

/* ------------------------------------------------------------- 口令 / 引导 */

function readTokenFromUrl() {
  const url = new URL(location.href)
  const token = url.searchParams.get('token')
  if (token) {
    localStorage.setItem('friend.token', token)
    // 把 token 从地址栏抹掉，避免截图/分享时泄露
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return token
  }
  return localStorage.getItem('friend.token') ?? ''
}

async function boot() {
  S.token = readTokenFromUrl()
  if (!S.token) return showGate('')

  try {
    await loadApp()
  } catch (err) {
    if (err.status === 401) return showGate('口令不对')
    showGate(`连不上服务：${err.message}`)
  }
}

function showGate(message) {
  $('gate').classList.remove('hidden')
  $('app').classList.add('hidden')
  $('gate-error').textContent = message ?? ''
}

function hideGate() {
  $('gate').classList.add('hidden')
  $('app').classList.remove('hidden')
}

async function loadApp() {
  const data = await api('/api/app')
  S.messages = data.snapshot.messages
  S.lastSeq = data.snapshot.lastSeq
  S.config = data.config
  S.persona = data.persona
  S.characterName = data.characterName || '朋友'
  S.avatar = data.avatar || { kind: 'none', value: '' }
  S.memory = data.memory
  S.self = data.self ?? ''
  S.selfEnabled = data.selfEnabled !== false
  // 她此刻的状态。顶部那行字靠它。
  S.state = data.state ?? null
  S.summary = data.summary
  S.readiness = data.readiness
  hideGate()
  renderIdentity()
  // 首次进来直接落到底部，不给滚动动画
  Scrolling.follow = true
  renderAll({ force: true })
  connectEvents()
  startHeartbeat()
  startStateRefresh()
  updateStatus()
}

/**
 * 渲染头像。
 * 优先级：上传的图片 > 自定义文字/emoji > 名字首字
 */
function renderAvatar() {
  const node = $('avatar')
  const avatar = S.avatar

  if (avatar && avatar.kind === 'image' && avatar.value) {
    // 用 background-image 而不是 <img>：能配合已有的圆形裁切和尺寸，
    // 也不用管图片加载失败时的占位
    node.textContent = ''
    node.style.backgroundImage = `url("${avatar.value}")`
    node.style.backgroundSize = 'cover'
    node.style.backgroundPosition = 'center'
    node.classList.add('has-image')
    return
  }

  node.style.backgroundImage = ''
  node.classList.remove('has-image')

  if (avatar && avatar.kind === 'text' && avatar.value) {
    node.textContent = avatar.value
    return
  }

  // 默认：取名字首字
  const name = S.characterName || '朋友'
  node.textContent = name.slice(0, 1).toUpperCase()
}

/** 名字和头像：名字从人设来，头像单独存 */
function renderIdentity() {
  const name = S.characterName || '朋友'
  $('name').textContent = name
  document.title = name
  renderAvatar()
}

/* ------------------------------------------------------------------ 渲染 */

function renderAll(options = {}) {
  renderMessages(options)
  renderHoldBanner()
}

function renderMessages(options = {}) {
  const box = $('messages')
  // 是否跟随到底：优先看用户的翻页状态，而不是每次重新测量。
  // 首次渲染（options.force）一定滚到底。
  const shouldFollow = options.force === true || Scrolling.follow
  const previousCount = box.childElementCount
  const hadContent = previousCount > 0
  const frag = document.createDocumentFragment()
  let prevDay = ''
  let prevRole = ''
  let prevAt = 0
  // 入场动画策略：
  // - animate=false（首屏、整屏刷新）→ 全部不播，避免一进来满屏闪
  // - animate=true  （收到新消息）    → 只播 seq 大于 animateFromSeq 的那几条
  const animate = options.animate === true
  const animateFromSeq = options.animateFromSeq ?? 0

  S.messages.forEach((m) => {
    const day = dayKey(m.at)
    if (day !== prevDay) {
      const sep = document.createElement('div')
      sep.className = 'day-sep'
      sep.textContent = dayLabel(m.at)
      frag.appendChild(sep)
      prevDay = day
      prevRole = ''
    }

    const row = document.createElement('div')
    row.className = `row ${m.role === 'user' ? 'me' : 'them'}`
    // 同一方在 2 分钟内连续发言就收紧间距
    if (prevRole === m.role && m.at - prevAt < 120000) row.classList.add('tight')

    if (m.role !== 'user') {
      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.textContent = clock(m.at)
      row.appendChild(meta)
    }

    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (m.kind === 'proactive') bubble.classList.add('proactive')
    // 旧气泡不重播动画，避免整屏闪动；只有真正新到的那条才播
    if (!animate || m.seq <= animateFromSeq) bubble.classList.add('no-anim')

    const images = Array.isArray(m.images) ? m.images : []
    if (images.length) {
      bubble.classList.add('has-image')
      // 表情包要单独标记：它比普通图片小得多，而且"只有图"时不显示占位文字
      if (m.sticker) bubble.classList.add('has-sticker')
      const gallery = document.createElement('div')
      gallery.className = 'bubble-images'
      for (const id of images) {
        const img = document.createElement('img')
        // 图片单独走接口取，不塞进 SSE 快照里
        img.src = `/api/image?id=${encodeURIComponent(id)}&token=${encodeURIComponent(S.token)}`
        img.alt = m.sticker ? '表情包' : '图片'
        img.loading = 'lazy'
        // 图片加载完会撑开高度，如果用户贴着底部就跟着顶上去
        img.addEventListener('load', () => {
          if (Scrolling.follow) scrollToBottom(false)
        })
        gallery.appendChild(img)
      }
      bubble.appendChild(gallery)

      /*
       * 正文只在"真的有话"时才显示。
       *
       * 服务端对"只想发个表情包"的消息存的是 '（发表情）' 这个占位符——
       * 那是为了让消息非空（空文本在前端会渲染成空气泡），
       * 但它不是她真的说的话，露出来会很出戏。
       */
      const hasRealText = m.text && m.text !== '（发表情）'
      if (hasRealText) {
        const caption = document.createElement('div')
        caption.className = 'bubble-text'
        caption.textContent = m.text
        bubble.appendChild(caption)
      }
    } else {
      bubble.textContent = m.text
    }

    row.appendChild(bubble)
    frag.appendChild(row)

    prevRole = m.role
    prevAt = m.at
  })

  box.replaceChildren(frag)
  if (shouldFollow || !hadContent) {
    // 首屏直接落到底，不给动画（避免看到从顶部滑下来的过程）
    scrollToBottom(false)
  } else {
    // 用户在翻看历史，别打断他；给个"跳到最新"的入口
    showJump()
  }
}

function renderHoldBanner() {
  const banner = $('hold-banner')
  const p = S.config?.proactive
  if (!p) return banner.classList.add('hidden')

  const bits = []
  if (!p.enabled) bits.push('主动消息已关闭')
  else {
    bits.push(`静默 ${p.quietStart}:00-${p.quietEnd}:00`)
    bits.push(`间隔 ${p.minGapMinutes}-${p.maxGapMinutes} 分钟`)
  }
  banner.textContent = bits.join(' · ')
  banner.classList.remove('hidden')
}

/**
 * 把消息区滚到底。
 *
 * 为什么要连滚三次：
 * iOS 上刚插入 DOM 的内容，scrollHeight 要等一帧才准确；
 * 键盘弹起时视觉视口还会再变一次。只滚一次经常差最后一段，
 * 表现就是"新消息要手动下滑才能看到"。
 */
function scrollToBottom(smooth = false) {
  const box = $('messages')
  // 同一帧内的多次调用合并成一次。流式回复时每个增量都会调到这里，
  // 不合并的话会出现"一帧滚好几次"，加上浏览器的滚动平滑处理，看起来就是抖。
  Scrolling.pendingSmooth = Scrolling.pendingSmooth || smooth
  Scrolling.until = Date.now() + 700
  if (Scrolling.frame) return
  Scrolling.frame = requestAnimationFrame(() => {
    Scrolling.frame = 0
    const behavior = Scrolling.pendingSmooth ? 'smooth' : 'auto'
    Scrolling.pendingSmooth = false
    box.scrollTo({ top: box.scrollHeight, behavior })
    // 内容高度（换行、流式追加）可能在这一帧之后才定下来，再补一次
    requestAnimationFrame(() => {
      const vv = window.visualViewport
      const visible = vv ? vv.height : box.clientHeight
      if (box.scrollHeight - box.scrollTop - visible > 2) {
        box.scrollTo({ top: box.scrollHeight, behavior: 'auto' })
      }
      Scrolling.until = Date.now() + 300
    })
  })
}

/**
 * 用户当前是不是贴着底部看。
 *
 * iOS 键盘弹起时 clientHeight 是"布局视口"高度，比实际可见区域大，
 * 直接用 clientHeight 会把"其实就在底部"误判成"离底部很远"，
 * 于是新消息来了不自动滚——这就是之前那个 BUG。
 * 所以这里改用 visualViewport 的实际高度。
 */
function isNearBottom(box) {
  const vv = window.visualViewport
  const visible = vv ? vv.height : box.clientHeight
  const distance = box.scrollHeight - box.scrollTop - visible
  return distance < 120
}

/** 只有用户自己往上翻时才停止自动跟随 */
function bindScrollTracking() {
  const box = $('messages')
  box.addEventListener('scroll', () => {
    if (Date.now() < Scrolling.until) return // 忽略我们自己触发的滚动
    Scrolling.follow = isNearBottom(box)
    if (Scrolling.follow) hideJump()
  }, { passive: true })
  Scrolling.follow = true
  $('jump-latest').addEventListener('click', () => {
    Scrolling.follow = true
    hideJump()
    scrollToBottom(true)
  })
}

function showJump() {
  $('jump-latest').classList.remove('hidden')
}

function hideJump() {
  $('jump-latest').classList.add('hidden')
}

/* ------------------------------------------------------------- 改头像 */

/** 服务端的上限是 400 KB，这里留点余量 */
const AVATAR_MAX_BYTES = 380 * 1024

/** 备选 emoji：够用就行，不做成 emoji 选择器 */
const AVATAR_EMOJI = ['🐺', '🌙', '🌊', '🔥', '🍀', '🐱', '🐶', '🦊', '🐧', '🧊', '☕', '🎧']

/** 头像面板的临时状态：点「保存」才真正生效 */
const AvatarEdit = { text: '', dataUrl: '', busy: false }

function openAvatarSheet() {
  const avatar = S.avatar ?? { kind: 'none', value: '' }
  AvatarEdit.text = avatar.kind === 'text' ? avatar.value : ''
  AvatarEdit.dataUrl = avatar.kind === 'image' ? avatar.value : ''
  AvatarEdit.busy = false

  $('avatar-text').value = AvatarEdit.text
  $('avatar-result').classList.add('hidden')
  renderEmojiRow()
  renderAvatarPreview()
  $('avatar-sheet').classList.remove('hidden')
}

function closeAvatarSheet(discard = true) {
  if (discard) {
    AvatarEdit.text = ''
    AvatarEdit.dataUrl = ''
  }
  $('avatar-sheet').classList.add('hidden')
}

function renderEmojiRow() {
  const row = $('emoji-row')
  const frag = document.createDocumentFragment()
  for (const glyph of AVATAR_EMOJI) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'emoji-choice'
    button.textContent = glyph
    if (AvatarEdit.text === glyph) button.classList.add('active')
    button.addEventListener('click', () => {
      // 再点一次取消选择
      AvatarEdit.text = AvatarEdit.text === glyph ? '' : glyph
      AvatarEdit.dataUrl = ''
      $('avatar-text').value = AvatarEdit.text
      renderEmojiRow()
      renderAvatarPreview()
    })
    frag.appendChild(button)
  }
  row.replaceChildren(frag)
}

function renderAvatarPreview() {
  const node = $('avatar-preview')
  if (AvatarEdit.dataUrl) {
    node.textContent = ''
    node.style.backgroundImage = `url("${AvatarEdit.dataUrl}")`
    node.style.backgroundSize = 'cover'
    node.style.backgroundPosition = 'center'
    return
  }
  node.style.backgroundImage = ''
  node.textContent = AvatarEdit.text || (S.characterName || '朋友').slice(0, 1).toUpperCase()
}

function avatarResult(message, ok) {
  const box = $('avatar-result')
  box.className = `result ${ok ? 'ok' : 'bad'}`
  box.textContent = message
  box.classList.remove('hidden')
}

/** 把 data URL 换成 Image 对象 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('这张图读不出来，换一张试试'))
    image.src = dataUrl
  })
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** base64 对应的实际字节数 */
function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return 0
  const base64 = dataUrl.slice(comma + 1)
  const padding = (base64.match(/=+$/) ?? [''])[0].length
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * 压缩图片到上限以内。
 *
 * 为什么要做：手机相册里随便一张就是 3-5 MB，直接传会被服务端拒掉。
 * 缩到 256px 见方通常只剩十几 KB，做头像绰绰有余。
 * 全程在浏览器里完成，原图不会上传。
 */
async function compressImage(file) {
  const original = await readFileAsDataUrl(file)
  if (dataUrlBytes(original) <= AVATAR_MAX_BYTES) return original

  const image = await loadImage(original)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  // 从 256 开始，不够就继续缩小、降质量
  const sizes = [256, 192, 128, 96]
  const qualities = [0.82, 0.7, 0.6, 0.5]

  for (const size of sizes) {
    // 等比缩放到 size x size 之内
    const ratio = Math.min(size / image.width, size / image.height, 1)
    const w = Math.max(1, Math.round(image.width * ratio))
    const h = Math.max(1, Math.round(image.height * ratio))
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(image, 0, 0, w, h)

    for (const quality of qualities) {
      const out = canvas.toDataURL('image/jpeg', quality)
      if (dataUrlBytes(out) <= AVATAR_MAX_BYTES) return out
    }
  }

  // 兜底：用最小尺寸的最低质量
  return canvas.toDataURL('image/jpeg', 0.4)
}

/**
 * 压缩一张**表情包**。
 *
 * 跟 compressImage（头像用）分开，因为目标尺寸不一样：
 * 头像 256px 够了，表情包缩到 256 会糊得看不清字。
 *
 * 上限也放宽到 2 MB，跟服务端 stickers.js 的 MAX_BYTES 对齐——
 * 对不上的话会出现"浏览器觉得压好了、服务端拒收"的假失败。
 */
async function compressSticker(file) {
  const original = await readFileAsDataUrl(file)
  if (dataUrlBytes(original) <= STICKER_MAX_BYTES) return original

  const image = await loadImage(original)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const sizes = [STICKER_MAX_EDGE, 512, 384, 256]
  const qualities = [0.88, 0.78, 0.68, 0.55]

  for (const size of sizes) {
    const ratio = Math.min(size / image.width, size / image.height, 1)
    const w = Math.max(1, Math.round(image.width * ratio))
    const h = Math.max(1, Math.round(image.height * ratio))
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(image, 0, 0, w, h)

    for (const quality of qualities) {
      const out = canvas.toDataURL('image/jpeg', quality)
      if (dataUrlBytes(out) <= STICKER_MAX_BYTES) return out
    }
  }

  return canvas.toDataURL('image/jpeg', 0.5)
}

/* ------------------------------------------------------------------ SSE */

function connectEvents() {
  S.es?.close()
  const es = new EventSource(`/api/events?token=${encodeURIComponent(S.token)}`)
  S.es = es

  es.addEventListener('messages', (event) => {
    const snap = JSON.parse(event.data)
    // 先记下旧游标，这样只有新到的那条会播入场动画
    const previousLastSeq = S.lastSeq
    S.messages = snap.messages
    S.lastSeq = snap.lastSeq
    /*
     * 她的状态跟着消息一起到。
     * 不更新的话会出现"她已经在打字了，顶部还写着在煮面"。
     */
    if (snap.state) {
      S.state = snap.state
      updateStatus()
    }
    renderMessages({ animate: true, animateFromSeq: previousLastSeq })
    if (snap.unread > 0 && document.visibilityState === 'visible') markRead()
  })

  es.onopen = () => {
    S.esDown = false
    // 不要在这里写"在线"——那会把她的真实状态（睡了/在忙）盖掉。
    // 状态只由服务端给的 state 决定，这里只负责清掉"断开"标记。
    updateStatus()
  }
  es.onerror = () => {
    S.esDown = true
    updateStatus()
    // EventSource 自己会重连，这里不用手动处理
  }
}

function setStatus(text, live, stateKey) {
  const el = $('status')
  el.textContent = text
  el.classList.toggle('live', Boolean(live))
  /*
   * data-state 必须每次都重置。
   * 不重置的话，从"在煮面"切到"连接断开"时旧的 data-state='busy' 还留着，
   * CSS 的橙色会盖住"断开"该有的样式——界面上看就是"断线了但显示成在忙"。
   */
  if (stateKey) el.dataset.state = stateKey
  else delete el.dataset.state
}

/**
 * 顶部那行状态。
 *
 * 以前永远写着"在线"——那是最糟的一种写法：
 * 她没回消息的时候，你只能猜是不是自己说错了什么。
 * 现在它说的是**她真实在干什么**（在煮面 / 困得不行了 / 睡了），
 * 于是"她没回我"从悬念变成了信息。
 *
 * 三种情况优先级（高到低）：
 *   1. 连接有问题 / 配置没补齐 → 这些是**系统状态**，比她在干嘛更要紧
 *   2. 服务端给的 herState（正在输入 / 睡了 / 在忙 / 在的）
 *   3. 拿不到就退回旧文案，别让界面空着
 */
function updateStatus() {
  const p = S.config?.proactive

  // 连接断了先说连接。这条比"她在忙"重要得多——不然你会以为她不理你。
  if (S.esDown) return setStatus('连接断开，重连中…', false)
  if (S.readiness?.length) return setStatus('等你补齐设置', false)

  const st = S.state
  if (st?.label) {
    // 状态栏只放主文案；细节（"8 分钟前记下"）放 title，长按能看到
    setStatus(st.label, st.key !== 'asleep', st.key)
    $('status').title = st.detail || ''
    return
  }

  if (p && !p.enabled) return setStatus('主动消息已关闭', false)
  setStatus('在线', true)
}

/**
 * 状态会**随时间自己变**（比如从"困得不行了"变成"睡了"），
 * 而那时候不一定有新消息、也就没有 SSE 推送。
 * 所以每隔一会儿自己去问一次。
 */
function startStateRefresh() {
  const pull = () => {
    if (document.visibilityState !== 'visible') return
    api('/api/app')
      .then((data) => {
        if (data.state) {
          S.state = data.state
          updateStatus()
        }
      })
      .catch(() => {})
  }
  clearInterval(startStateRefresh._timer)
  startStateRefresh._timer = setInterval(pull, 60000)
}

/**
 * 心跳：告诉服务端"我正看着这个页面"。
 *
 * 只在页面可见时发。这样服务端在它想主动开口时能判断出：
 * - 页面开着 → 消息直接出现就行，不用震手机
 * - 页面关了/切后台了 → 必须推 Bark，因为你看不到
 *
 * 这就是"推送该不该发"的唯一依据，所以别在页面隐藏时偷偷发。
 */
function startHeartbeat() {
  const beat = () => {
    if (document.visibilityState !== 'visible') return
    api('/api/ping', { method: 'POST', body: {} }).catch(() => {})
  }
  beat()
  clearInterval(startHeartbeat._timer)
  startHeartbeat._timer = setInterval(beat, 45000)

  document.addEventListener('visibilitychange', () => {
    // 切回前台立刻报到；切到后台什么都不发，让服务端自然超时
    if (document.visibilityState === 'visible') beat()
  })
}

async function markRead() {
  try {
    await api('/api/read', { method: 'POST', body: { seq: S.lastSeq } })
  } catch {
    /* 标记失败无所谓，下次还会试 */
  }
}

/* ------------------------------------------------------------- 发送消息 */

async function send() {
  const input = $('input')
  const text = input.value.trim()
  const images = [...Pending.images]
  if ((!text && images.length === 0) || S.streaming) return

  input.value = ''
  autoGrow(input)
  clearPending()
  S.streaming = true
  $('send').disabled = true

  // 自己发言时无条件跟到底：这时候用户一定想看新消息
  Scrolling.follow = true
  hideJump()

  // 乐观渲染：先把自己那句话（和图片）显示出来
  const optimistic = {
    seq: S.lastSeq + 0.5,
    at: Date.now(),
    role: 'user',
    text,
    kind: 'chat',
    ...(images.length ? { images: images.map(() => '__pending__') } : {}),
  }
  S.messages = [...S.messages, optimistic]
  renderMessages({ force: true })

  // 待发图片还没上传，先在本机直接显示，别等接口回来
  if (images.length) {
    const rows = $('messages').querySelectorAll('.row.me')
    const lastRow = rows[rows.length - 1]
    const gallery = lastRow?.querySelector('.bubble-images')
    if (gallery) {
      const nodes = [...gallery.querySelectorAll('img')]
      images.forEach((dataUrl, i) => {
        if (nodes[i]) nodes[i].src = dataUrl
      })
    }
  }

  // 再插入一个"正在打字"的气泡
  const typingRow = document.createElement('div')
  typingRow.className = 'row them'
  typingRow.id = 'typing-row'
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = clock(Date.now())
  const typingBubble = document.createElement('div')
  typingBubble.className = 'bubble'
  typingBubble.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>'
  typingRow.append(meta, typingBubble)
  $('messages').appendChild(typingRow)
  scrollToBottom(false)

  // 逐字动画接管这个气泡：先把三点动画清掉，再匀速吐字
  typewriterReset(typingBubble, () => typingBubble.replaceChildren())

  let streamed = ''
  let lastDeltaAt = 0

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}` },
      body: JSON.stringify(images.length ? { text, images } : { text }),
    })
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      throw new Error(body.slice(0, 200) || `发送失败（${res.status}）`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        const eventMatch = raw.match(/^event:\s*(.+)$/m)
        const dataMatch = raw.match(/^data:\s*(.+)$/m)
        if (!eventMatch || !dataMatch) continue
        const type = eventMatch[1].trim()
        let payload
        try {
          payload = JSON.parse(dataMatch[1])
        } catch {
          continue
        }

        if (type === 'delta') {
          const now = performance.now()
          const elapsed = lastDeltaAt ? now - lastDeltaAt : 0
          lastDeltaAt = now
          streamed = payload.full
          // 不直接写 DOM，交给自适应动画按帧更新
          typewriterFeed(streamed, elapsed)
        } else if (type === 'waiting') {
          /*
           * 她在忙，要等一会儿才动笔。
           *
           * 三点动画这时候是在**说谎**——它表示"正在输入"，
           * 可她还没开始。所以换成一句实话：她在干嘛、要等多久。
           * 第一个字吐出来时，逐字动画会把这块内容整个换掉。
           */
          showWaitingHint(typingBubble, payload)
        } else if (type === 'done') {
          // flush 让气泡先显示完整文字，避免"打完字又补一段"的跳动
          typewriterFlush()
          // 记下旧游标：只有新到的这条才播入场动画，
          // 其余气泡即使被重建也不重播（否则整屏闪一下）
          const previousLastSeq = S.lastSeq
          S.messages = payload.snapshot.messages
          S.lastSeq = payload.snapshot.lastSeq
          document.getElementById('typing-row')?.remove()
          // 自己刚发完，一定要落在最新一条上
          Scrolling.follow = true
          renderMessages({ force: true, animate: true, animateFromSeq: previousLastSeq })
        } else if (type === 'error') {
          throw new Error(payload.error)
        }
      }
    }
  } catch (err) {
    // 先停掉逐字动画，否则它还会继续往一个已被移除的节点上写字
    typewriterReset(null, null)
    document.getElementById('typing-row')?.remove()
    toast(`出错了：${err.message}`)
    // 把没发出去的内容还回输入框，别让用户白打一遍
    if (text && !input.value) {
      input.value = text
      autoGrow(input)
    }
    if (images.length && Pending.images.length === 0) {
      Pending.images = images
      renderPreviews()
    }
    // 重新拉一次真实状态，把乐观插入的消息对齐
    try {
      const data = await api('/api/app')
      S.messages = data.snapshot.messages
      S.lastSeq = data.snapshot.lastSeq
      renderMessages()
    } catch {
      /* 忽略 */
    }
  } finally {
    typewriterReset(null, null)
    S.streaming = false
    $('send').disabled = false
    document.getElementById('typing-row')?.remove()
    markRead()
  }
}

/* ------------------------------------------------------------------ 设置 */

function buildSettings(tab) {
  const body = $('sheet-body')
  if (!S.config) return

  if (tab === 'proactive') {
    const p = S.config.proactive
    body.replaceChildren(
      switchRow('开启主动找我', 'proactive-enabled', p.enabled),
      row(
        field('静默时段开始（小时）', numberInput('quietStart', p.quietStart, 0, 23)),
        field('静默时段结束（小时）', numberInput('quietEnd', p.quietEnd, 0, 23)),
        'field-row',
      ),
      row(
        field('最小间隔（分钟）', numberInput('minGapMinutes', p.minGapMinutes, 5, 1440)),
        field('最大间隔（分钟）', numberInput('maxGapMinutes', p.maxGapMinutes, 5, 1440)),
        'field-row',
      ),
      row(
        field('对方没回时最多连发', numberInput('maxUnanswered', p.maxUnanswered, 0, 10)),
        field('每天最多主动（次）', numberInput('maxPerDay', p.maxPerDay, 0, 50)),
        'field-row',
      ),
      row(
        field('刚聊完至少隔多久（分钟）', numberInput('minIdleMinutes', p.minIdleMinutes, 0, 1440)),
        field('连发两条的概率（0-1）', numberInput('doubleTextChance', p.doubleTextChance, 0, 1, 0.05)),
        'field-row',
      ),
      switchRow('让模型自己决定这次要不要开口', 'proactive-decide', p.letModelDecide),
      actionBlock('手动试一次', '立即让它判断一次要不要找你（会真的发消息）', 'btn-force', '强制发一条（跳过判断）', 'btn-force-hard'),
      // 主动决策的历史，异步填进去
      historyBlock(),
    )
    void loadHistory()
  }

  if (tab === 'persona') {
    body.replaceChildren(
      field('它是谁（这段会直接进系统提示词）', textArea('persona', S.persona, true)),
      hint('改完保存就生效，下一条回复就会用新设定。写性格、说话习惯、边界都行，越具体越像人。'),
    )
  }

  if (tab === 'self') {
    /*
     * 「她的变化」——这个面板本身就是这个功能的一部分。
     *
     * 一个会自己改自己、你完全看不见的东西，跑偏了你只会觉得
     * "她怎么变了"，查不出是哪一步变的。所以这里三件事都要有：
     * 能看她现在怎么想自己、能看她改过什么、能退回上一版。
     */
    const changes = S.selfChanges ?? []
    const changeBox = document.createElement('div')
    changeBox.className = 'field'
    changeBox.append(label(`她改过自己什么（最近 ${changes.length} 次）`))

    if (changes.length === 0) {
      changeBox.append(hint('还没有改过。她在聊天之外经历了一些事之后，会自己更新对自己的看法。'))
    } else {
      const list = document.createElement('div')
      list.className = 'change-list'
      for (const c of changes.slice(0, 8)) {
        const row = document.createElement('div')
        row.className = 'change-row'
        const when = document.createElement('div')
        when.className = 'change-when'
        when.textContent = `${fmtTime(c.at)}${c.reason ? ' · ' + c.reason : ''}`
        row.append(when)
        for (const t of c.added ?? []) {
          const line = document.createElement('div')
          line.className = 'change-line add'
          line.textContent = '+ ' + t
          row.append(line)
        }
        for (const t of c.removed ?? []) {
          const line = document.createElement('div')
          line.className = 'change-line del'
          line.textContent = '− ' + t
          row.append(line)
        }
        if (!(c.added ?? []).length && !(c.removed ?? []).length) {
          const line = document.createElement('div')
          line.className = 'change-line'
          line.textContent = '（措辞有调整）'
          row.append(line)
        }
        list.append(row)
      }
      changeBox.append(list)
    }

    const statusLine = document.createElement('div')
    statusLine.className = 'hint'
    statusLine.textContent = S.selfEnabled === false
      ? '⚠ 成长功能已关闭（FRIEND_SELF=0），她不会自己变了。'
      : `快照 ${(S.selfSnapshots ?? []).length} 份，可随时退回。`

    body.replaceChildren(
      field('她怎么看待自己（她自己会改这一段）', textArea('self', S.self, true)),
      hint(
        '这是她自己慢慢形成的想法，改完保存立刻生效。' +
          '她的"说话方式"不在这里——那属于人设，锁死的。' +
          '所以不管她怎么长，都不会变成另一个人。',
      ),
      changeBox,
      statusLine,
      actionBlock('立刻让她想一次', '拿最近的经历和对话跑一次，看她有没有新的想法', 'btn-self-evolve', '退回上一版', 'btn-self-restore'),
    )
  }

  if (tab === 'days') {
    /*
     * 她的日子（时间线）。
     *
     * 为什么值得单独一页：她的流水本来是完整的，但只有最近 8 条会被
     * 喂回去、也没有界面能看——所以她"只有现在、没有过去"。
     * 按天压成一天一句之后，你才能看到"她这些天都干了什么"。
     */
    const days = S.lifeDays ?? []
    const stats = S.lifeDaysStats ?? {}

    const head = document.createElement('div')
    head.className = 'field'
    head.append(
      label(`她的日子（${stats.total ?? 0} 天）`),
      hint(
        stats.total
          ? `${stats.first ?? ''} 起到 ${stats.last ?? ''}，一天一条。` +
            (stats.byFallback ? `${stats.byFallback} 天是自动兜底写的（当时模型没调通）。` : '')
          : '还没有记录。她过完一天之后会自动记一句，也可以点下面的「补上」立刻整理。',
      ),
    )

    const list = document.createElement('div')
    list.className = 'day-list'

    if (days.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hint'
      empty.textContent = '她每天都在过日子，只是还没被整理成"一天一句"。等一天过完就会自动记下来。'
      list.append(empty)
    }

    for (const d of days) {
      const row = document.createElement('div')
      row.className = 'day-row'

      const date = document.createElement('div')
      date.className = 'day-date'
      date.textContent = fmtDay(d.date)

      const text = document.createElement('div')
      text.className = 'day-text'
      text.textContent = d.text

      const meta = document.createElement('div')
      meta.className = 'day-meta'
      // 那天记了几件事、是不是兜底写的——都摊开说，不含糊
      meta.textContent = `${d.count ?? '?'} 件事` + (d.by === 'fallback' ? ' · 自动兜底' : '')

      row.append(date, text, meta)
      list.append(row)
    }

    body.replaceChildren(
      head,
      list,
      actionBlock(
        '补上还没整理的',
        '把过完但还没写成一句的日子补上',
        'btn-days-catchup',
        '换一批看看',
        'btn-days-reload',
      ),
    )
  }

  if (tab === 'sticker') {
    /*
     * 表情包管理。
     *
     * 两条入口都要有：上传，以及"我刚往文件夹里拷了一堆"的重扫。
     * 后者很重要——一次准备几十张图，拖进文件夹比在手机上点几十次上传现实得多。
     */
    const items = S.stickers ?? []
    const head = document.createElement('div')
    head.className = 'field'
    head.append(
      label(`表情包（${items.length} 张，启用 ${items.filter((i) => i.enabled).length} 张）`),
      hint(
        S.stickerEnabled === false
          ? '⚠ 表情包功能已关闭（FRIEND_STICKER=0），她不会发。'
          : `今天她发了 ${S.stickerTodayUsed ?? 0} / ${S.stickerMaxPerDay ?? 8} 张。` +
            `至少隔 ${S.stickerMinGap ?? 6} 条消息才会再发一张。`,
      ),
    )

    const list = document.createElement('div')
    list.className = 'sticker-list'

    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hint'
      empty.textContent =
        '还没有表情包。把图片拷到 D:\\PYF\\friend\\data\\stickers\\ 然后点下面的「重新扫描」，' +
        '或者直接用「上传」按钮。描述会由模型看图自动生成，你不用自己写。'
      list.append(empty)
    }

    for (const it of items) {
      const row = document.createElement('div')
      row.className = 'sticker-row' + (it.enabled ? '' : ' off')

      const img = document.createElement('img')
      img.className = 'sticker-thumb'
      img.loading = 'lazy'
      img.src = `/api/image?id=${it.id}`
      img.alt = it.desc || '表情包'

      const meta = document.createElement('div')
      meta.className = 'sticker-meta'

      const desc = document.createElement('textarea')
      desc.className = 'sticker-desc'
      desc.rows = 2
      desc.value = it.desc || ''
      desc.placeholder = '（还没有描述，她挑不到这张）'
      desc.dataset.stickerDesc = it.id

      const foot = document.createElement('div')
      foot.className = 'sticker-foot'
      foot.append(
        valueLine(`用过 ${it.uses ?? 0} 次`),
        (() => {
          const b = document.createElement('button')
          b.className = 'ghost tiny'
          b.textContent = it.enabled ? '停用' : '启用'
          b.dataset.stickerToggle = it.id
          b.dataset.next = it.enabled ? '0' : '1'
          return b
        })(),
        (() => {
          const b = document.createElement('button')
          b.className = 'danger tiny'
          b.textContent = '删除'
          b.dataset.stickerDelete = it.id
          return b
        })(),
      )

      meta.append(desc, foot)
      row.append(img, meta)
      list.append(row)
    }

    const upload = document.createElement('input')
    upload.type = 'file'
    upload.accept = 'image/*'
    upload.multiple = true
    upload.hidden = true
    upload.id = 'sticker-file'

    const bar = document.createElement('div')
    bar.className = 'sticker-bar'

    const pick = document.createElement('button')
    pick.className = 'ghost'
    pick.id = 'sticker-pick'
    pick.textContent = '上传图片'

    const rescan = document.createElement('button')
    rescan.className = 'ghost'
    rescan.id = 'sticker-rescan'
    rescan.textContent = '重新扫描文件夹'

    bar.append(pick, rescan, upload)

    body.replaceChildren(head, bar, list, hint('改完描述点一下空白处就保存。停用的表情包不会出现在她的候选清单里。'))
  }

  if (tab === 'memory') {
    const summaryBox = document.createElement('div')
    summaryBox.className = 'field'
    summaryBox.append(
      label('自动摘要（只读，历史聊天的压缩）'),
      (() => {
        const pre = document.createElement('textarea')
        pre.className = 'tall'
        pre.readOnly = true
        pre.value = S.summary.text || '（还没生成，聊得多了会自动压缩）'
        return pre
      })(),
    )
    body.replaceChildren(
      field('它记住的关于你的事', textArea('memory', S.memory, true)),
      summaryBox,
      actionBlock('立刻抽取一次记忆', '把最近的对话里值得长期记住的事整理进去', 'btn-extract', '压缩一次历史摘要', 'btn-summary'),
    )
  }

  if (tab === 'system') {
    const modelBox = document.createElement('div')
    modelBox.className = 'field'
    modelBox.append(
      label('模型'),
      valueLine(`聊天模型：${S.config.model.chatModel}`),
      valueLine(`DeepSeek Key：${S.config.model.configured ? '已配置 ✓' : '未配置 ✗'}`),
    )
    const barkBox = document.createElement('div')
    barkBox.className = 'field'
    barkBox.append(
      label('Bark 推送'),
      valueLine(`服务地址：${S.config.bark.server}`),
      valueLine(`Key：${S.config.bark.configured ? '已配置 ✓' : '未配置 ✗'}`),
      hint('Key 存在服务端的 config.json 里，不会下发到浏览器。'),
    )
    body.replaceChildren(modelBox, barkBox, actionBlock('测试模型', '发一次最小请求验证 Key 可用', 'btn-test-model', '发一条测试推送', 'btn-test-bark'))
    if (S.readiness.length) {
      const warn = document.createElement('div')
      warn.className = 'result bad'
      warn.textContent = S.readiness.join('\n')
      body.appendChild(warn)
    }
  }
}

async function saveSettings() {
  const btn = $('sheet-save')
  btn.disabled = true
  try {
    if (S.activeTab === 'persona') {
      const persona = $('persona').value
      await api('/api/persona', { method: 'PUT', body: { persona } })
      S.persona = persona
    } else if (S.activeTab === 'memory') {
      const memory = $('memory').value
      await api('/api/memory', { method: 'PUT', body: { memory } })
      S.memory = memory
    } else if (S.activeTab === 'self') {
      const self = $('self').value
      const r = await api('/api/self', { method: 'PUT', body: { self } })
      S.self = r.self
    } else if (S.activeTab === 'proactive') {
      const patch = {
        proactive: {
          enabled: $('proactive-enabled').checked,
          quietStart: num('quietStart'),
          quietEnd: num('quietEnd'),
          minGapMinutes: num('minGapMinutes'),
          maxGapMinutes: num('maxGapMinutes'),
          maxUnanswered: num('maxUnanswered'),
          maxPerDay: num('maxPerDay'),
          minIdleMinutes: num('minIdleMinutes'),
          doubleTextChance: num('doubleTextChance'),
          letModelDecide: $('proactive-decide').checked,
        },
      }
      const data = await api('/api/config', { method: 'PUT', body: patch })
      S.config = data.config
    }
    toast('已保存')
    renderHoldBanner()
    updateStatus()
    if (S.activeTab !== 'system') closeSheet()
  } catch (err) {
    toast(`保存失败：${err.message}`)
  } finally {
    btn.disabled = false
  }
}

const num = (id) => {
  const value = Number($(id)?.value)
  return Number.isFinite(value) ? value : 0
}

/* --------------------------------------------------------- DOM 小构件 */

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function label(text) {
  return el('label', null, text)
}

function hint(text) {
  return el('div', 'hint', text)
}

function valueLine(text) {
  const node = el('div', 'hint', text)
  return node
}

function field(labelText, control) {
  const wrap = el('div', 'field')
  wrap.append(label(labelText), control)
  return wrap
}

function row(a, b, className) {
  const wrap = el('div', className ?? '')
  wrap.append(a, b)
  return wrap
}

function textArea(id, value, tall) {
  const node = document.createElement('textarea')
  node.id = id
  if (tall) node.className = 'tall'
  node.value = value ?? ''
  return node
}

function numberInput(id, value, min, max, step) {
  const node = document.createElement('input')
  node.type = 'number'
  node.id = id
  node.value = value
  if (min !== undefined) node.min = String(min)
  if (max !== undefined) node.max = String(max)
  node.step = String(step ?? 1)
  node.inputMode = 'decimal'
  return node
}

function switchRow(text, id, checked) {
  const wrap = el('div', 'switch-row')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'switch'
  input.id = id
  input.checked = Boolean(checked)
  wrap.append(el('span', null, text), input)
  return wrap
}

function actionBlock(primaryText, primaryHint, primaryId, secondaryText, secondaryId) {
  const wrap = el('div', 'field')
  const buttons = el('div', 'field-row')
  const b1 = el('button', 'ghost', primaryText)
  b1.id = primaryId
  const b2 = el('button', 'ghost', secondaryText)
  b2.id = secondaryId
  buttons.append(b1, b2)
  wrap.append(buttons, hint(primaryHint))
  const result = el('div', 'result hidden')
  result.id = 'action-result'
  wrap.append(result)
  return wrap
}

function showActionResult(ok, message) {
  const box = $('action-result')
  if (!box) return toast(message)
  box.className = `result ${ok ? 'ok' : 'bad'}`
  box.textContent = message
  box.classList.remove('hidden')
}

/* ------------------------------------------------- 主动决策历史 */

/**
 * "它最近想找你几次、为什么没发"。
 *
 * 为什么值得放在手机上：这是回答"它怎么不主动找我"最直接的证据。
 * 原来只有终端里的 status 能看，而且只看得到最近一次。
 */
function historyBlock() {
  const wrap = el('div', 'field')
  wrap.append(
    label('最近它想找你的记录'),
    hint('每次到了窗口都会判断一次。这里能看到它发了什么、或者为什么没发。'),
  )
  const list = el('div', 'history-list')
  list.id = 'history-list'
  list.textContent = '加载中…'
  wrap.append(list)
  return wrap
}

async function loadHistory() {
  const list = $('history-list')
  if (!list) return
  try {
    const data = await api('/api/proactive/history?limit=20')
    const events = data.events ?? []
    if (events.length === 0) {
      list.textContent = '还没有记录。等它跑过一次判断就有了（大约每次窗口一次）。'
      return
    }

    const frag = document.createDocumentFragment()
    for (const e of events) {
      const row = el('div', `history-row ${e.sent ? 'sent' : 'hold'}`)

      const time = document.createElement('time')
      const d = new Date(e.at)
      time.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      row.appendChild(time)

      const text = el('span', 'history-text')
      if (e.dryRun) {
        text.textContent = `演练：${(e.messages ?? []).join(' / ') || '(没内容)'}`
        row.classList.add('dry')
      } else if (e.sent) {
        text.textContent = (e.messages ?? []).join(' / ')
      } else {
        text.textContent = e.reason || '（没说明原因）'
      }
      row.appendChild(text)
      frag.appendChild(row)
    }
    list.replaceChildren(frag)
  } catch (err) {
    list.textContent = `读不到记录：${err.message}`
  }
}

/* ------------------------------------------------------------------ 事件 */

function openSheet(tab) {
  S.activeTab = tab ?? S.activeTab
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.activeTab))
  buildSettings(S.activeTab)
  $('sheet').classList.remove('hidden')

  /*
   * 「她的变化」的内容单独拉，不塞进 /api/app。
   *
   * 理由：变更流水和快照列表只在这个面板里用得到，塞进首屏那个
   * 每次打开网页都要走的接口里是浪费。先渲染再补齐，
   * 所以点开时不会卡一下白屏。
   */
  if (S.activeTab === 'self') {
    void loadSelf().then(() => {
      if (S.activeTab === 'self') buildSettings('self')
    })
  }

  if (S.activeTab === 'sticker') {
    void loadStickers().then(() => {
      if (S.activeTab === 'sticker') buildSettings('sticker')
    })
  }

  if (S.activeTab === 'days') {
    void loadLifeDays().then(() => {
      if (S.activeTab === 'days') buildSettings('days')
    })
  }
}

/** 拉她的日子（时间线） */
async function loadLifeDays() {
  try {
    const data = await api('/api/life/days?limit=60')
    S.lifeDays = data.days ?? []
    S.lifeDaysStats = data.stats ?? {}
    S.lifeDaysPending = data.pending ?? 0
  } catch (err) {
    toast(`读她的日子失败：${err.message}`)
  }
}

/** 拉表情包列表 */
async function loadStickers() {
  try {
    const data = await api('/api/stickers')
    S.stickers = data.items ?? []
    S.stickerEnabled = data.enabled
    S.stickerTodayUsed = data.todayUsed
    S.stickerMaxPerDay = data.maxPerDay
    S.stickerMinGap = data.minMessagesBetween
  } catch (err) {
    toast(`读表情包失败：${err.message}`)
  }
}

/** 拉她的自我：当前内容 + 变更流水 + 快照列表 */
async function loadSelf() {
  try {
    const [selfData, changesData] = await Promise.all([
      api('/api/self'),
      api('/api/self/changes?limit=20'),
    ])
    S.self = selfData.self
    S.selfSnapshots = selfData.snapshots ?? []
    S.selfEnabled = selfData.enabled
    S.selfChanges = changesData.changes ?? []
  } catch (err) {
    toast(`读她的变化失败：${err.message}`)
  }
}

/** 变更流水里的时间戳 → 好读的短格式 */
function fmtTime(at) {
  if (!at) return ''
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * "2026-09-21" → "9月21日 周一"
 *
 * 加星期是有用的：你会想"她那天是周末还是工作日"——
 * 那直接影响她那天干什么。
 */
function fmtDay(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? ''))
  if (!m) return String(dateKey ?? '')
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 ${wd}`
}

function closeSheet() {
  $('sheet').classList.add('hidden')
}

function toast(message) {
  const node = $('toast')
  node.textContent = message
  node.classList.remove('hidden')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => node.classList.add('hidden'), 2600)
}

function autoGrow(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
}

function wireEvents() {
  /* 口令门 */
  $('gate-btn').addEventListener('click', async () => {
    const value = $('gate-input').value.trim()
    if (!value) return
    S.token = value
    localStorage.setItem('friend.token', value)
    try {
      await loadApp()
    } catch (err) {
      localStorage.removeItem('friend.token')
      S.token = ''
      $('gate-error').textContent = err.status === 401 ? '口令不对' : err.message
    }
  })
  $('gate-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('gate-btn').click()
  })

  /* 发图片
   *
   * 点击时**新建**一个文件选择框再用它打开选择器。
   *
   * 为什么不复用页面上那个固定的 input：
   * iOS Safari 上复用会让 FileList 返回空——change 事件正常触发，
   * 但 files.length === 0。实测日志就是 '选图:进入 收到 0 个文件'。
   * 每次新建一个干净的 input 就绕过了这个状态问题。
   */
  $('attach').addEventListener('click', () => {
    const picker = createFilePicker()
    /*
     * 必须挂进 .attach-wrap（它是 position:relative）。
     * 不要挂到 composer-row 上——选择框是绝对定位铺满容器的，
     * 挂上去会盖住整行，把输入框和发送键都挡住。
     */
    const wrap = $('attach').closest('.attach-wrap') ?? $('attach').parentElement
    wrap.appendChild(picker)
    sendClientDiag('选图:打开选择器', '已创建选择框并触发点击')
    picker.click()
  })
  // 桌面端可以直接把图拖进窗口
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  })
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    await handleImageFiles(e.dataTransfer.files)
  })

  /* 发送 */
  $('send').addEventListener('click', send)
  const input = $('input')
  input.addEventListener('input', () => autoGrow(input))

  /*
   * 表情包：上传 + 描述编辑。
   *
   * 都用文档级委托——面板内容是每次重建的，绑在节点上会在重建后失效，
   * 那是个很难查的"按钮突然没反应"。
   */
  document.addEventListener('change', async (e) => {
    if (e.target.id !== 'sticker-file') return
    const files = [...(e.target.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return

    toast(`正在上传 ${files.length} 张…`)
    let ok = 0
    for (const file of files) {
      try {
        // 表情包：长边 720 足够看清字，又不会太大
        const dataUrl = await compressSticker(file)
        await api('/api/stickers', { method: 'POST', body: { dataUrl } })
        ok++
      } catch (err) {
        toast(`「${file.name}」失败：${err.message}`)
      }
    }
    e.target.value = ''
    await loadStickers()
    if (S.activeTab === 'sticker') buildSettings('sticker')
    toast(`已添加 ${ok} / ${files.length} 张`)
  })

  document.addEventListener(
    'blur',
    async (e) => {
      const id = e.target.dataset?.stickerDesc
      if (!id) return
      const desc = e.target.value.trim()
      const cached = (S.stickers ?? []).find((s) => s.id === id)
      // 没改就不发请求——失焦会频繁触发
      if (cached && cached.desc === desc) return
      try {
        await api('/api/stickers', { method: 'PUT', body: { id, desc } })
        if (cached) cached.desc = desc
      } catch (err) {
        toast(`描述没保存：${err.message}`)
      }
    },
    true,
  )

  input.addEventListener('keydown', (e) => {
    // iPhone 上回车即发送；桌面按住 Shift 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  /* 设置面板 */
  $('open-settings').addEventListener('click', () => openSheet())
  $('sheet-close').addEventListener('click', closeSheet)
  $('sheet-save').addEventListener('click', saveSettings)
  $('sheet').addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined && e.target.classList.contains('sheet-backdrop')) closeSheet()
  })
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => openSheet(tab.dataset.tab))
  })

  /* 刷新 */
  $('refresh').addEventListener('click', async () => {
    try {
      const data = await api('/api/app')
      S.messages = data.snapshot.messages
      S.lastSeq = data.snapshot.lastSeq
      S.config = data.config
      S.characterName = data.characterName || S.characterName
      S.readiness = data.readiness
      renderIdentity()
      renderAll()
      updateStatus()
      scrollToBottom(false)
      toast('已刷新')
    } catch (err) {
      toast(`刷新失败：${err.message}`)
    }
  })

  /* 面板里的动作按钮（事件委托，因为内容是动态生成的） */
  $('sheet-body').addEventListener('click', async (e) => {
    /*
     * 表情包行的按钮用的是 data 属性而不是 id——列表是循环渲染的，
     * 用 id 会撞车（每行都想叫 "sticker-toggle"）。
     */
    const toggleId = e.target.dataset?.stickerToggle
    const deleteId = e.target.dataset?.stickerDelete
    if (toggleId || deleteId) {
      e.target.disabled = true
      try {
        if (toggleId) {
          const enabled = e.target.dataset.next === '1'
          await api('/api/stickers', { method: 'PUT', body: { id: toggleId, enabled } })
        } else {
          if (!confirm('删掉这张表情包？（文件也会删掉）')) return
          await api(`/api/stickers?id=${deleteId}`, { method: 'DELETE' })
        }
        await loadStickers()
        buildSettings('sticker')
      } catch (err) {
        toast(`操作失败：${err.message}`)
      } finally {
        e.target.disabled = false
      }
      return
    }

    const id = e.target.id
    if (!id) return
    e.target.disabled = true
    try {
      if (id === 'sticker-pick') {
        $('sticker-file')?.click()
        return
      }
      if (id === 'sticker-rescan') {
        const r = await api('/api/stickers/sync', { method: 'POST' })
        await loadStickers()
        buildSettings('sticker')
        showActionResult(
          true,
          `新增 ${r.added ?? 0} 张，生成描述 ${r.described ?? 0} 张，清理 ${r.removed ?? 0} 张` +
            ((r.errors ?? []).length ? `；${r.errors.length} 个问题` : ''),
        )
        return
      }
      if (id === 'btn-days-catchup') {
        const r = await api('/api/life/days/catchup', { method: 'POST' })
        await loadLifeDays()
        buildSettings('days')
        showActionResult(
          true,
          r.added > 0 ? `补了 ${r.added} 天` : '没有要补的（都整理过了）',
        )
        return
      }
      if (id === 'btn-days-reload') {
        await loadLifeDays()
        buildSettings('days')
        showActionResult(true, `读回 ${S.lifeDays.length} 天`)
        return
      }
      if (id === 'btn-test-model') {
        const r = await api('/api/test/model', { method: 'POST' })
        showActionResult(r.ok, r.ok ? '模型可用 ✓' : `失败：${r.message}`)
      } else if (id === 'btn-test-bark') {
        const r = await api('/api/test/bark', { method: 'POST' })
        showActionResult(r.ok, r.ok ? '推送已发出，看下手机有没有响' : `失败：${r.message}`)
      } else if (id === 'btn-force') {
        const r = await api('/api/proactive/run', { method: 'POST', body: { force: false } })
        showActionResult(true, r.sent ? `已发出：${(r.messages ?? []).join(' / ')}` : `这次没发。原因：${r.reason}`)
      } else if (id === 'btn-force-hard') {
        const r = await api('/api/proactive/run', { method: 'POST', body: { force: true } })
        showActionResult(Boolean(r.sent), r.sent ? `已强制发出：${(r.messages ?? []).join(' / ')}` : `失败：${r.reason}`)
      } else if (id === 'btn-extract') {
        const r = await api('/api/memory/extract', { method: 'POST' })
        if (r.updated) {
          S.memory = r.memory
          $('memory').value = r.memory
          showActionResult(true, '记忆已更新')
        } else {
          showActionResult(false, `没更新：${r.reason}`)
        }
      } else if (id === 'btn-summary') {
        const r = await api('/api/summary/roll', { method: 'POST' })
        showActionResult(Boolean(r.updated), r.updated ? `已压缩到第 ${r.upToSeq} 条` : `没压缩：${r.reason}`)
      } else if (id === 'btn-self-evolve') {
        const r = await api('/api/self/evolve', { method: 'POST' })
        S.self = r.self
        $('self').value = r.self
        await loadSelf()
        showActionResult(
          Boolean(r.updated),
          r.updated
            ? `她想通了点什么：${(r.added ?? []).map((t) => '「' + t + '」').join('') || '（措辞有调整）'}`
            : `没变：${r.reason}`,
        )
      } else if (id === 'btn-self-restore') {
        const r = await api('/api/self/restore', { method: 'POST' })
        if (r.updated) {
          S.self = r.self
          $('self').value = r.self
          await loadSelf()
          showActionResult(true, `已退回 ${r.restoredFrom}`)
        } else {
          showActionResult(false, `退不了：${r.reason}`)
        }
      }
    } catch (err) {
      showActionResult(false, err.message)
    } finally {
      e.target.disabled = false
    }
  })

  /* 改头像 */
  $('avatar').addEventListener('click', openAvatarSheet)
  $('avatar-cancel').addEventListener('click', () => closeAvatarSheet(true))
  $('avatar-sheet').addEventListener('click', (e) => {
    if (e.target.dataset.avatarClose !== undefined && e.target.classList.contains('sheet-backdrop')) {
      closeAvatarSheet(true)
    }
  })

  $('avatar-text').addEventListener('input', () => {
    // 手输文字时清掉图片，两者只能留一个
    AvatarEdit.text = $('avatar-text').value.trim()
    AvatarEdit.dataUrl = ''
    renderEmojiRow()
    renderAvatarPreview()
  })

  $('avatar-pick').addEventListener('click', () => $('avatar-file').click())

  $('avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选同一个文件
    if (!file) return
    if (!file.type.startsWith('image/')) {
      avatarResult('请选择图片文件', false)
      return
    }
    avatarResult('正在压缩…', true)
    try {
      const before = dataUrlBytes(await readFileAsDataUrl(file))
      const dataUrl = await compressImage(file)
      AvatarEdit.dataUrl = dataUrl
      AvatarEdit.text = ''
      $('avatar-text').value = ''
      renderEmojiRow()
      renderAvatarPreview()
      const after = dataUrlBytes(dataUrl)
      avatarResult(
        before > after
          ? `已压缩：${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB`
          : `图片 ${Math.round(after / 1024)} KB`,
        true,
      )
    } catch (err) {
      avatarResult(err.message, false)
    }
  })

  $('avatar-reset').addEventListener('click', async () => {
    if (AvatarEdit.busy) return
    AvatarEdit.busy = true
    try {
      const data = await api('/api/avatar', { method: 'PUT', body: { kind: 'none' } })
      S.avatar = data.avatar
      renderIdentity()
      AvatarEdit.text = ''
      AvatarEdit.dataUrl = ''
      $('avatar-text').value = ''
      renderEmojiRow()
      renderAvatarPreview()
      avatarResult('已恢复默认', true)
    } catch (err) {
      avatarResult(err.message, false)
    } finally {
      AvatarEdit.busy = false
    }
  })

  $('avatar-save').addEventListener('click', async () => {
    if (AvatarEdit.busy) return
    const button = $('avatar-save')
    button.disabled = true
    AvatarEdit.busy = true
    try {
      let payload
      if (AvatarEdit.dataUrl) payload = { kind: 'image', dataUrl: AvatarEdit.dataUrl }
      else if (AvatarEdit.text) payload = { kind: 'text', value: AvatarEdit.text }
      else payload = { kind: 'none' }

      const data = await api('/api/avatar', { method: 'PUT', body: payload })
      S.avatar = data.avatar
      renderIdentity()
      closeAvatarSheet(true)
      toast('头像已更新')
    } catch (err) {
      avatarResult(err.message, false)
    } finally {
      button.disabled = false
      AvatarEdit.busy = false
    }
  })

  /* 回到前台时刷新 + 标记已读 */
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return
    try {
      const data = await api('/api/app')
      S.messages = data.snapshot.messages
      S.lastSeq = data.snapshot.lastSeq
      renderMessages()
      markRead()
    } catch {
      /* 忽略 */
    }
  })

  /* iOS 键盘：用 visualViewport 顶起输入框，别让它被键盘盖住 */
  if (window.visualViewport) {
    const vv = window.visualViewport
    const sync = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--kb', `${offset}px`)
      document.querySelector('.app').style.paddingBottom = `${offset}px`
      // 键盘弹起/收起会改变可见高度。此时如果用户本来就贴着底部，
      // 必须重新顶到底，否则最后一条会被键盘挡住。
      if (Scrolling.follow) scrollToBottom(false)
    }
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
  }

  /* 页面隐藏前把已读状态推上去 */
  window.addEventListener('pagehide', () => {
    navigator.sendBeacon?.(`/api/read?token=${encodeURIComponent(S.token)}`)
  })

  // 滚动跟随状态必须在首次渲染之前建立
  bindScrollTracking()
}

/* ------------------------------------------------------------------ 时间格式 */

function clock(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400000)
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, today)) return '今天'
  if (same(d, yesterday)) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/* ------------------------------------------------------------- 启动 */

/**
 * 构建版本号。
 *
 * 用途很实在：手机上出问题时，第一件要确认的事是"跑的是哪一版"。
 * iOS 对"添加到主屏幕"的网页缓存极顽固，光靠下拉刷新经常没用——
 * 实测排查图片功能查了很久，最后发现手机上跑的根本是旧 JS，
 * 新代码一行都没执行。
 *
 * 所以：启动时立刻上报一次版本，并在设置页里显示出来。
 * 对不上就说明缓存没更新。
 */
const BUILD = '2026-09-20.9'

function reportBuild() {
  sendClientDiag('启动', `版本 ${BUILD}`, {
    href: location.href.slice(0, 100),
    standalone: String(window.navigator.standalone ?? 'n/a'),
    hasFileOverlay: Boolean(document.querySelector('.file-overlay')),
    hasAttach: Boolean(document.getElementById('attach')),
  })
}

wireEvents()
// 把版本号显示在界面上，一眼就能看出是不是旧版
if ($('build')) $('build').textContent = `build ${BUILD}`
reportBuild()
boot()
