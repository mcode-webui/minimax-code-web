// mcode-webui HTTP/SSE server — bootstrap.
//
// All actual logic lives in server/lib/* + server/routes/* + server/router.js.
// This file only wires up:
//   - installGlobalErrorHandlers (uncaughtException / unhandledRejection)
//   - preflight checks (mcode.cmd exists, upload dir)
//   - initSettings() — load persistent settings, generate default token if needed
//   - http.createServer(handleRequest) + listen
//   - SIGINT / SIGTERM cleanup (close ACP singleton, close server)
//
// API surface is unchanged from the original monolithic server.js — see server/router.js
// for the URL → handler mapping.
//
// In-product launch (preferred):
//   mcode webui            # from a built checkout or an installed CLI
// Direct launch:
//   node packages/webui/server.js
// The server resolves the mcode engine automatically (env MCODE_CMD >
// MCODE_WEBUI_SELF_ENTRY > repo dist/cli.js > ~/.minimax-code > PATH).

import http from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'

import { installGlobalErrorHandlers, MCODE_CMD, UPLOAD_DIR, WEBUI_DATA_DIR, PORT, PORT_PINNED, setServingPort, HOST, DEFAULT_MODEL, DEFAULT_WORKSPACE, SESSIONS_DB, TOKEN_STDOUT } from './server/lib/config.js'
import { listenWithPortFallback, MAX_PORT_ATTEMPTS } from './server/lib/port.js'
import { LAN_IP } from './server/lib/lan.js'
import { handleRequest } from './server/router.js'
import { runStartupCleanup } from './server/cleanup.js'
import { shutdownMcodeAcpSingleton } from './server/lib/acp-client.js'
import { init as initSettings, getPersistPath, getTokenEnabled } from './server/lib/settings.js'
import { setTokenAuthEnabled as setAuthTokenEnabled } from './server/lib/auth.js'
import { pushTokenFirstRun } from './server/lib/state-bus.js'

installGlobalErrorHandlers()

// v0.5.ai: preflight — uploads 目录必须能写
// v1.0: mcode 不在已知位置时降级启动 (UI/静态资源仍可用, mcode 相关功能请求时报错) —
//   之前直接 process.exit(1), 插件装到非 .minimax-code 布局的目录时整包不可用
// v2.1 (in-product): 数据根目录 ~/.mcode-webui 必须先建（uploads/settings 都在它下面）
mkdirSync(WEBUI_DATA_DIR, { recursive: true })
if (!existsSync(MCODE_CMD) && MCODE_CMD !== 'mcode') {
  console.warn(`[webui] mcode engine not found at ${MCODE_CMD} — chat features will fail; set MCODE_CMD, build the repo CLI (pnpm build), or install mcode`)
}
mkdirSync(UPLOAD_DIR, { recursive: true })

runStartupCleanup()

// v1.0.1: 初始化 settings (load from disk, generate default token if needed,
//   sync auth module). The printToken callback fires ONLY on first-ever
//   startup (when the token didn't exist on disk). After that, the token
//   value lives only in the settings file; if the operator rotates via
//   the settings card, the new value is broadcast over SSE and shown in
//   the settings card until acknowledged.
// v2 (Lease C08, ANTI-PATTERNS-FIX-PLAN §AP1): the raw token is NO LONGER
//   echoed to stdout. Instead we push `token.first_run` over SSE so the
//   web UI can show the onboarding modal. The raw token never leaves the
//   controlled channel (SSE → already-authenticated local UI) and never
//   touches shell history / Docker logs / systemd journal / screen shares.
//
//   TOKEN_STDOUT=1 keeps a single NEUTRAL line ("token persisted to: <path>")
//   for docker / no-UI environments where no SSE client will connect to
//   receive the modal. The token value itself is NEVER printed.
let _printedFirstToken = false
initSettings({
  printToken: (token) => {
    if (_printedFirstToken) return
    _printedFirstToken = true
    const persistPath = getPersistPath()
    // Push to any connected SSE client (the UI modal lives here).
    // No-op if sseByCid is empty (e.g. server started headlessly).
    pushTokenFirstRun({ token, persistPath })
    if (TOKEN_STDOUT) {
      // docker / no-UI fallback — single neutral line, NEVER raw token.
      console.log(`token persisted to: ${persistPath}`)
    }
  },
})
// Sync tokenAuth master switch from settings → auth module
setAuthTokenEnabled(getTokenEnabled())

const server = http.createServer(handleRequest)

// 端口回退 (见 server/lib/port.js): 默认端口被占用时向后找空闲端口, 显式 PORT
//   不回退。日志里的端口必须是实际绑定值 —— 启动器 (mcode-web / mcode webui) 正是
//   从 "listening on" 这一行取要打开的 URL, 而 origin 信任集 / share URL 按
//   setServingPort() 记录的端口计算。
listenWithPortFallback(server, {
  port: PORT,
  host: HOST,
  pinned: PORT_PINNED,
  onListening: (boundPort) => {
    setServingPort(boundPort)
    console.log(`[webui] listening on http://${HOST}:${boundPort}`)
    console.log(`[webui] LAN url: http://${LAN_IP}:${boundPort}`)
    console.log(`[webui] mcode cmd: ${MCODE_CMD}`)
    console.log(`[webui] default model: ${DEFAULT_MODEL}`)
    console.log(`[webui] default workspace: ${DEFAULT_WORKSPACE}`)
    console.log(`[webui] uploads: ${UPLOAD_DIR}`)
    console.log(`[webui] sessions: ${SESSIONS_DB}`)
    console.log(`[webui] settings: ${getPersistPath()}`)
  },
  // 监听失败必须显式退出: uncaughtException 处理器只记录不退出, 之前端口被占用
  //   时会留下一个"没在监听"的活进程。端口被显式指定时给出可操作的提示。
  onUnavailable: (error) => {
    const reason = (error && (error.code || error.message)) || String(error)
    console.error(`[webui] cannot listen on ${HOST}:${PORT} — ${reason}`)
    if (error && error.code === 'EADDRINUSE') {
      console.error(
        PORT_PINNED
          ? `[webui] port ${PORT} is taken and was pinned (PORT / --port), so no fallback was attempted. Free it, or pass another value.`
          : `[webui] ports ${PORT}-${PORT + MAX_PORT_ATTEMPTS - 1} are all taken. Free one, or pass --port <number>.`,
      )
    }
    process.exit(1)
  },
})

process.on('SIGINT', () => {
  console.log('[webui] SIGINT, shutting down...')
  shutdownMcodeAcpSingleton()
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  console.log('[webui] SIGTERM, shutting down...')
  shutdownMcodeAcpSingleton()
  server.close(() => process.exit(0))
})
