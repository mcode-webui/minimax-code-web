/**
 * Markdown outline extraction (slice 27 — preview TOC).
 *
 * The outline is derived from the RENDERED DOM, never from a second
 * parse of the markdown source. That requirement is load-bearing:
 *
 *   - the rendered DOM is the single source of truth for what the user
 *     SEES — a custom language renderer (mermaid, slice 23) can emit
 *     arbitrary markup the markdown parser never produced, and an
 *     outline built from a re-parse could disagree with the page;
 *   - a heading id assigned here is the anchor the outline jumps to, so
 *     the id lives on the element the browser will actually scroll to.
 *
 * This module holds the pure decision logic (slug, filter, order) so it
 * is unit-testable without a DOM; the component
 * (`components/markdown-toc.tsx`) owns the DOM walk and the scroll spy
 * and calls `extractOutline` with whatever `querySelectorAll` found.
 */

/** The minimal DOM surface the extractor touches. Real Elements satisfy
 *  this shape; tests stub it. */
export interface OutlineElement {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  /** `Element.closest` — used to exclude headings nested inside a
   *  mermaid block (defensive; see isOutlineHeading). */
  closest?(selector: string): OutlineElement | null;
}

/** One outline row: the anchor id, the heading level, the label. */
export interface TocEntry {
  id: string;
  level: number;
  text: string;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** The selector the component feeds to querySelectorAll. Kept here so
 *  the filter and the query can never disagree about what counts. */
export const OUTLINE_HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

/**
 * Does this element belong in the outline?
 *
 * Headings inside a `.mermaid-block` are excluded: a diagram is not a
 * chapter (slice 23 + slice 27 ticket). In practice mermaid renders
 * `<svg>`-bearing divs with no heading children, but if a future
 * renderer emits heading-shaped markup inside a diagram, the outline
 * must not pick it up.
 */
export function isOutlineHeading(el: OutlineElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (!HEADING_TAGS.has(tag)) return false;
  if (el.closest && el.closest(".mermaid-block")) return false;
  return true;
}

/**
 * Stable, collision-free anchor id for a heading label.
 *
 * Rules, in order:
 *   - collapse every run of non word-y characters (spaces, slashes,
 *     punctuation, full-width parens …) into a single `-`;
 *   - drop leading/trailing separators;
 *   - keep CJK characters verbatim — the slug is an anchor id, not a
 *     transliteration, and the document is often Chinese;
 *   - never return an empty string (a heading with no usable characters
 *     still needs a unique target).
 *
 * Uniqueness is NOT this function's job — `extractOutline` appends the
 * `-2` / `-3` suffix, because uniqueness is a property of the document,
 * not of the label.
 */
export function headingSlug(text: string): string {
  const slug = (text ?? "")
    .trim()
    .toLowerCase()
    // Split on anything that is not a letter, digit, underscore, or
    // CJK ideograph; collapse runs into one separator.
    .replace(/[^\p{L}\p{N}_]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/**
 * Build the outline from the rendered heading elements, in document
 * order.
 *
 * - Elements failing `isOutlineHeading` are skipped (non-headings, and
 *   headings inside mermaid blocks).
 * - An element that already carries an id keeps it (another renderer
 *   may have anchored it); otherwise the slug of its text is assigned
 *   back onto the element via `setAttribute` so the anchor jump lands.
 * - Duplicate labels get `-2`, `-3`, … appended — a document with two
 *   "安装" sections must still jump to the one the user clicked.
 * - An empty input yields an empty outline; the panel hides itself
 *   rather than rendering an empty box (ticket AC 6).
 */
export function extractOutline(elements: OutlineElement[]): TocEntry[] {
  const seen = new Map<string, number>();
  const out: TocEntry[] = [];
  for (const el of elements) {
    if (!isOutlineHeading(el)) continue;
    const text = (el.textContent ?? "").trim();
    const level = Number.parseInt(el.tagName.slice(1), 10);
    let id = el.getAttribute("id");
    if (!id) {
      id = headingSlug(text);
      const count = seen.get(id) ?? 0;
      seen.set(id, count + 1);
      if (count > 0) id = `${id}-${count + 1}`;
      el.setAttribute("id", id);
    } else {
      // Reserve explicit ids too, so a later slug collision with an
      // explicit id still de-duplicates.
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    out.push({ id, level, text });
  }
  return out;
}
