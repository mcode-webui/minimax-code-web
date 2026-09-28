import type { AppearanceChoice, ThemeName } from "./types";

/**
 * Theme control, following the upstream protocol exactly.
 *
 * The resolved theme is a `light` / `dark` class on <html> plus a matching
 * `color-scheme`, which is what the design tokens' `.dark` block keys off and what
 * keeps native scrollbars and form controls in step. The initial value is applied
 * before first paint by the inline script in app/layout.tsx; this module only reads
 * and changes it afterwards.
 *
 * Slice 18 added the third state (`system`): the user can now pick
 * `light` / `dark` / `follow system`, the choice survives a reload, and a live
 * `matchMedia('(prefers-color-scheme: dark)')` change flips the resolved theme
 * without waiting for a reload or a settings open. The "chosen mode"
 * (`AppearanceChoice`) is kept distinct from the "resolved light/dark"
 * (`ThemeName`) — both are exposed.
 *
 * The storage key follows the slice-07 convention: the choice lives on the same
 * `webui:ui:v1:<cid>` envelope as the rest of the per-browser UI state, with the
 * `cid` guard preventing two cids sharing a browser from clobbering each other.
 */

/** Read the user's stored appearance choice. `null` = no choice yet
 *  (bootstrap falls back to `prefers-color-scheme`). */
export function currentAppearance(): AppearanceChoice | null {
  if (typeof window === "undefined") return null;
  // The state field is owned by lib/persist, but reading localStorage directly
  // here avoids dragging the larger module into the inline bootstrap's
  // mirror — see the bootstrap in app/layout.tsx for the parallel logic.
  try {
    const raw = window.localStorage.getItem(appearanceStateKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { appearance?: unknown };
    } | null;
    const value =
      parsed &&
      parsed.state &&
      (parsed.state as { appearance?: unknown }).appearance;
    if (value === "light" || value === "dark" || value === "system")
      return value;
    return null;
  } catch {
    return null;
  }
}

/** Resolve the currently applied light/dark theme from the document. */
export function currentTheme(): ThemeName {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Resolve the choice + matchMedia into the actual light/dark to apply. */
export function resolvedTheme(): ThemeName {
  const choice = currentAppearance();
  if (choice === "light" || choice === "dark") return choice;
  if (typeof window === "undefined") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

/** Apply a concrete theme to the document. Does not persist. */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

/** Apply the user's three-state appearance choice: write through the
 *  `webui:ui:v1:<cid>` envelope, then update the document immediately. */
export function applyAppearance(choice: AppearanceChoice): void {
  // Read the current UiState so we don't accidentally drop a sibling field
  // (sidebar collapsed, last session, …). This avoids a round-trip through
  // lib/persist and keeps the helper self-contained for the settings picker.
  let current: Record<string, unknown> = {};
  try {
    const raw = window.localStorage.getItem(appearanceStateKey());
    if (raw) {
      const parsed = JSON.parse(raw) as {
        state?: Record<string, unknown>;
      } | null;
      if (parsed && parsed.state) current = { ...parsed.state };
    }
  } catch {
    /* fall through — empty current is fine; the choice is the only required field */
  }
  current.appearance = choice;
  try {
    const cid = readCidFromStorage();
    window.localStorage.setItem(
      appearanceStateKey(),
      JSON.stringify({ version: 1, cid, state: current }),
    );
  } catch {
    // Private modes and embedded webviews can refuse storage; the theme still
    // applies for this page view, it just will not be remembered.
  }
  applyTheme(themeForChoice(choice));
  // System choice implies a re-resolution against matchMedia; explicit light /
  // dark short-circuit to themselves. `themeForChoice` keeps the mapping in
  // one place so the listener below and this writer agree.
}

function themeForChoice(choice: AppearanceChoice): ThemeName {
  if (choice === "dark") return "dark";
  if (choice === "light") return "light";
  // `system` — defer to matchMedia.
  if (typeof window === "undefined") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

/**
 * Subscribe to live `prefers-color-scheme` changes.
 *
 * Returns an unsubscribe function. The listener only flips the document
 * when the user's choice is `system` (i.e. "follow the OS"); an explicit
 * `light` / `dark` choice does NOT change with the OS.
 */
export function subscribeSystemTheme(
  listener: (theme: ThemeName) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  let mql: MediaQueryList | null = null;
  try {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }
  const handler = (event: MediaQueryListEvent) => {
    if (currentAppearance() !== "system") return;
    listener(event.matches ? "dark" : "light");
  };
  // addEventListener is the modern API; the older addListener is the Safari < 14
  // fallback. Both are no-ops on platforms that already use the new API.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql?.removeEventListener("change", handler);
  }
  // Legacy fallback — typed as `any` because the old method is not on the
  // current lib.dom MediaQueryList type.
  const legacy = mql as unknown as {
    addListener: (cb: (event: MediaQueryListEvent) => void) => void;
    removeListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(handler);
  return () => legacy.removeListener(handler);
}

/** Flip light <-> dark. Kept for callers that want the legacy 2-way toggle;
 *  the slice-18 settings picker prefers applyAppearance directly. */
export function toggleTheme(): ThemeName {
  const next: ThemeName = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  // Mirror the legacy behaviour: persist the resolved value to the same
  // envelope so a reload honours the flip. The choice becomes `light` /
  // `dark` (not `system`) — toggle is explicit, not follow.
  applyAppearance(next);
  return next;
}

// --- localStorage envelope -------------------------------------------------

/**
 * Build the `webui:ui:v1:<cid>` key the slice-07 persistence module uses.
 * Duplicated here (and in the inline bootstrap in app/layout.tsx) to keep
 * `theme.ts` dependency-light — the settings modal already imports
 * `currentTheme`/`applyTheme`/`toggleTheme`, so avoiding a lib/persist
 * import keeps the legacy 2-state path bundle-stable.
 *
 * The key shape MUST stay in sync with `uiStateKey` in lib/persist.ts.
 */
function appearanceStateKey(): string {
  return `webui:ui:v1:${readCidFromStorage()}`;
}

/**
 * Read the cid from localStorage without going through lib/cid.ts — that
 * module would create a new cid on a cold read, which is exactly what the
 * inline bootstrap must NOT do (it runs before the user has chosen anything).
 * We only want to LOOK at whatever cid is already there.
 */
function readCidFromStorage(): string {
  if (typeof window === "undefined") return "anon";
  try {
    const value = window.localStorage.getItem("webui_cid");
    if (typeof value === "string" && value.length > 0) return value;
  } catch {
    /* */
  }
  return "anon";
}
