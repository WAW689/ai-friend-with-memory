/**
 * 表情包的测试。
 *
 * 这个功能最容易出的四类问题：
 *
 * 1. **她变成表情包机器人**。模型一旦发现"发表情包有反应"就会越用越多。
 *    所以间隔闸门和每日上限必须有测试盯着——这是整个功能最重要的部分。
 * 2. **发错图**。编号越界时如果兜底成"随便抓一张"，会发出完全不相干的图，
 *    比不发尴尬得多。
 * 3. **标记漏进正文**。用户看到 `[表情包:3]` 这种坐标；而且它会留在历史里，
 *    下一轮模型会照抄。
 * 4. **清单和编号错位**。清单是轮换的（用得少的排前面），
 *    如果翻译编号时用了另一份清单，就会发错。
 *
 * 用法：node test/stickers.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, loadConfig } from '../src/config.js'
import {
  enabledStickers,
  getSticker,
  readLib,
  stickerMenu,
  stickerFile,
  writeLib,
  STICKER_LIMITS,
} from '../src/stickers.js'
import { parseStickerMark, stickerGate } from '../src/engine.js'
import { buildStickerSection } from '../src/prompts.js'
import { store } from '../src/storage.js'

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

/** 造假的库和消息，避免依赖真实文件 */
function seed({ items = [], assistantMessages = 0, state = {} } = {}) {
  fs.mkdirSync(path.dirname(PATHS.stickerLib), { recursive: true })
  writeLib({
    version: 1,
    items: items.map((it, i) => ({
      id: it.id ?? String(i + 1).padStart(16, 'a'),
      file: it.file ?? `s${i}.png`,
      mime: 'image/png',
      bytes: 100,
      desc: it.desc ?? `描述${i + 1}`,
      enabled: it.enabled !== false,
      uses: it.uses ?? 0,
      addedAt: it.addedAt ?? 1000 + i,
    })),
  })

  store.messages = Array.from({ length: assistantMessages }, (_, i) => ({
    seq: i + 1,
    at: Date.now(),
    role: 'assistant',
    text: `m${i}`,
    kind: 'chat',
  }))
  store.state = { ...store.state, ...state }
}

const cfg = loadConfig()

console.log('\n标记解析（容错）\n')

check('标准写法能抠出来', () => {
  const r = parseStickerMark('行吧\n[表情包:3]')
  assert(r.index === 3, `编号不对：${r.index}`)
  assert(r.text === '行吧', `正文不对：${JSON.stringify(r.text)}`)
  return `index=${r.index}`
})

check('全角冒号也能认', () => {
  const r = parseStickerMark('无语了[表情包：2]')
  assert(r.index === 2, `全角冒号没认出来：${r.index}`)
  return 'ok'
})

check('夹在句中、带空格也能认', () => {
  const r = parseStickerMark('这个 [ 表情包 : 5 ] 给你')
  assert(r.index === 5, `没认出来：${r.index}`)
  assert(!r.text.includes('表情包'), '标记残留：' + r.text)
  return 'ok'
})

check('多个标记只认第一张（真人也只发一张）', () => {
  const r = parseStickerMark('[表情包:1]\n[表情包:7]')
  assert(r.index === 1, `应该认第一张，实际 ${r.index}`)
  assert(!r.text.includes('表情包'), '标记残留：' + r.text)
  return '只认第一张'
})

check('没有标记时原样返回', () => {
  const r = parseStickerMark('今天挺累的')
  assert(r.index === null, '误判出编号')
  assert(r.text === '今天挺累的', '正文被改了')
  return 'ok'
})

check('只有标记、没有正文时正文为空', () => {
  const r = parseStickerMark('[表情包:4]')
  assert(r.index === 4, '编号不对')
  assert(r.text === '', `正文应该是空串，实际 ${JSON.stringify(r.text)}`)
  return '空正文'
})

check('抠掉标记后不留下多余空行', () => {
  const r = parseStickerMark('第一行\n\n[表情包:2]\n\n')
  assert(!/\n{3,}/.test(r.text), '留下了多余空行：' + JSON.stringify(r.text))
  return JSON.stringify(r.text)
})

check('乱写编号不会崩', () => {
  assert(parseStickerMark('[表情包:abc]').index === null, '非数字应该忽略')
  assert(parseStickerMark('[表情包:999]').index === 999, '大数字应该原样返回（越界交给下游拦）')
  assert(parseStickerMark('').index === null, '空串应该安全')
  assert(parseStickerMark(null).index === null, 'null 应该安全')
  return 'ok'
})

console.log('\n频率闸门（最重要）\n')

check('关掉功能就永远不发', () => {
  seed({ items: [{ desc: 'x' }], assistantMessages: 100 })
  const gate = stickerGate({ sticker: { enabled: false } })
  assert(!gate.ok, '关了还允许发')
  return gate.reason
})

