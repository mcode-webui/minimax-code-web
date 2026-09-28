// webui/test/helpers/tmp.js
//
// Shared test-side tmpdir management.
//
// Why this exists
// ---------------
// 60+ webui test files call `mkdtempSync(join(tmpdir(), "<prefix>-"))` to
// stage isolated data directories, then leave the directory on disk when the
// suite ends. On a busy dev host the same machine runs many agents in
// parallel; the unused directories (the historical leak count is ~30k entries
// in `/tmp` across `webui-export-test-`, `webui-events-test-`, etc.) bury
// real signals (e.g. zombie-server diagnostics).
//
// The repo's existing gate `scripts/test-isolation-lint.check.mjs` already
// enforces that any test which spawns server.js overrides the four
// `MCODE_WEBUI_*` env paths. That gate proves the path was set; it does NOT
// prove the directory was removed. This helper closes the second half of
// the contract.
//
// Design
// ------
// Every directory created through `mkTmpDir` / `mkSubTmpDir` is registered
// in a process-local Set. Three cleanup hooks flush the set:
//
//   1. `process.on('exit')` — synchronous; runs on normal exit AND after
//      process.exit() / uncaughtException / unhandledRejection trigger
//      exit. This is the LAST line of defence.
//   2. `process.on('SIGINT')` and `process.on('SIGTERM')` — the handler
//      runs the cleanup synchronously, removes ITSELF from the listener
//      list, then `process.kill(process.pid, sig)` re-raises the signal.
//      Without the `removeListener` step the same listener catches the
//      re-raised signal and the handler runs again — an infinite loop
//      that prevents the process from ever exiting (round-3 B6.1
//      evidence: SIGTERM left the process alive, only SIGKILL killed it
//      with exit 137). SIGKILL is intentionally not handled — kernel-
//      only, no userland hook, OS-level tmp cleanup is the only
//      defence.
//
// `node --test` runs each `after()` hook before process exit, so the normal
// path is "test code rm's via `rmTmpDir`", and the three hooks only fire
// when the suite died before reaching cleanup. All three use `force: true`
// so a half-built directory does not strand the test runner.
//
// Parent-directory batching
// -------------------------
// Tests that build many directories (e.g. one per `beforeEach` case) can
// opt into the parent-batching shape: a single `mkTmpDir("prefix-X-")`
// gives the parent, every `beforeEach` creates children via `mkSubTmpDir`
// inside it, and the after-hook rm's the parent. The node `child` dirs
// never appear in `os.tmpdir()` at all — they live under the parent, which
// itself lives under `os.tmpdir()` for one-shot OS cleanup.
//
// Process-safety
// --------------
// The helper installs all hooks exactly once (idempotent), and the Set
// is iterated in registration order so a parent directory is removed
// AFTER its children (the inverse order `force: true` would handle anyway,
// but explicit order makes debugging easier).
//
// Cross-platform
// --------------
// `fs.rmSync(..., { recursive: true, force: true })` is the documented
// cross-platform removal call. The helper does NOT touch `fs.rm` (async);
// rmSync is intentional so the `exit` hook can do its work without
// scheduling further I/O after the loop has drained. The signal handlers
// also do a synchronous rm — async handlers can let the kernel default-
// action the signal before our cleanup finishes, which is what B6 hit.
//
// Usage
// -----
//   import { mkTmpDir, mkSubTmpDir, rmTmpDir } from "../helpers/tmp.js";
//
//   let tmpDir;
//   beforeEach(() => { tmpDir = mkTmpDir("webui-events-test-"); });
//   afterEach(() => { if (tmpDir) rmTmpDir(tmpDir); });
//
//   // batching shape (one parent for many children):
//   let parent;
//   before(() => { parent = mkTmpDir("webui-export-test-"); });
//   after(() => { if (parent) rmTmpDir(parent); });
//   beforeEach(() => { const child = mkSubTmpDir(parent, "case-"); });

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const _tracked = new Set();
let _hookInstalled = false;

/**
 * Synchronously remove every tracked directory. Idempotent — safe to call
 * multiple times; the Set is cleared after a successful pass so the signal
 * handler that re-raises the signal does not double-rm.
 */
function flushTracked() {
  for (const dir of _tracked) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — never let cleanup throw out of an exit hook
    }
  }
  _tracked.clear();
}

/**
 * Install the synchronous `process.on('exit')` flush hook plus SIGINT /
 * SIGTERM handlers that clean up, remove themselves, and re-raise the
 * signal so the default disposition kills the process. Idempotent.
 *
 * Why synchronous? `process.on('exit')` listeners only run sync code, and
 * we want the rm to actually finish before the process goes away — an
 * async-rm registered through `process.on('beforeExit')` can race a fast
 * exit and strand the directory again.
 *
 * Why remove the listener before re-raising? Round-3 B6.1 caught this:
 * the round-2 handler ran `process.kill(process.pid, sig)` while the
 * same handler was still registered. Node delivered the re-raised
 * signal back to the listener, the listener ran cleanup again, and the
 * loop only ended when SIGKILL killed the process with exit code 137.
 * `process.removeListener` BEFORE `process.kill` is what makes the
 * re-raise a one-shot: the second signal delivery hits no listener and
 * the default disposition kills the process with the signal's natural
 * exit code (130 for SIGINT, 143 for SIGTERM).
 *
 * Safety net: if `process.kill` somehow does not kill us (e.g. some
 * future Node behaviour), `process.exit(128 + signum)` is a hard
 * fallback that cannot loop — Node tears down the event loop on exit.
 */
