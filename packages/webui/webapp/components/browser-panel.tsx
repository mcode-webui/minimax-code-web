"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Locale, MessageKey } from "@/lib/i18n";
import { Icon } from "@/components/icons";
import {
  buildSandboxUrl,
  backHistory,
  canGoBack,
  canGoForward,
  coerceAddress,
  createHistory,
  currentPath,
  forwardHistory,
  iframeKey,
  IFRAME_SANDBOX,
  isHtmlPath,
  pushHistory,
  type BrowserHistory,
  type CoercedAddress,
} from "@/lib/browser-nav";
import { tBrowser } from "@/lib/i18n-browser";

/**
 * Built-in browser panel (slice 04 of the webui-parity program).
 *
 * A sandboxed iframe that previews a workspace-local HTML page over
 * `/api/fs/raw?path=…`. The address bar accepts workspace-relative
 * paths ONLY — `coerceAddress()` rejects any `http(s)://` /
 * `file://` / other scheme input BEFORE the path ever reaches the
 * iframe. The iframe's `sandbox` attribute is the minimal
 * `allow-scripts` set (see `lib/browser-nav.ts#IFRAME_SANDBOX`),
 * which deliberately omits `allow-same-origin` to keep the
 * previewed page from reaching the app's cookies / session storage
 * and `allow-top-navigation` to keep a malicious preview from
 * replacing the host document.
 *
 * Acceptance — what the ticket pins:
 *   1. The iframe `sandbox` attribute string is exactly `allow-scripts`
 *      (pinned by `browser-nav.test.ts`).
 *   2. A path outside the allowed roots is refused by `/api/fs/raw`
 *      (pinned by `routes/fs-raw.test.js`, which already lands).
 *   3. An absolute URL or `file://` target cannot be navigated to
 *      (pinned by `browser-nav.test.ts` — `coerceAddress` returns
 *      `{ok:false, reason:"absolute"}`).
 *
 * Wiring-slice (04b) note: the panel was deliberately left unmounted
 * in slice 04 because `components/panels.tsx` was owned by slice 03.
 * slice 03 has merged, so this follow-up slice mounts the panel and
 * fixes the two functional defects the acceptance surfaced:
 *
 *   F1 — The controlled-sync effect unconditionally rebuilt the
 *        back/forward history stack on EVERY `controlledPath` change.
 *        Under the natural round-trip wiring
 *        (`onNavigate` → parent state → `currentPath` prop), the
 *        Go button pushed once and then the effect wiped the back
 *        stack (back never enabled); under decoupled wiring (parent
 *        stores `controlledPath` separately) the address-bar draft
 *        went stale after back. The fix below distinguishes an
 *        echo of the panel's own navigation (keep the stack) from
 *        an external change (file-tree click → re-seed the stack).
 *
 *   F2 — The address bar accepted workspace-relative paths but the
 *        `buildSandboxUrl` builder emitted them verbatim to the
 *        wire (`/api/fs/raw?path=public%2Findex.html`). The server
 *        route resolves a relative `path` against its OWN CWD, which
 *        is almost never an allowed root, so a workspace-relative
 *        entry landed on a 403 / ENOENT instead of an iframe render.
 *        Absolute in-root paths worked; everything else did not. The
 *        component now carries a real `workspaceDir` prop and a new
 *        helper in `lib/browser-nav.ts#resolveWorkspacePath`
 *        stitches the two halves BEFORE building the URL.
 *
 * The panel is still controlled — `currentPath`/`onNavigate` are the
 * parent-facing surface, mirroring the slice-02 preview pane —
 * because the parent owns the active panel and renders the
 * toolbar launcher. Two funnels feed it now: the address-bar Go
 * button (this file, internal) and the file-tree's HTML row
 * (`components/panels.tsx#FileRow`, external via the page-level
 * `onOpenInBrowser` callback). The same `currentPath` prop drives
 * both.
 */

export interface BrowserPanelProps {
  /** Active locale, used to resolve bilingual strings. */
  locale: Locale;
  /**
   * Project-relative translator — same shape as the rest of the
   * panels. The component itself only reads slice-04 keys via
   * `tBrowser()`; `t` is exposed mainly so the wiring surface
   * (toolbar / settings modal that escalates to the panel) keeps
   * the same prop shape.
   */
  t: (key: MessageKey) => string;
  /**
   * Currently-open path (workspace-relative). `null` renders the
   * empty state. The wiring slice owns this state — the component
   * is controlled, mirroring the slice-02 preview pane.
   */
  currentPath: string | null;
  /**
   * Absolute path of the active workspace. The component resolves
   * workspace-relative entries against this directory BEFORE
   * constructing the iframe src; absolute in-root paths flow
   * through unchanged. Pass `""` when no workspace is active —
   * the empty state has no iframe, so the unresolved path cannot
   * reach the wire.
   */
  workspaceDir?: string;
  /** Called when the user picks a path in the address bar. */
  onNavigate: (path: string) => void;
}

