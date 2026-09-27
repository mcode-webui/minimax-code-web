// server/routes/fs.js — 文件系统 API（feat-workspace-lhl)
//
// GET  /api/fs/read?path=xxx&showHidden=0  读取目录
// GET  /api/fs/read-file?path=xxx          读取单文件内容（slice 02，右栏预览）
// GET  /api/fs/raw?path=xxx                原样返回（image / html，slice 02 预览）
// POST /api/fs/mkdir                       创建目录 { path }
// POST /api/fs/open-default { path }       用系统默认应用打开（slice 14）
// POST /api/fs/reveal { path }             在文件管理器中定位（slice 14）

import { readDirectory, createDirectory, resolveTarget, readFileContent } from '../lib/fs-util.js'
import { readJson, BodyTooLargeError } from '../lib/read-json.js'
import { assertWorkspacePath, assertWorkspaceParentPath, expandTilde } from '../lib/workspace.js'
import { openWithDefault, revealInFileManager } from '../lib/open-target.js'
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, basename } from 'node:path'

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

// GET /api/fs/read-file?path=xxx
//   读单个文件内容（slice 02 右栏预览用）。
//   containment 同 read/mkdir（safePath 门），不绕过；
//   超 512 KiB（fs-util 的 DEFAULT_FILE_READ_MAX）显式拒绝而非截断；
//   检测到 NUL 字节视为二进制拒读。返回里带 language/mime
//   让前端做 type→renderer 路由时少一次 round-trip。
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
  // 413/415 区分 oversize / 二进制 / 非常规文件；其他错误归 400
  // （stat 失败属于 caller 把路走没了，UI 应展示该路径无效）。
  let status = 200
  if (!result.ok) {
    if (result.error && result.error.startsWith('file too large')) status = 413
    else if (result.error === 'not a regular file' || result.error === 'binary file not supported') status = 415
    else status = 400
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

// GET /api/fs/raw?path=xxx
//   原样返回文件字节（slice 02 用：image / svg / font 等），走 stream。
//   containment 同 read；≤20 MiB（与 pr-22 上限对齐）；content-type 按
//   扩展名查表，未知为 application/octet-stream。Cache-Control: no-store
//   因为本地文件没有 immutable 假设，编辑器改了应当立刻可见。
//
//   Streaming is incompatible with the Hono `createResponseCapture` buffer
//   (it only models writeHead/end), so the route exposes two entry points:
//     - `handleFsRaw(req, res)`  — legacy (req, res) signature, used by the
//       non-Hono dispatcher and the test fixtures that pipe into a fake
//       ServerResponse.
//     - `handleFsRawStream(rawPath)` — returns the validated (status,
//       headers, Node Readable) tuple the Hono registration wraps in a real
//       Response with `Readable.toWeb(stream)`. The actual containment /
//       size / mime work is done once in `handleFsRawStream` and the legacy
//       handler just forwards the result.
const RAW_MAX_BYTES = 20 * 1024 * 1024
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

/**
 * Stream-aware variant: validates the path and returns either
 *   { ok:false, status, json }    — the caller turns into a JSON Response, OR
 *   { ok:true,  status, headers, stream } — the caller wraps in a streaming
 *                                    Response with the mime / cache headers.
 *
 * The stream is a Node Readable; the Hono registration converts it with
 * `Readable.toWeb()` (the Web Streams adapter is the standard fetch-API
 * shape @hono/node-server accepts on the body slot).
 *
 * `opts.download` flips the response into "save as" mode by adding a
 * `Content-Disposition: attachment` header — slice 14's third action
 * ("下载查看") reuses this route rather than introducing a second
 * streaming endpoint, so the same containment gate, the same 20 MiB
 * cap, and the same regular-file check all stay in one place.
 * `opts.downloadFilename` overrides the basename used in the
 * disposition (default: the realpath'd leaf).
 */
export function handleFsRawStream(rawPath, opts = {}) {
  if (!rawPath) {
    return {
      ok: false,
      status: 400,
      json: { ok: false, error: 'missing path' },
    }
  }
  const path = safePath(rawPath)
  if (!path) {
    const gate = assertWorkspacePath(resolveTarget(expandTilde(rawPath)))
    return {
      ok: false,
      status: 403,
      json: { ok: false, error: gate.ok ? 'invalid path' : gate.error },
    }
  }

  let st
  try {
    st = statSync(path)
  } catch {
    return {
      ok: false,
      status: 404,
      json: { ok: false, error: 'not found' },
    }
  }
  if (!st.isFile()) {
    return {
      ok: false,
      status: 400,
      json: { ok: false, error: 'not a regular file' },
    }
  }
  if (st.size > RAW_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      json: { ok: false, error: `file too large (max ${RAW_MAX_BYTES} bytes)` },
    }
  }

  const ext = extname(path).toLowerCase()
  const type = RAW_CONTENT_TYPES[ext] || 'application/octet-stream'
  const headers = {
    'Content-Type': type,
    'Content-Length': String(st.size),
    'Cache-Control': 'no-store',
  }
  if (opts.download) {
    // The filename is quoted per RFC 6266 so a space, comma, or
    // semicolon in the leaf does not break the header parser; the
    // fallback (`fallback`) tells the browser what to use when the
    // server-supplied value cannot be turned into a usable filename.
    const leaf = opts.downloadFilename || basename(path)
    headers['Content-Disposition'] =
      `attachment; filename="${leaf.replace(/"/g, '')}"`
  }
  return {
    ok: true,
    status: 200,
    headers,
    stream: createReadStream(path),
  }
}

