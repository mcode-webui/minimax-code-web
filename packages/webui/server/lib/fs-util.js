// server/lib/fs-util.js — 文件系统工具类（feat-workspace-lhl)
//
// 提供目录浏览、条目详情、创建目录、文件读取（feat-file-preview slice 02）等功能。
// 后续可用于 sidebar 文件树管理 / 右栏文件预览。

import { readdirSync, statSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, extname, basename } from 'node:path'
import { homedir } from 'node:os'

// 知名目录解析（对标 File System Access API 的 startIn）：
//   linux:   读 XDG user-dirs 配置（中文系统是 ~/文档 而非 ~/Documents），
//            回退 ~/Documents 等英文目录，最后回退主目录
//   darwin:  ~/Documents 等系统默认目录（存在即用），回退主目录
//   win32:   先探 OneDrive 重定向（~/OneDrive/Documents，中文 Windows 常见），
//            再 ~/Documents（磁盘上始终是英文名，资源管理器显示才本地化），
//            回退主目录
// 兜底顺序保证任何平台都返回一个存在的目录（picker 永不因目录缺失而 404）。
const XDG_DIRS = {
  documents: 'XDG_DOCUMENTS_DIR',
  desktop: 'XDG_DESKTOP_DIR',
  downloads: 'XDG_DOWNLOAD_DIR',
  music: 'XDG_MUSIC_DIR',
  pictures: 'XDG_PICTURES_DIR',
  videos: 'XDG_VIDEOS_DIR',
}

function wellKnownDir(name) {
  const xdgKey = XDG_DIRS[name]
  if (!xdgKey) return null
  const home = homedir()
  const capitalized = name[0].toUpperCase() + name.slice(1)
  if (process.platform === 'linux') {
    try {
      const cfg = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8')
      const m = cfg.match(new RegExp(`^${xdgKey}=["']?([^"'\n]+)["']?`, 'm'))
      if (m) {
        const p = m[1].replace('$HOME', home)
        if (existsSync(p)) return p
      }
    } catch {}
  }
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(join(home, 'OneDrive', capitalized))
  }
  candidates.push(join(home, capitalized))
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return home
}

