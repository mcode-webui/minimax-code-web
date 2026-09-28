// Math renderer (KaTeX) for assistant messages and markdown previews.
//
// Three input shapes render as formulas, mirroring the desktop client:
//
//   - `$E=mc^2$`   inline math inside prose;
//   - `$$…$$`      display math (block-level, centred);
//   - ```math      a fenced code block whose language token is `math`.
//
// The first two are a marked inline extension (`webuiMath`); the third goes
// through the language→renderer registry (`registerLanguageRenderer`), the
// same seam `mermaid` uses — the markdown main flow stays language-agnostic
// and the two features cannot shadow each other.
//
// KaTeX is used in HTML output mode (`output: "html"`). That mode emits only
// `span`, `svg` and `path` elements, which is exactly the surface the
// sanitiser allowlist in `lib/markdown.ts` is extended for. The default
// "htmlAndMathml" mode would additionally emit a `<math>` MathML tree, which
// the sanitiser drops whole (it is a DROP tag) — silently producing half a
// formula — so the MathML leg is switched off rather than rendered broken.
//
// Failure contract (acceptance criterion: a broken formula degrades to the
// original text, never a blank page):
//
//   - inline/display `$…$`: `katex.renderToString` throws on invalid input
//     (`throwOnError` defaults to true and is set explicitly); the catch
//     emits the raw source (delimiters included) as
//     `<code class="inline-code">` — the same markup ordinary inline code
//     uses, so it inherits the existing code styling in both themes.
//   - ```math fence: the renderer lets the error propagate and the registry's
//     `safeLanguageRenderer` wrapper falls back to the plain fenced-block
//     shell, so the original source is visible as a code block — identical
//     to how a throwing third-party renderer behaves.
//
// `\href` and other trust-gated features stay disabled (KaTeX's `trust`
// defaults to false and is not raised here), so a formula cannot smuggle a
// link URL through the math parser.

import katex from "katex";
import { marked } from "marked";

import { escapeHtml, registerLanguageRenderer } from "./markdown";

/** KaTeX options shared by all three input shapes. */
const KATEX_OPTIONS = {
  // HTML-only output: the only element surface we extend the sanitiser for.
  output: "html",
  // An invalid formula must throw so the caller can degrade to `<code>`;
  // `throwOnError: true` is KaTeX's default but is pinned here because the
  // degradation contract depends on it.
  throwOnError: true,
  // Non-fatal strict-mode complaints (e.g. unicode text in math mode) are
  // rendered as-is; they must not spam the console for model output.
  strict: false,
} as const;

/** Render one formula; throws on invalid input (see module comment). */
function renderMathToHtml(source: string, displayMode: boolean): string {
  return katex.renderToString(source, { ...KATEX_OPTIONS, displayMode });
}

/**
 * Build the HTML for a `$…$` / `$$…$$` token.
 *
 * The inline extension tokenises (below) and renders (here); on a KaTeX
 * parse error the raw source — delimiters included — degrades to inline
 * code, which is the documented failure shape for prose-embedded math.
 */
function mathExtensionRenderer(token: {
  text?: string;
  raw?: string;
  display?: boolean;
}): string {
  const source = token.text ?? "";
  try {
    return renderMathToHtml(source, token.display === true);
  } catch {
    return `<code class="inline-code">${escapeHtml(token.raw ?? source)}</code>`;
  }
}

/**
 * Inline math extension.
 *
 * Tokenising rules are intentionally conservative so ordinary prose never
 * turns into formulas:
 *
 *   - a single-dollar body cannot span lines and cannot start with a digit,
 *     so `costs $5 and $10` stays prose;
 *   - an unclosed `$` or `$$` never matches (the body needs a closing
 *     delimiter) and the text passes through untouched;
 *   - `\(`…`\)` is deliberately NOT math here: the start hook reserves the
 *     index only so a later `$` is not consumed first; the tokenizer still
 *     requires a dollar delimiter, matching the desktop behaviour.
 */
const MATH_START = /\$\$?|\\\(/u;

marked.use({
  extensions: [
    {
      name: "webuiMath",
      level: "inline",
      start(source: string): number | undefined {
        const index = source.search(MATH_START);
        return index >= 0 ? index : undefined;
      },
      tokenizer(source: string) {
        const match = source.match(/^(\$\$?)([\s\S]+?)\1/u);
        if (!match) return undefined;
        const delimiter = match[1];
        const body = match[2];
        if (delimiter === undefined || body === undefined) return undefined;
        // Single-dollar inline math cannot cross a line or attach to a
        // number — the `$5 and $10` false-positive guard.
        if (delimiter === "$" && (body.includes("\n") || /^\d/u.test(body))) {
          return undefined;
        }
        return {
          type: "webuiMath",
          raw: match[0],
          text: body,
          display: delimiter === "$$",
        };
      },
      renderer(token) {
        return mathExtensionRenderer(
          token as unknown as { text?: string; raw?: string; display?: boolean },
        );
      },
    },
  ],
});

/**
 * Install the ```math fence renderer.
 *
 * Success emits KaTeX display-mode HTML directly (a `.katex-display` span,
 * block-level through the KaTeX stylesheet). Failure throws into the
 * registry's `safeLanguageRenderer` wrapper, which falls back to the plain
 * codeblock shell — the source stays visible as a code block.
 *
 * Idempotent (`Map.set`), matching the mermaid renderer's install contract.
 */
export function registerMathRenderer(): void {
  registerLanguageRenderer("math", (source) => renderMathToHtml(source, true));
}

// Auto-register on module import, the same pattern as
// `lib/mermaid-renderer.ts`: importing this module from a client entry is
// the whole wiring; the markdown main flow stays language-agnostic.
registerMathRenderer();
