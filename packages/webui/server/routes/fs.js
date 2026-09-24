// server/routes/fs.js — 文件系统 API（feat-workspace-lhl)
//
// GET  /api/fs/read?path=xxx&showHidden=0  读取目录
// POST /api/fs/mkdir                       创建目录 { path }

import { readDirectory, createDirectory, resolveTarget } from '../lib/fs-util.js'
import { readJson, BodyTooLargeError } from '../lib/read-json.js'
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

  const result = readDirectory(path, {
    showHidden,
    // Only advertise a parent the containment gate would actually accept, so
    // the panel's "up" control disables at the boundary instead of offering a
    // move that can only 403.
    reachableParent: (candidate) => assertWorkspacePath(candidate).ok,
  })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

export async function handleFsMkdir(req, res) {
  // Uses the shared bounded reader. This route used to carry its own
  // `req.on('data', …)` buffer, which is why it escaped the body cap added
  // for every other JSON route: the cap was written for the
  // `for await (const chunk of req)` shape and nothing caught this one.
  let data;
  try {
    data = await readJson(req);
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' })
      res.end(JSON.stringify({ ok: false, error: cause.message, code: 'BODY_TOO_LARGE' }))
      return
    }
    throw cause;
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
}
