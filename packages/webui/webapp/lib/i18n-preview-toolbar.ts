/**
 * Bilingual strings — slice 27 (preview toolbar: refresh / edit toggle
 * / save / conflict card) and the Markdown outline panel.
 *
 * Own module rather than extending `lib/i18n.ts`, for the same reason
 * `i18n-file-open.ts` exists: the core dictionary is owned by other
 * slices, and a per-slice module keeps parallel slices from colliding.
 *
 * Every key MUST exist in both `en` and `zh` — `i18n-preview-toolbar`
 * has no runtime lock of its own, so the parity is pinned by review
 * plus the file-preview suite's live self-check. Copy rules:
 *
 *   - action.*      — the three toolbar buttons (refresh / edit /
 *                     preview / save) plus the conflict card's two
 *                     resolutions. Short; the panel is narrow.
 *   - status.*      — the inline feedback lines ("saved at", "save
 *                     failed", "refresh failed"). Honesty is the
 *                     requirement: a deleted file names the likely
 *                     cause instead of blanking.
 *   - conflict.*    — the external-modification card. It must tell the
 *                     user WHEN the disk version changed and what each
 *                     button does to their edit.
 *   - credential.*  — the write-side credential gate (slice 16
 *                     alignment): the card the user passes before the
 *                     editor opens on `.env`-shaped files.
 *   - toc.*         — the outline panel.
 */

import type { Locale } from "./i18n";

const PREVIEW_TOOLBAR_STRINGS = {
  en: {
    /* --- toolbar actions ------------------------------------------- */
    "previewToolbar.toolbar.aria": "Preview toolbar",
    "previewToolbar.refresh": "Refresh",
    "previewToolbar.refresh.aria": "Re-read this file from disk and re-render",
    "previewToolbar.edit": "Edit",
    "previewToolbar.edit.aria": "Switch this preview to the editor",
    "previewToolbar.preview": "Preview",
    "previewToolbar.preview.aria": "Switch back to the rendered preview",
    "previewToolbar.edit.disabledHint": "Editing is available for text files only",
    "previewToolbar.save": "Save",
    "previewToolbar.save.aria": "Save the edited content to the file on disk",
    "previewToolbar.editorAria": "Editing file content. Changes are only written when you press Save.",
    /* --- save / refresh feedback ----------------------------------- */
    "previewToolbar.savedAt": "Saved at {{time}}",
    "previewToolbar.saveFailed": "Save failed: {{error}}. Your edits are kept.",
    "previewToolbar.refreshFailed": "Refresh failed: {{error}}",
    "previewToolbar.fileGone": "The file may have been deleted, moved, or its path changed.",
    /* --- external-modification conflict ----------------------------- */
    "previewToolbar.conflict.title": "The file changed on disk",
    "previewToolbar.conflict.detail":
      "Someone or something else modified this file after you opened it (disk version: {{time}}, {{size}} bytes). Overwriting replaces that edit; loading the disk version discards yours.",
    "previewToolbar.conflict.overwrite": "Overwrite disk version",
    "previewToolbar.conflict.reload": "Load disk version",
    /* --- write-side credential gate (slice 16 alignment) ------------ */
    "previewToolbar.credential.title": "This file is read-only by default",
    "previewToolbar.credential.detail":
      "{{name}} looks like a credential file. Because the webui can be reachable from the local network, editing it here is disabled unless you confirm explicitly.",
    "previewToolbar.credential.editAnyway": "Edit anyway",
    "previewToolbar.credential.cancel": "Cancel",
    /* --- outline panel ---------------------------------------------- */
    "previewToolbar.toc.title": "Outline",
    "previewToolbar.toc.jump": "Jump to “{{text}}”",
    "previewToolbar.toc.active": "Current section",
  },
  zh: {
    /* --- toolbar actions ------------------------------------------- */
    "previewToolbar.toolbar.aria": "预览工具栏",
    "previewToolbar.refresh": "刷新",
    "previewToolbar.refresh.aria": "从磁盘重新读取该文件并重新渲染",
    "previewToolbar.edit": "编辑",
    "previewToolbar.edit.aria": "将该预览切换为编辑器",
    "previewToolbar.preview": "预览",
    "previewToolbar.preview.aria": "切换回渲染后的预览",
    "previewToolbar.edit.disabledHint": "仅文本文件支持编辑",
    "previewToolbar.save": "保存",
    "previewToolbar.save.aria": "将编辑后的内容保存到磁盘上的文件",
    "previewToolbar.editorAria": "正在编辑文件内容。只有按下保存才会写入磁盘。",
    /* --- save / refresh feedback ----------------------------------- */
    "previewToolbar.savedAt": "已保存 {{time}}",
    "previewToolbar.saveFailed": "保存失败：{{error}}。编辑内容已保留。",
    "previewToolbar.refreshFailed": "刷新失败：{{error}}",
    "previewToolbar.fileGone": "文件可能已被删除、移动或路径已变化。",
    /* --- external-modification conflict ----------------------------- */
    "previewToolbar.conflict.title": "文件在磁盘上已被修改",
    "previewToolbar.conflict.detail":
      "该文件在你打开之后被其他人或程序修改过（磁盘版本：{{time}}，{{size}} 字节）。覆盖将替换那份修改；载入磁盘版本会丢弃你的编辑。",
    "previewToolbar.conflict.overwrite": "覆盖磁盘版本",
    "previewToolbar.conflict.reload": "载入磁盘版本",
    /* --- write-side credential gate (slice 16 alignment) ------------ */
    "previewToolbar.credential.title": "此文件默认只读",
    "previewToolbar.credential.detail":
      "{{name}} 是凭据形状的文件。由于 webui 可能从局域网访问，默认禁止在这里编辑它，除非你明确确认。",
    "previewToolbar.credential.editAnyway": "仍要编辑",
    "previewToolbar.credential.cancel": "取消",
    /* --- outline panel ---------------------------------------------- */
    "previewToolbar.toc.title": "大纲",
    "previewToolbar.toc.jump": "跳转到“{{text}}”",
    "previewToolbar.toc.active": "当前章节",
  },
} as const;

export type PreviewToolbarKey = keyof (typeof PREVIEW_TOOLBAR_STRINGS)["en"];

/**
 * Translate a preview-toolbar key. Same `{{param}}` interpolation and
 * en-fallback rules as `tFileOpen`.
 */
export function tPreviewToolbar(
  locale: Locale,
  key: PreviewToolbarKey,
  params?: Record<string, string | number | undefined | null>,
): string {
  const safeLocale = (locale === "zh" ? "zh" : "en") as "zh" | "en";
  const bucket = PREVIEW_TOOLBAR_STRINGS[safeLocale] || PREVIEW_TOOLBAR_STRINGS.en;
  const fallback: string = PREVIEW_TOOLBAR_STRINGS.en[key] ?? key;
  let value: string = bucket[key] || fallback;
  if (params) {
    for (const [name, raw] of Object.entries(params)) {
      const replacement = raw === null || raw === undefined ? "" : String(raw);
      value = value.replaceAll(`{{${name}}}`, replacement);
    }
  }
  return value;
}
