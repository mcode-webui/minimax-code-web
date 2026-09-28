"use client";

import {
  Children,
  createElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { MermaidBlock } from "./mermaid-block";
import { parseInlineStyle } from "../lib/markdown";

/**
 * Render pre-sanitised HTML and mount mermaid blocks as real React
 * components.
 *
 * Why this is a real React tree and not a `dangerouslySetInnerHTML`
 * injection followed by a one-shot DOM walk + portal:
 *
 *   - The previous design injected the sanitised HTML once after
 *     mount, then walked the DOM to find mermaid placeholders and
 *     replaced each placeholder with a `createPortal(<MermaidBlock>,
 *     placeholder)`. That works on first commit but a later React
 *     re-commit of the SAME html re-applies `dangerouslySetInnerHTML`,
 *     which **replaces the inner DOM** (the placeholders are now
 *     fresh nodes). The previously-portalled `MermaidBlock` instances
 *     are attached to the OLD detached placeholders and become
 *     orphans — the diagram never mounts, and the placeholder stays
 *     at "渲染中…" forever. No console error fires; the failure is
 *     silent. (Acceptance run.)
 *
 *   - The fix in this version parses the sanitised HTML on every
 *     render and converts it to a React element tree. Each mermaid
 *     placeholder pair is recognised by the walker and replaced with
 *     a `<MermaidBlock source=... theme=.../>` element — a real React
 *     node, in the real React tree, that React re-reconciles on every
 *     commit. Re-commits are idempotent: the walker runs again, finds
 *     the placeholders in the FRESH input, and emits the same
 *     `<MermaidBlock>` elements. No portals, no DOM walks, no
 *     orphaned subtrees.
 *
 * SSR fallback: when `DOMParser` is unavailable (the static-export
 * prerender), the walker falls back to a single `dangerouslySetInnerHTML`
 * element. The mermaid path is a no-op in SSR — there is nothing to
 * render — and the live mermaid mount happens entirely client-side.
 */
export function MarkdownHtml({ html }: { html: string }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Watch the <html> element for the light/dark class flip so diagrams
  // re-render when the user changes the theme.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const compute = (): "light" | "dark" => {
      return document.documentElement.classList.contains("dark")
        ? "dark"
        : "light";
    };
    setTheme(compute());
    const obs = new MutationObserver(() => setTheme(compute()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  // Convert the sanitised HTML to a React tree. The walker is pure —
  // same input always yields the same tree — and mermaid blocks are
  // emitted as `<MermaidBlock source=... theme=.../>` directly. No
  // portal, no second DOM pass.
  const tree = htmlToReact(html, theme);

  return (
    <div
      className="markdown-html-host"
      data-testid="markdown-html-host"
      data-mermaid-count={countMermaid(tree)}
    >
      {tree}
    </div>
  );
}

/**
 * Walk a sanitised HTML string and convert it to a React tree.
 *
 * The walker:
 *
 *   - emits one `ReactNode` per child node of the parsed body, in
 *     order (text nodes, element nodes);
 *   - recognises the mermaid placeholder pair `<pre class="mermaid-source"
 *     hidden>SOURCE</pre><div class="mermaid-block">…</div>` and
 *     replaces the `<div>` with a `<MermaidBlock source=.../>` —
 *     the `<pre>` is consumed (skipped) since its text content has
 *     been folded into the MermaidBlock prop;
 *   - passes through every other tag with the sanitiser's allowed
 *     attributes (`class`, `href`, `title`, `align`) so a markdown
 *     document looks the same as before — only the mermaid fences
 *     are upgraded from inert HTML to a live component.
 *
 * Returns a single `dangerouslySetInnerHTML` element from inside the
 * tree on SSR (when `DOMParser` is undefined); the prerender still
 * produces a non-empty HTML response.
 */
function htmlToReact(html: string, theme: "light" | "dark"): ReactNode {
  if (typeof DOMParser === "undefined") {
    return (
      <div
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  );

  // Keep a counter for stable React keys across the walk.
  let key = 0;

  const walkChildren = (parent: Element | Document): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === 3 /* text */) {
        const text = child.textContent ?? "";
        if (text.length === 0) continue;
        out.push(text);
        continue;
      }
      if (child.nodeType !== 1 /* element */) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      // mermaid placeholder pair: consume the preceding source <pre>
      // (skipped) and replace the following <div class="mermaid-block">
      // with a real <MermaidBlock source=...>.
      if (tag === "pre" && el.classList.contains("mermaid-source")) {
        continue;
      }
      if (tag === "div" && el.classList.contains("mermaid-block")) {
        const source = findMermaidSourceBefore(el);
        out.push(
          createElement(MermaidBlock, {
            key: `mermaid-${key++}`,
            source,
            theme,
          }),
        );
        continue;
      }

      const props: Record<string, unknown> = { key: `n${key++}` };
      for (const attr of el.attributes) {
        const name = attr.name.toLowerCase();
        if (name === "class") {
          props.className = attr.value;
        } else if (name === "style") {
          // KaTeX layout lives in inline styles, and React requires the
          // style prop as an object — a string is rejected with a console
          // error and the styles never apply. The value was already vetted
          // by the sanitiser's `isSafeStyleValue`; this only reshapes it.
          props.style = parseInlineStyle(attr.value);
        } else {
          props[attr.name] = attr.value;
        }
      }
      const children = walkChildren(el);
      out.push(
        createElement(tag, props, children.length > 0 ? children : undefined),
      );
    }
    return out;
  };

  return walkChildren(doc.body);
}

