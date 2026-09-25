// scripts/lib/dev-watch-scope.mjs
// The dev backend watcher's include-list filter.
//
// Node 24's `--watch` flag follows the entire module graph: an mtime
// change inside any transitively imported file (notably
// `node_modules/@hono/node-server/dist/*.mjs` after a sibling
// worktree's `pnpm install` activity reaches this checkout through
// the shared pnpm-store hardlinks) restarts the backend. With the
// old "any change restarts" behaviour the SIGTERM landed on a
// backend mid-cleanup, `server.close()` waited on a live SSE
// socket, and the process wedged — the watcher saw it alive but
// not listening and refused to spawn a replacement.
//
// `fs.watch({ recursive: true })` lets us scope the watch to the
// `server/` directory tree and ignore `node_modules`/`.next`/
// `dist`/etc, while keeping the "restart on save" affordance.
//
// Exported separately so the dev-webui.mjs launcher can import
// without pulling in child_process / process.on side effects, and
// so scripts/dev-webui.test.mjs can pin every branch with a
// dependency-free unit test.

// v2 (session-isolation/05 forensic): also exclude the pnpm global
// store path (`~/.local/share/pnpm/store/v3/files/...`) explicitly.
// `fs.watch` reports paths under the symlinked `node_modules/` so
// the `/node_modules/` substring check already covers them, but the
// pnpm-store hardlink chain was the *original* SIGTERM wedge
// trigger — a defense-in-depth that pins the exact path means a
// future change to the substring check (or a refactor that
// normalises the path differently) cannot silently re-introduce
// the wedge. The path is read once at module load and cached.
import { homedir } from "node:os";
import { join } from "node:path";

function pnpmStorePrefix() {
  // Pnpm respects XDG conventions: `$XDG_DATA_HOME/pnpm/store` or
  // `$HOME/.local/share/pnpm/store`. Read HOME directly so the
  // cached prefix survives a later `process.chdir`.
  const home = process.env.HOME || homedir();
  return join(home, ".local", "share", "pnpm", "store");
}
const PNPM_STORE_PREFIX = pnpmStorePrefix();

/**
 * Returns true when `filename` is part of the backend's source
 * tree and a save should restart the dev backend. The argument is
 * the filename `fs.watch` emits — on Linux an absolute path, on
 * macOS sometimes a relative path, on Windows a backslash-separated
 * absolute path. The function normalises separators and matches on
 * the path component (no `existsSync` round-trip; the watcher does
 * not need to read the disk).
 */
export function shouldWatchFile(filename) {
  if (!filename) return false;
  // Defense-in-depth: the pnpm global store path. Any file under
  // this prefix is a pnpm-internal hardlink target — a sibling
  // worktree's `pnpm install` rewrites it, mtime propagates
  // through every hardlink, and the watcher would (under --watch)
  // restart the backend. Even though the `/node_modules/` check
  // below already excludes the symlinked path, an explicit prefix
  // excludes the in-place pnpm-store path too (relevant if a future
  // refactor decides to watch the store directly for some reason).
  if (PNPM_STORE_PREFIX && filename.startsWith(PNPM_STORE_PREFIX)) return false;
  // fs.watch on Linux emits absolute paths, on macOS it can
  // emit relative paths; POSIX and Windows separators both appear
  // in real-world fs.watch output.
  const normalized = filename.replace(/\\/g, "/");
  // The backend's source is packages/webui/server.js + server/.
  // Anything else — node_modules, .next, dist, .turbo caches, the
  // webapp/, third_party/ — is not our code and must not trigger
  // a restart. The first match wins; later includes do not undo
  // an earlier exclude.
  if (normalized.includes("/node_modules/")) return false;
  if (normalized.endsWith("/node_modules")) return false;
  if (normalized.includes("/.next/")) return false;
  if (normalized.endsWith("/.next")) return false;
  if (normalized.includes("/.turbo/")) return false;
  if (normalized.endsWith("/.turbo")) return false;
  if (normalized.includes("/dist/")) return false;
  if (normalized.endsWith("/dist")) return false;
  if (normalized.includes("/webapp/")) return false;
  if (normalized.endsWith("/webapp")) return false;
  if (normalized.includes("/third_party/")) return false;
  if (normalized.endsWith("/third_party")) return false;
  if (normalized.includes("/.git/")) return false;
  if (normalized.endsWith("/.git")) return false;
  if (normalized.endsWith("/.DS_Store")) return false;
  if (normalized.endsWith(".swp")) return false;
  if (normalized.endsWith(".tmp")) return false;
  // Source-only: anything under packages/webui/server.js (the
  // entry point) or packages/webui/server/. Files outside are
  // not the backend's code.
  return (
    normalized.endsWith("/server.js") ||
    normalized.includes("/server/") ||
    normalized === "server.js"
  );
}