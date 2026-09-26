"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Input as AntInput,
  type InputRef,
  Modal as AntModal,
  Segmented as AntSegmented,
  Switch,
  Tabs as AntTabs,
} from "antd";

import * as api from "@/lib/api";
import { useAlerts } from "@/lib/alerts";
import { InboxList } from "./inbox";
import { useSessionContext } from "@/lib/store";
import { applyTheme, currentTheme } from "@/lib/theme";
import { matchFilter } from "@/lib/workspace-filter";
import type { Locale, MessageKey } from "@/lib/i18n";
import type { ThemeName } from "@/lib/types";
import { Icon } from "./icons";
import { ProviderManagementPanel } from "./provider-management";

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
          {/*
            `alerts` and `progress` are rendered but no launcher can reach them:
            every `openPanel(...)` call in the app passes one of `workspace`,
            `files`, `search` or `plugins`, and the bell opens the inbox
            flyout (components/inbox.tsx), not this panel. Neither kind has a
            counterpart in the desktop's right panel, whose tab registry is
            exactly `changes` / `terminal` / `browser` / `files`. See the
            ProgressPanel comment. Kept, not deleted, so a future launcher is a
            one-line change — but do not read them as ported surfaces.
          */}
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
  | "connection"
  | "providers";

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
      // Provider management (ticket 03) — model providers surface lives
      // in the management group, below connection, and is the only
      // server-driven section the desktop "用量与模型" group also covers.
      { id: "providers", key: "providers.title", section: "providers" },
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
 * Progress panel — **currently unreachable**.
 *
 * An earlier revision of this comment claimed upstream renders this as "the
 * `进度` tab on the right edge". It does not. The desktop's right panel is a
 * tabbed *file* panel and its tab registry is exactly four entries:
 * `changes`, `terminal`, `browser`, `files`, each gated on a capability
 * (extracted from the shipped bundle's `iJ` list). There is no progress tab
 * and no alerts tab there either.
 *
 * This view therefore has no counterpart to port, and nothing opens it: the
 * only panel kinds any launcher passes to `openPanel` are `search`,
 * `workspace`, `files` and `plugins`. The activity feed it approximates lives
 * on a different desktop surface (the turn inspector's `activity-group-*`
 * regions), which has no webui entry point.
 *
 * It is kept rather than deleted because the content is assembled from state
 * this app already has, so wiring a launcher is a small change — but it should
 * not be read as a ported surface. If it is ever reached, what it shows is
 * "recent alerts plus the active run", not an upstream progress timeline.
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

  // Last-write-wins. Without this, clicking `/a` then `/a/b` lets the older
  // `/a` listing land after the newer `/a/b` one and overwrite it, leaving the
  // breadcrumb saying `/a/b` above `/a`'s contents. A generation counter is
  // enough: the newest `load` owns the result, and anything older is dropped
  // when it finally arrives.
  const loadGen = useRef(0);
  const load = useCallback(async (target: string) => {
    const gen = ++loadGen.current;
    setLoading(true);
    try {
      const next = await api.getFsDir(target);
      if (gen !== loadGen.current) return; // a newer navigation won
      if (next.ok) {
        setListing(next);
        setError(null);
      } else {
        setError(next.error ?? "unreadable");
      }
    } catch (cause) {
      if (gen !== loadGen.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // Only the newest load clears the spinner; an older one finishing late
      // must not claim the panel is idle while a newer read is still running.
      if (gen === loadGen.current) setLoading(false);
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
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="workspace-section-group"
    >
      {/* §1 section_environmental — branch in subtitle, the current workspace
          directory underneath, a "Switch workspace" button, and 3 git
          entries as active buttons. Branch placeholder uses `\u00a0`
          (upstream's choice) rather than `undefined` so the header keeps its
          height when the engine has not yet picked a workspace. */}
      <WorkspaceSection
        title={t("workspace.sectionEnvironment")}
        subtitle={state?.workspace.branch ?? "\u00a0"}
      >
        <div className="flex flex-col gap-2">
          {/* The current workspace — the directory itself, plus the
              "Switch workspace" button next to it. Empty when the server
              has not reported one yet (the message is the "no workspace"
              hint the picker renders for an unset state). */}
          <div
            data-testid="workspace-current-dir"
            className="flex items-center gap-2 rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5"
          >
            <span className="flex size-5 flex-none items-center justify-center text-icon_default_secondary">
              <Icon name="folder" size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate font-family-code text-caption-small-strong text-text_default_primary">
              {state?.workspace.dir || t("workspace.picker.noWorkspace")}
            </span>
            <button
              type="button"
              data-testid="workspace-switch-button"
              onClick={() => setPickerOpen(true)}
              className="flex h-7 flex-none items-center gap-1 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              <Icon name="folderEmpty" size={14} />
              <span>{t("workspace.switch")}</span>
            </button>
          </div>

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

      <WorkspacePickerModal
        t={t}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentDir={state?.workspace.dir ?? null}
      />
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

/**
 * Workspace picker — modal that drives the workspace switch flow.
 *
 * Implements the PR #22 fs-picker feature checklist (path input, parent
 * navigation, directory listing, glob filter, create-new-folder, recents
 * tab, native OS picker) using antd primitives in the current Next.js
 * stack. Two tabs: `Recents` shows the server's recent-workspaces list
 * (from session activity) and a "no workspace" button (uses tmpdir);
 * `Browse` is the in-product directory navigator.
 *
 * The browser tab is the workhorse — it is the one that always works,
 * including in token-gated / no-native-picker environments. The native
 * picker button is opportunistic: when it succeeds, the picked path is
 * fed straight into the same `setWorkspace` call.
 *
 * Exported so other surfaces (the home-screen workspace chip's "选择新
 * 项目" affordance, see `components/workspace-picker.tsx`) can mount it
 * without going through the conversation-view WorkspacePanel. The modal
 * is one component, one source of truth — each caller owns its own open
 * state and never shares an instance.
 *
 * Wire: the modal is dismissible (settings-modal-style), and the picked
 * path is forwarded to `POST /api/workspace` (the same handler the rest
 * of the app uses). On success the picker closes; the state snapshot
 * update carries the new directory through the SSE stream, so any
 * downstream consumer (composer attachments, session tree) sees it
 * without further wiring.
 */
export function WorkspacePickerModal({
  t,
  open,
  onClose,
  currentDir,
}: {
  t: (key: MessageKey) => string;
  open: boolean;
  onClose: () => void;
  currentDir: string | null;
}) {
  return (
    <AntModal
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={560}
      rootClassName="mavis-confirm-modal-compact"
      classNames={{
        mask: "mavis-confirm-modal-compact-mask",
        content: "mavis-confirm-modal-compact-surface",
      }}
      styles={{ header: { background: "transparent" } }}
      title={
        <span className="flex items-center gap-2">
          <span className="mavis-confirm-modal-compact-title text-heading3 text-text_default_primary">
            {t("workspace.picker.title")}
          </span>
        </span>
      }
    >
      <WorkspacePickerBody t={t} onClose={onClose} currentDir={currentDir} />
    </AntModal>
  );
}

/**
 * The modal body. State machine: `Browse` reads `/api/workspace/browse`
 * (containment-checked server-side), `Recents` reads `/api/workspace/recent`.
 * Both feeds feed the same confirmation handler (`setWorkspace`).
 */
function WorkspacePickerBody({
  t,
  onClose,
  currentDir,
}: {
  t: (key: MessageKey) => string;
  onClose: () => void;
  currentDir: string | null;
}) {
  const [tab, setTab] = useState<"recents" | "browse">("recents");

  return (
    <div className="flex flex-col gap-3" data-testid="workspace-picker">
      <AntTabs
        activeKey={tab}
        onChange={(key) => setTab(key as "recents" | "browse")}
        items={[
          {
            key: "recents",
            label: t("workspace.picker.tabs.recents"),
          },
          {
            key: "browse",
            label: t("workspace.picker.tabs.browse"),
          },
        ]}
      />

      {tab === "recents" ? (
        <WorkspaceRecentsTab
          t={t}
          onClose={onClose}
          currentDir={currentDir}
          onSwitchToBrowse={() => setTab("browse")}
        />
      ) : (
        <WorkspaceBrowseTab t={t} onClose={onClose} currentDir={currentDir} />
      )}
    </div>
  );
}

interface RecentPick {
  dir: string;
  name: string;
  sessionCount: number;
  lastActiveAt: number;
}

function WorkspaceRecentsTab({
  t,
  onClose,
  currentDir,
  onSwitchToBrowse,
}: {
  t: (key: MessageKey) => string;
  onClose: () => void;
  currentDir: string | null;
  onSwitchToBrowse: () => void;
}) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<RecentPick[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tmpDir, setTmpDir] = useState<string | null>(null);

  // Last-write-wins: a search query that lands after a broader one
  // should not silently re-replace the displayed list. Same trick as
  // the FilesPanel.
  const loadGen = useRef(0);
  const load = useCallback(
    async (q: string) => {
      const gen = ++loadGen.current;
      setLoading(true);
      setError(null);
      try {
        const result = await api.recentWorkspaces(q, 20);
        if (gen !== loadGen.current) return;
        setItems(result.items ?? []);
        if (result.tmpDir) setTmpDir(result.tmpDir);
      } catch (cause) {
        if (gen !== loadGen.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (gen === loadGen.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load(search);
    }, 120);
    return () => window.clearTimeout(handle);
  }, [load, search]);

  const pick = async (dir: string | null) => {
    setBusy(true);
    try {
      if (dir === null) {
        // "No workspace" uses tmpdir: same behaviour as the chat composer
        // when launched without an explicit workspace. The server
        // resolves the temp directory as the workspace.
        if (!tmpDir) {
          setError(t("workspace.picker.error"));
          return;
        }
        await api.setWorkspace(tmpDir);
      } else {
        await api.setWorkspace(dir);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const filtered = items.filter(
    (it) =>
      !search.trim() ||
      it.dir.toLowerCase().includes(search.trim().toLowerCase()) ||
      it.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-2">
      <AntInput
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t("workspace.picker.recents.search")}
        data-testid="workspace-recents-search"
        className="mavis-input"
      />

      {error ? (
        <p
          data-testid="workspace-recents-error"
          className="text-caption-small-strong text-text_status_error"
        >
          {error}
        </p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="text-caption-small-strong text-text_default_tertiary">
          {t("workspace.picker.loading")}
        </p>
      ) : null}

      {!loading && items.length === 0 && !error ? (
        <p
          data-testid="workspace-recents-empty"
          className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary"
        >
          {t("workspace.picker.recents.empty")}
        </p>
      ) : null}

      {filtered.length > 0 ? (
        <ul
          data-testid="workspace-recents-list"
          className="flex max-h-[260px] flex-col gap-px overflow-y-auto"
        >
          {filtered.map((item) => {
            const isCurrent = item.dir === currentDir;
            return (
              <li key={item.dir}>
                <button
                  type="button"
                  data-testid={`workspace-recents-row-${item.dir}`}
                  disabled={busy}
                  onClick={() => void pick(item.dir)}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
                      {item.name}
                    </span>
                    {isCurrent ? (
                      <span
                        data-testid={`workspace-recents-current-${item.dir}`}
                        className="rounded-full bg-bg_interaction_tertiary_selected px-1.5 py-0.5 text-caption-small-strong text-text_default_primary"
                      >
                        ✓
                      </span>
                    ) : null}
                  </span>
                  <span
                    title={item.dir}
                    className="truncate font-family-code text-caption-small-strong text-text_default_tertiary"
                  >
                    {item.dir}
                  </span>
                  <span className="text-caption-small-strong text-text_default_tertiary">
                    {item.sessionCount} session{item.sessionCount === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void pick(null)}
          data-testid="workspace-recents-no-workspace"
          className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
        >
          {t("workspace.picker.noWorkspace")}
        </button>
        <button
          type="button"
          onClick={onSwitchToBrowse}
          data-testid="workspace-recents-browse"
          className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.tabs.browse")}…
        </button>
      </div>
    </div>
  );
}

function WorkspaceBrowseTab({
  t,
  onClose,
  currentDir,
}: {
  t: (key: MessageKey) => string;
  onClose: () => void;
  currentDir: string | null;
}) {
  // Seed the directory from the active workspace when one is set —
  // most of the time the user opens the picker to "go up one level",
  // not to navigate from the platform root.
  const [path, setPath] = useState<string>(() => currentDir ?? "");
  const [listing, setListing] = useState<api.BrowseResult | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRoots, setErrorRoots] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadGen = useRef(0);
  const load = useCallback(async (target: string) => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    setErrorRoots(null);
    try {
      const result = await api.browseWorkspace(target || undefined);
      if (gen !== loadGen.current) return;
      if (result.ok) {
        setListing(result);
      } else {
        // The server carries `roots` on the containment error payload
        // (server/lib/workspace.js#assertWorkspacePath /
        // resolveWithinRoots) so the picker can render "must be under:
        // …" instead of a bare "非法". Surface them in the UI.
        setError(result.error ?? t("workspace.picker.error"));
        if (Array.isArray(result.roots)) setErrorRoots(result.roots);
      }
    } catch (cause) {
      if (gen !== loadGen.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const entries = listing?.children ?? [];
  // Dirs first, then alphabetical — the same shape FilesPanel uses.
  const sorted = useMemo(() => {
    const dirs = entries.filter((e) => e.isDir);
    const rest = entries.filter((e) => !e.isDir);
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    rest.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...rest];
  }, [entries]);
  const matched = filter
    ? sorted.filter((e) => matchFilter(e.name, filter))
    : sorted;
  const visible = matched.slice(0, 200);
  const hidden = matched.length - visible.length;

  const pick = async () => {
    // Server wire field is `dir` (see server/lib/workspace.js#browseWorkspace).
    // The wire name used to drift to the wrong field in the webapp type and
    // reading code — that regression was the root cause of the picker
    // silently doing nothing (confirm button permanently disabled). Keep
    // this on `listing.dir`; the regression test in
    // webapp/test/workspace-picker-wire.test.ts pins both the type and
    // the read site.
    if (!listing?.dir) {
      setError(t("workspace.picker.error"));
      return;
    }
    setBusy(true);
    try {
      await api.setWorkspace(listing.dir);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mkdir = async () => {
    if (!listing?.dir) return;
    const name = window.prompt(t("workspace.picker.newFolderPrompt"), "");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const next = `${listing.dir.replace(/\/+$/, "")}/${trimmed}`;
      const result = await api.mkdir(next);
      if (!result.ok) {
        setError(result.path ? "mkdir failed" : "mkdir failed");
        return;
      }
      // Re-list the parent to surface the new folder.
      await load(listing.dir);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Toolbar: parent, path, home, root, mkdir. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && setPath(listing.parent)}
          data-testid="workspace-picker-up"
          aria-label={t("workspace.picker.up")}
          title={t("workspace.picker.up")}
          className="flex size-7 flex-none items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-40"
        >
          <Icon name="chevronRight" size={14} className="rotate-180" />
        </button>
        <AntInput
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onPressEnter={() => setPath(path.trim())}
          placeholder={t("workspace.picker.pathPlaceholder")}
          aria-label={t("workspace.picker.pathPlaceholder")}
          data-testid="workspace-picker-path"
          className="mavis-input min-w-0 flex-1"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setPath("~")}
          data-testid="workspace-picker-home"
          className="h-7 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.home")}
        </button>
        <button
          type="button"
          onClick={() => setPath("")}
          data-testid="workspace-picker-roots"
          className="h-7 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.root")}
        </button>
        <button
          type="button"
          disabled={!listing?.dir}
          onClick={() => void mkdir()}
          data-testid="workspace-picker-mkdir"
          className="h-7 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-40"
        >
          {t("workspace.picker.newFolder")}
        </button>
        {/* Native OS picker (zenity/kdialog/osascript/PowerShell) removed
            per ticket feedback — the in-product WorkspacePickerModal is the
            only path now. See routes/workspace.js#v0.5.by comment. */}
      </div>

      {/* Filter row — same matcher as FilesPanel. */}
      <div className="flex items-center gap-1">
        <AntInput
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("workspace.picker.filterPlaceholder")}
          data-testid="workspace-picker-filter"
          className="mavis-input min-w-0 flex-1"
        />
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter("")}
            aria-label={t("files.clearFilter")}
            data-testid="workspace-picker-filter-clear"
            className="flex size-8 flex-none items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>

      {error ? (
        <div
          data-testid="workspace-picker-error"
          className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5 text-caption-small-strong text-text_status_error"
        >
          <span className="block">{error}</span>
          {errorRoots && errorRoots.length > 0 ? (
            <span
              data-testid="workspace-picker-error-roots"
              className="mt-1 block text-text_default_tertiary"
            >
              {t("workspace.picker.mustBeUnder")} {errorRoots.join(", ")}
            </span>
          ) : null}
        </div>
      ) : null}

      {loading && entries.length === 0 ? (
        <p className="text-caption-small-strong text-text_default_tertiary">
          {t("workspace.picker.loading")}
        </p>
      ) : null}

      {/* When no path has been given yet, the Browse tab's root view
          shows the allowed roots rather than a folder list — clicking
          one enters it. */}
      {!path && !loading ? (
        <ul
          data-testid="workspace-picker-roots-list"
          className="flex max-h-[260px] flex-col gap-px overflow-y-auto"
        >
          {(listing?.roots ?? []).map((root) => (
            <li key={root}>
              <button
                type="button"
                onClick={() => setPath(root)}
                data-testid={`workspace-picker-root-${root}`}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
              >
                <span className="flex size-5 flex-none items-center justify-center text-icon_default_secondary">
                  <Icon name="folder" size={15} />
                </span>
                <span
                  title={root}
                  className="min-w-0 flex-1 truncate font-family-code text-caption-small-strong text-text_default_primary"
                >
                  {root}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {path && visible.length > 0 ? (
        <ul
          data-testid="workspace-picker-listing"
          className="flex max-h-[260px] flex-col gap-px overflow-y-auto"
        >
          {visible.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => entry.isDir && setPath(entry.path)}
                data-testid={`workspace-picker-entry-${entry.path}`}
                data-entry-type={entry.isDir ? "dir" : "file"}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
              >
                <span className="flex size-4 flex-none items-center justify-center text-icon_default_secondary">
                  <Icon name={entry.isDir ? "folder" : "file"} size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
                  {entry.name}
                </span>
              </button>
            </li>
          ))}
          {hidden > 0 ? (
            <li
              data-testid="workspace-picker-truncated"
              className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
            >
              {t("files.showing")} {visible.length} / {matched.length}
            </li>
          ) : null}
        </ul>
      ) : null}

      {!loading && path && matched.length === 0 && !error ? (
        <p
          data-testid="workspace-picker-empty"
          className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
        >
          {filter
            ? t("files.noMatch")
            : t("workspace.picker.empty")}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          data-testid="workspace-picker-cancel"
          className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.cancel")}
        </button>
        <button
          type="button"
          disabled={busy || !listing?.dir}
          onClick={() => void pick()}
          data-testid="workspace-picker-confirm"
          className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:opacity-50"
        >
          {t("workspace.picker.useWorkspace")}
        </button>
      </div>
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
  section?: "general" | "appearance" | "connection" | "providers";
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
    providers: (
      // The provider management panel owns its own loading / saving
      // state — wrapping it in a card here keeps the section chrome
      // consistent with the rest of SettingsPanel.
      <ProviderManagementPanel t={t} />
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

  // Last-write-wins across in-flight searches. The cleanup only cancels the
  // debounce timer; once a request has actually been issued, an older response
  // can still land after a newer one and replace the right results with stale
  // ones. A generation counter drops the stale response. The counter is bumped
  // in the cleanup too, so a response that lands after the query changed (or
  // was cleared) is discarded rather than repopulating an empty box.
  const searchGen = useRef(0);
  useEffect(() => {
    const gen = ++searchGen.current;
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
          if (gen !== searchGen.current) return;
          setHits(payload.results ?? []);
          setSearched(true);
        })
        .catch((cause) => {
          if (gen !== searchGen.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (gen === searchGen.current) setBusy(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(handle);
      searchGen.current += 1;
    };
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