/**
 * Find the source text for a mermaid placeholder.
 *
 * The renderer (lib/mermaid-renderer.ts) emits a
 * `<pre class="mermaid-source" hidden>SOURCE</pre>` immediately
 * before each `<div class="mermaid-block">`. We walk the previous
 * siblings of `placeholder` to find the source.
 *
 * IMPORTANT: read `pre.textContent`, not `pre.innerHTML`.
 *
 * The renderer escapes the source via `escapeHtml` (`&`→`&amp;`,
 * `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#39;`) so a hostile
 * fence cannot smuggle markup through the placeholder. By the time
 * DOMParser has parsed the sanitised HTML, the entity references
 * have already been decoded back into literal characters — that is
 * what `textContent` returns.
 *
 * `pre.innerHTML`, by contrast, **re-serialises** the text content
 * and re-emits entities (`<` → `&lt;`). A naive `.replace(/</g,
 * "<")` over that string is therefore a no-op against the literal
 * character (`<` never appears in `innerHTML`) and silently leaves
 * `--&gt;` in the source handed to mermaid, which then refuses to
 * parse every flowchart that uses `-->|label|` edge syntax and
 * corrupts the failure-state "copy source" button (the user copies
 * `A --&gt;|是| B`, not `A -->|是| B`).
 *
 * Exported under a test-only name so the markdown-html-render test
 * suite can assert this contract without booting a full DOM (the
 * suite has no jsdom / happy-dom and the walker lives in client
 * code). The element contract is the small DOM Level 1 surface the
 * function actually touches: `nodeType`, `tagName`, `classList`,
 * `textContent`, `previousSibling`.
 */
export function findMermaidSourceBefore(placeholder: {
  previousSibling: unknown;
}): string {
  let cur: unknown = placeholder.previousSibling;
  while (cur) {
    const node = cur as {
      nodeType?: number;
      tagName?: string;
      classList?: { contains(c: string): boolean };
      textContent?: string | null;
    };
    if (
      node.nodeType === 1 &&
      typeof node.tagName === "string" &&
      node.tagName.toLowerCase() === "pre" &&
      node.classList?.contains("mermaid-source")
    ) {
      return node.textContent ?? "";
    }
    cur = (cur as { previousSibling?: unknown }).previousSibling;
  }
  return "";
}

/**
 * Count the number of `<MermaidBlock>` instances in a rendered tree.
 *
 * Used for the `data-mermaid-count` attribute on the host div so a
 * regression test can assert "the markdown produced N mermaid
 * diagrams" without depending on internal walker details.
 */
function countMermaid(node: ReactNode): number {
  let count = 0;
  Children.forEach(node, (child) => {
    if (!child || typeof child !== "object") return;
    if (Array.isArray(child)) {
      for (const c of child) count += countMermaid(c);
      return;
    }
    const el = child as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === MermaidBlock) count++;
    if (el.props?.children) count += countMermaid(el.props.children);
  });
  return count;
}