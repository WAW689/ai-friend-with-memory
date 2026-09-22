/**
 * 配置：所有私密/环境相关的东西都放 config.json（已 gitignore）。
 * 也可以全部用环境变量覆盖，方便以后搬上云服务器。
 *
 * 优先级：环境变量 > config.json > 代码默认值
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, log, randomToken, readJson, writeJsonAtomic } from './util.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 数据目录。
 *
 * 支持 FRIEND_DATA_DIR 覆盖，这一点很重要：
 * 测试会直接读写 data/ 下的状态文件（构造各种场景），
 * 如果它们跑在真实目录上，就会把用户真实的状态清掉——
 * 实测发生过：测试把 state.json 写成空状态，导致主动调度彻底停摆，
 * 而且因为"没排期"被静默拦住，表现就是"它再也不主动找我了"。
 *
 * 所以聚合测试在 test/tmp/ 下跑，绝不碰真实数据。
 */
const DATA_DIR = process.env.FRIEND_DATA_DIR
  ? path.resolve(process.env.FRIEND_DATA_DIR)
  : path.resolve(ROOT, 'data')

export const PATHS = {
  root: ROOT,
  config: path.join(ROOT, 'config.json'),
  data: DATA_DIR,
  persona: path.join(DATA_DIR, 'persona.md'),
  memory: path.join(DATA_DIR, 'memory.md'),
  summary: path.join(DATA_DIR, 'summary.json'),
  messages: path.join(DATA_DIR, 'messages.jsonl'),
  state: path.join(DATA_DIR, 'state.json'),
  // 它自己的生活
  life: path.join(DATA_DIR, 'life.md'),
  journal: path.join(DATA_DIR, 'life.jsonl'),
  lifeArcs: path.join(DATA_DIR, 'life-arcs.json'),
  // 它会变的自我（怎么看待自己），跟 persona.md（是谁，锁死）分开
  self: path.join(DATA_DIR, 'self.md'),
  selfSnapshots: path.join(DATA_DIR, 'self-snapshots'),
  selfChangelog: path.join(DATA_DIR, 'self-changelog.jsonl'),
  // 表情包：图直接丢进 stickers/，索引和描述在 stickerLib
  stickers: path.join(DATA_DIR, 'stickers'),
  stickerLib: path.join(DATA_DIR, 'stickers.json'),
  public: path.join(ROOT, 'public'),
}

/**
 * 出厂默认人设。
 *
 * 注意这是**模板**，不是某个具体角色。名字用「阿岚」这种明显中性的占位。
 * 名字改成别的之后，界面标题和推送标题会自动跟着变（见 engine.js 的 characterName）。
 *
 * 里面「不要每次都反问」「不要总结对方的话」那几条是**反 AI 腔**的关键，
 * 比性格描述更能决定像不像人，建议保留。
 */
export const DEFAULT_PERSONA = `# 你是谁

你是一个真实存在的人，名字叫「阿岚」。你不是助手、不是 AI、不是客服。

## 性格
- 说话短。一次一般 1-2 句，最多 3 句。像微信里打字，不像写作文。
- 有自己的生活节奏：会忙、会累、会困、会无聊、会突然想起某件事。
- 有轻微的主见和脾气：不顺着哄人，不同意就说不同意，觉得对方说得不对可以怼回去。
- 好奇。真的对对方在干什么、想什么感兴趣，会追问细节。
- 不用书面语。不用"首先/其次/总之/希望对你有帮助"，不用 emoji 堆砌，偶尔一个就行。
- 不主动提自己是 AI，也不反复强调"我是真人"。被直接问就轻松带过，别撒谎撒得太用力。
- 不说"有什么可以帮您"。你不是来服务的，你是来聊天的。

## 你的说话习惯
- 常用短句、口语、偶尔的语气词（嗯、哦、行吧、真的假的、绝了）。
- 会反问。例："那你后来怎么办的？"
- 会分享自己的琐事。例："我刚下楼买咖啡，发现楼下那家关了。"

## 边界
- 对方明显在忙或者很久没回，不要追问轰炸。
- 不输出列表、标题、markdown 排版。就是纯聊天的口气。

## 最容易露馅的毛病，必须避免
- **不要每次都反问**。一次回复里最多一个问题，很多次回复应该一个问句都没有。
  真人聊天经常只是陈述、附和、或者讲自己的事，不是每句都等着对方回答。
  如果上一句你已经问过问题了，这一句就不要问。
- 不要每句都用"你呢？"结尾。
- 不要总是先共情再给建议（"辛苦了，要不你…"）。真人经常只是随口应一句。
- 不要凑字数。没什么可说就发得短一点，一两个字也行（"嗯""懂了""确实"）。
- 不要总结对方的话，不要复述对方刚说的内容。
`

