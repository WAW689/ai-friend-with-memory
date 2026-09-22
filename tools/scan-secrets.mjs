/**
 * 发布前扫一遍：git 追踪的文件里有没有不该公开的东西。
 *
 * 为什么不硬编码真实密钥：**那样等于把密钥写进仓库**。
 * （这工具的第一版就是这么干的，差点把 Bark Key 和访问口令提交上去。）
 * 只按"形态"匹配，具体值从来不写进来。
 *
 * 用法（本沙箱不能 spawn 子进程，所以列表由 shell 传进来）：
 *   git ls-files > tools/_tracked.txt
 *   node tools/scan-secrets.mjs tools/_tracked.txt
 */
import fs from 'node:fs'

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

const listFile = process.argv[2] ?? 'tools/_tracked.txt'
const tracked = fs
  .readFileSync(listFile, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

console.log('扫描 ' + tracked.length + ' 个 git 追踪文件')
console.log('')

let hits = 0
for (const f of tracked) {
  let text
  try {
    text = fs.readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  for (const p of PATTERNS) {
    lines.forEach((l, i) => {
      if (p.re.test(l)) {
        // 只报位置和类型，**不回显命中的内容**——那本身就是敏感信息
        console.log(`  ! ${f}:${i + 1}  命中「${p.name}」`)
        hits++
      }
    })
  }
}

console.log('')
if (hits === 0) {
  console.log('没有发现敏感内容 —— 可以安全发布')
} else {
  console.log('发现 ' + hits + ' 处，发布前必须处理')
  process.exitCode = 1
}
