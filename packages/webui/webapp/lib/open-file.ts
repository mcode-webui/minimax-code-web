// webapp/lib/open-file.ts
//
// The single-source "open.file.in.web" capability (webui-parity 12).
//
// Two entry points — the file tree (空间目录) and the turn summary
// (轮次总结, `ActivitySummary`) — both have to land on the same
// right-hand preview pane. Keeping that "one action, one preview
// surface" promise means the action itself must live in one module:
// this file. Every renderer that wants to open a file calls
// `openFileInWeb(path)`; every renderer that wants to show the
// preview subscribes via `subscribeOpenFile`. There is no second
// "open logic" anywhere — the unit test in
// `webapp/test/open-file.test.ts` pins this by grepping the source
// tree for callers.
//
// Persistence channel: `localStorage` under `webui:open-file:path`.
// The key shares the prefix slice 01 established (`webui:files-tree:…`,
// see `lib/files-tree.ts`), so the on-disk namespace stays one
// family. Slice 01 stores per-workspace expansion in `sessionStorage`
// (a tab-scoped channel — the right choice for ephemeral UI state);
// the open-file path is a single global value the user expects to
// survive a refresh, so `localStorage` is the right fit. Slice 07
// ("reopen-state parity") will own the cross-restart durability
// migration and may promote this value to its server-side settings
// store; until then `localStorage` carries the refresh-survival
// guarantee the ticket pins.

const STORAGE_KEY = "webui:open-file:path";

export type OpenFileListener = (path: string | null) => void;

const listeners = new Set<OpenFileListener>();

// Module-level mirror so synchronous reads (tests, non-React callers)
// don't have to hit storage. The subscriber API is the primary contract;
// this is a small optimisation on top of the same value.
let currentPath: string | null = null;

function readPersisted(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Disabled storage / quota / privacy mode — best-effort, the in-memory
    // value is the source of truth for the lifetime of the page.
    return null;
  }
}

function writePersisted(value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Best-effort — see readPersisted().
  }
}

function notify(value: string | null): void {
  currentPath = value;
  for (const listener of listeners) listener(value);
}

/**
 * Open a file in the right-hand preview pane.
 *
 * The action is idempotent: re-opening the same path is a no-op for
 * the listener side, but the persistence write still runs so a
 * tab-close / refresh reopens the same file. Returns the value that
 * was just published, mostly so tests can assert without having to
 * subscribe.
 */
export function openFileInWeb(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("openFileInWeb requires a non-empty path");
  }
  writePersisted(path);
  notify(path);
  return path;
}

/**
 * Close the preview pane back to its empty state.
 *
 * No-op when nothing is open — useful in keyboard handlers that
 * always fire on Escape.
 */
export function closeOpenFile(): void {
  writePersisted(null);
  notify(null);
}

/**
 * Read the currently-open file path without subscribing. Synchronous,
 * so it is safe to call from render code (the value is updated
 * synchronously inside `openFileInWeb` / `closeOpenFile`).
 *
 * On first read after page load the function falls back to
 * `localStorage`, so a refresh sees the path the previous page had
 * open. After the first call the in-memory mirror is the source of
 * truth.
 */
export function getOpenFilePath(): string | null {
  if (currentPath !== null) return currentPath;
  const persisted = readPersisted();
  currentPath = persisted;
  return persisted;
}

/**
 * Subscribe to open / close events. The listener fires with the
 * current path on subscribe (so a freshly-mounted component picks up
 * the existing state without a separate `getOpenFilePath()` call)
 * and again on every `openFileInWeb` / `closeOpenFile`. Returns the
 * unsubscribe function.
 */
export function subscribeOpenFile(listener: OpenFileListener): () => void {
  listeners.add(listener);
  // Seed the subscription so the listener does not have to call
  // `getOpenFilePath()` separately to read the current value. Fall
  // through to the persisted value when the in-memory mirror is
  // empty — that is the refresh-survival path.
  listener(currentPath ?? readPersisted());
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only handle: clear module state between tests. Production
 * code never calls this.
 */
export function __testReset(): void {
  listeners.clear();
  currentPath = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // best-effort
    }
  }
}