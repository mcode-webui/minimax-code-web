"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Empty } from "antd";
import { createPortal } from "react-dom";

import { useAlerts } from "@/lib/alerts";
import type { AlertItem } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { Icon } from "./icons";

/**
 * 站内信 — the inbox, as a flyout beside the sidebar.
 *
 * This is not a right-hand drawer. The desktop client anchors the inbox to the
 * bell and flies it out *beside* the sidebar: its left edge sits 8px to the
 * right of the sidebar card's right edge, its bottom edge 8px above the
 * viewport bottom, with a large radius and a soft shadow (no border). Upstream
 * computes that offset in its own code
 * (`align.offset = [(sidebarRight - triggerRight) + 8, innerHeight - triggerBottom - 8]`
 * with `autoAdjustOverflow: false`).
 *
 * The panel is portalled to `document.body` with `fixed` positioning: the
 * sidebar and the content column are both `overflow-hidden`, so an anchored
 * child would be clipped by its ancestors.
 *
 * The surface and its tab row follow upstream, but the *feed* is still this
 * server's alert ring buffer — there is no inbox API with categories or read
 * state yet. 产品更新 / 我的消息 / 全部已读 therefore render disabled.
 */

/** Inbox width. Upstream's popover is content-sized; this keeps long messages readable. */
const INBOX_WIDTH = 380;
/** Gap between the sidebar card and the flyout (upstream: +8 on the x offset). */
const SIDEBAR_GAP = 8;
/** Distance from the viewport bottom (upstream: `innerHeight - triggerBottom - 8`). */
const BOTTOM_INSET = 8;

const INBOX_TABS: { key: MessageKey; disabled?: boolean }[] = [
  { key: "inbox.tabAll" },
  { key: "inbox.tabProduct", disabled: true },
  { key: "inbox.tabMine", disabled: true },
];

export function InboxFlyout({
  open,
  onClose,
  t,
}: {
  open: boolean;
  onClose: () => void;
  t: (key: MessageKey) => string;
}) {
  const [placement, setPlacement] = useState<{ left: number; bottom: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    // Anchor to the sidebar card itself, like upstream does (it resolves the
    // nearest `[data-testid="sidebar-base-card"]` from the bell).
    const card = document.querySelector('[data-testid="sidebar-base-card"]');
    const right = card?.getBoundingClientRect().right ?? 0;
    const maxLeft = Math.max(SIDEBAR_GAP, window.innerWidth - INBOX_WIDTH - SIDEBAR_GAP);
    setPlacement({
      left: Math.min(Math.max(SIDEBAR_GAP, right + SIDEBAR_GAP), maxLeft),
      bottom: BOTTOM_INSET,
    });
  }, []);

  useEffect(() => {
    if (open) place();
    else setPlacement(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The bell itself owns the toggle; anything else dismisses.
      const bell = document.querySelector('[data-testid="inbox-entry"]');
      if (bell?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, onClose, place]);

  if (!open || !placement || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("inbox.title")}
      data-testid="inbox-flyout"
      style={{ left: placement.left, bottom: placement.bottom, width: INBOX_WIDTH }}
      className="fixed z-[150] flex max-h-[min(560px,70vh)] flex-col overflow-hidden rounded-[18px] bg-bg_grouped_secondary_elevated shadow-shadow_default"
    >
      <div className="flex flex-none items-center gap-4 border-b border-border_light px-4 pt-3 pb-2">
        {INBOX_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            disabled={tab.disabled}
            aria-current={tab.disabled ? undefined : "true"}
            title={tab.disabled ? t("common.unsupported") : undefined}
            className={[
              "relative pb-1 text-sm transition-colors",
              tab.disabled
                ? "cursor-not-allowed text-text_default_tertiary opacity-50"
                : "text-text_default_primary",
            ].join(" ")}
          >
            {t(tab.key)}
            {tab.disabled ? null : (
              <span className="absolute inset-x-0 -bottom-[2px] h-[2px] rounded-full bg-text_default_primary" />
            )}
          </button>
        ))}
        <button
          type="button"
          disabled
          title={t("common.unsupported")}
          className="ml-auto cursor-not-allowed pb-1 text-xs text-text_default_tertiary opacity-50"
        >
          {t("inbox.markAllRead")}
        </button>
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <InboxList t={t} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * The message rows.
 *
 * Shared with the alerts drawer (components/panels.tsx) so both surfaces render
 * the same data the same way — one row per message: a level-coloured glyph, the
 * message as the title, its source as the subtitle, and the time on the right.
 */
export function InboxList({ t }: { t: (key: MessageKey) => string }) {
  const { alerts } = useAlerts();

  if (alerts.length === 0) {
    return (
      <div className="px-2 py-6" data-testid="alerts-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("alerts.empty")}
          styles={{ image: { height: 36 } }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {alerts.map((alert) => (
        <InboxRow key={alert.id} alert={alert} />
      ))}
    </div>
  );
}

function InboxRow({ alert }: { alert: AlertItem }) {
  const tone =
    alert.level === "error"
      ? "bg-bg_status_error"
      : alert.level === "warn"
        ? "bg-bg_status_warning"
        : "bg-bg_status_positive";
  return (
    <div className="flex items-start gap-3 rounded-[10px] px-2 py-2.5 hover:bg-bg_interaction_tertiary_hover">
      <span className={`flex size-8 flex-none items-center justify-center rounded-[8px] ${tone}`}>
        <Icon name="bell" size={16} className="text-icon_default_inverted" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words text-sm leading-5 text-text_default_primary">{alert.msg}</span>
        <span className="truncate text-xs leading-4 text-text_default_tertiary">
          {alert.src}
          {alert.count && alert.count > 1 ? ` ×${alert.count}` : ""}
        </span>
      </div>
      <span className="flex-none pt-0.5 text-xs leading-4 text-text_default_tertiary">
        {new Date(alert.ts).toLocaleTimeString()}
      </span>
    </div>
  );
}