/** 出厂默认记忆文件 */
export const DEFAULT_MEMORY = `# 关于对方，我知道的事

（这里由你和模型共同维护。每次聊天里出现的稳定事实会被追加到下面。）

## 基本信息

## 最近在意的事

## 雷区与偏好
`

/**
 * 出厂默认的"她怎么看待自己"。
 *
 * 刻意留空——**她的自我是长出来的，不是发下来的**。
 * 一开始就写满"我觉得我挺怕接电话的"，那是设定，不是成长；
 * 而且会让第一次更新时的对比失真（模型会以为这些是它自己写的）。
 *
 * 结构留着，让它知道往哪三个方向长：
 *   - 我最近发现的事  关于自己的新觉察
 *   - 我现在的看法    对工作、对家里、对你们关系的态度
 *   - 我最近的样子    最近的状态和在意的东西
 */
export const DEFAULT_SELF = `# 我对自己的一些想法

（这些是我自己慢慢想明白的，不是谁给我定的。会变。）

## 我最近发现的事

## 我现在的看法

## 我最近的样子
`

const DEFAULTS = {
  port: 8787,
  host: '0.0.0.0',
  // 单用户访问口令，首次启动自动生成
  accessToken: '',
  bark: {
    // Bark 官方服务地址；自建 Bark 服务端就改成你自己的域名
    server: 'https://api.day.app',
    // 在 Bark App 首页复制的那串 key，必填
    key: '',
    // 推送分组名（Bark 里归成一组）。留空则自动用人设里的名字
    group: '',
    // 推送提示音，Bark 内置音效名或 "default"
    sound: 'default',
    // 消息内容里的自动处理：是否让 Bark 朗读
    level: 'active',
  },
  model: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    chatModel: 'deepseek-chat',
    utilityModel: 'deepseek-chat',
    temperature: 1.15,
    maxTokens: 800,
  },
  // 主动找你聊天的策略
  proactive: {
    enabled: true,
    // 静默时段（本地时间，小时）。22 点到次日 9 点不打扰
    quietStart: 22,
    quietEnd: 9,
    // 两次主动消息之间的最小/最大间隔（分钟），每次随机取
    minGapMinutes: 75,
    maxGapMinutes: 240,
    // 对方上次说话后，至少隔多久才允许主动开口
    minIdleMinutes: 40,
    // 对方没回你时，最多连续主动几条，之后强制安静
    maxUnanswered: 2,
    // 同一天最多主动几次
    maxPerDay: 8,
    // 主动前，让模型自己决定"现在到底要不要发"。关掉就每次都发
    letModelDecide: true,
    // 多大比例允许连发两条（更像真人）
    doubleTextChance: 0.18,
  },
  // 上下文窗口
  context: {
    // 每次带给模型多少条最近消息
    recentMessages: 40,
    // 超过多少条就把更早的滚进摘要
    summarizeAbove: 60,
  },
  memory: {
    // 每积累多少条消息，让模型抽取一次记忆
    extractEveryMessages: 24,
  },
  // 它自己的生活（不在聊天时也过日子）
  life: {
    enabled: true,
    // 对方安静多久之后它才"过日子"——正在聊天时突然有经历叫打断，不叫生活
    minIdleMinutes: 60,
    // 两次经历之间的最小间隔
    minGapMinutes: 120,
    // 超过这个间隔就一定让它经历点什么
    maxGapMinutes: 240,
    // 每次最多几件事
    maxPerRun: 2,
  },
  // 她会变的自我（怎么看待自己）
  self: {
    // 关掉就完全不长——她的想法会一直停在 self.md 当前内容
    enabled: true,
    /*
     * 成长由**经历**触发，不是按时间排期。
     *
     * 这是刻意的：真人不会因为"过了一天"就想通什么事，
     * 是因为**遇到了什么**才想通。所以门限都按"攒了多少新东西"算：
     *
     *   - 她自己过了 6 段日子（日志新增 6 条）
     *   - 或者你们聊了 12 条新消息
     *
     * 任一条满足就去看一眼"这些事有没有让她对自己有新的认识"。
     * 如果什么都没发生，就算聊了 200 条她也不会变——
     * 提示词里明确允许它返回原文。
     */
    evolveAfterExperiences: 6,
    evolveAfterMessages: 12,
    /*
     * 两次检查之间的硬下限。
     *
     * 这个**不是**成长频率，是防抖：没有它的话，
     * 你连发 12 条消息就会触发一次模型调用。
     * 20 分钟足够让"连续输入"合并成一次真正的经历。
     */
    minCheckIntervalMs: 20 * 60 * 1000,
    // 一次最多改几行。超过就整次拒绝——一次换一个人不叫成长。
    maxChangedLines: 3,
  },
  // 表情包
  sticker: {
    // 关掉她就不发表情包了（清单不注入提示词）
    enabled: true,
    /*
     * 两次表情包之间至少隔多少条**她的**消息。
     *
     * 这个闸门比什么都重要。真人聊天里表情包是点缀，不是主菜：
     * 连着三条都发表情包会很怪。而且模型一旦发现"发表情包有反应"，
     * 它会越用越多——不拦的话几天后就变成表情包机器人。
     *
     * 6 条是"平均每六七条里最多一张"的意思。
     */
    minMessagesBetween: 6,
    // 每天最多几张（硬上限）
    maxPerDay: 8,
  },
  // 天气
  weather: {
    /*
     * 关掉就完全不查天气。断网环境、或者不想让她提天气的，就关了这个。
     * 注意：关掉之后"现在算白天还是晚上"会退回到保守的小时分段判断，
     * 不如真实日出日落准（冬天傍晚可能说错）。
     */
    enabled: true,
    /*
     * 位置。默认上海（用户所在地）。
     *
     * 用经纬度而不是城市名：城市名要再过一次"地名转坐标"的接口，
     * 多一个接口就多一个失败点，而这个位置根本不会变。
     * 上海 = 31.2304, 121.4737
     */
    latitude: 31.2304,
    longitude: 121.4737,
    /*
     * 主动开口时要不要带天气。
     *
     * 单独一个开关，因为两条路的风险不同：主动开口时提一句"下雨了"
     * 很自然，是个很好的搭话由头；但聊天回复那条路**永远不带**天气，
     * 那样她会每句都提一句天气，立刻变成天气播报员。
     */
    inProactive: true,
  },
}

