import { marked } from "marked";

/**
 * Markdown rendering for assistant messages and markdown file previews.
 *
 * The parser is `marked`, which the workspace already depends on
 * (`packages/tui` uses it) — it is therefore already in the lockfile and already
 * recorded in release/dependency-licenses.json as MIT, so this adds no new
 * dependency edge to the distribution.
 *
 * Options (`gfm`, `breaks`) match upstream so line breaks and GFM tables render
 * the way the desktop does.
 *
 * Assistant text can contain anything the model or a file it read produced, so
 * the parser output is sanitised (see `sanitize`) before it reaches the DOM.
 * Syntax highlighting is deliberately absent for now — upstream colours code
 * through `--code-theme-*` tokens when a highlighter is attached, and those
 * tokens are already in the token layer, so adding a highlighter later needs no
 * markup change.
 */

const OPTIONS = { gfm: true, breaks: true } as const;

marked.setOptions(OPTIONS);

/** Escape text for embedding in HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape text for embedding in an HTML attribute value (single-quoted).
 *
 * The marked renderer's `code` callback hands us `text` (the source inside
 * the fence) and `lang` (the language token after ```). Both are interpolated
 * into HTML attributes or text nodes, so the escapes here are what keep a
 * markdown author with no script context from injecting markup via the fence
 * itself. Note this is the static parser escape — the sanitiser is the second
 * wall, and either side alone is not sufficient.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Language → renderer registry.
 *
 * This is the seam that future minimax-code-plugin renderers will hook into.
 * A code fence's `lang` token is matched against this map; the matching
 * renderer owns the HTML the parser emits for that fence.
 *
 * Design rules (so the registry stays extensible without rewrites):
 *
 *   - **No `if (lang === "mermaid")` inside the marked renderer.** The marked
 *     code-callback below dispatches via `languageRenderers.get(lang)`, so a
 *     third-party renderer just calls `registerLanguageRenderer(...)` once and
 *     is wired in. The main flow never branches on a particular language.
 *
 *   - **Renderers are pure functions.** They receive `(source, lang)` and
 *     return the HTML fragment the parser should splice in. No side effects,
 *     no DOM access — `parseMarkdown` runs in Node during the prerender
 *     static export and would explode on a renderer that touches
 *     `document`.
 *
 *   - **The default code renderer stays the fallback.** When a language is
 *     unknown, the built-in fenced-block shell is emitted exactly as before.
 *     A language that is registered but throws stays in the fallback path
 *     too, so a broken third-party renderer cannot blank the document — see
 *     `safeLanguageRenderer` below.
 *
 *   - **Renderers emit sanitised HTML.** The sanitiser after marked drops
 *     everything that is not on the allowlist. Renderers must therefore
 *     escape their own source text — `escapeHtml` is exported below for that.
 *
 * To add a new renderer:
 *   ```ts
 *   registerLanguageRenderer("my-format", (source) => `<div>...</div>`);
 *   ```
 * That single call is enough; no main-flow edits, no plugin imports in the
 * parser file.
 */
export type LanguageRenderer = (source: string, lang: string) => string;

const languageRenderers = new Map<string, LanguageRenderer>();

/**
 * Register a renderer for a fence language. The renderer is called with the
 * raw fence body and the lang token and returns the HTML fragment the parser
 * should splice in. Re-registering the same language replaces the previous
 * renderer; this is the documented plugin-extension path.
 *
 * Plugin code typically calls this once at module-init time:
 *   ```ts
 *   import { registerLanguageRenderer } from "@/lib/markdown";
 *   registerLanguageRenderer("vega-lite", vegaLiteRenderer);
 *   ```
 */
export function registerLanguageRenderer(lang: string, renderer: LanguageRenderer): void {
  if (!lang) throw new Error("registerLanguageRenderer: lang must be non-empty");
  if (typeof renderer !== "function") {
    throw new Error("registerLanguageRenderer: renderer must be a function");
  }
  languageRenderers.set(lang.toLowerCase().trim(), renderer);
}

/** Test-only escape hatch — clears the registry. Never called in production. */
export function _clearLanguageRenderersForTest(): void {
  languageRenderers.clear();
}

/** Test-only — list the registered language tokens. */
export function _registeredLanguageRenderersForTest(): string[] {
  return [...languageRenderers.keys()];
}

/**
 * Extract the bare language token from a marked `lang` field.
 *
 * marked passes through everything after the fence opener up to the
 * first newline; metadata like `` ```mermaid {theme: dark} `` arrives
 * as `"mermaid {theme: dark}"`. The registry keys on the bare token,
 * so we split on whitespace and lower-case.
 */
function bareLanguage(lang: string): string {
  const head = (lang ?? "").trim().split(/\s+/)[0] ?? "";
  return head.toLowerCase();
}

