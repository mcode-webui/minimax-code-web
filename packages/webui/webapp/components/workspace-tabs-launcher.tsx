"use client";

/**
 * Tab launcher + empty-state (slice 15).
 *
 * Renders the vertical launcher list the 07 / 08 references show under
 * the tab strip: `Files / Changes / Tasks / Side chat (beta) /
 * Terminal / Browser`. Each entry is a button with an icon, label,
 * and (for the two "not implemented" surfaces) a tooltip explaining
 * the gap so a click does not silently do nothing.
 *
 * The launcher has two states:
 *   - **Inline launcher** — the panel column has zero tabs; the
 *     launcher IS the content. This is the 07 reference exactly.
 *   - **Popover launcher** — the panel column has tabs but the user
 *     clicked the "+" pill on the strip. Closes on outside-click and
 *     on Escape.
 *
 * Both states call the same `onPick` handler so the page only
 * needs one entry point per launcher kind (open / disabled-hint).
 */

import type { Locale, MessageKey } from "@/lib/i18n";
import { Icon, type IconName } from "./icons";
import type { SurfaceTabKind } from "@/lib/workspace-tabs-state";

/**
 * The four kinds the launcher can open. Mirrors
 * `SURFACE_TAB_KINDS` — kept as a separate const so the renderer's
 * loop reads as the launcher's six visible rows.
 */
const LAUNCHER_ROWS: ReadonlyArray<{
  kind: SurfaceTabKind | "btw" | "terminal";
  labelKey: "workspaceTabs.launcher.files" | "workspaceTabs.launcher.git" | "workspaceTabs.launcher.tasks" | "workspaceTabs.launcher.browser" | "workspaceTabs.launcher.btw" | "workspaceTabs.launcher.terminal";
  icon: IconName;
  // Surface kinds land on a tab; the two "not implemented" entries
  // are clearly disabled and surface a hint copy on hover.
  implemented: boolean;
}> = [
  { kind: "files", labelKey: "workspaceTabs.launcher.files", icon: "folder", implemented: true },
  { kind: "git", labelKey: "workspaceTabs.launcher.git", icon: "git", implemented: true },
  { kind: "tasks", labelKey: "workspaceTabs.launcher.tasks", icon: "workspace", implemented: true },
  { kind: "btw", labelKey: "workspaceTabs.launcher.btw", icon: "browser", implemented: false },
  { kind: "terminal", labelKey: "workspaceTabs.launcher.terminal", icon: "terminal", implemented: false },
  { kind: "browser", labelKey: "workspaceTabs.launcher.browser", icon: "browserGlobe", implemented: true },
];

export interface WorkspaceTabsLauncherProps {
  locale: Locale;
  t: (key: MessageKey) => string;
  /** Called when the user picks a launcher row. Receives the kind. */
  onPick: (kind: SurfaceTabKind) => void;
  /** Called when the user picks a "not implemented" row — the
   *  caller can decide to show a transient hint or do nothing. */
  onDisabledHint?: (kind: "btw" | "terminal") => void;
  /** When `true`, render the launcher in popover mode (anchored
   *  under the "+" pill). When `false`, render the launcher inline
   *  as the panel column's empty state. */
  mode: "popover" | "inline";
}

/**
 * The launcher body — the same six rows regardless of mode. The
 * popover / inline distinction is owned by the wrapper below.
 *
 * The `locale` prop is reserved for a future locale-aware branch
 * (e.g. an RTL toggle) — the renderer does not need it today, so
 * it stays in the signature but is unused at the call site.
 */
export function WorkspaceTabsLauncher({
  locale: _locale,
  t,
  onPick,
  onDisabledHint,
  mode: _mode,
}: WorkspaceTabsLauncherProps) {
  // `_locale` and `_mode` are reserved for a future locale-aware
  // branch (e.g. an RTL toggle) and a popover-vs-inline style
  // tweak respectively. The renderer does not need them today, so
  // they are still in the signature (callers do not need to
  // re-thread) but unused at the call site.
  void _locale;
  void _mode;
  return (
    <div
      className="flex w-full flex-col gap-1"
      data-testid="workspace-tabs-launcher"
      data-mode={_mode}
      role="listbox"
      aria-label={t("workspaceTabs.tabs.aria")}
    >
      {LAUNCHER_ROWS.map((row) => {
        if (row.implemented) {
          const surfaceKind = row.kind as SurfaceTabKind;
          return (
            <button
              key={row.kind}
              type="button"
              data-testid={`workspace-tabs-launcher-${row.kind}`}
              role="option"
              aria-label={t(row.labelKey)}
              onClick={() => onPick(surfaceKind)}
              className="flex h-[34px] w-full items-center gap-2 rounded-[10px] px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              <span className="flex size-4 flex-shrink-0 items-center justify-center text-icon_default_secondary">
                <Icon name={row.icon} size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate text-left">{t(row.labelKey)}</span>
            </button>
          );
        }
        // Disabled surface — surface a tooltip with the "not
        // implemented" hint copy so a click does not silently no-op.
        const disabledKind = row.kind as "btw" | "terminal";
        const hintKey =
          disabledKind === "btw"
            ? "workspaceTabs.launcher.btw.disabledHint"
            : "workspaceTabs.launcher.terminal.disabledHint";
        const hint = t(hintKey);
        return (
          <button
            key={row.kind}
            type="button"
            data-testid={`workspace-tabs-launcher-${row.kind}`}
            data-disabled="true"
            title={hint}
            aria-label={`${t(row.labelKey)} — ${hint}`}
            disabled
            onClick={() => onDisabledHint?.(disabledKind)}
            className="flex h-[34px] w-full cursor-not-allowed items-center gap-2 rounded-[10px] px-3 text-sm text-text_default_tertiary opacity-50"
          >
            <span className="flex size-4 flex-shrink-0 items-center justify-center">
              <Icon name={row.icon} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{t(row.labelKey)}</span>
            <span className="flex-none text-caption-small-strong text-text_default_tertiary">
              —
            </span>
          </button>
        );
      })}
    </div>
  );
}

// kept above — `_mode` and `_locale` are reserved destructure
// names that the prop signature keeps around without a current
// renderer call site.