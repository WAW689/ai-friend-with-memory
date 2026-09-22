/**
 * 补一段过去的生活流水。
 *
 * 刚上线时流水是空的，它会显得"今天才出生"——
 * 第一次主动找你说话时，它没有任何可引用的真实经历。
 *
 * 这个脚本按 life.md 的设定，倒推着编一段合理的过去，
 * 时间戳分布在过去几天里，符合作息（凌晨三四点睡、中午起）。
 *
 * 用法：
 *   node src/backfill-life.js            补 3 天
 *   node src/backfill-life.js 5          补 5 天
 *   node src/backfill-life.js 3 --dry    只生成不写盘，先看看质量
 */
import fs from 'node:fs'
import { loadConfig } from './config.js'
import { complete } from './llm.js'
import { recordActivity, readArcs, readJournal, readLife, writeArcs, JOURNAL_FILE } from './life.js'
import { log, now } from './util.js'

const args = process.argv.slice(2)
const days = Number(args.find((a) => /^\d+$/.test(a))) || 3
const dry = args.includes('--dry')

const cfg = loadConfig()
const life = readLife()

if (!life.trim()) {
  console.error('还没有生活设定（data/life.md）。先建好它再补流水。')
  process.exit(1)
}

const existing = readJournal()
if (existing.length > 0 && !args.includes('--force')) {
  console.error(`流水里已经有 ${existing.length} 条了。`)
  console.error('补过去会插在现有记录前面，可能造成时间错乱。')
  console.error('确实要补就加 --force（会先备份现有流水）。')
  process.exit(1)
}

/* ------------------------------------------------------------ 生成 */

/** 把作息要求说清楚，让生成的时间点合理 */
function sleepScheduleNote() {
  return `她的作息：凌晨三四点睡，中午前后起。所以：
- 上午 10 点前基本在睡，不该有"清早去买菜"这种事
- 活动集中在下午、晚上、深夜
- 深夜（24:00-03:00）是她在家的时间，容易有"睡不着""刷手机""猫在闹"这类`
}

const prompt = `你在为一个虚构角色补写她**过去 ${days} 天**的日常生活。

【她是谁】
${life}

${sleepScheduleNote()}

【要写什么】
- 写 ${days * 3} 到 ${days * 4} 件事，分布在过去 ${days} 天里
- 每件事都是**平淡的日常**：做饭、收拾屋子、出门买东西、取快递、
  猫闯祸、看手机看到几点、天气、小烦小乐、突然想到什么
- **不要写重大事件**：不生病、不出事、不跟人吵架、家里不变态。
  她是个普通人，过普通日子。
- 每件事 8-25 个字，口语，像随手记的一句
- 不要提到那个网友（对方）。这是她自己的日子

【输出格式】
只输出 JSON，不要其他文字：
{"activities": [{"day": 0, "hour": 14, "text": "..."}, ...]}

day：0 = 今天，1 = 昨天，2 = 前天，以此类推（最大 ${days - 1}）
hour：0-23，必须符合作息（见上）

只输出 JSON。`

console.log('')
console.log(`  按设定补过去 ${days} 天的生活…`)
console.log('')

let activities = []
try {
  const text = await complete(cfg, [
    { role: 'system', content: prompt },
    { role: 'user', content: '开始。' },
  ], { maxTokens: 1600, temperature: 1.3 })

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const parsed = JSON.parse(text.slice(start, end + 1))
  activities = Array.isArray(parsed.activities) ? parsed.activities : []
} catch (err) {
  console.error(`  生成失败：${err.message}`)
  process.exit(1)
}

/* ------------------------------------------------------------ 校验与排序 */