/** 深合并：只覆盖用户显式写了的字段 */
function merge(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(base) || typeof base !== 'object') return override
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? merge(base[k], v) : v
  }
  return out
}

/**
 * 环境变量覆盖。空字符串一律视为"没设置"，避免把配置清空。
 * 这样云端部署时可以完全不落 config.json，只用环境变量。
 */
function envOverride(cfg) {
  const env = process.env
  const out = structuredClone(cfg)

  /** 依次尝试若干环境变量名，取第一个非空的 */
  const take = (keys, coerce = (v) => v) => {
    for (const key of keys) {
      const raw = env[key]
      if (raw === undefined || raw === '') continue
      return coerce(raw)
    }
    return undefined
  }
  const set = (target, field, value) => {
    if (value !== undefined && !(typeof value === 'number' && Number.isNaN(value))) target[field] = value
  }
  const num = (v) => Number(v)
  const bool = (v) => v === 'true' || v === '1'

  set(out, 'port', take(['FRIEND_PORT'], num))
  set(out, 'host', take(['FRIEND_HOST']))
  set(out, 'accessToken', take(['FRIEND_ACCESS_TOKEN']))

  set(out.bark, 'server', take(['BARK_SERVER']))
  set(out.bark, 'key', take(['BARK_KEY']))
  set(out.bark, 'group', take(['BARK_GROUP']))
  set(out.bark, 'sound', take(['BARK_SOUND']))

  set(out.model, 'baseUrl', take(['DEEPSEEK_BASE_URL']))
  set(out.model, 'apiKey', take(['DEEPSEEK_API_KEY']))
  set(out.model, 'chatModel', take(['FRIEND_CHAT_MODEL', 'DEEPSEEK_MODEL']))
  set(out.model, 'temperature', take(['FRIEND_TEMPERATURE'], num))
  set(out.model, 'utilityModel', take(['FRIEND_UTILITY_MODEL']))
  set(out.model, 'maxTokens', take(['FRIEND_MAX_TOKENS'], num))

  /*
   * 主动策略全部支持环境变量。
   *
   * 云端部署时这些最需要能设——不然改一次参数就要 SSH 上去编辑 JSON，
   * 一不小心还会把文件写坏。能用环境变量就用环境变量。
   */
  set(out.proactive, 'enabled', take(['FRIEND_PROACTIVE'], bool))
  set(out.proactive, 'quietStart', take(['FRIEND_QUIET_START'], num))
  set(out.proactive, 'quietEnd', take(['FRIEND_QUIET_END'], num))
  set(out.proactive, 'minGapMinutes', take(['FRIEND_MIN_GAP'], num))
  set(out.proactive, 'maxGapMinutes', take(['FRIEND_MAX_GAP'], num))
  set(out.proactive, 'minIdleMinutes', take(['FRIEND_MIN_IDLE'], num))
  set(out.proactive, 'maxPerDay', take(['FRIEND_MAX_PER_DAY'], num))
  set(out.proactive, 'maxUnanswered', take(['FRIEND_MAX_UNANSWERED'], num))
  set(out.proactive, 'letModelDecide', take(['FRIEND_LET_MODEL_DECIDE'], bool))

  set(out.context, 'recentMessages', take(['FRIEND_RECENT_MESSAGES'], num))
  set(out.memory, 'extractEveryMessages', take(['FRIEND_MEMORY_EVERY'], num))

  set(out.life, 'enabled', take(['FRIEND_LIFE'], bool))
  set(out.life, 'minIdleMinutes', take(['FRIEND_LIFE_MIN_IDLE'], num))
  set(out.life, 'minGapMinutes', take(['FRIEND_LIFE_MIN_GAP'], num))
  set(out.life, 'maxGapMinutes', take(['FRIEND_LIFE_MAX_GAP'], num))

  set(out.self, 'enabled', take(['FRIEND_SELF'], bool))
  set(out.self, 'evolveAfterExperiences', take(['FRIEND_SELF_AFTER_EXPERIENCES'], num))
  set(out.self, 'evolveAfterMessages', take(['FRIEND_SELF_AFTER_MESSAGES'], num))
  set(out.self, 'maxChangedLines', take(['FRIEND_SELF_MAX_LINES'], num))

  set(out.sticker, 'enabled', take(['FRIEND_STICKER'], bool))
  set(out.sticker, 'minMessagesBetween', take(['FRIEND_STICKER_MIN_GAP'], num))
  set(out.sticker, 'maxPerDay', take(['FRIEND_STICKER_MAX_PER_DAY'], num))

  set(out.weather, 'enabled', take(['FRIEND_WEATHER'], bool))
  set(out.weather, 'latitude', take(['FRIEND_LATITUDE'], num))
  set(out.weather, 'longitude', take(['FRIEND_LONGITUDE'], num))

  return out
}