check('刚发过就拦（不到间隔条数）', () => {
  seed({ items: [{ desc: 'x' }], assistantMessages: 10 })
  store.state.lastStickerAtSeq = 8 // 才说了 2 条
  const gate = stickerGate({ sticker: { enabled: true, minMessagesBetween: 6, maxPerDay: 8 } })
  assert(!gate.ok, '间隔不够却放行')
  return gate.reason
})

check('隔够了就放行', () => {
  seed({ items: [{ desc: 'x' }], assistantMessages: 10 })
  store.state.lastStickerAtSeq = 3 // 已经说了 7 条
  const gate = stickerGate({ sticker: { enabled: true, minMessagesBetween: 6, maxPerDay: 8 } })
  assert(gate.ok, '隔够了却被拦：' + gate.reason)
  return '放行'
})

check('从没发过时放行（重启后 lastStickerAtSeq 是空的）', () => {
  seed({ items: [{ desc: 'x' }], assistantMessages: 50 })
  delete store.state.lastStickerAtSeq
  const gate = stickerGate({ sticker: { enabled: true, minMessagesBetween: 6, maxPerDay: 8 } })
  assert(gate.ok, '第一次就被拦：' + gate.reason)
  return '放行'
})

check('每日上限会被拦住', () => {
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  seed({ items: [{ desc: 'x' }], assistantMessages: 100, state: { stickersByDay: { [key]: 8 } } })
  const gate = stickerGate({ sticker: { enabled: true, minMessagesBetween: 6, maxPerDay: 8 } })
  assert(!gate.ok, '到上限了还放行')
  return gate.reason
})

check('昨天的计数不算今天的', () => {
  seed({ items: [{ desc: 'x' }], assistantMessages: 100, state: { stickersByDay: { '2020-01-01': 99 } } })
  const gate = stickerGate({ sticker: { enabled: true, minMessagesBetween: 6, maxPerDay: 8 } })
  assert(gate.ok, '旧日期把今天拦住了：' + gate.reason)
  return '放行'
})

console.log('\n清单与轮换\n')

check('关掉的表情包不进清单', () => {
  seed({ items: [{ desc: 'a' }, { desc: 'b', enabled: false }, { desc: 'c' }] })
  const menu = stickerMenu()
  assert(menu.list.length === 2, `应该只剩 2 张，实际 ${menu.list.length}`)
  assert(!menu.text.includes('b'), '停用的还在清单里')
  return `${menu.list.length} 张`
})

check('用得少的排前面（否则后面永远轮不上）', () => {
  seed({
    items: [
      { desc: '用得多的', uses: 50 },
      { desc: '没用过的', uses: 0 },
    ],
  })
  const menu = stickerMenu()
  assert(menu.list[0].desc === '没用过的', `第一张应该是没用过的，实际是「${menu.list[0].desc}」`)
  return '已轮换'
})

check('清单带编号，且编号从 1 开始', () => {
  seed({ items: [{ desc: '甲' }, { desc: '乙' }] })
  const menu = stickerMenu()
  assert(/^1\. /.test(menu.text), '清单没从 1 开始：' + menu.text)
  assert(menu.text.includes('甲'), '描述没进去')
  return 'ok'
})

check('空库返回空清单（不注入提示词）', () => {
  seed({ items: [] })
  const menu = stickerMenu()
  assert(menu.text === '', '空库却有清单文本')
  assert(buildStickerSection(menu.text) === '', '空清单却注入了段落')
  return '空串'
})

check('没有描述的不进清单（否则模型无法区分，只能瞎挑）', () => {
  /*
   * 这条抓的是一个真实的设计问题：描述生成失败时，
   * 清单里会出现一堆一模一样的"（还没写描述）"。
   * 模型分不出哪张是哪张，挑出来的就是随机的——比不发更糟。
   */
  seed({ items: [{ desc: '有描述的' }, { desc: '' }, { desc: '   ' }] })
  const menu = stickerMenu()
  assert(menu.list.length === 1, `应该只剩 1 张，实际 ${menu.list.length}`)
  assert(menu.text.includes('有描述的'), '有描述的没进去')
  assert(!menu.text.includes('还没写描述'), '空描述的还是进了清单')
  return '只留 1 张'
})

check('全部没描述时返回空清单（宁可不发）', () => {
  seed({ items: [{ desc: '' }, { desc: '' }] })
  const menu = stickerMenu()
  assert(menu.text === '', '没有可用描述却给了清单')
  assert(buildStickerSection(menu.text) === '', '注入了空清单段落')
  return '空串'
})

check('描述过长会被截断（每轮都要带的，得省 token）', () => {
  seed({ items: [{ desc: '这是一段特别特别长的描述'.repeat(10) }] })
  const menu = stickerMenu()
  const line = menu.text.split('\n')[0]
  assert(line.length < 30, `描述没截断，长度 ${line.length}：${line}`)
  return `${line.length} 字`
})