export function BrowserPanel({
  locale,
  t,
  currentPath: controlledPath,
  workspaceDir = "",
  onNavigate,
}: BrowserPanelProps) {
  // Per-panel history stack — see `lib/browser-nav.ts#createHistory`
  // for the rationale (independent from the document history).
  const [history, setHistory] = useState<BrowserHistory>(() => createHistory(controlledPath));
  const [draft, setDraft] = useState<string>(controlledPath ?? "");
  const [refreshNonce, setRefreshNonce] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  // Sync the controlled prop into local state.
  //
  // The controlled-and-acks-the-parent shape can mean two different
  // things on every `controlledPath` change:
  //
  //   (a) ECHO — the parent updated `controlledPath` because WE
  //       pushed (Go / Back / Forward). The internal history already
  //       carries the new entry, so re-seeding it from scratch would
  //       silently drop every back stack the user had built.
  //
  //   (b) EXTERNAL — the parent updated `controlledPath` because an
  //       outside action pointed at a new file (a file-tree HTML
  //       click, an open-file event from chat). The internal history
  //       does NOT carry this entry yet; we must re-seed.
  //
  // We disambiguate by comparing the new `controlledPath` to the
  // internal `currentPath(history)`. If they match, the change is
  // an echo of our own navigation — keep the stack and only sync the
  // address-bar draft + clear stale errors. If they differ, treat the
  // change as external and re-seed the stack with the new path on top
  // of it (the same shape `useState` would have produced on a first
  // mount). The functional `setHistory` updater returns `prev`
  // unchanged on echo, so React skips a re-render for the stack itself.
  //
  // We deliberately do NOT bump the `refreshNonce` on echo — the
  // iframe `src` is already pointed at the new path (it comes from
  // `currentPath(history)` and changes via the key on `iframeKey`),
  // and a refresh now would discard the just-loaded document mid-render.
  useEffect(() => {
    const controlled = controlledPath ?? null;
    setHistory((prev) => {
      if (controlled === currentPath(prev)) return prev;
      return createHistory(controlledPath);
    });
    // The address bar must mirror the controlled path even on echo
    // (back/forward from the panel buttons drives `controlledPath` via
    // the same `onNavigate` callback the user types into). Sync
    // unconditionally — it's cheap and matches what the user sees.
    setDraft(controlledPath ?? "");
    // Errors only apply to the navigation that produced them; a
    // brand-new navigation (echo or external) wipes the error so it
    // cannot outlive the input that caused it. The same controlledPath
    // arriving twice (e.g. parent re-renders) hits the echo branch
    // above and the `setError(null)` here is a no-op visually.
    setError(null);
  }, [controlledPath]);

  // The address bar's "go" handler — validates the draft, refuses
  // any non-path input, and pushes a new history entry on success.
  const submit = useCallback(() => {
    const coerced: CoercedAddress = coerceAddress(draft);
    if (!coerced.ok) {
      if (coerced.reason === "empty") return; // empty draft is a no-op
      setError(errorMessageFor(coerced.reason, locale));
      return;
    }
    if (!isHtmlPath(coerced.path)) {
      setError(tBrowser(locale, "browser.error.notHtml"));
      return;
    }
    setError(null);
    setHistory((prev) => pushHistory(prev, coerced.path));
    onNavigate(coerced.path);
  }, [draft, onNavigate, locale]);

  // Back / forward — purely internal state transitions; the resulting
  // current path is forwarded to the parent so the address bar
  // drafts match what the iframe renders. Refresh is a remount of the
  // iframe via a nonce bump — no URL change needed.
  const goBack = useCallback(() => {
    setHistory((prev) => {
      const next = backHistory(prev);
      const nextPath = currentPath(next);
      // Skip the `onNavigate` round-trip when the back-step is a no-op
      // (`backHistory` is idempotent at the bottom). Surfacing a stale
      // echo of the same controlledPath would re-fire the sync effect
      // needlessly — and could trip a future regression that bumps
      // refreshNonce on echo.
      if (nextPath && nextPath !== currentPath(prev)) onNavigate(nextPath);
      return next;
    });
  }, [onNavigate]);

  const goForward = useCallback(() => {
    setHistory((prev) => {
      const next = forwardHistory(prev);
      const nextPath = currentPath(next);
      if (nextPath && nextPath !== currentPath(prev)) onNavigate(nextPath);
      return next;
    });
  }, [onNavigate]);

  const refresh = useCallback(() => {
    // Refresh is just a remount — bumping the nonce forces React to
    // throw the iframe away and create a fresh DOM node, which
    // discards the previewed page's window-level state. No URL
    // change is needed: same src, fresh document.
    setRefreshNonce((value) => value + 1);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      } else if (event.key === "Escape") {
        // Reset the draft to the currently-open path so a stray
        // escape does not lose the user's selection.
        setDraft(controlledPath ?? "");
      }
    },
    [submit, controlledPath],
  );

  const path = currentPath(history);
  const back = canGoBack(history);
  const forward = canGoForward(history);
  // Workspace-relative entries are pre-resolved against `workspaceDir`
  // inside `buildSandboxUrl` (see lib/browser-nav.ts#resolveWorkspacePath)
  // so the server-side `/api/fs/raw` sees an absolute in-root path and
  // its containment gate lets it through. Absolute entries flow through
  // unchanged.
  const url = useMemo(
    () => (path ? buildSandboxUrl(path, workspaceDir) : null),
    [path, workspaceDir],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2"
      data-testid="browser-panel"
      data-sandbox={IFRAME_SANDBOX}
      data-path={path ?? ""}
    >
      <header className="flex min-w-0 items-center gap-2">
        <span className="flex size-4 flex-none items-center justify-center text-icon_default_tertiary" aria-hidden>
          <Icon name="browserGlobe" size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text_default_primary">
          {tBrowser(locale, "browser.title")}
        </span>
      </header>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={goBack}
          disabled={!back}
          aria-label={tBrowser(locale, "browser.backAria")}
          title={tBrowser(locale, "browser.back")}
          data-testid="browser-panel-back"
          className={[
            "flex size-7 flex-none items-center justify-center rounded-[8px] transition-colors",
            back
              ? "text-icon_default_tertiary hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
              : "cursor-not-allowed text-icon_default_quaternary",
          ].join(" ")}
        >
          <Icon name="reply" size={14} className="rotate-180" />
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={!forward}
          aria-label={tBrowser(locale, "browser.forwardAria")}
          title={tBrowser(locale, "browser.forward")}
          data-testid="browser-panel-forward"
          className={[
            "flex size-7 flex-none items-center justify-center rounded-[8px] transition-colors",
            forward
              ? "text-icon_default_tertiary hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
              : "cursor-not-allowed text-icon_default_quaternary",
          ].join(" ")}
        >
          <Icon name="reply" size={14} />
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={!path}
          aria-label={tBrowser(locale, "browser.refreshAria")}
          title={tBrowser(locale, "browser.refresh")}
          data-testid="browser-panel-refresh"
          className={[
            "flex size-7 flex-none items-center justify-center rounded-[8px] transition-colors",
            path
              ? "text-icon_default_tertiary hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
              : "cursor-not-allowed text-icon_default_quaternary",
          ].join(" ")}
        >
          <Icon name="refresh" size={14} />
        </button>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={tBrowser(locale, "browser.addressPlaceholder")}
          aria-label={tBrowser(locale, "browser.addressAria")}
          data-testid="browser-panel-address"
          className="mavis-input min-w-0 flex-1"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={submit}
          disabled={draft.trim().length === 0}
          aria-label={tBrowser(locale, "browser.goAria")}
          title={tBrowser(locale, "browser.go")}
          data-testid="browser-panel-go"
          className={[
            "flex h-7 flex-none items-center rounded-[8px] px-2 text-caption-small-strong transition-colors",
            draft.trim().length === 0
              ? "cursor-not-allowed text-text_default_quaternary"
              : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover",
          ].join(" ")}
        >
          {tBrowser(locale, "browser.go")}
        </button>
      </div>

      {error ? (
        <p
          className="rounded-[8px] border border-border_default bg-bg_grouped_secondary_elevated px-2 py-1 text-caption-small-strong text-text_status_error"
          data-testid="browser-panel-error"
        >
          {error}
        </p>
      ) : null}

      <div
        className="flex min-h-[240px] flex-1 overflow-hidden rounded-[8px] border border-border_default bg-bg_default_scrim"
        data-testid="browser-panel-body"
      >
        {path && url ? (
          <iframe
            key={iframeKey(path, refreshNonce)}
            src={url}
            title={tBrowser(locale, "browser.title")}
            sandbox={IFRAME_SANDBOX}
            data-testid="browser-panel-iframe"
            data-src={url}
            data-path={path}
            className="h-full w-full border-none bg-bg_default_primary"
          />
        ) : (
          <div
            className="flex h-full w-full flex-col items-center justify-center gap-1 px-4 py-8 text-center"
            data-testid="browser-panel-empty"
          >
            <span className="text-sm font-medium text-text_default_primary">
              {tBrowser(locale, "browser.empty.title")}
            </span>
            <span className="text-caption-small-strong text-text_default_tertiary">
              {tBrowser(locale, "browser.empty.body")}
            </span>
          </div>
        )}
      </div>

      {/* The translator prop is exposed in the public type so the
         wiring slice can pass a thin wrapper if it wants to; the
         browser panel itself only reads keys through tBrowser so
         the wrapper is optional. */}
      <span data-testid="browser-panel-translator" hidden>{typeof t === "function" ? "ok" : "missing"}</span>
    </div>
  );
}

/**
 * Map a `coerceAddress` rejection reason to the bilingual copy.
 *
 * Kept as a free function (not inline in the component) so the
 * "missing translation" fallback is in one place — when the key
 * resolves to the raw key name, the user sees the key in the UI,
 * not an empty bar.
 */
function errorMessageFor(reason: "absolute" | "empty" | "not-a-path", locale: Locale): string {
  if (reason === "absolute") return tBrowser(locale, "browser.error.absolute");
  if (reason === "not-a-path") return tBrowser(locale, "browser.error.unknown").replace("{{error}}", "not a path");
  return tBrowser(locale, "browser.error.unknown").replace("{{error}}", "");
}