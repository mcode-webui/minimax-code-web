// One-shot development launcher for the webui.
//
// The webui ships as two cooperating processes:
//   - the Node HTTP/SSE backend (packages/webui/server.js) on :18090
//   - the Next.js dev server (next dev webapp) on :18091, proxying /api/* → :18090
//
// `pnpm webui:dev` boots both, prefixes their stdout/stderr so output is
// readable, and tears them down together on Ctrl+C. No new runtime dependency —
// just `node:child_process`.
//
// Both halves reload on save: the backend through a custom in-process watcher
// (see watchBackend below; disable with MCODE_WEBUI_DEV_NO_WATCH=1), the frontend
// through `next dev`.
//
// In a built checkout, `pnpm mcode-web` already serves the exported UI; this
// launcher is only useful when iterating on `webapp/` source.

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { shouldWatchFile } from "./lib/dev-watch-scope.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const webuiDir = path.join(root, "packages", "webui");
const webappDir = path.join(webuiDir, "webapp");

if (!existsSync(path.join(webuiDir, "server.js"))) {
  console.error(`[mcode:dev] cannot find packages/webui/server.js — run from the repository root.`);
  process.exit(1);
}
if (!existsSync(path.join(webappDir, "next.config.mjs"))) {
  console.error(`[mcode:dev] cannot find packages/webui/webapp/next.config.mjs — has the Next app been scaffolded?`);
  process.exit(1);
}

const children = new Map();
let exiting = false;

// Ports are declared once: the frontend's port has to reach the backend as a
// trusted origin (see below), so it cannot live only in the spawn args.
const BACKEND_PORT = Number(process.env.PORT) || 18090;
const FRONTEND_PORT = Number(process.env.MCODE_WEBUI_DEV_FRONTEND_PORT) || 18091;

// The frontend runs on its own port and proxies /api/* to the backend, so the
// browser's Origin is this dev server — never the backend's own origin.
// router.js Gate 1b (the CSRF boundary) rejects any non-GET whose Origin is not
// trusted, which silently disabled the whole mutating API here — switching
// sessions, creating and deleting them, sending, saving settings — while GETs
// kept working, so the UI looked alive but did nothing. Declaring the dev
// origins is what makes the two-process setup usable; it is scoped to this
// process (`MCODE_WEBUI_TRUSTED_ORIGINS`), so a user's persisted
// settings.json is untouched.
//
// IPv6 loopback (`http://[::1]:<port>`) is deliberately absent: the settings
// sanitizer only accepts `[a-z0-9.-]` inside the brackets, so a bracketed
// literal is rejected and logged. `localhost` and `127.0.0.1` are what the
// browser actually sends here.
const DEV_TRUSTED_ORIGINS = [
  `http://localhost:${FRONTEND_PORT}`,
  `http://127.0.0.1:${FRONTEND_PORT}`,
].join(",");

