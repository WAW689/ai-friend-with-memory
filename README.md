# 朋友

一个会**主动找你聊天**的 AI 朋友。跑在你自己的电脑上，聊天记录和记忆都只存在本地；
它想找你的时候，通过 **Bark** 把消息推到你 iPhone 的锁屏上。

- 聊天界面：自建网页 App，在 iPhone Safari 里打开，可以「添加到主屏幕」当原生 App 用
- 主动消息：定时醒来 → 判断现在该不该开口 → 发消息 + 推手机
- 不像机器人的关键：随机间隔、静默时段、防连发轰炸、模型二次判断、会连发两条、按你的作息调整

## 它能做什么

| 能力 | 说明 |
|---|---|
| **主动找你** | 不是定时群发。到点先过四道闸门（静默时段/每日上限/连发上限/刚聊完），再让模型判断"现在该不该开口"，还能自己决定"这次不说" |
| **发图片** | 点回形针从相册选图，它会真的看懂（需要 `deepseek-flash`）。上传前在浏览器里自动压缩 |
| **改头像** | 点头像就能换成 emoji 或自己的图 |
| **有记忆** | 每 24 条消息自动整理一份关于你的长期档案；聊太久会自动压缩成摘要 |
| **时间感知** | 分得清"今天/昨天"，也知道你们中间隔了多久 |
| **完全不联网存数据** | 对话、记忆、人设全在你本地 `data/` 里，图片也不上传到任何第三方 |
| **每天自动备份** | 保留 14 天，备份放在 `backups/`，独立于 `data/` |

**依赖极少**：零第三方 npm 依赖，只需要 Node 22+。二维码生成、PNG 编码、测试框架都是手写的。

## 快速上手

需要两样东西：

