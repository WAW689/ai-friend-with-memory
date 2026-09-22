/**
 * 主动消息的清洗与 JSON 打捞测试。
 *
 * 背景：实测抓到一个很难发现的 bug——
 * 模型想返回 {"messages": [...]}，但输出被 token 截断，
 * JSON 解析失败后回退到"按行切分"，结果**整段 JSON 原文被当成消息发了出去**：
 *   {"messages": ["十一点我跟人去吃个饭，就在学校后门那家"]"}
 *
 * 这类错误不会报错、不会崩，只会让用户看到一串乱码般的 JSON。
 *
 * 用法：node test/message-clean.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import { suite, assert, isMain } from './_harness.js'
import { __debug } from '../src/engine.js'

const {
  normalizeMessages,
  salvageJsonStrings,
  looksLikeJsonGarbage,
  cleanupReply,
  sanitizeChunk,
  sanitizeFull,
} = __debug

export function run() {
  const t = suite('消息清洗')

  console.log('\n消息清洗\n')

  t.check('正常消息原样保留', () => {
    const out = normalizeMessages(['刚下楼买了杯咖啡'])
    assert(out.length === 1 && out[0] === '刚下楼买了杯咖啡', `结果不对：${JSON.stringify(out)}`)
    return out[0]
  })

  t.check('去掉行首编号和项目符号', () => {
    const out = normalizeMessages(['1. 第一条', '- 第二条', '• 第三条', '1、第四条'])
    assert(out.every((l) => !/^[-*•\d]/.test(l)), `没去干净：${JSON.stringify(out)}`)
    return JSON.stringify(out)
  })

  t.check('最多保留两条', () => {
    const out = normalizeMessages(['a', 'b', 'c', 'd'])
    assert(out.length === 2, `保留了 ${out.length} 条`)
    return `${out.length} 条`
  })

  t.check('过滤空行和纯空白', () => {
    const out = normalizeMessages(['a', '', '   ', '\n', 'b'])
    assert(out.length === 2, `结果不对：${JSON.stringify(out)}`)
    return '已过滤'
  })

  t.check('JSON 残渣不会被当成消息（关键回归点）', () => {
    // 这就是实测抓到的 bug：解析失败后回退到按行切分，把 JSON 原文整个发了出去
    const garbage = [
      '{"messages": ["十一点我跟人去吃个饭，就在学校后门那家"]"}',
      '{"messages": ["a", "b"]}',
      '{"text": "hi"}',
      '```json',
    ]
    for (const line of garbage) {
      const out = normalizeMessages([line])
      assert(out.length === 0, `JSON 残渣没被过滤：${JSON.stringify(out)}`)
    }
    return `过滤了 ${garbage.length} 种 JSON 残渣`
  })

  t.check('识别 JSON 残渣的判断本身正确', () => {
    assert(looksLikeJsonGarbage('{"messages": ["a"]}'), '完整 JSON 应被识别')
    assert(looksLikeJsonGarbage('```json'), '代码块标记应被识别')
    assert(!looksLikeJsonGarbage('刚下楼买咖啡'), '正常聊天不该被误判')
    assert(!looksLikeJsonGarbage('我说"你好"'), '普通引号不该被误判')
    return '判断准确'
  })

  console.log('\n残缺 JSON 打捞\n')

  t.check('从截断的 JSON 里捞出完整字符串', () => {
    const text = '{"messages": ["十一点我跟人去吃个饭", "然后回'
    const out = salvageJsonStrings(text)
    assert(out.includes('十一点我跟人去吃个饭'), `没捞到完整那条：${JSON.stringify(out)}`)
    assert(!out.some((s) => s.includes('然后回')), `把截断的半条也捞了：${JSON.stringify(out)}`)
    return JSON.stringify(out)
  })

  t.check('跳过 JSON 的键名', () => {
    const out = salvageJsonStrings('{"messages": ["真正的消息"]}')
    assert(!out.includes('messages'), `键名被当成内容：${JSON.stringify(out)}`)
    assert(out.includes('真正的消息'), '正常内容没捞到')
    return JSON.stringify(out)
  })

  t.check('正常 JSON 也能捞（作为兜底路径）', () => {
    const out = salvageJsonStrings('{"messages": ["第一条", "第二条"]}')
    assert(out.length === 2, `捞出 ${out.length} 条`)
    return JSON.stringify(out)
  })

  t.check('转义字符被正确还原', () => {
    const out = salvageJsonStrings('{"messages": ["他说\\"好\\"", "第二"]}')
    assert(out[0] === '他说"好"', `转义没还原：${JSON.stringify(out[0])}`)
    return JSON.stringify(out)
  })

  t.check('打捞结果经过清洗后是干净的', () => {
    const text = '{"messages": ["十一点我跟人去吃个饭", "然后回'
    const out = normalizeMessages(salvageJsonStrings(text))
    assert(out.length === 1, `结果条数不对：${JSON.stringify(out)}`)
    assert(out[0] === '十一点我跟人去吃个饭', `内容不对：${JSON.stringify(out)}`)
    return out[0]
  })

  t.check('捞不到东西时返回空数组而不是原文', () => {
    const out = normalizeMessages(salvageJsonStrings('{"messages": ['))
    assert(out.length === 0, `不该有内容：${JSON.stringify(out)}`)
    return '返回空，这次会跳过而不是发乱码'
  })

  console.log('\n换行清洗（气泡里不许有空行）\n')

  t.check('连续空行被合成一句话（真实事故）', () => {
    /*
     * 实测：400 条回复里有 39 条带换行，而且**全是 `\n\n`，单个 `\n` 一处都没有**。
     * 说明她在用"空行"分段，渲染出来就是气泡里段落之间空一行——像文档不像微信。
     *
     * 更离谱的一条：她把操作系统课的内容写成了 6 段带小标题的讲义，
     * 完全违反人设里"一次 1-2 句"。所以清洗和提示词两边都要堵。
     */
    const raw = '就是排队。\n\n你是新来的，先让你进最快的队。\n\n快队排的人少，办得也快。'
    const out = cleanupReply(raw)
    assert(!out.includes('\n'), `还有换行：${JSON.stringify(out)}`)
    assert(out.startsWith('就是排队。'), '开头变了')
    assert(out.includes('快队排的人少'), '内容丢了')
    return out.slice(0, 30) + '…'
  })

  t.check('换行变空格，不是直接删掉（否则两句话会黏在一起）', () => {
    // "就够了。" + "先听着" 如果直接删换行会变成"就够了。先听着"——这是对的，
    // 但 "abc\n\ndef" 直接删会变成 "abcdef"。要的是空格。
    const out = cleanupReply('嗯，能应付过课间就够了。\n\n先听着，下课再说。')
    assert(out === '嗯，能应付过课间就够了。 先听着，下课再说。', `结果不对：${JSON.stringify(out)}`)
    return JSON.stringify(out)
  })

  t.check('单个换行也处理（以后模型改了习惯也不会漏）', () => {
    const out = cleanupReply('第一行\n第二行')
    assert(!out.includes('\n'), '单个换行没处理')
    return JSON.stringify(out)
  })

  t.check('开头的换行和空格被去掉', () => {
    const out = cleanupReply('\n\n  开头就是换行')
    assert(out === '开头就是换行', `结果不对：${JSON.stringify(out)}`)
    return JSON.stringify(out)
  })

  t.check('没有换行的消息不受影响', () => {
    const out = cleanupReply('很普通的一条消息，没有任何换行。')
    assert(out === '很普通的一条消息，没有任何换行。', '内容被改了')
    return '原样'
  })

  t.check('流式分片做同样的清洗，且**不 trim**（关键）', () => {
    /*
     * 流式那块不能 trim：正文还没结束，trim 会把正在打的空格吃掉，
     * 后面接上的字就跟前面黏在一起了（"你好" + " 吗" → "你好吗" 而不是 "你好 吗"）。
     */
    assert(sanitizeChunk('\n\n') === ' ', '纯换行分片应该变成一个空格')
    assert(sanitizeChunk('abc\n\ndef') === 'abc def', '分片里的换行没处理')
    assert(sanitizeChunk(' 尾空格 ') === ' 尾空格 ', '不该 trim 掉空格')
    assert(sanitizeChunk('') === '', '空分片应该还是空')
    return 'ok'
  })

  t.check('累计全文上清洗能把跨分片的双空格收掉（关键）', () => {
    /*
     * 双空格**只产生在分片边界上**：
     * 模型分两次吐出 "a\n" 和 "\nb"，单独清洗各得 "a " 和 " b"，
     * 拼起来就是 "a  b"——单看一片永远发现不了。
     * 所以清洗的必须是**累计全文**（前端用的也是 payload.full）。
     */
    const chunks = ['a\n', '\nb']
    let full = ''
    const shown = []
    for (const c of chunks) {
      full += c
      shown.push(sanitizeFull(full))
    }
    assert(!/ {2,}/.test(shown[1]), `累计清洗后仍有双空格：${JSON.stringify(shown[1])}`)
    assert(shown[1] === 'a b', `结果不对：${JSON.stringify(shown[1])}`)

    // 模拟真实场景：她分片吐出带空行的两段
    let real = ''
    const realShown = []
    for (const c of ['就是排队。', '\n\n', '你是新来的。']) {
      real += c
      realShown.push(sanitizeFull(real))
    }
    assert(!/ {2,}/.test(realShown[2]), `真实分片出现双空格：${JSON.stringify(realShown[2])}`)
    assert(realShown[2] === '就是排队。 你是新来的。', `结果不对：${JSON.stringify(realShown[2])}`)
    return JSON.stringify(realShown[2])
  })

  t.check('流式分片和最终结果对得上（否则消息结束时会跳一下）', () => {
    /*
     * 这两条必须一致。不一致的话，屏幕上会先空出一行、
     * 等消息结束正文被规范化之后那行又缩回去——那个跳动很明显。
     */
    const chunks = ['就是排队。', '\n\n', '你是新来的。', '\n\n', '就这点事。']
    const streamed = chunks.map(sanitizeChunk).join('')
    const final = cleanupReply(chunks.join(''))
    assert(streamed.trim() === final, `流式得到 ${JSON.stringify(streamed)}，最终是 ${JSON.stringify(final)}`)
    return JSON.stringify(final)
  })

  t.check('主动消息的每条内部也不许有换行', () => {
    // 主动开口的每条都是独立的一行，内部再有换行就会在气泡里断开
    const out = normalizeMessages(['第一句\n\n第二句'])
    assert(out.length === 1, `条数不对：${JSON.stringify(out)}`)
    assert(!out[0].includes('\n'), `还有换行：${JSON.stringify(out[0])}`)
    return JSON.stringify(out[0])
  })

  t.finish()
  return t.state
}

if (isMain(import.meta.url)) {
  const state = run()
  process.exit(state.fail === 0 ? 0 : 1)
}
