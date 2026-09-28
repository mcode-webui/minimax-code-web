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
  type SummaryIconType,
  type TranscriptBlock,
} from "../lib/transcript";
import { Icon } from "./icons";
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
 */
export function ActivityGroup({
  blocks,
  summary,
  t,
  onOpenFile,
  streaming = false,
  startedAtMs,
}: {
  blocks: TranscriptBlock[];
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
}) {
  const active = useMemo(() => isActivityGroupActive(blocks), [blocks]);
  // Mixed runs (thoughts + tools) open expanded, pure-tool runs collapsed —
  // see the component docblock. `useState` initialiser runs once per mount.
  const [expanded, setExpanded] = useState(() => summary.thinking > 0);
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
            open={forcedOpen || expanded}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              if (forcedOpen && !next) {
                // React does not re-apply an unchanged `open` attribute, so a
                // click during an active run would leave the DOM collapsed.
                // Snap it back — the "cannot collapse while running" rule.
                event.currentTarget.open = true;
                return;
              }
              setExpanded(next);
            }}
          >
            <summary
              data-testid="activity-group-header"
              data-message-collapse-trigger
              className="group/header inline-flex min-w-0 max-w-full cursor-pointer list-none items-center gap-1 pr-1 text-left text-sm leading-5 tracking-normal [&::-webkit-details-marker]:hidden"
            >
              <span
                data-testid="activity-group-header-icon"
                className="inline-flex shrink-0"
              >
                <CategoryIcon type={summary.iconType} />
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
                className="activity-group-items flex max-h-[230px] flex-col gap-1.5 overflow-y-auto scrollbar-hide"
              >
                {blocks.map((block, index) =>
                  block.role === "thinking" ? (
                    <ThinkingRow
                      key={index}
                      block={block}
                      t={t}
                      // Only the trailing thought streams; earlier ones in the
                      // same run have already settled.
                      streaming={streaming && index === blocks.length - 1}
                      startedAtMs={startedAtMs}
                      initiallyOpen={!hasTools}
                    />
                  ) : (
                    <ToolCard key={index} block={block} t={t} onOpenFile={onOpenFile} />
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
          <CategoryIcon type="thinking" />
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
 * The leading icon for an ActivityGroup header or a ToolCard.
 *
 * Upstream (`90321` byte 2085700 + icon module 32709) renders these as
 * precise 16×16 SVGs from a 16-icon registry keyed by `iconType`. The full
 * SVG catalog lives in the icon registry and is not yet pulled into this
 * frontend; for now we render a unicode glyph sized at 16 so the leading-edge
 * slot is visible and `data-tool-icon-type` is honoured. When the precise
 * paths land in `icons.tsx`, swap the glyph for `<Icon name={type} ... />`
 * behind the same `type` key — the data attributes and sizing are stable.
 */
function CategoryIcon({ type }: { type: SummaryIconType }) {
  const glyph = CATEGORY_GLYPH[type] ?? "•";
  return (
    <span
      aria-hidden="true"
      data-tool-icon-type={type}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text_default_tertiary"
      style={{ fontSize: 14, lineHeight: 1 }}
    >
      {glyph}
    </span>
  );
}

const CATEGORY_GLYPH: Record<SummaryIconType, string> = {
  "plugin": "🧩",
  "file-edit": "✎",
  "edit": "✎",
  "agent": "◉",
  "skill": "✦",
  "web": "⌘",
  "search": "◎",
  "thinking": "◌",
  "file": "▢",
  "command": "›_",
  "tool": "◇",
  "logo": "◈",
  "bot": "◉",
  "summary": "≡",
  "code": "⟨⟩",
  "memory": "❒",
  "alert": "△",
};

/**
 * A single tool call: the `→ name {args}` header plus the output the server wrote
 * beneath it. Output collapses by default — a tool can emit thousands of lines, and
 * upstream keeps it behind a disclosure for the same reason.
 */
function ToolCard({ block, t, onOpenFile }: { block: TranscriptBlock; t: (key: MessageKey) => string; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const output = block.toolOutput ?? [];
  const paths = block.toolPaths ?? [];
  const hasBody = output.length > 0 || paths.length > 0;
  const iconType = iconByName(block.toolName);
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
  const { locale } = useLocale();
  const recent = store?.state?.recentSubagents;
  const subagent = findSubagentForBlock(recent, block);

  const statusKey =
    block.toolStatus === "failed"
      ? "tool.status.failed"
      : block.toolStatus === "in_progress"
        ? "tool.status.in_progress"
        : "tool.status.completed";

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
    <div className="rounded-xl border border-border_default bg-bg_grouped_tertiary">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={open}
        data-tool-icon-type={iconType}
        onClick={() => hasBody && setOpen((value) => !value)}
      >
        <CategoryIcon type={iconType} />
        {hasBody ? (
          <span className={["transition-transform duration-200", open ? "rotate-90" : ""].join(" ")}>
            <Icon name="chevronRight" size={12} />
          </span>
        ) : (
          <span className="w-3" />
        )}
        <span className="font-family-code truncate text-caption-small-strong text-text_default_primary">
          {block.toolName}
        </span>
        <span
          className={[
            "flex-none text-caption-small-strong",
            block.toolStatus === "failed"
              ? "text-text_status_error"
              : block.toolStatus === "in_progress"
                ? "text-text_default_accent"
                : "text-text_default_tertiary",
          ].join(" ")}
        >
          {t(statusKey)}
        </span>
        {subagent ? (
          <button
            type="button"
            title={subagent.sessionId}
            data-testid="tool-card-subagent-badge"
            data-subagent-session={subagent.sessionId}
            data-subagent-status={subagent.status}
            onClick={(event) => {
              event.stopPropagation();
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
        {block.toolArgs ? (
          <span className="min-w-0 flex-1 truncate text-caption-small-strong text-text_default_tertiary">
            {block.toolArgs}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
      </button>

      {open && hasBody ? (
        <div className="border-t border-border_light px-2.5 py-1.5">
          {paths.length > 0 ? (
            <div className="mb-1 flex flex-wrap gap-1">
              {paths.map((path) => (
                <button
                  key={path}
                  type="button"
                  title={path}
                  data-testid="tool-card-path"
                  data-path={path}
                  onClick={() => onOpenFile(path)}
                  className="tool-resource-reference max-w-[260px] truncate rounded-md bg-bg_grouped_tertiary_elevated px-1.5 py-0.5 text-caption-small-strong text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border_accent"
                >
                  {path}
                </button>
              ))}
            </div>
          ) : null}
          {output.length > 0 ? (
            <pre className="codeblock-code thin-scrollbar max-h-[320px] overflow-auto rounded-lg p-2 text-caption-small-strong whitespace-pre-wrap text-text_default_secondary">
              {output.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
