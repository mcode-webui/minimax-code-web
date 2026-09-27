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

import { gitStatus, gitBranches, gitCheckout, gitDiff } from '../lib/git.js'

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

export function handleGitCheckout(req, res) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let data
      try { data = JSON.parse(body) } catch {
        json(res, 400, { ok: false, error: 'invalid json' })
        return resolve()
      }
      const dir = typeof data.dir === 'string' ? data.dir : ''
      const branch = typeof data.branch === 'string' ? data.branch : ''
      if (!dir || !branch) {
        json(res, 400, { ok: false, error: 'missing dir/branch' })
        return resolve()
      }
      gitCheckout(dir, branch).then((result) => {
        json(res, 200, result)
        resolve()
      })
    })
  })
}