const anchored = activities
  .map((a) => {
    let day = Number(a.day)
    const hour = Number(a.hour)
    const text = String(a.text ?? '').trim()
    if (!Number.isFinite(day) || !Number.isFinite(hour) || !text) return null
    if (day < 0 || day > days - 1 || hour < 0 || hour > 23) return null
    if (text.length < 6 || text.length > 60) return null

    /*
     * 凌晨（0-4 点）的事属于"前一天那个晚上"。
     *
     * 不这样处理的话会时间错乱：模型说"前天 2 点"和"前天 14 点"，
     * 排序后 2 点排在 14 点前面，读起来像是先过下午再过凌晨——
     * 明显不对。把凌晨归到前一天，顺序就正常了。
     */
    if (hour < 5) day += 1

    const d = new Date()
    d.setDate(d.getDate() - day)
    d.setHours(hour, Math.floor(Math.random() * 60), 0, 0)
    // 不能是未来
    if (d.getTime() > now()) d.setDate(d.getDate() - 1)
    return { at: d.getTime(), text }
  })
  .filter(Boolean)
  .sort((a, b) => a.at - b.at)

if (anchored.length === 0) {
  console.error('  模型没有产出可用的内容。')
  process.exit(1)
}

console.log(`  生成了 ${anchored.length} 件事：`)
console.log('')
for (const a of anchored) {
  const d = new Date(a.at)
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  // 用绝对日期（9/19），不用"昨天/今天"——凌晨的事归到前一天之后，
  // 相对说法反而容易让人看错顺序
  console.log(`    ${d.getMonth() + 1}/${d.getDate()} ${t}  ${a.text}`)
}
console.log('')

/* ------------------------------------------------------------ 线索 */

console.log('  正在生成"推进中的几件事"…')
console.log('')

let arcs = []
try {
  const arcText = await complete(cfg, [
    {
      role: 'system',
      content: `从下面这个人最近的日常里，抽出 2 条她**这些天一直在持续的状态**。

【她是谁】
${life}

【她最近做过的事（这些是"某一天做了什么"）】
${anchored.map((a) => '- ' + a.text).join('\n')}

【关键区分】
上面列的是**单次动作**。你要写的是**持续状态**。两者完全不同：
- 单次动作（不要写）："称了一下体重"、"煮了碗面"、"拿了个快递"
- 持续状态（要写）："这个月接的活老被拖尾款"、"想换房子但一直没动"、"作息越来越乱"

判断方法：如果一件事**五分钟就做完了**，那是单次动作，不是状态。
状态应该是那种"持续好几天、还没解决、偶尔会想起来"的事。

【要求】
- 正好 2 条
- 每条 10-25 字，口语
- 不要戏剧性的事（看病、吵架、家里变故）
- 不要提到那个网友

只输出 JSON：{"arcs": ["第一条", "第二条"]}`,
    },
    { role: 'user', content: '开始。' },
  ], { maxTokens: 400, temperature: 1.2 })

  const s = arcText.indexOf('{')
  const e = arcText.lastIndexOf('}')
  const parsed = JSON.parse(arcText.slice(s, e + 1))
  arcs = (Array.isArray(parsed.arcs) ? parsed.arcs : [])
    .map((t) => ({ text: String(t ?? '').trim() }))
    .filter((a) => a.text.length >= 6)
    .slice(0, 3)
} catch (err) {
  console.log(`  （线索生成失败，跳过：${err.message}）`)
}

for (const a of arcs) console.log(`    · ${a.text}`)
console.log('')

/* ------------------------------------------------------------ 写盘 */

if (dry) {
  console.log('  --dry 模式，没有写盘。去掉 --dry 才会真正保存。')
  console.log('')
  process.exit(0)
}

// 有旧流水的话先备份（--force 的情况）
if (existing.length > 0) {
  const backup = `${JOURNAL_FILE}.before-backfill`
  fs.copyFileSync(JOURNAL_FILE, backup)
  log.info(`旧流水已备份到 ${backup}`)
}

// 补的过去要插在现有记录之前：把旧记录读出来，重写成"新的在前"
const merged = [...anchored, ...existing].sort((a, b) => a.at - b.at)
fs.writeFileSync(JOURNAL_FILE, merged.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')

if (arcs.length) writeArcs(arcs)

console.log(`  ✓ 已写入 ${anchored.length} 条流水（共 ${merged.length} 条）`)
if (arcs.length) console.log(`  ✓ 已写入 ${arcs.length} 条线索`)
console.log('')
console.log('  跑 node src/cli.js life 可以查看。')
console.log('')
