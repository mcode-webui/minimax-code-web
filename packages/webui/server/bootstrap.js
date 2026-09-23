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
//
// Note: This file is the "real" startup. The checked-in server.js is
// only used in source checkouts — it (1) registers tsx + the
// @mavis/* source resolver, then (2) dynamically imports this file.
// The bundled dist/webui/server.js is an esbuild bundle that inlines
// every workspace import and never touches this file.

import http from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'

import { installGlobalErrorHandlers, MCODE_CMD, UPLOAD_DIR, WEBUI_DATA_DIR, PORT, PORT_PINNED, setServingPort, HOST, DEFAULT_MODEL, DEFAULT_WORKSPACE, SESSIONS_DB, TOKEN_STDOUT } from './lib/config.js'
import { listenWithPortFallback, MAX_PORT_ATTEMPTS } from './lib/port.js'
import { LAN_IP } from './lib/lan.js'
import { handleRequest } from './router.js'
// `MCODE_WEBUI_SERVER=legacy` bypasses Hono entirely; see server/app.js
// for why the two layers share one gate chain.
import { createHonoListener, ownsRequest } from './app.js'
import { runStartupCleanup } from './cleanup.js'
import { startTranscriptSync } from './lib/transcript-sync.js'
import { shutdownMcodeAcpSingleton } from './lib/acp-client.js'
import { init as initSettings, getPersistPath, getTokenEnabled } from './lib/settings.js'
import { setTokenAuthEnabled as setAuthTokenEnabled } from './lib/auth.js'
import { pushTokenFirstRun } from './lib/state-bus.js'

installGlobalErrorHandlers()

// Pre-flight: data root + upload dir must be writable. If mcode is not at
// the resolved path we warn rather than exit — UI/static assets still
// work; only chat-dependent endpoints will fail.
mkdirSync(WEBUI_DATA_DIR, { recursive: true })
if (!existsSync(MCODE_CMD) && MCODE_CMD !== 'mcode') {
  console.warn(`[webui] mcode engine not found at ${MCODE_CMD} — chat features will fail; set MCODE_CMD, build the repo CLI (pnpm build), or install mcode`)
}
mkdirSync(UPLOAD_DIR, { recursive: true })

runStartupCleanup()

// initSettings: load persistent settings, generate default token if needed.
// printToken fires ONLY on first-ever startup (when no token existed on
// disk). After that, the token value lives only in the settings file; if
// the operator rotates via the settings card, the new value is broadcast
// over SSE.
//
// The raw token is NEVER echoed to stdout (it would land in shell history,
// Docker logs, systemd journal, screen shares). Instead we push
// `token.first_run` over SSE so the web UI can show the onboarding modal.
// TOKEN_STDOUT=1 keeps a single NEUTRAL line ("token persisted to: <path>")
// for docker / no-UI environments where no SSE client will connect to
// receive the modal. The token value itself is NEVER printed.
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
      console.log(`token persisted to: ${persistPath}`)
    }
  },
})
setAuthTokenEnabled(getTokenEnabled())

// Which HTTP layer serves this process.
//
// `hono` (default) serves the routes listed in app.js's ledger and hands
// everything else to the legacy dispatcher; `legacy` skips the Hono
// layer entirely, which is the escape hatch if a framework-level
// regression ever needs to be ruled out at runtime.
const SERVER_IMPL = (process.env.MCODE_WEBUI_SERVER || 'hono').toLowerCase()
if (SERVER_IMPL !== 'hono' && SERVER_IMPL !== 'legacy') {
  console.error(`[webui] MCODE_WEBUI_SERVER must be "hono" or "legacy", got "${SERVER_IMPL}"`)
  process.exit(1)
}
// `createHonoListener` returns both the Hono app and the Node listener
// built from it; the app is threaded into `ownsRequest` so the dispatch
// decision and the actual serve walk the SAME router table instead of
// rebuilding one per request.
const honoBinding = SERVER_IMPL === 'hono' ? createHonoListener() : null
const honoApp = honoBinding ? honoBinding.app : null
const honoListener = honoBinding ? honoBinding.listener : null

const server = http.createServer((req, res) => {
  if (honoListener && honoApp) {
    const pathname = (req.url || '/').split('?')[0]
    if (ownsRequest(req.method || 'GET', pathname, honoApp)) return honoListener(req, res)
  }
  return handleRequest(req, res)
})

// Assigned once the listener is up; stopped alongside the ACP singleton so a
// restart cannot leave two pollers behind.
let stopTranscriptSync = () => {}

// Port fallback (see server/lib/port.js): default port walks forward when
// taken; explicit PORT does not fall back. The logged port must be the
// actual bound value — the launcher (mcode-web / mcode webui) reads the
// "listening on" line to pick the URL to open, and the origin trust set /
// share URL are computed from setServingPort().
listenWithPortFallback(server, {
  port: PORT,
  host: HOST,
  pinned: PORT_PINNED,
  onListening: (boundPort) => {
    setServingPort(boundPort)
    stopTranscriptSync = startTranscriptSync()
    console.log(`[webui] listening on http://${HOST}:${boundPort}`)
    console.log(`[webui] http layer: ${SERVER_IMPL}`)
    console.log(`[webui] LAN url: http://${LAN_IP}:${boundPort}`)
    console.log(`[webui] mcode cmd: ${MCODE_CMD}`)
    console.log(`[webui] default model: ${DEFAULT_MODEL}`)
    console.log(`[webui] default workspace: ${DEFAULT_WORKSPACE}`)
    console.log(`[webui] uploads: ${UPLOAD_DIR}`)
    console.log(`[webui] sessions: ${SESSIONS_DB}`)
    console.log(`[webui] settings: ${getPersistPath()}`)
  },
  // Listen failures must exit explicitly: the uncaughtException handler
  // only logs, so a failed listen would otherwise leave a live process
  // that never binds. Pin-vs-fallback message guides the operator.
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
  stopTranscriptSync()
  shutdownMcodeAcpSingleton()
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  console.log('[webui] SIGTERM, shutting down...')
  stopTranscriptSync()
  shutdownMcodeAcpSingleton()
  server.close(() => process.exit(0))
})
