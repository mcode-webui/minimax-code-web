"use client";

// Like components/loading-states.tsx, this file imports React explicitly:
// webapp/test/activity-group.test.ts renders it through react-dom/server
// under the tsx loader, which honours `jsx: "preserve"` by falling back to
// the classic runtime — there is no Next compiler in that process to inject
// the automatic one.
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

// Renderers register on import: thinking bodies render through the same
// markdown pipeline as assistant messages (ticket 46 — thinking bodies are
// Markdown, not plain text), so the mermaid/KaTeX language renderers must be
// attached before `renderMarkdown` runs over thinking text.
import { renderMarkdown } from "../lib/markdown";
import { MarkdownHtml } from "./markdown-html";
import "../lib/mermaid-renderer"; // registers the mermaid language renderer
import "../lib/math-renderer"; // registers KaTeX (inline $…$, $$…$$, ```math fences)
import { switchSession } from "../lib/api";
import { findSubagentForBlock } from "../lib/agent-team-lookup";
import { badgeLabelAndGlyph, agentLabel } from "../lib/i18n-agent-team";
import { useLocale } from "../lib/use-locale";
import { useSessionContext } from "../lib/store";
import {
  SUMMARY_CATEGORY_KEY,
  iconByName,
  type ActivitySummary,
  type RenderUnit,
  type TranscriptBlock,
} from "../lib/transcript";
import {
  TOOL_STATUS_LABEL_KEY,
  clampDetailText,
  normalizeToolStatus,
  resourceDisplayName,
  toolCallLabel,
  toolSummaryResourcePath,
} from "../lib/tool-projection";
import { hasExpandableTurnContent, type TurnStats } from "../lib/turn-stats";
import { Icon } from "./icons";
import { ToolIcon } from "./tool-icon";
import type { MessageKey } from "../lib/i18n";

/**
 * The activity-rendering family (ticket 46 — session render fidelity, PR2).
 *
 * These components were lifted out of `components/chat.tsx` for the same
 * reason `loading-states.tsx` was (ticket U8): the SSR render tests in
 * `webapp/test/activity-group.test.ts` drive them through
 * `renderToStaticMarkup`, which requires the module to load without
 * `chat.tsx`'s heavier `@/`-aliased import graph (the node test runner does
 * not resolve the Next `paths` aliases). All behaviour is unchanged by the
 * lift itself; the ticket-46 changes are called out per component below.
 */

/** Height (px) beyond which a thinking body is clamped behind an expand
 *  button — the upstream desktop value (`WebuiThinkingBlock`). */
const THINKING_CLAMP_HEIGHT_PX = 224;

/**
 * True while any tool block in the run is still in flight — no terminal
 * status line yet (`[completed]` / `[failed]`), or an explicit
 * `[in_progress]`. Mirrors `summarizeActivity`'s `activeTool` rule; kept as
 * its own export so the render test can pin the wire-status vocabulary the
 * forced-open behaviour depends on.
 */
export function isActivityGroupActive(blocks: readonly TranscriptBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.role === "tool" &&
      (!block.toolStatus || block.toolStatus === "in_progress"),
  );
}

/**
 * Assign each block of each activity unit a stable React key: its global
 * birth order across the whole decoded transcript (P3-1 fix).
 *
 * Why not the within-group index: the wire writes a tool's `→ name` header
 * only when the tool COMPLETES (verified against the live engine — see the
 * P2-1 probe in ticket 46), and assistant prose lines stream in between.
 * During a turn the same thought therefore moves between groups and shifts
 * within them as runs are re-cut frame by frame; a key that encodes the
 * within-group position remounts the row on every re-cut, wiping the
 * ThinkingRow's elapsed-seconds state exactly at the moment the turn
 * settles (observed: a thought ticking 1s→4s loses its seconds at
 * finalize). The birth order is stable instead: decoding is deterministic
 * and append-only — a block's predecessors never reorder or vanish, so its
 * ordinal never changes even when the group boundaries around it do.
 *
 * Non-activity units consume an ordinal too, so the numbering stays aligned
 * with the decoded block sequence (block N of the decode always gets key
 * `bN`).
 */