function installExitHook() {
  if (_hookInstalled) return;
  _hookInstalled = true;
  process.on("exit", () => {
    flushTracked();
  });
  // SIGINT (Ctrl-C / `kill -INT <pid>`): cleanup → removeListener →
  // re-raise so default disposition kills with exit code 130.
  const onSigint = () => {
    flushTracked();
    process.removeListener("SIGINT", onSigint);
    try {
      process.kill(process.pid, "SIGINT");
    } catch {
      // Defensive: if the kill fails for any reason, force-exit with
      // the signal's expected exit code.
      process.exit(130);
    }
    // If process.kill succeeded but didn't take effect (it should
    // synchronously raise the default disposition once no listener
    // remains), exit hard.
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  // SIGTERM (CI runner timeout / `kill <pid>` / `kill -TERM <pid>`):
  // cleanup → removeListener → re-raise so default disposition kills
  // with exit code 143.
  const onSigterm = () => {
    flushTracked();
    process.removeListener("SIGTERM", onSigterm);
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(143);
    }
    process.exit(143);
  };
  process.on("SIGTERM", onSigterm);
  // SIGKILL is intentionally NOT handled — kernel-only, no userland hook.
  // The OS's regular tmp cleanup (mtime-based) is the only line of
  // defence for that path. Same as before this helper existed.
}

/**
 * Register a directory for guaranteed cleanup. Returns the same path so
 * callers can chain `const dir = registerTmpDir(mkdtempSync(...));`.
 */
export function registerTmpDir(path) {
  if (typeof path !== "string" || !path) {
    throw new TypeError("registerTmpDir: path must be a non-empty string");
  }
  installExitHook();
  _tracked.add(path);
  return path;
}

/**
 * Drop a directory from the tracker and attempt a synchronous recursive
 * removal. Safe to call multiple times (the Set delete is a no-op when
 * the path is unknown). Errors are swallowed so a single failed rm does
 * not cascade into a suite-wide abort.
 */
export function rmTmpDir(path) {
  if (typeof path !== "string" || !path) return;
  _tracked.delete(path);
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Create a tracked temporary directory under `parentDir` (defaults to
 * `os.tmpdir()`) using `prefix` exactly as `mkdtempSync` consumes it.
 * The directory is registered for exit-hook cleanup; `rmTmpDir` removes
 * it eagerly when the test passes.
 */
export function mkTmpDir(prefix, { parent } = {}) {
  if (typeof prefix !== "string" || !prefix) {
    throw new TypeError("mkTmpDir: prefix must be a non-empty string");
  }
  installExitHook();
  const root = parent ?? tmpdir();
  const dir = mkdtempSync(join(root, prefix));
  _tracked.add(dir);
  return dir;
}

/**
 * Async counterpart to `mkTmpDir`. Several `*.mjs` trajectory tests
 * already use `await mkdtemp(...)` to build fixtures in parallel; this
 * helper preserves the async shape while still registering the directory
 * for the exit-hook cleanup path. Tests that want immediate cleanup can
 * `await rmTmpDirAsync(dir)` (which also de-registers the path).
 */
export async function mkTmpDirAsync(prefix, { parent } = {}) {
  if (typeof prefix !== "string" || !prefix) {
    throw new TypeError("mkTmpDirAsync: prefix must be a non-empty string");
  }
  installExitHook();
  const root = parent ?? tmpdir();
  const dir = await mkdtemp(join(root, prefix));
  _tracked.add(dir);
  return dir;
}

/**
 * Async counterpart to `rmTmpDir`. Same contract — de-registers the path
 * from the tracker and performs a recursive removal. Errors are
 * swallowed (best-effort cleanup).
 */
export async function rmTmpDirAsync(path) {
  if (typeof path !== "string" || !path) return;
  _tracked.delete(path);
  try {
    if (existsSync(path)) await rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Create a tracked child directory inside `parentDir`. Same contract as
 * `mkTmpDir` — the child is registered for cleanup, but the canonical
 * pattern with parent directories is to `rmTmpDir(parent)` (which
 * recursively removes every registered child as well).
 */
export function mkSubTmpDir(parentDir, prefix) {
  if (typeof parentDir !== "string" || !parentDir) {
    throw new TypeError("mkSubTmpDir: parentDir must be a non-empty string");
  }
  return mkTmpDir(prefix, { parent: parentDir });
}

/**
 * Test-only inspection helper: how many directories are still tracked
 * for cleanup. Used by the leak-lint script to assert "exactly zero
 * stragglers after a clean run". Not exported through the public surface
 * of test files.
 */
export function _trackedCount() {
  return _tracked.size;
}

/**
 * Test-only inspection helper: snapshot of the tracked directories, in
 * registration order. The leak-lint script diffs snapshots taken before
 * and after the suite to surface untracked creations.
 */
export function _trackedSnapshot() {
  return Array.from(_tracked);
}