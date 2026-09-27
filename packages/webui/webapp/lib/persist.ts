// webapp/lib/persist.ts
//
// Client-side persistence for re-open state parity (webui-parity 07).
//
// Three responsibilities, every one of which has to land *before* first
// paint so a refresh restores the user to the same place they left
// (刷新后不被丢回首页):
//
//   1. **UI state** — active session, right-panel open/closed + the
//      currently-selected tab, sidebar collapsed/expanded. Stored under
//      one key per cid so two tabs/windows don't cross-talk. The key
//      follows the same `webui:<feature>:<guard>` shape slice 01
//      established for the file tree (see webapp/lib/files-tree.ts: the
//      sessionStorage key is `webui:files-tree:<workspaceDir>` with a
//      versioned payload), but is namespaced per cid in `localStorage`
//      because two cids can each hold an active session, while a single
//      cid on two workspaces should NOT carry a stale panel choice.
//
//   2. **Transcript scroll position** — one entry per `(cid, sessionId)`
//      under `webui:scroll:v1:<cid>:<sessionId>`. The chat virtual
//      window already has the live `scrollTop`; we only need to store
//      the px. Per-session keys are deliberate: the user opens and
//      closes sessions with very different conversation lengths, and
//      "remember the position per conversation" is the contract.
//
//   3. **Files-tree slice** — *not ours*. Slice 01 owns the wire
//      format in `lib/files-tree.ts` and the sessionStorage hydration
//      in `components/panels.tsx#FilesPanel`. This module never reads
//      or writes that key; we only share the prefix convention so the
//      dev-tools view shows one coherent namespace.
//
// All writes are best-effort + debounced. localStorage can throw
// (private mode, quota); a failed write leaves the in-memory state
// correct and the persistence silent — a hard crash that the
// `app/global-error.tsx` boundary later surfaces is the failure mode we
// care about, not a quota error here.
//
// Versioning: every payload carries a `version: 1` discriminator so
// future tickets can reject old payloads rather than silently
// interpreting them. New fields are additive (`?? defaults`) so the
// version stays stable across feature additions; bumping `version`
// forces a clean slate.

import { clientId } from "./cid";

/** Stable prefix used by every key in this namespace. Mirrors slice 01. */
export const PREFIX = "webui";

/** Bump when the payload shape changes incompatibly. */
export const UI_STATE_VERSION = 1;
/** Bump when the scroll-position entry shape changes incompatibly. */
export const SCROLL_VERSION = 1;

/** Right-panel kinds. Mirrors `components/panels.tsx#PanelKind`. */
export type PanelKind = "workspace" | "files" | "git" | "alerts" | "search" | "progress" | "plugins";

export interface UiState {
  panel: PanelKind | null;
  /** Reserved for future tabs inside the right panel; kept so a
   *  promotion to "panels have inner tabs" does not need a key bump. */
  panelTab: string | null;
  /** Sidebar collapsed/expanded. Owned by `components/shell.tsx`. */
  sidebarCollapsed: boolean;
  /** Last-active session id. Used as the seed when the URL has no
   *  `?session=` but the SSE snapshot has not yet arrived. The server
   *  state always wins once SSE arrives — this is only a hint for the
   *  brief loading window. */
  lastSessionId: string | null;
}

export const DEFAULT_UI_STATE: UiState = {
  panel: null,
  panelTab: null,
  sidebarCollapsed: false,
  lastSessionId: null,
};

interface UiStatePayload {
  version: number;
  cid: string;
  state: UiState;
}

const UI_STATE_KEY_PREFIX = `${PREFIX}:ui:v${UI_STATE_VERSION}`;

/**
 * Build the localStorage key for this cid. Centralised here so a
 * future cid-naming tweak (e.g. HMAC of cid to avoid serving the raw
 * identifier to a console peek) lands in one place. Empty `cid` is
 * substituted with a literal `"anon"` to keep the key stable when
 * storage is unavailable — a missing key would otherwise be
 * indistinguishable from "fresh start".
 */
export function uiStateKey(cid: string | null | undefined): string {
  const safe = cid && cid.length > 0 ? cid : "anon";
  return `${UI_STATE_KEY_PREFIX}:${safe}`;
}

/** Read the persisted UI state for the current cid.
 *  Returns defaults on missing/bad input — never throws. */
export function readUiState(): UiState {
  if (typeof window === "undefined") return { ...DEFAULT_UI_STATE };
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(uiStateKey(clientId()));
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
  return deserializeUiState(raw, clientId());
}

/** Best-effort write, debounced. Coalesces a burst of updates so a
 *  panel-toggle + collapse + scroll move in the same tick all share
 *  one write. */
export function writeUiState(state: UiState): void {
  if (typeof window === "undefined") return;
  const cid = clientId();
  scheduleUiStateWrite(uiStateKey(cid), cid, state);
}

export function deserializeUiState(raw: string | null | undefined, cid: string | null | undefined): UiState {
  if (!raw) return { ...DEFAULT_UI_STATE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_UI_STATE };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== UI_STATE_VERSION) return { ...DEFAULT_UI_STATE };
  // Different cid — drop. The user switched cids (rare: a different
  // browser) and the previous session's panel choice should not bleed
  // into the new identity.
  if (typeof cid === "string" && cid.length > 0 && typeof obj.cid === "string" && obj.cid !== cid) {
    return { ...DEFAULT_UI_STATE };
  }
  const s = obj.state;
  if (!s || typeof s !== "object") return { ...DEFAULT_UI_STATE };
  const so = s as Record<string, unknown>;
  const validKinds: ReadonlySet<PanelKind> = new Set(["workspace", "files", "git", "alerts", "search", "progress", "plugins"]);
  const panel = typeof so.panel === "string" && validKinds.has(so.panel as PanelKind) ? (so.panel as PanelKind) : null;
  const panelTab = typeof so.panelTab === "string" ? (so.panelTab as string) : null;
  const sidebarCollapsed = so.sidebarCollapsed === true;
  const lastSessionId = typeof so.lastSessionId === "string" ? (so.lastSessionId as string) : null;
  return { panel, panelTab, sidebarCollapsed, lastSessionId };
}

