// webapp/lib/fs-tree-reveal.tsx
//
// Reveal-in-tree bridge between the sidebar 搜索 surface and the
// file-tree panel (webui-parity slice 19b follow-up).
//
// The sidebar's search surface (`workspace-tree-column.tsx#
// SearchSurface`) and the file-tree's filter box (`panels.tsx#
// FilesPanel`) both consume the same `/api/fs/search` endpoint.
// When the user clicks a hit in the sidebar the file must (1)
// open in the preview column and (2) make the tree panel
// expand-to-hit so the user can SEE where the match landed —
// the panel's expand-to-hit effect runs on its own server search,
// but the sidebar's click path had no equivalent.
//
// This module is a tiny React context that lets the sidebar
// surface request a reveal from the file-tree panel without
// lifting reveal logic into the page. The panel subscribes via
// `useFsTreeReveal()` and applies the request the same way it
// applies its own server-search results:
//
//   - union the requested ancestor paths into its `expanded` set,
//   - lazy-fetch each path,
//   - mark every match path as highlighted for 4 seconds.
//
// The sidebar calls `requestReveal({ matches, root })` and then
// switches to the files surface via its existing `onPickSurface`
// callback. Order matters: switching first, then letting the
// effect drain, makes the expand-to-hit animation visible.
//
// Why a context, not an imperative ref. FilesPanel is rendered
// inside the tree column's slot machinery (`TreeColumn`), so the
// sidebar has no direct parent ref to it. A shared context is the
// smallest wiring that keeps both components decoupled from the
// page. The provider lives in `workspace-tree-column.tsx` (one
// level above both consumers); the hook is `useFsTreeReveal()`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

import type { FsSearchMatch } from "./api";

export interface FsTreeRevealRequest {
  /**
   * The matches to expand-to-hit. Each match's `ancestors` chain
   * is walked; the absolute paths are added to the tree's expanded
   * set and the match paths themselves are added to the highlight
   * set.
   */
  matches: FsSearchMatch[];
  /**
   * The search root (workspace dir). The context does not need
   * it for its own bookkeeping, but consumers can use it to
   * ignore stale requests when the user switches workspaces.
   */
  root: string;
}

interface FsTreeRevealApi {
  /**
   * File-tree panel: subscribe to reveal requests. The callback
   * fires once per `requestReveal()` call (NOT on every render),
   * so the panel can apply the request inside its existing
   * `setExpanded` + `setHighlightedPaths` flow without needing a
   * re-render trigger.
   */
  subscribe: (cb: (req: FsTreeRevealRequest) => void) => () => void;
  /**
   * Sidebar surface: enqueue a reveal request. Fires immediately
   * for any subscriber that is currently mounted; if no panel is
   * mounted yet (the user clicks before the file surface
   * activates), the request is dropped — the user is expected
   * to switch surface first via `onPickSurface("files")`.
   */
  requestReveal: (req: FsTreeRevealRequest) => void;
}

const FsTreeRevealContext = createContext<FsTreeRevealApi | null>(null);

/**
 * Provider for the cross-surface reveal channel. Wrap a subtree
 * that contains both the sidebar search surface and the file-tree
 * panel. Single-instance; nesting is harmless but unnecessary.
 *
 * BUFFERING. The sidebar 搜索 → click flow fires the reveal
 * request BEFORE switching to the files surface, because the
 * files panel is the subscriber and is not yet mounted when the
 * click fires. Without a buffer the request is dropped, and the
 * tree would not expand-to-hit on the click path. The provider
 * therefore keeps the latest request in a ref and replays it to
 * any subscriber that mounts within `REPLAY_WINDOW_MS`. After
 * that window the request is stale (the user could have clicked
 * again, or moved on) and the buffer is dropped.
 *
 * One request at a time: a fresh click replaces the buffered
 * one. The semantics are "the last click wins" — exactly what
 * a user would expect if they clicked hit A, hit B, and the
 * panel mounted between them.
 */
const REPLAY_WINDOW_MS = 500;

export function FsTreeRevealProvider({ children }: { children: ReactNode }) {
  const subscribersRef = useRef<Set<(req: FsTreeRevealRequest) => void>>(new Set());
  const pendingRef = useRef<{ req: FsTreeRevealRequest; expiresAt: number } | null>(null);
  const pendingTimerRef = useRef<number | null>(null);

  const firePending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (pending && pending.expiresAt > Date.now()) {
      for (const cb of subscribersRef.current) cb(pending.req);
    }
  }, []);

  const subscribe = useCallback(
    (cb: (req: FsTreeRevealRequest) => void) => {
      subscribersRef.current.add(cb);
      // Drain the buffer immediately on subscribe — the panel
      // just mounted and is ready to handle the request now.
      if (pendingRef.current) firePending();
      return () => {
        subscribersRef.current.delete(cb);
      };
    },
    [firePending],
  );

  const requestReveal = useCallback(
    (req: FsTreeRevealRequest) => {
      pendingRef.current = { req, expiresAt: Date.now() + REPLAY_WINDOW_MS };
      if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = window.setTimeout(() => {
        pendingRef.current = null;
        pendingTimerRef.current = null;
      }, REPLAY_WINDOW_MS);
      // Fast path: a subscriber is already mounted (e.g. the
      // panel is already active), so fire immediately. The
      // buffer is cleared because the request is no longer
      // pending.
      if (subscribersRef.current.size > 0) {
        firePending();
      }
    },
    [firePending],
  );

  const api: FsTreeRevealApi = { subscribe, requestReveal };
  return (
    <FsTreeRevealContext.Provider value={api}>
      {children}
    </FsTreeRevealContext.Provider>
  );
}

/**
 * Sidebar hook — returns a stable function that enqueues a
 * reveal request. Cheap to call; only fires listeners when there
 * is a subscriber (the panel mounted).
 */
export function useFsTreeReveal(): {
  requestReveal: (req: FsTreeRevealRequest) => void;
} {
  const ctx = useContext(FsTreeRevealContext);
  // The provider is always mounted at the tree column root; if a
  // caller forgets to wrap, fall back to a no-op so the page
  // does not crash (a forgotten wrap is a developer mistake, not
  // a user-facing error).
  if (!ctx) return { requestReveal: () => undefined };
  return { requestReveal: ctx.requestReveal };
}

/**
 * Panel hook — subscribes to reveal requests and dispatches each
 * one to the supplied handler. The subscription is cleaned up on
 * unmount; multiple panels (e.g. main + preview) can subscribe
 * safely because each call fires all subscribers.
 */
export function useFsTreeRevealSubscriber(
  handler: (req: FsTreeRevealRequest) => void,
) {
  const ctx = useContext(FsTreeRevealContext);
  // Stable reference to the latest handler so the subscribe
  // call does not need to re-subscribe on every render.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!ctx) return;
    const cb = (req: FsTreeRevealRequest) => handlerRef.current(req);
    return ctx.subscribe(cb);
  }, [ctx]);
}