// 路径解析：~ / ~/xxx 展开主目录；documents 等关键字映射知名目录；其余原样
// v2.2 (in-product): exported — the containment gate in routes/fs.js must
//   resolve the same way the picker client does (keywords like 'documents'),
//   otherwise 'documents' resolves cwd-relative and ENOENTs.
export function resolveTarget(p) {
  if (!p || p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  const known = wellKnownDir(p)
  if (known) return known
  return p
}

// 权限字符串
function modeToString(mode) {
  const octal = (mode & 0o777).toString(8).padStart(3, '0')
  return octal
}

// 图标类型
function getIconType(name, stat) {
  if (stat.isDirectory()) return 'folder'
  const ext = extname(name).toLowerCase()
  const iconMap = {
    '.js': 'file-code', '.mjs': 'file-code', '.cjs': 'file-code',
    '.ts': 'file-code', '.tsx': 'file-code', '.jsx': 'file-code',
    '.py': 'file-code', '.rs': 'file-code', '.go': 'file-code',
    '.json': 'file-json', '.yaml': 'file-yaml', '.yml': 'file-yaml',
    '.html': 'file-html', '.css': 'file-css', '.scss': 'file-css',
    '.md': 'file-md', '.txt': 'file-text', '.log': 'file-text',
    '.png': 'file-image', '.jpg': 'file-image', '.jpeg': 'file-image',
    '.gif': 'file-image', '.svg': 'file-image', '.webp': 'file-image',
    '.mp3': 'file-audio', '.wav': 'file-audio', '.ogg': 'file-audio',
    '.mp4': 'file-video', '.mkv': 'file-video', '.avi': 'file-video',
    '.pdf': 'file-pdf',
    '.zip': 'file-archive', '.tar': 'file-archive', '.gz': 'file-archive',
    '.exe': 'file-exe', '.sh': 'file-sh',
  }
  return iconMap[ext] || 'file'
}

// 读取目录条目
export function readDirectory(targetPath, opts = {}) {
  const { limit = 500, showHidden = false } = opts
  const absPath = resolve(resolveTarget(targetPath))

  // Report a parent only when it is itself inside an allowed root. The panel's
  // "up" control is disabled on `!listing.parent`, so reporting a parent that
  // the containment gate will refuse leaves a permanently-enabled control that
  // can only ever answer 403 — at the outermost reachable directory, which is
  // exactly where a user clicks it to find out they are at the top.
  //
  // `reachableParent` is injected by the route (which already holds the
  // containment check) so this module keeps no dependency on the workspace
  // roots; without it the behaviour is unchanged apart from the boundary.
  let parent = null
  try {
    const candidate = resolve(absPath, '..')
    if (!opts.reachableParent || opts.reachableParent(candidate)) parent = candidate
  } catch {}

  let entries = []
  let skipped = 0
  try {
    const items = readdirSync(absPath, { withFileTypes: true })
    for (const item of items) {
      if (!showHidden && item.name.startsWith('.')) continue
      if (entries.length >= limit) { skipped = items.length - entries.length; break }

      try {
        const fullPath = join(absPath, item.name)
        const stat = statSync(fullPath)
        entries.push({
          name: item.name,
          path: fullPath,
          type: item.isDirectory() ? 'dir' : 'file',
          size: stat.size,
          mtime: stat.mtimeMs,
          mode: modeToString(stat.mode),
          icon: getIconType(item.name, stat),
          // isSymlink 暂不暴露
        })
      } catch {}
    }
  } catch (e) {
    return { ok: false, error: e.message, path: absPath }
  }

  // 排序：目录优先，按名称
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return {
    ok: true,
    path: absPath,
    parent,
    home: homedir(),
    entries,
    skipped,
    total: entries.length,
  }
}

// 创建目录
export function createDirectory(targetPath) {
  const absPath = resolve(resolveTarget(targetPath))
  try {
    mkdirSync(absPath, { recursive: true })
    return { ok: true, path: absPath }
  } catch (e) {
    return { ok: false, error: e.message, path: absPath }
  }
}

// v2.4 (file preview, slice 02):
//   `readFileContent` — read-only content fetch used by /api/fs/read-file and
//   the right-panel preview (webapp/components/file-preview.tsx).
//   Containment is the caller's job (routes/fs.js#handleFsReadFile runs
//   assertWorkspacePath first), so this module just does the file-level
//   checks:
//     - regular file (not directory / device / socket);
//     - size cap (DEFAULT_FILE_READ_MAX), oversize → error, never truncate;
//     - binary detection (NUL byte in the first BINARY_SNIFF_BYTES);
//     - UTF-8 BOM stripped on success.
//
//   Response shape is JSON-friendly so the route can serialize it as-is:
//     { ok:true,  path, size, encoding:'utf-8', binary:false,
//       mime, language, content }
//     { ok:false, path, error }
//
//   `language` is an extension-based hint the webapp's syntax renderer uses
//   to pick a token dictionary. It is informational — a guess — not a
//   contract; `unknown` is returned for anything not in the table.
export const DEFAULT_FILE_READ_MAX = 512 * 1024 // 512 KiB — same as pr-22
const BINARY_SNIFF_BYTES = 4096

// Minimum extension → language-id map the webapp renderer branches on.
// Anything missing falls back to "plain" (no highlighting beyond the monospace
// view). Adding a language here is a one-liner; the goal is to keep the
// surface small and predictable so the renderer stays single-file.
const EXT_LANGUAGE = {
  '.ts': 'typescript', '.tsx': 'typescript', '.cts': 'typescript', '.mts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html',
  '.md': 'markdown', '.markdown': 'markdown',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sql': 'sql',
  '.dockerfile': 'dockerfile',
}

// Inline MIME guess (also used by /api/fs/raw). Returns null for unknown so
// the caller can substitute `application/octet-stream`.
function mimeForExtension(ext) {
  switch (ext) {
    case '.html': case '.htm': return 'text/html; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.ico': return 'image/x-icon'
    case '.md': case '.markdown': return 'text/markdown; charset=utf-8'
    case '.txt': return 'text/plain; charset=utf-8'
    case '.pdf': return 'application/pdf'
    case '.woff2': return 'font/woff2'
    default: return null
  }
}

export function languageForExtension(ext) {
  return EXT_LANGUAGE[ext] ?? 'plain'
}

export function readFileContent(targetPath, opts = {}) {
  const max = opts.max ?? DEFAULT_FILE_READ_MAX
  const absPath = resolve(resolveTarget(targetPath))
  const ext = extname(absPath).toLowerCase()
  const language = languageForExtension(ext)
  const mime = mimeForExtension(ext) ?? 'application/octet-stream'

  let st
  try {
    st = statSync(absPath)
  } catch (e) {
    return { ok: false, path: absPath, error: e.message }
  }
  if (!st.isFile()) {
    return { ok: false, path: absPath, error: 'not a regular file' }
  }
  if (st.size > max) {
    return {
      ok: false,
      path: absPath,
      size: st.size,
      error: `file too large (max ${max} bytes)`,
      mime,
      language,
    }
  }

  // Sniff binary before reading the full file — saves memory on a 512 KiB
  // blob of a Windows DLL the user happened to click. The Buffer#includes
  // scan is O(sniffBytes) not O(size), so it never grows with the cap.
  let buf
  try {
    buf = readFileSync(absPath)
  } catch (e) {
    return { ok: false, path: absPath, error: e.message }
  }
  const sniffEnd = Math.min(BINARY_SNIFF_BYTES, buf.length)
  let binary = false
  for (let i = 0; i < sniffEnd; i++) {
    if (buf[i] === 0) { binary = true; break }
  }

  if (binary) {
    return {
      ok: false,
      path: absPath,
      size: st.size,
      error: 'binary file not supported',
      mime,
      language,
      binary: true,
    }
  }

  return {
    ok: true,
    path: absPath,
    size: st.size,
    // Slice 27 — the conflict-detection baseline. The preview editor
    // records (mtime, size) when a file is opened and sends them back
    // on save; `POST /api/fs/write` compares against the live stat and
    // refuses with 409 when the disk moved. Carrying it here means the
    // client never needs a second round-trip (and cannot race one
    // between read and edit).
    mtime: st.mtimeMs,
    mime,
    language,
    binary: false,
    encoding: 'utf-8',
    // Strip UTF-8 BOM; keep line endings as-is (the renderer is what
    // chooses to soften them).
    content: buf.toString('utf8').replace(/^\uFEFF/, ''),
  }
}
