// webui/server/lib/config.js
// Pure configuration constants. No side effects.

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// IMPORTANT: import the SUBPATH, never the bare root. The root index
// re-exports ./logging/* which drags in pino (and pino-pretty) into the
// bundle. The local-runtime-paths module is a leaf (node:path only),
// so it is free for both source mode (workspace-source-hooks.mjs
// resolves @mavis/shared/local-runtime-paths to ./src/local-runtime-paths.ts)
// and the bundled layout (esbuild inlines it). The workspace link is
// declared in packages/webui/package.json's dependencies block.
import { resolveV2DirectoryContract } from "@mavis/shared/local-runtime-paths";

import { isPortPinned } from "./port.js";
import { WEBUI_ROOT as PACKAGE_ROOT } from "./layout.js";

/** webui package root — alias for compatibility with models.js:6,17. */
export { PACKAGE_ROOT };

// Data-dir precedence (canonical):
//   MINIMAX_DATA_DIR (the newer env name used by packages/tui/src/runtime/data-dir.ts
//     and packages/config/src/config.ts) > MAVIS_DATA_DIR (legacy alias) >
//   ~/.minimax (fallback). One resolver, exported so both MAVIS_DATA_DIR and the
//   runtime DB path below agree with the rest of the product, and so the
//   trajectory/config.mjs sibling stays in lockstep when it adopts the same
//   helper.
function resolveDataDir() {
  const env = (process.env.MINIMAX_DATA_DIR ?? process.env.MAVIS_DATA_DIR ?? "").trim();
  if (env) return env;
  return join(homedir(), ".minimax");
}

