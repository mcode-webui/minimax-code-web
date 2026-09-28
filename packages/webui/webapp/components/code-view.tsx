"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  highlightCode,
  splitHighlightedLines,
  type HighlightedCode,
  type HighlightedLine,
} from "@/lib/code-highlight";
import { formatBytes } from "@/lib/file-preview";
import type { Locale, MessageKey } from "@/lib/i18n";
import { tFileOpen } from "@/lib/i18n-file-open";

/**
 * Code preview (slice 22 of webui-parity).
 *
 * Renders an `FsFilePayload`'s text content with:
 *   - gutter on the left, line numbers aligned to code lines,
 *     independent of horizontal scroll (line numbers never move when
 *     the user scrolls right on a long line);
 *   - syntax highlighting via highlight.js, lazy-loaded by grammar;
 *   - plain monospace fallback when the language is unknown;
 *   - truncate-with-notice when the content exceeds the highlight
 *     budget, so a multi-megabyte file never freezes the tab;
 *   - copy button that puts raw source on the clipboard (line
 *     numbers never leak into the copied text).
 *
 * The component owns its own loading state: the parent only needs to
 * hand it `(content, language)` and a t/locale pair. Render output
 * is a stable tree so the React reconciliation does not have to
 * rebuild 1000+ line cells on each scroll.
 */

export interface CodeViewProps {
  /** Raw text body of the file. Required. */
  content: string;
  /**
   * The server-reported language label (the wire form of
   * `languageForExtension`). Used to pick the highlight.js grammar
   * and to display the badge. Empty / unknown labels render as
   * plain monospace without an error.
   */
  language: string;
  /** File size in bytes, for the truncation notice. Optional. */
  size?: number;
  t: (key: MessageKey) => string;
  locale: Locale;
}

interface CodeViewState {
  /** Highlighted split, or null while loading / on unknown language. */
  split:
    | {
        lines: HighlightedLine[];
        language: string | null;
        truncated: boolean;
        originalLineCount?: number;
        visibleLineCount: number;
        /** Source ended with `\n` — copy path restores it for round-trip. */
        trailingNewline: boolean;
      }
    | null;
  /** Error message from the highlight step (rare — grammar load failure). */
  error: string | null;
}

