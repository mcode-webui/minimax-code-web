"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input as AntInput, type InputRef, Segmented as AntSegmented, Switch } from "antd";

import * as api from "@/lib/api";
import { useAlerts } from "@/lib/alerts";
import { InboxList } from "./inbox";
import { useSessionContext } from "@/lib/store";
import { applyTheme, currentTheme } from "@/lib/theme";
import { matchFilter } from "@/lib/workspace-filter";
import type { Locale, MessageKey } from "@/lib/i18n";
import type { ThemeName } from "@/lib/types";
import { Icon } from "./icons";

/**
 * Right-hand drawer.
 *
 * The container is upstream's right panel, reproduced as-is: an `aside` with a
 * width transition and an inset shadow on its left edge
 * (`shadow-[inset_8px_0px_12px_-8px_var(--opacity_black_1_8)]`), so opening it
 * looks like upstream's panel opening. The width is **fixed** at 288px so every
 * panel — workspace / files / alerts / search / progress / plugins — is the
 * same size regardless of viewport or content.
 *
 * Upstream fills that panel with a file/diff preview. This frontend has no such
 * feature, so the shell carries the panels this server actually backs. Settings
 * is *not* here — it is a dismissible dialog (`SettingsModal` below), because it
 * is a destination the user opens and closes rather than a side-by-side
 * surface.
 */

export type PanelKind = "workspace" | "files" | "alerts" | "search" | "progress" | "plugins";

export function RightPanel({
  kind,
  onClose,
  t,
}: {
  kind: PanelKind;
  /** Used by the search panel for its own Esc/blanket/close affordance. The
   *  container does not render its own close button (upstream's Drawer has
   *  no title row, see 反编译 eK in 36705 chunk). */
  onClose: () => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <aside
      className="h-full min-h-0 w-[288px] shrink-0 overflow-hidden"
      data-testid={`right-panel-${kind}`}
      // Same hairline as the sidebar's right edge (0.6px of --border_light), so the
      // drawer is separated from the transcript column exactly like upstream's
      // extension area is. The inset shadow below stays as the softer inner edge.
      // Width 288px matches upstream's `i.w4` Drawer `width:288` (see SPEC §H,
      // `workspace_panel.body`). Upstream's Drawer body is the panel content
      // with `pr-3`, no title row.
      style={{ borderLeft: "0.6px solid var(--border_light)" }}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden pr-4 shadow-[inset_8px_0px_12px_-8px_var(--opacity_black_1_8)]">
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {kind === "workspace" ? <WorkspacePanel t={t} /> : null}
          {kind === "files" ? <FilesPanel t={t} /> : null}
          {kind === "alerts" ? <AlertsPanel t={t} /> : null}
          {kind === "search" ? <SearchPanel onClose={onClose} t={t} /> : null}
          {kind === "progress" ? <ProgressPanel t={t} /> : null}
          {kind === "plugins" ? <PluginsPanel t={t} /> : null}
        </div>
      </div>
    </aside>
  );
}

/**
 * Settings.
 *
 * Upstream has no `/settings` route: settings is a two-column modal inside the main
 * surface. This reproduces the desktop (electron) variant — full viewport, a 260px
 * sidebar carrying a back affordance and a search box, and a content column capped at
 * 704px on the grouped-secondary background.
 *
 * The sidebar's category tree is upstream's, names included (`偏好/管理/编码/归档`
 * groups over `通用/外观/语音/快捷键/个性化/浏览器`, `用量与模型/连接/账户`,
 * `代码审查/工作树`, `已归档任务`). Only the categories this server can actually drive
 * are enabled; the rest are rendered disabled with the standing 暂不支持 marker rather
 * than hidden, so the surface still reads as the desktop's and nobody has to guess
 * whether a category is missing or unsupported.
 *
 * The body is the same `SettingsPanel` the drawer hosts, now told which section to
 * render — the settings contract itself did not move.
 */
type SettingsSection =
  | "general"
  | "appearance"
  | "connection";

