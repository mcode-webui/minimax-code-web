/**
 * Bilingual strings — slice 14 (file-open actions).
 *
 * New module rather than extending `lib/i18n.ts` because that file is
 * the core dictionary owned by other slices. Adding keys here avoids a
 * merge conflict when more slices land in parallel.
 *
 * Every key MUST exist in both `en` and `zh` — the runtime check is the
 * `i18n-file-open.test.ts` lock, not just a manual review. A key missing
 * in one locale silently falls back to the en value (or the key name
 * itself), and the panel ships in Chinese by default, so a missing zh
 * entry ships English text to a Chinese-locale user.
 *
 * The keys are grouped:
 *   - reason.* — the human-readable "why this file is not previewable"
 *     explanation that drives the panel body. Each variant maps to one
 *     of the four unsupported categories the read-file endpoint emits
 *     (binary / over-size / out-of-bounds / unknown).
 *   - action.* — the button labels. One pair each (open-default /
 *     reveal / download) so a future affordance does not have to share
 *     copy with the others. The download action (slice 14 R207) is the
 *     third button the user-facing ticket asks for; it is always
 *     enabled because the browser handles the save directly.
 *   - failure.* — error copy the buttons render when a button click
 *     comes back with `ok:false`. Short; the toast / banner stays short.
 *   - button.disabledHint.* — the "why is this disabled" tooltip. Two
 *     distinct reasons live here, picked by the classifier the panel
 *     uses:
 *       outOfBounds  — the panel knows the path is unreachable; opening
 *                       it would just bounce off the gate again.
 *       noOpener     — the host has no GUI binary; the action is honest
 *                       but unrunnable.
 *     Each carries its own message so the disabled state never lies about
 *     the cause.
 */

import type { Locale } from "./i18n";

const FILE_OPEN_STRINGS = {
  en: {
    /* Reasons — the panel body. The component picks one of these based
       on the read-file response: payload.binary / error.startsWith("file
       too large") / containment regex / fall-through. */
    "fileOpen.reason.binary": "This file is binary ({{mime}}); the preview only renders text.",
    "fileOpen.reason.oversize": "This file is larger than the preview cap (512 KiB).",
    "fileOpen.reason.outOfBounds": "This file is outside the workspace boundary.",
    "fileOpen.reason.unknown": "Cannot preview this file ({{error}}).",
    /* Action buttons — kept terse because the row's horizontal space is
       tight in the right-hand panel (288px). The aria-label carries the
       long form for screen readers. */
    "fileOpen.action.openDefault": "Open with default app",
    "fileOpen.action.openDefault.aria": "Open this file with the system's default application",
    "fileOpen.action.reveal": "Show in file manager",
    "fileOpen.action.reveal.aria": "Open the file manager and point at this file",
    /* Slice 14 R207 — the third "下载查看" action reuses the
       /api/fs/raw?download=1 endpoint. It is always enabled (no
       opener / file-manager dependency), so no disable-hint copy. */
    "fileOpen.action.download": "Download to view",
    "fileOpen.action.download.aria": "Download this file to your computer",
    /* Failure copy — the banner the panel renders when a button click
       comes back with `ok:false`. Keep it bilingual-friendly; the server
       already says what went wrong in `error`, this string is the
       framing. The download path has no failure banner — the browser
       either saves the file or the network layer surfaces its own
       error. */
    "fileOpen.failure.openDefault": "Could not open the file: {{error}}",
    "fileOpen.failure.reveal": "Could not open the file manager: {{error}}",
    /* Disabled tooltip — the reason the button is disabled. Two distinct
       reasons live here, picked by the classifier the panel uses:
         outOfBounds  — the panel knows the path is unreachable, opening
                         it would just bounce off the gate again
         noOpener     — the host has no GUI binary, the action is
                         honest but unrunnable
       Each carries its own message; reusing the "no GUI opener" copy
       for an out-of-bounds path misleads the user about why the button
       is dead. */
    "fileOpen.button.disabledHint.outOfBounds": "This path is outside the workspace; the action is unavailable.",
    "fileOpen.button.disabledHint.noOpener": "This environment has no GUI opener; the action is unavailable.",
    /* Header — shown at the top of the panel when the file is not
       previewable. Long-form, no ellipsis, because the body explains
       why. */
    "fileOpen.header.unsupported": "This file type is not previewable in the panel.",
  },
  zh: {
    "fileOpen.reason.binary": "该文件是二进制文件（{{mime}}），预览仅支持文本。",
    "fileOpen.reason.oversize": "该文件超过预览上限（512 KiB）。",
    "fileOpen.reason.outOfBounds": "该文件不在工作区允许范围内。",
    "fileOpen.reason.unknown": "无法预览该文件（{{error}}）。",
    "fileOpen.action.openDefault": "用默认应用打开",
    "fileOpen.action.openDefault.aria": "用系统默认应用程序打开该文件",
    "fileOpen.action.reveal": "在文件管理器中显示",
    "fileOpen.action.reveal.aria": "打开文件管理器并定位到该文件",
    "fileOpen.action.download": "下载查看",
    "fileOpen.action.download.aria": "将该文件下载到本地",
    "fileOpen.failure.openDefault": "打开文件失败：{{error}}",
    "fileOpen.failure.reveal": "打开文件管理器失败：{{error}}",
    "fileOpen.button.disabledHint.outOfBounds": "该路径不在工作区允许范围内，该操作不可用。",
    "fileOpen.button.disabledHint.noOpener": "当前环境没有 GUI opener，该操作不可用。",
    "fileOpen.header.unsupported": "该文件类型无法在面板中预览。",
  },
} as const;

export type FileOpenKey = keyof typeof FILE_OPEN_STRINGS["en"];

export { FILE_OPEN_STRINGS };

/**
 * Resolve a slice-14 string for the current locale.
 *
 * Falls back to en when the requested locale is unknown (defensive —
 * the webui only ships zh / en today, but the function should not
 * throw if a future third locale slips through). Falls back to the
 * raw key when the bucket is missing the entry, so a regression here
 * shows the key name (e.g. "fileOpen.reason.binary") in the UI rather
 * than rendering an empty bar.
 *
 * The optional `params` map substitutes `{{name}}` placeholders, same
 * convention the rest of the i18n modules use (`replace("{{name}}",
 * value)`). Today only `error` and `mime` are substituted, but the
 * helper is generic so future keys can carry more without API churn.
 *
 * The return type is widened from the literal `key`'s template type
 * to plain `string` because `replaceAll` strips the literal type —
 * callers do not need the literal (they pass it through to React).
 */
export function tFileOpen(
  locale: Locale,
  key: FileOpenKey,
  params?: Record<string, string | number | undefined | null>,
): string {
  const safeLocale = (locale === "zh" ? "zh" : "en") as "zh" | "en";
  const bucket = FILE_OPEN_STRINGS[safeLocale] || FILE_OPEN_STRINGS.en;
  const fallback: string = FILE_OPEN_STRINGS.en[key] ?? key;
  let value: string = bucket[key] || fallback;
  if (params) {
    for (const [name, raw] of Object.entries(params)) {
      const replacement = raw === null || raw === undefined ? "" : String(raw);
      value = value.replaceAll(`{{${name}}}`, replacement);
    }
  }
  return value;
}