/**
 * Bilingual strings — slice 04 (Built-in Browser).
 *
 * New module rather than extending `lib/i18n.ts` because that file is
 * owned by slice 03 (`feat/git-panel`). Adding keys here avoids a merge
 * conflict when both slices land.
 *
 * Every key MUST exist in both `en` and `zh` — the runtime check is the
 * `i18n-browser.test.ts` lock, not just a manual review. A key missing
 * in one locale silently falls back to the en value (or the key name
 * itself), and the panel ships in Chinese by default, so a missing zh
 * entry ships English text to a Chinese-locale user.
 */

import type { Locale } from "./i18n";

const BROWSER_STRINGS = {
  en: {
    /* Header — the panel title + the global helper. The header carries
       the panel name and a "pick an entry HTML" hint; the helper is
       the row rendered in the empty state when no path is loaded. */
    "browser.title": "Built-in browser",
    "browser.subtitle": "Preview a local HTML page in a sandboxed iframe",
    /* Address bar — Enter is the explicit "go" gesture, the same
       affordance the pr-22 reference and every desktop browser ships.
       The placeholder doubles as the empty-state helper. */
    "browser.addressPlaceholder": "Path to an entry HTML (e.g. public/index.html)",
    "browser.addressAria": "Browser address bar",
    "browser.go": "Go",
    "browser.goAria": "Navigate to the entered path",
    "browser.back": "Back",
    "browser.backAria": "Back to the previous page",
    "browser.forward": "Forward",
    "browser.forwardAria": "Forward to the next page",
    "browser.refresh": "Refresh",
    "browser.refreshAria": "Reload the current page",
    /* Empty state — shown when the panel has no current page. Mirrors
       the pr-22 reference copy: pick a workspace file or paste a path
       into the address bar. */
    "browser.empty.title": "No page open",
    "browser.empty.body": "Select an HTML file in the file tree, or paste a workspace-relative path above.",
    /* Edge states — the three reasons the panel refuses a request. The
       containment copy is bilingual-friendly; the server already
       surfaces an actionable "must be under" hint we re-use. */
    "browser.error.containment": "That path is outside the workspace boundary.",
    "browser.error.notHtml": "Only HTML files can be previewed here.",
    "browser.error.tooLarge": "That file is over the preview size cap (20 MiB).",
    "browser.error.notFile": "That path is not a regular file.",
    "browser.error.absolute": "Only workspace-relative paths are allowed — absolute URLs and file:// targets are not supported.",
    "browser.error.unknown": "Could not open that page: {{error}}",
    /* Loading + container-only diagnostics. Console errors from the
       preview page stay inside the iframe (the sandbox stops them
       from leaking out), so the "loading" hint doubles as a
       "this panel is alive" pulse. */
    "browser.loading": "Loading…",
  },
  zh: {
    "browser.title": "内置浏览器",
    "browser.subtitle": "在工作区 HTML 上做沙箱预览",
    "browser.addressPlaceholder": "入口 HTML 路径（如 public/index.html）",
    "browser.addressAria": "浏览器地址栏",
    "browser.go": "转到",
    "browser.goAria": "打开输入的路径",
    "browser.back": "后退",
    "browser.backAria": "返回上一个页面",
    "browser.forward": "前进",
    "browser.forwardAria": "前进到下一个页面",
    "browser.refresh": "刷新",
    "browser.refreshAria": "重新加载当前页",
    "browser.empty.title": "暂无页面",
    "browser.empty.body": "在文件树中点 HTML 文件，或在上方粘贴工作区相对路径。",
    "browser.error.containment": "该路径不在工作区允许范围内。",
    "browser.error.notHtml": "该面板只能预览 HTML 文件。",
    "browser.error.tooLarge": "该文件超过预览上限（20 MiB）。",
    "browser.error.notFile": "该路径不是一个常规文件。",
    "browser.error.absolute": "仅允许工作区相对路径；绝对 URL 与 file:// 目标不被支持。",
    "browser.error.unknown": "打开页面失败：{{error}}",
    "browser.loading": "加载中…",
  },
} as const;

export type BrowserKey = keyof typeof BROWSER_STRINGS["en"];

export { BROWSER_STRINGS };

/**
 * Resolve a slice-04 string for the current locale.
 *
 * Falls back to en when the requested locale is unknown (defensive —
 * the webui only ships zh / en today, but the function should not
 * throw if a future third locale slips through). Falls back to the
 * raw key when the bucket is missing the entry, so a regression here
 * shows the key name (e.g. "browser.subtitle") in the UI rather than
 * rendering an empty bar.
 */
export function tBrowser(locale: Locale, key: BrowserKey): string {
  const safeLocale = (locale === "zh" ? "zh" : "en") as "zh" | "en";
  const bucket = BROWSER_STRINGS[safeLocale] || BROWSER_STRINGS.en;
  return bucket[key] || (BROWSER_STRINGS.en[key] ?? key);
}