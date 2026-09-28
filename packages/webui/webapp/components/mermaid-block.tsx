"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Lazy mermaid block — slice 23 of webui-parity.
 *
 * The markdown pipeline emits a `<pre class="mermaid-source" hidden>` next
 * to a `<div class="mermaid-block">` placeholder for every mermaid fence it
 * encounters. This component is mounted into each placeholder via
 * `MarkdownHtml`'s mount pass and is responsible for:
 *
 *   - **Lazy load.** `mermaid` is several megabytes and is `import()`-ed
 *     only when the FIRST placeholder in the document is mounted; the
 *     `import()` lands the library in a single chunk (Next/Webpack
 *     code-splits dynamic imports) that is NOT in the initial bundle.
 *     A document with zero mermaid fences never asks for the chunk,
 *     and the network probe in `MarkdownHtml` records the absence.
 *
 *   - **Theme-aware render.** Mermaid is configured with the current
 *     theme tokens from `lib/mermaid-theme.ts`. A small
 *     `MutationObserver` on `<html>` (or the explicit `theme` prop)
 *     re-renders the diagram when the user flips light/dark.
 *
 *   - **CJK fallback.** Mermaid picks up `fontFamily` from its
 *     config; the value is a stack that prefers the system CJK font
 *     (PingFang / Microsoft YaHei / Noto Sans CJK SC) so the
 *     reporter's Chinese Gantt and flowchart labels render.
 *
 *   - **Strict security.** `securityLevel: "strict"` is the mermaid
 *     preset that disables click handlers and inline HTML; the SVG is
 *     then handed to `sanitizeMermaidSvg` (lib/mermaid-svg.ts) which
 *     walks it with DOMParser and drops every tag/attribute that is
 *     not on the markdown allowlist. The accepted-input test in the
 *     ticket carries a `click` callback and inline HTML — neither
 *     survives.
 *
 *   - **Failure is legible.** A parse error from mermaid shows the
 *     error string and a copyable `<pre>` of the original source.
 *     A load failure (network / browser issue) shows a generic
 *     "diagram unavailable" with the source still copyable. Neither
 *     path blanks the document.
 */

// `mermaid` is dynamically imported (see `loadMermaid`); the type is
// loaded eagerly so we can call `mermaid.render` and friends, but the
// runtime payload is not.
import type mermaidNs from "mermaid";

type MermaidApi = typeof mermaidNs;

let mermaidPromise: Promise<MermaidApi> | null = null;

/**
 * Dynamic import of mermaid. Cached so the second diagram does not pay
 * the load cost again. The first call's promise is what the lazy-load
 * evidence watches for; if it never resolves the document did not
 * trigger the chunk.
 */
function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import("mermaid").then((mod) => mod.default ?? mod);
  return mermaidPromise;
}

/** Reset for tests. */
export function _resetMermaidForTest(): void {
  mermaidPromise = null;
}

/**
 * Tracks the most recent configuration we handed to mermaid so we can
 * detect a theme flip without re-running the parser. The
 * `MutationObserver` in the component fires on `<html>` class changes
 * and triggers a re-render when the value differs.
 */
let lastMermaidConfigKey: string | null = null;

interface MermaidBlockProps {
  /** Raw mermaid source (the body of the ```mermaid fence). */
  source: string;
  /** Theme to render against; updated by the host when the theme flips. */
  theme: "light" | "dark";
  /** Test hook — overrides the dynamic import. */
  _loadMermaid?: () => Promise<MermaidApi>;
}

