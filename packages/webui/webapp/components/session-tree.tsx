"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dropdown } from "antd";
import { Input as AntInput, Modal as AntModal, type InputRef } from "antd";
import type { MenuProps } from "antd";

import * as api from "@/lib/api";
import { reportActionError, runAction } from "@/lib/action-errors";
import { useSessionContext } from "@/lib/store";
import type { MessageKey } from "@/lib/i18n";
import { sessionHref } from "@/lib/url-restore";
import { classifySwitchLanding } from "@/lib/session-switch";
import { projectRevealTarget, runProjectReveal } from "@/lib/project-reveal";
import {
  readProjectCustomizations,
  setProjectTitle,
  toggleProjectPinned,
  clearProjectCustomizations,
} from "@/lib/project-custom";
import { Icon } from "./icons";
import { MenuDivider, MenuRow } from "./shell";
import { WebuiContextMenu, type WebuiContextMenuItem } from "./context-menu";
import { sortWebuiProjectSessionIds } from "@/lib/session-rail";
import { ProjectRowSwitchAction } from "./workspace-picker";

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
 * ## Project context menu (ticket 55c, ref-26)
 *
 * The project header carries the desktop's five-entry context menu:
 *
 *   - 重命名项目 — real, backed by a browser-local display-name overlay
 *     (`lib/project-custom.ts`); there is no mcode surface to write a project
 *     name into (see that module's header for the reasoning).
 *   - 置顶项目 — real, same overlay module; pinned projects sort to the top.
 *   - 在文件夹中显示 — placeholder, disabled: a browser cannot open the OS
 *     file manager.
 *   - 归档对话 — placeholder, disabled: mcode's runtime db has an `archived`
 *     flag, but writing another process's database is out of scope for this
 *     slice and there is no un-archive surface yet (ticket 55b's archived
 *     tasks page is the prerequisite; without it archiving would be
 *     irreversible data loss).
 *   - 移除 (red) — real: batch-deletes every session under the project
 *     through the existing `DELETE /api/sessions/:id`, behind a confirm.
 *
 * One deliberate departure remains from the earlier trim: the per-row hover
 * pin (upstream swaps the row marker to a pin on hover). Pinning is
 * project-level in this UI, so the hairline stays as the resting state.
 *
 * webui-parity 47 aligned the interaction layer with the reference: selected
 * rows paint with the `tertiary_selected` token (hover keeps `tertiary_hover`),
 * the section header is a plain div, disclosures animate through `Expandable`
 * (the reference's `.webui-expandable-motion`), the empty and error states
 * carry the reference's card face and `role="alert"` respectively, and
 * session/subagent rows are `<a>` deep links over the app's own `?session=`
 * grammar (`lib/url-restore.ts#sessionHref`).
 */

// How many sessions a directory shows before the rest go behind `更多`. Upstream
// reveals its `sidebar-session-group-more` row under the same rule.
const SESSION_VISIBLE_LIMIT = 6;

/** Upstream's `placeholder` treatment for a session with no title yet. */
const UNTITLED: MessageKey = "sidebar.untitled";

/**
 * The disclosure wrapper (webui-parity 47, S5).
 *
 * The reference animates every sidebar disclosure with its
 * `.webui-expandable-motion` rule: `grid-template-rows 0fr → 1fr` (height
 * interpolates without measuring any row) plus a 140ms opacity crossfade;
 * `globals.css` carries the rule verbatim under the same class name, with a
 * `prefers-reduced-motion` branch that drops the transition but keeps the
 * open/closed state.
 *
 * The children stay MOUNTED while collapsed — that is what keeps the session
 * tree's loaded state and (in the shell) scroll position intact through a
 * collapse cycle — and the wrapper is `inert` + `aria-hidden` while closed so
 * the hidden rows are neither focusable nor announced.
 */
function Expandable({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`webui-expandable-motion${open ? " is-open" : ""}`}
      aria-hidden={!open}
      ref={(element) => {
        element?.toggleAttribute("inert", !open);
      }}
    >
      <div>{children}</div>
    </div>
  );
}

export function SessionTree({ t }: { t: (key: MessageKey) => string }) {
  const store = useSessionContext();
  const state = store.state;
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

  // Last-write-wins. Two effects below drive `refresh` — one on the active
  // session changing (a plain, usually-cached read) and one on the run state
  // changing (a forced re-read past the server's 15s cache). They are not
  // mutually exclusive, so a slow forced re-read could otherwise land after a
  // faster cached one and resurrect a stale status — a session still painted
  // as running after its turn ended, or the wrong ordering.
  const refreshGen = useRef(0);
  const refresh = useCallback(async (force = false) => {
    const gen = ++refreshGen.current;
    try {
      const next = await api.getSessionTree(force);
      if (gen !== refreshGen.current) return; // a newer read won
      setPayload(next.ok ? next : null);
      setError(next.ok ? null : next.reason ?? "unavailable");
    } catch (cause) {
      if (gen !== refreshGen.current) return;
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

  // Slice 06 — Agent Team. The server emits a `session-tree-changed` SSE
  // frame the moment a subagent row lands in the runtime db. The store
  // bumps `treeRevision` on every frame; we react by forcing a re-read
  // past the 15s cache. Skipped on mount: the initial fetch already runs.
  const sawTreeChange = useRef(false);
  useEffect(() => {
    if (!sawTreeChange.current) {
      sawTreeChange.current = true;
      return;
    }
    void refresh(true);
  }, [refresh, store.treeRevision]);

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

  // Ticket 55c — browser-local project customizations (rename overlay + pin
  // set; see lib/project-custom.ts). One state at the tree root, updated by
  // the project rows' context-menu actions. Pinned projects sort to the top
  // (in pin order — newest pin first), the rest keep the server's recency
  // order. A pin whose project disappeared is inert: it simply matches
  // nothing.
  const [customs, setCustoms] = useState(() => readProjectCustomizations());
  const onRenameProject = useCallback((key: string, title: string) => {
    setCustoms(setProjectTitle(key, title));
  }, []);
  const onTogglePinned = useCallback((key: string) => {
    setCustoms(toggleProjectPinned(key));
  }, []);
  // Routed through the tree root (not a direct clearProjectCustomizations
  // call inside ProjectNode) so the in-memory `customs` state and
  // localStorage change together — a project that survives a partial
  // remove must not keep showing an overlay its storage already lost.
  const onProjectRemoved = useCallback((key: string) => {
    setCustoms(clearProjectCustomizations(key));
  }, []);
  const sortedProjects = useMemo(() => {
    const rank = new Map(customs.pinned.map((key, index) => [key, index]));
    return [...projects].sort((a, b) => {
      const pa = rank.has(a.key) ? rank.get(a.key)! : Number.POSITIVE_INFINITY;
      const pb = rank.has(b.key) ? rank.get(b.key)! : Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return 0; // stable: Array.prototype.sort keeps recency order within a tier
    });
  }, [projects, customs.pinned]);

  return (
    // `scrollbar-gutter: stable` matches upstream so the list does not shift
    // when the scrollbar appears.
    <div
      data-testid="sidebar-scroll-viewport"
      className="h-full overflow-x-hidden overflow-y-auto px-2 scrollbar-hide"
      style={{ scrollbarGutter: "stable" }}
    >
      {error ? (
        /* webui-parity 47 (S4): `role="alert"` so screen readers announce the
           failure, and the live reason follows the localized prefix — a bare
           generic string left the user unable to tell a dead engine from a
           500. */
        <p
          role="alert"
          data-testid="sidebar-tree-error"
          className="px-2 pb-1 text-caption-small-strong text-text_status_error"
        >
          {t("sidebar.loadError")}
          {error}
        </p>
      ) : null}
      {!error && projects.length === 0 ? (
        /* webui-parity 47 (S3): the empty state gets the reference's card
           face (`.webui-empty-state`: radius, grouped background, padding)
           instead of bare floating text. */
        <p className="webui-empty-state mx-1 text-caption-small-strong text-text_default_secondary">
          {t("sidebar.empty")}
        </p>
      ) : null}

      {/* Section header — collapsible `group/section` row whose label is `项目`. */}
      {projects.length > 0 ? <SectionHeader label={t("sidebar.projects")} /> : null}

      {sortedProjects.map((project) => (
        <div key={project.key} className="space-y-px">
          <ProjectNode
            project={project}
            displayName={customs.titles[project.key] ?? project.name}
            pinned={customs.pinned.includes(project.key)}
            onRename={onRenameProject}
            onTogglePinned={onTogglePinned}
            onProjectRemoved={onProjectRemoved}
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
 * Activate a session, and say so when the engine did not follow.
 *
 * `runAction` only covers a request that came back rejected. The failure this
 * exists for produced no rejected request at all (webui-parity 63, defect E):
 * the row the user clicked, the URL and the engine's active session disagreed,
 * and a click that did nothing was indistinguishable from one that worked. The
 * switch response names the session the engine landed on, so that is what gets
 * compared — and only a proven mismatch reports, which keeps an ordinary switch
 * silent rather than nagging. The decision itself is `lib/session-switch.ts`.
 */
function openSessionAndReportLanding(
  sessionId: string,
  onChanged: () => void,
  t: (key: MessageKey) => string,
): void {
  const label = t("sidebar.openSession");
  void api
    .switchSession(sessionId)
    .then((res) => {
      if (classifySwitchLanding(res.session, sessionId) === "mismatch") {
        reportActionError(label, t("sidebar.switchMismatch"));
      }
    })
    .catch((cause) => reportActionError(label, cause))
    .then(onChanged);
}

/**
 * Upstream's `group/section` header row.
 *
 * webui-parity 47 (S2): a plain `div`, matching the reference's section
 * header (`.webui-rail-section-header`: `h-7` / `px-2` / tertiary label, no
 * arrow, not interactive). The previous markup rendered a `<button>` with no
 * `onClick` — focusable, announced as a control, and dead on click. If the
 * header ever gains a real behaviour, the control comes back together with
 * that behaviour, not before.
 */
function SectionHeader({ label }: { label: string }) {
  return (
    <div
      data-testid="sidebar-section-header"
      className="flex h-7 items-center px-2 text-sm font-normal leading-5 text-text_default_tertiary"
    >
      <span className="truncate">{label}</span>
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
 *
 * `className` exists for the one caller that renders a row action inside a
 * `pointer-events-none` layer (the session row's hover tray, webui-parity 63):
 * `pointer-events` is an inherited property, so such a tray has to switch it
 * back on per control or the control stops taking clicks.
 */
function RowAction({
  label,
  onClick,
  tone = "icon",
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "icon" | "tertiary" | "primary";
  className?: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === "tertiary"
      ? "flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[8px] text-text_default_tertiary transition-colors duration-200 hover:bg-bg_interaction_tertiary_hover hover:text-text_default_secondary"
      : tone === "primary"
        ? "flex h-[30px] w-[30px] items-center justify-center rounded-[8px] text-icon_interaction_tertiary_default transition-colors duration-200 hover:text-icon_interaction_tertiary_hover"
        : "flex h-[30px] w-[30px] items-center justify-center rounded text-icon_default_tertiary transition-colors hover:text-icon_default_secondary";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={className ? `${cls} ${className}` : cls}
    >
      {children}
    </button>
  );
}

/**
 * Level 1 — a project (one git repository, however many worktrees it has).
 *
 * The header carries the desktop's context menu (55c, ref-26). Rename and pin
 * are backed by the browser-local overlay (`lib/project-custom.ts`); reveal
 * and archive are disabled placeholders; remove batch-deletes the project's
 * sessions behind a confirm. The rename affordance reuses the session row's
 * inline-editor interaction (Enter commits, Escape discards, blur commits).
 */
function ProjectNode({
  project,
  displayName,
  pinned,
  onRename,
  onTogglePinned,
  onProjectRemoved,
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
  /** Overlay display name (user rename); falls back to the repo basename. */
  displayName: string;
  /** Whether the pin overlay currently holds this project. */
  pinned: boolean;
  /** Commit a rename (empty title clears the overlay). */
  onRename: (key: string, title: string) => void;
  /** Toggle the pin. */
  onTogglePinned: (key: string) => void;
  /**
   * Drop the project's overlay entries after a FULL successful remove —
   * routed through the tree root so the in-memory state and localStorage
   * stay in step (QA N3).
   */
  onProjectRemoved: (key: string) => void;
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
    ? `${displayName}, ${project.repoPaths.join(", ")}`
    : displayName;
  // The first repo path is the broad-stroke target; multi-directory
  // projects expose the per-directory choice below through DirectoryNode.
  // SB-6: the same path is the project menu's 在文件夹中显示 target, so both
  // read one helper rather than two copies of the rule.
  const switchRepoPath = projectRevealTarget(project);

  // Inline rename (same interaction contract as SessionNode's editor).
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<InputRef>(null);
  const renaming = draft !== null;
  useEffect(() => {
    if (renaming) inputRef.current?.input?.select();
  }, [renaming]);

  const commitRename = useCallback(() => {
    const next = (draft ?? "").trim();
    // Empty commit clears the overlay (back to the repo basename) — the
    // same rule the pin overlay follows, so there is one way to reset.
    setDraft(null);
    if (next && next !== displayName) onRename(project.key, next);
  }, [draft, displayName, onRename, project.key]);

  // Remove confirm. Deleting runs sequentially through the existing
  // single-session endpoint; a failure reports and stops the batch (the
  // sessions deleted before it stay deleted — the confirm already told the
  // user this cannot be undone). Each delete passes the server's
  // `authorize("session.delete")` gate individually — there is no
  // batch-authorization contract — so the confirm tells the user upfront
  // how many approval prompts to expect, and the dialog shows live
  // progress while it runs.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [progress, setProgress] = useState(0);
  // Every session id under the project, subagents included: mcode's runtime
  // rows are per-session and DELETE does not cascade into children. This
  // is ALSO the number the confirm quotes — the deletion is irreversible,
  // so the count must be the true number of rows about to go, not the
  // pill's main-session count (`sessionCount`), which deliberately tracks
  // user-started conversations only.
  const allSessionIds = useMemo(
    () =>
      project.directories.flatMap((directory) =>
        directory.sessions.flatMap((session) => [
          session.id,
          ...session.children.map((child) => child.id),
        ]),
      ),
    [project.directories],
  );
  const runRemove = useCallback(async () => {
    setRemoving(true);
    setProgress(0);
    let failed = false;
    for (const id of allSessionIds) {
      try {
        await api.deleteSession(id);
      } catch (cause) {
        reportActionError(t("projectMenu.remove"), cause);
        failed = true;
        break;
      }
      setProgress((done) => done + 1);
    }
    // Customizations are cleared ONLY on a full success. A partial failure
    // leaves the project (or its remains) with its rename/pin intact —
    // stripping them from a project that still exists would silently undo
    // the user's own edits (QA N3).
    if (!failed) onProjectRemoved(project.key);
    setRemoving(false);
    setConfirmRemove(false);
    onChanged();
  }, [allSessionIds, onChanged, onProjectRemoved, project.key, t]);

  const menuItems: MenuProps["items"] = [
    {
      key: "rename",
      label: (
        <MenuRow icon="pencil" label={t("projectMenu.rename")} testid="project-menu-rename" />
      ),
      onClick: () => {
        setDraft(displayName);
      },
    },
    {
      key: "pin",
      label: (
        <MenuRow
          icon="pin"
          label={pinned ? t("projectMenu.unpin") : t("projectMenu.pin")}
          testid="project-menu-pin"
        />
      ),
      onClick: () => onTogglePinned(project.key),
    },
    {
      key: "reveal",
      // SB-6. The item used to be `disabled: true` with `common.notLocal`,
      // claiming the local build cannot reach the OS file manager — it can,
      // and always could: `POST /api/fs/reveal` is implemented and registered
      // (`server/routes/fs.js#handleFsReveal`, `server/app.js`). The only
      // honest reason to grey this row out is a project bound to no local
      // directory, and that reason is now stated instead of guessed.
      disabled: !switchRepoPath,
      label: (
        <MenuRow
          icon="folder"
          label={t("projectMenu.revealInFolder")}
          disabled={!switchRepoPath}
          title={switchRepoPath ? undefined : t("projectMenu.revealUnavailableNoPath")}
          testid="project-menu-reveal"
        />
      ),
      onClick: () => {
        void runProjectReveal(switchRepoPath, t("projectMenu.revealInFolder"), {
          reveal: api.revealInFileManager,
          report: reportActionError,
        });
      },
    },
    {
      key: "archive",
      disabled: true,
      label: (
        <MenuRow
          icon="archive"
          label={t("projectMenu.archive")}
          disabled
          // PB-1 updated this reason, and the tooltip is the only place it
          // is stated. The old `common.notLocal` was WRONG twice over: it
          // claimed the local build lacks a capability it has had all
          // along (the SESSION-level 归档 above this menu is now live and
          // calls `archiveSession`), and it said nothing about what is
          // actually missing. What is missing is a PROJECT-SCOPED bulk
          // archive: v2 declares `archiveSession({id, archived})` for one
          // session and nothing project-wide, so this item would have to
          // fan out N single-session writes. Whether a partial failure
          // counts as success, and whether the user authorizes once or N
          // times, are product decisions no existing contract answers —
          // see `server/engine/session-context-actions.js` KNOWN DEBT 2.
          title={t("projectMenu.archiveUnavailable")}
          testid="project-menu-archive"
        />
      ),
    },
    { key: "divider", disabled: true, label: <MenuDivider /> },
    {
      key: "remove",
      label: (
        <MenuRow
          icon="trash"
          label={t("projectMenu.remove")}
          danger
          testid="project-menu-remove"
        />
      ),
      onClick: () => setConfirmRemove(true),
    },
  ];

  const header = renaming ? (
    <div data-testid="sidebar-project-header" className="group/project-header flex h-[30px] items-center gap-2 rounded-lg pl-2 pr-0.5">
      <span className="flex size-[14px] flex-shrink-0 items-center justify-center text-icon_default_primary">
        <Icon name="caretDown" size={12} className={open ? "transition-transform" : "-rotate-90 transition-transform"} />
      </span>
      <span className="flex size-[18px] flex-shrink-0 items-center justify-center text-icon_default_secondary">
        <Icon name={open ? "folderEmpty" : "folder"} size={18} />
      </span>
      <AntInput
        ref={inputRef}
        type="text"
        maxLength={200}
        value={draft ?? ""}
        aria-label={t("projectMenu.rename")}
        data-testid="sidebar-project-rename-input"
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitRename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
          }
        }}
        onBlur={() => commitRename()}
        className="desktop-text-ui-body min-w-0 flex-1 rounded-[4px] border border-border_accent bg-bg_grouped_secondary px-1.5 py-px text-sm leading-5 text-text_default_primary outline-none"
      />
    </div>
  ) : (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      aria-expanded={open}
      data-testid="sidebar-project-header"
      data-pinned={pinned ? "true" : "false"}
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
        {displayName}
      </span>

      {/* A pinned project keeps its pin visible beside the title — the
          hover-only actions row would otherwise make pin state invisible
          until hover, and the pinned tier exists precisely to be seen. */}
      {pinned ? (
        <span
          aria-label={t("projectMenu.pin")}
          title={t("projectMenu.pin")}
          className="flex size-[18px] flex-shrink-0 items-center justify-center text-icon_default_tertiary"
        >
          <Icon name="pin" size={12} />
        </span>
      ) : null}

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
        <span className="pointer-events-none absolute inset-y-0 right-0.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100">
          {switchRepoPath ? (
            <ProjectRowSwitchAction
              t={t}
              repoPath={switchRepoPath}
              onChanged={onChanged}
            />
          ) : null}
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
  );

  return (
    <>
      {/* The context menu rides the header row (right-click). antd's Dropdown
          owns dismissal; the panel wears the same mavis-dropdown skin the
          user menu does so the two menus read as one family. */}
      <Dropdown
        trigger={["contextMenu"]}
        placement="bottomLeft"
        overlayClassName="mavis-dropdown mavis-user-dropdown"
        menu={{
          items: menuItems,
          rootClassName: "mavis-dropdown-root-sub-menu mavis-user-dropdown-submenu",
          style: { width: "100%" },
        }}
        popupRender={(menuNode) => <div data-testid="project-context-menu">{menuNode}</div>}
      >
        {header}
      </Dropdown>

      {confirmRemove ? (
        <AntModal
          open
          centered
          closable
          keyboard
          maskClosable={!removing}
          footer={null}
          destroyOnHidden
          width={440}
          rootClassName="mavis-confirm-modal-compact"
          classNames={{
            mask: "mavis-confirm-modal-compact-mask",
            content: "mavis-confirm-modal-compact-surface",
          }}
          styles={{ header: { background: "transparent" } }}
          title={
            <span className="mavis-confirm-modal-compact-title text-heading3 text-text_default_primary">
              {t("projectMenu.removeConfirmTitle")}
            </span>
          }
          onCancel={() => {
            if (!removing) setConfirmRemove(false);
          }}
        >
          <div data-testid="project-remove-confirm" className="flex flex-col gap-4 py-2">
            <p className="text-sm leading-6 text-text_default_secondary">
              {/* The count is the true deletion set — main sessions AND
                  subagent rows — not the sidebar pill's main-session count:
                  an irreversible confirm must not understate what goes. */}
              {t("projectMenu.removeConfirmBody").replace(
                "{count}",
                String(allSessionIds.length),
              )}
            </p>
            {/* The server authorizes each single-session delete separately
                (no batch contract), so the user is told the number of
                approval prompts to expect instead of discovering them
                one dialog at a time. */}
            <p className="text-caption-small-strong leading-5 text-text_default_tertiary">
              {t("projectMenu.removeConfirmAuthNote").replace(
                "{count}",
                String(allSessionIds.length),
              )}
            </p>
            {removing ? (
              <p
                data-testid="project-remove-progress"
                className="text-caption-small-strong leading-5 text-text_default_secondary"
              >
                {t("projectMenu.removeProgress")
                  .replace("{done}", String(progress))
                  .replace("{total}", String(allSessionIds.length))}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={removing}
                onClick={() => setConfirmRemove(false)}
                className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
              >
                {t("projectMenu.cancel")}
              </button>
              <button
                type="button"
                disabled={removing}
                data-testid="project-remove-confirm-button"
                onClick={() => void runRemove()}
                className="h-8 rounded-lg bg-bg_interaction_danger_primary_default px-3 text-sm text-text_label_danger_primary_default transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {t("projectMenu.removeConfirm")}
              </button>
            </div>
          </div>
        </AntModal>
      ) : null}

      <Expandable open={open}>
        {project.directories.map((directory) => (
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
        ))}
      </Expandable>
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
  // webui-parity 58 (line B): within-directory ordering runs through the
  // reference's `sortWebuiProjectSessionIds` — pinned first, then
  // `updatedAt` descending, total on both keys so a refresh cannot reshuffle
  // equal-activity sessions. The pin record is empty for now (no
  // session-pin contract), so the effective rule is the deterministic
  // recency sort; the call site is already shaped for the day a pin record
  // lands.
  const orderedIds = sortWebuiProjectSessionIds(
    directory.sessions,
    {},
    directory.sessions.map(({ id }) => id),
  );
  const sessionsById = new Map(directory.sessions.map((entry) => [entry.id, entry]));
  const orderedSessions = orderedIds
    .map((id) => sessionsById.get(id))
    .filter((entry): entry is api.TreeSession => Boolean(entry));
  const visible = orderedSessions.slice(0, limit);
  const hidden = orderedSessions.length - visible.length;
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
          workspaceDir={directory.path}
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
          own disclosure (the Expandable that wraps every directory), so its
          sessions render unconditionally and are hidden by that wrapper, one
          indent in from the project row. A multi-directory project gates its
          session rows on the directory's own disclosure, animated the same
          way. */}
      {headerless ? (
        <div className="pl-4">{rows}</div>
      ) : (
        <Expandable open={open}>{rows}</Expandable>
      )}
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
/**
 * The session-row right-click menu — webui-parity 58 (line B).
 *
 * The item list, order, dividers, icons and danger tone are the reference
 * `SessionRail.tsx#openSessionMenu` moved across verbatim (zh labels too, via
 * the `sessionMenu.*` dictionary entries). What differs is only which items
 * this server can honour:
 *
 *   - 重命名 / 复制（工作目录、会话 ID）/ 删除 are real — they route through
 *     the same endpoints the hover actions use.
 *   - 置顶 / 归档 / 复制为新会话 became real in PB-1. Each has a handler
 *     passed in by the row that owns it (`onPin` / `onArchive` / `onFork`);
 *     they are `disabled` when the row did not supply one, which is the
 *     same rule 重命名 has always used. The state is not re-derived here —
 *     a row is pinned because `session.pinned` says so, and that field is
 *     the engine's `PinService` answer laid over the tree by
 *     `server/routes/sessions.js`.
 *   - 复制到新工作树 stays disabled, and the reason is NOT "no contract":
 *     the engine has the method. `ForkSessionInput.createIsolatedWorktree`
 *     exists and `GET /api/sessions/:id/fork-options` already returns
 *     `worktreeVisible` / `worktreeEligible` / `worktreeUnavailableReason`,
 *     and this client type carries all three. What is missing is a
 *     REFERENCE — design-ref/ has no screenshot of this menu, so the
 *     dialog's shape, whether a branch is chosen, and what happens to the
 *     source session are unknown. Per doc/placeholder-batch-plan.md §3.4
 *     ("不要在没有参照的情况下自创形态") this item is not self-authored.
 *   - 在文件夹中显示 / 问题反馈 are disabled in the reference itself; they
 *     are carried across as-is so the menu's shape matches.
 */
function buildSessionContextMenu({
  session,
  workspaceDir,
  onRename,
  onPin,
  onArchive,
  onFork,
  onDelete,
  t,
}: {
  session: api.TreeSession;
  /** The directory the session ran in — the reference's `session.workspaceDir`. */
  workspaceDir?: string;
  onRename?: () => void;
  /** PB-1: pin / unpin this session. Absent → the item renders disabled. */
  onPin?: () => void;
  /** PB-1: archive this session. Absent → the item renders disabled. */
  onArchive?: () => void;
  /** PB-1: open the duplicate dialog. Absent → the item renders disabled. */
  onFork?: () => void;
  onDelete: () => void;
  t: (key: MessageKey) => string;
}): readonly WebuiContextMenuItem[] {
  const menuIcon = (name: Parameters<typeof Icon>[0]["name"]) => <Icon name={name} />;
  return [
    {
      kind: "item",
      key: "pin",
      // A pinned session's action is to UNpin, and the label says so. The
      // state comes from the engine's own pin answer, not from a local
      // guess — see this component's header.
      label: t(session.pinned ? "sessionMenu.unpin" : "sessionMenu.pin"),
      icon: menuIcon("pin"),
      disabled: !onPin,
      onSelect: onPin,
    },
    {
      kind: "item",
      key: "rename",
      label: t("sessionMenu.rename"),
      icon: menuIcon("pencil"),
      disabled: !onRename,
      onSelect: onRename,
    },
    {
      kind: "item",
      key: "archive",
      label: t("sessionMenu.archive"),
      icon: menuIcon("archive"),
      disabled: !onArchive,
      onSelect: onArchive,
    },
    { kind: "divider", key: "fork-divider" },
    {
      kind: "item",
      key: "fork-current",
      label: t("sessionMenu.forkCurrent"),
      icon: menuIcon("fork"),
      disabled: !onFork,
      onSelect: onFork,
    },
    {
      kind: "item",
      key: "fork-worktree",
      label: t("sessionMenu.forkWorktree"),
      icon: menuIcon("fork"),
      // Honest placeholder, not a missing backend. The engine method and
      // the eligibility fields both exist (see this component's header);
      // the desktop reference for this variant's UI does not. Enabling
      // it would mean inventing the form. See
      // server/engine/session-context-actions.js KNOWN DEBT 1.
      disabled: true,
    },
    { kind: "divider", key: "copy-divider" },
    {
      kind: "item",
      key: "show-folder",
      label: t("sessionMenu.revealInFolder"),
      icon: menuIcon("folder"),
      disabled: true, // disabled in the reference as well
    },
    {
      kind: "item",
      key: "copy",
      label: t("sessionMenu.copy"),
      icon: menuIcon("copy"),
      submenu: [
        {
          kind: "item",
          key: "copy-workspace-dir",
          label: t("sessionMenu.copyWorkspaceDir"),
          icon: menuIcon("copy"),
          disabled: !workspaceDir,
          onSelect: () => void copyToClipboard(workspaceDir, t),
        },
        {
          kind: "item",
          key: "copy-session-id",
          label: t("sessionMenu.copySessionId"),
          icon: menuIcon("copy"),
          onSelect: () => void copyToClipboard(session.id, t),
        },
      ],
    },
    {
      kind: "item",
      key: "feedback",
      label: t("sessionMenu.feedback"),
      icon: menuIcon("feedback"),
      disabled: true, // disabled in the reference as well
    },
    { kind: "divider", key: "delete-divider" },
    {
      kind: "item",
      key: "delete",
      label: t("sessionMenu.delete"),
      icon: menuIcon("trash"),
      danger: true,
      onSelect: onDelete,
    },
  ];
}

/** Clipboard write that degrades to a reported error instead of throwing in the menu. */
async function copyToClipboard(value: string | undefined, t: (key: MessageKey) => string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch (cause) {
    reportActionError(t("sessionMenu.copy"), cause);
  }
}

/**
 * The 复制为新会话 preview dialog (PB-1).
 *
 * It exists because `GET /api/sessions/:id/fork-options` exists. The
 * engine answers a real question before the write — can this session be
 * forked, what will it be called, which copy of the title is it — and a
 * dialog that did not ask would be throwing that answer away. So the
 * dialog is the read, rendered: it opens, it fetches, and only the
 * engine's own `canFork` decides whether the confirm button is live.
 *
 * What it deliberately does NOT render is the worktree row. The engine
 * returns `worktreeVisible` / `worktreeEligible` and the client type
 * carries them; showing a disabled "duplicate to new worktree" row here
 * would be a second reference-free form, and this batch's discipline is
 * that an item with no reference stays a single greyed menu row rather
 * than becoming a greyed row in two places. See
 * `server/engine/session-context-actions.js` KNOWN DEBT 1.
 *
 * The three states are all rendered and none is a blank:
 *
 *   loading   — the fetch is in flight. The confirm button is disabled
 *               rather than absent, so the dialog does not change shape
 *               when the answer lands.
 *   canFork   — the confirm button is live and carries the suggested
 *               title in its own label-adjacent line, so the user sees
 *               exactly the title the fork will use (the server forces
 *               `useSuggestedTitle: true`).
 *   !canFork  — the engine's own `unavailableReason` is shown and the
 *               confirm button is disabled. The reason is rendered as
 *               the engine's text rather than translated: it is a
 *               machine reason code the engine owns, and inventing a
 *               translation for a code this build has never seen would
 *               be a guess presented as a translation.
 */
function SessionForkDialog({
  sessionId,
  open,
  onCancel,
  onForked,
  t,
}: {
  sessionId: string;
  open: boolean;
  onCancel: () => void;
  /** Called with the new session's id once the fork succeeded. */
  onForked: (newSessionId: string) => void;
  t: (key: MessageKey) => string;
}) {
  const [options, setOptions] = useState<api.SessionForkOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [forking, setForking] = useState(false);
  // The id whose options are on screen. Without it, a dialog reopened on
  // a DIFFERENT row would show the previous row's answer for the frames
  // between mount and the fetch resolving — the same class of bug as
  // reusing a stale closure over a changed prop.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setOptions(null);
    setLoadedFor(null);
    void (async () => {
      try {
        const next = await api.getSessionForkOptions(sessionId);
        if (cancelled) return;
        setOptions(next);
        setLoadedFor(sessionId);
      } catch (cause) {
        if (cancelled) return;
        // A failed READ is not an empty answer: the dialog says so and
        // keeps the confirm button disabled, rather than rendering
        // `canFork:false` and implying the engine refused a fork it was
        // never asked about.
        reportActionError(t("sessionMenu.forkCurrent"), cause);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, t]);

  if (!open) return null;

  const canFork = options?.ok === true && options.canFork === true;
  // `loadedFor` guards the render against the one frame where `options`
  // still holds the previous row's answer.
  const answer = loadedFor === sessionId ? options : null;

  const runFork = async () => {
    setForking(true);
    try {
      const forked = await api.forkSession(sessionId);
      onCancel();
      onForked(forked.id);
    } catch (cause) {
      reportActionError(t("sessionMenu.forkCurrent"), cause);
    } finally {
      setForking(false);
    }
  };

  return (
    <AntModal
      open
      centered
      closable
      keyboard
      maskClosable={!forking}
      footer={null}
      destroyOnHidden
      width={440}
      rootClassName="mavis-confirm-modal-compact"
      classNames={{
        mask: "mavis-confirm-modal-compact-mask",
        content: "mavis-confirm-modal-compact-surface",
      }}
      styles={{ header: { background: "transparent" } }}
      title={
        <span className="mavis-confirm-modal-compact-title text-heading3 text-text_default_primary">
          {t("sessionMenu.forkCurrent")}
        </span>
      }
      onCancel={() => {
        if (!forking) onCancel();
      }}
    >
      <div data-testid="session-fork-dialog" className="flex flex-col gap-4 py-2">
        {loading ? (
          <p
            data-testid="session-fork-loading"
            className="text-sm leading-6 text-text_default_secondary"
          >
            {t("sessionMenu.forkLoading")}
          </p>
        ) : !answer ? (
          <p
            data-testid="session-fork-unavailable"
            className="text-sm leading-6 text-text_default_secondary"
          >
            {t("sessionMenu.forkUnavailable")}
          </p>
        ) : (
          <>
            {answer.sourceTitle ? (
              <p className="text-sm leading-6 text-text_default_secondary">
                {t("sessionMenu.forkFrom").replace("{title}", answer.sourceTitle)}
              </p>
            ) : null}
            <p className="text-caption-small-strong leading-5 text-text_default_tertiary">
              {answer.suggestedTitle
                ? t("sessionMenu.forkSuggested").replace("{title}", answer.suggestedTitle)
                : t("sessionMenu.forkNoTitle")}
            </p>
            {answer.canFork ? null : (
              <p
                data-testid="session-fork-blocked"
                className="text-caption-small-strong leading-5 text-text_label_danger_primary_default"
              >
                {t("sessionMenu.forkBlocked").replace(
                  "{reason}",
                  answer.unavailableReason ?? t("sessionMenu.forkBlockedUnknown"),
                )}
              </p>
            )}
          </>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={forking}
            onClick={onCancel}
            className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
          >
            {t("sessionMenu.forkCancel")}
          </button>
          <button
            type="button"
            // Live only on the engine's own `canFork`, and never while the
            // read is in flight — a button that becomes clickable before
            // the answer arrives would fork on a guess.
            disabled={forking || loading || !canFork}
            data-testid="session-fork-confirm"
            onClick={() => void runFork()}
            className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm text-text_label_inverse_primary transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {t("sessionMenu.forkConfirm")}
          </button>
        </div>
      </div>
    </AntModal>
  );
}

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
  workspaceDir,
  t,
}: {
  session: api.TreeSession;
  activeId: string | null;
  open: boolean;
  onToggle: (key: string) => void;
  onChanged: () => void;
  /** The directory this session's project row sits under — feeds the menu's copy item. */
  workspaceDir?: string;
  t: (key: MessageKey) => string;
}) {
  const { state } = useSessionContext();
  const active = session.id === activeId;
  // webui-parity 58 (line B): the session row's right-click menu. State is
  // per-row (the reference holds one in the list root; both render a single
  // portal menu at a time because opening another row's menu unmounts this
  // row's before its own portal can coexist).
  const [contextMenu, setContextMenu] = useState<
    | { readonly x: number; readonly y: number; readonly items: readonly WebuiContextMenuItem[] }
    | undefined
  >();
  // PB-1: the 复制为新会话 dialog. Held here rather than in the menu builder
  // because the menu is a pure function of its arguments and rebuilt on
  // every right-click, while the dialog is a piece of state with a fetch
  // and a pending write behind it.
  const [forkOpen, setForkOpen] = useState(false);
  const openSessionMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: buildSessionContextMenu({
        session,
        workspaceDir,
        onRename: () => startRename(),
        onPin: () =>
          void runAction(
            t(session.pinned ? "sessionMenu.unpin" : "sessionMenu.pin"),
            api.pinSession(session.id, !session.pinned),
          ).then(onChanged),
        onArchive: () =>
          void runAction(t("sessionMenu.archive"), api.archiveSession(session.id)).then(onChanged),
        onFork: () => setForkOpen(true),
        onDelete: () =>
          void runAction(t("sidebar.delete"), api.deleteSession(session.id)).then(onChanged),
        t,
      }),
    });
  };
  // The engine status is the source for every row, but the active session's is
  // also on the wire live: `running.active` arrives over SSE the moment a turn
  // starts. Reading it here is what makes the marquee immediate rather than up
  // to a cache lifetime late.
  const liveRunning = active && (state?.running?.active ?? false);
  const stateMark = SESSION_STATE_MARK[session.status];
  const hasChildren = session.children.length > 0;
  const onOpen = useCallback(() => {
    openSessionAndReportLanding(session.id, onChanged, t);
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
  //
  // The draft is cleared only AFTER the write resolves, and only on success. It
  // used to be cleared first, which meant a failed rename (offline, 4xx, a
  // declined `session.rename` authorization) unmounted the input and left the
  // user with no trace of what they had typed and no way to retry it.
  //
  // `reportActionError` rather than `runAction`, because this call site has to
  // know whether the write succeeded: `runAction` reports and returns
  // `undefined`, which is indistinguishable from a successful rename whose own
  // value happens to be `undefined`.
  const commitRename = useCallback(async () => {
    if (settled.current) return;
    settled.current = true;
    const next = (draft ?? "").trim();
    // Nothing to write: close the editor, and keep the short-circuit ahead of
    // any await so an unchanged title never becomes a request.
    if (!next || next === (session.title || "")) {
      setDraft(null);
      return;
    }
    try {
      await api.renameSession(session.id, next);
      setDraft(null);
      onChanged();
    } catch (cause) {
      // Keep the input mounted with the typed text so it can be retried or
      // copied out. Re-arm the latch so a second Enter/blur tries again.
      reportActionError(t("sidebar.rename"), cause);
      settled.current = false;
    }
  }, [draft, session.id, session.title, onChanged, t]);

  // Row geometry. `pl-2` lives on the OUTER container, not on the row, so
  // that the disclosure — now a sibling of the row rather than a child of
  // it — keeps the same left inset it had while nested.
  // webui-parity 47 (S1): the selected row uses `tertiary_selected`, not the
  // hover fill. The two sharing a token made "which session am I in"
  // invisible — hovering any row painted it exactly like the active one.
  const rowSurface = [
    "w-full flex items-center gap-2 pl-2 pr-0.5 h-[30px] transition-colors rounded-lg",
    active
      ? "bg-bg_interaction_tertiary_selected text-text_default_primary"
      : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover",
  ].join(" ");

  // The disclosure is a `<button>` SIBLING of the row, not a child of it: an
  // interactive element cannot nest inside another one (the row itself is an
  // `<a>` since webui-parity 47), and nesting would put two tab stops inside
  // one control, giving assistive tech and keyboard users an ambiguous
  // target.
  const caretToggle = hasChildren ? (
    <button
      type="button"
      aria-label={t("sidebar.subagents")}
      aria-expanded={open}
      data-testid="sidebar-session-subagents-toggle"
      onClick={(event) => {
        event.stopPropagation();
        onToggle(session.id);
      }}
      className="flex-shrink-0 flex items-center justify-center text-icon_default_tertiary"
    >
      <Icon
        name="caretDown"
        size={12}
        className={open ? "transition-transform" : "-rotate-90 transition-transform"}
      />
    </button>
  ) : null;

  const rowBody = (
          <div className="min-w-0 flex-1 text-left transition-all mr-2 group-hover/row:mr-[90px] group-focus-within/row:mr-[90px]">
            <div className="flex items-center gap-2">
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
      <div
        className="group/row relative rounded-lg"
        onContextMenu={renaming ? undefined : openSessionMenu}
      >
        {renaming ? (
          /* Editing swaps the element: a `<button>` must not contain an
             `<input>`, and it would swallow the keystrokes. The disclosure is
             withheld while editing — collapsing the list out from under an
             open editor is not something the user asked for. */
          <div data-testid="sidebar-session-row" className={rowSurface}>
            {rowBody}
          </div>
        ) : (
          <div className={rowSurface}>
            {caretToggle}
            {/* webui-parity 47 (S8): the row is an `<a>` whose href carries
                the app's own deep-link grammar (`?session=<id>`, see
                lib/url-restore.ts — NOT the reference's `#session=` fragment:
                the restore pipeline is keyed on the query string, and a
                second grammar would fight the live "reopen where I was"
                flow). A plain left click is intercepted and routed through
                the same switchSession call as before; modified clicks
                (middle / cmd / ctrl / shift) fall through to the browser, so
                "open in new tab" lands on a URL the cold-load path already
                knows how to restore. */}
            <a
              href={sessionHref(session.id)}
              onClick={(event) => {
                if (
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                onOpen();
              }}
              data-shortcut-session-target={session.id}
              data-testid="sidebar-session-row"
              className="min-w-0 flex-1 flex items-center rounded-lg text-left text-inherit no-underline"
            >
              {rowBody}
            </a>
          </div>
        )}

        {renaming ? null : (
        /* webui-parity 63 (defect ② / D5): the tray is 90px of the row's
           ~197px width, absolutely positioned and z-raised, so while it was
           shown it swallowed every click in the row's right half — a click
           meant to open the session landed on export / rename / delete, and
           delete really did delete the session (audit seq 72534-72539). The
           tray is `pointer-events-none`; the three controls below switch it
           back on individually, so the row keeps the rest of its hit area and
           the native `download` semantics survive (an `onClick
           preventDefault` "fix" would have turned a mis-click into a dead
           click and dropped save-as / copy-link). Same idiom as the project
           header's action slot. */
        <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 z-[1]">
          <div className="hidden h-[30px] w-[90px] items-center group-hover/row:flex group-focus-within/row:flex">
            <a
              href={api.sessionExportUrl(session.id)}
              download
              aria-label={t("sidebar.export")}
              title={t("sidebar.export")}
              className="pointer-events-auto flex h-[30px] w-[30px] items-center justify-center rounded text-icon_default_tertiary transition-colors hover:text-icon_default_secondary"
            >
              <Icon name="download" size={14} />
            </a>
            <RowAction
              label={t("sidebar.rename")}
              onClick={startRename}
              className="pointer-events-auto"
            >
              {/* Upstream's rename affordance is this glyph, not an icon-pack path. */}
              <span aria-hidden className="text-[13px] leading-none">
                ✎
              </span>
            </RowAction>
            <RowAction
              label={t("sidebar.delete")}
              className="pointer-events-auto"
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

      {hasChildren ? (
        <Expandable open={open}>
          {session.children.map((child) => (
            <SubagentRow
              key={child.id}
              session={child}
              active={child.id === activeId}
              onChanged={onChanged}
              workspaceDir={workspaceDir}
              t={t}
            />
          ))}
        </Expandable>
      ) : null}
      {contextMenu ? (
        <WebuiContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(undefined)}
        />
      ) : null}
      {/* PB-1. `onForked` re-reads the tree so the new row appears, then
          switches to it: a duplicate the user cannot navigate to is a
          duplicate they have to go find, and the switch is the same path
          every other row-open takes. */}
      <SessionForkDialog
        sessionId={session.id}
        open={forkOpen}
        onCancel={() => setForkOpen(false)}
        onForked={(newSessionId) => {
          onChanged();
          void openSessionAndReportLanding(newSessionId, onChanged, t);
        }}
        t={t}
      />
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
  workspaceDir,
  t,
}: {
  session: api.TreeSession;
  active: boolean;
  onChanged: () => void;
  /** The parent session's directory — feeds the row's copy menu item. */
  workspaceDir?: string;
  t: (key: MessageKey) => string;
}) {
  const onOpen = useCallback(() => {
    openSessionAndReportLanding(session.id, onChanged, t);
  }, [session.id, onChanged, t]);

  // webui-parity 58 (line B): the child (subagent) row carries the same
  // right-click menu as its parent — the reference's `openSessionMenu` is
  // bound to child rows too. Rename stays disabled here: the child row has
  // no inline editor to swap into (its rename contract would need the same
  // edit affordance the main row has). PB-1's 置顶 / 归档 / 复制为新会话 are
  // NOT in that category and are wired below — see `openChildMenu`.
  const [contextMenu, setContextMenu] = useState<
    | { readonly x: number; readonly y: number; readonly items: readonly WebuiContextMenuItem[] }
    | undefined
  >();
  // PB-1: the child's own copy of the fork dialog, for the same reason
  // `SessionNode` holds one.
  const [forkOpen, setForkOpen] = useState(false);
  const openChildMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: buildSessionContextMenu({
        session,
        workspaceDir,
        // PB-1: the child row gets the same three actions as its parent,
        // and the reason it can is that all three are keyed on the
        // session id alone — the child row carries a real `mvs_` id, the
        // engine's archive/pin/fork methods take no parent/child notion,
        // and none of them needs an inline editor the way 重命名 does.
        // Leaving them off would produce two menus with the same items
        // that behave differently depending on which row was clicked,
        // which is the kind of difference a user discovers by accident.
        onPin: () =>
          void runAction(
            t(session.pinned ? "sessionMenu.unpin" : "sessionMenu.pin"),
            api.pinSession(session.id, !session.pinned),
          ).then(onChanged),
        onArchive: () =>
          void runAction(t("sessionMenu.archive"), api.archiveSession(session.id)).then(onChanged),
        onFork: () => setForkOpen(true),
        onDelete: () =>
          void runAction(t("sidebar.delete"), api.deleteSession(session.id)).then(onChanged),
        t,
      }),
    });
  };

  // webui-parity 47 (S1 + S8): same selected token and same `<a>` deep-link
  // treatment as the parent session row — see SessionNode's row markup.
  return (
    <>
    <a
      href={sessionHref(session.id)}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onOpen();
      }}
      title={session.title || t(UNTITLED)}
      data-testid="sidebar-subagent-row"
      data-agent={session.agent}
      onContextMenu={openChildMenu}
      className={[
        "w-full flex items-center gap-2 pl-8 pr-2 h-[26px] text-left transition-colors rounded-lg text-inherit no-underline",
        active
          ? "bg-bg_interaction_tertiary_selected text-text_default_primary"
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
    </a>
      {contextMenu ? (
        <WebuiContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(undefined)}
        />
      ) : null}
      <SessionForkDialog
        sessionId={session.id}
        open={forkOpen}
        onCancel={() => setForkOpen(false)}
        onForked={(newSessionId) => {
          onChanged();
          void openSessionAndReportLanding(newSessionId, onChanged, t);
        }}
        t={t}
      />
    </>
  );
}
