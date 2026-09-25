// server/routes/fs.js — 文件系统 API（feat-workspace-lhl)
//
// GET  /api/fs/read?path=xxx&showHidden=0  读取目录
// POST /api/fs/mkdir                       创建目录 { path }

import { createReadStream, statSync } from 'node:fs'
import { extname, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { readDirectory, createDirectory, resolveTarget, readFileContent } from '../lib/fs-util.js'
import { assertWorkspacePath, assertWorkspaceParentPath, expandTilde } from '../lib/workspace.js'

// v2.2 (in-product): containment 门 — 目录浏览/创建与 browseWorkspace 同边界，
//   只允许落在允许根（默认 home + 默认工作区 + tmp，MCODE_WEBUI_WORKSPACE_ROOTS
//   可整体替换）内的路径。'~' 前缀先展开再校验。独立仓版本的 safePath 只挡
//   '..'，在产品包里收紧为允许根边界。
function safePath(rawPath) {
  // v2.2: resolveTarget first — the picker's default start is the
  //   'documents' keyword (XDG dir → ~/Documents → home fallback); gating
  //   the raw keyword would resolve it cwd-relative and ENOENT.
  const gate = assertWorkspacePath(resolveTarget(expandTilde(rawPath)))
  return gate.ok ? gate.path : null
}

function gateError(res, rawPath) {
  const gate = assertWorkspacePath(resolveTarget(expandTilde(rawPath)))
  res.writeHead(403, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: gate.ok ? 'invalid path' : gate.error }))
}

export function handleFsRead(req, res) {
  const url = new URL(req.url, `http://localhost`)
  let rawPath = url.searchParams.get('path') || ''
  const showHidden = url.searchParams.get('showHidden') === '1'

  if (!rawPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'missing path' }))
    return
  }

  // v2.2 (in-product): containment 校验 — 独立仓版本直接读任意路径，
  //   产品包里 read 与 mkdir 同边界（允许根内才可枚举）。
  const path = safePath(rawPath)
  if (!path) {
    gateError(res, rawPath)
    return
  }

  const result = readDirectory(path, { showHidden })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

// GET /api/fs/file?path=xxx  读取文本文件内容（webui-react 右栏文档预览）
//   边界与 read 相同：允许根内（safePath containment）、≤512KB、拒二进制。
export function handleFsReadFile(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const rawPath = url.searchParams.get('path') || ''

  if (!rawPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'missing path' }))
    return
  }

  const path = safePath(rawPath)
  if (!path) {
    gateError(res, rawPath)
    return
  }

  const result = readFileContent(path)
  res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

export function handleFsMkdir(req, res) {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let data
    try { data = JSON.parse(body) } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
      return
    }

    // mkdir 的目标尚不存在 — 校验父目录在允许根内（v2.2）
    const gate = assertWorkspaceParentPath(resolveTarget(expandTilde(data.path)))
    if (!gate.ok) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: gate.error }))
      return
    }

    const result = createDirectory(gate.path)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  })
}

// GET /api/fs/raw?path=xxx  按扩展名原样返回文件（内置浏览器 iframe 打开 html 等用）
//   允许根内、≤20MB；content-type 按扩展名映射，未知为二进制流。
const RAW_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
}

export function handleFsRaw(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const rawPath = url.searchParams.get('path') || ''
  if (!rawPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'missing path' }))
    return
  }
  const path = safePath(rawPath)
  if (!path) {
    gateError(res, rawPath)
    return
  }
  let st
  try {
    st = statSync(path)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
    return
  }
  if (!st.isFile()) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not a regular file' }))
    return
  }
  if (st.size > 20 * 1024 * 1024) {
    res.writeHead(413, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'file too large (max 20MB)' }))
    return
  }
  const type = RAW_CONTENT_TYPES[extname(path).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' })
  createReadStream(path).pipe(res)
}

// POST /api/fs/open { path, mode: 'file' | 'folder' }
//   在系统中打开（xdg-open）：文件用默认应用，folder 模式打开所在/指定目录（文件管理器）。
export function handleFsOpen(req, res) {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let data
    try { data = JSON.parse(body) } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
      return
    }
    const rawPath = typeof data.path === 'string' ? data.path : ''
    const mode = data.mode === 'folder' ? 'folder' : 'file'
    if (!rawPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'missing path' }))
      return
    }
    const gate = assertWorkspacePath(resolveTarget(expandTilde(rawPath)))
    if (!gate.ok) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: gate.error }))
      return
    }
    let target = gate.path
    if (mode === 'folder') {
      try {
        if (statSync(target).isFile()) target = dirname(target)
      } catch {}
    }
    execFile('xdg-open', [target], { timeout: 5000 }, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, target }))
  })
}
