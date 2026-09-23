"use client";

import { dismissActionError, useActionErrors } from "@/lib/action-errors";
import type { MessageKey } from "@/lib/i18n";
import { Icon } from "./icons";

/**
 * Banner stack for failed mutations (see `lib/action-errors.ts`).
 *
 * Rendered once, near the root, so any component can report a failure without
 * knowing where the notice appears. Positioned bottom-centre and above the
 * composer, which is where the user's attention already is after acting.
 */
export function ActionErrorBanner({ t }: { t: (key: MessageKey) => string }) {
  const errors = useActionErrors();
  if (errors.length === 0) return null;

  return (
    <div
      data-testid="action-error-banner"
      role="alert"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-[1100] flex w-full max-w-[460px] -translate-x-1/2 flex-col gap-2 px-4"
    >
      {errors.map((error) => (
        <div
          key={error.id}
          className="pointer-events-auto flex items-start gap-2 rounded-xl border border-border_default bg-bg_grouped_secondary_elevated px-3 py-2 shadow-shadow_default"
        >
          <span className="mt-0.5 flex size-4 flex-shrink-0 items-center justify-center text-icon_default_tertiary">
            <Icon name="bell" size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-text_default_primary">
              {error.label} — {t("action.failed")}
            </p>
            <p className="mt-0.5 break-words text-caption-small-strong text-text_default_tertiary">
              {error.detail}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("panel.close")}
            title={t("panel.close")}
            onClick={() => dismissActionError(error.id)}
            className="flex size-6 flex-shrink-0 items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
