"use client";

/**
 * Three-state appearance picker (slice 18).
 *
 * Renders three cards in a row, mirroring the desktop reference
 * (`refs/ui/04-settings-general.jpg`):
 *
 *   - Light card   — a small white window mockup with a dark accent dot.
 *   - Dark card    — a small dark window mockup with a light accent dot.
 *   - System card  — a half-light / half-dark split mockup.
 *
 * The selected card carries a blue ring (the same `--border_accent` token
 * the desktop's radio-buttons use); unselected cards carry the default
 * 1px border. Tapping a card calls `applyAppearance` immediately — no
 * reload, no "apply" button — and writes the choice into the slice-07
 * UI-state envelope.
 *
 * The component reads its initial choice from `currentAppearance()` so
 * the rendered highlight matches what the inline bootstrap in
 * `app/layout.tsx` painted on first paint, then keeps a local mirror for
 * instant feedback. The mirror is the same pattern `panels.tsx#ThemeSwitch`
 * used (now removed) — small enough to inline.
 *
 * No "darkAlgorithm" in the menu either: the chosen theme is committed as
 * a class on `<html>` and the `mavis-*` skin + Tailwind tokens + antd
 * tokens all resolve through `styles/tokens.css`. The desktop does it
 * the same way; we keep the convention.
 */

import { useEffect, useState } from "react";

import type { AppearanceChoice } from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { applyAppearance, currentAppearance } from "@/lib/theme";
import { tAppearance } from "@/lib/i18n-appearance";

interface AppearanceCardPickerProps {
  /** The active locale (the picker reads its labels through
   *  `tAppearance`, not the central `t()`). Carried as a prop so the
   *  picker does not import the locale store directly. */
  locale: Locale;
}

