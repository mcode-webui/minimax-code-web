"use client";

/**
 * Markdown outline panel (slice 27 — preview TOC).
 *
 * Layout mirrors the reference the user supplied (the DSH preview
 * component): the rendered document on the left, a clickable outline on
 * the right, the current section highlighted as the page scrolls.
 *
 * Where the outline comes from. NOT a second markdown parse — the
 * component runs `extractOutline` (lib/markdown-toc.ts) over the
 * headings the RENDERED DOM already contains, so what the outline
 * lists is by construction what the page shows. Heading ids are
 * assigned onto those DOM nodes right there (the anchor the browser
 * scrolls to is the node the user is looking at). Mermaid diagrams
 * (slice 23) are not headings and cannot enter the outline; a heading
 * nested inside a `.mermaid-block` is excluded defensively by
 * `isOutlineHeading`.
 *
 * Visibility rules:
 *   - a document with NO headings renders no panel at all (no empty
 *     box — ticket AC 6);
 *   - the panel also hides when the content column is too narrow
 *     (< OUTLINE_MIN_HOST_PX) so the document never gets squeezed by
 *     its own outline; the ResizeObserver re-checks on every resize.
 *
 * Scroll spy. The headings' scroll parent is the preview body
 * (`.file-preview-body`, owned by file-preview.tsx). Found via
 * `closest()` at mount rather than a prop so this component works in
 * every mount (file tab and right pane) without new plumbing. On
 * scroll, the last heading above the fold becomes the active entry —
 * throttled to one computation per animation frame.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  extractOutline,
  OUTLINE_HEADING_SELECTOR,
  type TocEntry,
} from "@/lib/markdown-toc";
import { tPreviewToolbar } from "@/lib/i18n-preview-toolbar";
import type { Locale } from "@/lib/i18n";

/**
 * Below this content width the outline would squeeze the document past
 * legibility, so it hides. Calibrated against the preview column's
 * minWidth (320 — see lib/workspace-tabs-state.ts): at the DEFAULT
 * width (400 → ~320 content px after paddings) the outline MUST be
 * visible (a heading document without its outline fails the slice's
 * acceptance), so the guard only trips for degenerate mounts.
 */
const OUTLINE_MIN_HOST_PX = 300;

export interface MarkdownTocProps {
  /**
   * Ref to the element that HOLDS the rendered markdown (the div the
   * headings live in). The outline re-extracts whenever `renderKey`
   * changes (a refresh re-rendered the document).
   */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Changes whenever the rendered markdown changes (the html string). */
  renderKey: string;
  locale: Locale;
}