export function assignActivityBlockKeys(
  units: readonly RenderUnit[],
): Map<number, string[]> {
  const keys = new Map<number, string[]>();
  let ordinal = 0;
  units.forEach((unit, unitIndex) => {
    if (unit.kind === "activity") {
      keys.set(
        unitIndex,
        unit.blocks.map(() => `b${ordinal++}`),
      );
    } else {
      ordinal += 1;
    }
  });
  return keys;
}

/**
 * A folded run of thinking/tool steps (ticket 46 — D3).
 *
 * Upstream (`WebuiActivityGroup`) renders this as ONE native `<details>`:
 * the whole summary row toggles the group (keyboard reachable for free),
 * the body carries a timeline spine on its left edge, and a `data-active`
 * attribute marks runs that still hold a running/pending tool. While a run
 * is active the group cannot be collapsed — the engine is mid-step, so the
 * process stays visible until the turn settles. This replaces the previous
 * two-button (text + separate chevron) `grid-template-rows` construction.
 *
 * Default-open follows the upstream orchestration
 * (`AssistantBody.tsx` renderActivityParts + `expandProcessByDefault`): a
 * mixed run (thoughts AND tools) opens expanded, a pure-tool run starts
 * collapsed, and inside a mixed run the nested thinking blocks start
 * collapsed (`collapseNestedThinking`) while a thoughts-only run starts
 * with its thinking block expanded.
 *
 * The body has no height cap and no scrollbar of its own (webui-parity 61,
 * G7). The reference stylesheet gives `.activity-group-items` `gap: 0`, a
 * 28px minimum row height and no `max-height` — the whole transcript
 * scrolls as one column, and a long tool run is simply long. Our previous
 * `max-h-[230px] overflow-y-auto` put a second scrollbar inside a page that
 * already scrolls, so a group cut its own steps off mid-list. Row height and
 * zero gap now come from `app/globals.css` (`.activity-group-items > *`),
 * matching the reference's `.webui-tool-row { min-height: 28px }`.
 *
 * webui-parity 61 (G4) adds an optional controlled mode: pass `expanded` +
 * `onExpandedChange` and the turn bar's chevron drives the group. Uncontrolled
 * is the default and is byte-for-byte the behaviour above.
 */
