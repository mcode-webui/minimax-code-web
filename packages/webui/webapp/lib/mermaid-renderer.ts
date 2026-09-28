// Mermaid language renderer (slice 23 of webui-parity).
//
// Registers a renderer for the `mermaid` code-fence language so that a
// ```mermaid fence in markdown becomes a placeholder the React tree can
// find and replace with the lazy mermaid diagram component. The renderer
// itself is pure HTML — it does NOT import mermaid (mermaid is several
// megabytes and must not load for documents that do not contain a
// mermaid fence).
//
// The placeholder is two adjacent elements that survive the markdown
// sanitiser:
//
//   <pre class="mermaid-source" hidden>ESCAPED_SOURCE</pre>
//   <div class="mermaid-block">…</div>
//
// Why two siblings? The sanitiser allowlist (lib/markdown.ts) only keeps
// `class` on `<pre>` and `<div>`, so any data attribute is dropped. The
// source therefore travels as the text content of the `<pre>`, paired to
// the placeholder `<div>` by document order. After the HTML lands in the
// DOM, the MarkdownHtml component walks both containers, decodes the
// source, and replaces each placeholder `<div>` with a `<MermaidBlock>`
// portal.
//
// `hidden` is not in the sanitiser allowlist; the sanitiser drops it and
// leaves the pre visible until the React tree unmounts it (which is
// microseconds later in the same paint). The hidden CSS lives on
// `.mermaid-source` so the source pre is also inert before the React
// tree finds it. Defense in depth.
//
// The renderer is registered on module import via
// `registerLanguageRenderer`; `lib/markdown.ts` looks the language up
// before its default fenced-block renderer runs, so the markdown main
// flow stays language-agnostic.

import { escapeHtml, registerLanguageRenderer } from "./markdown";

/**
 * Build the placeholder HTML for a mermaid fence.
 *
 * The mermaid-block component (`components/mermaid-block.tsx`) reads the
 * source by walking the rendered tree after mount, so the placeholder is
 * a marker, not a working diagram.
 */
function mermaidPlaceholder(source: string): string {
  return [
    `<pre class="mermaid-source" hidden>`,
    escapeHtml(source),
    `</pre>`,
    // The placeholder is what the React tree finds and replaces. The
    // accessible label sits inside so a screen reader announces the
    // diagram (the real diagram replaces it). `class="mermaid-block"`
    // is the hook; sanitiser keeps `class` on `<div>`.
    `<div class="mermaid-block" role="figure" aria-label="mermaid diagram">`,
    `<span class="mermaid-block-loading">渲染中…</span>`,
    `</div>`,
  ].join("");
}

/**
 * Install the mermaid renderer. Idempotent because the registry is a
 * `Map.set`; calling this twice is harmless. Plugins in the future
 * (`minimax-code-plugin`) will install their own this way.
 */
export function registerMermaidRenderer(): void {
  registerLanguageRenderer("mermaid", (source) => mermaidPlaceholder(source));
}

// Auto-register on module import so the markdown pipeline picks up
// mermaid fences without an extra call site. Plugins follow the same
// pattern (import their renderer module from a one-line bootstrap).
registerMermaidRenderer();