export function MarkdownToc({ contentRef, renderKey, locale }: MarkdownTocProps) {
  const [outline, setOutline] = useState<TocEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hostTooNarrow, setHostTooNarrow] = useState(false);
  const scrollParentRef = useRef<HTMLElement | null>(null);

  // Re-extract the outline from the rendered DOM whenever the document
  // (re-)renders. This is the single place the DOM is walked; the pure
  // rules live in lib/markdown-toc.ts.
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    const headings = Array.from(
      host.querySelectorAll<HTMLElement>(OUTLINE_HEADING_SELECTOR),
    );
    setOutline(extractOutline(headings));
    setActiveId(outlineFirst(headings));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderKey
    // is the html string; the effect must run exactly when the DOM
    // under contentRef has been re-committed with that html.
  }, [renderKey, contentRef]);

  // Track the geometry the outline SHARES with the document. The
  // observed element is the scroll container (`.file-preview-body`),
  // NOT the markdown host: the host's own width changes by exactly the
  // outline's width when the outline mounts, so watching the host
  // creates a feedback loop (outline shows → host shrinks below the
  // threshold → outline hides → host widens → outline shows …). The
  // scroller's width is set by the column layout alone.
  //
  // The scroller's clientHeight is ALSO captured (as `maxPanelPx`):
  // sticky positioning only has room to move when the panel is
  // shorter than the scroll viewport, so the panel's max-height is
  // pinned to the scroller's visible height — a 40-heading document
  // must not grow an outline taller than the pane it floats in.
  const [maxPanelPx, setMaxPanelPx] = useState<number | null>(null);
  useEffect(() => {
    const host = contentRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observed = host.closest<HTMLElement>(".file-preview-body") ?? host;
    const read = () => {
      const width = observed.clientWidth;
      setHostTooNarrow(width > 0 && width < OUTLINE_MIN_HOST_PX);
      const height = (observed as HTMLElement).clientHeight;
      if (height > 0) setMaxPanelPx(height);
    };
    const observer = new ResizeObserver(read);
    observer.observe(observed);
    read();
    return () => observer.disconnect();
  }, [contentRef]);

  // Scroll spy: subscribe to the preview body's scroll events once the
  // outline exists.
  useEffect(() => {
    if (outline.length === 0) return;
    const host = contentRef.current;
    if (!host) return;
    const scroller = host.closest<HTMLElement>(".file-preview-body");
    if (!scroller) return;
    scrollParentRef.current = scroller;

    let frame = 0;
    const recompute = () => {
      frame = 0;
      const current = activeHeading(scroller, outline);
      setActiveId(current);
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(recompute);
    };
    recompute();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [outline, contentRef]);

  const jumpTo = useMemo(
    () => (id: string) => {
      setActiveId(id);
      const host = contentRef.current;
      const target = host?.querySelector<HTMLElement>(`#${cssEscape(id)}`);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [contentRef],
  );

  if (outline.length === 0 || hostTooNarrow) return null;

  return (
    <nav
      aria-label={tPreviewToolbar(locale, "previewToolbar.toc.title")}
      data-testid="file-preview-toc"
      data-count={outline.length}
      // No `self-stretch` on purpose: stretching the panel to the
      // document's height (the flex row's tallest item) leaves sticky
      // positioning no room to move — the panel scrolled out of view
      // with the document, taking the active highlight with it (the
      // acceptance-run regression this fix pins). The panel keeps its
      // natural (content) height and `max-height` is pinned to the
      // scroll viewport's clientHeight so a long outline stays inside
      // the pane it floats in.
      className="file-preview-toc flex-none"
      style={maxPanelPx !== null ? { maxHeight: `${maxPanelPx}px` } : undefined}
    >
      <p className="file-preview-toc-title" data-testid="file-preview-toc-title">
        {tPreviewToolbar(locale, "previewToolbar.toc.title")}
      </p>
      <ol className="file-preview-toc-list">
        {outline.map((entry) => (
          <li key={entry.id} style={{ paddingLeft: `${(entry.level - 1) * 10}px` }}>
            <a
              href={`#${cssEscape(entry.id)}`}
              onClick={(event) => {
                event.preventDefault();
                jumpTo(entry.id);
              }}
              aria-current={activeId === entry.id ? "true" : undefined}
              title={tPreviewToolbar(locale, "previewToolbar.toc.jump", {
                text: entry.text,
              })}
              data-testid="file-preview-toc-item"
              data-level={entry.level}
              data-active={activeId === entry.id ? "true" : "false"}
              className={`file-preview-toc-link file-preview-toc-l${entry.level}`}
            >
              <span className="file-preview-toc-text">{entry.text}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The first heading currently above the fold (null before the first). */
function activeHeading(
  scroller: HTMLElement,
  outline: TocEntry[],
): string | null {
  const top = scroller.getBoundingClientRect().top;
  let current: string | null = null;
  for (const entry of outline) {
    const el = document.getElementById(entry.id);
    if (!el) continue;
    // A heading counts as "reached" once its top passes ~a third of the
    // viewport below the container's top edge — the reading position,
    // not the very top pixel.
    if (el.getBoundingClientRect().top - top <= scroller.clientHeight / 3) {
      current = entry.id;
    } else {
      break;
    }
  }
  return current;
}

function outlineFirst(headings: HTMLElement[]): string | null {
  for (const el of headings) {
    const id = el.getAttribute("id");
    if (id) return id;
  }
  return null;
}

/**
 * Escape an id for use in `querySelector` / `getElementById`-adjacent
 * selectors. Our own slugs are selector-safe by construction, but an
 * id the document carried explicitly (kept verbatim by
 * extractOutline) can contain dots or colons.
 */
function cssEscape(id: string): string {
  return (window.CSS?.escape ?? escapeFallback)(id);
}

function escapeFallback(value: string): string {
  return value.replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (c) => `\\${c}`);
}
