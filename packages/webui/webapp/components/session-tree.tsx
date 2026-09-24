"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input as AntInput, type InputRef } from "antd";

import * as api from "@/lib/api";
import { runAction } from "@/lib/action-errors";
import { useSessionContext } from "@/lib/store";
import type { MessageKey } from "@/lib/i18n";
import { Icon } from "./icons";

/**
 * Sidebar session tree — Project → directory → main session → subagent.
 *
 * ## Where the data comes from
 *
 * The four levels are assembled server-side in `server/lib/session-tree.js` and
 * served by `GET /api/session-tree`. The webui's wrapper records cannot express
 * this: they are one flat level and carry no notion of which session spawned
 * which, so a subagent is invisible and a worktree is indistinguishable from an
 * unrelated directory. Only mcode's runtime db knows the parent/child edges
 * and the workspace each session ran in.
 *
 * ## Where the markup comes from
 *
 * Every class string below is upstream's, read from the running desktop
 * client's DOM. The reference for a re-derivation is
 * `scripts/desktop-reference.mjs` (`--surface sidebar`).
 *
 * Two deliberate departures, both to avoid shipping dead controls:
 *
 *   - Upstream swaps the row marker to a pin button on hover. This server has
 *     no pinning contract, so the hairline is kept as the resting state and
 *     the pin is omitted.
 *   - Upstream's per-row actions are pin / rename / delete. Rename, delete and
 *     export all have endpoints and are rendered; pinning has none, so it is not.
 */

// How many sessions a directory shows before the rest go behind `更多`. Upstream
// reveals its `sidebar-session-group-more` row under the same rule.
const SESSION_VISIBLE_LIMIT = 6;

/** Upstream's `placeholder` treatment for a session with no title yet. */
const UNTITLED: MessageKey = "sidebar.untitled";