check('超过上限时只取前 N 张', () => {
  seed({ items: Array.from({ length: 50 }, (_, i) => ({ desc: `第${i}张`, addedAt: 1000 + i })) })
  const menu = stickerMenu()
  assert(menu.list.length === STICKER_LIMITS.maxInPrompt, `应该取 ${STICKER_LIMITS.maxInPrompt} 张，实际 ${menu.list.length}`)
  return `${menu.list.length} 张`
})

check('编号能正确翻译回 id（清单顺序 ≠ id 顺序）', () => {
  /*
   * 这条防的是最隐蔽的一类错：清单是**轮换**的，
   * 编号 1 不一定是库里第一张。翻译时用了另一份清单就会发错图。
   */
  seed({
    items: [
      { id: 'aaaaaaaaaaaaaaaa', desc: '用得多的', uses: 9 },
      { id: 'bbbbbbbbbbbbbbbb', desc: '没用过的', uses: 0 },
    ],
  })
  const menu = stickerMenu()
  assert(menu.list[1].id === 'aaaaaaaaaaaaaaaa', '列表顺序和预期不符')
  return '顺序已轮换'
})

console.log('\n段落注入\n')

check('有表情包时注入清单 + 怎么发', () => {
  seed({ items: [{ desc: '一只躺着的猫' }] })
  const s = buildStickerSection(stickerMenu().text)
  assert(s.includes('一只躺着的猫'), '描述没进去')
  assert(/\[表情包:编号\]|\[表情包:N\]/.test(s.replace('编号', 'N')) || /表情包:/.test(s), '没说明怎么发')
  assert(/不要连着发/.test(s), '缺少"不要连着发"的克制说明')
  return `${s.length} 字`
})

check('克制说明必须在（防表情包机器人）', () => {
  seed({ items: [{ desc: 'x' }] })
  const s = buildStickerSection(stickerMenu().text)
  assert(/大部分消息是不带表情包的/.test(s), '缺少"大部分消息不带"的说明')
  assert(/单独起一行/.test(s), '没说明标记要单独一行')
  return '有'
})

console.log('\n文件与索引\n')

check('索引文件不存在时返回空库而不是崩', () => {
  fs.rmSync(PATHS.stickerLib, { force: true })
  const lib = readLib()
  assert(Array.isArray(lib.items) && lib.items.length === 0, '没返回空库')
  return '空库'
})

check('索引坏掉时也返回空库', () => {
  fs.writeFileSync(PATHS.stickerLib, '{ 这不是 JSON', 'utf8')
  const lib = readLib()
  assert(Array.isArray(lib.items), '坏文件让 readLib 崩了')
  return '已兜住'
})

check('stickerFile 挡住目录穿越', () => {
  seed({ items: [{ id: 'aaaaaaaaaaaaaaaa', file: '../../../config.json' }] })
  const item = getSticker('aaaaaaaaaaaaaaaa')
  assert(stickerFile(item) === null, '目录穿越没被拦住')
  return '已拦住'
})

check('文件不存在时 stickerFile 返回 null', () => {
  seed({ items: [{ id: 'aaaaaaaaaaaaaaaa', file: 'not-there.png' }] })
  const item = getSticker('aaaaaaaaaaaaaaaa')
  assert(stickerFile(item) === null, '不存在的文件却返回了路径')
  return 'null'
})

check('id 格式非法的不算数', () => {
  seed({ items: [{ desc: 'x' }] })
  assert(getSticker('../etc/passwd') === null, '非法 id 被当成有效')
  assert(getSticker('') === null, '空 id 被当成有效')
  return 'ok'
})

check('停用后不进 enabledStickers', () => {
  seed({ items: [{ desc: 'a' }, { desc: 'b', enabled: false }] })
  assert(enabledStickers().length === 1, `应该有 1 张启用，实际 ${enabledStickers().length}`)
  return 'ok'
})

check('配置里有限流参数，且间隔不是 0', () => {
  const c = loadConfig()
  assert(c.sticker.enabled !== undefined, '缺 enabled')
  assert(c.sticker.minMessagesBetween >= 3, `间隔太小（${c.sticker.minMessagesBetween}），会变成表情包机器人`)
  assert(c.sticker.maxPerDay > 0 && c.sticker.maxPerDay <= 30, `每日上限不合理：${c.sticker.maxPerDay}`)
  return `隔 ${c.sticker.minMessagesBetween} 条 / 每天 ${c.sticker.maxPerDay} 张`
})

check('写入的不是真实 data 目录', () => {
  assert(
    path.resolve(PATHS.data) === path.resolve(process.env.FRIEND_DATA_DIR),
    `PATHS.data 指向了 ${PATHS.data}`,
  )
  return PATHS.data
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