// --- debounced writer ------------------------------------------------------

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingKey: string | null = null;
let pendingCid: string | null = null;
let pendingState: UiState | null = null;
const DEBOUNCE_MS = 150;

function scheduleUiStateWrite(key: string, cid: string, state: UiState): void {
  pendingKey = key;
  pendingCid = cid;
  pendingState = state;
  if (pendingTimer) return;
  const fire = () => {
    const k = pendingKey;
    const c = pendingCid;
    const s = pendingState;
    pendingTimer = null;
    pendingKey = null;
    pendingCid = null;
    pendingState = null;
    if (!k || !c || !s) return;
    try {
      const payload: UiStatePayload = { version: UI_STATE_VERSION, cid: c, state: s };
      window.localStorage.setItem(k, JSON.stringify(payload));
    } catch {
      // same best-effort contract as the reader
    }
  };
  pendingTimer = setTimeout(fire, DEBOUNCE_MS);
}

/** Test-only handle: flush the debounced writer immediately. */
export function __flushUiState(): void {
  if (!pendingTimer) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  const k = pendingKey;
  const c = pendingCid;
  const s = pendingState;
  pendingKey = null;
  pendingCid = null;
  pendingState = null;
  if (!k || !c || !s) return;
  try {
    const payload: UiStatePayload = { version: UI_STATE_VERSION, cid: c, state: s };
    window.localStorage.setItem(k, JSON.stringify(payload));
  } catch {
    /* */
  }
}

// --- transcript scroll position --------------------------------------------

interface ScrollEntryPayload {
  version: number;
  cid: string;
  sessionId: string;
  scrollTop: number;
  /** Wall-clock ms when the position was last persisted. Reserved
   *  for a future expiry policy; the renderer reads it only for
   *  diagnostics, never to gate the restore. */
  savedAt: number;
}

const SCROLL_KEY_PREFIX = `${PREFIX}:scroll:v${SCROLL_VERSION}`;

/** Per-(cid, sessionId) key. Mirrors slice 01's "per-workspace guard"
 *  discipline: each session gets its own entry so two sessions do not
 *  collide. */
export function scrollKey(cid: string | null | undefined, sessionId: string | null | undefined): string {
  const safeCid = cid && cid.length > 0 ? cid : "anon";
  const safeS = sessionId && sessionId.length > 0 ? sessionId : "anon";
  return `${SCROLL_KEY_PREFIX}:${safeCid}:${safeS}`;
}

export function readScrollPosition(sessionId: string | null | undefined): number {
  if (typeof window === "undefined" || !sessionId) return 0;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(scrollKey(clientId(), sessionId));
  } catch {
    return 0;
  }
  return deserializeScroll(raw, clientId(), sessionId);
}

export function writeScrollPosition(sessionId: string | null | undefined, scrollTop: number): void {
  if (typeof window === "undefined" || !sessionId) return;
  const cid = clientId();
  try {
    const payload: ScrollEntryPayload = {
      version: SCROLL_VERSION,
      cid,
      sessionId,
      scrollTop,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(scrollKey(cid, sessionId), JSON.stringify(payload));
  } catch {
    /* best-effort */
  }
}

export function deserializeScroll(
  raw: string | null | undefined,
  cid: string | null | undefined,
  sessionId: string | null | undefined,
): number {
  if (!raw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object") return 0;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== SCROLL_VERSION) return 0;
  if (typeof cid === "string" && cid.length > 0 && typeof obj.cid === "string" && obj.cid !== cid) return 0;
  if (typeof sessionId === "string" && sessionId.length > 0 && typeof obj.sessionId === "string" && obj.sessionId !== sessionId) return 0;
  const top = obj.scrollTop;
  return typeof top === "number" && Number.isFinite(top) && top >= 0 ? top : 0;
}

// --- sidebar collapsed (owned by components/shell.tsx) ----------------------

/**
 * Read the user's last collapsed choice for the sidebar. Lives here
 * rather than in shell.tsx so the persistence keyspace is defined in
 * one place — slice 01 established the convention of `webui:<feature>`
 * with version + cid guards, and shell.tsx touches the same payload
 * the rest of the page uses.
 *
 * Returns `false` (i.e. "expanded") on every fresh-install path so a
 * first-time user lands on the desktop's wide-viewport surface rather
 * than a hidden rail.
 */
export function readShellCollapsedFromPersistedState(): boolean {
  return readUiState().sidebarCollapsed;
}

/** Persist the sidebar collapsed choice. Coalesces via the same
 *  debounced writer `writeUiState` uses; we synthesise a full payload
 *  so a future reader sees the panel + lastSessionId fields
 *  intact. */
export function writePersistedShellCollapsed(collapsed: boolean): void {
  const current = readUiState();
  // Skip the no-op write so toggling on the same value the storage
  // already has does not bounce through the debounce.
  if (current.sidebarCollapsed === collapsed) return;
  writeUiState({ ...current, sidebarCollapsed: collapsed });
}
