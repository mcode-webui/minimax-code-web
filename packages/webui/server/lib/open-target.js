// webui/server/lib/open-target.js
//
// Helpers for "open this file with the OS" — used by `POST /api/fs/open-default`
// (hand the path off to the platform default application) and
// `POST /api/fs/reveal` (point the file manager at the file's parent directory
// and select the file). Both run inside the same containment gate the other
// `/api/fs/*` routes use.
//
// Security invariants (pinned by `test/routes/fs-open-target.test.js` and the
// ticket acceptance criteria, not just by code review):
//
//   1. **`execFile`, never shell.** The opener is invoked through
//      `child_process.execFile(bin, argv, …)` so every argv element is
//      passed as a literal to the child process — there is no shell
//      metacharacter surface at all. The bin itself is a constant from the
//      platform map (`open` on macOS, `start` / `explorer` on Windows,
//      `xdg-open` / `gio` on Linux) so user input never enters the
//      executable name.
//
//   2. **Containment gate.** Every entry point routes the requested path
//      through `assertWorkspacePath` (the same gate `/api/fs/*` uses) and
//      a realpath-based per-node containment that mirrors `gateFile` in
//      `lib/git.js`. A dangling or external symlink is rejected; a path
//      resolving outside the allowed roots is rejected.
//
//   3. **Must be an existing regular file.** Directories, devices, sockets,
//      FIFOs and non-existent paths are rejected with a 400. The opener
//      receives an absolute, contained, realpath'd regular file — there is
//      no way to hand it a directory under any other name.
//
//   4. **Explicit "no opener" error.** When no opener binary is available on
//      the host (e.g. a headless Linux container without `xdg-open` /
//      `gio`) the helper answers `{ ok:false, code:"no-opener" }` instead
//      of spawning something that ENOENTs. The route returns that as a
//      structured error so the UI can disable the button rather than
//      silently failing on click.

import { execFile } from "node:child_process"
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { assertWorkspacePath, assertWorkspaceParentPath } from "./workspace.js"

const SPAWN_TIMEOUT_MS = 5000
// `xdg-open` and friends fork-and-exit almost immediately; a 5-second
// window is generous (a hung opener is a platform bug, not user input).

/**
 * Per-platform opener recipe. Each entry is the argv vector the helper
 * passes to `execFile` — argv elements are literals, no shell, and the
 * binary is the first element (looked up via `which`-style probing before
 * the call so a headless host can answer without spawning).
 *
 * Linux has two real contenders:
 *   - `xdg-open` (most desktop environments; the freedesktop standard).
 *   - `gio open` (the GNOME-side fallback that ships even when xdg-open
 *      is missing — common on Alpine / minimal images).
 *
 * The helper tries both, in order, and the first one that the host has on
 * PATH wins. macOS uses `open`, Windows uses `cmd.exe /c start ""` —
 * `start` is a cmd builtin, so we have to spawn the shell; the argv
 * sequence below is the canonical "start with empty title" idiom, which
 * is what the Win32 docs recommend to keep the literal next argument from
 * being interpreted as the window title.
 */
const PLATFORM_OPENERS = {
  darwin: [{ bin: "open", prefix: [] }],
  linux: [
    { bin: "xdg-open", prefix: [] },
    { bin: "gio", prefix: ["open"] },
  ],
  win32: [{ bin: "cmd.exe", prefix: ["/c", "start", ""] }],
}

/**
 * Reveal recipes. macOS's `open -R` is the canonical "reveal in Finder"
 * idiom. Windows uses `explorer.exe /select,<path>` — note the lack of
 * space after the comma, which is what `explorer` expects. Linux file
 * managers don't have a single "reveal" command, so we open the parent
 * directory with the same opener the open-default path uses — that is the
 * honest cross-platform fallback (the UI explains it).
 */
const PLATFORM_REVEALERS = {
  darwin: [{ bin: "open", prefix: ["-R"] }],
  win32: [{ bin: "explorer.exe", prefix: ["/select,"], argvSuffix: true }],
  linux: [
    { bin: "xdg-open", prefix: [] },
    { bin: "gio", prefix: ["open"] },
  ],
}

/**
 * Locate the first available opener on the host.
 *
 * Returns `{ bin, prefix }` when one is available, `null` otherwise. We
 * probe with `which`-style PATH lookup (the `which` package would be the
 * idiomatic answer, but this module ships with zero npm dependencies —
 * slice 03 set the precedent in `lib/git.js`).
 */
function findOpener(recipes) {
  for (const recipe of recipes) {
    if (pathHasBinary(recipe.bin)) {
      return recipe
    }
  }
  return null
}