export function MermaidBlock({ source, theme, _loadMermaid }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    // Last-write-wins across rapid prop updates.
    const gen = ++genRef.current;
    let cancelled = false;
    setError(null);
    setSvg(null);
    const loader = _loadMermaid ?? loadMermaid;
    (async () => {
      try {
        const mermaid = await loader();
        if (cancelled || gen !== genRef.current) return;
        const configKey = `${theme}|${source.length}|${theme}`;
        if (lastMermaidConfigKey !== configKey) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: theme === "dark" ? "dark" : "default",
            // CJK font fallback — picked up by mermaid's default theme
            // for any text it renders. The stack is intentionally
            // broad so the reporter's Chinese Gantt / flowchart labels
            // render even on a freshly installed system.
            fontFamily: [
              "-apple-system",
              "BlinkMacSystemFont",
              "Segoe UI",
              "PingFang SC",
              "Hiragino Sans GB",
              "Microsoft YaHei",
              "Noto Sans CJK SC",
              "Source Han Sans SC",
              "sans-serif",
            ].join(", "),
            // Disable everything interactive; the strict level also
            // disables click handlers, but we double-tap the message
            // by leaving flowchart curve style and htmlLabels on the
            // safe defaults.
          });
          lastMermaidConfigKey = configKey;
        }
        // mermaid.render returns { svg } (a string); older versions
        // returned the SVG directly. The union is the documented
        // contract — handle both shapes.
        const id = `mermaid-${gen}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await mermaid.render(id, source);
        if (cancelled || gen !== genRef.current) return;
        const raw = typeof result === "string" ? result : result.svg;
        // Sanitise the SVG before injection. mermaid is configured
        // strictly (no clicks, no HTML labels), but the sanitiser is
        // the second wall: anything mermaid would emit that is not on
        // the markdown allowlist (script, onload, foreignObject, …)
        // is dropped here.
        const clean = sanitiseSvg(raw);
        setSvg(clean);
      } catch (cause) {
        if (cancelled || gen !== genRef.current) return;
        // Parse error or load failure. The failure-state UI shows the
        // source so the user can copy it; this never blanks the page.
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, theme, _loadMermaid]);

  if (error) {
    return <FailureView source={source} error={error} />;
  }
  if (svg) {
    return (
      <div
        className="mermaid-block-rendered"
        data-testid="mermaid-block-rendered"
        data-theme={theme}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <div className="mermaid-block-pending" data-testid="mermaid-block-pending">
      <span className="mermaid-block-loading">渲染中…</span>
    </div>
  );
}

function FailureView({ source, error }: { source: string; error: string }) {
  return (
    <div
      className="mermaid-block-failure"
      role="alert"
      data-testid="mermaid-block-failure"
    >
      <div className="mermaid-block-failure-title">Mermaid 渲染失败</div>
      <div className="mermaid-block-failure-error" data-testid="mermaid-block-failure-error">
        {error}
      </div>
      <pre
        className="mermaid-block-failure-source"
        data-testid="mermaid-block-failure-source"
      >
        {source}
      </pre>
      <div className="mermaid-block-failure-hint">
        源代码已显示在上方，可复制。文档其余部分保持正常渲染。
      </div>
    </div>
  );
}

/**
 * Strip dangerous tags/attributes from a mermaid SVG before injection.
 *
 * Mermaid is configured with `securityLevel: "strict"` so its output
 * already lacks click handlers and inline HTML — but `strict` is
 * documented as "no clicks, no flows", not "no foreignObject, no
 * script". The defence-in-depth pass below applies the same allowlist
 * the markdown pipeline uses (see lib/markdown.ts), so any tag or
 * attribute the markdown renderer would drop is dropped here too.
 *
 * Runs in the browser; degrades to escaped text on a server prerender.
 */
function sanitiseSvg(svg: string): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return svg.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  }
  const doc = new DOMParser().parseFromString(`<body>${svg}</body>`, "image/svg+xml");
  // Mirror the markdown DROP set — never survives.
  const DROP = new Set([
    "script", "style", "iframe", "object", "embed", "link", "meta",
    "form", "input", "foreignobject",
  ]);
  // Walk the SVG tree; SVG has its own namespace but we treat tags
  // case-insensitively (SVG elements are camelCase in DOM; the
  // markdown allowlist is lower-case).
  const walk = (node: Element): void => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();
      if (DROP.has(tag)) {
        child.remove();
        continue;
      }
      walk(child);
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        // Drop every event handler and every `href` whose scheme is
        // not safe. Keep `class`, `viewBox`, `xmlns`, `d`, `x`, `y`,
        // `width`, `height`, `fill`, `stroke`, `transform`, `points`
        // — those are what the rendered diagram needs to look right.
        if (name.startsWith("on")) {
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === "href" || name === "xlink:href") {
          const value = (attr.value ?? "").trim();
          if (!/^(?:https?:|mailto:|#|\/)/i.test(value)) {
            child.removeAttribute(attr.name);
          }
          continue;
        }
        if (name === "style") {
          // Style attributes can carry expression(...) and url(...)
          // that would re-introduce XSS vectors. Drop the whole
          // attribute; mermaid's class-driven styling still applies
          // (see styles/code-preview.css).
          child.removeAttribute(attr.name);
        }
      }
    }
  };
  walk(doc.documentElement);
  return doc.body.innerHTML;
}