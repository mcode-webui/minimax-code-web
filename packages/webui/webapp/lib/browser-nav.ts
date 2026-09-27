// webapp/lib/browser-nav.ts
//
// Pure logic for the built-in browser panel (slice 04).
//
// This module owns every security-sensitive decision the panel makes:
//   - the iframe `sandbox` token list (`IFRAME_SANDBOX`),
//   - the path→URL builder that funnels every text path through the
//     containment-gated `/api/fs/raw?path=…` route,
//   - the `coerceAddress` validator that REJECTS absolute URLs and
//     `file://` targets before they ever reach the iframe.
//
// Centralising these in a pure module (no React, no DOM) means the
// security tests in `webapp/test/browser-nav.test.ts` can pin them
// without spinning up a render harness, and the component file can
// stay focused on layout.

import { fsRawUrl } from "./api";

/**
 * Iframe sandbox token list (slice 04 — built-in browser).
 *
 * The threat model is "previewed page tries to reach the host app".
 * The tokens below are the minimal set that lets a static site render
 * while disabling every escape hatch:
 *
 *   - `allow-scripts`     ← JS in the preview runs (so a real static
 *     site with a build-step bundle works), but…
 *   - `allow-same-origin` is intentionally OMITTED. With it, the
 *     sandboxed iframe would be treated as same-origin with the
 *     app and its scripts could read the app's cookies / session
 *     storage / IndexedDB. The combination
 *     `allow-scripts + allow-same-origin` is the well-known
 *     "sandbox escape" — it is the single thing the panel refuses
 *     to allow.
 *   - `allow-top-navigation` is intentionally OMITTED. The iframe
 *     could otherwise replace the host document (a clickjacking
 *     primitive — a malicious page could redirect the user to a
 *     phishing surface on the same origin).
 *   - `allow-popups`      ← OMITTED. A popup from the sandboxed
 *     page would inherit the page's window.opener, which a
 *     carefully crafted preview could abuse to interact with the
 *     app's main window. The current desktop reference (pr-22)
 *     still permits popups for "open in new tab"; this slice
 *     deliberately tightens that — popups add no product value for
 *     a local preview surface and only widen the attack surface.
 *   - `allow-forms`       ← OMITTED. A form submit would target
 *     `_top` by default (replaced by the host doc before our
 *     no-top-nav took effect); and even with `_blank`, a form
 *     could leak the previewed page's state to an attacker
 *     URL via field values.
 *   - `allow-modals`      ← OMITTED. `alert()` from the sandboxed
 *     page could be scripted to interrupt the user mid-interaction.
 *   - `allow-pointer-lock`/etc. ← OMITTED. None are needed for a
 *     passive preview surface.
 *
 * If a future feature genuinely needs a wider sandbox (e.g. a
 * preview that hits a local API), it MUST revisit this constant in
 * the same commit — the test below pins the exact string and a
 * change that drops `allow-top-navigation-by-user-activation` or
 * similar is the kind of small, silent widening that has shipped
 * unnoticed on other products.
 */
export const IFRAME_SANDBOX =
  "allow-scripts";

/**
 * Schemes the address bar refuses to navigate to.
 *
 * The full validator is `coerceAddress` below — this constant is
 * kept exported so the security test can pin the rejection set
 * independently of the parsing logic.
 */
export const REJECTED_SCHEMES = ["http://", "https://", "file://"] as const;

/**
 * Result of validating a user-entered address.
 *
 * - `ok: true`  carries a `path` (a workspace-relative path string)
 *   that the caller hands to `buildSandboxUrl` to get the iframe src.
 * - `ok: false` carries a `reason` that maps 1:1 to a key in
 *   `lib/i18n-browser.ts` so the panel renders the right copy.
 */
export type CoercedAddress =
  | { ok: true; path: string }
  | { ok: false; reason: "absolute" | "empty" | "not-a-path" };

/**
 * Validate and normalise a user-entered address.
 *
 * Accepted shapes:
 *   - empty string  → { ok:false, reason:"empty" }  (the caller
 *     shows the empty-state helper, not an error)
 *   - workspace-relative path, e.g. `public/index.html` or
 *     `docs/welcome.html` — anything that does NOT carry a scheme
 *     prefix. Backslashes are normalised to forward slashes so a
 *     Windows clipboard paste does not bypass the gate.
 *
 * Rejected shapes:
 *   - `http(s)://…`           → reason:"absolute"
 *   - `file://…`              → reason:"absolute"
 *   - any other scheme-prefixed form (e.g. `javascript:`, `data:`)
 *     → reason:"absolute"   (it is impossible for the iframe to
 *     honour these anyway — the src is a same-origin relative URL
 *     to `/api/fs/raw` — but rejecting in code keeps the
 *     address-bar input shape consistent with what we render)
 *   - non-string input        → reason:"not-a-path"
 *
 * The panel calls this BEFORE calling `buildSandboxUrl`; the
 * acceptance criteria pin that an absolute URL typed into the
 * address bar is refused at the input layer, not silently turned
 * into a 404 by the iframe.
 */
