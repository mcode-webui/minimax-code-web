import type { FsFilePayload } from "./api";

/**
 * Pure routing logic for the right-panel file preview (slice 02).
 *
 * `pickPreviewKind` is the file→renderer mapping the
 * `components/file-preview.tsx` view branches on. Extracting it here
 * keeps the React surface thin AND lets unit tests pin the mapping
 * without spinning up React — Node's loader does not honour the Next.js
 * `@/lib/...` alias the component itself uses.
 *
 * Rules — what gets which renderer:
 *   markdown    `.md` / `.markdown` (server says `language === "markdown"`,
 *                   or the fallback path's extension matches)
 *   image       any path whose server mime is `image/*`, or whose
 *                   extension is in IMAGE_EXTS (the server may not emit a
 *                   language for an image, so the path is the tiebreaker)
 *   code        everything else — a plain monospace pre with a language
 *                   badge from the server's hint. "unsupported" never
 *                   reaches the live product path because the server
 *                   rejects binary up front, but it remains in the type
 *                   for exhaustive switch coverage.
 */

export type PreviewKind =
  | "markdown"
  | "image"
  | "code"
  | "unsupported";

const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
]);
const MARKDOWN_EXTS = new Set([".md", ".markdown"]);

export function pickPreviewKind(payload: FsFilePayload, fallbackPath: string): PreviewKind {
  const lang = (payload.language ?? "").toLowerCase();
  const mime = (payload.mime ?? "").toLowerCase();
  const ext = lastExt(fallbackPath);

  if (lang === "markdown" || MARKDOWN_EXTS.has(ext)) return "markdown";
  if (mime.startsWith("image/")) return "image";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "code";
}

export function lastExt(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

export function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}