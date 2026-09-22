/**
 * 发布前扫一遍：git 追踪的文件里有没有不该公开的东西。
 *
 * 两道关，各管一半：
 *
 *   ① 形态匹配 —— 认出 sk- 密钥、Bark URL、手机号、内网地址这类**长相**可疑的东西。
 *      好处是什么都不用告诉我就能跑；坏处是认不出"长得正常"的密钥。
 *
 *   ② 真值比对 —— 从本地的 config.json 里取出你**实际在用的**口令和密钥，
 *      去追踪文件里找它们。config.json 本身不进仓库，所以这一步不泄露任何东西。
 *      这是唯一能真正回答"我的东西到底有没有被提交上去"的检查。
 *
 * 为什么不硬编码真实密钥：**那样等于把密钥写进仓库**。
 * （这工具的第一版就是这么干的，差点把 Bark Key 和访问口令提交上去。）
 *
 * 误报怎么处理：文档里的示例地址（RFC 6598 的 100.64.1.2）和占位口令
 * （token=abc）本来就没有信息量，它们列在 PLACEHOLDER_LINE 里明确放行。
 * 放行是**按行**判断的：那行只要还夹带了别的东西，照样会被抓到。
 *
 * 用法（本沙箱不能 spawn 子进程，所以列表由 shell 传进来）：
 *   git ls-files > tools/_tracked.txt
 *   node tools/scan-secrets.mjs tools/_tracked.txt
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PATTERNS = [
  // DeepSeek / OpenAI 风格的 key
  { name: 'API Key（sk- 开头）', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  // Bark：形如 https://api.day.app/<22 位以上的 key>
  { name: 'Bark Key（URL 形态）', re: /api\.day\.app\/[A-Za-z0-9]{16,}/ },
  // 通用：赋值给 key/token/secret 的长随机串
  {
    name: '疑似硬编码密钥赋值',
    re: /(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['"][A-Za-z0-9_-]{20,}['"]/i,
  },
  // 本机/内网地址
  { name: 'Tailscale IP（100.64/10）', re: /\b100\.(?:6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { name: '私有网段 IP', re: /\b(?:192\.168|10\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/ },
  // 中文手机号
  { name: '手机号', re: /\b1[3-9]\d{9}\b/ },
]

/** 这些行是在讲"怎么用"，不是在记"你的配置"。见文件头说明。 */
const PLACEHOLDER_LINE = [
  // RFC 6598 文档示例地址：Tailscale 教程里到处在用，不是任何人的真实地址
  /\b100\.64\.1\.2\b/,
  // 命令行示例里的占位口令
  /[?&]token=(?:abc|xxx+|your[-_]?token)\b/i,
  // 自己声明是假数据的行。测试夹具要用假地址就写明它，
  // 既是给工具看的，也是给以后读代码的人看的。
  /(NOT[-_]?REAL|FAKE|DUMMY|EXAMPLE[-_]|示例|占位)/i,
]

const isPlaceholder = (line) => PLACEHOLDER_LINE.some((re) => re.test(line))

/**
 * 工具自己不算。
 *
 * 它必须在注释里举例说明"什么样的地址算本机地址"，
 * 那些例子会被自己的规则命中——这就是自指。跳过它，
 * 而不是把注释写模糊：说不清楚的工具等于没有。
 */
const SKIP_FILES = new Set(['tools/scan-secrets.mjs'])

/**
 * 从本地 config.json 里取真实值。
 *
 * 长度门槛 8：太短的值（比如空口令、"1"）满仓库都是，比对只会制造噪音。
 */
function realValues() {
  const out = []
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  } catch {
    return out // 没有 config.json（别人的机器上跑）就跳过这一关
  }
  const add = (value, label) => {
    const s = String(value ?? '').trim()
    if (s.length >= 8) out.push({ label, value: s })
  }
  add(cfg.accessToken, '访问口令')
  add(cfg.bark?.key, 'Bark Key')
  add(cfg.model?.apiKey, 'DeepSeek API Key')
  return out
}

/**
 * 本机现在的地址。
 *
 * 形态匹配认不出"这个 IP 到底是不是我的"——这一条能：
 * 举例用的 100.101.102.103 和真实的 100.x.y.z 长得一模一样，
 * 但只有后者会出现在这张表里。所以"自己人"是比出来的，不是猜出来的。
 */
function localIps() {
  const out = []
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni?.address && !ni.internal) out.push({ label: `本机地址 ${ni.address}`, value: ni.address })
      }
    }
  } catch {
    /* 拿不到就算了，形态匹配还在 */
  }
  return out
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const listFile = process.argv[2] ?? path.join(ROOT, 'tools', '_tracked.txt')
const tracked = fs
  .readFileSync(listFile, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

const secrets = [...realValues(), ...localIps()]

console.log('扫描 ' + tracked.length + ' 个 git 追踪文件')
console.log(
  secrets.length > 0
    ? `真值比对：${secrets.length} 项（${secrets.map((s) => s.label).join('、')}）`
    : '真值比对：没读到 config.json，只做形态匹配',
)
console.log('')

let hits = 0
let skipped = 0

for (const f of tracked) {
  if (SKIP_FILES.has(f.replace(/\\/g, '/'))) continue

  let text
  try {
    text = fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')

  lines.forEach((l, i) => {
    const where = `  ! ${f}:${i + 1}`

    // ① 形态匹配
    for (const p of PATTERNS) {
      if (!p.re.test(l)) continue
      if (isPlaceholder(l)) {
        skipped++
        continue
      }
      // 只报位置和类型，**不回显命中的内容**——那本身就是敏感信息
      console.log(`${where}  命中「${p.name}」`)
      hits++
    }

    // ② 真值比对：这条不看长相，只看"是不是我自己的东西"
    for (const s of secrets) {
      if (l.includes(s.value)) {
        console.log(`${where}  命中「本机配置里的${s.label}」`)
        hits++
      }
    }
  })
}

console.log('')
if (skipped > 0) {
  console.log(`（放行了 ${skipped} 处文档示例，它们不含真实信息）`)
  console.log('')
}
if (hits === 0) {
  console.log('没有发现敏感内容 —— 可以安全发布')
} else {
  console.log('发现 ' + hits + ' 处，发布前必须处理')
  process.exitCode = 1
}
