/** 前端接线自检：确认滚动修复涉及的元素、样式、函数都在 */
import './_bootstrap.js' // 必须排第一：隔离数据目录，防止污染真实 data/

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

// 她的变化（会变的自我）
//
// 这个面板存在的意义就是"她改自己时你看得见"。少一个入口，
// 这个功能就从"可控的成长"变成"你查不出原因的性格漂移"。
const selfChecks = [
  ['HTML 有「她的变化」标签', /data-tab="self"/.test(html)],
  ['JS 有 self 分支的渲染', /tab === 'self'/.test(js)],
  ['JS 能编辑 self.md', /textArea\('self'/.test(js)],
  ['JS 有变更流水列表', /change-list/.test(js)],
  ['JS 展示新增行', /change-line add/.test(js)],
  ['JS 展示删掉的行', /change-line del/.test(js)],
  ['JS 单独拉 /api/self', /api\('\/api\/self'\)/.test(js)],
  ['JS 拉变更流水', /api\/self\/changes/.test(js)],
  ['JS 有"立刻让她想一次"按钮', /btn-self-evolve/.test(js)],
  ['JS 有"退回上一版"按钮', /btn-self-restore/.test(js)],
  ['保存走 PUT /api/self', /api\('\/api\/self', \{ method: 'PUT'/.test(js)],
  ['打开面板时自动加载', /void loadSelf\(\)/.test(js)],
  ['CSS 有 .change-list', /\.change-list\s*\{/.test(css)],
  ['CSS 有增删两色', /\.change-line\.add\s*\{/.test(css) && /\.change-line\.del\s*\{/.test(css)],
  ['关闭成长时界面会提示', /成长功能已关闭/.test(js)],
]

// 表情包
const stickerChecks = [
  ['HTML 有「表情包」标签', /data-tab="sticker"/.test(html)],
  ['JS 有 sticker 分支的渲染', /tab === 'sticker'/.test(js)],
  ['JS 单独拉 /api/stickers', /api\('\/api\/stickers'\)/.test(js)],
  ['JS 能上传', /api\('\/api\/stickers', \{ method: 'POST'/.test(js)],
  ['JS 能改描述和启停', /api\('\/api\/stickers', \{ method: 'PUT'/.test(js)],
  ['JS 能删除', /api\/stickers\?id=/.test(js)],
  ['JS 能重新扫描文件夹', /api\/stickers\/sync/.test(js)],
  ['上传用 multiple（一次能选多张）', /upload\.multiple = true/.test(js)],
  ['表情包有独立的压缩函数', /async function compressSticker/.test(js)],
  ['压缩上限与服务端一致', /STICKER_MAX_BYTES = 2 \* 1024 \* 1024/.test(js)],
  ['表情包气泡单独标记', /has-sticker/.test(js)],
  ['占位文字不会显示出来', /'（发表情）'/.test(js)],
  ['CSS 有 .has-sticker', /\.bubble\.has-sticker\s*\{/.test(css)],
  ['CSS 表情包比普通图小', /\.has-sticker[\s\S]{0,200}max-height/.test(css)],
  ['CSS 有 .sticker-row', /\.sticker-row\s*\{/.test(css)],
  ['描述编辑用事件委托（重建后不失效）', /dataset\?\.stickerDesc/.test(js)],
]

// 顶部状态栏
//
// 这行字决定用户怎么理解"她没回消息"。少一个环节就会退化成永远显示"在线"——
// 那正好把"她会去忙、会困"这两个功能在界面上的效果全部抵消。
const statusChecks = [
  ['JS 从服务端拿 state', /S\.state = data\.state/.test(js)],
  ['SSE 推送里带 state', /if \(snap\.state\)/.test(js)],
  ['连接断开时优先报断开', /S\.esDown[\s\S]{0,80}连接断开/.test(js)],
  ['onopen 不再写死"在线"', !/es\.onopen = \(\) => \{\s*setStatus\('在线'/.test(js)],
  ['setStatus 支持状态样式', /function setStatus\(text, live, stateKey\)/.test(js)],
  ['data-state 每次重置（防旧样式残留）', /delete el\.dataset\.state/.test(js)],
  ['状态会定时自己刷新（时间会流逝）', /function startStateRefresh/.test(js)],
  ['启动时开启状态刷新', /startStateRefresh\(\)/.test(js)],
  ['CSS 有 typing 状态样式', /\[data-state='typing'\]/.test(css)],
  ['CSS 有 asleep 状态样式', /\[data-state='asleep'\]/.test(css)],
  ['状态栏会截断而不是撑破顶栏', /\.status[\s\S]{0,240}text-overflow: ellipsis/.test(css)],
]

// 她的日子（时间线）
const daysChecks = [
  ['HTML 有「她的日子」标签', /data-tab="days"/.test(html)],
  ['JS 有 days 分支的渲染', /tab === 'days'/.test(js)],
  ['JS 单独拉 /api/life/days', /api\('\/api\/life\/days/.test(js)],
  ['JS 能手动补摘要', /api\/life\/days\/catchup/.test(js)],
  ['日期带星期（看得出那天是不是周末）', /function fmtDay/.test(js) && /周日/.test(js)],
  ['兜底写的会标出来', /by === 'fallback'/.test(js)],
  ['CSS 有 .day-list', /\.day-list\s*\{/.test(css)],
  ['CSS 有 .day-row', /\.day-row\s*\{/.test(css)],
  ['CSS 时间轴有小圆点', /\.day-row::before/.test(css)],
  ['CSS 有 .day-date / .day-text', /\.day-date\s*\{/.test(css) && /\.day-text\s*\{/.test(css)],
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

console.log('\n她的变化')
for (const [name, ok] of selfChecks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log('\n表情包')
for (const [name, ok] of stickerChecks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log('\n顶栏状态')
for (const [name, ok] of statusChecks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
  if (!ok) failed++
}

console.log('\n她的日子')
for (const [name, ok] of daysChecks) {
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