/**
 * `which`-style PATH probe. Returns true when the binary resolves to a
 * runnable on PATH (or is an absolute path that exists on disk).
 *
 * `child_process.execFile` would ENOENT for a missing binary, but the
 * helper wants to answer a structured "no opener" before spawning, so
 * the explicit probe is worth the ten lines.
 *
 * The PATH separator is platform-specific — POSIX uses `:`, Windows
 * uses `;`. We do NOT do clever regex splitting on the first char
 * because Windows drive letters (`C:`) and POSIX absolute paths
 * (`/usr/bin`) collide; a single-character split is correct.
 */
function pathHasBinary(bin) {
  if (isAbsolute(bin)) {
    try {
      return statSync(bin).isFile()
    } catch {
      return false
    }
  }
  const sep = process.platform === "win32" ? ";" : ":"
  const path = process.env.PATH || ""
  const dirs = path.split(sep).filter(Boolean)
  for (const dir of dirs) {
    try {
      const candidate = resolve(dir, bin)
      if (existsSync(candidate)) return true
    } catch {
      // PATH segments can be malformed; skip and try the next one.
    }
  }
  return false
}

/**
 * Containment gate for "open / reveal" — same boundary as `/api/fs/*`,
 * with a per-node realpath check that mirrors `gateFile` in `lib/git.js`.
 *
 *   - out-of-root path (literal or after realpath) → rejected
 *   - non-existent path → rejected (we need to actually open a file)
 *   - directory / device / fifo → rejected
 *   - symlink (live or dangling) → resolved; live escapes are rejected,
 *     dangling links are rejected too — same defence-in-depth slice 03
 *     shipped for `git diff`.
 *
 * The strategy is parent-first containment (slice 02's
 * `assertWorkspaceParentPath`): we prove the parent directory lives
 * inside an allowed root, then prove the leaf is a regular file. The
 * parent-first pattern lets a non-existent leaf still pass containment
 * (the parent is real) before failing the regular-file check — that
 * distinction is what lets the UI render "this path doesn't exist"
 * rather than "out of bounds".
 *
 * Returns the realpath'd absolute path on success, or `null` on any
 * rejection. The caller pairs `null` with a structured error so the UI
 * can render an actionable hint rather than a red toast.
 */
function gateRegularFile(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null
  // Parent-first containment: prove the directory the leaf lives in
  // is inside an allowed root. `assertWorkspaceParentPath` does not
  // require the leaf to exist (the leaf is exactly what we want to
  // classify next), and the parent IS real — so realpathSync
  // succeeds and the boundary is clean.
  const parentGate = assertWorkspaceParentPath(rawPath)
  if (!parentGate.ok) return null
  const resolved = parentGate.path

  let real
  try {
    real = realpathSync(resolved)
  } catch {
    // Realpath failed — either the file does not exist (ENOENT) or
    // permission was denied (EACCES). Either way the opener has no
    // target. The parent gate passed, so this is a leaf-shape
    // failure, not a containment failure.
    return null
  }

  // Re-prove containment on the realpath. `assertWorkspaceParentPath`
  // already walked the parent; doing it again on the leaf catches
  // the case where the leaf realpath is a symlink target that lives
  // outside the parent's root (e.g. `workDir/leak → /etc/hostname`).
  // `assertWorkspacePath` (vs Parent) is what proves the resolved
  // file itself is still inside an allowed root.
  const reGate = assertWorkspacePath(real)
  if (!reGate.ok) return null

  let st
  try {
    st = lstatSync(real)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) {
    // Should not happen — realpathSync above resolves symlinks — but
    // defence-in-depth: a symlink whose realpath we just computed
    // must already be inside the gate, and we re-checked above.
    // Reject on any remaining doubt rather than let the opener
    // follow a link the gate did not inspect.
    return null
  }
  if (!st.isFile()) {
    // Directory / device / fifo — not what the user asked to "open".
    return null
  }
  return real
}

/**
 * Run the opener with the contained file as the only user input.
 *
 * The argv array is built per-platform from the recipe table above. No
 * element is ever a shell string; the only place `execFile` is called
 * uses literal argv.
 *
 * Resolves to `{ ok: true }` on a clean spawn, or `{ ok:false, code,
 * error }` when the spawn itself fails (ENOENT is the most common case
 * — the recipe found a binary in `which`-style probing but the path
 * moved between probe and spawn). On Windows the `start` builtin forks
 * and exits immediately, so any non-zero exit code we observe is from
 * `cmd.exe` itself, not from the application it launched.
 */
function runOpener(recipe, argv) {
  return new Promise((resolve) => {
    execFile(
      recipe.bin,
      argv,
      {
        timeout: SPAWN_TIMEOUT_MS,
        // Detached on Linux/macOS so the opener is free to outlive the
        // webui process — without this, killing the dev server would
        // also kill the user's PDF viewer. `windowsHide` keeps the
        // intermediate cmd.exe flash suppressed.
        detached: process.platform !== "win32",
        windowsHide: true,
        // stdio:ignore — the opener is a GUI launch; its stdout / stderr
        // is meaningless here and we don't want it polluting the
        // server logs.
        stdio: "ignore",
      },
      (err) => {
        if (err) {
          resolve({
            ok: false,
            code: "spawn-failed",
            error: err.message || String(err),
          })
          return
        }
        resolve({ ok: true })
      },
    )
  })
}

