"use client";

import { useCallback, useEffect, useState } from "react";

import { resolveLocale, storeLocale, translate, type Locale, type MessageKey } from "./i18n";

/**
 * Locale state and translator.
 *
 * Resolved after mount rather than during render: the stored/browser preference
 * lives in `localStorage`, which the static export cannot read, and reading it in
 * the render pass would desynchronise hydration. The markup renders in the
 * default locale for one frame, then settles.
 */
export function useLocale(): {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
} {
  const [locale, setLocaleState] = useState<Locale>("zh");

  useEffect(() => {
    setLocaleState(resolveLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    storeLocale(next);
    setLocaleState(next);
  }, []);

  const t = useCallback((key: MessageKey) => translate(locale, key), [locale]);

  return { locale, setLocale, t };
}
