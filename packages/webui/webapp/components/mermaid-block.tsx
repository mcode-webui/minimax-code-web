"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Lazy mermaid block — slice 23 of webui-parity.
 *
 * The markdown pipeline emits a `<pre class="mermaid-source" hidden>`
 * next to a `<div class="mermaid-block">` placeholder for every mermaid
 * fence it encounters. `MarkdownHtml` walks the parsed HTML and emits a
 * real `<MermaidBlock source=... theme=.../>` React element for each
 * placeholder, so this component owns its own lifecycle — no portal,
 * no second DOM pass, no orphan risk on React re-commits.
 *
 * Responsibilities:
 *
 *   - **Lazy load.** `mermaid` is several megabytes and is `import()`-ed
 *     only when the FIRST placeholder in the document mounts; the
 *     `import()` lands the library in a single webpack chunk that is
 *     NOT in the initial bundle. A document with zero mermaid fences
 *     never asks for the chunk.
 *
 *   - **Theme-aware render.** `mermaid.initialize` is called once per
 *     distinct config (see `_mermaidConfigKeyForTest`) so theme flips
 *     trigger a re-render without resetting the parser cache.
 *
 *   - **CJK fallback.** The `fontFamily` stack passed to mermaid
 *     prefers the system CJK font (PingFang / Microsoft YaHei / Noto
 *     Sans CJK SC) so Chinese Gantt and flowchart labels render.
 *
 *   - **Strict security + `%%{init}` hardening.** `securityLevel:
 *     "strict"` is the mermaid preset that disables click handlers
 *     and inline HTML. The `%%{init:...}` directive the user can put
 *     inside a mermaid source is stripped before reaching mermaid
 *     because it can override the security level (an `init: "loose"`
 *     would re-enable the XSS surface). The SVG output is then walked
 *     through the same allowlist the markdown pipeline uses — see
 *     `sanitiseSvg` below.
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
 *
 * The key MUST include every configuration value that affects the
 * emitted SVG — adding a new flag to the `mermaid.initialize` call
 * below without also bumping this key would silently leave a stale
 * config in mermaid's internal state on a theme flip. The key
 * previously read `${theme}|${source.length}|${theme}` (which had
 * `theme` duplicated and ignored the htmlLabels/suppressErrorRendering
 * overrides), so this version hashes the live config object.
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

export function _stripMermaidInitForTest(source: string): string {
  return stripMermaidInit(source);
}

/**
 * The font stack we hand to mermaid as `fontFamily`. CJK fallback —
 * PingFang SC (macOS), Microsoft YaHei (Windows), Noto Sans CJK SC
 * (Linux distros without the Apple/Microsoft fonts). Exported so the
 * test suite can assert the stack survived a refactor of
 * `mermaid.initialize`.
 */
export const _mermaidFontFamilyForTest = "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif";

/**
 * Build the `mermaid.initialize` argument for the production
 * `MermaidBlock`. Exported so the test suite can assert every option
 * the production code passes — a regression that drops
 * `htmlLabels: false` or `suppressErrorRendering: true` would let
 * foreignObject labels / bomb SVGs back into the DOM, and that
 * regression must be caught by the unit harness even though the
 * full mermaid path requires a browser.
 *
 * The four non-obvious options, each of which has caused a real
 * acceptance failure and is tested in `markdown-html-render.test.ts`:
 *
 *   - `htmlLabels: false` (top-level) + `flowchart: { htmlLabels:
 *     false }`. mermaid 11 ships `htmlLabels: true` as the global
 *     default, which puts node labels and edge labels inside
 *     `<foreignObject>` blocks. The sanitiser has to drop
 *     `<foreignObject>` wholesale (allowing it would re-introduce
 *     the same HTML-injection surface `securityLevel: "strict"` is
 *     supposed to close), so every flowchart / pie / class / state
 *     diagram rendered as an empty box until we disabled the
 *     html-label path here. The mermaid 11 labelHelper reads from
 *     TWO config slots — node labels read the top-level
 *     `htmlLabels`, edge labels read `flowchart.htmlLabels`. Both
 *     must be set to false; one alone leaves foreignObjects behind
 *     (verified against mermaid 11.12.1).
 *
 *   - `suppressErrorRendering: true`. Stop mermaid from injecting
 *     the "Syntax error in text" bomb SVG into `document.body` on
 *     every parse failure. By default mermaid appends a 2400×512
 *     error SVG to the page even when the host caller (us) catches
 *     the thrown error and renders a legible failure UI; the bomb
 *     is then left orphaned at the bottom of the document, outside
 *     any mermaid card, × N where N is the number of bad fences in
 *     the markdown. With this flag, mermaid calls its internal
 *     `removeTempElements()` on every error path, so `document.body`
 *     is left clean.
 *
 *   - `securityLevel: "strict"`. The mermaid preset that disables
 *     click handlers and inline HTML. Combined with the `%%{init}`
 *     stripper and the sanitiser, this is the third wall that keeps
 *     a hostile fence from triggering an external request beacon.
 *
 *   - The CJK font fallback on `fontFamily` so Chinese Gantt and
 *     flowchart labels render on a freshly installed system.
 */
