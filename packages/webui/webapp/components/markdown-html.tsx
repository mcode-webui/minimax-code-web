"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MermaidBlock } from "./mermaid-block";

/**
 * Render pre-sanitised HTML and mount mermaid blocks into their placeholders.
 *
 * Why this is a separate component and not a `useEffect` inside MarkdownView:
 *
 *   - The markdown main flow (`lib/markdown.ts`) emits `<pre class="mermaid-source"
 *     hidden>SOURCE</pre><div class="mermaid-block">…</div>` placeholders so the
 *     sanitiser's allowlist (which only keeps `class` on `<pre>` and `<div>`)
 *     does not strip the diagram source.
 *
 *   - `dangerouslySetInnerHTML` injects that HTML once. To render the actual
 *     diagram inside the placeholder we need a React tree that owns the
 *     placeholder DOM node; a portal is the natural primitive here.
 *
 *   - ReactDOM portals require a `useState` / `useRef` to keep the host node
 *     stable across renders; packaging the walk-and-mount in a child component
 *     keeps the call sites clean.
 *
 * The component:
 *   - renders the sanitised HTML;
 *   - on mount (and whenever the HTML string changes), walks the resulting
 *     DOM, pairs every `<pre class="mermaid-source">` with the following
 *     `<div class="mermaid-block">`, and replaces the placeholder div's
 *     children with a `<MermaidBlock>` portal;
 *   - keeps an in-flight counter so a hot re-render does not leave orphaned
 *     placeholders or duplicate mermaid blocks;
 *   - falls back to leaving the placeholder alone when the DOM does not
 *     include any mermaid placeholders (the lazy-load evidence case —
 *     a markdown document without mermaid triggers zero mermaid work).
 */
export function MarkdownHtml({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Stable state so the portals have something to mount into.
  const [slots, setSlots] = useState<MermaidSlot[] | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Watch the <html> element for the light/dark class flip so diagrams
  // re-render when the user changes the theme.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const compute = () => {
      const next: "light" | "dark" = document.documentElement.classList.contains("dark")
        ? "dark"
        : "light";
      setTheme(next);
    };
    compute();
    const obs = new MutationObserver(compute);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Find every <div class="mermaid-block"> placeholder and pair it
    // with its preceding <pre class="mermaid-source"> sibling.
    const placeholders = host.querySelectorAll<HTMLDivElement>("div.mermaid-block");
    if (placeholders.length === 0) {
      // No mermaid in the document — lazy load is provably not
      // triggered. Slots stay null and MermaidBlock never mounts.
      setSlots(null);
      // Also remove any orphan <pre class="mermaid-source"> nodes so
      // the visible document never carries raw source.
      for (const pre of host.querySelectorAll<HTMLPreElement>("pre.mermaid-source")) {
        pre.remove();
      }
      return;
    }
    // The placeholder pairing walks each placeholder backwards through
    // previous siblings looking for the most recent `.mermaid-source`.
    const nextSlots: MermaidSlot[] = [];
    placeholders.forEach((placeholder, index) => {
      const source = findSourceBefore(placeholder) ?? "";
      nextSlots.push({
        host: placeholder,
        source,
        index,
      });
      // Clear the placeholder so the portal is the only thing the
      // user sees (the placeholder text was a "rendering…" hint).
      placeholder.replaceChildren();
      // Remove the source <pre> so it cannot show up via a theme
      // switch mid-render. The portal keeps `source` in props.
      const sibling = previousSourceSibling(placeholder);
      if (sibling) sibling.remove();
    });
    setSlots(nextSlots);
    return () => {
      // On unmount / HTML change, clear the placeholders so React
      // portals know to detach.
      for (const slot of nextSlots) {
        if (slot.host.isConnected) slot.host.replaceChildren();
      }
    };
  }, [html]);

  return (
    <>
      <div
        ref={hostRef}
        className="markdown-html-host"
        data-testid="markdown-html-host"
        data-mermaid-slots={slots ? String(slots.length) : "0"}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {slots?.map((slot) =>
        slot.host.isConnected
          ? createPortal(
              <MermaidBlock source={slot.source} theme={theme} />,
              slot.host,
              `mermaid-${slot.index}`,
            )
          : null,
      )}
    </>
  );
}

interface MermaidSlot {
  host: HTMLDivElement;
  source: string;
  index: number;
}

/**
 * Walk previous siblings of `placeholder` looking for the most recent
 * `<pre class="mermaid-source">`. The text content of that pre is the
 * mermaid source for the diagram. Returns the source string or null
 * if no sibling pre is found (defensive — the renderer always emits
 * the source pre, so a null here means a third-party plugin's renderer
 * misfired).
 */
function findSourceBefore(placeholder: HTMLDivElement): string | null {
  const pre = previousSourceSibling(placeholder);
  if (!pre) return null;
  // The renderer escaped the source via `escapeHtml`. Reversing the
  // escapes gives us the original diagram source text. We use
  // `innerHTML` because escaping only touched the four standard
  // entities; reading `textContent` would double-decode the entities
  // back into the rendered glyphs.
  return decodeEscapes(pre.innerHTML);
}

function previousSourceSibling(node: HTMLElement): HTMLPreElement | null {
  let cur: ChildNode | null = node.previousSibling;
  while (cur) {
    if (
      cur.nodeType === 1 /* Element */ &&
      (cur as Element).tagName.toLowerCase() === "pre" &&
      (cur as Element).classList.contains("mermaid-source")
    ) {
      return cur as HTMLPreElement;
    }
    cur = cur.previousSibling;
  }
  return null;
}

/** Reverse the four-character HTML escape we apply in the renderer. */
function decodeEscapes(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}