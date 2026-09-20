/**
 * 服务入口。
 * 启动顺序有讲究：先载入历史消息，再起 HTTP，最后开调度器。
 */
import { checkReadiness, loadConfig } from './config.js'
import { createServer, printBanner, startStoreBroadcast } from './http.js'
import { startScheduler, stopScheduler } from './scheduler.js'
import { store } from './storage.js'
import { log } from './util.js'

const cfg = loadConfig()

store.load()
startStoreBroadcast()

const { server } = createServer()

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`端口 ${cfg.port} 已被占用。改 config.json 里的 port，或先关掉占用它的程序。`)
  } else {
    log.error(`服务启动失败：${err.message}`)
  }
  process.exit(1)
})

server.listen(cfg.port, cfg.host, () => {
  printBanner(cfg, cfg.port)
  startScheduler()
  for (const problem of checkReadiness(cfg)) log.warn(problem)
})

/* ------------------------------------------------------------ 优雅退出 */

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`收到 ${signal}，正在退出…`)
  stopScheduler()
  // 把合并中的状态立刻落盘，避免丢"已读到哪"
  store.saveStateNow()
  server.close(() => process.exit(0))
  // 兜底：5 秒还没关干净就强退
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => log.error(`未处理的 Promise 拒绝：${reason}`))
