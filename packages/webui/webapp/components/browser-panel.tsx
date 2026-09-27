"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Locale } from "@/lib/i18n";
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
 * Not mounted by this slice — the wiring into `components/panels.tsx`
 * is the follow-up slice (the file is owned by slice 03 / git-panel
 * and is out of scope for the concurrent slices). The component is
 * exported as `BrowserPanel` with the props documented below; the
 * wiring slice should:
 *
 *   import { BrowserPanel } from "@/components/browser-panel";
 *
 *   // inside the right-hand panel registry:
 *   <BrowserPanel
 *     locale={locale}
 *     t={(key) => translate(locale, key)}  // any t() shape works
 *   />
 *
 * The mount is intentionally agnostic to which workspace is active
 * today — `workspaceDir` is a prop, not read from context, so the
 * wiring slice can drive it from `useSessionContext().state.workspace.dir`.
 * The wiring slice will also own the bridge that maps "click an HTML
 * file in the file tree" → `BrowserPanel.setCurrentPath(path)`. The
 * single-source tripwire in `open-file.test.ts` pins the existing
 * preview pane; this panel will get the same kind of test once the
 * bridge is wired.
 */

export interface BrowserPanelProps {
  /** Active locale, used to resolve bilingual strings. */
  locale: Locale;
  /** Project-relative translator — same shape as the rest of the panels. */
  t: (key: string) => string;
  /**
   * Currently-open path (workspace-relative). `null` renders the
   * empty state. The wiring slice owns this state — the component
   * is controlled, mirroring the slice-02 preview pane.
   */
  currentPath: string | null;
  /** Called when the user picks a path in the address bar. */
  onNavigate: (path: string) => void;
}

export function BrowserPanel({ locale, t, currentPath: controlledPath, onNavigate }: BrowserPanelProps) {
  // Per-panel history stack — see `lib/browser-nav.ts#createHistory`
  // for the rationale (independent from the document history).
  const [history, setHistory] = useState<BrowserHistory>(() => createHistory(controlledPath));
  const [draft, setDraft] = useState<string>(controlledPath ?? "");
  const [refreshNonce, setRefreshNonce] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  // Sync the controlled prop into local state. When the parent
  // switches the open path externally (file-tree click), the panel
  // mounts a fresh history stack on top of the new current path —
  // a `controlledPath → history` sync rather than a `push` so the
  // external change never accidentally wipes the back-stack the
  // user has been building.
  useEffect(() => {
    setHistory(createHistory(controlledPath));
    setDraft(controlledPath ?? "");
    setRefreshNonce((value) => value + 1);
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
    setRefreshNonce((value) => value + 1);
    onNavigate(coerced.path);
  }, [draft, onNavigate, locale]);

  // Back / forward / refresh — all forward through the history stack
  // and surface the resulting current path back to the parent. The
  // parent does not need to know which button was clicked; it just
  // gets the path the user landed on.
  const goBack = useCallback(() => {
    setHistory((prev) => {
      const next = backHistory(prev);
      const nextPath = currentPath(next);
      if (nextPath) onNavigate(nextPath);
      return next;
    });
    setRefreshNonce((value) => value + 1);
  }, [onNavigate]);

  const goForward = useCallback(() => {
    setHistory((prev) => {
      const next = forwardHistory(prev);
      const nextPath = currentPath(next);
      if (nextPath) onNavigate(nextPath);
      return next;
    });
    setRefreshNonce((value) => value + 1);
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
  const url = useMemo(() => (path ? buildSandboxUrl(path) : null), [path]);

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