const SETTINGS_NAV: {
  group: MessageKey;
  items: { id: string; key: MessageKey; section?: SettingsSection }[];
}[] = [
  {
    group: "settings.group.preferences",
    items: [
      { id: "general", key: "settings.tab.general", section: "general" },
      { id: "appearance", key: "settings.appearance", section: "appearance" },
      { id: "voice", key: "settings.tab.voice" },
      { id: "shortcuts", key: "settings.tab.shortcuts" },
      { id: "personalization", key: "settings.tab.personalization" },
      { id: "browser", key: "settings.tab.browser" },
    ],
  },
  {
    group: "settings.group.management",
    items: [
      { id: "connection", key: "settings.tab.connection", section: "connection" },
      { id: "account", key: "settings.tab.account" },
    ],
  },
  {
    group: "settings.group.coding",
    items: [
      { id: "code-review", key: "settings.tab.codeReview" },
      { id: "worktree", key: "settings.tab.worktree" },
    ],
  },
  {
    group: "settings.group.archived",
    items: [{ id: "archived", key: "settings.tab.archived" }],
  },
];

export function SettingsModal({
  open,
  onClose,
  t,
  locale,
  setLocale,
}: {
  open: boolean;
  onClose: () => void;
  t: (key: MessageKey) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}) {
  const [active, setActive] = useState("general");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const needle = query.trim().toLowerCase();
  const groups = SETTINGS_NAV.map((group) => ({
    ...group,
    items: needle
      ? group.items.filter((item) => t(item.key).toLowerCase().includes(needle))
      : group.items,
  })).filter((group) => group.items.length > 0);

  const current = SETTINGS_NAV.flatMap((group) => group.items).find((item) => item.id === active);
  const section = current?.section;

  return (
    <div className="fixed inset-0 z-[1000] flex">
      {/* Upstream dims with the blanket token rather than a hardcoded black. */}
      <div className="absolute inset-0 bg-utility_blanket" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("panel.settings")}
        data-testid="settings-modal"
        className="two-column-modal relative flex h-full w-full overflow-hidden bg-bg_grouped_secondary"
      >
        {/* Back affordance + search + the grouped category tree. */}
        <div className="flex w-[260px] flex-shrink-0 flex-col gap-2 overflow-y-auto bg-bg_default_scrim px-3 pt-3 pb-5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t("settings.back")}
              onClick={onClose}
              className="flex size-7 flex-none items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
            >
              <Icon name="reply" size={16} className="rotate-180" />
            </button>
            <AntInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings.searchPlaceholder")}
              aria-label={t("settings.searchPlaceholder")}
              data-testid="settings-search-input"
              // .mavis-input is the desktop skin (36px / 8px radius / token-based
              // bg/border). The previous hand-rolled <input> was 32px / 8px — the
              // extra 4px come from the official desktop class. Acceptable: this is
              // a settings-modal search field, not a 1:1 match to a desktop widget.
              className="mavis-input min-w-0 flex-1"
            />
          </div>

          {groups.length === 0 ? (
            <p className="px-3 py-2 text-sm text-text_default_tertiary">
              {t("settings.searchNoResults")}
            </p>
          ) : null}

          {groups.map((group) => (
            <div key={group.group} className="flex flex-col gap-0.5">
              <span className="desktop-text-ui-assist px-3 py-1 text-text_default_tertiary">
                {t(group.group)}
              </span>
              {group.items.map((item) => {
                const disabled = !item.section;
                const selected = item.id === active;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={disabled}
                    title={disabled ? t("common.unsupported") : undefined}
                    aria-current={selected ? "page" : undefined}
                    data-testid={`settings-tab-${item.id}`}
                    onClick={() => setActive(item.id)}
                    // Upstream's `.menu-item`: gap 12px, padding 8px 12px, radius 8px,
                    // hover/selected on the tertiary interaction tokens, and an
                    // inset focus ring on keyboard focus.
                    className={[
                      "flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left text-sm transition-colors focus:outline-none",
                      disabled
                        ? "cursor-not-allowed text-text_default_tertiary opacity-50 focus-visible:shadow-[inset_0_0_0_1px_var(--border_accent)]"
                        : selected
                          ? "bg-bg_interaction_tertiary_selected text-text_default_primary focus-visible:shadow-[inset_0_0_0_1px_var(--border_accent)]"
                          : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover focus-visible:shadow-[inset_0_0_0_1px_var(--border_accent)]",
                    ].join(" ")}
                  >
                    <span className="min-w-0 flex-1 truncate">{t(item.key)}</span>
                    {disabled ? (
                      <span className="flex-none text-caption-small-strong text-text_default_tertiary">
                        {t("common.unsupported")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Content on the grouped-secondary background, capped at upstream's 704px. */}
        <div
          role="separator"
          aria-orientation="vertical"
          className="w-0 border-l-[0.5px] border-border_light"
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full min-w-[320px] max-w-[704px] px-6 py-6">
            <SettingsPanel t={t} locale={locale} setLocale={setLocale} section={section} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Progress panel.
 *
 * Upstream renders a chronological feed of tool activity, plan/ask decisions and
 * recent assistant turns for the active run — the `进度` tab on the right edge.
 * The server does not expose a dedicated progress feed, so this view falls back
 * to the recent alerts + the active session's running activity, giving the same
 * "what is happening right now" surface.
 */
function ProgressPanel({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const [open, setOpen] = useState(true);
  // The alert ring buffer, newest first, from the shared alerts stream
  // (lib/alerts.ts).
  const { alerts } = useAlerts();

  const running = state?.running.active ?? false;
  const thinking = state?.context.thinkingStatus ?? "";

  return (
    <div className="flex flex-col gap-3">
      {/* Collapsible header. Upstream renders `进度 ⌄` plus the subtitle on
          the same line; clicking the header toggles whether the body shows. */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-2 py-1 text-left"
      >
        <span className="min-w-0 flex-1 text-sm font-medium text-text_default_primary">
          {t("panel.progress")}
        </span>
        <span
          className={[
            "flex size-4 items-center justify-center text-icon_default_secondary transition-transform duration-200",
            open ? "rotate-180" : "",
          ].join(" ")}
        >
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      <p className="-mt-2 px-2 text-caption-small-strong text-text_default_tertiary">
        {t("panel.progress.subtitle")}
      </p>

      {open ? (
        <div className="flex flex-col gap-3">
          <Field label={t("chat.thinking")}>
            <div className="flex items-center gap-2 text-text_default_primary">
              <span
                className={[
                  "size-2 rounded-full",
                  running ? "bg-bg_status_positive" : "bg-bg_status_neutral",
                ].join(" ")}
                aria-hidden
              />
              <span>{running ? thinking || t("chat.thinking") : "—"}</span>
            </div>
          </Field>

          <Field label={t("toolbar.alerts")}>
            {alerts.length === 0 ? (
              <span className="text-caption-small-strong text-text_default_tertiary">
                {t("panel.progress.empty")}
              </span>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {alerts.slice(0, 12).map((alert) => (
                  <li
                    key={alert.id}
                    className="flex items-start gap-2 rounded-lg bg-bg_grouped_tertiary px-2 py-1.5 text-caption-small-strong text-text_default_secondary"
                  >
                    <span
                      className={[
                        "mt-1 size-1.5 flex-shrink-0 rounded-full",
                        alert.level === "error"
                          ? "bg-bg_status_error"
                          : alert.level === "warn"
                            ? "bg-bg_status_warning"
                            : "bg-bg_status_positive",
                      ].join(" ")}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 break-words">{alert.msg}</span>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Plugin marketplace.
 *
 * Stub — the real implementation lives behind the engine's plugin install
 * contract, which this server does not expose yet. The desktop client renders
 * a category-tabs + grid-of-cards layout (市场 / 个人 tabs, 安装 buttons).
 * Until that contract lands, show the affordance plus a "正在做" notice so the
 * click target is real and the user knows we know it's missing. See shell.tsx
 * sidebar.nav for the desktop order.
 */
function PluginsPanel({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="desktop-text-dialog-medium text-base font-medium leading-6 text-text_default_primary">
        {t("panel.plugins.title")}
      </div>
      <div className="flex items-start gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-3">
        <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-bg_interaction_tertiary_hover text-icon_default_secondary">
          <Icon name="plugins" size={14} />
        </span>
        <div className="desktop-text-ui-body min-w-0 flex-1 text-sm leading-5 text-text_default_secondary">
          {t("panel.plugins.placeholder")}
        </div>
      </div>
    </div>
  );
}

// --- workspace --------------------------------------------------------------

// How many directory entries the files panel lists before truncating.
const FILES_VISIBLE_LIMIT = 200;

/**
 * Files panel — upstream's 文件 tab in its right-hand extension area.
 *
 * Backed by `GET /api/fs/read`, which is a **scandir**: it lists a directory and
 * refuses a file with `ENOTDIR`. So this is a navigator, not a viewer — there is
 * no file-content endpoint to render a preview from, and rather than fake one the
 * panel stays a directory browser. Directories are drillable; files are listed
 * with their size and left non-interactive, because a row that looks clickable
 * and opens nothing is the failure mode this frontend keeps having to fix.
 *
 * Navigation state is the filesystem itself (`path` + the `parent` the server
 * returns), so there is no client-side stack that can drift from reality.
 */
function FilesPanel({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const [path, setPath] = useState<string>(state?.workspace.dir ?? "");
  const [listing, setListing] = useState<api.FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Filter over the listing — case-insensitive, `*` / `?` globs, applied AFTER
  // the server returns the scandir listing. The FILES_VISIBLE_LIMIT cap below
  // still bounds what is rendered. See `lib/workspace-filter.ts` for the matcher
  // and the promise its placeholder makes.
  const [filter, setFilter] = useState("");

  const load = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const next = await api.getFsDir(target);
      if (next.ok) {
        setListing(next);
        setError(null);
      } else {
        setError(next.error ?? "unreadable");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const entries = listing?.entries ?? [];
  // Directories first, then files; each group alphabetical. This is how a file
  // browser is expected to read, and the server returns raw scandir order.
  const dirs = entries.filter((e) => e.type === "dir");
  const files = entries.filter((e) => e.type !== "dir");
  // The cap is reported rather than silent, so a truncated list never looks like
  // the whole directory.
  const ordered = [...dirs, ...files];
  // Filter first, then cap: the cap must bound the *matches*, not the directory.
  // Capping first would let a filter on a large directory render nothing at all,
  // because the rows the user is looking for were cut before the filter ran.
  const matched = filter ? ordered.filter((entry) => matchFilter(entry.name, filter)) : ordered;
  const visible = matched.slice(0, FILES_VISIBLE_LIMIT);
  const hidden = matched.length - visible.length;

  const formatSize = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Up one level, plus the current directory. The path is the identity of
          this view, so it is shown rather than only breadcrumbed. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && setPath(listing.parent)}
          aria-label={t("files.parent")}
          title={t("files.parent")}
          data-testid="files-up"
          className="flex size-7 flex-shrink-0 items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary disabled:opacity-40"
        >
          <Icon name="chevronRight" size={14} className="rotate-180" />
        </button>
        <span
          data-testid="files-path"
          className="min-w-0 flex-1 truncate text-caption-small-strong text-text_default_tertiary"
          title={listing?.path ?? path}
        >
          {listing?.path ?? path}
        </span>
      </div>

      {/* Filter over this directory's entries. It sits below the path row on
          purpose: that row is navigation (which directory am I in), the filter
          narrows that directory's contents. Case-insensitive, with `*` / `?`
          globs, exactly what the placeholder promises. */}
      <div className="flex items-center gap-1">
        <AntInput
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("files.filterPlaceholder")}
          aria-label={t("files.filterPlaceholder")}
          data-testid="files-filter"
          className="mavis-input min-w-0 flex-1"
        />
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter("")}
            aria-label={t("files.clearFilter")}
            title={t("files.clearFilter")}
            data-testid="files-filter-clear"
            className="flex size-8 flex-shrink-0 items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
          >
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="text-caption-small-strong text-text_status_error">{error}</p>
      ) : null}
      {loading && entries.length === 0 ? (
        <p className="text-caption-small-strong text-text_default_tertiary">{t("app.connecting")}</p>
      ) : null}

      <div className="flex flex-col">
        {visible.map((entry) => {
          const isDir = entry.type === "dir";
          const row = (
            <>
              <span className="flex size-4 flex-shrink-0 items-center justify-center text-icon_default_secondary">
                <Icon name={isDir ? "folder" : "file"} size={15} />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
                {entry.name}
              </span>
              {!isDir && entry.size > 0 ? (
                <span className="flex-shrink-0 text-caption-small-strong text-text_default_tertiary">
                  {formatSize(entry.size)}
                </span>
              ) : null}
            </>
          );
          return isDir ? (
            <button
              key={entry.path}
              type="button"
              data-testid="files-dir-row"
              data-path={entry.path}
              onClick={() => setPath(entry.path)}
              className="flex h-[28px] w-full items-center gap-2 rounded-lg px-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              {row}
            </button>
          ) : (
            <div
              key={entry.path}
              data-testid="files-file-row"
              className="flex h-[28px] w-full items-center gap-2 rounded-lg px-1.5"
            >
              {row}
            </div>
          );
        })}
        {hidden > 0 ? (
          <p
            data-testid="files-truncated"
            className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
          >
            {t("files.showing")} {visible.length} / {ordered.length}
          </p>
        ) : null}
        {!loading && entries.length === 0 && !error ? (
          <p className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary">
            {t("files.empty")}
          </p>
        ) : null}
        {/* A non-empty directory whose rows were all filtered out is a different
            state from an empty directory — "Empty folder" would be a lie. */}
        {!loading && entries.length > 0 && matched.length === 0 ? (
          <p
            data-testid="files-no-match"
            className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
          >
            {t("files.noMatch")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function WorkspacePanel({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  // The git rows are active in upstream — disabled would lie. The webui does
  // not yet expose these endpoints, so a click surfaces an explicit transient
  // notice inside the section itself (instead of mutating the global alert
  // ring buffer, which is reserved for engine-emitted events).
  const [missingEndpoint, setMissingEndpoint] = useState<string | null>(null);

  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="workspace-section-group"
    >
      {/* §1 section_environmental — branch in subtitle, 3 git entries as
          active buttons. Branch placeholder uses `\u00a0` (upstream's choice)
          rather than `undefined` so the header keeps its height when the
          engine has not yet picked a workspace. */}
      <WorkspaceSection
        title={t("workspace.sectionEnvironment")}
        subtitle={state?.workspace.branch ?? "\u00a0"}
      >
        <div className="flex flex-col gap-px">
          {(
            [
              { row: "changes", testid: "workspace-changes-entry", icon: "file" },
              { row: "commitAndPush", testid: "workspace-commit-entry", icon: "file" },
              { row: "openTerminal", testid: "workspace-open-terminal-entry", icon: "terminal" },
            ] as const
          ).map(({ row, testid, icon }) => (
            <button
              key={row}
              type="button"
              data-testid={testid}
              title={t("workspace.env.activeHint")}
              onClick={() => setMissingEndpoint(row)}
              className="flex h-8 w-full items-center gap-2 rounded-[8px] pl-1.5 pr-2 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              <span className="flex size-5 flex-none items-center justify-center text-icon_default_primary">
                <Icon name={icon} size={20} />
              </span>
              <span className="desktop-text-ui-body min-w-0 flex-1 truncate text-sm text-text_default_primary">
                {t(`workspace.${row}` as MessageKey)}
              </span>
            </button>
          ))}
          {missingEndpoint ? (
            <p
              data-testid="workspace-env-missing-endpoint"
              className="mt-1 rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5 text-caption-small-strong text-text_default_tertiary"
            >
              {t("workspace.env.activeHint")}
            </p>
          ) : null}
        </div>
      </WorkspaceSection>

      {/* §2 section_plan — upstream shows the run's plan review card. */}
      <WorkspaceSection title={t("workspace.sectionPlan")}>
        <SectionPlaceholder testid="workspace-plan" t={t} />
      </WorkspaceSection>

      {/* §3 agent_team — upstream renders the `PreviewerMini` embedded variant
          listing delegated runs. */}
      <WorkspaceSection title={t("workspace.sectionAgentTeam")}>
        <SectionPlaceholder testid="workspace-agent-team" t={t} />
      </WorkspaceSection>

      {/* §4 working_folders — upstream renders the folder tree of the active
          workspace. */}
      <WorkspaceSection title={t("workspace.sectionWorkingFolders")}>
        <SectionPlaceholder testid="workspace-working-folders" t={t} />
      </WorkspaceSection>

      {/* §5 sources — upstream renders a card with the icons of sources the
          run has read from. */}
      <WorkspaceSection title={t("workspace.sectionSources")}>
        <SectionPlaceholder testid="workspace-sources" t={t} />
      </WorkspaceSection>

      {/* §6 cloudResultReview / 交付物 — upstream renders the cloud-session
          result review (its "deliverables" surface). */}
      <WorkspaceSection title={t("workspace.sectionDeliverables")}>
        <SectionPlaceholder testid="workspace-cloud-result" t={t} />
      </WorkspaceSection>
    </div>
  );
}

/**
 * A named section inside the workspace panel.
 *
 * Upstream's section header carries an optional subtitle — for 环境信息 that is
 * the current git branch. The upstream code falls back to `\u00a0` (a
 * non-breaking space) when the branch is missing, so the header keeps its
 * height; we mirror that. Body styling matches upstream's `_.N` section
 * wrapper: vertical stack, 4px gap, 6px left padding on the header so the
 * title aligns with the row icons.
 */
function WorkspaceSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex w-full flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2 px-1.5">
        <span className="desktop-text-ui-small-strong text-text_default_primary">{title}</span>
        {subtitle ? (
          <span className="desktop-text-ui-assist min-w-0 truncate text-text_default_tertiary">
            {subtitle}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Honest placeholder used inside sections whose upstream data (planReview,
 * teamMembers, files / fileSource, sourceHistory, cloudResultReview) the
 * webui does not yet expose. Reads as "this section is real, the data is
 * not yet wired" rather than as an empty list ("no plan yet").
 */
function SectionPlaceholder({ testid, t }: { testid: string; t: (key: MessageKey) => string }) {
  return (
    <div
      data-testid={testid}
      className="flex items-center gap-2 rounded-[8px] px-1.5 py-2 text-text_default_tertiary"
    >
      <span className="desktop-text-ui-assist text-sm">{t("workspace.section.development")}</span>
    </div>
  );
}

// --- settings ---------------------------------------------------------------

function SettingsPanel({
  t,
  locale,
  setLocale,
  section,
}: {
  t: (key: MessageKey) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Which category to render; undefined means a disabled (unsupported) one. */
  section?: "general" | "appearance" | "connection";
}) {
  const [snapshot, setSnapshot] = useState<api.SettingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.getSettings());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const next = await api.postSettings(body);
        setSnapshot((current) => ({ ...(current ?? {}), ...next }));
        setNotice(t("settings.saved"));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  if (!snapshot) {
    return <p className="text-text_default_tertiary">{error ?? t("app.connecting")}</p>;
  }

  // A category with no section behind it is one this server cannot drive. Say so
  // rather than showing an empty page: the desktop has these categories, so their
  // absence would otherwise read as a bug.
  if (!section) {
    return (
      <p className="text-text_default_tertiary">{t("common.unsupported")}</p>
    );
  }

  const exposure = (
    <>
      {snapshot.lanExposureNotice ? (
        <p className="rounded-lg border border-border_default bg-bg_grouped_tertiary px-2 py-1.5 text-caption-small-strong text-text_status_warning">
          {snapshot.lanExposureNotice}
        </p>
      ) : null}
      {snapshot.bindRestartPending ? (
        <p className="text-caption-small-strong text-text_status_warning">
          {t("settings.lanBind")} — {t("settings.saved")}
        </p>
      ) : null}
    </>
  );

  const body = {
    general: (
      <>
        <Field label={t("settings.engine")}>
          <div className="break-all text-caption-small-strong text-text_default_secondary">
            {snapshot.mcodeVersion ?? "—"}
          </div>
          <div className="text-caption-small-strong text-text_default_tertiary">
            {snapshot.defaultModel ?? ""}
          </div>
        </Field>
        <Field label={t("settings.localUrl")}>
          <div className="break-all text-text_default_secondary">{snapshot.localUrl ?? "—"}</div>
        </Field>
        <Field label={t("settings.lanUrl")}>
          <div className="break-all text-text_default_secondary">{snapshot.lanUrl ?? "—"}</div>
        </Field>
      </>
    ),
    appearance: (
      /* Appearance — theme and language switches folded into settings. */
      <Field label={t("settings.appearance")}>
        <div className="flex flex-col gap-2">
          <ThemeSwitch t={t} />
          <LanguageSwitch t={t} locale={locale} setLocale={setLocale} />
        </div>
      </Field>
    ),
    connection: (
      <>
        <Field label={t("settings.security")}>
          <div className="flex flex-col gap-2">
            <Toggle
              label={t("settings.readOnly")}
              checked={snapshot.readOnly ?? false}
              disabled={busy}
              onChange={(value) => void patch({ readOnly: value })}
            />
            <Toggle
              label={t("settings.lan")}
              checked={snapshot.lanBroadcast ?? false}
              disabled={busy}
              onChange={(value) => void patch({ lanBroadcast: value })}
            />
            <Toggle
              label={t("settings.lanBind")}
              checked={snapshot.lanBind ?? false}
              disabled={busy}
              onChange={(value) => void patch({ lanBind: value })}
            />
            <Toggle
              label={t("settings.tokenEnabled")}
              checked={snapshot.tokenEnabled ?? false}
              disabled={busy}
              onChange={(value) => void patch({ tokenEnabled: value })}
            />
          </div>
        </Field>
        {exposure}
        {snapshot.currentToken ? (
          <Field label={t("settings.tokenValue")}>
            <div className="break-all font-family-code text-caption-small-strong text-text_default_secondary">
              {snapshot.currentToken}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void patch({ acknowledgeToken: true })}
              className="mt-2 h-8 self-start rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
            >
              {t("settings.ackToken")}
            </button>
          </Field>
        ) : null}
        <div className="px-3 py-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void patch({ resetToken: true })}
            className="h-8 self-start rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
          >
            {t("settings.resetToken")}
          </button>
        </div>
      </>
    ),
  }[section];

  return (
    /* Upstream's section shell: a `gap-3` column of cards. */
    <div className="flex w-full flex-col gap-3">
      <section className="flex w-full flex-col gap-3">
        <div className="rounded-[16px] bg-bg_grouped_tertiary p-1">{body}</div>
      </section>

      {notice ? <p className="text-caption-small-strong text-text_status_success">{notice}</p> : null}
      {error ? <p className="text-caption-small-strong text-text_status_error">{error}</p> : null}
    </div>
  );
}

// --- alerts -----------------------------------------------------------------

function AlertsPanel({ t }: { t: (key: MessageKey) => string }) {
  // 站内信 (the inbox). The bell opens the anchored flyout (components/inbox.tsx);
  // this drawer view stays for the `alerts` panel kind and renders the same rows
  // from the same stream.
  return <InboxList t={t} />;
}

// --- shared pieces ----------------------------------------------------------

/**
 * One settings row inside a section card.
 *
 * Upstream's row component is a 14px label with the control beside or beneath it,
 * inside a card whose padding provides the inset — so the padding lives here rather
 * than on the card, which keeps a row's hit area continuous.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <span className="desktop-text-ui-body text-text_default_primary">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2">
      <span className="text-sm text-text_default_primary">{label}</span>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(value) => onChange(value)}
      />
    </label>
  );
}

/**
 * Theme picker.
 *
 * The document owns the applied theme (see lib/theme.ts), and the class on <html>
 * is not reactive state, so this reads it on mount and keeps a local mirror to
 * re-render the selected segment immediately after a write.
 */
function ThemeSwitch({ t }: { t: (key: MessageKey) => string }) {
  const [theme, setTheme] = useState<ThemeName>("light");
  useEffect(() => setTheme(currentTheme()), []);
  return (
    <Segmented
      label={t("settings.theme")}
      value={theme}
      options={[
        { id: "light", label: t("settings.themeLight") },
        { id: "dark", label: t("settings.themeDark") },
      ]}
      onChange={(id) => {
        const next = id as ThemeName;
        applyTheme(next);
        setTheme(next);
      }}
    />
  );
}

/** Language picker. Writes through the same store the rest of the UI reads. */
function LanguageSwitch({
  t,
  locale,
  setLocale,
}: {
  t: (key: MessageKey) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}) {
  return (
    <Segmented
      label={t("settings.language")}
      value={locale}
      options={[
        { id: "zh", label: "中文" },
        { id: "en", label: "English" },
      ]}
      onChange={(id) => setLocale(id as Locale)}
    />
  );
}

/** A labelled two-or-more-way pill switch. */
function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-text_default_primary">{label}</span>
      <AntSegmented
        className="mavis-segmented"
        // antd's options carry {label, value}; we accept {id, label} from
        // callers for backwards compatibility (see ThemeSwitch /
        // LanguageSwitch).
        options={options.map((option) => ({
          label: option.label,
          value: option.id,
        }))}
        value={value}
        onChange={(next) => onChange(String(next))}
      />
    </div>
  );
}

/**
 * Session search.
 *
 * Backed by `GET /api/sessions/search`, which scores a session title first and its
 * id second and returns the best hit per workspace (see the route). The query is
 * debounced because every keystroke would otherwise be a round trip, and the route
 * reads the session store on each call.
 */
function SearchPanel({
  onClose,
  t,
}: {
  onClose: () => void;
  t: (key: MessageKey) => string;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<api.SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<InputRef>(null);

  useEffect(() => {
    inputRef.current?.input?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setHits([]);
      setSearched(false);
      return;
    }
    const handle = window.setTimeout(() => {
      setBusy(true);
      setError(null);
      void api
        .searchSessions(trimmed)
        .then((payload) => {
          setHits(payload.results ?? []);
          setSearched(true);
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setBusy(false));
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query]);

  return (
    <div className="flex flex-col gap-3">
      <AntInput
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("search.placeholder")}
        className="mavis-input"
      />

      {busy ? <span className="text-caption-small-strong text-text_default_tertiary">…</span> : null}
      {searched && hits.length === 0 && !busy ? (
        <span className="text-text_default_tertiary">{t("search.empty")}</span>
      ) : null}
      {hits.length > 0 ? (
        <span className="text-caption-small-strong text-text_default_tertiary">
          {t("search.results").replace("%n", String(hits.length))}
        </span>
      ) : null}

      <div className="flex flex-col gap-0.5">
        {hits.map((hit) => (
          <button
            key={hit.id}
            type="button"
            title={hit.workspace}
            onClick={() => {
              void api.switchSession(hit.id).finally(onClose);
            }}
            className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            <span className="min-w-0 truncate text-sm text-text_default_primary">
              {hit.title || t("sidebar.untitled")}
            </span>
            <span className="min-w-0 truncate text-caption-small-strong text-text_default_tertiary">
              {hit.workspace.split("/").filter(Boolean).pop() ?? hit.workspace}
            </span>
          </button>
        ))}
      </div>

      {error ? <p className="text-caption-small-strong text-text_status_error">{error}</p> : null}
    </div>
  );
}