export function _mermaidInitializeOptionsForTest(theme: "light" | "dark"): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    fontFamily: _mermaidFontFamilyForTest,
  };
}

/**
 * Build the config-change key the component compares against
 * `lastMermaidConfigKey` to decide whether `mermaid.initialize` must
 * re-run. Exported so the test suite can pin the key's contract.
 *
 * The contract the tests pin (and a historical bug made necessary):
 *
 *   - The key MUST track the **content** of the initialize options. An
 *     earlier implementation keyed on `${theme}|${source.length}`, so
 *     an options change behind an unchanged source length produced the
 *     SAME key and the new `mermaid.initialize` silently never ran —
 *     acceptance flipped an option in place and nothing re-initialised,
 *     with the entire unit suite still green (nothing asserted the
 *     key). Hashing the live options object makes that drift
 *     impossible: content changes, key changes.
 *
 *   - `source` deliberately does NOT participate in the key. `source`
 *     is consumed by the `mermaid.render` call, not `initialize`; two
 *     different diagrams sharing one config must NOT re-initialise
 *     mermaid between them.
 *
 *   - Identical inputs must produce the identical key — the guard
 *     exists to skip no-op re-initialisation.
 */
export function _mermaidConfigKeyForTest(
  theme: "light" | "dark",
  source: string,
  options: Record<string, unknown>,
): string {
  return `${theme}|${JSON.stringify(options)}`;
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
        // The configKey includes EVERY value passed to mermaid.initialize
        // (theme, htmlLabels, suppressErrorRendering, fontFamily). Adding a
        // new option to the shared `_mermaidInitializeOptionsForTest` builder
        // above without also extending this key would silently leave mermaid
        // running with a stale config across a theme flip. Hashing the actual
        // options (rather than a brittle human-typed signature) makes that
        // drift impossible: if the options shape changes, the hash changes,
        // and mermaid re-initialises.
        const options = _mermaidInitializeOptionsForTest(theme);
        const configKey = _mermaidConfigKeyForTest(theme, source, options);
        if (lastMermaidConfigKey !== configKey) {
          mermaid.initialize(options);
          lastMermaidConfigKey = configKey;
        }
        // Hardening: strip `%%{init:{...}}` directives before passing
        // the source to mermaid. Mermaid honours these on the parsed
        // diagram and they can override the security level — a hostile
        // `%%{init:{"securityLevel":"loose"}}` would re-enable
        // htmlLabels + <img src=x> and turn the diagram into a request
        // beacon. The acceptance run reproduced this; the source-side
        // filter is the fix.
        const hardened = stripMermaidInit(source);
        // mermaid.render returns { svg } (a string); older versions
        // returned the SVG directly. The union is the documented
        // contract — handle both shapes.
        const id = `mermaid-${gen}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await mermaid.render(id, hardened);
        if (cancelled || gen !== genRef.current) return;
        const raw = typeof result === "string" ? result : result.svg;
        // Sanitise the SVG before injection. Mermaid is configured
        // strictly (no clicks, no HTML labels) and the %%{init} is
        // stripped above, but the sanitiser is the third wall: anything
        // mermaid emits that is not on the markdown allowlist (script,
        // onload, foreignObject, …) is dropped here.
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
 * Strip a `%%{init:{...}}` directive from a mermaid source.
 *
 * Mermaid applies `%%{init:{...}}` blocks at parse time and they
 * override every other configuration source — including the
 * `mermaid.initialize({securityLevel: "strict"})` call we make in
 * this component. A hostile input carrying
 * `%%{init:{"securityLevel":"loose"}}` therefore re-enables the
 * htmlLabels + <img> + <foreignObject> surface we explicitly
 * disabled, and the browser will fetch whatever remote URL the
 * diagram embeds. The acceptance run reproduced this as a request
 * beacon. The strip happens before the source reaches mermaid so
 * the directive never has a chance to take effect.
 *
 * The match uses a brace-counting walk, not a regex. A regex
 * `[^}]*` is wrong here because mermaid init bodies can contain
 * nested JSON braces (`{"flowchart":{"htmlLabels":true}}`); the
 * naive regex stops at the first `}` and leaves the outer `}}` plus
 * the rest of the source in a state mermaid's parser then chokes on.
 * The walker counts opening / closing braces from the position
 * right after `init:` and stops at the matching close — every
 * `%%{init:...}` is removed wholesale, but nothing else.
 */
function stripMermaidInit(source: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < source.length) {
    // Find the next `%%` marker. Whitespace between `%%` and `{` is
    // tolerated — mermaid's own parser is lenient.
    const pctStart = source.indexOf("%%", cursor);
    if (pctStart < 0) {
      out += source.slice(cursor);
      break;
    }
    // Scan past whitespace for the `{`.
    let braceIdx = pctStart + 2;
    while (braceIdx < source.length && /\s/.test(source.charAt(braceIdx))) braceIdx++;
    if (source.charAt(braceIdx) !== "{") {
      // Not a `%%{...}` form — emit and continue past the `%%`.
      out += source.slice(cursor, pctStart + 2);
      cursor = pctStart + 2;
      continue;
    }
    // From here on we are inside `%%{...}`.
    const directiveStart = braceIdx;
    const inner = source.slice(directiveStart + 1);
    if (!/^\s*init\s*:/i.test(inner)) {
      // Different `%%{...}` form — keep the marker and continue
      // past the next `}` (no brace-counting needed since we are
      // not stripping this directive, only moving the cursor).
      const closeIdx = source.indexOf("}", directiveStart + 1);
      out += source.slice(cursor, closeIdx >= 0 ? closeIdx + 1 : directiveStart + 1);
      cursor = closeIdx >= 0 ? closeIdx + 1 : directiveStart + 1;
      continue;
    }
    // Walk forward, counting braces, to find the directive's close.
    const colonOffset = inner.search(":");
    if (colonOffset < 0) {
      out += source.slice(cursor);
      break;
    }
    const bodyStart = directiveStart + 1 + colonOffset + 1;
    let depth = 1;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) {
      // Unterminated directive — bail and keep the rest verbatim.
      out += source.slice(cursor);
      break;
    }
    out += source.slice(cursor, pctStart);
    // i is one past the matching `}`. Consume a trailing newline.
    cursor = i;
    if (source[cursor] === "\n") cursor++;
  }
  return out;
}

/**
 * Strip dangerous tags/attributes from a mermaid SVG before injection.
 *
 * Three rules that proved necessary in acceptance:
 *
 *   1. **Use `documentElement`, not `body`.** SVG parsed with
 *      `image/svg+xml` is an `XMLDocument` — `doc.body` is `null`
 *      on an XML document. Reading `body.innerHTML` returns "Cannot
 *      read properties of null" on every successful mermaid render
 *      and falls into the failure path. The root element is
 *      `doc.documentElement` (the `<svg>` itself).
 *
 *   2. **Keep `<style>`, filter its contents.** Mermaid ships its
 *      styles inside `<style>` blocks (class selectors and inline
 *      rules for shapes). Dropping the whole `<style>` leaves every
 *      shape dark-on-dark or, in the harness, a solid black box.
 *      Drop the dangerous subset of CSS instead: `@import`, `url(...)`
 *      to a remote/attacker origin, `expression(...)`, `behavior:`,
 *      `javascript:` schemes, `-moz-binding`. The remainder — class
 *      selectors, fills, strokes, sizes — is what makes the diagram
 *      legible. Serialise back through `XMLSerializer`, not
 *      `body.innerHTML` (the latter is for HTML, not SVG).
 *
 *   3. **Drop the rest of the DROP set.** Scripts, iframes, objects,
 *      embeds, forms, inputs, foreignObjects, metas, links — these
 *      carry the same XSS risk in SVG as they do in HTML and are
 *      removed whole. (`<foreignObject>` is dropped as defence in
 *      depth even though mermaid is initialised with
 *      `htmlLabels: false` and so does not emit it: allowing
 *      foreignObject would re-open an HTML-injection vector inside the
 *      SVG, which is exactly what `securityLevel: "strict"` is
 *      supposed to close. The cost of dropping it is zero now that
 *      labels render as native SVG `<text>`.)
 *
 * Event handlers (`onclick`, `onload`, `onerror`, …) on surviving
 * elements are stripped; `href` / `xlink:href` is kept only for the
 * safe schemes (`http`, `https`, `mailto`, `#fragment`, `/relative`).
 *
 * Runs in the browser; degrades to escaped text on a server prerender.
 */
