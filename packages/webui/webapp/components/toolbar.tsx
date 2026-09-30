"use client";

import { useSessionContext, useTicker } from "@/lib/store";
import type { MessageKey } from "@/lib/i18n";
import { VersionBadgeChip } from "@/components/version-badge";
import { Icon } from "./icons";

/**
 * Conversation toolbar.
 *
 * Structure is copied from the upstream renderer's conversation view:
 *
 *   <bar>     flex h-[56px] items-center flex-shrink-0 pl-2
 *   <title>   flex min-w-0 flex-1 translate-y-[2px] items-center pr-3
 *   <actions> fixed right-4 top-[15px] z-[80]  — a bordered h-7 group holding the
 *             workspace control, then size-[30px] icon buttons
 *
 * The right-hand group is pinned with `fixed` upstream (it sits over the scroll
 * area rather than inside it), which is reproduced here.
 *
 * What belongs in this bar: upstream models it as the **right-hand extension
 * area's tab list** — its own command registry names the surfaces
 * (`sidebar_toggle`, `files_open`, `terminal_toggle`, `browser_open`,
 * `workspace_panel_toggle: "显示或隐藏右侧拓展区" → "切换文件、终端与浏览器所在的右侧拓展区"`).
 * So the bar is for opening panels, not for account-level actions: settings and
 * notifications live in the account menu (see `SidebarFooter`), which is also
 * where upstream keeps them.
 *
 * Slice 04b: the browser button now opens the slice-04 browser panel
 * instead of staying disabled — the upstream command `browser_open` is
 * part of the bar's contract, and the panel it now opens is the
 * sandboxed iframe preview over `/api/fs/raw` (see
 * `components/browser-panel.tsx`).
 */

interface ToolbarProps {
  t: (key: MessageKey) => string;
  onOpenWorkspace: () => void;
  onOpenFiles: () => void;
  /** Open the right-hand Git panel (slice 03 of webui-parity). */
  onOpenGit?: () => void;
  /** Open the built-in browser panel (slice 04b of webui-parity). */
  onOpenBrowser: () => void;
  /** Which panel is currently open, so its launcher can show the active state. */
  activePanel?: "workspace" | "files" | "git" | "browser" | null;
}