export function SessionTree({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const activeId = state?.mcodeSessionId ?? null;
  // Live, from the SSE snapshot — unlike `session.status` in the payload below,
  // which the server reads from the engine's database through a 15s cache.
  const running = state?.running?.active ?? false;
  const [payload, setPayload] = useState<api.SessionTreePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openProjects, setOpenProjects] = useState<string[]>([]);
  const [openDirs, setOpenDirs] = useState<string[]>([]);
  const [openSessions, setOpenSessions] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<Record<string, number>>({});

  const refresh = useCallback(async (force = false) => {
    try {
      const next = await api.getSessionTree(force);
      setPayload(next.ok ? next : null);
      setError(next.ok ? null : next.reason ?? "unavailable");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // Refetch when the active session changes: the tree is ordered by activity, and
  // switching a session is exactly what moves it. The server caches the payload
  // for 15s, so this is usually a cache hit.
  useEffect(() => {
    void refresh();
  }, [refresh, activeId]);

  // A run starting or ending is when the engine rewrites the per-session `status`
  // this list paints, and the payload is served from that 15s cache — so this
  // transition forces a re-read instead of waiting the cache out. Without it a
  // running session looked idle, and a finished one kept shimmering.
  // Skipped on mount: the effect above already fetches.
  const sawRun = useRef(false);
  useEffect(() => {
    if (!sawRun.current) {
      sawRun.current = true;
      return;
    }
    void refresh(true);
  }, [refresh, running]);

  // Open the active session's chain on first sight so "where am I" is answered
  // without a click. Cheap to re-run: the three updates are no-ops once open.
  useEffect(() => {
    if (!activeId || !payload?.projects) return;
    for (const project of payload.projects) {
      for (const directory of project.directories) {
        const holdsActive = directory.sessions.some(
          (session) =>
            session.id === activeId || session.children.some((child) => child.id === activeId),
        );
        if (!holdsActive) continue;
        const parent = directory.sessions.find((session) =>
          session.children.some((child) => child.id === activeId),
        );
        setOpenProjects((current) =>
          current.includes(project.key) ? current : [...current, project.key],
        );
        setOpenDirs((current) =>
          current.includes(directory.path) ? current : [...current, directory.path],
        );
        if (parent) {
          setOpenSessions((current) =>
            current.includes(parent.id) ? current : [...current, parent.id],
          );
        }
        return;
      }
    }
  }, [activeId, payload]);

  const toggle = useCallback(
    (setter: React.Dispatch<React.SetStateAction<string[]>>) => (key: string) => {
      setter((current) =>
        current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
      );
    },
    [],
  );

  const projects = payload?.projects ?? [];

  return (
    // `scrollbar-gutter: stable` matches upstream so the list does not shift
    // when the scrollbar appears.
    <div
      data-testid="sidebar-scroll-viewport"
      className="h-full overflow-x-hidden overflow-y-auto px-2 scrollbar-hide"
      style={{ scrollbarGutter: "stable" }}
    >
      {error ? (
        <p className="px-2 py-1 text-caption-small-strong text-text_status_error">
          {t("error.session")}
        </p>
      ) : null}
      {!error && projects.length === 0 ? (
        <p className="px-2 py-1 text-caption-small-strong text-text_default_tertiary">
          {t("sidebar.empty")}
        </p>
      ) : null}

      {/* Section header — collapsible `group/section` row whose label is `项目`. */}
      {projects.length > 0 ? <SectionHeader label={t("sidebar.projects")} /> : null}

      {projects.map((project) => (
        <div key={project.key} className="space-y-px">
          <ProjectNode
            project={project}
            activeId={activeId}
            open={openProjects.includes(project.key)}
            onToggle={toggle(setOpenProjects)}
            openDirs={openDirs}
            onToggleDir={toggle(setOpenDirs)}
            openSessions={openSessions}
            onToggleSession={toggle(setOpenSessions)}
            revealed={revealed}
            onReveal={(path) =>
              setRevealed((current) => ({
                ...current,
                [path]: (current[path] ?? SESSION_VISIBLE_LIMIT) + SESSION_VISIBLE_LIMIT,
              }))
            }
            onChanged={refresh}
            t={t}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Upstream's `group/section` header row.
 *
 * The chevron is `opacity-0` until the header is hovered — upstream shows the
 * disclose affordance only on hover, keeping the resting list quiet.
 */
function SectionHeader({ label, actions }: { label: string; actions?: React.ReactNode }) {
  return (
    <div className="group/section flex h-[30px] items-center gap-1 pl-2 pr-0.5 bg-transparent">
      <button type="button" aria-expanded data-sidebar-keep-open className="flex items-center gap-1 flex-1 min-w-0 text-left">
        <span className="text-sm font-normal leading-5 text-text_default_tertiary truncate">
          {label}
        </span>
        <span className="flex-shrink-0 transition-[opacity,transform] duration-200 opacity-0 group-hover/section:opacity-100">
          <Icon name="chevronDown" size={12} className="text-icon_default_tertiary" />
        </span>
      </button>
      {actions}
    </div>
  );
}

/**
 * One row action.
 *
 * `tone="icon"` is upstream's icon-button treatment for row actions
 * (`text-icon_default_tertiary hover:text-icon_default_secondary`, `rounded`).
 * `tone="tertiary"` is the variant upstream uses for a row whose icon is already
 * dimmed (`text-text_default_tertiary … hover:text-text_default_secondary`).
 */
function RowAction({
  label,
  onClick,
  tone = "icon",
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "icon" | "tertiary" | "primary";
  children: React.ReactNode;
}) {
  const cls =
    tone === "tertiary"
      ? "flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[8px] text-text_default_tertiary transition-colors duration-200 hover:bg-bg_interaction_tertiary_hover hover:text-text_default_secondary"
      : tone === "primary"
        ? "flex h-[30px] w-[30px] items-center justify-center rounded-[8px] text-icon_interaction_tertiary_default transition-colors duration-200 hover:text-icon_interaction_tertiary_hover"
        : "flex h-[30px] w-[30px] items-center justify-center rounded text-icon_default_tertiary transition-colors hover:text-icon_default_secondary";
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/** Level 1 — a project (one git repository, however many worktrees it has). */
function ProjectNode({
  project,
  activeId,
  open,
  onToggle,
  openDirs,
  onToggleDir,
  openSessions,
  onToggleSession,
  revealed,
  onReveal,
  onChanged,
  t,
}: {
  project: api.TreeProject;
  activeId: string | null;
  open: boolean;
  onToggle: (key: string) => void;
  openDirs: string[];
  onToggleDir: (key: string) => void;
  openSessions: string[];
  onToggleSession: (key: string) => void;
  revealed: Record<string, number>;
  onReveal: (path: string) => void;
  onChanged: () => void;
  t: (key: MessageKey) => string;
}) {
  const label = project.repoPaths.length
    ? `${project.name}, ${project.repoPaths.join(", ")}`
    : project.name;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        title={label}
        aria-expanded={open}
        data-testid="sidebar-project-header"
        onClick={() => onToggle(project.key)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(project.key);
          }
        }}
        className="group/project-header flex h-[30px] cursor-pointer items-center gap-2 rounded-lg pl-2 pr-0.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover focus:outline-none focus-visible:bg-bg_interaction_tertiary_hover"
      >
        {/* The caret is the filled triangle the desktop uses for sidebar
            disclosures, rotated -90deg when collapsed, distinct from the stroked
            chevron used elsewhere. */}
        <span className="flex size-[14px] flex-shrink-0 items-center justify-center text-icon_default_primary">
          <Icon
            name="caretDown"
            size={12}
            className={open ? "transition-transform" : "-rotate-90 transition-transform"}
          />
        </span>
        <span className="flex size-[18px] flex-shrink-0 items-center justify-center text-icon_default_secondary">
          <Icon name={open ? "folderEmpty" : "folder"} size={18} />
        </span>
        <span
          data-testid="sidebar-project-title"
          className="desktop-text-ui-body min-w-0 flex-1 truncate text-sm leading-5 text-text_default_secondary"
        >
          {project.name}
        </span>

        {/* Fixed-width 60px slot: the count pill fades out as hover actions fade
            in, and keeping the slot a fixed width stops the title from
            reflowing on hover. */}
        <div className="relative ml-auto h-[30px] w-[60px] flex-shrink-0">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 flex w-[30px] items-center justify-center transition-opacity duration-200 group-hover/project-header:opacity-0"
          >
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-bg_grouped_tertiary px-1 text-center text-xs font-normal leading-4 text-text_default_secondary">
              {project.sessionCount}
            </span>
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0.5 flex items-center opacity-0 transition-opacity duration-200 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100">
            <RowAction
              label={t("sidebar.newInProject")}
              tone="primary"
              onClick={() =>
                void runAction(t("sidebar.newInProject"), api.newSession(project.directories[0]?.path)).then(
                  onChanged,
                )
              }
            >
              <Icon name="plusSmall" size={16} />
            </RowAction>
          </span>
        </div>
      </div>

      {open
        ? project.directories.map((directory) => (
            <DirectoryNode
              key={directory.path}
              directory={directory}
              activeId={activeId}
              headerless={project.directories.length === 1}
              open={openDirs.includes(directory.path)}
              onToggle={onToggleDir}
              openSessions={openSessions}
              onToggleSession={onToggleSession}
              revealed={revealed}
              onReveal={onReveal}
              onChanged={onChanged}
              t={t}
            />
          ))
        : null}
    </>
  );
}

/**
 * Level 2 — one directory (a worktree or a plain checkout) inside a project.
 *
 * `headerless` is set when the project holds exactly one directory: the path row
 * is then redundant (the project row already names the checkout) and the
 * reference sidebar shows those sessions directly under the project. Projects
 * with several directories keep the row, because that is what distinguishes
 * them.
 */
function DirectoryNode({
  directory,
  activeId,
  open,
  headerless,
  onToggle,
  openSessions,
  onToggleSession,
  revealed,
  onReveal,
  onChanged,
  t,
}: {
  directory: api.TreeDirectory;
  activeId: string | null;
  open: boolean;
  headerless?: boolean;
  onToggle: (key: string) => void;
  openSessions: string[];
  onToggleSession: (key: string) => void;
  revealed: Record<string, number>;
  onReveal: (path: string) => void;
  onChanged: () => void;
  t: (key: MessageKey) => string;
}) {
  const limit = revealed[directory.path] ?? SESSION_VISIBLE_LIMIT;
  const visible = directory.sessions.slice(0, limit);
  const hidden = directory.sessions.length - visible.length;
  const holdsActive = directory.sessions.some(
    (session) => session.id === activeId || session.children.some((child) => child.id === activeId),
  );

  const rows = (
    <>
      {visible.map((session) => (
        <SessionNode
          key={session.id}
          session={session}
          activeId={activeId}
          open={openSessions.includes(session.id)}
          onToggle={onToggleSession}
          onChanged={onChanged}
          t={t}
        />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          data-testid="sidebar-directory-more"
          onClick={() => onReveal(directory.path)}
          className="desktop-text-ui-small-strong flex h-[30px] w-full items-center gap-2 rounded-lg pl-8 pr-2.5 text-sm text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_tertiary disabled:opacity-50"
        >
          <span className="min-w-0 flex-1 truncate">
            {t("sidebar.more")} ({hidden})
          </span>
        </button>
      ) : null}
    </>
  );

  return (
    <>
      {/* Second-level header — same geometry as the project header, one indent
          deeper, with the title in `text-text_default_secondary`. Skipped for a
          project's only directory. */}
      {headerless ? null : (
      <div
        role="button"
        tabIndex={0}
        aria-label={directory.path}
        title={directory.path}
        aria-expanded={open}
        data-testid="sidebar-directory-header"
        data-workspace-dir={directory.path}
        onClick={() => onToggle(directory.path)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(directory.path);
          }
        }}
        className="group/project-header flex h-[30px] cursor-pointer items-center gap-2 rounded-lg pl-6 pr-0.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover focus:outline-none focus-visible:bg-bg_interaction_tertiary_hover"
      >
        <span className="flex size-[18px] flex-shrink-0 items-center justify-center text-icon_default_secondary">
          <Icon name={open ? "folderEmpty" : "folder"} size={18} />
        </span>
        <span
          className={[
            "desktop-text-ui-body min-w-0 flex-1 truncate text-sm leading-5",
            holdsActive ? "text-text_default_primary" : "text-text_default_secondary",
          ].join(" ")}
        >
          {directory.name}
        </span>
        <div className="relative ml-auto h-[30px] w-[60px] flex-shrink-0">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 flex w-[30px] items-center justify-center transition-opacity duration-200 group-hover/project-header:opacity-0"
          >
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-bg_grouped_tertiary px-1 text-center text-xs font-normal leading-4 text-text_default_secondary">
              {directory.sessions.length}
            </span>
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0.5 flex items-center opacity-0 transition-opacity duration-200 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100">
            <RowAction
              label={t("sidebar.newInProject")}
              tone="primary"
              onClick={() =>
                void runAction(t("sidebar.newInProject"), api.newSession(directory.path)).then(onChanged)
              }
            >
              <Icon name="plusSmall" size={16} />
            </RowAction>
          </span>
        </div>
      </div>
      )}

      {/* A headerless (single-directory) project is governed by the project's
          own disclosure, so its sessions are shown whenever the project is
          open, one indent in from the project row. */}
      {headerless || open
        ? headerless
          ? <div className="pl-4">{rows}</div>
          : rows
        : null}
    </>
  );
}

/**
 * Level 3 — a main agent session, with its subagents beneath it.
 *
 * Upstream's row is a small composition worth keeping intact: the button spans
 * the row, everything inside it lives in an inner wrapper that slides right on
 * hover (`mr-2 group-hover:mr-[60px]`), and the actions sit in an absolutely
 * positioned overlay that is `hidden` until hover. Sliding the content instead
 * of overlaying it is what keeps a long title readable up to the last
 * character.
 */
/**
 * How a session that stopped on something other than success reads in the list.
 *
 * The engine writes `aborted`, `interrupted` and `error` into the session row,
 * and every one of them rendered exactly like `idle` — a session that died on an
 * error was indistinguishable from one that was simply quiet. Only states that
 * mean "this did not finish cleanly" get a mark; `idle` and `completed` stay
 * plain, and `started` is the marquee. The label is the tooltip, so the mark is
 * never the only carrier of the meaning.
 */
const SESSION_STATE_MARK: Record<string, { dot: string; label: MessageKey }> = {
  error: { dot: "bg-bg_status_error", label: "session.status.error" },
  aborted: { dot: "bg-bg_status_warning", label: "session.status.aborted" },
  interrupted: { dot: "bg-bg_status_warning", label: "session.status.interrupted" },
};

function SessionNode({
  session,
  activeId,
  open,
  onToggle,
  onChanged,
  t,
}: {
  session: api.TreeSession;
  activeId: string | null;
  open: boolean;
  onToggle: (key: string) => void;
  onChanged: () => void;
  t: (key: MessageKey) => string;
}) {
  const { state } = useSessionContext();
  const active = session.id === activeId;
  // The engine status is the source for every row, but the active session's is
  // also on the wire live: `running.active` arrives over SSE the moment a turn
  // starts. Reading it here is what makes the marquee immediate rather than up
  // to a cache lifetime late.
  const liveRunning = active && (state?.running?.active ?? false);
  const stateMark = SESSION_STATE_MARK[session.status];
  const hasChildren = session.children.length > 0;
  const onOpen = useCallback(() => {
    void runAction(t("sidebar.openSession"), api.switchSession(session.id)).then(onChanged);
  }, [session.id, onChanged, t]);

  // `draft === null` means "not renaming". The title commits on Enter or blur and
  // is discarded on Escape.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<InputRef>(null);
  const settled = useRef(false);
  const renaming = draft !== null;
  const title = session.title || t(UNTITLED);

  useEffect(() => {
    if (renaming) inputRef.current?.input?.select();
  }, [renaming]);

  const startRename = useCallback(() => {
    settled.current = false;
    setDraft(session.title || "");
  }, [session.title]);

  // Enter commits and the input then unmounts; `settled` stops the unmount from
  // writing a second time through blur.
  const commitRename = useCallback(async () => {
    if (settled.current) return;
    settled.current = true;
    const next = (draft ?? "").trim();
    setDraft(null);
    if (!next || next === (session.title || "")) return;
    await runAction(t("sidebar.rename"), api.renameSession(session.id, next));
    onChanged();
  }, [draft, session.id, session.title, onChanged, t]);

  const rowClass = [
    "w-full flex items-center gap-2 pl-2 pr-0.5 h-[30px] text-left transition-colors rounded-lg",
    active
      ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
      : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover",
  ].join(" ");

  const rowBody = (
          <div className="min-w-0 flex-1 transition-all mr-2 group-hover/row:mr-[90px] group-focus-within/row:mr-[90px]">
            <div className="flex items-center gap-2">
              {/* The disclosure is a sibling of the marker, not of the row button:
                  a button inside a button is invalid HTML and makes the click
                  target ambiguous. */}
              {hasChildren ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={t("sidebar.subagents")}
                  aria-expanded={open}
                  data-testid="sidebar-session-subagents-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(session.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggle(session.id);
                    }
                  }}
                  className="flex-shrink-0 cursor-pointer flex items-center justify-center text-icon_default_tertiary"
                >
                  <Icon
                    name="caretDown"
                    size={12}
                    className={open ? "transition-transform" : "-rotate-90 transition-transform"}
                  />
                </span>
              ) : null}

              <span
                aria-hidden
                className="flex flex-shrink-0 items-center justify-center h-[31px] w-[18px] text-icon_default_tertiary"
              >
                <span className="block h-[31px] w-0 border-l-[0.5px] border-border_default" />
              </span>

              {renaming ? (
                <AntInput
                  ref={inputRef}
                  type="text"
                  maxLength={200}
                  value={draft ?? ""}
                  aria-label={t("sidebar.rename")}
                  data-testid="sidebar-session-rename-input"
                  onChange={(event) => setDraft(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      settled.current = true;
                      setDraft(null);
                    }
                  }}
                  onBlur={() => void commitRename()}
                  className="desktop-text-ui-body min-w-0 flex-1 rounded-[4px] border border-border_accent bg-bg_grouped_secondary px-1.5 py-px text-sm leading-5 text-text_default_primary outline-none"
                />
              ) : (
                <RunningTitle
                  title={title}
                  running={session.status === "started" || liveRunning}
                />
              )}
              {stateMark ? (
                <span
                  data-testid="sidebar-session-status"
                  role="img"
                  aria-label={t(stateMark.label)}
                  title={t(stateMark.label)}
                  className={`ml-1.5 size-1.5 flex-shrink-0 rounded-full ${stateMark.dot}`}
                />
              ) : null}
              {hasChildren ? (
                /* Child count clamps at 99+ so the row never grows with the number. */
                <span className="desktop-text-ui-assist flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-bg_grouped_tertiary px-1 text-xs leading-4 text-text_default_secondary">
                  {session.children.length > 99 ? "99+" : session.children.length}
                </span>
              ) : null}
            </div>
          </div>
  );

  return (
    <>
      <div className="group/row relative rounded-lg">
        {renaming ? (
          /* Editing swaps the element: a `<button>` must not contain an
             `<input>`, and it would swallow the keystrokes. */
          <div data-testid="sidebar-session-row" className={rowClass}>
            {rowBody}
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            data-shortcut-session-target={session.id}
            data-testid="sidebar-session-row"
            className={rowClass}
          >
            {rowBody}
          </button>
        )}

        {renaming ? null : (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 z-[1]">
          <div className="hidden h-[30px] w-[90px] items-center group-hover/row:flex group-focus-within/row:flex">
            <a
              href={api.sessionExportUrl(session.id)}
              download
              aria-label={t("sidebar.export")}
              title={t("sidebar.export")}
              className="flex h-[30px] w-[30px] items-center justify-center rounded text-icon_default_tertiary transition-colors hover:text-icon_default_secondary"
            >
              <Icon name="download" size={14} />
            </a>
            <RowAction label={t("sidebar.rename")} onClick={startRename}>
              {/* Upstream's rename affordance is this glyph, not an icon-pack path. */}
              <span aria-hidden className="text-[13px] leading-none">
                ✎
              </span>
            </RowAction>
            <RowAction
              label={t("sidebar.delete")}
              onClick={() =>
                void runAction(t("sidebar.delete"), api.deleteSession(session.id)).then(onChanged)
              }
            >
              <Icon name="trash" size={14} />
            </RowAction>
          </div>
        </div>
        )}
      </div>

      {open && hasChildren
        ? session.children.map((child) => (
            <SubagentRow
              key={child.id}
              session={child}
              active={child.id === activeId}
              onChanged={onChanged}
              t={t}
            />
          ))
        : null}
    </>
  );
}