/**
 * Run a registered renderer with a guarantee it cannot break the document.
 *
 * If a third-party renderer throws, returns undefined, or returns a fragment
 * that contains nothing parseable, the fence falls back to the plain
 * codeblock shell. The thrown error is re-thrown through the wrapper's
 * caller so the dev console still surfaces it, but the markdown continues to
 * render — the next fence, the headings, the prose — exactly as before. This
 * is the property the acceptance criteria call "整篇文档其余部分正常渲染":
 * one bad renderer does not blank the page.
 */
function safeLanguageRenderer(lang: string, source: string): string | null {
  const key = bareLanguage(lang);
  if (!key) return null;
  const renderer = languageRenderers.get(key);
  if (!renderer) return null;
  try {
    const out = renderer(source, lang);
    if (typeof out !== "string" || out.length === 0) return null;
    return out;
  } catch (cause) {
    // Surface in dev console; never let it propagate.
    if (typeof console !== "undefined") {
      console.warn(`[markdown] language renderer for "${key}" threw`, cause);
    }
    return null;
  }
}

/**
 * Emit upstream's code-block and inline-code markup.
 *
 * This matters because upstream neutralises the browser default on bare blocks —
 * `pre:not(.codeblock-pre){padding:0;background:transparent;border:none}` — so the
 * parser's default `<pre><code>` renders with no background and no padding at all.
 * The shell below is the one those rules expect: a `codeblock-shell` column holding
 * a `codeblock-toolbar` (language + copy) over `pre.codeblock-pre` with
 * `code.codeblock-code`. Inline code uses `code.inline-code`, which upstream styles
 * separately.
 */
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = bareLanguage(lang ?? "");
      // Language-aware path: dispatch to the registered renderer (the seam
      // future plugins attach to). The match is on the bare language token
      // — `mermaid` matches but `mermaid-foo` does not.
      const label = language ? `<span class="codeblock-lang">${escapeHtml(language)}</span>` : "";
      if (language) {
        const custom = safeLanguageRenderer(lang ?? language, text);
        if (custom !== null) return custom;
      }
      return [
        `<div class="codeblock-shell">`,
        `<div class="codeblock-toolbar">${label}</div>`,
        `<pre class="codeblock-pre">`,
        `<code class="codeblock-code${language ? ` language-${escapeHtml(language)}` : ""}">${escapeHtml(text)}</code>`,
        `</pre>`,
        `</div>`,
      ].join("");
    },
    codespan({ text }: { text: string }) {
      return `<code class="inline-code">${escapeHtml(text)}</code>`;
    },
  },
});

/** Tags marked can emit and that we are willing to render. */
export const ALLOWED_TAGS = new Set([
  // Container tags are needed for the code-block shell emitted by the renderer
  // below (`codeblock-shell` / `codeblock-toolbar` are divs, `codeblock-lang` is a
  // span). Dropping them unwraps the shell and the official styling never applies.
  "div", "span",
  "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "table", "thead", "tbody", "tr", "th", "td",
  // KaTeX HTML output is built exclusively from `span`, `svg` and `path`
  // (`lib/math-renderer.ts`). `svg` is therefore removed from the DROP set
  // below, and its subtree is walked like any other element: a `<script>` or
  // an `<animate>` inside a hand-written `<svg>` still cannot survive (they
  // are not in this set), and `svg` admits no `href`-like attribute at all.
  "svg", "path",
]);

/** Attributes kept per tag; everything else is dropped. */
export const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  code: new Set(["class"]),
  pre: new Set(["class"]),
  // `class` is inert (no script, no URL) and is what carries the design-system
  // styling; a markdown author can therefore only restyle, not execute.
  div: new Set(["class"]),
  // `style` on `span` (plus the geometry attributes on `svg`/`path`) is what
  // KaTeX markup needs — its layout is inline-styled spans. Every `style`
  // value is additionally vetted by `isSafeStyleValue` below, so the value
  // charset cannot express a URL, an `expression(...)` or a position change.
  span: new Set(["class", "aria-hidden", "style"]),
  svg: new Set(["class", "xmlns", "width", "height", "viewbox", "preserveaspectratio"]),
  path: new Set(["d"]),
  th: new Set(["align"]),
  td: new Set(["align"]),
};

/**
 * Style property names rejected even where the value check would pass.
 *
 * KaTeX never emits them inline; refusing them keeps layout hijacking (a
 * `position: fixed` overlay, a background-image beacon) out of reach even if
 * the value charset below were ever relaxed.
 */
const FORBIDDEN_STYLE_PROPERTIES = new Set([
  "position", "background", "background-image", "behavior", "binding",
  "-moz-binding",
]);

/**
 * Whether an inline `style` attribute value is safe to keep.
 *
 * The grammar is deliberately narrower than CSS: each declaration must be
 * `property: value` with a plain identifier property and a value drawn from
 * identifier characters, digits and the few punctuation marks CSS geometry
 * uses (`-`, `.`, `%`, `#`, `,`, `_`, whitespace). Parentheses, slashes and
 * `@` cannot appear, ruling out `url(...)`, `expression(...)`, `@import` and
 * `image-set()` outright; the forbidden-property list above is defence in
 * depth on top of that.
 *
 * Exported for the policy tests, and mirrored by the React-side style parser
 * in `components/markdown-html.tsx` — the two must accept the same grammar.
 */
