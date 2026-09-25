// server/routes/git.js —— git 只读/分支 API（webui-react 右栏 Git 面板）
//
// GET  /api/git/status   ?dir=xxx      工作区状态（分支 + 变更文件）
// GET  /api/git/branches ?dir=xxx      本地分支列表 + 当前分支
// GET  /api/git/diff     ?dir=&file=   单文件相对 HEAD 的 diff
// POST /api/git/checkout {dir, branch} 切换分支
//
// 目录经 assertWorkspacePath 允许根校验；execFile 无 shell。

import { gitStatus, gitBranches, gitCheckout, gitDiff } from '../lib/git.js'

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function handleGitStatus(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const dir = url.searchParams.get('dir') || ''
  if (!dir) return json(res, 400, { ok: false, error: 'missing dir' })
  gitStatus(dir).then((result) => json(res, result.ok ? 200 : 200, result))
}

export function handleGitBranches(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const dir = url.searchParams.get('dir') || ''
  if (!dir) return json(res, 400, { ok: false, error: 'missing dir' })
  gitBranches(dir).then((result) => json(res, 200, result))
}

export function handleGitDiff(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const dir = url.searchParams.get('dir') || ''
  const file = url.searchParams.get('file') || ''
  if (!dir || !file) return json(res, 400, { ok: false, error: 'missing dir/file' })
  gitDiff(dir, file).then((result) => json(res, 200, result))
}

export function handleGitCheckout(req, res) {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let data
    try { data = JSON.parse(body) } catch {
      return json(res, 400, { ok: false, error: 'invalid json' })
    }
    const dir = typeof data.dir === 'string' ? data.dir : ''
    const branch = typeof data.branch === 'string' ? data.branch : ''
    if (!dir || !branch) return json(res, 400, { ok: false, error: 'missing dir/branch' })
    gitCheckout(dir, branch).then((result) => json(res, 200, result))
  })
}