export function ActivityGroup({
  blocks,
  blockKeys,
  summary,
  t,
  onOpenFile,
  streaming = false,
  startedAtMs,
  expanded,
  onExpandedChange,
}: {
  blocks: TranscriptBlock[];
  /** Per-block stable React keys from `assignActivityBlockKeys` (see its
   *  docblock for why the within-group index is not stable mid-turn).
   *  Optional: falls back to the index for hand-built fixtures. */
  blockKeys?: string[];
  summary: ActivitySummary;
  t: (key: MessageKey) => string;
  onOpenFile: (path: string) => void;
  /** True while the engine is streaming THIS run's trailing thinking block
   *  (the tail unit of the transcript is an activity run whose last block
   *  is a thought). Forces the group and the thinking block open. */
  streaming?: boolean;
  /** `running.startedAt` from the snapshot — the anchor the streaming
   *  thinking row ticks its elapsed seconds from. Absent on cold load. */
  startedAtMs?: number | null;
  /** Turn-level expansion intent (webui-parity 61, G4). `undefined` — the
   *  default — leaves the group on its own state and its own initial value.
   *  A boolean puts the group under the turn bar's chevron, which drives
   *  every group of that turn as one block; see `TurnProcessDisclosure`. */
  expanded?: boolean;
  /** Required alongside `expanded`: with it the group is controlled, and a
   *  header click reports the new state instead of keeping it. */
  onExpandedChange?: (next: boolean) => void;
}) {
  const active = useMemo(() => isActivityGroupActive(blocks), [blocks]);
  // Mixed runs (thoughts + tools) open expanded, pure-tool runs collapsed —
  // see the component docblock. `useState` initialiser runs once per mount.
  const [ownExpanded, setOwnExpanded] = useState(() => summary.thinking > 0);
  const controlled = expanded !== undefined && onExpandedChange !== undefined;
  const expandedState = controlled ? expanded : ownExpanded;
  const hasTools = useMemo(() => blocks.some((block) => block.role === "tool"), [blocks]);

  // While a call is in flight upstream names it instead of listing categories
  // ("已使用 3 次工具｜bash"); once the turn settles it lists the per-category
  // contributions joined with ", " (「查看 2 个文件, 执行 1 条命令」).
  const label = summary.activeTool
    ? t("activity.activeTool")
        .replace("{{count}}", String(summary.tools))
        .replace("{{tool}}", summary.activeTool)
    : summary.contributions
        .map((entry) =>
          t((SUMMARY_CATEGORY_KEY[entry.category] ?? "activity.usedTools") as MessageKey).replace(
            "{{count}}",
            String(entry.count),
          ),
        )
        .join(", ");

  // The forced-open state (active tool, or streaming thought). While it
  // holds, a user click on the summary must not collapse the group.
  const forcedOpen = active || streaming;

  return (
    <div className="mb-4">
      <div className="message-animate-in group relative w-full">
        <div
          data-testid="activity-group-header-shell"
          className="desktop-text-ui-small flex w-full text-sm leading-5"
        >
          <details
            data-testid="activity-group"
            data-active={active ? "true" : undefined}
            className="min-w-0 flex-1"
            open={forcedOpen || expandedState}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              if (forcedOpen && !next) {
                // React does not re-apply an unchanged `open` attribute, so a
                // click during an active run would leave the DOM collapsed.
                // Snap it back — the "cannot collapse while running" rule.
                event.currentTarget.open = true;
                return;
              }
              if (controlled) onExpandedChange(next);
              else setOwnExpanded(next);
            }}
          >
            <summary
              data-testid="activity-group-header"
              className="group/header inline-flex min-w-0 max-w-full cursor-pointer list-none items-center gap-1 pr-1 text-left text-sm leading-5 tracking-normal [&::-webkit-details-marker]:hidden"
            >
              <span
                data-testid="activity-group-header-icon"
                className="inline-flex shrink-0"
              >
                <ToolIcon type={summary.iconType} className="h-4 w-4 text-text_default_tertiary" />
              </span>
              <span className="min-w-0 truncate text-text_default_tertiary group-hover/header:text-text_default_secondary">
                {label}
              </span>
              <span
                className={[
                  "-ml-1 flex h-4 w-4 shrink-0 items-center justify-center self-center text-text_label_tertiary_default transition-transform duration-200 ease-out group-hover/header:text-text_label_tertiary_hover",
                  forcedOpen || expanded ? "rotate-90" : "",
                ].join(" ")}
              >
                <Icon name="chevronRight" />
              </span>
            </summary>
            <div className="activity-group-body relative pt-2.5">
              <span className="timeline-spine" aria-hidden="true" />
              <div
                data-testid="activity-group-detail"
                className="activity-group-items flex flex-col gap-0"
              >
                {blocks.map((block, index) =>
                  block.role === "thinking" ? (
                    <ThinkingRow
                      key={blockKeys?.[index] ?? index}
                      block={block}
                      t={t}
                      // Only the trailing thought streams; earlier ones in the
                      // same run have already settled.
                      streaming={streaming && index === blocks.length - 1}
                      startedAtMs={startedAtMs}
                      initiallyOpen={!hasTools}
                    />
                  ) : (
                    <ToolCard key={blockKeys?.[index] ?? index} block={block} t={t} onOpenFile={onOpenFile} />
                  ),
                )}
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

/**
 * One thought (ticket 46 — D2).
 *
 * Upstream (`WebuiThinkingBlock`) is a native `<details>` whose summary row
 * reads icon + status copy + elapsed seconds + chevron: 「推理中...」 with a
 * live-ticking second counter while the thought streams, collapsing to
 * 「已完成推理」 + the settled total when the turn ends. The expanded body
 * renders through the Markdown pipeline (not plain text) and clamps behind
 * an 「展开 / 收起」 button once it exceeds 224px.
 *
 * Duration data: the wire transcript carries no per-thinking timestamps, so
 * the seconds tick from the snapshot's `running.startedAt` (the same
 * turn-level anchor upstream feeds `WebuiThinkingBlock` as
 * `processingStartedAtMs`). The last streamed value freezes in place as the
 * total when streaming ends; thoughts restored from a cold-loaded session
 * have no anchor and simply omit the seconds rather than invent them.
 */