export function ConversationToolbar({
  t,
  onOpenWorkspace,
  onOpenFiles,
  onOpenGit,
  onOpenBrowser,
  activePanel = null,
}: ToolbarProps) {
  const { state } = useSessionContext();
  // `running` is the live half of the session's state: the server sets it when a
  // turn starts and clears it when the turn ends, and it arrives over SSE. The
  // transcript has its own indicator, but that one is only visible when the
  // transcript is scrolled to it — this bar is always on screen, which is what
  // answers "is it still working?" without hunting for it.
  const running = state?.running.active ?? false;
  const startedAt = state?.running.startedAt ?? null;
  const now = useTicker(1000);
  const elapsed = running && startedAt ? formatElapsed(now - startedAt) : null;
  const tps = state?.context.tps ?? 0;

  return (
    <div className="flex h-[56px] flex-shrink-0 items-center pl-2">
      {/* Session title with chevron. The chevron is the title's "what is this
          conversation" disclosure — upstream uses it to rename / move the
          session; the server has no rename endpoint yet, so the disclosure
          is purely presentational. */}
      {/* `pr-[160px]` reserves the width the `fixed right-4` launcher
          cluster below actually occupies PLUS 12px of breathing room:
          4 × `size-[30px]` + 3 × `gap-1` + `right-4` = 148px, and
          flush against the icons reads as one control rather than two.
          It was `pr-20` (80px) — an under-count that stayed invisible
          because the row's only trailing content used to be nothing
          (the title is left-aligned, so a too-small reserve could not
          collide with anything). webui-parity 89 put the version badge
          at the row's far end with `ml-auto`, which is what finally
          measured it: 68px UNDER the cluster at 1440px wide. */}
      <div className="flex min-w-0 flex-1 translate-y-[2px] items-center gap-2 pr-[160px]">
        {/* `min-w-0` makes the title the row's ELASTIC member. It was
            not, so the title refused to shrink and the badge — the only
            other item that can — was crushed to zero width instead.
            The title already owns a `truncate` span for exactly this
            job; it just had no way to be given less room. */}
        <button
          type="button"
          aria-label={state?.sessionTitle || t("sidebar.untitled")}
          className="flex h-8 min-w-0 items-center gap-1 rounded-lg px-2 text-sm font-medium text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          <span className="max-w-[420px] truncate">{state?.sessionTitle || t("sidebar.untitled")}</span>
          <Icon name="chevronDown" size={14} />
        </button>
        {running ? (
          <span
            data-testid="toolbar-session-status"
            className="flex flex-shrink-0 items-center gap-2 text-caption-small-strong text-text_default_tertiary"
          >
            <span className="mavis-loading">
              <span className="mavis-dot mavis-dot-a" />
              <span className="mavis-dot mavis-dot-b" />
              <span className="mavis-dot mavis-dot-c" />
            </span>
            <span>{t("chat.status.running")}</span>
            {elapsed ? <span className="tabular-nums">{elapsed}</span> : null}
            {tps > 0 ? (
              <span className="tabular-nums">
                {Math.round(tps)} {t("chat.tps")}
              </span>
            ) : null}
          </span>
        ) : null}
        {/* webui-parity 89 (F-4) — the version badge. Placement is the
            one place in this bar that is both always-on and never
            actionable, so it goes at the FAR END of the title row
            (`ml-auto`), opposite the session title it qualifies: the
            title answers "what am I looking at", the badge answers
            "which checkout am I looking at", and reading them as one
            left-to-right pair is the question the user actually has.
            It sits BEFORE the `pr-20` reserve, so the fixed launcher
            cluster can never overlap it at a narrow viewport. */}
        <VersionBadgeChip t={t} now={now} />
      </div>

      {/* Panel launchers — the right extension area's tab list. Upstream pins
          this cluster with `fixed` so it floats over the scroll area; the flex
          row above therefore reserves its width (`pr-20` = `right-4` + three
          `size-[30px]` buttons + `gap-1`) so the trailing workspace name can
          never slide underneath it at a narrow viewport. */}
      <div className="fixed right-4 top-[15px] z-[80] flex items-center gap-1">
        <ToolbarButton
          label={t("toolbar.browser")}
          onClick={onOpenBrowser}
          active={activePanel === "browser"}
          title={t("toolbar.browser")}
        >
          <Icon name="browser" size={16} />
        </ToolbarButton>
        <ToolbarButton label={t("toolbar.files")} onClick={onOpenFiles} active={activePanel === "files"}>
          <Icon name="folder" size={16} />
        </ToolbarButton>
        {/* Git panel (slice 03): right-panel surface mirroring the
            desktop's `changes` tab. The button is hidden if `onOpenGit`
            is not provided (defensive — older callers that haven't been
            updated to pass it still work). The active state lights up
            when the right-panel is currently showing the GitPanel. */}
        {onOpenGit ? (
          <ToolbarButton
            label={t("toolbar.git")}
            onClick={onOpenGit}
            active={activePanel === "git"}
            data-testid="toolbar-git-button"
          >
            <Icon name="git" size={16} />
          </ToolbarButton>
        ) : null}
        <ToolbarButton
          label={t("toolbar.workspace")}
          onClick={onOpenWorkspace}
          active={activePanel === "workspace"}
        >
          <Icon name="workspace" size={16} />
        </ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  badge,
  tone,
  active,
  disabled,
  title,
  children,
}: {
  label: string;
  onClick?: () => void;
  badge?: string;
  tone?: "warn";
  active?: boolean;
  disabled?: boolean;
  /** Overrides the tooltip — used to say why a launcher is not available. */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={[
        "relative flex size-[30px] flex-shrink-0 select-none items-center justify-center rounded-[8px] transition-colors",
        disabled
          ? "cursor-not-allowed text-icon_default_tertiary opacity-40"
          : active
            ? "bg-bg_interaction_tertiary_hover text-icon_default_primary"
            : "text-icon_default_secondary hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary",
      ].join(" ")}
    >
      {children}
      {badge ? (
        <span
          className={[
            "absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none text-text_default_inverted_static",
            tone === "warn" ? "bg-bg_status_warning" : "bg-bg_status_error",
          ].join(" ")}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Alerts count for the sidebar's inbox dot.
 *
 * The count comes from the shared alerts stream (lib/alerts.ts) — `/api/alerts`
 * is SSE, so it is subscribed to rather than polled. Re-exported here because
 * the shell reads it alongside the other toolbar-derived state.
 */
export { useAlertCount } from "@/lib/alerts";

/** `m:ss` for a turn in flight — long enough to stay readable, never a date. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