export function AppearanceCardPicker({
  locale,
}: AppearanceCardPickerProps): JSX.Element {
  const [choice, setChoice] = useState<AppearanceChoice>("system");
  useEffect(() => {
    setChoice(currentAppearance() ?? "system");
  }, []);

  const cards: ReadonlyArray<{
    id: AppearanceChoice;
    label: string;
    aria: string;
    render: () => JSX.Element;
  }> = [
    {
      id: "light",
      label: tAppearance(locale, "appearance.choice.light"),
      aria: tAppearance(locale, "appearance.choice.light.aria"),
      render: () => <LightMockup />,
    },
    {
      id: "dark",
      label: tAppearance(locale, "appearance.choice.dark"),
      aria: tAppearance(locale, "appearance.choice.dark.aria"),
      render: () => <DarkMockup />,
    },
    {
      id: "system",
      label: tAppearance(locale, "appearance.choice.system"),
      aria: tAppearance(locale, "appearance.choice.system.aria"),
      render: () => <SystemMockup />,
    },
  ];

  const hint =
    choice === "system"
      ? tAppearance(locale, "appearance.hint.system")
      : tAppearance(locale, "appearance.hint.fixed");

  return (
    <div className="flex flex-col gap-2" data-testid="appearance-card-picker">
      <div
        role="radiogroup"
        aria-label={tAppearance(locale, "appearance.choice.system")}
        className="grid grid-cols-3 gap-3"
      >
        {cards.map((card) => {
          const selected = card.id === choice;
          return (
            <button
              key={card.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={card.aria}
              data-card-id={card.id}
              data-selected={selected ? "true" : "false"}
              onClick={() => {
                applyAppearance(card.id);
                setChoice(card.id);
              }}
              className={
                "group flex flex-col items-center gap-2 rounded-[12px] border bg-bg_default_secondary p-2 transition-colors " +
                (selected
                  ? "border-[1.5px] border-border_accent"
                  : "border border-border_default hover:bg-bg_interaction_tertiary_hover")
              }
            >
              <div
                aria-hidden={true}
                className={
                  "flex h-[60px] w-full items-center justify-center overflow-hidden rounded-[8px] " +
                  (selected
                    ? "bg-bg_default_primary"
                    : "bg-bg_default_tertiary")
                }
              >
                {card.render()}
              </div>
              <span className="text-[12px] leading-[16px] text-text_default_primary">
                {card.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[12px] leading-[18px] text-text_default_secondary">
        {hint}
      </p>
    </div>
  );
}

/* --- mockup graphics ----------------------------------------------------- */

// Each mockup is a tiny inline-SVG window: a rounded rectangle with a few
// "content bars" and a single corner accent dot. The bars use a
// token-derived colour so they re-tint with the active theme. The accent
// dot is the opposite end of the value scale (the same trick the desktop
// mockups use — a dark dot on the light card, a light dot on the dark
// card) so the three cards are visually distinct at a glance.
//
// These are static graphics. They live inside the card button but the
// button's background is already themed, so they stay readable in both
// light and dark mode without any per-theme branching.

function LightMockup(): JSX.Element {
  return (
    <svg
      viewBox="0 0 80 40"
      width="80"
      height="40"
      role="presentation"
      aria-hidden={true}
    >
      <rect
        x="2"
        y="2"
        width="76"
        height="36"
        rx="4"
        fill="var(--bg_default_primary)"
        stroke="var(--border_default)"
        strokeWidth="1"
      />
      <rect
        x="6"
        y="8"
        width="22"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="6"
        y="14"
        width="40"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="6"
        y="20"
        width="32"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="6"
        y="26"
        width="18"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="62"
        y="26"
        width="12"
        height="8"
        rx="2"
        fill="var(--text_default_primary)"
      />
    </svg>
  );
}

function DarkMockup(): JSX.Element {
  return (
    <svg
      viewBox="0 0 80 40"
      width="80"
      height="40"
      role="presentation"
      aria-hidden={true}
    >
      <rect
        x="2"
        y="2"
        width="76"
        height="36"
        rx="4"
        fill="var(--bg_default_primary)"
        stroke="var(--border_default)"
        strokeWidth="1"
      />
      <rect
        x="6"
        y="8"
        width="22"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="6"
        y="14"
        width="40"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="6"
        y="20"
        width="32"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="6"
        y="26"
        width="18"
        height="3"
        rx="1.5"
        fill="var(--bg_default_tertiary)"
      />
      <rect
        x="62"
        y="26"
        width="12"
        height="8"
        rx="2"
        fill="var(--bg_default_primary)"
        stroke="var(--border_default)"
        strokeWidth="1"
      />
    </svg>
  );
}

/**
 * Split mockup — left half light, right half dark. Renders the same
 * window twice with a clipPath to split the canvas along the vertical
 * centre line.
 */
function SystemMockup(): JSX.Element {
  return (
    <svg
      viewBox="0 0 80 40"
      width="80"
      height="40"
      role="presentation"
      aria-hidden={true}
    >
      <defs>
        <clipPath id="appearance-system-left">
          <rect x="0" y="0" width="40" height="40" />
        </clipPath>
        <clipPath id="appearance-system-right">
          <rect x="40" y="0" width="40" height="40" />
        </clipPath>
      </defs>
      {/* Left half — light */}
      <g clipPath="url(#appearance-system-left)">
        <rect
          x="2"
          y="2"
          width="76"
          height="36"
          rx="4"
          fill="var(--bg_default_primary)"
          stroke="var(--border_default)"
          strokeWidth="1"
        />
        <rect
          x="6"
          y="8"
          width="22"
          height="3"
          rx="1.5"
          fill="var(--bg_default_tertiary)"
        />
        <rect
          x="6"
          y="14"
          width="20"
          height="3"
          rx="1.5"
          fill="var(--bg_default_tertiary)"
        />
        <rect
          x="6"
          y="20"
          width="14"
          height="3"
          rx="1.5"
          fill="var(--bg_default_tertiary)"
        />
        <rect
          x="62"
          y="26"
          width="12"
          height="8"
          rx="2"
          fill="var(--text_default_primary)"
        />
      </g>
      {/* Right half — same content but inverted, simulating the OS flipping. */}
      <g clipPath="url(#appearance-system-right)">
        <rect
          x="2"
          y="2"
          width="76"
          height="36"
          rx="4"
          fill="var(--text_default_primary)"
          stroke="var(--border_default)"
          strokeWidth="1"
        />
        <rect
          x="6"
          y="8"
          width="22"
          height="3"
          rx="1.5"
          fill="var(--text_default_secondary)"
        />
        <rect
          x="6"
          y="14"
          width="20"
          height="3"
          rx="1.5"
          fill="var(--text_default_secondary)"
        />
        <rect
          x="6"
          y="20"
          width="14"
          height="3"
          rx="1.5"
          fill="var(--text_default_secondary)"
        />
        <rect
          x="62"
          y="26"
          width="12"
          height="8"
          rx="2"
          fill="var(--bg_default_primary)"
          stroke="var(--border_default)"
          strokeWidth="1"
        />
      </g>
    </svg>
  );
}
