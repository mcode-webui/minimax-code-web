"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  // Gutter layout: a 2-cell grid keeps the gutter locked to the left
  // of the code area regardless of horizontal scroll. The grid columns
  // are `[auto, 1fr]` so the code area takes the remaining width and
  // scrolls horizontally; the gutter column is fixed-width and stays
  // in place because it shares the grid with the code.
  //
  // `font-variant-numeric: tabular-nums` aligns digits in the gutter
  // so the colon between the number and the code does not dance when
  // the file crosses 9 → 10 or 99 → 100 lines.
  return (
    <div
      className="file-preview-codeblock thin-scrollbar max-w-full overflow-auto rounded-[8px] bg-bg_grouped_secondary_elevated font-family-code text-caption-small-strong text-text_default_primary"
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
  // Copy button: selecting the gutter is impossible (its own DOM
  // subtree), and the code area's textContent contains only the
  // source (no gutter digits). `clipboard.writeText` over the whole
  // code subtree is therefore safe.
  const onCopy = async () => {
    const text = split.lines.map((line) => line.text).join("\n");
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

  return (
    <div className="relative">
      <div className="sticky right-0 top-0 z-10 flex justify-end p-1.5">
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label={tFileOpen(locale, "fileOpen.code.copy.aria")}
          data-testid="file-preview-code-copy"
          className="rounded-[6px] border border-border_default bg-bg_default_scrim px-2 py-0.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {tFileOpen(locale, "fileOpen.code.copy")}
        </button>
      </div>
      <pre className="m-0 whitespace-pre" data-testid="file-preview-code-pre">
        <code className={split.language ? `hljs language-${split.language}` : "hljs"}>
          {split.lines.map((line) => (
            <div
              key={line.number}
              className="file-preview-codeblock-line"
              data-line={line.number}
              data-testid="file-preview-code-line"
            >
              <span
                className="file-preview-codeblock-gutter"
                aria-hidden
                data-testid="file-preview-code-gutter"
              >
                {line.number}
              </span>
              <span
                className="file-preview-codeblock-code"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: line.html || "&nbsp;" }}
              />
            </div>
          ))}
        </code>
      </pre>
    </div>
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