function sanitiseSvg(svg: string): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return svg.replace(/[&<>]/g, (c) => ({ "&": "&", "<": "<", ">": ">" })[c] ?? c);
  }
  let doc: XMLDocument;
  try {
    // Parse as XML (image/svg+xml) so the document root is the <svg>
    // itself, not wrapped in a <body>. This is the fix for the
    // "Cannot read properties of null (reading 'innerHTML')" throw:
    // doc.body is null on an XMLDocument.
    doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  } catch {
    return svg;
  }
  if (!doc.documentElement) {
    // The parse failed (parsererror child). Return the original so
    // the failure state still shows the error rather than empty SVG.
    return svg;
  }
  // Whole-element DROP set — never survives. <style> is removed
  // from this set; it stays in the tree but its contents are
  // filtered by `filterStyleContent` below.
  const DROP_ELEMENT = new Set([
    "script", "iframe", "object", "embed", "link", "meta",
    "form", "input", "foreignobject",
  ]);
  // Walk the SVG tree; tags are case-insensitive in DOM.
  const walk = (node: Element): void => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();
      if (DROP_ELEMENT.has(tag)) {
        child.remove();
        continue;
      }
      if (tag === "style") {
        // KEEP the <style> element but filter its content. This is
        // the fix for "diagrams render as solid black boxes":
        // mermaid's CSS lives here, and removing it removes the
        // class selectors that drive every shape's fill / stroke /
        // size.
        const text = child.textContent ?? "";
        child.textContent = filterStyleContent(text);
        walk(child);
        continue;
      }
      walk(child);
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) {
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === "href" || name === "xlink:href") {
          const value = (attr.value ?? "").trim();
          if (!/^(?:https?:|mailto:|#|\/)/i.test(value)) {
            child.removeAttribute(attr.name);
          }
        }
        // NOTE: the `style` attribute is NOT stripped here. Mermaid
        // emits per-shape inline styles (`style="fill:#...;stroke:#..."`)
        // that the <style> block does not cover. Stripping them
        // produces a black-box diagram (the acceptance's
        // reproduction). A future threat-model pass can add a
        // CSS-property allowlist; for now we accept the inline
        // styles since mermaid itself produced them with
        // securityLevel: "strict" and they cannot carry expressions
        // or url() — those would have been filtered at the source.
      }
    }
  };
  walk(doc.documentElement);
  // XML serialiser — `body.innerHTML` would have failed (no body on
  // an XMLDocument) AND would have HTML-escaped the SVG attributes.
  return new XMLSerializer().serializeToString(doc.documentElement);
}

