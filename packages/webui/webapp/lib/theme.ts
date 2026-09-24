import type { ThemeName } from "./types";

/**
 * Theme control, following the upstream protocol exactly.
 *
 * The resolved theme is a `light` / `dark` class on <html> plus a matching
 * `color-scheme`, which is what the design tokens' `.dark` block keys off and what
 * keeps native scrollbars and form controls in step. The initial value is applied
 * before first paint by the inline script in app/layout.tsx; this module only reads
 * and changes it afterwards.
 *
 * The storage key is `theme` — the same key upstream uses, so a choice made in one
 * surface is honoured by the other.
 */

const STORAGE_KEY = "theme";

/** Read the currently applied theme from the document. */
export function currentTheme(): ThemeName {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Apply a theme to the document and persist it. */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private modes and embedded webviews can refuse storage; the theme still
    // applies for this page view, it just will not be remembered.
  }
}

/** Flip light <-> dark. */
export function toggleTheme(): ThemeName {
  const next: ThemeName = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