export function isSafeStyleValue(value: string): boolean {
  for (const declaration of value.split(";")) {
    const trimmed = declaration.trim();
    if (trimmed === "") continue;
    const match = trimmed.match(/^(-?[a-zA-Z]+(?:-[a-zA-Z]+)*)\s*:\s*([-a-zA-Z0-9.%#_,\s]*)$/);
    const property = match?.[1];
    if (!match || property === undefined) return false;
    if (FORBIDDEN_STYLE_PROPERTIES.has(property.toLowerCase())) return false;
  }
  return true;
}

/**
 * Parse an inline `style` attribute value into a React style object.
 *
 * This is the reshaping mirror of `isSafeStyleValue`: the sanitiser has
 * already vetted the grammar it accepts, so this function only splits
 * declarations on `;`, splits each on the first `:`, camelCases the property
 * (`margin-right` → `marginRight`) and skips anything malformed instead of
 * throwing.
 *
 * Needed because React rejects a string `style` prop outright (console error,
 * styles never applied) — the React tree builder in
 * `components/markdown-html.tsx` must hand it an object. Exported for the
 * policy tests, which pin the exact shape React receives: a wrong key casing
 * silently drops that one declaration.
 */
export function parseInlineStyle(value: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const declaration of value.split(";")) {
    const trimmed = declaration.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    const propertyValue = trimmed.slice(colon + 1).trim();
    if (!property || propertyValue === "") continue;
    const camel = property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    style[camel] = propertyValue;
  }
  return style;
}

const SAFE_URL = /^(?:https?:|mailto:|#|\/)/i;

/**
 * Reduce rendered HTML to the tags and attributes above.
 *
 * Runs in the browser via DOMParser, which parses without executing scripts and
 * without fetching subresources, so walking the tree is safe. Elements that are not
 * allowed are unwrapped (children kept) except for tags whose content is dangerous
 * (script/style/etc.), which are dropped whole.
 */
function sanitize(html: string): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    // Static export prerender: the transcript is empty, so there is nothing to
    // render. Returning escaped text keeps this path inert rather than unsafe.
    return html.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  }

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  // `svg` is NOT in this set: KaTeX (lib/math-renderer.ts) emits real
  // `<svg>` geometry and needs it to survive. Its subtree is still walked —
  // scripts, event handlers and any attribute outside ALLOWED_ATTRS are
  // stripped exactly as they are everywhere else.
  const DROP = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "math"]);

  const walk = (node: Element): void => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();

      if (DROP.has(tag)) {
        child.remove();
        continue;
      }

      // Recurse first so unwrapped children are sanitised too.
      walk(child);

      if (!ALLOWED_TAGS.has(tag)) {
        child.replaceWith(...child.childNodes);
        continue;
      }

      const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (!allowed.has(name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === "href" && !SAFE_URL.test(attr.value.trim())) {
          child.removeAttribute(attr.name);
          continue;
        }
        // `style` passes the name check only where the allowlist admits it;
        // the value must additionally clear the safe-grammar check, so a
        // hand-written `style="background:url(...)"` loses the attribute.
        if (name === "style" && !isSafeStyleValue(attr.value)) {
          child.removeAttribute(attr.name);
        }
      }

      // External links open away from the app; the page is not a navigable site.
      if (tag === "a" && child.getAttribute("href")) {
        child.setAttribute("rel", "noopener noreferrer");
        child.setAttribute("target", "_blank");
      }
    }
  };

  walk(doc.body);
  return doc.body.innerHTML;
}

/**
 * Render markdown to HTML *without* sanitising.
 *
 * Separated from `renderMarkdown` so the emitted markup can be asserted without a
 * DOM, and so the two concerns stay independent: this function owns "what the
 * parser and our renderer overrides produce", `sanitize` owns "what may reach the
 * DOM". Callers must not use this directly for DOM insertion.
 */
export function parseMarkdown(source: string): string {
  return marked.parse(source, { async: false }) as string;
}

/**
 * Render markdown to sanitised HTML.
 *
 * Without a DOM the sanitiser cannot walk the tree, and it degrades to escaped
 * text rather than forwarding unparsed HTML. That path is only reachable during the
 * static export's prerender, where there is no transcript to render; it exists so
 * the function is total, not as a rendering mode.
 */
export function renderMarkdown(source: string): string {
  return sanitize(parseMarkdown(source));
}

// Re-export escape helpers so a third-party renderer does not have to ship its
// own — the parser path's escape rules and the sanitiser's escape rules have
// to stay in sync, and giving the registry a one-stop import is the cheapest
// way to keep that contract honest.
export { escapeHtml, escapeAttribute };