function spawnChild(name, command, args, cwd, color, extraEnv) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: color ? "1" : "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(name, child);

  const prefix = color ? `\x1b[${color}m[${name}]\x1b[0m ` : `[${name}] `;
  const forward = (stream, dest) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) dest.write(`${prefix}${line}\n`);
    });
    stream.on("end", () => {
      if (buf.length > 0) dest.write(`${prefix}${buf}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    children.delete(name);
    // An exit while we are restarting the backend is expected — the
    // SIGTERM came from restartBackend. Skip the "crashed" branch
    // so the launcher keeps running and the respawn lands.
    if (!exiting && !(name === "backend" && restartingBackend)) {
      // One side crashed — kill the other so the user does not end up with a
      // half-running pair, and exit non-zero so the shell / CI surfaces it.
      exiting = true;
      console.error(`[mcode:dev] ${name} exited (code=${code}, signal=${signal}) — shutting down siblings.`);
      for (const [otherName, other] of children) {
        try {
          other.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      // Give siblings a moment to flush, then exit with the original code.
      setTimeout(() => process.exit(code ?? 1), 500);
    }
  });

  return child;
}

// Custom backend watcher.
//
// Node 24's `--watch` flag follows the entire module graph: an mtime
// change inside any transitively imported file (notably
// `node_modules/@hono/node-server/dist/*.mjs` after a sibling
// worktree's `pnpm install` activity reaches this checkout through
// the shared pnpm store hardlinks) restarts the backend. With the
// old "any change restarts" behaviour the SIGTERM landed on a
// backend mid-cleanup, `server.close()` waited on a live SSE
// socket, and the process wedged — the watcher saw it alive but
// not listening and refused to spawn a replacement.
//
// `fs.watch({ recursive: true })` lets us scope the watch to the
// `server/` directory tree and ignore `node_modules`/`.next`/
// `dist`/etc, while keeping the "restart on save" affordance.
const watchBackend = process.env.MCODE_WEBUI_DEV_NO_WATCH !== "1";
const backendArgs = watchBackend ? ["server.js"] : ["server.js"];

// `shouldWatchFile` lives in scripts/lib/dev-watch-scope.mjs so the
// test can import it without pulling in child_process / process.on
// side effects from this launcher.

function watchBackendSources(onChange) {
  // fs.watch on the entry file picks up top-level changes; the
  // recursive watcher on server/ covers the imported tree. We
  // register both because some platforms only deliver changes to
  // one watcher for a given file.
  //
  // On Linux, fs.watch emits only the basename for non-recursive
  // watches; on macOS and Windows it emits the relative path. We
  // join the basename with the watch target so shouldWatchFile's
  // path-component filter sees the same shape everywhere.
  const entryPath = path.join(webuiDir, "server.js");
  const serverDir = path.join(webuiDir, "server");
  const watchers = [];
  for (const target of [entryPath, serverDir]) {
    if (!existsSync(target)) continue;
    try {
      const w = watch(target, { recursive: target === serverDir }, (event, filename) => {
        // Join the basename with the watch target so the filter
        // sees a stable absolute-or-relative path. fs.watch can
        // pass `filename === null` (Linux, kqueue variants) — guard.
        const joined = filename ? path.join(target, filename) : target;
        if (process.env.MCODE_WEBUI_DEV_WATCH_TRACE) {
          console.error(
            `[mcode:dev] fs.watch event: target=${target} event=${event} filename=${filename} joined=${joined}`,
          );
        }
        if (shouldWatchFile(joined)) onChange(joined);
      });
      w.on("error", (error) => {
        console.error(`[mcode:dev] watch(${target}) error: ${error.message}`);
      });
      watchers.push(w);
    } catch (error) {
      console.error(`[mcode:dev] watch(${target}) failed: ${error.message}`);
    }
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
  };
}

let restartInFlight = false;
let restartingBackend = false;
let restartTimer = null;
function scheduleBackendRestart(triggerFile) {
  if (restartTimer) clearTimeout(restartTimer);
  // Coalesce bursts (saving several files in quick succession should
  // produce one restart, not N). 200ms is short enough that an
  // interactive save feels instant, long enough that a multi-file
  // commit collapses to one cycle.
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartBackend(triggerFile);
  }, 200);
  if (typeof restartTimer.unref === "function") restartTimer.unref();
}

async function restartBackend(triggerFile) {
  if (restartInFlight) return;
  restartInFlight = true;
  try {
    const old = children.get("backend");
    if (!old) return; // already gone
    console.log(
      `[mcode:dev] restart: ${path.relative(root, triggerFile)} — restarting backend`,
    );
    // Mark the child as "expected to exit" so spawnChild's exit
    // handler does not treat the SIGTERM as a crash and tear down
    // the whole launcher. The flag is cleared after we respawn or
    // give up.
    restartingBackend = true;
    try {
      old.kill("SIGTERM");
    } catch {
      // already gone
    }
    const exited = await waitForExit(old, 8000);
    if (!exited) {
      console.warn(
        `[mcode:dev] backend did not exit within 8s after SIGTERM — SIGKILL`,
      );
      try {
        old.kill("SIGKILL");
      } catch {
        // already gone
      }
      await waitForExit(old, 2000);
    }
    children.delete("backend");
    // Respawn. spawnChild's exit handler is wired for "exited
    // unexpectedly"; we cleared that path by deleting the entry
    // before respawning so the respawn won't trigger the sibling-
    // kill chain. The exit code from the SIGTERM (143) is fine to
    // discard here.
    const backend = spawnChild(
      "backend",
      process.execPath,
      backendArgs,
      webuiDir,
      "36",
      { PORT: String(BACKEND_PORT), MCODE_WEBUI_TRUSTED_ORIGINS: DEV_TRUSTED_ORIGINS },
    );
    if (typeof backend.unref === "function") backend.unref();
  } finally {
    restartInFlight = false;
    restartingBackend = false;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.once("exit", onExit);
  });
}

const backend = spawnChild(
  "backend",
  process.execPath,
  backendArgs,
  webuiDir,
  "36", // cyan
  { PORT: String(BACKEND_PORT), MCODE_WEBUI_TRUSTED_ORIGINS: DEV_TRUSTED_ORIGINS },
);
const frontend = spawnChild(
  "frontend",
  "npx",
  ["next", "dev", "webapp", "--port", String(FRONTEND_PORT)],
  webuiDir,
  "35", // magenta
  { MCODE_WEBUI_ORIGIN: `http://127.0.0.1:${BACKEND_PORT}` },
);

console.log(`[mcode:dev] backend PID ${backend.pid ?? "?"} — http://127.0.0.1:${BACKEND_PORT}/`);
console.log(`[mcode:dev] frontend PID ${frontend.pid ?? "?"} — http://127.0.0.1:${FRONTEND_PORT}/ (open this in the browser)`);
console.log(
  watchBackend
    ? "[mcode:dev] backend watcher is ON — saving server code restarts it (a restart cancels a running turn)."
    : "[mcode:dev] backend watcher is OFF (MCODE_WEBUI_DEV_NO_WATCH=1).",
);
console.log(`[mcode:dev] Ctrl+C stops both.`);

if (watchBackend) {
  const stopWatcher = watchBackendSources((file) => scheduleBackendRestart(file));
  process.once("exit", stopWatcher);
}

function shutdown(signal) {
  if (exiting) return;
  exiting = true;
  console.error(`\n[mcode:dev] received ${signal}, stopping both processes…`);
  for (const [name, child] of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  // Force-kill after 5s if anything is still alive.
  setTimeout(() => {
    for (const [name, child] of children) {
      try {
        if (!child.killed) {
          child.kill("SIGKILL");
          console.error(`[mcode:dev] force-killed ${name}`);
        }
      } catch {
        // already gone
      }
    }
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Keep the parent alive while either child is running.
const interval = setInterval(() => {
  if (children.size === 0 && !exiting) {
    clearInterval(interval);
    process.exit(0);
  }
}, 1000);
interval.unref();