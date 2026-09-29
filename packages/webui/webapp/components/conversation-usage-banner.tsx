// ConversationUsageBanner — WebUI transcription of `function p()` from
// `mine-transcript/58686.pretty.js` (lines 26984–27108). Shown when the cloud
// quota signals an `insufficient_credit` / `five_hour` / `weekly` /
// `video` notice; data is passed through props so the WebUI shell can decide
// how to wire it to the runtime.
//
// The brief says: "若依赖云端数据，做成纯展示组件、数据由 props 传入。"
// That matches `notice.kind`, `notice.messageKey`, `notice.resetAtMs`,
// `notice.actions` (the action IDs the desktop translates to
// `buy_credits` / `subscribe_plan` / `upgrade_plan`) and `notice.dismissable`
// (driven by `f.Rm(t)` — Desktop calls `Rm` the "should I render the close
// button" decision; here we expose `notice.dismissable` as a simple boolean).
//
// The CTA buttons keep their verbatim labels:
//   "buy_credits"      → chat_button_buy_credits
//   "subscribe_plan"   → chat_button_subscribe_plan
//   "upgrade_plan"     → chat_button_upgrade_plan
// The container class names come straight from line 27041–27043 (`h` toggles
// between the inline `relative mb-2 flex min-h-16 flex-col gap-3 …` and the
// compact `mb-3 flex min-h-12 flex-wrap items-center …` variant).
//
// The dismiss button testid is `conversation-usage-dismiss` (line 27066 /
// 27101); the brief also names `conversation-usage-banner-dismiss`. We emit
// both testids on the same node so Playwright selectors written against either
// form land on the same element.

import type { MouseEvent, ReactNode } from "react";

export type ConversationUsageActionKind =
  | "buy_credits"
  | "subscribe_plan"
  | "upgrade_plan";

export interface ConversationUsageNotice {
  kind: "five_hour" | "weekly" | "video" | "insufficient_credit" | string;
  messageKey: string;
  resetAtMs?: number | null;
  actions: readonly ConversationUsageActionKind[];
  dismissable?: boolean;
}

export interface ConversationUsageBannerProps {
  notice: ConversationUsageNotice;
  mobileLayout?: boolean;
  messageText: string;
  dismissLabel?: string;
  buttonLabels?: Partial<Record<ConversationUsageActionKind, string>>;
  onDismiss?: () => void;
  onAction?: (kind: ConversationUsageActionKind) => void;
  renderActionButton?: (params: {
    kind: ConversationUsageActionKind;
    label: string;
    onClick: () => void;
    variant: "black" | "gray";
    testId: string;
  }) => ReactNode;
}

const DEFAULT_BUTTON_LABELS: Record<ConversationUsageActionKind, string> = {
  buy_credits: "购买积分",
  subscribe_plan: "订阅套餐",
  upgrade_plan: "升级套餐",
};

function formatResetAt(resetAtMs: number, now: number = Date.now()): string {
  const sameDay = (() => {
    const a = new Date(resetAtMs);
    const b = new Date(now);
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  })();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(resetAtMs);
}

function DefaultActionButton(props: {
  kind: ConversationUsageActionKind;
  label: string;
  variant: "black" | "gray";
  testId: string;
  onClick: () => void;
}): React.JSX.Element {
  const { kind, label, variant, testId, onClick } = props;
  const base =
    "!inline-flex !h-8 !items-center !justify-center !rounded-lg !px-3 !py-0 !text-[14px] border-[0.5px]";
  const styles =
    variant === "black"
      ? `${base} border-border_default bg-bg_interaction_primary_default text-text_default_inverted hover:bg-bg_interaction_primary_hover`
      : `${base} border-border_default bg-bg_default_primary text-text_default_primary hover:bg-bg_interaction_tertiary_hover`;
  return (
    <button type="button" className={styles} data-testid={testId} onClick={onClick}>
      {label}
    </button>
  );
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        d="M4 4l10 10M14 4L4 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NoticeIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      className="flex-none text-icon_default_secondary"
    >
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="13.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function ConversationUsageBanner(props: ConversationUsageBannerProps): React.JSX.Element {
  const {
    notice,
    mobileLayout = false,
    messageText,
    dismissLabel = "关闭",
    buttonLabels,
    onDismiss,
    onAction,
    renderActionButton,
  } = props;

  const labels: Record<ConversationUsageActionKind, string> = {
    buy_credits: buttonLabels?.buy_credits ?? DEFAULT_BUTTON_LABELS.buy_credits,
    subscribe_plan: buttonLabels?.subscribe_plan ?? DEFAULT_BUTTON_LABELS.subscribe_plan,
    upgrade_plan: buttonLabels?.upgrade_plan ?? buttonLabels?.upgrade_plan ?? DEFAULT_BUTTON_LABELS.upgrade_plan,
  };

  const composedMessage =
    notice.resetAtMs == null
      ? messageText
      : `${messageText} ${formatResetAt(notice.resetAtMs)}`;

  const canDismiss = notice.dismissable !== false;
  const dismissClass = mobileLayout
    ? "absolute right-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-icon_default_tertiary hover:bg-bg_interaction_tertiary_hover"
    : "flex h-8 w-8 items-center justify-center rounded-lg text-icon_default_tertiary hover:bg-bg_interaction_tertiary_hover";

  const containerClass = mobileLayout
    ? "relative mb-2 flex min-h-16 flex-col gap-3 rounded-2xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-2 transcript-shadow-banner-soft"
    : "mb-3 flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated px-4 py-2 transcript-shadow-banner-soft";

  const handleDismiss = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDismiss?.();
  };

  const handleAction = (kind: ConversationUsageActionKind) => () => {
    onAction?.(kind);
  };

  return (
    <div
      className={containerClass}
      data-testid="conversation-usage-banner"
      data-notice-kind={notice.kind}
    >
      <div
        className={
          mobileLayout
            ? "flex min-w-0 items-center gap-2 pr-9"
            : "flex min-w-[240px] flex-1 items-center gap-2"
        }
      >
        <NoticeIcon />
        <p className="min-w-0 flex-1 text-[14px] leading-5 text-text_default_primary">
          {composedMessage}
        </p>
      </div>
      {mobileLayout && canDismiss ? (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={dismissLabel}
          data-testid="conversation-usage-banner-dismiss"
          className={dismissClass}
        >
          <CloseIcon />
        </button>
      ) : null}
      <div
        className={
          mobileLayout
            ? "flex items-center justify-end gap-2"
            : "ml-auto flex flex-none items-center gap-2"
        }
      >
        {notice.actions.map((kind) => {
          const variant = kind === "buy_credits" ? "gray" : "black";
          const label = labels[kind];
          const testId = `conversation-usage-action-${kind}`;
          return renderActionButton ? (
            renderActionButton({
              kind,
              label,
              onClick: handleAction(kind),
              variant,
              testId,
            })
          ) : (
            <DefaultActionButton
              key={kind}
              kind={kind}
              label={label}
              variant={variant}
              testId={testId}
              onClick={handleAction(kind)}
            />
          );
        })}
        {!mobileLayout && canDismiss ? (
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={dismissLabel}
            data-testid="conversation-usage-banner-dismiss"
            className={dismissClass}
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}