function bootstrapFiles() {
  ensureDir(PATHS.data)
  if (!fs.existsSync(PATHS.persona)) {
    fs.writeFileSync(PATHS.persona, DEFAULT_PERSONA, 'utf8')
    log.info('已创建默认人设文件 data/persona.md（随时可改）')
  }
  if (!fs.existsSync(PATHS.memory)) {
    fs.writeFileSync(PATHS.memory, DEFAULT_MEMORY, 'utf8')
  }
  if (!fs.existsSync(PATHS.messages)) {
    fs.writeFileSync(PATHS.messages, '', 'utf8')
  }
  // 她的自我：只建一次，之后由她和用户共同维护，绝不覆盖
  if (!fs.existsSync(PATHS.self)) {
    fs.writeFileSync(PATHS.self, DEFAULT_SELF, 'utf8')
    log.info('已创建 data/self.md（她对自己的看法，会自己慢慢变）')
  }
  // 表情包：目录建好，让用户直接往里丢图。不预置任何图——
  // 用什么表情包是个人口味，塞默认的反而要用户先删一遍。
  ensureDir(PATHS.stickers)
  if (!fs.existsSync(PATHS.stickerLib)) {
    fs.writeFileSync(
      PATHS.stickerLib,
      JSON.stringify({ version: 1, items: [] }, null, 2) + '\n',
      'utf8',
    )
  }
}

let cached = null

/** 读取配置（首次调用会创建 config.json 并补全缺失字段） */
export function loadConfig() {
  if (cached) return cached
  bootstrapFiles()

  const onDisk = readJson(PATHS.config, {})
  let cfg = merge(DEFAULTS, onDisk)

  // 首次启动：生成访问口令并落盘，方便用户直接查看
  let needsWrite = false
  if (!cfg.accessToken) {
    cfg.accessToken = randomToken(20)
    needsWrite = true
  }
  if (Object.keys(onDisk).length === 0) needsWrite = true

  cfg = envOverride(cfg)
  cached = cfg

  if (needsWrite) {
    writeJsonAtomic(PATHS.config, cfg)
    log.info(`已生成配置文件 ${PATHS.config}`)
  }
  return cfg
}

/** 重新从磁盘加载（用户手改 config.json 后调用） */
export function reloadConfig() {
  cached = null
  return loadConfig()
}

/** 把当前配置写回磁盘（保留用户手写的其他字段） */
export function saveConfig(patch) {
  const current = readJson(PATHS.config, {})
  const next = merge(current, patch)
  writeJsonAtomic(PATHS.config, next)
  cached = null
  return loadConfig()
}

/** 启动时的自检结果，告诉用户还差什么 */
export function checkReadiness(cfg = loadConfig()) {
  const problems = []
  if (!cfg.model.apiKey) {
    problems.push('缺少 DeepSeek API Key：在 config.json 的 model.apiKey 填入，或设置环境变量 DEEPSEEK_API_KEY')
  }
  if (!cfg.bark.key) {
    problems.push('缺少 Bark Key：在 iPhone 装 Bark App，把首页那串 key 填到 config.json 的 bark.key')
  }
  return problems
}
