"use client";

/**
 * 任务管理 tab body (slice 15).
 *
 * Renders the active session's dispatched subagents (slice 06's
 * `state.recentSubagents[]`) as a vertical list with:
 *   - status glyph (the slice-06 badge label + glyph)
 *   - agent name (resolved through the same `agentLabel` helper
 *     the `ToolCard` already uses)
 *   - a "jump" button that calls `api.switchSession(subagent.sessionId)`
 *     — same UX as the `tool-card-subagent-badge` affordance the
 *     chat transcript already exposes
 *   - relative timestamps ("3s ago" / "5m ago" / "2h ago") so a
 *     long-running subagent reads as "still running, started 5m ago"
 *
 * The panel is read-only; slice 06 owns the writer (`server/lib/state-bus.js#recordSubagentForCid`).
 * The renderer subscribes to the SSE snapshot the page already
 * provides through `useSessionContext()`.
 */

import { useCallback } from "react";

import * as api from "@/lib/api";
import { useSessionContext } from "@/lib/store";
import { useLocale } from "@/lib/use-locale";
import { agentLabel, badgeLabelAndGlyph } from "@/lib/i18n-agent-team";
import { tWorkspaceTab } from "@/lib/i18n-workspace-tabs";
import { runAction } from "@/lib/action-errors";
import { Icon } from "./icons";
import type { Locale, MessageKey } from "@/lib/i18n";
import type { RecentSubagent } from "@/lib/types";

export interface WorkspaceTabsTasksProps {
  t: (key: MessageKey) => string;
  locale: Locale;
}

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  queued: 1,
  idle: 2,
  done: 3,
  failed: 3,
  stopped: 3,
};

export function WorkspaceTabsTasks({ t, locale }: WorkspaceTabsTasksProps) {
  const { state } = useSessionContext();
  const recent = state?.recentSubagents ?? [];
  const sorted = [...recent].sort((a, b) => statusOrder(a.status) - statusOrder(b.status));

  const jumpTo = useCallback(
    async (subagent: RecentSubagent) => {
      const sessionId = subagent.sessionId;
      if (!sessionId) return;
      try {
        await api.switchSession(sessionId);
      } catch (cause) {
        // runAction surfaces a transient banner via the same channel
        // the chat composer uses for `send` failures. The banner is
        // bilingual (see lib/action-errors.ts) so we don't need to
        // render anything panel-local.
        const message = cause instanceof Error ? cause.message : String(cause);
        runAction(t("workspaceTabs.tasks.jump"), Promise.reject(new Error(message)));
      }
    },
    [t],
  );

  return (
    <div className="flex flex-col gap-3" data-testid="workspace-tabs-tasks">
      <header className="flex flex-col gap-1">
        <h2 className="desktop-text-dialog-medium text-base font-medium leading-6 text-text_default_primary">
          {t("workspaceTabs.tasks.title")}
        </h2>
        <p className="text-caption-small-strong text-text_default_tertiary">
          {t("workspaceTabs.tasks.subtitle")}
        </p>
      </header>

      {sorted.length === 0 ? (
        <p
          data-testid="workspace-tabs-tasks-empty"
          className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary"
        >
          {t("workspaceTabs.tasks.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="workspace-tabs-tasks-list">
          {sorted.map((subagent) => (
            <TaskRow
              key={subagent.toolCallId || subagent.sessionId}
              subagent={subagent}
              locale={locale}
              t={t}
              onJump={() => void jumpTo(subagent)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({
  subagent,
  locale,
  t,
  onJump,
}: {
  subagent: RecentSubagent;
  locale: Locale;
  t: (key: MessageKey) => string;
  onJump: () => void;
}) {
  const badge = badgeLabelAndGlyph(locale, subagent.status);
  const name = agentLabel(locale, subagent.agentName);
  const ts = subagent.updatedAtMs ?? subagent.createdAtMs ?? null;
  return (
    <li
      data-testid={`workspace-tabs-task-row-${subagent.toolCallId || subagent.sessionId}`}
      className="flex items-center gap-2 rounded-lg border border-border_default bg-bg_grouped_secondary_elevated px-2 py-1.5"
    >
      <span
        className={[
          "flex size-5 flex-shrink-0 items-center justify-center rounded-md text-caption-small-strong",
          subagent.status === "running"
            ? "bg-bg_status_accent text-text_default_accent"
            : subagent.status === "failed"
              ? "bg-bg_status_error text-text_status_error"
              : "bg-bg_grouped_tertiary text-text_default_secondary",
        ].join(" ")}
        aria-label={badge?.label ?? ""}
        title={badge?.label ?? ""}
      >
        {badge?.glyph ?? "·"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 truncate text-sm text-text_default_primary">
          <span className="font-medium">{name}</span>
          <span className="text-caption-small-strong text-text_default_tertiary">
            {badge?.label ?? ""}
          </span>
        </span>
        <span className="flex items-center gap-2 truncate font-family-code text-caption-small-strong text-text_default_tertiary">
          <span title={subagent.sessionId}>{shortenSessionId(subagent.sessionId)}</span>
          {ts ? <span title={new Date(ts).toLocaleString()}>{formatAgo(t, locale, ts)}</span> : null}
        </span>
      </div>
      <button
        type="button"
        onClick={onJump}
        aria-label={t("workspaceTabs.tasks.jump")}
        title={subagent.sessionId}
        data-testid={`workspace-tabs-task-jump-${subagent.toolCallId || subagent.sessionId}`}
        className="flex h-7 flex-none items-center gap-1 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
        <Icon name="reply" size={12} className="rotate-180" />
        <span>{t("workspaceTabs.tasks.jump")}</span>
      </button>
    </li>
  );
}

function statusOrder(status: string | null): number {
  if (!status) return 99;
  return STATUS_ORDER[status] ?? 99;
}

function shortenSessionId(id: string): string {
  if (!id) return "";
  if (id.length <= 14) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}

function formatAgo(t: (key: MessageKey) => string, locale: Locale, ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const totalSec = Math.floor(delta / 1000);
  if (totalSec < 60) {
    return tWorkspaceTab(locale, "workspaceTabs.tasks.sinceAgo").replace("{n}", String(totalSec));
  }
  if (totalSec < 3600) {
    return tWorkspaceTab(locale, "workspaceTabs.tasks.minutesAgo").replace("{n}", String(Math.floor(totalSec / 60)));
  }
  return tWorkspaceTab(locale, "workspaceTabs.tasks.hoursAgo").replace("{n}", String(Math.floor(totalSec / 3600)));
}