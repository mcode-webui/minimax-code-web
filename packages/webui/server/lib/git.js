// server/lib/git.js — git CLI wrapper (zero npm deps, uses the OS `git` binary).
//
// Used by the right-panel Git panel (slice 03 of webui-parity): workspace
// status (porcelain v1 + branch / upstream), local-branch list,
// single-file diff against HEAD with a no-index fallback for untracked
// files, and a destructive branch-switch gated by a local-branch
// allow-list.
//
// Security invariants — these are pinned by `test/routes/git.test.js`
// and the ticket acceptance criteria, not just by code review:
//
//   1. **execFile, never shell.** `run(dir, args)` uses
//      `child_process.execFile('git', ['-C', dir, ...args], …)` so
//      every argv element is passed as a literal to the child process
//      and there is no shell metacharacter surface at all.
//
//   2. **Containment gate.** Every entry point routes the requested
//      `dir` through `assertWorkspacePath` (the same gate `/api/fs/*`
//      uses), so an out-of-root path is rejected before `git` is even
//      invoked.
//
//   3. **Local-branch allow-list.** `gitCheckout` matches the branch
//      name against `BRANCH_RE` (letters / digits / dot / underscore /
//      hyphen / slash) and additionally rejects names that start with
//      `-` (defence-in-depth: even though `execFile` does not interpret
//      argv as a shell, a stray `--upload-pack=…` style branch name
//      would still be passed as an argv element to `git` and could be
//      re-interpreted as a `git` option by the binary itself).
//
//   4. **`--` separator.** `gitDiff` always passes the user-supplied
//      `file` after a `--` token, so a filename like `--output=/etc/x`
//      cannot be re-interpreted as a `git diff` option. The same input
//      is additionally rejected by the explicit `startsWith('-')`
//      guard so we never even try to invoke `git` with a name that
//      starts with a dash.
//
//   5. **File-axis containment.** `gitDiff` resolves `file` against
//      the contained `dir` and requires the result's realpath to stay
//      inside the directory's realpath. Absolute paths, `..`-prefixed
//      paths, and symlink escapes are all rejected — without this an
//      attacker could pass `?file=/etc/hostname` and read any
//      server-readable file through the `--no-index -- /dev/null <file>`
//      fallback (the ticket invariant "file 参数不得逃逸工作区").

import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { assertWorkspacePath } from './workspace.js'

const TIMEOUT_MS = 10000
const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/

function run(dir, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 4 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: (stderr || err.message).trim() })
        else resolve({ ok: true, stdout })
      },
    )
  })
}

// Like `run`, but preserves the exit code so callers that need to
// distinguish "diff was found" (exit 1 for `git diff --no-index`)
// from "real error" can do so without re-parsing stderr.
function runRaw(dir, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 4 },
      (err, stdout, stderr) => {
        // When execFile succeeds (no thrown error), err is null and
        // the exit code is 0. When it fails, err.code carries the
        // exit status — including the special case `code === null`
        // for signal-terminated children.
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout: stdout || '', stderr: stderr || '', error: err ? err.message : null })
      },
    )
  })
}

// Containment gate. `assertWorkspacePath` does the realpath-based
// containment check internally (see `lib/workspace.js#resolveWithinRoots`)
// but returns the *literal* request path as `path` — that is the right
// shape for `/api/fs/*` (their handlers pass the path to `statSync` /
// `readdirSync`, which realpath themselves). For the git routes we
// want a SINGLE canonical spelling of the dir: we want `git -C <dir>`
// and the file-axis containment comparison to talk about the same
// string, so a symlinked root cannot produce two different spellings
// of the same directory (macOS's `/var` → `/private/var` is the canonical
// case where this matters — without this canonicalisation, the literal
// request path would be passed to `git -C` while the realpath was
// used for the gateFile comparison, and any platform where the
// temp root traverses a symlink could produce a mismatch the test
// could not catch).
//
// Returns the realpath'd dir on success, or null when containment
// rejects the input. The route uses this single canonical string
// for `git -C` AND the file-axis comparison AND the containment
// check — they cannot diverge, regardless of the platform's temp
// symlink layout.
function gate(dir) {
  const gateResult = assertWorkspacePath(dir)
  if (!gateResult.ok) return null
  try {
    return realpathSync(gateResult.path)
  } catch {
    // The containment check inside `assertWorkspacePath` already
    // realpath'd the path; if it succeeded there, `realpathSync`
    // here should not fail. Fall back to the literal only as a
    // last resort — better to keep serving the request than to
    // reject it on a transient FS hiccup.
    return gateResult.path
  }
}

