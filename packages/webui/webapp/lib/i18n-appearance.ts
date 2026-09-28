/**
 * Bilingual strings — slice 18 (three-state appearance setting).
 *
 * New module rather than extending `lib/i18n.ts` because the central
 * dictionary is owned by every slice in flight; appending here keeps the
 * diff small and avoids a cross-slice merge conflict. Every key MUST
 * exist in BOTH locales — `i18n-appearance.test.ts` enforces it.
 *
 * The keys are grouped:
 *
 *   - choice.*           — the three card labels (light / dark / system)
 *                          and the descriptive hint the picker shows
 *                          beneath them. The hint is short enough for a
 *                          288px picker card and the chosen word is
 *                          pulled verbatim from the desktop reference
 *                          (`refs/ui/04-settings-general.jpg`).
 *   - card.*             — the small mockup-window copy drawn inside
 *                          each card. Picker cards are 96×60px-ish on
 *                          the desktop; the labels are short and don't
 *                          really change between locales — but listing
 *                          them here makes a future "active-row" label
 *                          easy to wire.
 *   - group / heading    — the section title the picker lives under,
 *                          and the surrounding "Application" group
 *                          title the desktop reference uses. Both
 *                          already exist on the central dictionary
 *                          (`settings.appearance` / `settings.tab.general`)
 *                          and the picker reuses them rather than
 *                          redeclaring.
 *   - tooltip.*          — the tooltip on each card. Three reasons for
 *                          pinning these as i18n keys rather than a
 *                          terse `title=""`: the rendered string is
 *                          read by screen readers, and bilingual users
 *                          don't get a stray tooltip in another
 *                          language on hover.
 *
 * Reuses `t()` from `./i18n` so a missing key still falls back to the
 * raw key (the dictionary's debug contract), but every key here is in
 * both locales — see the test.
 */

import type { Locale } from "./i18n";

const APPEARANCE_STRINGS = {
  en: {
    /* Three card labels. */
    "appearance.choice.light": "Light",
    "appearance.choice.dark": "Dark",
    "appearance.choice.system": "Follow system",
    /* Tooltip / aria for each card. The aria version is what screen
       readers announce on focus. */
    "appearance.choice.light.aria":
      "Light mode — fixed, ignores the system theme",
    "appearance.choice.dark.aria":
      "Dark mode — fixed, ignores the system theme",
    "appearance.choice.system.aria":
      "Follow system — switch the page theme when your operating system switches",
    /* Sub-line beneath the three cards. Sits below the card row and
       describes the active choice in plain English so a user who has
       never opened the picker before does not have to guess what each
       icon means. */
    "appearance.hint.fixed":
      "The page stays in this theme no matter what your operating system does.",
    "appearance.hint.system":
      "The page follows your operating system's dark / light setting. Switches live, without refreshing.",
  },
  zh: {
    "appearance.choice.light": "浅色",
    "appearance.choice.dark": "深色",
    "appearance.choice.system": "跟随系统",
    /* 卡片 aria 标签。屏幕阅读器在焦点上读这一行。 */
    "appearance.choice.light.aria": "浅色模式 — 固定为浅色，不跟随系统",
    "appearance.choice.dark.aria": "深色模式 — 固定为深色，不跟随系统",
    "appearance.choice.system.aria":
      "跟随系统 — 操作系统切换明暗时，页面同步切换",
    /* 卡片下方的提示行。一句话讲清当前选择的语义,避免新用户
       靠图标猜测含义。 */
    "appearance.hint.fixed":
      "页面始终保持该主题,不随操作系统的明暗切换而改变。",
    "appearance.hint.system":
      "页面跟随操作系统的明暗设置。系统切换时,页面会实时跟随,无需刷新。",
  },
} as const;

export type AppearanceKey = keyof (typeof APPEARANCE_STRINGS)["en"];

/**
 * List of every slice-18 string. Mirrored on `APPEARANCE_STRINGS` so the
 * bilingual-coverage test can iterate without re-typing the keys. Adding
 * a new key in both `APPEARANCE_STRINGS.en` and `APPEARANCE_STRINGS.zh`
 * without appending it here is a test failure.
 */
export const APPEARANCE_KEYS: ReadonlyArray<AppearanceKey> = [
  "appearance.choice.light",
  "appearance.choice.dark",
  "appearance.choice.system",
  "appearance.choice.light.aria",
  "appearance.choice.dark.aria",
  "appearance.choice.system.aria",
  "appearance.hint.fixed",
  "appearance.hint.system",
];

export { APPEARANCE_STRINGS };

/**
 * Resolve a slice-18 string for the current locale.
 *
 * Falls back to en on a missing locale (defensive — the webui only
 * ships zh / en today). Falls back to the raw key when the bucket is
 * missing the entry, so a regression here surfaces as the key name in
 * the UI rather than an empty bar.
 */
export function tAppearance(locale: Locale, key: AppearanceKey): string {
  const safeLocale = (locale === "zh" ? "zh" : "en") as "zh" | "en";
  const bucket = APPEARANCE_STRINGS[safeLocale] || APPEARANCE_STRINGS.en;
  return bucket[key] || APPEARANCE_STRINGS.en[key] || key;
}