/**
 * Open a file with the OS default application.
 *
 * Returns `{ ok:false, code, error }` on:
 *   - `"missing-path"` / `"out-of-bounds"` (containment rejected)
 *   - `"not-a-regular-file"` (directory / device / symlink)
 *   - `"no-opener"` (no binary on PATH)
 *   - `"spawn-failed"` (binary ENOENTed at exec time)
 *
 * The structured codes let the UI branch without parsing free-form text.
 */
export async function openWithDefault(rawPath) {
  const real = gateRegularFile(rawPath)
  if (!real) {
    return {
      ok: false,
      code: classifyRejection(rawPath),
      error: "path not reachable",
    }
  }
  const recipes = PLATFORM_OPENERS[process.platform] || PLATFORM_OPENERS.linux
  const recipe = findOpener(recipes)
  if (!recipe) {
    return {
      ok: false,
      code: "no-opener",
      error: "no GUI opener available on this host",
    }
  }
  return runOpener(recipe, [...recipe.prefix, real])
}

/**
 * Reveal a file in the platform file manager.
 *
 * `open -R` on macOS, `explorer.exe /select,<file>` on Windows,
 * `xdg-open <dir>` (parent directory) on Linux — there is no portable
 * "select this row" command on the freedesktop side, so the Linux
 * fallback opens the parent directory. The UI is expected to disable the
 * "select" affordance on Linux when the platform lookup returns the
 * parent-only recipe, but the current contract is "always open the
 * parent if no select is available" so the user at least lands somewhere
 * useful.
 */
export async function revealInFileManager(rawPath) {
  const real = gateRegularFile(rawPath)
  if (!real) {
    return {
      ok: false,
      code: classifyRejection(rawPath),
      error: "path not reachable",
    }
  }
  const recipes = PLATFORM_REVEALERS[process.platform] || PLATFORM_REVEALERS.linux
  const recipe = findOpener(recipes)
  if (!recipe) {
    return {
      ok: false,
      code: "no-opener",
      error: "no file manager available on this host",
    }
  }
  // Windows' `/select,` syntax requires the path glued to the comma
  // (the comma is the separator and there is no escape). `argvSuffix`
  // flags the recipe so the helper can append the file to the LAST
  // prefix element rather than as its own argv slot. macOS uses `-R`
  // as its own element. Linux uses the parent directory because file
  // managers don't agree on a select idiom.
  let argv
  if (recipe.argvSuffix) {
    const head = recipe.prefix.slice(0, -1)
    const tail = recipe.prefix[recipe.prefix.length - 1]
    argv = [...head, `${tail}${real}`]
  } else if (process.platform === "linux") {
    argv = [...recipe.prefix, dirname(real)]
  } else {
    argv = [...recipe.prefix, real]
  }
  return runOpener(recipe, argv)
}

/**
 * Map a path that did not pass the gate to the structured rejection code
 * the UI keys off of. The intent is to keep the wire shape stable so the
 * component can branch on `code` without parsing free-form text.
 *
 * Mirrors the parent-first containment strategy `gateRegularFile` uses
 * (see that function's header): if the parent is inside the allowed
 * roots but the leaf is a non-existent file or a directory, the
 * rejection is `not-a-regular-file`; only when the parent itself is
 * out of bounds do we surface `out-of-bounds`.
 */
function classifyRejection(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return "missing-path"
  }
  // Parent-first: if the parent is out of bounds, the request cannot
  // reach the file at all. Otherwise the leaf shape is the issue.
  const parentGate = assertWorkspaceParentPath(rawPath)
  if (!parentGate.ok) return "out-of-bounds"
  // Parent was contained. Either the leaf doesn't exist, it's a
  // directory, or a symlink escape invalidated it. The wire error
  // stays coarse; the UI can drill in.
  return "not-a-regular-file"
}

/**
 * Diagnostic helper used by the route's "is this host even capable"
 * probe. Returns the resolved recipe's bin (so the route can log it on
 * failure) or `null` when nothing is available. Tests use this to pin
 * the per-platform recipe table without exercising `execFile` itself.
 */
export function _probeOpeners() {
  const open = PLATFORM_OPENERS[process.platform] || PLATFORM_OPENERS.linux
  const reveal = PLATFORM_REVEALERS[process.platform] || PLATFORM_REVEALERS.linux
  return {
    open: findOpener(open),
    reveal: findOpener(reveal),
    platform: process.platform,
  }
}
