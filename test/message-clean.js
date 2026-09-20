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
import { suite, assert, isMain } from './_harness.js'
import { __debug } from '../src/engine.js'

const { normalizeMessages, salvageJsonStrings, looksLikeJsonGarbage } = __debug

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

  t.finish()
  return t.state
}

if (isMain(import.meta.url)) {
  const state = run()
  process.exit(state.fail === 0 ? 0 : 1)
}