function ThinkingRow({
  block,
  t,
  streaming = false,
  startedAtMs,
  initiallyOpen = false,
}: {
  block: TranscriptBlock;
  t: (key: MessageKey) => string;
  streaming?: boolean;
  startedAtMs?: number | null;
  initiallyOpen?: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(initiallyOpen);
  // Content-height clamp state — measured only while the body is visible.
  const [contentExpanded, setContentExpanded] = useState(false);
  const [contentOverflows, setContentOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const html = useMemo(() => renderMarkdown(block.text), [block.text]);
  const open = streaming || detailOpen;

  // Live seconds: tick once per second while streaming, anchored at the
  // turn's `startedAt`. When streaming stops the interval is cleared and the
  // last value stays as the settled total.
  useEffect(() => {
    if (!streaming || typeof startedAtMs !== "number") return undefined;
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [streaming, startedAtMs]);

  // Clamp measurement: the body only has a box once the details is open, so
  // measure (and observe) there. A ResizeObserver keeps the verdict honest
  // while streaming grows the text past the threshold mid-thought.
  useEffect(() => {
    const content = contentRef.current;
    if (!open || !content) return undefined;
    const measure = () =>
      setContentOverflows(content.scrollHeight > THINKING_CLAMP_HEIGHT_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open, block.text]);

  const statusLabel = streaming ? t("activity.thinkingLive") : t("activity.thinkingDone");
  const showSeconds = elapsed !== null && elapsed >= 1;

  return (
    <details
      className="webui-thinking-block py-2.5"
      data-testid="thinking-block"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (streaming && !next) {
          // Streaming keeps the thought expanded (React will not re-apply an
          // unchanged `open` attribute after a user click flipped the DOM).
          event.currentTarget.open = true;
          return;
        }
        setDetailOpen(next);
      }}
    >
      <summary
        data-testid="thinking-summary"
        className="group/thought inline-flex min-w-0 cursor-pointer list-none items-center gap-1 text-text_default_tertiary [&::-webkit-details-marker]:hidden"
      >
        <span className="inline-flex shrink-0" data-testid="thinking-summary-icon">
          <ToolIcon type="thinking" className="h-4 w-4 text-text_default_tertiary" />
        </span>
        <span
          className="min-w-0 truncate transition-colors group-hover/thought:text-text_default_secondary"
          data-thinking-status={streaming ? "live" : "done"}
        >
          {statusLabel}
        </span>
        {streaming ? (
          <span
            className="webui-thinking-live-status inline-flex shrink-0 items-center gap-1"
            data-testid="thinking-live-status"
          >
            <span className="thinking-live-dot" aria-hidden="true" />
          </span>
        ) : null}
        {showSeconds ? (
          <span className="webui-thinking-elapsed shrink-0 tabular-nums text-text_default_quaternary">
            {elapsed}s
          </span>
        ) : null}
        <span
          className={[
            "flex h-4 w-4 shrink-0 items-center justify-center transition-transform duration-200 ease-out",
            open ? "rotate-0" : "-rotate-90",
          ].join(" ")}
        >
          <Icon name="caretDown" size={12} />
        </span>
      </summary>
      <div className="ml-[7.5px] border-l-[0.5px] border-border_default pl-[13px] pt-2">
        <div
          ref={contentRef}
          className={[
            "webui-thinking-detail-content",
            contentOverflows && !contentExpanded ? "is-clamped" : "",
          ].join(" ")}
        >
          <div className="text-activity-detail matrix-markdown matrix-markdown--thinking text-text_default_secondary">
            <MarkdownHtml html={html} />
          </div>
        </div>
        {contentOverflows ? (
          <button
            type="button"
            data-testid="thinking-expand"
            className="desktop-text-ui-small mt-1 text-text_default_tertiary transition-colors hover:text-text_default_secondary"
            onClick={() => setContentExpanded((value) => !value)}
          >
            {contentExpanded ? t("activity.collapse") : t("activity.expand")}
          </button>
        ) : null}
      </div>
    </details>
  );
}

/**
 * A single tool call (ticket 46 — D4, PR3).
 *
 * Upstream (`WebuiToolRow`) is a native `<details>`: the summary row
 * carries the human label from the projection table, the status chip
 * (hidden once completed — the reference keeps settled rows clean), and,
 * for read-style calls, the resource path with its full form on the
 * `title` attribute. The body splits into 「输入 / 结果 / 错误」
 * sections, each clamped at 2000 characters by `clampDetailText`.
 *
 * Switching the header from a `<button>` to `<details>/<summary>` (PR3)
 * also fixes the invalid nested-button HTML flagged in QA: the subagent
 * badge is a real `<button>` and used to sit INSIDE the header button.
 */
function ToolCard({
  block,
  t,
  onOpenFile,
}: {
  block: TranscriptBlock;
  t: (key: MessageKey) => string;
  onOpenFile: (path: string) => void;
}) {
  // Bilingual label table lookup needs the active locale (the reference
  // hardcodes its Chinese desktop copy; this frontend is bilingual).
  const { locale } = useLocale();
  const status = normalizeToolStatus(block.toolStatus);
  const statusLabelKey =
    status === "unknown" ? undefined : TOOL_STATUS_LABEL_KEY[status];
  // The reference hides the status chip entirely once a call completes.
  const showStatusLabel = status !== "completed" && statusLabelKey !== undefined;
  const label = toolCallLabel(block.toolName, locale);
  const iconType = iconByName(block.toolName);
  // Read-style calls lift their resource path onto the summary row.
  // The args derivation first (live traffic: `→ read  {"path": …}`),
  // falling back to the decoder-collected `@ path` lines when the
  // header carried no args — see toolSummaryResourcePath.
  const resourcePath = toolSummaryResourcePath(
    block.toolName,
    block.toolArgs,
    block.toolPaths ?? [],
  );

  const output = (block.toolOutput ?? []).join("\n");
  // The wire writes a failed call's error text as ordinary output lines
  // under the tool header, so the error SECTION is the output rendered
  // in error styling (and the result section is suppressed).
  const errorText =
    status === "error" ? (output || t("tool.executionFailed")) : undefined;
  const resultText = status === "error" ? undefined : (output || undefined);
  // Ticket 46 P4 decision: the args move OFF the summary row into the
  // body's 「输入」 section, matching the reference layout.
  const inputText = (block.toolArgs ?? "").trim() || undefined;
  const paths = block.toolPaths ?? [];
  const hasDetail = Boolean(
    inputText || resultText || errorText || paths.length > 0 || status === "running",
  );

  // Slice 06 — Agent Team: when this tool is the parent of a subagent
  // dispatch, attach the live status badge + jump reference from the
  // server's `recentSubagents` array. The match is by `toolCallId`
  // (carried on the block by the `##tc:` marker the decoder
  // consumes) so a session that spawned multiple subagents badges
  // each `→ task` line with its OWN child — matching by tool NAME
  // would badge every line with the newest child, which is wrong.
  // See `lib/agent-team-lookup.ts#findSubagentForBlock` for the
  // matching rule and its unit tests.
  const store = useSessionContext();
  const recent = store?.state?.recentSubagents;
  const subagent = findSubagentForBlock(recent, block);

  // Subagent badge — label and glyph are resolved through i18n so
  // both locales actually differ (the previous slice hardcoded English
  // glyphs here, leaving the file orphaned — the acceptance fix wires
  // the keys through `tAgentTeam` / `agentLabel`).
  const badge = subagent ? badgeLabelAndGlyph(locale, subagent.status) : null;
  const agentNameLabel = subagent ? agentLabel(locale, subagent.agentName) : null;
  const subagentLabel = badge && agentNameLabel
    ? `${badge.glyph} ${agentNameLabel}`
    : null;

  return (
    <details
      data-testid="tool-card"
      data-tool-status={status}
      className="group/tool rounded-xl border border-border_default bg-bg_grouped_tertiary"
    >
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-left [&::-webkit-details-marker]:hidden">
        {hasDetail ? (
          <span className="flex h-3 w-3 shrink-0 items-center justify-center text-text_label_tertiary_default transition-transform duration-200 ease-out group-open/tool:rotate-90">
            <Icon name="chevronRight" size={12} />
          </span>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <ToolIcon
          type={iconType}
          className={[
            "h-4 w-4 shrink-0",
            status === "error" ? "text-text_status_error" : "text-text_default_tertiary",
          ].join(" ")}
        />
        <span className="font-family-code truncate text-caption-small-strong text-text_default_primary">
          {label}
        </span>
        {showStatusLabel && statusLabelKey !== undefined ? (
          <span
            className={[
              "flex-none text-caption-small-strong",
              status === "error"
                ? "text-text_status_error"
                : status === "running"
                  ? "text-text_default_accent"
                  : "text-text_default_tertiary",
            ].join(" ")}
            data-testid="tool-card-status"
          >
            · {t(statusLabelKey as MessageKey)}
          </span>
        ) : null}
        {resourcePath ? (
          <span
            className="text-caption-small-strong min-w-0 flex-1 truncate text-text_default_secondary"
            title={resourcePath}
            data-testid="tool-card-resource-path"
          >
            {resourceDisplayName(resourcePath)}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {subagent ? (
          <button
            type="button"
            title={subagent.sessionId}
            data-testid="tool-card-subagent-badge"
            data-subagent-session={subagent.sessionId}
            data-subagent-status={subagent.status}
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
              if (subagent.sessionId) {
                void switchSession(subagent.sessionId).catch(() => {});
              }
            }}
            className={[
              "flex-none cursor-pointer rounded-md px-1.5 py-px text-caption-small-strong transition-colors",
              subagent.status === "running"
                ? "bg-bg_status_accent text-text_default_accent hover:bg-bg_interaction_tertiary_hover"
                : subagent.status === "failed"
                  ? "bg-bg_status_error text-text_status_error hover:bg-bg_interaction_tertiary_hover"
                  : "bg-bg_grouped_tertiary_elevated text-text_default_secondary hover:bg-bg_interaction_tertiary_hover",
            ].join(" ")}
          >
            {subagentLabel}
          </button>
        ) : null}
      </summary>

      {hasDetail ? (
        <div className="border-t border-border_light px-2.5 py-1.5">
          {paths.length > 0 ? (
            <div className="mb-1 flex flex-wrap gap-1">
              {paths.map((path, pathIndex) => (
                <button
                  // A tool can touch the same path twice (edit + verify);
                  // the bare path would collide as a React key.
                  key={`${path}-${pathIndex}`}
                  type="button"
                  title={path}
                  data-testid="tool-card-path"
                  data-path={path}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenFile(path);
                  }}
                  className="tool-resource-reference max-w-[260px] truncate rounded-md bg-bg_grouped_tertiary_elevated px-1.5 py-0.5 text-caption-small-strong text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border_accent"
                >
                  {path}
                </button>
              ))}
            </div>
          ) : null}
          {status === "running" && !inputText && !resultText && !errorText ? (
            <div
              className="text-caption-small-strong text-text_default_tertiary"
              data-testid="tool-card-running"
            >
              {t("tool.runningDetail")}
            </div>
          ) : null}
          {inputText ? (
            <ToolDetailSection label={t("tool.section.input")} value={inputText} />
          ) : null}
          {resultText ? (
            <ToolDetailSection label={t("tool.section.result")} value={resultText} />
          ) : null}
          {errorText ? (
            <ToolDetailSection label={t("tool.section.error")} value={errorText} error />
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

/** One 「输入 / 结果 / 错误」 body section of a tool card. The error
 *  section renders its label and body in the error colour; every body
 *  clamps at `TOOL_DETAIL_CHAR_LIMIT` (2000) with a `...` suffix, the
 *  reference truncation rule, and at 180px of height, the reference
 *  `.webui-tool-detail-section pre` cap (webui-parity 61, G7) — the one
 *  scroll container the desktop still keeps inside a group. */
function ToolDetailSection({
  label,
  value,
  error = false,
}: {
  label: string;
  value: string;
  error?: boolean;
}) {
  return (
    <section className="mb-1.5 last:mb-0" data-testid={error ? "tool-card-error-section" : undefined}>
      <div
        className={[
          "text-caption-small-strong mb-0.5",
          error ? "text-text_status_error" : "text-text_default_tertiary",
        ].join(" ")}
      >
        {label}
      </div>
      <pre
        className={[
          "codeblock-code thin-scrollbar max-h-[180px] overflow-auto rounded-lg p-2 text-caption-small-strong whitespace-pre-wrap",
          error ? "text-text_status_error" : "text-text_default_secondary",
        ].join(" ")}
      >
        {clampDetailText(value)}
      </pre>
    </section>
  );
}

/**
 * Whole-turn process bar (ticket 46 — D6, PR3), lifted here from
 * `chat.tsx` with the reference (`WebuiTurnProcess`) summary restored.
 *
 * The summary row is the composite 「思考 N 次，用了 M 次工具，共执行
 * X 分 Y 秒」; parts with a zero count drop out. A live turn renders
 * 「已执行 N 秒」 and re-renders once per second; a settled turn adds
 * the output rate `N token/s` on the right. A 0.5px separator closes
 * the bar from below, the reference rule.
 *
 * Duration sources: a settled turn reads `processedDuration` (the
 * `§§ processed_duration` marker the server writes at finalise); a
 * live turn ticks from `running.startedAt`. The settled state is
 * TRANSIENT: the marker reaches the front-end only in the finalise
 * snapshot and does not survive the server's session-state rebuild, so
 * after a reload (or once the stream settles) no `processedDuration`
 * remains to render — see the docs' turn-bar section. The rate is
 * DERIVED, not measured tokens: the wire transcript carries no per-turn
 * token count (the ACP usage event only accumulates session totals
 * server-side, and this ticket's red line forbids touching the four
 * server files), so the number is `answerChars / seconds` — the same
 * fallback formula the reference applies when its runtime reports no
 * `usage.outputTokens`. See `lib/turn-stats.ts`.
 *
 * The turn bar's chevron (webui-parity 61, G4). The reference
 * (`WebuiTurnProcess`, `TranscriptPrimitives.tsx`) renders the same
 * summary row as a `<button>` carrying a `turn-process-chevron` glyph that
 * rotates 90° when the turn's process is expanded, and renders plain
 * text with no toggle when the turn has nothing to expand. Both halves of
 * that are restored here:
 *
 *   - the gate is `hasExpandableTurnContent(stats)` — the same counts the
 *     composite summary already prints, so a turn with no thought and no
 *     tool call (a plain ping/pong) keeps a bare summary line;
 *   - the live turn never shows the toggle. The reference reaches the same
 *     state through its `forceExpanded` / `disabled` props, whose docblock
 *     says those modes "suppress the toggle and keep available details
 *     open", and here it is also the only honest option: an activity group
 *     holding a running tool is force-open and cannot be collapsed, so a
 *     chevron on the live bar would be a control that cannot act.
 *
 * What expanding shows is the turn's process — its thinking and tool
 * steps, which live in the `ActivityGroup`s above the bar. This is the
 * reference's disclosure body without its DOM nesting: the reference puts
 * those steps INSIDE the collapsible region, and ticket 61 risk 2 records
 * that the agreed shape here is state coordination instead, so the groups
 * keep their own folding semantics and the chevron drives them as one
 * block. The turn's answer text is unaffected either way — the reference
 * keeps it outside the collapse through `collapsedContent`, and ours is
 * never inside it.
 *
 * `expanded` is `undefined` until the user touches the chevron: the turn's
 * groups keep their own defaults (a mixed run open, a pure-tool run
 * collapsed) exactly as before this ticket. The first click inverts
 * `defaultExpanded`, so it always changes something visible.
 * The `turn-process-disclosure` testid is kept.
 */
export function TurnProcessDisclosure({
  stats,
  processedDurationMs,
  t,
  active = false,
  startedAtMs,
  expanded,
  defaultExpanded = true,
  onExpandedChange,
}: {
  stats: TurnStats;
  /** Settled turns only — `block.processedDuration` in milliseconds. */
  processedDurationMs?: number;
  t: (key: MessageKey) => string;
  /** True while the engine is still streaming THIS turn. */
  active?: boolean;
  /** `running.startedAt` — the live turn's tick anchor. */
  startedAtMs?: number | null;
  /** The user's chevron intent for this turn's activity groups; `undefined`
   *  until they touch it, which leaves the groups on their own defaults. */
  expanded?: boolean;
  /** The expansion the turn's groups have by default — the target the first
   *  click inverts. See `computeTurnLayout#defaultExpandedByTurn`. */
  defaultExpanded?: boolean;
  /** Called with the next expansion when the chevron is pressed. Absent means
   *  the bar is not wired to a turn (the live bar), and no toggle renders. */
  onExpandedChange?: (next: boolean) => void;
}) {
  // Live seconds render 0 on the first (SSR + hydration) frame and
  // start ticking from the effect — never from Date.now() during
  // render, which would desync server and client markup.
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    const tick = () => {
      if (typeof startedAtMs !== "number") return;
      setLiveSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAtMs]);

  const seconds = active
    ? (liveSeconds ?? 0)
    : typeof processedDurationMs === "number"
      ? Math.max(0, Math.floor(processedDurationMs / 1000))
      : 0;

  // 「M 分 N 秒」 over a minute, bare seconds under it — the reference
  // duration formatter.
  const durationLabel =
    seconds >= 60
      ? t("turn.duration.minutes")
          .replace("{{minutes}}", String(Math.floor(seconds / 60)))
          .replace("{{seconds}}", String(seconds % 60))
      : t("turn.duration.seconds").replace("{{seconds}}", String(seconds));

  const parts: string[] = [];
  if (stats.thinking > 0) {
    parts.push(t("activity.thoughtSteps").replace("{{count}}", String(stats.thinking)));
  }
  if (stats.tools > 0) {
    parts.push(t("turn.usedTools").replace("{{count}}", String(stats.tools)));
  }
  const elapsedTemplate = active ? t("turn.elapsedActive") : t("turn.elapsedTotal");
  const summary = [...parts, elapsedTemplate.replace("{{duration}}", durationLabel)].join("，");

  const outputRate =
    !active && seconds > 0 && stats.answerChars > 0
      ? Math.round(stats.answerChars / seconds)
      : null;

  // The chevron exists only for a settled turn that HAS process steps and a
  // handler to drive them with — see the docblock's G4 section.
  const canToggle = !active && hasExpandableTurnContent(stats) && !!onExpandedChange;
  const processExpanded = expanded ?? defaultExpanded;

  const summaryText = (
    <span
      className="text-activity-body-small flex items-center gap-1 py-1 text-center text-sm font-normal leading-5 tracking-normal text-text_label_tertiary_default"
      data-testid="turn-process-summary-text"
      data-summary-text={summary}
    >
      {summary}
    </span>
  );

  return (
    <section className="pt-2" data-testid="turn-process-disclosure">
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-2"
        data-testid="turn-process-summary"
      >
        {canToggle ? (
          <button
            type="button"
            aria-expanded={processExpanded}
            data-testid="turn-process-trigger"
            onClick={() => onExpandedChange?.(!processExpanded)}
            className="group/turn-process text-activity-body-small flex cursor-pointer items-center gap-1 py-1 text-center text-sm font-normal leading-5 tracking-normal text-text_label_tertiary_default transition-colors hover:text-text_label_tertiary_hover"
          >
            {summaryText}
            <span
              data-testid="turn-process-chevron"
              className={[
                "-ml-1 flex h-4 w-4 shrink-0 items-center justify-center self-center text-icon_interaction_tertiary_default transition-transform duration-200 ease-out group-hover/turn-process:text-icon_interaction_tertiary_hover",
                processExpanded ? "rotate-90" : "",
              ].join(" ")}
            >
              <Icon name="chevronRight" size={16} />
            </span>
          </button>
        ) : (
          summaryText
        )}
        {!active && outputRate !== null ? (
          <span
            className="text-size_12 ml-auto text-text_default_tertiary tabular-nums"
            data-testid="turn-output-rate"
          >
            <span className="sr-only">{t("turn.outputRateSr")}</span>
            {outputRate} token/s
          </span>
        ) : null}
      </div>
      <div
        className="mt-2 border-b-[0.5px] border-border_default"
        data-testid="turn-process-separator"
        aria-hidden="true"
      />
    </section>
  );
}
