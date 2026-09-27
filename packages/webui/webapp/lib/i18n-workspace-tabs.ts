/**
 * Bilingual strings — slice 15 (Sidebar Workspace Tabs) only.
 *
 * Slice 15 registers its keys in `lib/i18n.ts` alongside every
 * other slice, so the central `MessageKey` union covers them and
 * the existing `t()` translator works out of the box. This module
 * is kept as a thin helper for two reasons:
 *
 *   1. Type-level isolation. The `WorkspaceTabKey` type lets a
 *      component render a slice-15 string without depending on the
 *      wider `MessageKey` union — useful for tests that want to
 *      pin the slice's vocabulary.
 *   2. The standalone strings table mirrors the en/zh block in
 *      `lib/i18n.ts` so an outside reader can see every slice-15
 *      string without grepping a 1000-line dictionary file. The
 *      runtime translator still goes through the central
 *      `translate` (so the values stay in lockstep).
 */

import type { Locale, MessageKey } from "./i18n";
import { translate } from "./i18n";

export const WORKSPACE_TAB_KEYS = [
  "workspaceTabs.tab.files",
  "workspaceTabs.tab.files.aria",
  "workspaceTabs.tab.git",
  "workspaceTabs.tab.git.aria",
  "workspaceTabs.tab.browser",
  "workspaceTabs.tab.browser.aria",
  "workspaceTabs.tab.tasks",
  "workspaceTabs.tab.tasks.aria",
  "workspaceTabs.tab.filePrefix",
  "workspaceTabs.launcher.files",
  "workspaceTabs.launcher.git",
  "workspaceTabs.launcher.tasks",
  "workspaceTabs.launcher.btw",
  "workspaceTabs.launcher.btw.disabledHint",
  "workspaceTabs.launcher.terminal",
  "workspaceTabs.launcher.terminal.disabledHint",
  "workspaceTabs.launcher.browser",
  "workspaceTabs.addTab.aria",
  "workspaceTabs.tabs.aria",
  "workspaceTabs.tabs.empty",
  "workspaceTabs.empty.heading",
  "workspaceTabs.empty.subtitle",
  "workspaceTabs.fileTab.pathAria",
  "workspaceTabs.fileTab.revealInTree",
  "workspaceTabs.fileTab.copyPath",
  "workspaceTabs.tasks.title",
  "workspaceTabs.tasks.subtitle",
  "workspaceTabs.tasks.empty",
  "workspaceTabs.tasks.jump",
  "workspaceTabs.tasks.toolCall",
  "workspaceTabs.tasks.sinceAgo",
  "workspaceTabs.tasks.minutesAgo",
  "workspaceTabs.tasks.hoursAgo",
  "workspaceTabs.tasks.jumpError",
  "workspaceTabs.column.resizeAria",
  "workspaceTabs.column.resetAria",
  "workspaceTabs.column.conversationAria",
  "workspaceTabs.column.panelAria",
  "workspaceTabs.column.secondaryAria",
  "workspaceTabs.column.closedAllTabs",
] as const satisfies readonly MessageKey[];

export type WorkspaceTabKey = (typeof WORKSPACE_TAB_KEYS)[number];

/**
 * Resolve a slice-15 string for the current locale. Delegates to
 * the central `translate` — the value lives in `lib/i18n.ts`'s
 * en / zh tables. Kept as a separate helper so a caller can declare
 * the narrower `WorkspaceTabKey` type at its boundary.
 */
export function tWorkspaceTab(locale: Locale, key: WorkspaceTabKey): string {
  return translate(locale, key);
}