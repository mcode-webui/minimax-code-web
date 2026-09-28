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
import { classifyCredential } from '../lib/credential-file.js'
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, basename } from 'node:path'
import { searchWorkspace, DEFAULTS as SEARCH_DEFAULTS, ABSOLUTE_LIMITS as SEARCH_LIMITS } from '../lib/fs-search.js'

// v2.2 (in-product): containment 门 — 目录浏览/创建与 browseWorkspace 同边界，
//   只允许落在允许根（默认 home + 默认工作区 + tmp，MCODE_WEBUI_WORKSPACE_ROOTS
//   可整体替换）内的路径。'~' 前缀先展开再校验。独立仓版本的 safePath 只挡
//   '..'，在产品包里收紧为允许根边界。
//
//   v2.5 (slice 16 fix): safePath now returns the **realpath** form,
//   not the link path. The credential-shaped-file predicate (slice 16)
//   matches by basename; a workspace symlink `innocent.txt → id_rsa`
//   would otherwise pass containment with `innocent.txt` as the
//   basename and the gate would never see the target's name. The
//   shared gate (`assertWorkspacePath`) already runs realpathSync
//   inside `resolveWithinRoots`; we now surface that value as
//   `gate.real` so the credential check below sees the right
//   basename. Hardlinks are an inherent limit — a basename check
//   cannot follow an inode alias; that case is documented in
//   `lib/credential-file.js`.
function safePath(rawPath) {
  // v2.2: resolveTarget first — the picker's default start is the
  //   'documents' keyword (XDG dir → ~/Documents → home fallback); gating
  //   the raw keyword would resolve it cwd-relative and ENOENT.
  const gate = assertWorkspacePath(resolveTarget(expandTilde(rawPath)))
  // `gate.real` is the symlink-resolved form (always set when
  // `gate.ok === true`; falls back to the unresolved path on the
  // older error shape). Use it so the credential check sees the
  // *target*'s basename, not the link's.
  return gate.ok ? (gate.real ?? gate.path) : null
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

// GET /api/fs/read-file?path=xxx[&confirm=1]
//   读单个文件内容（slice 02 右栏预览用）。
//   containment 同 read/mkdir（safePath 门），不绕过；
//   超 512 KiB（fs-util 的 DEFAULT_FILE_READ_MAX）显式拒绝而非截断；
//   检测到 NUL 字节视为二进制拒读。返回里带 language/mime
//   让前端做 type→renderer 路由时少一次 round-trip。
//
//   v2.5 (slice 16 — credential file preview guard):
//   文件名命中凭据模式（`.env` / `*.pem` / `id_rsa` 等，详见
//   lib/credential-file.js）时，默认拒绝 plaintext 渲染，明文返回
//   `{ ok:false, code:'credential', error:'credential file — preview
//   disabled', credentialReason, mime, language }`，HTTP 403。客户端
//   在拒绝态展示"已阻止预览"+ "仍要打开？"二次确认；用户确认后用
//   `confirm=1` 重发请求，服务器才下发原文。文件树 / 默认应用 /
//   文件管理器 / 下载等动作不受影响——它们走别的端点。
//
//   The credential predicate is the single source of truth
//   (`lib/credential-file.js`); the webapp re-imports the same table
//   (`webapp/lib/credential-file.ts`) so the server gate and the
//   client classifier cannot drift. The shared fixture test
//   (`webapp/test/credential-file.test.ts`) walks both with the
//   same inputs.
export function handleFsReadFile(req, res) {
  const url = new URL(req.url, `http://localhost`)
  const rawPath = url.searchParams.get('path') || ''
  const confirmed = url.searchParams.get('confirm') === '1'

  if (!rawPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'missing-path', error: 'missing path' }))
    return
  }

  const path = safePath(rawPath)
  if (!path) {
    gateError(res, rawPath)
    return
  }

  // Credential gate (slice 16). Default-refuse, explicit-override.
  // The basename of `path` is the only thing the predicate looks
  // at — the directory does not matter, which keeps the rule
  // consistent regardless of workspace layout. `path` here is the
  // realpath (safePath now surfaces `gate.real`); a workspace
  // symlink `innocent.txt → id_rsa` therefore reaches the
  // predicate with basename `id_rsa` and is correctly refused.
  // Hardlinks are an inherent limit (same inode, different name,
  // no kernel hook for basename to follow) — see the
  // `lib/credential-file.js` comment.
  if (!confirmed) {
    const classification = classifyCredential(path)
    if (classification) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: false,
          code: 'credential',
          error: 'credential file — preview disabled',
          credentialReason: classification.reason,
          path,
          // mime / language stay populated so the UI's PreviewError can
          // render a meaningful state without a second round-trip
          // (mirrors the shape used for binary / oversize refusals).
          language: 'plain',
          binary: false,
        }),
      )
      return
    }
  }

  // Slice 16 audit log — when the user explicitly confirmed
  // (`confirm=1` on a credential-shaped path), record one line on
  // stderr so an operator can grep /var/log or the process output
  // for "secret opened" events. Format is JSON-shaped for
  // log-aggregator ingestion:
  //   {"event":"credential.override","ts":...,"path":"...","reason":"..."}
  // We log AFTER the credential check so a path that is NOT
  // credential-shaped (where `confirm=1` is a no-op) does not
  // produce noise. The audit line intentionally does NOT include
  // the file content — only the basename + sub-reason.
  if (confirmed) {
    const classification = classifyCredential(path)
    if (classification) {
      // Best-effort: write to stderr. We don't fail the request
      // if stderr is closed (e.g. a piped consumer that closed
      // early); the audit is best-effort, not transactional.
      try {
        process.stderr.write(
          JSON.stringify({
            event: 'credential.override',
            ts: new Date().toISOString(),
            path,
            reason: classification.reason,
            endpoint: 'read-file',
          }) + '\n',
        )
      } catch {
        // never throw from the audit log path
      }
    }
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
 *
 * v2.5 (slice 16 — credential file preview guard): credential-shaped
 * paths are refused here too, with the same override affordance as
 * `/api/fs/read-file` (`opts.confirm === true`). The image / font /
 * html extensions this route serves should never overlap with the
 * credential predicate, but defending the endpoint is cheap and keeps
 * the rule uniform. The "下载查看" action (`download=1`) is itself a
 * legitimate way out of the preview — the server does not strip it.
 */
export function handleFsRawStream(rawPath, opts = {}) {
  if (!rawPath) {
    return {
      ok: false,
      status: 400,
      json: { ok: false, code: 'missing-path', error: 'missing path' },
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

  // Credential gate — same predicate, same override knob. The image
  // extensions this route serves (png / jpg / webp / svg / pdf / …)
  // should never hit it in practice, but the rule stays in one place.
  if (opts.confirm !== true) {
    const classification = classifyCredential(path)
    if (classification) {
      return {
        ok: false,
        status: 403,
        json: {
          ok: false,
          code: 'credential',
          error: 'credential file — preview disabled',
          credentialReason: classification.reason,
          path,
        },
      }
    }
  }

  // Slice 16 audit log — same shape as the read-file route. Logs
  // only when the override was actually used (confirm on a
  // credential-shaped path); a confirm on a non-credential file is
  // a no-op and does not produce noise. `endpoint` distinguishes
  // raw-stream from read-file so a forensic search can group them.
  if (opts.confirm === true) {
    const classification = classifyCredential(path)
    if (classification) {
      try {
        process.stderr.write(
          JSON.stringify({
            event: 'credential.override',
            ts: new Date().toISOString(),
            path,
            reason: classification.reason,
            endpoint: opts.download ? 'raw-download' : 'raw',
          }) + '\n',
        )
      } catch {
        // never throw from the audit log path
      }
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
  const confirm = url.searchParams.get('confirm') === '1'
  const result = handleFsRawStream(rawPath, { download, confirm })
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

// GET /api/fs/search?root=<abs>&q=<glob>[&depth=&maxNodes=&wallMs=&limit=&includeHidden=1]
//
//   Bounded workspace search (slice 19a). The shipped file-tree
//   filter (slice 01) matches only already-expanded nodes, so a
//   `package.json` three directories deep is invisible until the
//   user manually opens every intermediate directory. This route
//   fixes that by walking the workspace behind the same
//   `assertWorkspacePath` gate the other `/api/fs/*` routes use,
//   with hard budgets so a hostile or pathological request cannot
//   pin the server.
//
//   Why a separate endpoint, not a flag on `/api/fs/read`. The
//   tree read returns the immediate children of one directory;
//   adding recursion + budgets + a glob predicate on top would
//   complicate that contract for callers that still depend on
//   its current shape (the right-panel preview footer, the
//   browse view, the recents list). A new endpoint keeps the
//   shipped tree behaviour stable for callers that do not
//   need it and gives the panel a focused search surface.
//
//   Containment. The `root` parameter goes through the SAME
//   `assertWorkspacePath` gate as `/api/fs/read` — out-of-root
//   answers 403 with the same actionable error message. The
//   walker is then called with the gate's realpath as its root;
//   symlinks that escape get caught at the gate, not deeper
//   into the walk.
//
//   Wire parameters — every one is optional except `root` and
//   `q`. Defaults come from `lib/fs-search.js#DEFAULTS`; each
//   is also clamped to `ABSOLUTE_LIMITS` so `?maxNodes=999999`
//   cannot pin a core.
//
//     root          (required)  — absolute path or '~'/'$HOME'/…
//                                   (same expansion as the other
//                                   fs routes)
//     q             (required)  — glob pattern; `*` any run,
//                                   `?` one char, case-insensitive,
//                                   anchored (re-used from
//                                   workspace-filter semantics).
//                                   Empty / whitespace-only → 400
//     depth         (optional)  — default 8, max 16
//     maxNodes      (optional)  — default 5000, max 50000
//     wallMs        (optional)  — default 1500, max 5000
//     limit         (optional)  — default 200, max 1000 (alias
//                                   for `maxMatches`)
//     includeHidden (optional)  — `1` to include dotfile entries
//
//   Credential decision (slice 16 alignment — DECIDED, see below).
//   The slice ticket asks: "Decide explicitly whether
//   credential-shaped files should be omitted from results
//   entirely, included as paths, or flagged". The decision here
//   is "flag, never omit, never read":
//
//     - Credential-shaped matches ARE returned, so the user can
//       see the file exists in their workspace (mirrors the
//       behaviour of `/api/fs/read` which keeps them visible in
//       the tree listing).
//     - Each credential match carries `credential: true` and a
//       stable `credentialReason` (one of 'dotenv', 'key-file',
//       'ssh-key', 'credentials', 'ssh-meta') the webapp reuses
//       from the right-panel preview classifier.
//     - The path itself is the realpath form (same canonical
//       spelling the route stores), so the existing
//       `/api/fs/read-file` containment + credential guard kicks
//       in on the user-initiated click — the search response
//       cannot leak plaintext even when the user typed a
//       credential-shaped `q` like `*.env`.
//     - `skipped.credential` is incremented for each match that
//       hit the predicate, so the UI can render a credible
//       "searched N, skipped M credentials" footer.
//
//   The predicate (`classifyCredential` from
//   `lib/credential-file.js`) is the same one slice 16 wired
//   into the read-file/raw routes, so the search transport and
//   the preview guard cannot drift.
//
//   The endpoint NEVER returns file contents. `matches[i]` is
//   `{ path, name, type, ancestors, credential?, credentialReason? }`
//   and nothing else — no `content`, no `size` sample, no
//   `mtime`. Anything else would weaken slice 16.
export function handleFsSearch(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const rawRoot = (url.searchParams.get('root') || '').trim()
  const q = (url.searchParams.get('q') || '').trim()

  if (!rawRoot) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'missing-root', error: 'missing root' }))
    return
  }
  if (!q) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'missing-q', error: 'missing q' }))
    return
  }

  // Same containment as /api/fs/read — no new escape surface.
  // `safePath` returns the realpath form so the matched entries
  // the walker returns line up byte-for-byte with what other
  // fs routes consider "this file".
  const root = safePath(rawRoot)
  if (!root) {
    gateError(res, rawRoot)
    return
  }
  // The path must point at a directory — a `root=<file>` would
  // produce zero matches and waste budget; surface the error.
  try {
    if (!statSync(root).isDirectory()) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'not-a-directory', error: 'root is not a directory', root }))
      return
    }
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'stat-failed', error: e.message, root }))
    return
  }

  // Collect the budgets the caller pinned. The walker clamps
  // each to the absolute limit, so a malicious or buggy client
  // cannot side-step the budget contract.
  const opts = {
    maxDepth: url.searchParams.get('depth'),
    maxNodes: url.searchParams.get('maxNodes'),
    wallMs: url.searchParams.get('wallMs'),
    maxMatches: url.searchParams.get('limit') ?? url.searchParams.get('maxMatches'),
    includeHidden: url.searchParams.get('includeHidden') === '1',
  }

  const result = searchWorkspace(root, q, opts)
  // Echo the requested q + root for the UI to confirm what it
  // actually searched; useful when the user typed a glob they
  // thought was absolute but was a basename match.
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...result }))
}

// Re-exported so the docs and tests can import the same numbers
// the route hands the walker, without going through the URL.
export { SEARCH_DEFAULTS, SEARCH_LIMITS }

