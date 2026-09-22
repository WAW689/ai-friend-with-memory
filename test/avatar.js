/**
 * 头像模块的单元测试。
 * 直接测服务端逻辑，不需要起服务——比走 HTTP 更快，也更容易覆盖边界。
 *
 * 用法：node test/avatar.js
 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

import fs from 'node:fs'
import path from 'node:path'
import { readAvatar, setTextAvatar, setImageAvatar, clearAvatar, MAX_IMAGE_BYTES } from '../src/avatar.js'
import { PATHS } from '../src/config.js'

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

/** 一个真正的 1x1 PNG */
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

console.log('\n头像模块\n')

// 记下原始状态，测完还原，别把用户设好的头像弄丢
const original = readAvatar()

check('文字头像：正常设置', () => {
  const avatar = setTextAvatar('狼')
  assert(avatar.kind === 'text', 'kind 不对')
  assert(avatar.value === '狼', `值不对：${avatar.value}`)
  assert(readAvatar().value === '狼', '没有落盘')
  return `value=${avatar.value}`
})

check('文字头像：多余字符被截到 2 个', () => {
  const avatar = setTextAvatar('一二三四五')
  assert(Array.from(avatar.value).length === 2, `没截断：${avatar.value}`)
  return `value=${avatar.value}`
})

check('文字头像：emoji 不会被切成半个', () => {
  const avatar = setTextAvatar('🐺🌙🔥')
  const glyphs = Array.from(avatar.value)
  assert(glyphs.length === 2, `码点数量不对：${glyphs.length}`)
  assert(glyphs[0] === '🐺', `第一个字被切坏：${JSON.stringify(glyphs[0])}`)
  // 关键：不能出现落单的代理项（半个 emoji）
  for (const g of glyphs) {
    assert(g.codePointAt(0) > 0xffff || g.length === 1, `出现了半个字符：${JSON.stringify(g)}`)
  }
  return `value=${avatar.value}（${glyphs.length} 个码点）`
})

check('文字头像：空字符串等于恢复默认', () => {
  setTextAvatar('狼')
  const avatar = setTextAvatar('   ')
  assert(avatar.kind === 'none', `应为 none，实际 ${avatar.kind}`)
  return 'kind=none'
})

check('图片头像：正常设置', () => {
  const result = setImageAvatar(PNG_1PX)
  assert(result.avatar.kind === 'image', 'kind 不对')
  assert(result.bytes > 0, '字节数为 0')
  assert(readAvatar().kind === 'image', '没有落盘')
  return `${result.bytes} 字节`
})

check('图片头像：拒绝非图片 MIME', () => {
  let threw = false
  try {
    setImageAvatar('data:text/plain;base64,aGk=')
  } catch (err) {
    threw = true
    assert(/不支持的图片格式/.test(err.message), `错误信息不清楚：${err.message}`)
  }
  assert(threw, '应该抛错但没有')
  return '已拒绝'
})

check('图片头像：拒绝缺少 data URL 前缀的输入', () => {
  let threw = false
  try {
    setImageAvatar('iVBORw0KGgo=')
  } catch (err) {
    threw = true
  }
  assert(threw, '应该抛错但没有')
  return '已拒绝'
})

check('图片头像：拒绝超大图片', () => {
  // 构造刚好超过上限的 base64
  const tooBig = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1024) * 4 / 3))}`
  let threw = false
  try {
    setImageAvatar(tooBig)
  } catch (err) {
    threw = true
    assert(/太大/.test(err.message), `错误信息不清楚：${err.message}`)
  }
  assert(threw, '应该抛错但没有')
  return `上限 ${Math.round(MAX_IMAGE_BYTES / 1024)} KB`
})

check('图片头像：刚好在上限内可以接受', () => {
  // 让解码后的字节数略小于上限
  const targetBytes = MAX_IMAGE_BYTES - 1024
  const base64Len = Math.floor((targetBytes * 4) / 3)
  const dataUrl = `data:image/webp;base64,${'A'.repeat(base64Len)}`
  const result = setImageAvatar(dataUrl)
  assert(result.bytes <= MAX_IMAGE_BYTES, `字节数超了：${result.bytes}`)
  return `${Math.round(result.bytes / 1024)} KB`
})

check('读取：文件损坏时返回默认而不是崩溃', () => {
  const file = path.join(PATHS.data, 'avatar.json')
  const backup = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  const avatar = readAvatar()
  fs.writeFileSync(file, backup, 'utf8')
  assert(avatar.kind === 'none', `应回退到 none，实际 ${avatar.kind}`)
  return '已回退'
})

check('还原原始头像', () => {
  if (original.kind === 'image') setImageAvatar(original.value)
  else if (original.kind === 'text') setTextAvatar(original.value)
  else clearAvatar()
  const now = readAvatar()
  assert(now.kind === original.kind, `还原失败：${now.kind} != ${original.kind}`)
  return `kind=${now.kind}`
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