export function coerceAddress(raw: string): CoercedAddress {
  if (typeof raw !== "string") return { ok: false, reason: "not-a-path" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  // Scheme-anchored check — case-insensitive, applied to the
  // trimmed input so whitespace before the scheme is not a bypass.
  const lowered = trimmed.toLowerCase();
  for (const scheme of REJECTED_SCHEMES) {
    if (lowered.startsWith(scheme)) {
      return { ok: false, reason: "absolute" };
    }
  }
  // Catch-all for any other scheme-looking prefix
  // (e.g. `javascript:`, `data:`, `vbscript:`).
  if (/^[a-z][a-z0-9+.\-]*:/i.test(trimmed)) {
    return { ok: false, reason: "absolute" };
  }
  // Path normalisation: backslashes → forward slashes, then strip a
  // single leading `./` (a common clipboard artifact). We deliberately
  // do NOT call `path.resolve` here — the server's containment gate is
  // the single source of truth for "is this path inside an allowed
  // root", and a `..` segment past the gate's resolution must be
  // rejected by the gate (it is, with a 403), not silently rewritten
  // here.
  const normalised = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  return { ok: true, path: normalised };
}

/**
 * Build the iframe `src` for a validated path.
 *
 * The iframe MUST always point at the containment-gated `/api/fs/raw`
 * route — never at a `file://` URL, never at a workspace raw path.
 * The server enforces the actual containment; the iframe src here
 * is the ONLY place this URL is constructed, so a grep for
 * `fsRawUrl` in the component is the tripwire that catches any
 * future "open in iframe via filesystem" regression.
 */
export function buildSandboxUrl(path: string): string {
  return fsRawUrl(path);
}

/**
 * Decide whether a path the server returned is HTML.
 *
 * The server's `/api/fs/raw` answers any regular file; the panel
 * uses a small extension allow-list so it does not silently try to
 * embed `application/octet-stream` (e.g. a user picks a binary by
 * mistake) or `.svg` (which would render fine but is not what the
 * ticket pins — built-in preview of "static sites", not "image
 * gallery").
 *
 * The check is deliberately path-based rather than mime-based:
 * the browser sandbox has no way to read the server's `Content-Type`
 * before loading the iframe, and the extension is the wire shape the
 * server uses to assign `text/html; charset=utf-8` (see
 * `server/routes/fs.js#RAW_CONTENT_TYPES`).
 */
const HTML_EXTS = new Set([".html", ".htm"]);
export function isHtmlPath(path: string): boolean {
  const lowered = path.toLowerCase();
  for (const ext of HTML_EXTS) {
    if (lowered.endsWith(ext)) return true;
  }
  return false;
}

/**
 * A tiny history stack the panel uses for back / forward.
 *
 * The stack is intentionally NOT the browser's real history
 * (`history.pushState`) — the panel lives in a different column from
 * the chat surface, and tying its navigation to the document's
 * history would mean `Alt+←` from the chat also moved the panel
 * backwards. The stack is owned by the panel's React state and
 * survives unmounts via a key the panel computes.
 *
 * The shape is `{ entries: path[]; index: number }` so the panel can
 * jump to `entries[index]` on every render without needing to mutate
 * the array. `push(path)` advances the index and drops any
 * "forward" entries — the same semantics as a browser history when
 * the user navigates after a `back`.
 */
export interface BrowserHistory {
  entries: string[];
  /** Index of the CURRENT entry. `entries[index]` is rendered. */
  index: number;
}

export function createHistory(initial: string | null = null): BrowserHistory {
  if (initial === null) return { entries: [], index: -1 };
  return { entries: [initial], index: 0 };
}

export function pushHistory(history: BrowserHistory, path: string): BrowserHistory {
  // Drop forward entries on a new push — the user has chosen to
  // navigate from a fork.
  const trimmed = history.entries.slice(0, history.index + 1);
  // De-dupe consecutive repeats so a click on "Go" twice does not
  // pollute the back stack.
  if (trimmed[trimmed.length - 1] === path) {
    return { entries: trimmed, index: trimmed.length - 1 };
  }
  const next = [...trimmed, path];
  return { entries: next, index: next.length - 1 };
}

export function backHistory(history: BrowserHistory): BrowserHistory {
  if (history.index <= 0) return history;
  return { entries: history.entries, index: history.index - 1 };
}

export function forwardHistory(history: BrowserHistory): BrowserHistory {
  if (history.index < 0) return history;
  if (history.index >= history.entries.length - 1) return history;
  return { entries: history.entries, index: history.index + 1 };
}

export function currentPath(history: BrowserHistory): string | null {
  if (history.index < 0) return null;
  return history.entries[history.index] ?? null;
}

export function canGoBack(history: BrowserHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: BrowserHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/**
 * A stable key for the `<iframe>` so React mounts a fresh DOM node
 * whenever the navigation target changes. The sandbox token list is
 * `allow-scripts` only — see `IFRAME_SANDBOX` — so an in-place
 * `src=` change is enough to navigate; the key only matters for
 * `push` / `refresh`, both of which must produce a brand-new
 * document (the latter explicitly to drop any cached module-level
 * state the preview's JS may have kept).
 */
export function iframeKey(path: string, refreshNonce: number): string {
  return `${refreshNonce}:${path}`;
}