export function CodeView({ content, language, size, t, locale }: CodeViewProps) {
  const [state, setState] = useState<CodeViewState>({ split: null, error: null });
  // Highlight runs in a microtask; if the user clicks through several
  // files in a row, only the latest result wins. Same last-write-wins
  // pattern as `file-preview.tsx#load`.
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    let cancelled = false;
    setState({ split: null, error: null });
    (async () => {
      try {
        const result: HighlightedCode = await highlightCode(language, content);
        if (cancelled || gen !== genRef.current) return;
        const split = splitHighlightedLines(result, content);
        setState({ split, error: null });
      } catch (cause) {
        if (cancelled || gen !== genRef.current) return;
        // Highlight failures are non-fatal: fall through to the
        // plain monospace render so the user always sees the file.
        // The error stays in state only for diagnostics — not shown
        // in the UI.
        setState({
          split: {
            lines: content.split("\n").map((text, i) => ({
              number: i + 1,
              html: escapeHtmlSafe(text),
              text,
            })),
            language: language || null,
            truncated: false,
            visibleLineCount: content.split("\n").length,
            trailingNewline:
              content.length > 0 &&
              content.charCodeAt(content.length - 1) === 10,
          },
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, language]);

  // The badge label uses the language the renderer ACTUALLY used
  // (the resolved hljs module name, e.g. "javascript"), falling back
  // to the server-reported label when no grammar loaded.
  const badgeLabel = state.split?.language ?? normaliseLabel(language);
  const showBadge = badgeLabel.length > 0;

  const truncatedNotice = useMemo<string | null>(() => {
    if (!state.split?.truncated) return null;
    const original = state.split.originalLineCount ?? state.split.visibleLineCount;
    const sizeHint = size !== undefined ? ` (${formatBytes(size)})` : "";
    // The bilingual notice falls through to the i18n key when it is
    // present; the inline fallback keeps the slice self-contained
    // until the next i18n sweep.
    return tFileOpen(locale, "fileOpen.code.truncated", {
      shown: state.split.visibleLineCount,
      total: original,
    }) + sizeHint;
  }, [state.split, size, locale]);

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="file-preview-code"
      data-language={badgeLabel || "plain"}
      data-truncated={state.split?.truncated ? "true" : undefined}
    >
      <div className="flex items-center gap-2 text-caption-small-strong text-text_default_tertiary">
        {showBadge ? (
          <span
            data-testid="file-preview-language"
            className="rounded-[6px] border border-border_default bg-bg_default_scrim px-1.5 py-0.5 font-family-code text-[11px] uppercase tracking-wide text-text_default_tertiary"
          >
            {badgeLabel}
          </span>
        ) : null}
        {state.split ? (
          <span data-testid="file-preview-code-line-count">
            {state.split.visibleLineCount} {state.split.visibleLineCount === 1 ? "line" : "lines"}
          </span>
        ) : null}
      </div>

      {truncatedNotice ? (
        <div
          className="flex items-center gap-2 rounded-[8px] border border-border_status_warning bg-bg_default_scrim px-2 py-1 text-caption-small-strong text-text_status_warning"
          data-testid="file-preview-code-truncated-notice"
          role="status"
        >
          <span aria-hidden>⚠</span>
          <span>{truncatedNotice}</span>
        </div>
      ) : null}

      {state.error ? (
        // Diagnostic only — the render below always succeeds. Keeping
        // the field in the DOM (hidden) lets tests assert it.
        <span data-testid="file-preview-code-error" hidden>
          {state.error}
        </span>
      ) : null}

      <CodeBody split={state.split} t={t} locale={locale} />
    </div>
  );
}

function CodeBody({
  split,
  t,
  locale,
}: {
  split: CodeViewState["split"];
  t: (key: MessageKey) => string;
  locale: Locale;
}) {
  // The outer wrapper is a flex row with the gutter as a fixed-width
  // child and the scroll area as a flex-1 sibling. ONLY the scroll
  // area scrolls horizontally — the gutter is outside that wrapper,
  // so it never moves with the code. (An earlier design used a single
  // grid inside one scrolling div; the gutter scrolled with the code
  // because it shared the scroll context. Acceptance caught it.)
  return (
    <div
      className="file-preview-codeblock flex min-w-0 overflow-hidden rounded-[8px] bg-bg_grouped_secondary_elevated font-family-code text-caption-small-strong text-text_default_primary"
      data-testid="file-preview-codeblock"
    >
      {!split ? (
        <div className="p-3 text-text_default_tertiary">{t("app.connecting")}</div>
      ) : (
        <CodeTable split={split} t={t} locale={locale} />
      )}
    </div>
  );
}

function CodeTable({
  split,
  t,
  locale,
}: {
  split: NonNullable<CodeViewState["split"]>;
  t: (key: MessageKey) => string;
  locale: Locale;
}) {
  // Copy button: the rendered DOM subtree contains gutter digits
  // AND code — a naive `textContent` would include both, leaking
  // numbers into the clipboard. Instead, the split records carry
  // the raw source per line; joining with `\n` reconstructs the
  // exact source text (interior blanks are preserved because each
  // blank line is an empty `text`, not a missing line). We also
  // preserve a trailing newline so the source round-trips
  // byte-for-byte: a file ending in `\n` produces N lines whose
  // joined form is `line 1\n...\nline N-1` (no trailing `\n`) — the
  // split marks `trailingNewline: true` when the source had one,
  // and the copy path appends it back. Without this the user could
  // `cp file.js file.js.bak; view in panel; cp clipboard file.js` and
  // lose the final newline — a real annoyance for scripts.
  const onCopy = async () => {
    let text = split.lines.map((line) => line.text).join("\n");
    if (split.trailingNewline) text += "\n";
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Some browsers refuse clipboard access outside a user gesture
        // for non-secure contexts; fall back to the legacy API.
      }
    }
    if (typeof document === "undefined") return;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  };

  // The two children of `file-preview-codeblock`:
  //   1. <aside class="file-preview-codeblock-gutter-column"> — fixed-width,
  //      vertically scrollable, gutter column. Lives OUTSIDE the
  //      horizontal scroll wrapper. Numbers in `font-variant-numeric:
  //      tabular-nums` so 1/10/100 all sit at the same x.
  //   2. <div class="file-preview-codeblock-scroll"> — the only element
  //      with `overflow-x: auto`. Contains the copy button row + the
  //      pre with the code rows. Horizontal scroll on a long line
  //      scrolls ONLY this child, exactly the IDE behaviour.
  //
  // Vertically, both columns scroll together because the outer wrapper
  // does NOT have overflow-y set; the inner scroll column gets its own
  // vertical scroll that drives the gutter's via a sync handler below.
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const syncScroll = useCallback((source: "gutter" | "scroll") => {
    const g = gutterRef.current;
    const s = scrollRef.current;
    if (!g || !s) return;
    if (source === "gutter") g.scrollTop = s.scrollTop;
    else s.scrollTop = g.scrollTop;
  }, []);
  return (
    <>
      <aside
        ref={gutterRef}
        onScroll={() => syncScroll("gutter")}
        className="file-preview-codeblock-gutter-column thin-scrollbar flex-none overflow-y-auto overflow-x-hidden border-r border-border_default bg-bg_grouped_secondary py-1 font-variant-numeric tabular-nums text-text_default_quaternary"
        data-testid="file-preview-codeblock-gutter-column"
        aria-hidden
      >
        {split.lines.map((line) => (
          <div
            key={line.number}
            className="file-preview-codeblock-gutter"
            data-testid="file-preview-code-gutter"
          >
            {line.number}
          </div>
        ))}
      </aside>
      <div className="file-preview-codeblock-scroll min-w-0 flex-1 overflow-auto">
        <div className="sticky right-0 top-0 z-10 flex justify-end bg-transparent">
          <button
            type="button"
            onClick={() => void onCopy()}
            aria-label={tFileOpen(locale, "fileOpen.code.copy.aria")}
            data-testid="file-preview-code-copy"
            className="m-1.5 rounded-[6px] border border-border_default bg-bg_default_scrim px-2 py-0.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {tFileOpen(locale, "fileOpen.code.copy")}
          </button>
        </div>
        <pre
          ref={scrollRef}
          onScroll={() => syncScroll("scroll")}
          className="file-preview-codeblock-pre m-0"
          data-testid="file-preview-code-pre"
        >
          <code className={split.language ? `hljs language-${split.language}` : "hljs"}>
            {split.lines.map((line) => (
              <div
                key={line.number}
                className="file-preview-codeblock-line"
                data-line={line.number}
                data-testid="file-preview-code-line"
              >
                <span
                  className="file-preview-codeblock-code"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: line.html || "" }}
                />
              </div>
            ))}
          </code>
        </pre>
      </div>
    </>
  );
}

function normaliseLabel(language: string): string {
  return (language ?? "").toLowerCase().trim();
}

// The error-path renderer in CodeView also needs to escape HTML; the
// shared helper lives in lib/code-highlight.ts but importing it here
// would create a cycle in the build graph (lib already imports
// highlight.js, the component imports lib). We duplicate the four
// escapes rather than add a separate module just for this.
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
function escapeHtmlSafe(value: string): string {
  return value.replace(/[&<>"']/gu, (c) => ESCAPE_MAP[c] ?? c);
}