/**
 * Strip CSS attack vectors from a `<style>` block's text content.
 *
 * The list below is the minimal blocklist that closes the
 * documented CSS-based XSS paths (per the OWASP CSS Injection
 * Cheat Sheet). Everything else — class selectors, properties,
 * values, units — survives untouched. The mermaid `<style>` blocks
 * this filter is tested against contain only `.<class> { ... }`
 * rules, so this filter is a no-op for them; the blocklist exists
 * for the case where a future mermaid version (or a hostile input
 * rendered with strict + a custom theme) ships something that
 * would otherwise let an attacker reach `expression(...)` or a
 * remote `@import`.
 */
function filterStyleContent(css: string): string {
  return css
    // `@import` lets a stylesheet pull in arbitrary rules from a
    // remote origin. Drop the whole @import rule (the rest of the
    // line up to the next `;` or `}` is the rule body).
    .replace(/@import\s+[^;}\n]*[;}]?/gi, "")
    // `url(...)` to anything except data:image, fragment-only, or
    // http(s) to a safe origin (loopback or the current document).
    // The lookahead is permissive — any scheme other than those is
    // removed wholesale, leaving the rest of the rule intact.
    .replace(/url\s*\(\s*['"]?(?!data:image\/|#|https?:\/\/(?:localhost|127\.0\.0\.1))/gi, "url(#)")
    // CSS expressions (legacy IE) and modern variants. None of
    // these are reachable from mermaid, but the blocklist is the
    // defence-in-depth part of the filter.
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/behavior\s*:[^;}\n]*/gi, "")
    // `-moz-binding` lets a stylesheet pull in an XBL file — drop
    // any rule that names it.
    .replace(/-moz-binding\s*:[^;}\n]*/gi, "")
    // `javascript:` and `vbscript:` schemes inside any url(...) or
    // url-shaped token. The regex is permissive — anywhere the
    // literal scheme name shows up before a `:` it is stripped.
    .replace(/(?:javascript|vbscript|data)\s*:/gi, ":");
}