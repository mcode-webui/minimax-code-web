"use client";

/**
 * System-theme subscription (slice 18).
 *
 * Mounted once at the root of the page. Its single job is to keep the
 * document's `light` / `dark` class in step with `prefers-color-scheme`
 * **while the user's stored choice is `system`** — explicit `light` /
 * `dark` choices are pinned and must NOT track the OS.
 *
 * The matchMedia listener is owned by `lib/theme.ts` so the resolution
 * algorithm is in one place; this component is just the mount point.
 *
 * No JSX is rendered. The component's return value is intentionally `null`.
 * It exists purely to host the `useEffect`.
 */

import { useEffect } from "react";
import {
  applyTheme,
  currentAppearance,
  subscribeSystemTheme,
} from "@/lib/theme";

export function AppearanceSync(): null {
  useEffect(() => {
    const unsubscribe = subscribeSystemTheme((next) => {
      // The listener in lib/theme.ts already gates on `currentAppearance()`,
      // but we re-check here so an explicit choice made after mount is
      // respected on the very next media-query change.
      if (currentAppearance() !== "system") return;
      applyTheme(next);
    });
    return unsubscribe;
  }, []);
  return null;
}