1. **DeepSeek API Key** — <https://platform.deepseek.com> 申请
2. **Bark Key** — iPhone 装 [Bark](https://apps.apple.com/app/id1403753865)，首页那串就是（不想推送可以不填）

```bash
git clone https://github.com/WAW689/friend.git
cd friend
node src/cli.js key sk-你的key       # 填 DeepSeek Key
node src/cli.js bark 你的BarkKey     # 填 Bark Key（可跳过）
node src/cli.js check                # 体检，看还缺什么
node src/server.js                   # 启动
```

启动后终端会打印手机访问地址和口令。在 iPhone Safari 打开、添加到主屏幕即可。

**人设**在 `data/persona.md`，改完立刻生效，不用重启。
出厂是一个叫「阿岚」的占位角色，重点在文件末尾那几条**反 AI 腔**的规定。

详细说明、常见问题、云端部署见下面的章节和 `docs/`。

---

## 一分钟上手

```powershell
cd D:\PYF\friend

# 1. 填 DeepSeek API Key（如果用 DSH，可以直接复用它的 key，见下文）
node src/cli.js key sk-你的key

# 2. 填 Bark Key（iPhone 装 Bark App，把首页那串 key 复制过来）
node src/cli.js bark 你的BarkKey

# 3. 检查一遍
node src/cli.js check

# 4. 启动
node src/server.js
```

启动后终端会打印两个地址，**手机用局域网那个**：

```
本机访问：   http://127.0.0.1:8787/?token=xxxxxxxx
手机访问：   http://192.168.x.x:8787/?token=xxxxxxxx
```

（`192.168.x.x` 换成你电脑实际的局域网地址，终端会打印出来）

在 iPhone 上打开"手机访问"那条链接，然后：

1. Safari 底部分享 → **添加到主屏幕**，以后从桌面图标直接进
2. 第一次打开会要访问口令（终端和链接里都有，会自动记住）
3. 进设置 ⚙ → 连接 → 点「测试模型」和「发一条测试推送」，确认两条链路都通

> 手机和电脑必须在同一个 WiFi 下。出门在外也想用，见文末「在外网访问」。

---

## 它到底是怎么"主动"的

「主动发消息」不是一个定时群发，而是一套判断流程：

1. **到点了才醒**。每 75~240 分钟随机排一次（可在设置里改），不是准点。
2. **硬性拦截**（任何一条命中就不发，连模型都不叫）：
   - 静默时段内（默认 22:00–9:00）
   - 今天已到次数上限（默认 8 次）
   - 已经连发 N 条对方都没回（默认 2 条）
   - 你刚说过话不久（默认 40 分钟内）
3. **模型再判一次**。把最近的对话、隔了多久、连发了几条都给它，让它决定：
   - 现在该不该开口
   - 该说什么（最多两条）
   - 如果它认为"没必要"，这次就真的不发，并重新排期
4. **你正在看屏幕就不推手机**。页面开着的时候消息直接出现，不震你。
   判断依据是页面**可见时**发出的心跳（45 秒一次）；页面切到后台就不再发心跳，
   90 秒后服务端就认为你不在跟前，于是正常推 Bark。
5. **发完重排下一次**，间隔重新随机。

拦下来的原因会记在 `state.json` 里，用 `node src/cli.js status` 或 DSH 里的 `friend_status` 就能看到
"上次为什么没发"。

### 想调主动策略

三种方式，随你顺手：

- 手机上：⚙ → 主动
- 命令行：改 `config.json` 的 `proactive` 段
- DSH 里：直接说「让它白天每 2 小时找我一次，晚上 11 点后别吵」

### 想立刻看它会说什么（不发出去）

```powershell
node src/cli.js wake --dry-run     # 只演练，看它会说什么
node src/cli.js wake               # 尊重所有拦截，走真实流程
node src/cli.js wake --force       # 跳过一切拦截，强制发一条
```

---

## 发图片

**点输入框左边的回形针**就能从相册选图或拍照，一次最多 4 张，也可以直接拖进窗口。
图和文字可以一起发。

它**真的看得见**——实测：

> 你发（蓝底 + 红圆 + 绿方块）
> 它回：**蓝色打底，中间一个大红圆，左上角有个小绿方块。**

### 几个实现上的取舍

**图片单独存文件，不塞进聊天记录。** 一张手机截图 base64 后有 1-3 MB，
几百条对话下来 `messages.jsonl` 会涨到几百 MB，而它每次都要整个读进内存。
所以图片存在 `data/images/日期/` 下，消息里只记一个 id。

**上传前在浏览器里压缩。** 手机直出的照片 3-8 MB，
压到长边 1280 通常只剩一两百 KB，视觉上完全够看，而且**图片是按尺寸计费 token 的**
（一张最多 1024 token）。原图不会上传。

**发消息时只带最近 4 张图。** 更早的图在文字记录里留 `［1 张图］` 占位——
它知道那里有图，但不会重复看到，否则 prompt 会越聊越贵。

### 模型要求

图片需要 **`deepseek-flash`**（`deepseek-chat` 不支持）。
你现在配的就是 `deepseek-flash`，所以开箱可用。

验证一下你的账户能不能用图片：

```powershell
node test/vision-probe.js
```

三条都 ✓ 就说明可用。它会打印每张图实际占的 token 数。

### 图片占空间

```powershell
node src/cli.js images      # 看图片数量和占用
```

想清理就在 `data/images/` 下按日期删。

> **备份不含图片。** `backups/` 只备份聊天记录、记忆、人设、头像——
> 图片体积大，而且它不是"无法重新生成"的东西。删掉图片后，
> 聊天记录里对应的消息只剩文字占位，模型也就看不到那张图了。

---

## 人设

人设就是一个 markdown 文件：`data/persona.md`。改完保存，**下一条回复就生效**，不用重启。

也可以：

- 手机上 ⚙ → 人设
- DSH 里说「把人设改成……」（走 `friend_persona` 工具）

出厂人设的角色叫「阿岚」（只是个占位名，随便改成你想要的），重点是那几条**反 AI 腔**的规定：
不要每次都反问、不要总结对方的话、不要先共情再给建议、没什么可说就发短点。
这几条比"性格描述"更能决定它像不像人，建议保留。

> **改名字只需改一处**：人设第一行的「名字叫「XX」」。
> 聊天界面顶部的名字、头像首字，以及 Bark 推送的标题都会自动跟着变。
> 想单独指定推送标题，在 `config.json` 的 `bark.group` 里写死即可（留空则跟人设走）。

---

## 头像

**直接点聊天界面左上角的头像**就能改。三种方式：

| 方式 | 说明 |
|---|---|
| 选 emoji | 内置 12 个备选，点一下就换 |
| 自己输字 | 最多 2 个字符（emoji 也算一个） |
| 上传图片 | 从相册选，会自动裁成圆形 |

存成 `data/avatar.json`。不设的话默认取名字第一个字。

**关于上传图片**：手相册里随便一张就 3-5 MB，服务端上限是 400 KB。
所以浏览器里会**先自动压缩再上传**（缩到 256px 以内、必要时降质量），
压缩后通常十几 KB，做头像绰绰有余——**原图不会离开你的手机**。

Android 一般不用管；iOS 上传后走的是 Safari，不需要相册权限弹窗。

---

## 记忆

它自己维护一份关于你的档案：`data/memory.md`。

- 每攒够 24 条消息，后台自动抽取一次稳定事实（工作、住处、偏好、雷区……）
- 聊天记录太长时自动滚动压缩成摘要（`data/summary.json`），不会把上下文撑爆
- 你可以随时手改，或让它立刻整理一次：

```powershell
node src/cli.js extract-memory
node src/cli.js memory
```

---

## 在 DSH 里管理它

当前会话已经挂了一组工具，直接说人话就行：

| 你说 | 它调用 |
| --- | --- |
| 「朋友服务起来了吗」 | `friend_start` |
| 「它现在什么状态，为什么不找我」 | `friend_status` |
| 「帮我跟它说一句：今天怎么样了」 | `friend_send` |
| 「演练一下，看它现在会说什么」 | `friend_wake` (mode=dry) |
| 「强制让它发一条」 | `friend_wake` (mode=force) |
| 「把人设改得更毒舌一点」 | `friend_persona` |
| 「它都记住我什么了」 | `friend_memory` |
| 「晚上 11 点后别吵，白天每 2 小时找我」 | `friend_proactive_config` |
| 「发条测试推送」 | `friend_push_test` |

> 这组工具是**当前 DSH 进程内**的动态插件，重启 DSH 就没了（不影响「朋友」服务本身）。
> 需要长期保留的话，把它做成 agent preset，见 `docs/DSH-集成.md`。

---

## 开机自启与守护（重要）

**没有这一步，电脑重启后服务就不会自己起来**，而且你不会发现——除非注意到它一整天没找你。

用一个启动脚本管理，它同时负责：找 node、设工作目录、重定向日志、注册计划任务。

```powershell
.\start-friend.ps1 -Status      # 看状态（服务在不在、有没有注册自启）
.\start-friend.ps1             # 前台启动（看得到日志，Ctrl+C 停）
.\start-friend.ps1 -Background # 后台启动（日志写进 logs\）
.\start-friend.ps1 -Install    # 注册开机自启（需要管理员）
.\start-friend.ps1 -Uninstall  # 取消开机自启（需要管理员）
```

**注册自启**：开始菜单搜 PowerShell → 右键 → **以管理员身份运行** → 执行

```powershell
cd D:\PYF\friend
.\start-friend.ps1 -Install
```

装上之后：

- **登录 Windows 时自动启动**，不用手动开
- **挂了会自动重拉**（每 5 分钟检查一次）
- 日志写在 `logs\friend-日期.log`，出问题先看它

> 如果提示"无法加载脚本，因为在此系统上禁止运行脚本"，说明你的 PowerShell 执行策略是 Restricted。
> 临时绕过：`powershell -ExecutionPolicy Bypass -File .\start-friend.ps1 -Status`
> 或永久放开当前用户：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

## 自动备份

`data/` 里那 200 多条对话和它对你的记忆，是**唯一无法重新生成**的东西——
代码可以重装、配置可以重填，这些丢了就没了。

服务每天会自动备份一次，备份放在 **`backups/日期/`**（独立于 `data/`，所以误删 `data/` 也不会连带删掉备份）。

```powershell
node src/cli.js backup           # 看有哪些备份
node src/cli.js backup --now     # 立刻备一份
```

保留最近 **14 天**，同一天重复备份按日期覆盖，不会堆成一堆。

**恢复方法**：停掉服务，把某份备份里的文件复制回 `data/`，再启动。

```powershell
.\start-friend.ps1 -Status          # 先确认服务状态
# 停掉服务后：
copy backups\2026-09-20\messages.jsonl data\
copy backups\2026-09-20\memory.md data\
copy backups\2026-09-20\persona.md data\
```

---

## 常用命令

```powershell
npm test                          # 跑全部测试（8 个套件）
npm start                         # 启动服务
npm run status                    # 看主动排期与拦截原因

node src/cli.js check            # 配置体检
node src/cli.js status           # 主动排期与拦截原因
node src/cli.js say "在吗"        # 在终端直接聊一句
node src/cli.js memory           # 打印记忆档案
node src/cli.js extract-memory   # 立刻整理一次记忆
node src/cli.js backup --now     # 立刻备份
node src/cli.js wake-now         # 把下次主动窗口拉到当前
node src/cli.js reset-streak     # 清空"连续未回"计数
node src/cli.js token            # 显示访问口令
node src/reset.js persona        # 人设恢复出厂（不碰聊天记录）
node test/smoke.js <token>       # 只跑接口冒烟测试
```

### 测试

```powershell
npm test                  # 全部（11 个套件，约 5 秒）
node test/all.js          # 同上
node test/prompts.js      # 单独跑某一个
```

测试分两类：**离线**（不调模型、不依赖服务，随时可跑）和**在线**（需要服务在跑）。

测试**绝对不会碰到你的真实数据**。每个测试文件的第一个 import 都是
`test/_bootstrap.js`，它把 `FRIEND_DATA_DIR` 指到一个隔离目录：

- 跑 `npm test` → 所有套件共用 `test/tmp/`
- 单独跑某个文件 → 各自用 `test/tmp-<套件名>/`

这两类目录都在 `.gitignore` 里（里面会复制真实的 `persona.md` / `memory.md`，
属于私密内容，**不要提交**）。

> 这条不是多虑：曾经直接跑 `node test/life.js` 把真实的生活设定
> 写成了测试夹具，聊天里的她一度"失去了身份"。`test/regressions.js`
> 现在会检查每个测试文件都引入了引导模块。

### 推送相关

```powershell
node src/cli.js test-bark         # 发一条固定文案，只测通道通不通
```

要确认推送到达手机时的样子，就用 `test-bark`——**它推的是写死的文字，绝不碰聊天记录**。

> 这里原本还有 `bark-last` / `bark-preview` 两个命令（把聊天记录里的消息推过去预览效果）。
> 已经删掉：它们会把**你自己说的话**推回给你，调试时反复执行就会连收十几遍。
> 你真机上收到过自己发的消息，就是它们干的。
>
> 现在**唯一会推送的路径是真实的主动消息**。测试环境还会额外挂一把总闸
> （`FRIEND_NO_PUSH=1`），让测试在物理上不可能响你手机。

---

## 文件在哪

```
D:\PYF\friend\
├─ config.json          ← 密钥、端口、主动策略（含访问口令，别外传）
├─ data\
│  ├─ messages.jsonl    ← 全部聊天记录，只追加，不会因崩溃损坏
│  ├─ state.json        ← 已读到哪、主动排期、连发计数
│  ├─ persona.md        ← 人设
│  ├─ memory.md         ← 长期记忆
│  ├─ summary.json      ← 历史摘要
│  └─ push.log          ← 推送记录，排查推送问题用
├─ public\              ← iPhone 端页面
└─ src\                 ← 服务端代码
```

删掉整个 `data\` 就是"重新认识一次"。删 `messages.jsonl` 但留着 `memory.md` 是"忘了聊过什么，但还记得你"。

---

## 搬到云服务器（电脑不常开时）

代码是按平台无关写的，全部支持环境变量，云上不用落配置文件：

```bash
DEEPSEEK_API_KEY=sk-xxx \
BARK_KEY=你的key \
FRIEND_PORT=8787 \
FRIEND_ACCESS_TOKEN=换个好记的口令 \
node src/server.js
```

用 systemd / pm2 / Docker 常驻即可，`data/` 挂个卷持久化。
搬上去之后建议：

- 关掉公网直连，或者前面挂一层 HTTPS 反代（口令是明文传输的）
- 或者只在内网跑，靠 Tailscale / WireGuard 进去

详细步骤见 `docs/部署与迁移.md`。

---

## 安全提醒

- `config.json` 里有你的 DeepSeek Key、Bark Key 和访问口令，**不要提交到 git、不要发群里**（`.gitignore` 已经屏蔽）
- 服务默认监听 `0.0.0.0`，也就是同局域网都能访问到端口。有口令拦着，但口令是明文传输的
- 如果电脑在不可信网络里（公司、公共 WiFi），把 `config.json` 的 `host` 改成 `127.0.0.1`，然后用 Tailscale 之类的方式进
- Bark Key 泄露了别人能给你推消息，去 Bark App 里重置即可
