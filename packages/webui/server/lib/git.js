// server/lib/git.js —— git CLI 封装（零 npm 依赖，基于开源 git 二进制）
//
// 供右栏 Git 面板使用：状态（porcelain）、分支列表、切换分支、单文件 diff。
// 安全：目录必须先经 assertWorkspacePath（允许根内）；分支名白名单校验；
//       execFile 不走 shell，杜绝注入。

import { execFile } from 'node:child_process'
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

function gate(dir) {
  const gateResult = assertWorkspacePath(dir)
  return gateResult.ok ? gateResult.path : null
}

// 工作区状态：分支 + 变更文件（porcelain v1）。不是仓库时 ok:false/isRepo:false。
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

// 本地分支列表 + 当前分支。
export async function gitBranches(dir) {
  const abs = gate(dir)
  if (!abs) return { ok: false, error: '目录不在允许范围内' }
  const res = await run(abs, ['branch', '--list', '--format=%(refname:short)'])
  if (!res.ok) return { ok: false, error: res.error }
  const branches = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((name) => ({ name, current: name.startsWith('* ') }))
  for (const b of branches) {
    if (b.current) b.name = b.name.slice(2)
  }
  return { ok: true, branches }
}

// 切换分支（本地分支名白名单校验；execFile 无 shell 注入面）。
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

// 单文件相对 HEAD 的 diff（未跟踪文件回退 no-index 造出全量新增 diff）。
export async function gitDiff(dir, file) {
  const abs = gate(dir)
  if (!abs) return { ok: false, diff: '', error: '目录不在允许范围内' }
  if (file.includes('..') || file.startsWith('-')) return { ok: false, diff: '', error: '非法路径' }
  let res = await run(abs, ['diff', 'HEAD', '--', file])
  if (res.ok && res.stdout.trim() !== '') return { ok: true, diff: res.stdout }
  res = await run(abs, ['diff', '--no-index', '--', '/dev/null', file])
  if (res.ok) return { ok: true, diff: res.stdout }
  // no-index 对存在文件比较 /dev/null 恒有差异；失败则透传错误
  return { ok: false, diff: '', error: res.error }
}