export function handleFsRaw(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const rawPath = url.searchParams.get('path') || ''
  const download = url.searchParams.get('download') === '1'
  const result = handleFsRawStream(rawPath, { download })
  if (!result.ok) {
    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.json))
    return
  }
  res.writeHead(result.status, result.headers)
  result.stream.pipe(res)
}

/** Hono-friendly bridge: turns the tuple above into a fetch-API Response
 *  by adapting the Node Readable to a Web ReadableStream. Exposed for the
 *  Hono registration in server/app.js. */
export function rawStreamToWebResponse(rawPath, opts = {}) {
  const result = handleFsRawStream(rawPath, opts)
  if (!result.ok) {
    return new Response(JSON.stringify(result.json), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(Readable.toWeb(result.stream), {
    status: result.status,
    headers: result.headers,
  })
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

// POST /api/fs/open-default { path }
//   Hand the path to the OS default application. The shared
//   `assertWorkspacePath` + per-node realpath containment gate inside
//   `openWithDefault` (lib/open-target.js) is what enforces the
//   boundary — the route's job is to JSON-decode the body and turn the
//   helper's structured codes into HTTP status codes the webapp can
//   branch on without parsing free-form text.
//
//   Wire codes:
//     ok (200)        — opener spawned cleanly
//     missing-path    — 400, no body
//     out-of-bounds   — 403, containment rejected
//     not-a-regular-file — 400, gate refused (directory / non-existent / symlink escape)
//     no-opener       — 503, host has no GUI binary on PATH; the UI
//                       disables the button on this answer so a click
//                       never produces a silent no-op
//     spawn-failed    — 502, binary ENOENTed between probe and exec
export async function handleFsOpenDefault(req, res) {
  let data
  try {
    data = await readJson(req)
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' })
      res.end(JSON.stringify({ ok: false, error: cause.message, code: 'BODY_TOO_LARGE' }))
      return
    }
    throw cause
  }

  const result = await openWithDefault(data.path)
  if (result.ok) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Map structured codes to HTTP status. The component reads `code`
  // for the button-disable / message branches, so the wire shape is
  // stable across 200 / 4xx / 5xx answers.
  const status = codeToStatus(result.code)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, code: result.code, error: result.error }))
}

// POST /api/fs/reveal { path }
//   Open the file manager pointed at the path. Wire model and gate are
//   the same as `handleFsOpenDefault`; macOS / Windows select the
//   specific row, Linux opens the parent directory (the freedesktop side
//   has no portable "select" command).
export async function handleFsReveal(req, res) {
  let data
  try {
    data = await readJson(req)
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' })
      res.end(JSON.stringify({ ok: false, error: cause.message, code: 'BODY_TOO_LARGE' }))
      return
    }
    throw cause
  }

  const result = await revealInFileManager(data.path)
  if (result.ok) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  const status = codeToStatus(result.code)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, code: result.code, error: result.error }))
}

// Translate the structured error codes from `lib/open-target.js` to HTTP
// status codes. The component branches on `code`, so the wire shape is
// what matters most; the status is the conventional mapping.
function codeToStatus(code) {
  switch (code) {
    case 'missing-path':
      return 400
    case 'out-of-bounds':
      return 403
    case 'not-a-regular-file':
      return 400
    case 'no-opener':
      // 503 Service Unavailable — the host literally has no opener to
      // serve. The UI disables the button on this answer so the user
      // never gets a silent click.
      return 503
    case 'spawn-failed':
      return 502
    default:
      return 500
  }
}
