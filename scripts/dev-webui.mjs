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
// Both halves reload on save: the backend through Node's built-in `--watch`
// (disable with MCODE_WEBUI_DEV_NO_WATCH=1), the frontend through `next dev`.
//
// In a built checkout, `pnpm mcode-web` already serves the exported UI; this
// launcher is only useful when iterating on `webapp/` source.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
    if (!exiting) {
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

// The backend runs under Node's built-in watcher so editing the server takes effect
// without a manual restart. `next dev` already hot-reloads the frontend; the backend
// was the half that silently kept serving the code it started with, which is the
// "开发期改不动" complaint this closes. No new dependency: `--watch` is Node's own.
//
// Plain `--watch` (not `--watch-path`) on purpose: it follows the module graph, so it
// restarts on server.js and anything under server/ that got imported, and stays quiet
// while Next churns through `webapp/.next`. An explicit path list would also have to
// enumerate every server/ subdirectory by hand and drift out of date.
//
// A restart drops in-flight SSE streams and the spawned `acp` engine, so a save during
// a running turn kills that turn. That is inherent to restart-based reload; set
// MCODE_WEBUI_DEV_NO_WATCH=1 when you need a stable process (for example while
// stepping through the engine in a debugger).
const watchBackend = process.env.MCODE_WEBUI_DEV_NO_WATCH !== "1";
const backendArgs = watchBackend ? ["--watch", "server.js"] : ["server.js"];

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