"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { renderMarkdown } from "@/lib/markdown";
import { MarkdownHtml } from "./markdown-html";
import "../lib/mermaid-renderer"; // registers the mermaid language renderer
import "../lib/math-renderer"; // registers KaTeX (inline $…$, $$…$$, ```math fences)
import { reportActionError } from "@/lib/action-errors";
import {
  decodeTranscript,
  groupActivity,
  type TranscriptBlock,
} from "@/lib/transcript";
import { Icon } from "./icons";
import { useChatVirtualization } from "./chat-virtual-list";
import { ActivityPulse, isSessionActivityActive } from "./loading-states";
import { ActivityGroup } from "./activity-group";
import { useSessionContext } from "@/lib/store";
import { readScrollPosition as readPersistedScroll } from "@/lib/persist";
import type { Locale, MessageKey } from "@/lib/i18n";
import { WorkspaceChipDropdown } from "./workspace-picker";

/**
 * Conversation surface.
 *
 * Both message models are copied from the upstream renderer, and they are not the
 * same shape:
 *
 *   user       right-aligned bubble — `justify-end` wrapper, `bg-bg_grouped_tertiary`
 *              on `px-3 py-2 rounded-[16px] w-fit max-w-[80%]`, body in
 *              `.message-container-user-text`
 *   assistant  no bubble at all — a collapsible activity summary line followed by
 *              markdown rendered through `.matrix-markdown`
 *
 * Slice 25 — the conversation column has no ceiling (it absorbs all
 * leftover). The readable measure cap (960px, centred) lives on the
 * content: `mx-auto max-w-[960px]` on `.message-container-chat-content`.
 * At viewports where the column is narrower than 960 (1280–1920 in
 * every state we measured), the cap does not bite and the content
 * fills the column 1:1 minus the column's padding. At wider viewports
 * the cap bites: the content sits at 960 centred, and the slack
 * above it splits evenly left and right — no dead band dumping on
 * one side. 960px is the concrete measure: ~80 characters at the
 * ~12px default chat font, comfortably above the 768 default for
 * typical viewports while bounding the line length at the wide
 * extreme. Message bubbles keep their existing `max-w-[80%]` (the
 * upstream measure) and do not re-stack. The 743px figure belongs
 * to the home screen, not the conversation.
 */

interface ChatProps {
  t: (key: MessageKey) => string;
  locale: Locale;
  /**
   * Optional webui-parity 07 hook: the page tells the chat about the
   * scroll position to restore and receives scroll updates to persist.
   *
   * Both directions are optional and disabled by default — slice 12 owns
   * this file, so the wiring is additive only. The page wires
   * `onScrollPersist` to its `lib/persist.ts` scroll key, and supplies
   * the remembered top via `initialScrollTop` when the active session
   * id actually changes.
   */
  initialScrollTop?: number;
  onScrollPersist?: (scrollTop: number) => void;
  /**
   * The session id this Chat belongs to. Used to re-read the saved
   * scroll position when the SSE snapshot delivers the active
   * session AFTER the component first mounted (the cold-load
   * sequence is: page mounts with state=null → SSE arrives →
   * sessionId becomes non-null). Without this hook, the
   * `initialScrollTop` useState initializer only runs once and
   * captures `0` from the no-active-session pre-SSE render.
   */
  sessionKey?: string | null;
  /**
   * Open a file in the right-hand preview pane (`open.file.in.web`,
   * webui-parity 12). Called from the turn-summary's per-file paths
   * surfaced inside the `ActivityGroup` body — the tree entry point
   * calls the same action from `components/panels.tsx#FileRow`. The
   * page-level handler is responsible for opening the right panel
   * when it is currently closed.
   *
   * Optional because the home screen (`HomeState`) does not render a
   * transcript with tool cards; the default no-op keeps the surface
   * trivial there.
   */
  onOpenFile?: (path: string) => void;
}

