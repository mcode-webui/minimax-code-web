// server/routes/git.js — git read-only / branch API (right-panel Git panel).
//
// GET  /api/git/status   ?dir=xxx     workspace status (branch + changed files)
// GET  /api/git/branches ?dir=xxx     local branches + current marker
// GET  /api/git/diff     ?dir=&file=  single-file diff vs HEAD (no-index fallback)
// POST /api/git/checkout {dir, branch} switch local branch (destructive)
//
// Security: every entry point routes `dir` through the shared
// `assertWorkspacePath` gate (same boundary as `/api/fs/*`), so a path
// that lands outside an allowed workspace root is rejected with an
// actionable error before `git` is invoked. `execFile` is used
// throughout — there is no shell, no metacharacter surface.
// `gitCheckout` additionally validates the branch name against a
// local-branch allow-list (regex + leading-dash guard).
//
// The checkout body goes through `readJson` from `lib/read-json.js` —
// the same bounded body reader every other JSON route uses, with the
// 1 MiB cap and `BodyTooLargeError` -> 413 answer. Hand-rolling a
// `req.on('data', ...)` loop would skip that cap and break the repo
// gate (test:release-tools / test-isolation-lint enforces the cap).

import { gitStatus, gitBranches, gitCheckout, gitDiff } from '../lib/git.js'
import { readJson, tryReadJson, BodyTooLargeError } from '../lib/read-json.js'

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function handleGitStatus(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const dir = url.searchParams.get('dir') || ''
  if (!dir) {
    json(res, 400, { ok: false, error: 'missing dir' })
    return Promise.resolve()
  }
  return gitStatus(dir).then((result) => json(res, 200, result))
}

export function handleGitBranches(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const dir = url.searchParams.get('dir') || ''
  if (!dir) {
    json(res, 400, { ok: false, error: 'missing dir' })
    return Promise.resolve()
  }
  return gitBranches(dir).then((result) => json(res, 200, result))
}

export function handleGitDiff(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const dir = url.searchParams.get('dir') || ''
  const file = url.searchParams.get('file') || ''
  if (!dir || !file) {
    json(res, 400, { ok: false, error: 'missing dir/file' })
    return Promise.resolve()
  }
  return gitDiff(dir, file).then((result) => json(res, 200, result))
}

export async function handleGitCheckout(req, res) {
  // `tryReadJson` returns `{ ok, value, tooLarge }` so we can answer
  // 413 directly (with the shared `Connection: close` header) and
  // do not have to re-implement the body cap. A malformed body
  // collapses to `{}` the same way every other route's does, which
  // is the right answer here — the only fields we read are `dir`
  // and `branch`, both string-coerced; an unparseable body just
  // produces "missing dir/branch" via the validation below.
  const r = await tryReadJson(req)
  if (!r.ok) {
    if (r.tooLarge) {
      res.writeHead(413, {
        'Content-Type': 'application/json; charset=utf-8',
        Connection: 'close',
      })
      res.end(JSON.stringify({ ok: false, error: `request body too large (max ${r.limit} bytes)`, code: 'BODY_TOO_LARGE' }))
      return
    }
    // tryReadJson only returns `ok:false` for too-large bodies; other
    // errors propagate as exceptions. Defensive fallback in case a
    // future caller passes an option that triggers another code path.
    json(res, 500, { ok: false, error: 'failed to read request body' })
    return
  }
  const data = r.value
  const dir = typeof data.dir === 'string' ? data.dir : ''
  const branch = typeof data.branch === 'string' ? data.branch : ''
  if (!dir || !branch) {
    json(res, 400, { ok: false, error: 'missing dir/branch' })
    return
  }
  const result = await gitCheckout(dir, branch)
  json(res, 200, result)
}
