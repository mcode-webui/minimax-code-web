// webapp/lib/sidebar-nav.ts
//
// Sidebar nav-row activation (webui-parity 47, N2).
//
// Why this lives in its own module: the signal has two inputs the sidebar
// cannot see at once — the engine's active session id (via the store) and
// the page-owned tab strip's active tree surface (passed down as a prop
// through AppShell) — and the rule is pure. Keeping it a pure function means
// the regression suite drives the real decision logic rather than asserting
// on rendered classes only, and the shell stays a thin caller.
//
// The rule mirrors the reference rail: sibling surface rows (搜索 / 插件)
// light when their surface owns the tree column; the action row (新建会话,
// the reference's 新建任务) lights only in "home mode" — no session
// selected — and only while no sibling surface owns the screen.

import type { MessageKey } from "./i18n";

/** Which sidebar-owned tree-column surface is currently active. */
export type SidebarNavSurface = "search" | "plugins" | null;

/**
 * Whether the nav row for `key` should render its active state.
 *
 * `sessionId` is the engine's active session id (`null` on the home
 * screen); `activeSurface` is the page-computed tree-surface signal.
 */
export function isSidebarNavActive(
  key: MessageKey,
  sessionId: string | null,
  activeSurface: SidebarNavSurface,
): boolean {
  if (key === "sidebar.search") return activeSurface === "search";
  if (key === "sidebar.plugins") return activeSurface === "plugins";
  if (key === "topbar.newSession") {
    return sessionId === null && activeSurface === null;
  }
  return false;
}
