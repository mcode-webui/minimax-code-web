// webui/server/lib/static.js
// Static file serving (HTML + assets).

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname here = webui/server/lib/. public/ is at webui/public/.
// So go up 2 levels: webui/server/lib → ../.. → webui → public/.
export const PUBLIC_DIR = resolve(__dirname, "..", "..", "public");

// v0.5.ab: 静态文件服务（/lib/* — marked、highlight.js 库）
// v0.5.ar: 扩展为任何文件扩展名（品牌 logo 等），用白名单防止 path traversal（拒绝 .. 和 \）
export function serveStatic(pathname, res) {
  // 安全检查：拒绝 .. 和 \
  const safe = pathname
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/\\/g, "");
  if (safe.includes("..") || safe.includes("\\") || safe.includes("\0")) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  let filePath = join(PUBLIC_DIR, safe);
  // v2.4: 目录回落到 index.html —— /react/ 之前 404（只认文件不认目录），
  // 用户必须手敲 /react/index.html 才能看到 React 版。
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    const idx = join(filePath, "index.html");
    if (existsSync(idx) && statSync(idx).isFile()) filePath = idx;
  }
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath).toLowerCase();
    const mime =
      ext === ".js"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".html"
            ? "text/html; charset=utf-8" // v2.3: auth-gate.html (index.html goes through serveIndex)
            : ext === ".json"
              ? "application/json; charset=utf-8"
            : ext === ".png"
              ? "image/png"
              : ext === ".svg"
                ? "image/svg+xml; charset=utf-8"
                : ext === ".ico"
                  ? "image/x-icon"
                  : ext === ".jpg" || ext === ".jpeg"
                    ? "image/jpeg"
                    : ext === ".gif"
                      ? "image/gif"
                      : ext === ".webp"
                        ? "image/webp"
                        : "application/octet-stream";
    // v0.5.bx-35: app/*.js 不缓存 (改得频繁, browser cache 旧版 = 用户看不到 fix)
    // v0.5.bx-36: styles/*.css 也加 no-cache (CSS 改得也不少, 跟 main.js 同等频繁度)
    //   其它静态资源 (img/png 等) 保持 1h 缓存
    const isAppJs = safe.startsWith("app/") && ext === ".js";
    const isAppCss = safe.startsWith("styles/") && ext === ".css";
    const noCache = isAppJs || isAppCss;
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": noCache ? "no-cache" : "public, max-age=3600",
    });
    return res.end(readFileSync(filePath));
  }
  return false;
}

/**
 * 默认入口 —— 新版（React + Ant Design）优先。
 *
 * v2.5: 根路径 / 由 packages/webui-react 的构建产物接管；原 vanilla 单页
 * **归档**在 /legacy/（文件不搬家，只改路由 —— 移动/重命名会在下次 source-sync
 * 制造冲突，见 AGENTS.md）。构建产物缺失时回落到 vanilla，保证 fresh clone
 * 没跑过 build 也能打开页面。
 */
export function serveIndex(res) {
  const reactPath = join(PUBLIC_DIR, "react", "index.html");
  if (existsSync(reactPath) && statSync(reactPath).isFile()) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(readFileSync(reactPath));
  }
  return serveLegacyIndex(res);
}

/**
 * 归档入口 —— 原 vanilla 单页（index.html + app/ + styles/）。
 * 资源用的是根绝对路径（/app/*.js、/styles/*.css），所以放在 /legacy/ 下照常工作。
 */
export function serveLegacyIndex(res) {
  const htmlPath = join(PUBLIC_DIR, "index.html");
  if (existsSync(htmlPath) && statSync(htmlPath).isFile()) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(readFileSync(htmlPath));
  }
  return false;
}
