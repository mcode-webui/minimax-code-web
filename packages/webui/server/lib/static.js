// webui/server/lib/static.js
// Static file serving for the web UI.
//
// Single root: the Next.js static export at `webui/webapp/out`. `auth-gate.html`
// is part of this tree — it ships via webapp/public/auth-gate.html, so Next's
// `output: 'export'` copies it to the export root alongside the rest of the
// shell, and the LAN token gate (server/router.js) resolves it from this single
// root. The trajectory studio's own static assets live in webui/public/trajectory/
// (NOT in the export root) and are served by server/trajectory/http.mjs, which
// reads them via its own `WEB_ROOT` URL; they are intentionally not part of
// this module's serving surface.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { NEXT_EXPORT_DIR } from "./layout.js";

const MIME = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Reject traversal before touching the filesystem. `..` and backslashes are
 * removed rather than merely tested for, which is what the previous implementation
 * did and what the surrounding checks assert.
 */
function safeRelative(pathname) {
  const safe = pathname.replace(/^\/+/, "").replace(/\.\./g, "").replace(/\\/g, "");
  if (safe.includes("..") || safe.includes("\\") || safe.includes("\0")) return null;
  return safe;
}

function contentType(filePath) {
  return MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Cache policy.
 *
 * Next's build output is content-addressed (`_next/static/<hash>/…`), so it can be
 * cached indefinitely — that is the whole point of the hashed filenames.
 *
 * HTML is the exception and must never be cached. It is the only file that names the
 * current build's chunks, so a cached copy pins the browser to a previous build:
 * the page would run stale code for the whole max-age, and once the old chunk is
 * gone it would 404 its own bundle. `no-cache` (revalidate every time) rather than
 * `no-store` keeps a cheap 304 for unchanged files.
 *
 * Everything else gets the default 1h cache: there is no other no-cache branch.
 */
function cacheControl(relativePath) {
  if (relativePath.endsWith(".html")) return "no-cache";
  if (relativePath.startsWith("_next/static/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

function sendFile(res, filePath, relativePath) {
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": cacheControl(relativePath),
  });
  return res.end(readFileSync(filePath));
}

function fileIn(root, relative) {
  if (!root || !relative) return null;
  const filePath = join(root, relative);
  // `join` collapses the traversal we already stripped; re-check that the result
  // is still inside the root so a crafted path can never escape it.
  if (!filePath.startsWith(root + sep)) return null;
  return existsSync(filePath) && statSync(filePath).isFile() ? filePath : null;
}

/**
 * Serve a static asset.
 *
 * Resolution per request:
 *   - the exact file (`/favicon_v2.ico`)
 *   - `<path>/index.html` so a directory-style URL (`/trajectory/`) resolves
 *     when Next exported the page that way (trailingSlash: true).
 *
 * The single root is `NEXT_EXPORT_DIR` (the Next.js static export). Anything
 * not produced by the export is not served from here — `/trajectory/`-style
 * requests for the trajectory studio are caught by router.js's `/trajectory`
 * mount BEFORE the static branch runs.
 *
 * @returns {boolean} true when a file was served (or a 404 was written for a
 *   directory-style path that matches nothing), false to let the caller continue.
 */
export function serveStatic(pathname, res) {
  const relative = safeRelative(pathname);
  if (relative === null) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  const direct = fileIn(NEXT_EXPORT_DIR, relative);
  if (direct) return sendFile(res, direct, relative), true;

  // Next emits `route/index.html` (trailingSlash: true), so `/route` and
  // `/route/` both need to resolve to it.
  const indexed = fileIn(NEXT_EXPORT_DIR, join(relative.replace(/\/+$/, ""), "index.html"));
  if (indexed) return sendFile(res, indexed, `${relative}/index.html`), true;

  return false;
}

/**
 * Serve the application shell for `/`.
 *
 * Reads from the Next.js static export. Returns false when the export is
 * absent (a bare checkout without `pnpm --filter @mavis/webui webapp:build`)
 * so the router can produce its documented 404 tail.
 */
export function serveIndex(res) {
  const htmlPath = fileIn(NEXT_EXPORT_DIR, "index.html");
  if (htmlPath) return sendFile(res, htmlPath, "index.html"), true;
  return false;
}