/**
 * A session title, shimmering while the session is still running.
 *
 * Upstream's own running indicator — there is no spinner and no dot. It paints
 * the text with a gradient and animates the background position, using
 * `--text_default_quaternary` as the travelling highlight. Reproduced with the
 * same inline properties upstream sets, so the effect is identical rather than
 * merely similar. `prefers-reduced-motion` disables it, matching upstream's
 * reduced-motion handling elsewhere in its stylesheet.
 */
function RunningTitle({ title, running }: { title: string; running: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [durationMs, setDurationMs] = useState<number>(1600);

  useEffect(() => {
    if (!running || typeof window === "undefined") return;
    const el = ref.current;
    if (!el) return;
    // SPEC §F row 211: upstream drives the shimmer via
    // `--shimmer-text-band: 80px` and `duration = (width + 80) / 80 * 1000 ms`.
    // We read the measured width after layout and apply both, so a long title
    // takes proportionally longer to sweep. The width listener is reset
    // whenever the sidebar resizes (or the locale/title changes).
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setDurationMs(Math.round((w + 80) / 80 * 1000));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [running, title]);

  if (!running) {
    return (
      <span className="desktop-text-ui-body min-w-0 flex-1 truncate text-sm leading-5 text-text_default_secondary">
        {title}
      </span>
    );
  }
  return (
    <span
      ref={ref}
      data-testid="sidebar-session-running"
      className="desktop-text-ui-body min-w-0 flex-1 truncate text-sm leading-5 text-text_default_primary motion-reduce:animate-none"
      style={{
        // Upstream's highlight band is 80px wide; the gradient stays
        // anchored to the band regardless of container width.
        backgroundImage:
          "linear-gradient(90deg, var(--text_default_primary, #171717) 0%, var(--text_default_quaternary, #cccccc) 50%, var(--text_default_primary, #171717) 100%)",
        backgroundSize: "var(--shimmer-text-band, 80px) 100%",
        backgroundClip: "text",
        WebkitTextFillColor: "transparent",
        animation: `shimmer ${durationMs}ms linear infinite`,
      }}
    >
      {title}
    </span>
  );
}

/**
 * Level 4 — a subagent session spawned by a main session.
 *
 * Its own row rather than something nested inside `SessionNode`'s single-line flex
 * row, and it switches the conversation like any other row: a subagent's
 * transcript is a real session the user can open. Upstream indents these one step
 * further and prints the agent name on the right, which is what distinguishes a
 * subagent from a main session at a glance.
 */
function SubagentRow({
  session,
  active,
  onChanged,
  t,
}: {
  session: api.TreeSession;
  active: boolean;
  onChanged: () => void;
  t: (key: MessageKey) => string;
}) {
  const onOpen = useCallback(() => {
    void runAction(t("sidebar.openSession"), api.switchSession(session.id)).then(onChanged);
  }, [session.id, onChanged, t]);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={session.title || t(UNTITLED)}
      data-testid="sidebar-subagent-row"
      data-agent={session.agent}
      className={[
        "w-full flex items-center gap-2 pl-8 pr-2 h-[26px] text-left transition-colors rounded-lg",
        active
          ? "bg-bg_interaction_tertiary_hover"
          : "hover:bg-bg_interaction_tertiary_hover",
      ].join(" ")}
    >
      <span
        aria-hidden
        className="flex flex-shrink-0 items-center justify-center h-[18px] w-[18px] text-icon_default_tertiary"
      >
        <span className="block h-[18px] w-0 border-l-[0.5px] border-border_default" />
      </span>
      <span className="desktop-text-ui-body min-w-0 flex-1 truncate text-sm text-text_default_secondary">
        {session.title || t(UNTITLED)}
      </span>
      <span className="flex-shrink-0 text-caption-small-strong text-text_default_tertiary">
        {session.agent}
      </span>
    </button>
  );
}
