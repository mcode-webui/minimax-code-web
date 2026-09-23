"use client";

import { useSessionContext, useTicker } from "@/lib/store";
import type { MessageKey } from "@/lib/i18n";
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
 * The browser button is still rendered, disabled: the upstream command is part
 * of the bar's contract, and the disabled state is what tells the user the
 * feature exists without wiring a no-op. `files` is the tab this server backs —
 * the directory tree comes from `GET /api/fs/read?path=<dir>` (a `scandir`,
 * not a file reader).
 */

interface ToolbarProps {
  t: (key: MessageKey) => string;
  onOpenWorkspace: () => void;
  onOpenFiles: () => void;
  /** Which panel is currently open, so its launcher can show the active state. */
  activePanel?: "workspace" | "files" | null;
}

export function ConversationToolbar({ t, onOpenWorkspace, onOpenFiles, activePanel = null }: ToolbarProps) {
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
      <div className="flex min-w-0 flex-1 translate-y-[2px] items-center gap-2 pr-20">
        <button
          type="button"
          aria-label={state?.sessionTitle || t("sidebar.untitled")}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm font-medium text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
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
      </div>

      {/* Panel launchers — the right extension area's tab list. Upstream pins
          this cluster with `fixed` so it floats over the scroll area; the flex
          row above therefore reserves its width (`pr-20` = `right-4` + two
          `size-[30px]` buttons + `gap-1`) so the trailing workspace name can
          never slide underneath it at a narrow viewport. */}
      <div className="fixed right-4 top-[15px] z-[80] flex items-center gap-1">
        <ToolbarButton
          label={t("toolbar.browser")}
          disabled
          title={`${t("toolbar.browser")} — ${t("common.unsupported")}`}
        >
          <Icon name="browser" size={16} />
        </ToolbarButton>
        <ToolbarButton label={t("toolbar.files")} onClick={onOpenFiles} active={activePanel === "files"}>
          <Icon name="folder" size={16} />
        </ToolbarButton>
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
