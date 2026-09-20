/** 前端接线自检：确认滚动修复涉及的元素、样式、函数都在 */
import fs from 'node:fs'

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')

const checks = [
  ['HTML 里有 jump-latest 按钮', html.includes('id="jump-latest"')],
  ['CSS 里有 .jump 规则', /\.jump\s*\{/.test(css)],
  ['CSS 里 .jump 跟随键盘高度', /--kb/.test(css.slice(css.indexOf('.jump'), css.indexOf('.jump') + 400))],
  ['JS 里有 Scrolling 状态对象', /const Scrolling = \{/.test(js)],
  ['scrollToBottom 做了二次/三次顶底', (js.match(/requestAnimationFrame/g) ?? []).length >= 2],
  ['isNearBottom 用 visualViewport 高度', /vv \? vv\.height : box\.clientHeight/.test(js)],
  ['绑定了滚动跟踪', /bindScrollTracking\(\)/.test(js)],
  ['监听 scroll 时忽略程序化滚动', /Date\.now\(\) < Scrolling\.until/.test(js)],
  ['发消息后强制落底', /renderMessages\(\{ force: true \}\)/.test(js)],
  ['翻历史时显示跳转按钮', /showJump\(\)/.test(js)],
  ['首次加载强制落底', /renderAll\(\{ force: true \}\)/.test(js)],
]

// 头像相关
const avatarChecks = [
  ['HTML 有头像面板', html.includes('id="avatar-sheet"')],
  ['HTML 有 emoji 行容器', html.includes('id="emoji-row"')],
  ['HTML 有文件选择框', html.includes('id="avatar-file"')],
  ['HTML 有头像预览', html.includes('id="avatar-preview"')],
  ['CSS 有 .avatar-preview 样式', /\.avatar-preview\s*\{/.test(css)],
  ['CSS 有 .emoji-choice 样式', /\.emoji-choice\s*\{/.test(css)],
  ['JS 能渲染图片头像', /backgroundImage = `url/.test(js)],
  ['JS 有客户端压缩', /async function compressImage/.test(js)],
  ['点头像能打开面板', /\$\('avatar'\)\.addEventListener\('click', openAvatarSheet\)/.test(js)],
  ['保存走 /api/avatar', /api\('\/api\/avatar'/.test(js)],
]

// 发图片相关
const imageChecks = [
  ['HTML 有附件按钮', html.includes('id="attach"')],
  ['HTML 有预览容器', html.includes('id="composer-previews"')],
  ['按钮外面有定位容器', /class="attach-wrap"[\s\S]{0,300}id="attach"/.test(html)],
  ['不再有固定的 file input', !html.includes('id="image-file"')],
  ['CSS 有 .attach-wrap', /\.attach-wrap\s*\{/.test(css)],
  ['CSS 有 .attach-btn', /\.attach-btn\s*\{/.test(css)],
  ['CSS 有 .file-overlay', /\.file-overlay\s*\{/.test(css)],
  ['file-overlay 不是 display:none（iOS 关键）', !/\.file-overlay\s*\{[^}]*display:\s*none/.test(css)],
  ['CSS 有 .preview-item', /\.preview-item\s*\{/.test(css)],
  ['CSS 预览用 img 元素', /\.preview-item\s+img\s*\{/.test(css)],
  ['CSS 有预览删除键', /\.preview-remove\s*\{/.test(css)],
  ['CSS 有图片气泡样式', /\.bubble-images\s*\{/.test(css)],
  ['JS 每次点击新建选择框', /function createFilePicker/.test(js)],
  ['新建的选择框不用 multiple（iOS 关键）', !/input\.multiple/.test(js)],
  ['选择框挂进 attach-wrap', /closest\('\.attach-wrap'\)/.test(js)],
  ['JS 有待发图片状态', /const Pending = \{/.test(js)],
  ['JS 会在客户端压缩图片', /async function prepareImage/.test(js)],
  ['JS 限制长边尺寸', /CHAT_IMAGE_MAX_EDGE/.test(js)],
  ['压缩失败会退回原图', /return original/.test(js)],
  ['JS 气泡渲染图片', /bubble-images/.test(js)],
  ['JS 图片走单独接口取', /\/api\/image\?id=/.test(js)],
  ['JS 发送时带上图片', /images\.length \? \{ text, images \}/.test(js)],
  ['JS 失败时还原输入内容', /input\.value = text/.test(js)],
  ['JS 失败时还原待发图片', /Pending\.images = images/.test(js)],
  ['JS 支持拖拽发图', /dragover/.test(js) && /drop/.test(js)],
  ['JS 限制最多 4 张', /最多一次发 4 张/.test(js)],
  ['图片出错会回报服务端', /sendClientDiag/.test(js)],
  ['界面上显示构建版本', /build-line/.test(css) && /id="build"/.test(html)],
]

// 手机端布局
//
// 这里曾经有 13 项"新布局"检查（text-size-adjust、translateY 抬键盘、
// kb-lift、safe-bottom-eff 等）。实测那套改动在 iPhone 上反而更糟
// （键盘弹起时输入框被顶到屏幕顶部），用户要求回退，所以检查也一并去掉。
//
// 只保留两条与布局无关、纯功能性的检查。
const layoutChecks = [
  ['版本行存在', html.includes('id="build"') && css.includes('.build-line')],
  ['小屏也能显示版本行', /\.build-line[\s\S]{0,120}font-size/.test(css)],
]

// 动画流畅度相关
const animationChecks = [
  ['JS 有逐字动画状态', /const Typing = \{/.test(js)],
  ['按实测流速自适应（不是固定速度）', /msPerChar/.test(js) && !/TYPING_CHARS_PER_SEC/.test(js)],
  ['追平阈值随进度自适应', /TYPING_CATCH_UP_MIN_MS/.test(js) && /TYPING_CATCH_UP_MAX_MS/.test(js)],
  ['同一帧内滚动只执行一次', /Scrolling\.frame\) return/.test(js)],
  ['增量不再直接写 DOM', !/typingBubble\.textContent = streamed/.test(js)],
  ['完成后立即显示全文', /typewriterFlush\(\)/.test(js)],
  ['出错/结束时清理动画帧', /typewriterReset\(null, null\)/.test(js)],
  ['流速采样要攒够样本', /observedChars >= 12/.test(js)],
  ['旧气泡不重播入场动画', /animateFromSeq/.test(js) && /no-anim/.test(js)],
  ['CSS 有 .no-anim', /\.no-anim\s*\{/.test(css)],
  ['SSE 新消息带上旧游标', /const previousLastSeq = S\.lastSeq/.test(js)],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log('\n头像')
for (const [name, ok] of avatarChecks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log('\n发图片')
for (const [name, ok] of imageChecks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log('\n手机端布局')
for (const [name, ok] of layoutChecks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log('\n发送动画')
for (const [name, ok] of animationChecks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

// 额外：确认没有遗留的旧调用
const legacy = [
  ['showJumpHint 已移除', !js.includes('showJumpHint')],
  ['wasAtBottom 已移除', !js.includes('wasAtBottom')],
]
console.log('')
for (const [name, ok] of legacy) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}\n`)
process.exit(failed === 0 ? 0 : 1)