// Resolve a user-supplied `file` against the contained workspace dir
// and verify the result's realpath stays inside the dir's realpath.
// Four classes of escape are rejected:
//
//   - absolute paths (`/etc/hostname`, `C:\\Windows\\…`) — `git diff
//     -C <dir> -- /etc/hostname` would be re-anchored to <dir>, but
//     `git diff --no-index -- /dev/null /file` would read the
//     absolute path verbatim. We forbid these up front.
//   - `..`-prefixed paths — covered by the relative() check.
//   - symlinks (live OR dangling) that resolve outside the dir —
//     the lstatSync + realpathSync pair below catches both. The
//     previous "fall back to the unresolved path on realpathSync
//     error" was a real hole: a dangling symlink like
//     `repoDir/dangling-link → /etc/whatever-does-not-exist` would
//     throw ENOENT on realpathSync, the fallback would substitute
//     the unresolved path (which is by construction inside repoDir),
//     and the request would be admitted. The macOS CI caught this
//     because `/etc/hostname` does not exist on macOS runners
//     (Linux has it; macOS dropped it years ago).
//   - a parent directory outside the workspace — proved up front by
//     `realpathSync(resolve(absDir, dirname(file)))`.
//
// Returns the resolved file path on success, null on any escape. The
// caller treats null as "reject the request before invoking git".
function gateFile(dir, file) {
  if (typeof file !== 'string' || file.length === 0) return null
  // Absolute path — reject. This is the surface the acceptance
  // findings flagged: a request like
  //   GET /api/git/diff?dir=<workspace>&file=/etc/hostname
  // would otherwise let `--no-index -- /dev/null /etc/hostname`
  // read any server-readable file.
  if (isAbsolute(file)) return null
  // Up-front belt-and-braces guards: leading `-` (option injection
  // through `git diff` argv) and `..` (traversal that the relative()
  // check below already catches but we deny earlier for clarity).
  if (file.startsWith('-') || file.includes('..')) return null
  let absDir
  try {
    absDir = realpathSync(dir)
  } catch {
    return null
  }
  const resolved = resolve(absDir, file)
  // Prove the parent directory is inside the workspace — that
  // is the real containment invariant. The parent MUST resolve
  // (it must exist; `git diff` cannot stat a file whose parent
  // does not exist). A file path whose parent realpath's outside
  // the workspace is rejected even if the leaf itself does not
  // exist yet.
  const parentResolved = dirname(resolved)
  let parentReal
  try {
    parentReal = realpathSync(parentResolved)
  } catch {
    // Parent does not exist — the file cannot be in any tracked
    // or untracked state, so this is not a workspace file at all.
    return null
  }
  const parentRel = relative(absDir, parentReal)
  if (parentRel === '..' || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
    return null
  }
  // The parent is contained. Now decide the leaf:
  //   - regular file / directory on disk → contained-leaf check
  //     (realpath must stay inside repoDir).
  //   - symlink (live or dangling) → resolve it; if realpath fails,
  //     the link is dangling and the request is rejected (a dangling
  //     symlink could be created at any moment to point at an
  //     arbitrary target — admitting it would re-open the
  //     containment hole that the symlink test was supposed to pin).
  //   - does not exist → allow (legitimate "brand-new untracked
  //     file" case; the parent has already been proven contained).
  let st
  try {
    st = lstatSync(resolved)
  } catch (e) {
    if (e && e.code === 'ENOENT') return resolved
    return null
  }
  if (st.isSymbolicLink()) {
    // Symlink — resolve and re-check. A dangling symlink fails
    // here; that is the desired rejection.
    let realFile
    try {
      realFile = realpathSync(resolved)
    } catch {
      return null
    }
    const rel = relative(absDir, realFile)
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return realFile
    }
    return null
  }
  // Regular file or directory: realpath must stay inside the
  // workspace. A hard link to outside the workspace would still
  // resolve inside (realpath follows hard links to their target
  // inode), so the containment check is the right final guard.
  let realFile
  try {
    realFile = realpathSync(resolved)
  } catch {
    return null
  }
  const rel = relative(absDir, realFile)
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return realFile
  }
  return null
}

// Workspace status: branch + upstream + ahead/behind + changed files.
// `git status --porcelain=v1 -b` gives a single deterministic stream
// (one header line `## <branch>[...<upstream>] [ahead N, behind M]`
// followed by the per-file entries). Not-a-git-repo is not an error:
// the panel shows an empty state, not a red toast.
export async function gitStatus(dir) {
  const abs = gate(dir)
  if (!abs) return { ok: false, isRepo: false, error: '目录不在允许范围内' }
  const res = await run(abs, ['status', '--porcelain=v1', '-b'])
  if (!res.ok) {
    const notRepo = /not a git repository|不是 git 仓库/i.test(res.error || '')
    return { ok: false, isRepo: !notRepo, error: notRepo ? '不是 git 仓库' : res.error }
  }
  const lines = res.stdout.split('\n').filter((l) => l !== '')
  let branch = null
  let upstream = null
  let ahead = 0
  let behind = 0
  const files = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      // Branch header regex (deliberately permissive — see pr-22 § gitStatus):
      //   <localBranch>[...<upstream>] [ahead N, behind M]
      // Both halves are optional (detached HEAD, brand-new branch with no
      // upstream, etc.).
      const m = /^([^\.\s]+)(?:\.{3}(\S+))?(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(head)
      if (m) {
        branch = m[1] || null
        upstream = m[2] || null
        ahead = Number(m[3] || 0)
        behind = Number(m[4] || 0)
      }
      continue
    }
    const x = line[0]
    const y = line[1]
    let path = line.slice(3)
    let origPath = null
    const rename = /^(.+) -> (.+)$/.exec(path)
    if (rename) {
      origPath = rename[1]
      path = rename[2]
    }
    files.push({ x, y, path, origPath, staged: x !== ' ' && x !== '?' })
  }
  return { ok: true, isRepo: true, branch, upstream, ahead, behind, files }
}

