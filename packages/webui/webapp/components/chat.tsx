"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { renderMarkdown } from "@/lib/markdown";
import {
  decodeTranscript,
  groupActivity,
  SUMMARY_CATEGORY_KEY,
  type ActivitySummary,
  type TranscriptBlock,
} from "@/lib/transcript";
import { Icon } from "./icons";
import { useChatVirtualization } from "./chat-virtual-list";
import { useSessionContext } from "@/lib/store";
import { iconByName, type SummaryIconType } from "@/lib/transcript";
import type { Locale, MessageKey } from "@/lib/i18n";

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
 * The transcript scroller and column also come from upstream: the column is
 * `max-w-[768px]` (the 743px figure belongs to the home screen, not the
 * conversation).
 */

interface ChatProps {
  t: (key: MessageKey) => string;
  locale: Locale;
}

export function Chat({ t, locale }: ChatProps) {
  const { state } = useSessionContext();
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Decode, then fold each run of thinking/tool blocks into one activity group so
  // the transcript renders the way upstream lays it out.
  const units = useMemo(() => groupActivity(state ? decodeTranscript(state.chat) : []), [state]);

  // Global session-is-running state: when true, message-action rows are hidden
  // everywhere. The copy button has its own per-block `!isStreaming` check
  // inside the row, but the row container itself is gated here. Read off
  // `state.running.active` (set by mcode-acp/exec `finalize` and the SSE bus)
  // so the UI follows the engine, not a derived transcript signal.
  const sessionRunning = state?.running.active ?? false;

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
          <div className="message-container-chat-content mx-auto max-w-[768px] px-4">
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
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
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
      <div
        className="matrix-markdown matrix-markdown--shifted mavis-chat-markdown-flow"
        // Sanitised by lib/markdown.ts: only a small allowlist of tags and
        // attributes survives, and only http(s)/mailto/#/relative hrefs.
        dangerouslySetInnerHTML={{ __html: html }}
      />
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
  if (!(state?.running.active ?? false)) return null;
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
  return (
    <div className="flex items-center gap-2 py-2 text-text_default_tertiary">
      <span className="mavis-loading">
        <span className="mavis-dot mavis-dot-a" />
        <span className="mavis-dot mavis-dot-b" />
        <span className="mavis-dot mavis-dot-c" />
      </span>
      <span className="text-activity-body-small">{label}</span>
    </div>
  );
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
              <button
                type="button"
                className="flex h-8 items-center gap-1 rounded-full border border-border_default bg-bg_default_primary px-3 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
              >
                <Icon name="folder" size={13} />
                <span className="truncate whitespace-nowrap">
                  {state?.workspace.dir.split("/").filter(Boolean).pop() ?? t("home.chooseFolder")}
                </span>
              </button>
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

/**
 * A folded run of thinking/tool steps.
 *
 * Upstream presents these as one collapsible group whose header summarises the run
 * ("Thought N times, used M tools") with a chevron, and whose body is a
 * `grid-template-rows` + opacity transition. The same classes are used here, so the
 * open/close motion matches.
 */
function ActivityGroup({
  blocks,
  summary,
  t,
}: {
  blocks: TranscriptBlock[];
  summary: ActivitySummary;
  t: (key: MessageKey) => string;
}) {
  const [open, setOpen] = useState(false);

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

  return (
    <div className="mb-4">
      <div className="message-animate-in group relative w-full">
        <div
          data-testid="activity-group-header-shell"
          className="desktop-text-ui-small flex w-full text-sm leading-5"
        >
          <span className="group/header group/activity-label inline-flex min-w-0 max-w-[80%] items-center gap-1 pr-1 text-left text-sm leading-5 tracking-normal text-text_default_tertiary">
            <button
              type="button"
              data-testid="activity-group-header"
              data-message-collapse-trigger
              className="inline-flex min-w-0 items-center gap-1"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
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
            </button>
            <button
              type="button"
              aria-label={t("activity.detail")}
              className="-ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center self-center text-text_label_tertiary_default group-hover/header:text-text_label_tertiary_hover"
              onClick={() => setOpen((value) => !value)}
            >
              <span
                className={[
                  "flex h-4 w-4 items-center justify-center transition-transform duration-200 ease-out",
                  open ? "rotate-90" : "",
                ].join(" ")}
              >
                <Icon name="chevronRight" />
              </span>
            </button>
          </span>
        </div>

        <div
          className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
          style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
        >
          <div className="overflow-hidden">
            <div
              data-testid="activity-group-detail"
              className="flex max-h-[230px] flex-col gap-1.5 overflow-y-auto pt-2.5 scrollbar-hide"
            >
              {blocks.map((block, index) =>
                block.role === "thinking" ? (
                  <ThinkingRow key={index} block={block} t={t} />
                ) : (
                  <ToolCard key={index} block={block} t={t} />
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One thought.
 *
 * Upstream wraps each one in a `ThinkingBlock` titled
 * `message.item.thought_process` (思考过程) that is itself **collapsed by default** —
 * the thought text is not shown until you open it. The expanded body is
 * `text-activity-detail matrix-markdown--thinking` with a 0.5px left rule,
 * indented `ml-[7.5px] pl-[13px] pt-2`, which is what the classes below
 * reproduce.
 */
function ThinkingRow({ block, t }: { block: TranscriptBlock; t: (key: MessageKey) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/thought inline-flex min-w-0 items-center gap-1 text-text_default_tertiary"
      >
        <span className="min-w-0 truncate transition-colors group-hover/thought:text-text_default_secondary">
          {t("activity.thoughtProcess")}
        </span>
        <span
          className={[
            "flex h-4 w-4 shrink-0 items-center justify-center transition-transform duration-200 ease-out",
            open ? "rotate-0" : "-rotate-90",
          ].join(" ")}
        >
          <Icon name="caretDown" size={12} />
        </span>
      </button>
      {open ? (
        <div className="ml-[7.5px] border-l-[0.5px] border-border_default pl-[13px] pt-2">
          <div className="text-activity-detail matrix-markdown matrix-markdown--thinking text-text_default_secondary">
            <p className="m-0 break-words whitespace-pre-wrap">{block.text}</p>
          </div>
        </div>
      ) : null}
    </div>
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
function ToolCard({ block, t }: { block: TranscriptBlock; t: (key: MessageKey) => string }) {
  const [open, setOpen] = useState(false);
  const output = block.toolOutput ?? [];
  const paths = block.toolPaths ?? [];
  const hasBody = output.length > 0 || paths.length > 0;
  const iconType = iconByName(block.toolName);

  const statusKey =
    block.toolStatus === "failed"
      ? "tool.status.failed"
      : block.toolStatus === "in_progress"
        ? "tool.status.in_progress"
        : "tool.status.completed";

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
                <span
                  key={path}
                  title={path}
                  className="tool-resource-reference max-w-[260px] truncate rounded-md bg-bg_grouped_tertiary_elevated px-1.5 py-0.5 text-caption-small-strong text-text_default_secondary"
                >
                  {path}
                </span>
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