// mcode writes ~/.minimax/runtime/cwd.json with a UTF-8 BOM (\ufeff) at
// the head; JSON.parse rejects it, so strip the BOM before parsing.
function detectTuiCwd() {
  const f = join(homedir(), ".minimax", "runtime", "cwd.json");
  if (!existsSync(f)) return null;
  try {
    let raw = readFileSync(f, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const o = JSON.parse(raw);
    if (o && typeof o.cwd === "string" && o.cwd) return o.cwd;
  } catch (e) {
    console.warn(`[webui] detectTuiCwd: ${f} parse failed: ${e.message}`);
  }
  return null;
}

// Runtime data root. All mutable webui state (uploads, sessions json,
// settings) lives under one user-level directory, default
// ~/.mcode-webui — matching where settings.json already persisted.
export const WEBUI_DATA_DIR =
  process.env.MCODE_WEBUI_DATA_DIR || join(homedir(), ".mcode-webui");
// mcode engine detection chain. Priority order:
//   1. env MCODE_CMD                        (explicit override, always first)
//   2. env MCODE_WEBUI_SELF_ENTRY           (injected by `mcode webui` launcher — the running CLI)
//   3. monorepo build artifact PACKAGE_ROOT/../../dist/cli.js (dev/source layout)
//   4. user install layout ~/.minimax-code/mcode.cmd
//   5. PATH bare name "mcode"
export const MCODE_CMD = (() => {
  if (process.env.MCODE_CMD) return process.env.MCODE_CMD;
  const self = process.env.MCODE_WEBUI_SELF_ENTRY;
  if (self && existsSync(self)) return self;
  const repoCli = resolve(PACKAGE_ROOT, "..", "..", "dist", "cli.js");
  if (existsSync(repoCli)) return repoCli;
  const homeLayout = join(homedir(), ".minimax-code", "mcode.cmd");
  if (existsSync(homeLayout)) return homeLayout;
  return "mcode"; // PATH fallback
})();
// Default port 18090 (high-range to avoid collisions with desktop apps
// and common dev servers that squat on 8080 / 7890 / etc.). Overrideable
// by process.env.PORT (e.g. for running tests on a low port).
//
// Port fallback: the default port is a preference, not a promise — if
// it is taken, the server walks forward to the next free port (see
// server/lib/port.js). Explicitly configured ports (PORT>0, or the
// launcher's --port) stay exact: docker publishes, container health
// checks, and webui integration tests all dial the configured value
// and cannot discover a fallback.
export const PORT = Number(process.env.PORT) || 18090;
// Explicit ports are pinned. Unset / empty / 0 / non-numeric all mean
// "not specified" and fall back to the default port, which may itself
// fall back — matching the `Number(...) || 18090` test above
// (isPortPinned is the only implementation of that rule, see
// server/lib/port.js).
export const PORT_PINNED = isPortPinned(process.env.PORT);
// The port actually serving. After default-port fallback this can
// differ from PORT, so per-request consumers (CORS origin trust set,
// health/state/share URL, LAN hint copy) MUST call getServingPort()
// — never snapshot PORT at import time.
let servingPort = PORT;
export function getServingPort() {
  return servingPort;
}
export function setServingPort(port) {
  if (Number.isInteger(port) && port > 0) servingPort = port;
}
// Default bind is loopback (127.0.0.1): this is a high-trust-surface
// service (agent / filesystem / session control), so network reachability
// must be an explicit operator choice, not the default. LAN opt-in has
// two paths, both still respected:
//   1. env HOST (deploy / docker — always wins)
//   2. settings.json persistent lanBind=true (see server/lib/settings.js;
//      takes effect on restart)
// Neither → loopback. Upgraders who haven't set either land on the new
// default; anyone who set one already keeps their setting.
export const HOST = resolveBindHost(process.env.HOST, readPersistedLanBind());

// Pure resolution rule for the boot bind. Exported for tests.
//   env HOST (trimmed, non-empty) > lanBind===true ? "0.0.0.0" : loopback
export function resolveBindHost(envHost, lanBind) {
  const env = typeof envHost === "string" ? envHost.trim() : "";
  if (env) return env;
  if (lanBind === true) return "0.0.0.0";
  return "127.0.0.1";
}

// Best-effort read of the persisted `lanBind` flag straight from
// settings.json. Duplicates the path resolution of settings.js#_settingsPath
// on purpose: config.js must not import settings.js (settings.js imports
// config.js — a cycle would pin initialization order). Fail-closed: any
// missing/corrupt file resolves to false (loopback).
function readPersistedLanBind() {
  try {
    const p =
      process.env.MCODE_WEBUI_SETTINGS_PATH ||
      join(homedir(), ".mcode-webui", "settings.json");
    if (!existsSync(p)) return false;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && parsed.lanBind === true;
  } catch {
    return false;
  }
}
// Optional auth token for non-local requests. When set, all /api/* and
// SSE requests must carry either `?token=<value>` or
// `Authorization: Bearer <value>`. Local requests always bypass. See
// plugins/Wzdhehe/mcode-webui/references/SECURITY-NOTES.md §2.
export const TOKEN = process.env.TOKEN || "";
// TOKEN_STDOUT — escape hatch for docker / no-UI environments where
// the operator has no SSE client to receive the `token.first_run`
// modal. When "1", server.js prints a single NEUTRAL line
// ("token persisted to: <path>") — the raw token is NEVER echoed.
// Default off: production operators use the web UI modal that the SSE
// event drives.
export const TOKEN_STDOUT = process.env.MCODE_WEBUI_TOKEN_STDOUT === "1";
export const DEFAULT_MODEL =
  process.env.MCODE_MODEL || "minimax_api/MiniMax-M3";
export const DEFAULT_TIMEOUT = process.env.MCODE_TIMEOUT || "120s";
export const DEFAULT_MAX_STEPS = Number(process.env.MCODE_MAX_STEPS) || 6;
export const MAX_CONCURRENT = Number(process.env.MCODE_MAX_CONCURRENT) || 3;
export const UPLOAD_DIR =
  process.env.MCODE_WEBUI_UPLOAD_DIR || join(WEBUI_DATA_DIR, "uploads");
export const SESSIONS_DB =
  process.env.MCODE_WEBUI_SESSIONS_DB ||
  join(WEBUI_DATA_DIR, "sessions.json");
// mcode session physical storage location. Env override wins so E2E
// tests can run real-delete paths against a copy of the db without
// touching the production one. The default comes from the workspace
// contract `resolveV2DirectoryContract`.
export const MCODE_RUNTIME_DB =
  process.env.MCODE_RUNTIME_DB ||
  resolveV2DirectoryContract(resolveDataDir()).runtimeStateDb;
// mavis desktop sqlite db — local_runtime_token_usage holds real token usage.
export const MAVIS_DATA_DIR = resolveDataDir();
export const MAVIS_DB_PATH = resolveV2DirectoryContract(MAVIS_DATA_DIR).runtimeStateDb;
export const SQLITE3_BIN =
  detectSqlite3Bin() ?? "sqlite3"; // fallback: rely on PATH (spawn will ENOENT gracefully if missing)

// Per-{IP,token} rate limiter knobs.
//   - MCODE_WEBUI_RATE_LIMIT      : steady-state allowance per 60s (default 60)
//   - MCODE_WEBUI_RATE_LIMIT_BURST: hard ceiling within one window (default 100)
// Token holders get a 2x multiplier on both (see server/lib/rate-limit.js).
// Chat idle watchdog — acp/exec stream events reset the timer; a run
// is only timed out when silent for this window. Default 120s silent
// (the prior 90s wall clock chopped long-thinking / multi-tool turns).
// MCODE_WEBUI_PROMPT_IDLE_TIMEOUT seconds is the override (positive).
export const PROMPT_IDLE_TIMEOUT_MS = (() => {
  const s = Number(process.env.MCODE_WEBUI_PROMPT_IDLE_TIMEOUT);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 120000;
})();
export const RATE_LIMIT_PER_MIN = Number(process.env.MCODE_WEBUI_RATE_LIMIT || 60);
export const RATE_LIMIT_BURST = Number(process.env.MCODE_WEBUI_RATE_LIMIT_BURST || 100);

// Re-export the four SECURITY-NOTES env vars that
// scripts/check-docs-alignment.mjs requires as direct `export const`
// of the same name. Each is already consumed inline by the code that
// follows (UPLOAD_DIR reads MCODE_WEBUI_UPLOAD_DIR; sqlite-resolver.js
// reads MCODE_BETTER_SQLITE3; settings.js reads
// MCODE_WEBUI_SETTINGS_PATH; debug/inject reads DEBUG_INJECT).
// Exposing the raw env value keeps doc-aligned introspection simple
// without touching the consumer-side resolution.
export const MCODE_WEBUI_UPLOAD_DIR = process.env.MCODE_WEBUI_UPLOAD_DIR || null;
export const MCODE_WEBUI_SETTINGS_PATH = process.env.MCODE_WEBUI_SETTINGS_PATH || null;
export const MCODE_BETTER_SQLITE3 = process.env.MCODE_BETTER_SQLITE3 || null;
export const DEBUG_INJECT = process.env.DEBUG_INJECT || null;

// Platform-specific fallback paths to try when probing for the
// sqlite3 binary. Pure function for testability — no FS / process
// side effects.
export function getPlatformFallbackPaths(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  const paths = [];
  if (platform === "win32") {
    // Anaconda / Miniconda (commonly ship sqlite3.exe on Windows dev machines)
    paths.push(`${home}\\anaconda3\\Library\\bin\\sqlite3.exe`);
    paths.push(`${home}\\Anaconda3\\Library\\bin\\sqlite3.exe`);
    paths.push(`${home}\\miniconda3\\Library\\bin\\sqlite3.exe`);
    paths.push(`${home}\\Miniconda3\\Library\\bin\\sqlite3.exe`);
    // WindowsApps (scoop / winget install there)
    const local = env && env.LOCALAPPDATA;
    if (local) paths.push(`${local}\\Microsoft\\WindowsApps\\sqlite3.exe`);
    // System32 (rare but possible)
    paths.push("C:\\Windows\\System32\\sqlite3.exe");
  } else if (platform === "darwin") {
    paths.push("/usr/bin/sqlite3");
    paths.push("/opt/homebrew/bin/sqlite3"); // Apple Silicon Homebrew
    paths.push("/usr/local/bin/sqlite3"); // Intel Homebrew / manual install
  } else {
    // linux + other unix
    paths.push("/usr/bin/sqlite3");
    paths.push("/usr/local/bin/sqlite3");
  }
  return paths;
}

// Probe a single binary: returns true if it works (`--version` exits 0).
//   Uses spawnSync with stdio:ignore so it doesn't pollute output.
//   2s timeout — sqlite3 --version is instant on any sane system.
function probeBinary(cmd) {
  try {
    const r = spawnSync(cmd, ["--version"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 2000,
    });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}

// Resolve sqlite3 binary path. Order:
//   1. process.env.SQLITE3_BIN (explicit override; must actually work)
//   2. "sqlite3" on PATH (probe --version)
//   3. Platform-specific fallback list (first that works)
//   4. null (caller should degrade gracefully — mavis-usage.js returns null
//          on spawn ENOENT, same as today)
export function detectSqlite3Bin() {
  const envBin = process.env.SQLITE3_BIN;
  if (envBin && probeBinary(envBin)) return envBin;
  if (probeBinary("sqlite3")) return "sqlite3";
  for (const p of getPlatformFallbackPaths()) {
    if (probeBinary(p)) return p;
  }
  return null;
}

// DEFAULT_WORKSPACE must be a real path — mcode acp session/new
// rejects "Invalid params" without one. Priority: env MCODE_WORKSPACE
// > mcode TUI's cwd.json > user's home (fallback).
export const DEFAULT_WORKSPACE = (() => {
  if (process.env.MCODE_WORKSPACE) {
    console.log(
      `[webui] workspace: env MCODE_WORKSPACE=${process.env.MCODE_WORKSPACE}`,
    );
    return process.env.MCODE_WORKSPACE;
  }
  const tui = detectTuiCwd();
  if (tui) {
    console.log(`[webui] workspace: tui cwd.json=${tui}`);
    return tui;
  }
  const home = homedir();
  console.log(`[webui] workspace: homedir fallback=${home}`);
  return home;
})();

// re-export detectTuiCwd for workspace route
export { detectTuiCwd };

// installGlobalErrorHandlers — log + append .server.err so a crashed
// server leaves a trail rather than going silent.
export function installGlobalErrorHandlers() {
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    try {
      import("node:fs").then(({ appendFileSync }) => {
        const logFile = join(WEBUI_DATA_DIR, ".server.err");
        appendFileSync(
          logFile,
          `\n[uncaughtException ${new Date().toISOString()}] ${err.stack || err.message}\n`,
        );
      });
    } catch {}
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
    try {
      import("node:fs").then(({ appendFileSync }) => {
        const logFile = join(WEBUI_DATA_DIR, ".server.err");
        appendFileSync(
          logFile,
          `\n[unhandledRejection ${new Date().toISOString()}] ${reason && reason.stack ? reason.stack : String(reason)}\n`,
        );
      });
    } catch {}
  });
}