// Local branch list + current marker. We deliberately do NOT use
// `--format=%(refname:short)` because it strips the `* ` marker that
// the default `--list` output uses to indicate the current branch;
// we'd then lose the only signal we have for `current`. `--no-color`
// keeps the output machine-stable when stdout is a TTY (otherwise
// an ANSI prefix would slip into the parsed name).
export async function gitBranches(dir) {
  const abs = gate(dir)
  if (!abs) return { ok: false, error: '目录不在允许范围内' }
  const res = await run(abs, ['branch', '--list', '--no-color'])
  if (!res.ok) return { ok: false, error: res.error }
  const branches = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((raw) => {
      // Default `git branch --list` emits `* main` for the current
      // branch and `  main` (or `  remotes/…`) for the rest. The
      // leading whitespace is what we strip.
      if (raw.startsWith('* ')) return { name: raw.slice(2).trim(), current: true }
      return { name: raw, current: false }
    })
  return { ok: true, branches }
}

// Switch to a local branch. Branch name goes through:
//   - `BRANCH_RE` — letters / digits / dot / underscore / hyphen / slash
//   - `!startsWith('-')` — defends against a branch name like
//     `--upload-pack=…` that `git checkout` would otherwise parse as its
//     own option (even with `execFile`, `git` itself reads argv).
// The actual allow-list is the set of names returned by `gitBranches`,
// enforced client-side at the panel layer (the switcher only offers
// names from the server's list); this server-side guard is the
// defence-in-depth that survives a forged request from any client.
export async function gitCheckout(dir, branch) {
  const abs = gate(dir)
  if (!abs) return { ok: false, error: '目录不在允许范围内' }
  if (!BRANCH_RE.test(branch) || branch.startsWith('-')) {
    return { ok: false, error: '非法分支名' }
  }
  const res = await run(abs, ['checkout', branch])
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true }
}

// Single-file diff against HEAD, with a no-index fallback for untracked
// files (`git diff HEAD -- <file>` returns nothing for a brand-new file
// because `HEAD` has no entry for it; `git diff --no-index -- /dev/null
// <file>` produces a synthetic all-add diff).
//
// The `--` separator is the option-injection boundary — without it,
// `git diff --output=/etc/x` would write the diff to `/etc/x`.
// `startsWith('-')` is the belt-and-braces guard that makes the
// separator ungameable from the HTTP layer.
//
// The `file` argument is also containerised via `gateFile` (absolute
// paths rejected, `..` rejected, realpath must stay inside the dir) —
// without this an absolute path would slip through `--no-index --
// /dev/null <file>` and read any server-readable file. See invariant
// (5) in the header.
//
// `git diff --no-index` exits with code 1 when the two paths differ,
// which is the documented "diff was found" code (see `man git-diff`).
// `run()` treats any non-zero exit as a generic error, so the
// no-index branch passes `null` as the expected-error sentinel and
// inspects stdout / stderr directly. The first branch (`diff HEAD`)
// exits 0 with empty stdout when nothing changed, so its `err.code === 1`
// does NOT trip this — only `err.code !== 0 && err.code !== 1` would.
export async function gitDiff(dir, file) {
  const abs = gate(dir)
  if (!abs) return { ok: false, diff: '', error: '目录不在允许范围内' }
  const safeFile = gateFile(abs, file)
  if (!safeFile) return { ok: false, diff: '', error: '非法路径' }
  // Pass the contained, resolved path so the post-containment file
  // is what `git` actually reads. The `--` separator is the argv-side
  // boundary; `gateFile` is the path-side boundary.
  const headDiff = await runRaw(abs, ['diff', 'HEAD', '--', safeFile])
  if (headDiff.code === 0 && headDiff.stdout.trim() !== '') {
    return { ok: true, diff: headDiff.stdout }
  }
  // HEAD diff produced nothing (file is untracked or matches HEAD).
  // Try no-index vs /dev/null to get a synthetic all-add diff.
  const noIndex = await runRaw(abs, ['diff', '--no-index', '--', '/dev/null', safeFile])
  if (noIndex.code === 0 || noIndex.code === 1) {
    // exit 1 means "files differ" — that IS the success case for
    // no-index (it has no working tree to compare against).
    return { ok: true, diff: noIndex.stdout }
  }
  return { ok: false, diff: '', error: (noIndex.stderr || noIndex.error || '').trim() || 'git diff failed' }
}