export function Chat({
  t,
  locale,
  initialScrollTop,
  onScrollPersist,
  sessionKey,
  onOpenFile = () => {},
}: ChatProps) {
  const { state } = useSessionContext();
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Decode, then fold each run of thinking/tool blocks into one activity group so
  // the transcript renders the way upstream lays it out. The decoder needs
  // the workspace dir (slice 20) so a relative path the agent typed
  // (`src/foo.ts`) lands as `/ws/src/foo.ts` and the chip click resolves.
  const workspaceDir = state?.workspace?.dir ?? null;
  const units = useMemo(
    () =>
      groupActivity(state ? decodeTranscript(state.chat, { workspaceDir }) : []),
    [state, workspaceDir],
  );

  // Global session-is-running state: when true, message-action rows are hidden
  // everywhere. The copy button has its own per-block `!isStreaming` check
  // inside the row, but the row container itself is gated here. Read off
  // `state.running.active` (set by mcode-acp/exec `finalize` and the SSE bus)
  // so the UI follows the engine, not a derived transcript signal.
  const sessionRunning = state?.running.active ?? false;

  // Ticket 46 (D2/D3) — which activity run is streaming its thoughts right
  // now. The wire transcript carries no per-block streaming flag for thinking
  // (the `▍` cursor only marks the trailing assistant block), so the render
  // layer derives it: the session is running AND the transcript's tail unit
  // is an activity run whose last block is a thought — i.e. the engine is
  // producing thinking and has not yet emitted any assistant text or tool
  // call for this turn. That run's thinking block then renders its live
  // 「推理中...」+ ticking-seconds summary and stays force-expanded.
  const streamingActivityIndex = useMemo(() => {
    if (!sessionRunning) return -1;
    const tail = units[units.length - 1];
    if (!tail || tail.kind !== "activity") return -1;
    const last = tail.blocks[tail.blocks.length - 1];
    return last?.role === "thinking" ? units.length - 1 : -1;
  }, [units, sessionRunning]);
  // `running.startedAt` is the turn-level anchor the streaming thinking row
  // ticks its elapsed seconds from (the same semantics upstream feeds
  // `WebuiThinkingBlock` as `processingStartedAtMs`). Null once the turn
  // settles, absent on a cold-loaded session.
  const runningStartedAt = state?.running.startedAt ?? null;

  // Windowed rendering: above VIRTUAL_LIST_THRESHOLD (200) units we slice the
  // transcript to a visible window around the user's scroll position. The hook
  // owns the scroll/resize listeners; `stuck` uses the 16 px threshold so the
  // "jump to latest" pill does not flicker on a single wheel tick.
  const { window: virtWindow, stuck } = useChatVirtualization(scrollerRef, units.length);
  const visibleUnits = useMemo(
    () =>
      virtWindow.useVirtual
        ? units.slice(virtWindow.startIdx, virtWindow.endIdx)
        : units,
    [units, virtWindow.useVirtual, virtWindow.startIdx, virtWindow.endIdx],
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Webui-parity 07 — scroll position save (additive; slice 12 owns
  // this file). The page supplies `onScrollPersist`; we forward every
  // scroll event with a debounce so a long scroll does not flood
  // localStorage. The same debounce also covers the resize-driven
  // recompute path: when the virtual window moves because the
  // viewport resized (not the user), scrollTop is unchanged so the
  // write coalesces anyway.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const persist = onScrollPersist;
    if (!persist) return;
    const el = scrollerRef.current;
    if (!el) return;
    let timer: number | null = null;
    const onScroll = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        const target = scrollerRef.current;
        if (!target) return;
        persist(target.scrollTop);
      }, 100);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
  }, [onScrollPersist]);

  // Webui-parity 07 — scroll position restore. Re-runs whenever:
  //   1. The active session id changes (the page supplies `sessionKey`).
  //   2. The visible unit count changes — we wait for the transcript to
  //      settle before jumping, otherwise the scroller clamps a too-
  //      large scrollTop to its (smaller) scrollHeight and ends up at
  //      the bottom.
  //
  // The persisted position is read from localStorage on every session
  // id change, NOT from the `initialScrollTop` useState initializer,
  // because the SSE snapshot delivers the active session AFTER Chat
  // mounts — the initializer would capture `0` from a state=null
  // first render and never re-fire.
  const restoredRef = useRef<string | null>(null);
  const targetScrollRef = useRef<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionKey) {
      targetScrollRef.current = null;
      restoredRef.current = null;
      return;
    }
    const explicit = typeof initialScrollTop === "number" && Number.isFinite(initialScrollTop) ? initialScrollTop : null;
    const saved = readPersistedScroll(sessionKey);
    const best = explicit !== null && explicit > 0 ? explicit : saved;
    targetScrollRef.current = best > 0 ? best : null;
    restoredRef.current = null;
  }, [sessionKey, initialScrollTop]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = targetScrollRef.current;
    if (target === null) return;
    if (restoredRef.current === sessionKey) return;
    const raf = window.requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) return;
      const clamped = Math.min(target, el.scrollHeight);
      if (clamped <= 0) return;
      el.scrollTo({ top: clamped, behavior: "auto" });
      restoredRef.current = sessionKey ?? null;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [units.length, sessionKey]);

  // The action row lives ONCE at the tail of the transcript, not inside every
  // block. It reveals when the chat has any assistant content AND the session
  // is idle. A user prompt at the tail means we are waiting on the engine, so
  // the running gate hides the row during streaming; the "have any assistant
  // text" gate hides it before the first reply.
  //
  // The text fed to *copy* is the last assistant plain block's text (walking
  // units backward), so a freshly-settled turn with a closing ActivityGroup
  // still gives the user the final reply text — the row sits under the
  // ActivityGroup in the layout, not under the assistant plain block it copied.
  const trailingAssistant = useMemo(() => {
    for (let i = units.length - 1; i >= 0; i -= 1) {
      const u = units[i];
      if (!u || u.kind === "activity") continue;
      if (u.block.role === "assistant") return u.block;
    }
    return null;
  }, [units]);
  const showActions = !!trailingAssistant && !sessionRunning;

  return (
    <div className="min-h-0 flex-1 px-4 sm:px-6">
      <div className="relative h-full w-full flex-1 overflow-visible">
        <div
          ref={scrollerRef}
          className="scrollbar-hide relative h-full w-full overflow-x-hidden overflow-y-scroll"
        >
          {/* Slice 25 — measure cap lives on the CONTENT, not the
              column. The column absorbs all leftover (no ceiling);
              the chat stream is capped at 960px (a comfortable
              reading measure, ~80 chars at ~12px chat font) and
              centred with `mx-auto`. At viewports where the
              column is narrower than 960 the cap doesn't bite
              and the content fills the column 1:1; at wider
              viewports the cap bites and the slack above 960
              splits evenly left and right (no dead band dumping
              on one side). */}
          <div className="message-container-chat-content mx-auto w-full max-w-[960px] px-4">
            <div className="min-h-[10px] w-full" />
            {units.length === 0 ? (
              <p className="py-6 text-center text-caption-small-strong text-text_default_tertiary">
                {t("chat.empty")}
              </p>
            ) : null}
            {virtWindow.useVirtual && virtWindow.topSpacer > 0 ? (
              <div aria-hidden="true" data-testid="chat-virtual-top-spacer" style={{ height: virtWindow.topSpacer }} />
            ) : null}
            {visibleUnits.map((unit, localIndex) => {
              // Key by the *original* unit index so React keeps the same DOM
              // nodes when the window shifts (a unit that is in both the old
              // and new slice should not remount). The window slice only
              // changes startIdx / endIdx; the indices within the slice
              // (= `localIndex + startIdx`) are stable when the window is.
              const originalIndex = virtWindow.useVirtual
                ? virtWindow.startIdx + localIndex
                : localIndex;
              return unit.kind === "activity" ? (
                <ActivityGroup
                  key={originalIndex}
                  blocks={unit.blocks}
                  summary={unit.summary}
                  t={t}
                  onOpenFile={onOpenFile}
                  streaming={originalIndex === streamingActivityIndex}
                  startedAtMs={runningStartedAt}
                />
              ) : (
                <Block key={originalIndex} block={unit.block} t={t} />
              );
            })}
            {virtWindow.useVirtual && virtWindow.bottomSpacer > 0 ? (
              <div aria-hidden="true" data-testid="chat-virtual-bottom-spacer" style={{ height: virtWindow.bottomSpacer }} />
            ) : null}
            <ThinkingIndicator t={t} />
            {showActions ? (
              <div className="mb-4">
                <MessageActions
                  text={trailingAssistant?.text ?? ""}
                  t={t}
                  ts={trailingAssistant?.ts}
                  locale={locale}
                  isStreaming={false}
                  forceReveal={true}
                  sessionRunning={false}
                />
              </div>
            ) : null}
          </div>
        </div>

        {stuck ? (
          <button
            type="button"
            aria-label={t("chat.scrollBottom")}
            title={t("chat.scrollBottom")}
            onClick={scrollToBottom}
            data-testid="chat-scroll-bottom"
            className="absolute right-1/2 bottom-3 z-10 flex size-9 translate-x-1/2 items-center justify-center rounded-full border border-border_default bg-bg_default_primary text-icon_default_primary shadow-shadow_default transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            <Icon name="arrowUp" size={16} className="rotate-180" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Block({
  block,
  t,
}: {
  block: TranscriptBlock;
  t: (key: MessageKey) => string;
}) {
  // User turns are the only ones that get a bubble.
  if (block.role === "user") {
    return (
      <div className="mb-4">
        <div className="message-animate-in group flex w-full justify-end">
          <div className="flex w-full flex-col items-end gap-2">
            <div className="w-fit max-w-[80%] rounded-[16px] bg-bg_grouped_tertiary px-3 py-2 text-left">
              <div className="text-text_default_primary">
                <p className="desktop-text-chat-body message-container-user-text break-words whitespace-pre-wrap">
                  {block.text}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (block.role === "todo") return <TodoBlock block={block} />;
  if (block.role === "system") return <NoticeBlock block={block} t={t} />;

  // plan / ask / goal blocks also render as markdown bodies upstream.
  return (
    <div className="mb-4">
      <div
        className="mavis-assistant-message-surface message-animate-in group relative w-full"
        data-testid="message-item"
        data-role="assistant"
      >
        <div className="desktop-text-chat-body space-y-4 text-sm text-text_default_primary">
          <MarkdownBody text={block.text} streaming={block.streaming} />
          {block.processedDuration != null ? (
            <TurnProcessDisclosure
              processedDurationMs={block.processedDuration}
              t={t}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Message action row.
 *
 * Upstream's row is `复制 / 点赞 / 点踩 / fork`, each a 26×26 chip whose icon is
 * 18px. There is no *share* action on the desktop — the fourth slot is `fork`
 * (`message.conversation_mutation.fork_action`, the desktop's zh wording is
 * 复制为新会话).
 *
 * Visibility is **session-idle only** — neither hover nor select triggers it.
 * The row appears when the engine has finished the current turn
 * (`!sessionRunning`) AND this is the trailing block (`forceReveal`); when
 * conditions don't hold, the row is removed from the DOM entirely, so the
 * absence does not leave a gap.
 *
 * Per-row *copy* additionally respects the block-level streaming flag
 * (`!isStreaming`) so the button only renders when the text is complete.
 *
 * `复制` reads from the clipboard API and flips the icon to a tick for ~1.2s;
 * the tick is the desktop's own check glyph, not a swapped colour.
 * `点赞` / `点踩` / `fork` are visual affordances for now: the server has no
 * feedback or fork endpoint, so they only update local optimistic state.
 */
// The row shows only when the session is idle AND this block is the trailing
// unit. While the engine is still writing (`sessionRunning === true`), the row
// is NOT rendered at all. The Chat-level gate is the canonical place to
// decide "show this row at all"; this early-return is the second line of
// defence in case someone reuses MessageActions from another site without
// that gate.
const REVEALED = "opacity-100 pointer-events-auto";
function MessageActions({
  text,
  t,
  ts,
  locale,
  isStreaming,
  forceReveal,
  sessionRunning,
}: {
  text: string;
  t: (key: MessageKey) => string;
  ts?: number;
  locale: Locale;
  isStreaming?: boolean;
  forceReveal?: boolean;
  sessionRunning: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<"none" | "up" | "down">("none");
  const onCopy = useCallback(() => {
    if (typeof navigator === "undefined") return;
    // The clipboard promise rejects when permission is denied or the document
    // is not focused; without a catch that is an unhandled rejection and the row
    // silently stays in its "copy" state. Fall back to reporting the failure
    // through the same banner the other mutations use, so a denied clipboard is
    // visible instead of looking like a no-op button.
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((cause) => {
        reportActionError(t("chat.copy"), cause);
      });
  }, [text, t]);
  // Early return: when conditions don't hold, the row is removed from the DOM
  // entirely. The Chat render site also gates on `showActions`; this is the
  // safety net so the gap-under-message complaint can never come back even if a
  // caller forgets the outer gate.
  if (!(!sessionRunning && forceReveal)) return null;
  const showCopy = !isStreaming;
  return (
    <div
      data-testid="message-actions"
      className="-ml-1.5 mt-1.5 flex items-center gap-1.5"
    >
      {showCopy ? (
        <button
          type="button"
          data-testid="message-copy-button"
          onClick={onCopy}
          aria-label={copied ? t("chat.copied") : t("chat.copy")}
          title={copied ? t("chat.copied") : t("chat.copy")}
          className={`${REVEALED} flex size-[26px] items-center justify-center rounded-[8px] text-text_default_tertiary hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary`}
        >
          <Icon name={copied ? "check" : "file"} size={18} />
        </button>
      ) : null}
      <div data-testid="message-feedback-actions" className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="message-feedback-like"
          aria-label={t("chat.like")}
          aria-pressed={liked === "up"}
          title={t("chat.like")}
          onClick={() => setLiked((value) => (value === "up" ? "none" : "up"))}
          className={[
            REVEALED,
            "flex size-[26px] items-center justify-center rounded-[8px] transition-colors hover:bg-bg_interaction_tertiary_hover",
            liked === "up"
              ? "text-text_default_accent"
              : "text-text_default_tertiary hover:text-text_default_primary",
          ].join(" ")}
        >
          <Icon name="like" size={18} />
        </button>
        <button
          type="button"
          data-testid="message-feedback-dislike"
          aria-label={t("chat.dislike")}
          aria-pressed={liked === "down"}
          title={t("chat.dislike")}
          onClick={() => setLiked((value) => (value === "down" ? "none" : "down"))}
          className={[
            REVEALED,
            "flex size-[26px] items-center justify-center rounded-[8px] transition-colors hover:bg-bg_interaction_tertiary_hover",
            liked === "down"
              ? "text-text_default_accent"
              : "text-text_default_tertiary hover:text-text_default_primary",
          ].join(" ")}
        >
          <Icon name="dislike" size={18} />
        </button>
      </div>
      <button
        type="button"
        data-testid="message-fork-button"
        aria-label={t("chat.fork")}
        title={t("chat.fork")}
        className={`${REVEALED} flex size-[26px] items-center justify-center rounded-[8px] text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary`}
      >
        <Icon name="fork" size={18} />
      </button>
      {ts ? (
        <span className={`desktop-text-ui-assist text-[13px] leading-[18px] text-text_default_tertiary ${REVEALED}`}>
          {formatTimestamp(ts, locale)}
        </span>
      ) : null}
    </div>
  );
}

function formatTimestamp(ts: number, locale: Locale): string {
  const date = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (locale === "zh") return `${date.getMonth() + 1}月${date.getDate()}日,${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.toLocaleString("en-US", { month: "short" })} ${date.getDate()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Assistant body.
 *
 * Upstream renders markdown through `.matrix-markdown` (remark/rehype output
 * with `code.inline-code`, `strong`, headings, tables, …). This renders the
 * same shape with `marked`, sanitised before it reaches the DOM.
 */
function MarkdownBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className="matrix-markdown message-content relative max-w-full flex-1 overflow-hidden text-pretty">
      <div className="matrix-markdown matrix-markdown--shifted mavis-chat-markdown-flow">
        {/* Slice 23 — MarkdownHtml walks the rendered DOM, finds the
            mermaid-block placeholders, and mounts the lazy mermaid
            component into each one. The parser seam
            (`registerLanguageRenderer` in lib/markdown.ts) means
            third-party diagram renderers can attach here too. */}
        <MarkdownHtml html={html} />
      </div>
      {streaming ? (
        <span className="ml-[2px] inline-block animate-pulse text-text_default_accent">▍</span>
      ) : null}
    </div>
  );
}

/**
 * Whole-turn disclosure bar (`turn_process_disclosure` upstream).
 *
 * The desktop renders a small collapse bar pinned under each settled
 * assistant turn, summarising wall-clock duration. We only have
 * `processed_duration` today — upstream's `worked / processing_duration /
 * user_paused*` keys are engine-side state the webui backend does not surface,
 * so the bar collapses to a duration chip alone. See SPEC §B 尾项.
 *
 * The chevron rotates to mirror upstream's open/closed affordance.
 */
function TurnProcessDisclosure({
  processedDurationMs,
  t,
}: {
  processedDurationMs: number;
  t: (key: MessageKey) => string;
}) {
  const [open, setOpen] = useState(false);
  // Round to one decimal so a 12.34s turn reads "12.3s" rather than "12s",
  // matching upstream's tabular-nums duration display.
  const seconds = (processedDurationMs / 1000).toFixed(1);
  return (
    <div
      data-testid="turn-process-disclosure"
      className="group/turn-process text-activity-body-small flex w-full items-center gap-1 text-text_label_tertiary_default"
    >
      <button
        type="button"
        data-testid="turn-process-disclosure-trigger"
        aria-expanded={open}
        aria-label={open ? t("chat.turnProcess.collapse") : t("chat.turnProcess.expand")}
        title={open ? t("chat.turnProcess.collapse") : t("chat.turnProcess.expand")}
        onClick={() => setOpen((value) => !value)}
        className="desktop-text-ui-small inline-flex items-center gap-1 rounded-[6px] px-1 py-0.5 transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
        <span className="tabular-nums">{t("chat.turnProcess.took").replace("{{seconds}}", seconds)}</span>
        <Icon
          name="caretDown"
          size={12}
          className={`transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open ? (
        <div
          data-testid="turn-process-disclosure-detail"
          className="desktop-text-ui-small mt-1 flex w-full flex-col gap-1 pl-3 text-text_default_tertiary"
        >
          <span className="tabular-nums">
            {t("chat.turnProcess.took").replace("{{seconds}}", seconds)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function TodoBlock({ block }: { block: TranscriptBlock }) {
  const glyph =
    block.todoState === "done"
      ? "✓"
      : block.todoState === "doing"
        ? "◌"
        : block.todoState === "failed"
          ? "✗"
          : "○";
  const tone =
    block.todoState === "done"
      ? "text-text_status_success"
      : block.todoState === "failed"
        ? "text-text_status_error"
        : block.todoState === "doing"
          ? "text-text_default_accent"
          : "text-text_default_tertiary";

  return (
    <div className="mb-4">
      <div className="message-animate-in group relative w-full">
        <div className="flex items-start gap-2 text-activity-body-small">
          <span className={tone}>{glyph}</span>
          <span className="break-words whitespace-pre-wrap text-text_default_secondary">
            {block.text}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * System-notice block — substitutes for the activity-summary line upstream
 * shows when an assistant turn carries tool activity. The transcript contract
 * does not carry that summary, so notices render in its place until the
 * backend exposes it.
 */
function NoticeBlock({ block, t }: { block: TranscriptBlock; t: (key: MessageKey) => string }) {
  return (
    <div className="mb-4">
      <div className="message-animate-in group relative w-full">
        <div className="space-y-4 text-sm text-text_default_primary">
          <div className="text-activity-body-small w-full text-sm leading-5">
            <span className="group/header inline-flex min-w-0 max-w-[80%] items-center gap-1 pr-1 text-left text-sm leading-5 tracking-normal text-text_default_tertiary">
              {t("chat.system")}
            </span>
          </div>
          <p className="break-words whitespace-pre-wrap text-text_default_secondary">
            {block.text}
          </p>
        </div>
      </div>
    </div>
  );
}

function ThinkingIndicator({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  // Ticket U8: the gate is the exported pure function (unit-tested in
  // webapp/test/loading-skeleton.test.ts); the indicator itself lives in
  // components/loading-states.tsx so the streaming state stays renderable
  // without the chat module's heavier import graph.
  if (!isSessionActivityActive(state)) return null;
  // The server reports `thinkingStatus` as a free-form string. We only branch
  // on the four canonical phases the desktop uses (working / planning /
  // wiring / checking); anything else falls through to the default "thinking"
  // copy so an unknown stage never crashes the indicator.
  const phase = (state?.context.thinkingStatus ?? "").toLowerCase();
  const label =
    phase === "working"
      ? t("chat.thinkingStatus.working")
      : phase === "planning"
        ? t("chat.thinkingStatus.planning")
        : phase === "wiring"
          ? t("chat.thinkingStatus.wiring")
          : phase === "checking"
            ? t("chat.thinkingStatus.checking")
            : t("chat.thinking");
  return <ActivityPulse label={label} />;
}

/**
 * Home state — the screen shown before the first message.
 *
 * Upstream renders: a real-photo avatar, a time-of-day greeting
 * (`早上好` / `中午好` / `下午好` / `晚上好` / `夜深了`, picked from the user's
 * local hour) followed by a casual invite prompt, the composer inline, a single
 * row showing the active project + `本地` chip, and a horizontal `推荐` strip
 * of suggested tasks. The composer is passed in as children so its on-submit
 * logic remains the conversation tree's.
 *
 * `SHOW_SUGGESTIONS` holds the recommended-task strip back: the chips are not
 * wired to anything yet, so the row is not shipped as dead affordances. Flip
 * the flag to restore the row exactly as it was.
 */
const SUGGESTIONS: { id: string; emoji: string; labels: Record<"zh" | "en", string> }[] = [
  { id: "video", emoji: "🎬", labels: { zh: "视频生成 H3", en: "Video gen H3" } },
  { id: "product", emoji: "💡", labels: { zh: "产品运营", en: "Product ops" } },
  { id: "vibe", emoji: "▶", labels: { zh: "Vibe Coding", en: "Vibe Coding" } },
  { id: "design", emoji: "🎨", labels: { zh: "设计视觉", en: "Design" } },
  { id: "mcode", emoji: "☕", labels: { zh: "问问 MCode", en: "Ask MCode" } },
];

const SHOW_SUGGESTIONS = false;

/**
 * Pick a greeting from the local hour. Mirrors upstream's wording rather than
 * a literal translation, so the feel matches the running client.
 */
function pickGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return "早上好呀";
  if (hour >= 11 && hour < 14) return "中午好呀";
  if (hour >= 14 && hour < 19) return "下午好呀";
  if (hour >= 19 && hour < 23) return "晚上好呀";
  return "夜深了";
}

const GREETING_TAILS: Record<string, string[] | undefined> = {
  zh: [
    "卡住的代码发来看看",
    "想让今天做点啥?",
    "来聊点有意思的",
    "想到什么就说什么",
    "今天想做点什么?",
    "有什么需要我搭把手?",
  ],
  en: [
    "send the code that's stuck",
    "what should we tackle today?",
    "let's chat about something interesting",
    "say whatever comes to mind",
    "what do you want to work on today?",
    "anything I can help with?",
  ],
};

export function HomeState({ t, children, locale }: ChatProps & { children: React.ReactNode; locale: Locale }) {
  const { state } = useSessionContext();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Re-evaluate the greeting every minute so the slot matches the user's
    // local clock crossing a threshold (e.g. 11:59 → 12:00). The upstream
    // client does this too — the page never needs a reload for the greeting
    // to refresh.
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Use a stable tail so the page does not jitter on every render. The seed
  // changes only when the hour-bucket shifts (morning → afternoon, etc.).
  const greeting = pickGreeting(now);
  const tails: string[] = GREETING_TAILS[locale] ?? GREETING_TAILS.zh ?? [];
  const bucket = Math.floor(now.getTime() / 3_600_000);
  const tail = tails[bucket % tails.length] ?? "";

  // Real-photo avatar with an SVG fallback. The upstream build uses the same
  // cdn URL and falls back to a single-letter chip when the request fails.
  const avatarHref =
    "https://file.cdn.minimax.io/public/0742f66f-b304-4705-a9c7-bd68ab32db7f.svg";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-[200px]">
      <div className="flex w-full max-w-[743px] flex-col items-center gap-3 px-4 pb-6">
        <button
          type="button"
          aria-label={t("app.name")}
          className="group/avatar relative flex h-[70px] w-[70px] flex-shrink-0 cursor-pointer items-center justify-center overflow-visible rounded-full bg-bg_grouped_tertiary shadow-[0_0_20px_var(--opacity_black_1_8)] transition-opacity hover:opacity-90"
        >
          <span className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-full">
            <img
              src={avatarHref}
              alt=""
              width={70}
              height={70}
              className="size-[70px] rounded-full object-cover"
              referrerPolicy="no-referrer"
              crossOrigin="anonymous"
              onError={(event) => {
                const target = event.currentTarget;
                target.style.display = "none";
                const fallback = target.nextElementSibling as HTMLElement | null;
                if (fallback) fallback.style.display = "flex";
              }}
            />
            <span className="hidden size-[70px] items-center justify-center text-2xl font-medium text-text_default_primary">
              M
            </span>
          </span>
        </button>

        <h1 className="text-[28px] leading-tight font-medium text-text_default_primary">
          {greeting}
          <span className="text-text_default_primary">,</span>
          <span className="text-text_default_tertiary"> {tail}</span>
        </h1>

        {/* Composer (passed in) and, directly beneath it, the project + mode chip
            row. Both live in the same flex item: the greeting column spaces its
            children with `gap-3`, so rendering the row as a sibling would leave
            a 12px gap below the composer. The chips are read-only placeholders
            wired to the same store as the sidebar's Local/Cloud segmented. */}
        <div className="mt-2 w-full">
          {children}
          <div className="mt-0 flex w-full items-center gap-3 px-3">
            <div className="flex flex-1 items-center justify-center gap-3">
              <WorkspaceChipDropdown t={t} />
              <button
                type="button"
                aria-pressed
                className="flex h-8 items-center gap-1 rounded-full border border-border_default bg-bg_default_primary px-3 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
              >
                <Icon name="browser" size={13} />
                <span>{t("home.local")}</span>
              </button>
            </div>
          </div>
        </div>

        {SHOW_SUGGESTIONS ? (
          <>
            {/* Suggested-task row. Upstream places this *below* the project row,
                as a single horizontal line of icon + label chips. */}
            <section className="mt-3 w-full px-3" aria-label={t("home.suggestions")}>
              <div className="flex items-center justify-center gap-2 overflow-x-auto">
                {SUGGESTIONS.map((chip, index) => (
                  <button
                    key={chip.id}
                    type="button"
                    className={[
                      "flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-caption-small-strong transition-colors",
                      index === 0
                        ? "border border-border_tertiary_default text-text_default_primary hover:bg-bg_interaction_tertiary_hover"
                        : "border border-border_default text-text_default_primary hover:bg-bg_interaction_tertiary_hover",
                    ].join(" ")}
                  >
                    <span aria-hidden>{chip.emoji}</span>
                    <span className="whitespace-nowrap">{chip.labels[locale]}</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
