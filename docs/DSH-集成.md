# 在 DSH 里管理「朋友」

「朋友」本身是一个**独立进程**，不依赖 DSH 运行——DSH 关了、甚至电脑只开一半时间，
只要 `node src/server.js` 在跑，它照样会主动找你。

DSH 这边提供的是一个**管理面板**：不用切窗口，直接说人话就能查状态、改人设、调策略。

---

## 当前会话已经有什么

本会话挂了一组动态工具（Host 侧，通过 subprocess 驱动 `src/cli.js cctl`）：

| 工具 | 干什么 |
| --- | --- |
| `friend_start` | 启动服务（后台常驻） |
| `friend_status` | 看状态：未读、排期、今天发了几次、上次为什么没发、配置缺口 |
| `friend_send` | 以你的身份跟它说一句，直接看它怎么回 |
| `friend_wake` | 立刻跑一次主动判断（`auto` / `force` / `dry`） |
| `friend_persona` | 读 / 改人设 |
| `friend_memory` | 读 / 改 / 立刻整理长期记忆 |
| `friend_proactive_config` | 改主动策略（开关、静默时段、间隔、每日上限……） |
| `friend_push_test` | 发一条 Bark 测试推送 |

典型用法：

> 「朋友服务起来了吗」→ 调 `friend_start`
> 「它今天怎么没找我」→ 调 `friend_status`，它会告诉你卡在哪一条拦截上
> 「演练一下它现在会说什么」→ `friend_wake` mode=dry
> 「把人设改得更没耐心一点，别老哄我」→ 先 `friend_persona` 读，再改，再写回
> 「晚上十一点后别吵，白天每两小时找我」→ `friend_proactive_config`

---

## 重要：这组工具会随 DSH 重启消失

动态插件只活在**当前 DSH 进程**里（这是它的设计定位：临时扩展当前运行时）。
重启 DSH 之后，这组工具就没了——**但「朋友」服务本身和数据完全不受影响**。

消失之后你有三个选择：

### 选择一：让我重新挂一次（最省事）

新会话里直接说：「把管理「朋友」的那组工具重新挂上」。我会重新定义并运行同一个插件
（代码在我这边有记录，几秒钟的事）。

### 选择二：用命令行（不依赖任何东西，永远可用）

所有能力都有等价的 CLI，随时随地能用：

```powershell
cd <项目目录>
node src/cli.js cctl status                 # 状态（机器可读，KEY|值 格式）
node src/cli.js status                      # 状态（给人看的）
node src/cli.js cctl send "在吗"             # 发一句并拿回复
node src/cli.js cctl wake dry                # 演练
node src/cli.js cctl wake force              # 强制发一条
node src/cli.js cctl persona                 # 读人设
node src/cli.js cctl persona set "<新人设>"   # 写人设
node src/cli.js cctl memory                  # 读记忆
node src/cli.js cctl memory extract          # 立刻整理记忆
node src/cli.js cctl proactive quietStart=23 maxPerDay=5   # 改策略
node src/cli.js cctl push-test               # 测试推送
```

`cctl` 的输出是稳定的 `KEY|值` 格式，专门给脚本和自动化用；
其他命令是给人看的。你可以拿 `cctl` 接到任何地方（快捷指令、计划任务、别的 agent）。

### 选择三：做成常驻的 DSH agent preset

如果你希望**每次开 DSH 都自动有这组工具**，需要把它做成一个真正的插件包 +
agent preset，而不是动态插件。大致步骤：

1. 在本地建一个 Cordis 插件包，导出一个 `apply(ctx)`，里面
   `harness.registerTool(...)` 注册上面那八个工具；把 `runCli` 的实现从本会话的源码里抄过去。
2. `dsh plugin --profile <你的 profile> add <本地包路径>` 安装
3. 复制一份 shipped preset 到 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/friend/`，
   在它的 `agent.cordis.yml` 里加一行指向你的插件包
4. 用 `agentPresets.standingKeyFor('friend')` 做挂载校验，再开新会话确认工具在

> 注意：**不要直接改 shipped preset**（`agent-presets` 目录里那份），升级会被覆盖。
> 一定要 copy 出来改。
>
> 另外，宿主侧的 `subprocess` 注册表属于 host composition，preset 只能消费它、
> 不能自己提供，所以你的插件行不要包 isolate realm，直接放在 preset 里就行。

这一步不是必须的——选择一或选择二已经够用了，除非你真的每天都要在 DSH 里调它。

---

## 这组工具的实现方式（供参考）

几个踩过的坑，写在这里免得以后重复踩：

1. **动态插件沙箱里没有 `fetch`**。想发 HTTP 会直接报
   `fetch is not available in the dynamic package sandbox`，
   官方的路子是走 `ctx.web`。
2. **`ctx.web.fetch` 是只读抓取**，签名只有 `{ url }`，不能设 method/headers/body，
   所以它**发不了 POST**——用它调聊天接口是走不通的。
3. 结论：**用 `subprocess` 派发**。插件 spawn `node src/cli.js cctl ...`，由 CLI 去访问本地服务。
   顺带好处是 CLI 可以独立使用、可以调试、不依赖 DSH。
4. **沙箱里也没有 `setTimeout` / `setInterval`**。需要延时必须声明 `inject: ['timer']`
   然后用 `ctx.timeout(...)` / `ctx.interval(...)`（它们是 fiber effect，会随插件卸载自动清理）。
5. `ctx.subprocess.spawn` **不给默认值**，`graceMs` 是必填的正数，否则同步抛
   `subprocess graceMs must be a positive finite number`。
   完整签名是 `{ argv, cwd, stdio, graceMs, signal?, env? }`——
   注意是 `argv`（数组）不是 `command`/`args`。
6. 想真正"后台常驻"地启动服务，用
   `spawn({ argv: [cmdPath, '/c', 'start', '""', '/b', nodePath, 'src\\server.js'] })`，
   这样服务不挂在本插件的 fiber 上，插件卸载不会把它带走。
