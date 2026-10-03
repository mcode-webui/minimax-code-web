// webapp/test/markdown-raw-html.test.ts
//
// Regression suite for P17: raw HTML in the markdown source is text, never DOM.
//
// The defect
// ----------
//
// UAT round 2026-10-03 16:00 (board P17) recorded nine `[error]`-level
// `Warning: The tag <path> is unrecognized in this browser` entries whenever a
// model's reasoning or answer echoed an inline SVG snippet. Three layers
// combined into it:
//
//   1. `marked` has no "no raw HTML" option, and `lib/markdown.ts` configured
//      it with `{ gfm, breaks }` only — author HTML was forwarded verbatim.
//   2. `ALLOWED_TAGS` in `lib/markdown.ts` admits `svg` and `path` because
//      KaTeX emits real SVG geometry, so the sanitiser passed the snippet
//      through (`<g>`, not allowlisted, was unwrapped).
//   3. `htmlToReact` (`components/markdown-html.tsx`) turns the sanitised
//      HTML into React elements with `createElement(tag, …)`, so `<path>`
//      became a real unknown host element — one console error per occurrence.
//
// The fix is one hook (`renderer.html` escaping the token text). This file
// pins it from both ends:
//
//   - author-written SVG / HTML becomes escaped text and produces **no**
//     element in the React tree, which is what "zero console errors" means
//     here — React has nothing to warn about;
//   - renderer-generated SVG (KaTeX) still produces real `svg`/`path`
//     elements, so the fix did not over-reach.
//
// Test strategy: `marked` and the React tree builder are pure, so both are
// asserted in Node. `htmlToReact` needs a `DOMParser`, which Node lacks, so it
// runs under the existing parse5-backed shim (`test/helpers/dom-shim.ts`) —
// the same harness `markdown-html-render.test.ts` uses for the walker. No new
// dependency: the shim's whole point is that the project does not pull in
// jsdom/happy-dom.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, renderMarkdown } from "../lib/markdown";
import { htmlToReact } from "../components/markdown-html";
import "../lib/math-renderer"; // auto-registers the math renderers
import { withDomParserShim } from "./helpers/dom-shim";

/**
 * The UAT input, verbatim in shape: an SVG snippet the model pasted into its
 * reasoning, block-level, with a `<g>` wrapper and a self-closing `<path>`.
 */
const REASONING_WITH_SVG = [
  "先看这棵树的形状：",
  "",
  '<svg width="120" height="120" viewBox="0 0 120 120">',
  '  <g opacity="0.6">',
  '    <path d="M100 100 L20 20" stroke="black" fill="none"/>',
  "  </g>",
  "</svg>",
  "",
  "主干就这样。",
].join("\n");

/** Inline variant — the same tags typed mid-sentence. */
const INLINE_SVG = '画一个 <svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg> 就行';

/**
 * Collect every host-element tag the React tree builder emitted.
 *
 * `htmlToReact` returns React elements (`{ type, props }`) and text nodes
 * (strings); components are function/class types and are skipped, so what
 * lands in the set is exactly the tag names React would ask the DOM to mount.
 * That set is the direct precondition of the `unrecognized tag` warning: a tag
 * React does not know must never appear in it.
 */
function hostTagNames(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) hostTagNames(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof element.type === "string") out.add(element.type);
  if (element.props && "children" in element.props) {
    hostTagNames(element.props.children, out);
  }
  return out;
}

/** Host tag names the walker produces for a markdown string, under the shim. */
function tagsFor(source: string): Set<string> {
  return withDomParserShim(() => hostTagNames(htmlToReact(parseMarkdown(source), "light")));
}

describe("P17 — author-written SVG becomes text, never DOM tags", () => {
  test("a block-level SVG snippet emits no live svg/g/path tag", () => {
    const html = parseMarkdown(REASONING_WITH_SVG);
    for (const tag of ["svg", "g", "path"]) {
      assert.doesNotMatch(html, new RegExp(`<${tag}[\\s/>]`, "i"), `<${tag}> must not be live markup`);
    }
    // The snippet is still readable — as the source the model wrote.
    assert.match(html, /&lt;svg width=&quot;120&quot;/);
    assert.match(html, /&lt;path d=&quot;M100 100 L20 20&quot;/);
    // Surrounding prose is untouched: one bad snippet does not blank the message.
    assert.match(html, /先看这棵树的形状：/);
    assert.match(html, /主干就这样。/);
  });

  test("an inline SVG snippet typed mid-sentence is escaped too", () => {
    const html = parseMarkdown(INLINE_SVG);
    assert.doesNotMatch(html, /<svg[\s/>]/i);
    assert.doesNotMatch(html, /<path[\s/>]/i);
    assert.match(html, /&lt;svg viewBox=&quot;0 0 10 10&quot;&gt;/);
    assert.match(html, /^<p>画一个 /);
  });

  test("the React tree contains no svg/g/path element for author HTML", () => {
    // This is the console-zero-error assertion: React warns per unknown host
    // element it is asked to mount, so the absence of the tags is the absence
    // of the `The tag <path> is unrecognized in this browser` flood.
    const tags = tagsFor(REASONING_WITH_SVG);
    for (const tag of ["svg", "g", "path"]) {
      assert.equal(tags.has(tag), false, `the React tree must not mount <${tag}>`);
    }
    // The paragraph itself still renders — the text was not dropped with the tag.
    assert.equal(tags.has("p"), true);
  });

  test("the escaped block keeps its original line structure", () => {
    // marked hands a block token its raw source *including* the trailing
    // newline. Escaping must not swallow that, or a pasted multi-line snippet
    // would collapse into one unreadable line.
    const html = parseMarkdown(REASONING_WITH_SVG);
    assert.match(html, /&lt;svg[^\n]*?&gt;\n/, "the newline after the <svg> opener must survive");
    assert.match(html, /&lt;path[^\n]*?&gt;\n/, "the newline after the <path> line must survive");
  });

  test("renderMarkdown shows the snippet as escaped text (no-DOM fallback path)", () => {
    // Node has no `DOMParser`, so `sanitize` takes its inert fallback and
    // escapes the whole string — which is why this case is *not* the one that
    // goes red under the mutation; the parse-level tests above are. What it
    // pins is the contract a caller relies on: the public entry point returns
    // the snippet as readable source, never blank and never as markup.
    const html = renderMarkdown(REASONING_WITH_SVG);
    assert.doesNotMatch(html, /<svg[\s/>]/i);
    assert.doesNotMatch(html, /<path[\s/>]/i);
    assert.match(html, /&lt;svg width=&quot;120&quot;/);
    assert.match(html, /主干就这样。/);
  });

  test("an HTML block with an event handler is text, not a live element", () => {
    // The general case behind the SVG symptom: any author HTML, including the
    // attribute surface the sanitiser would otherwise have to police.
    const html = parseMarkdown('<div onclick="steal()">hi</div>');
    assert.doesNotMatch(html, /<div/);
    assert.match(html, /&lt;div onclick=/);
    const tags = withDomParserShim(() => hostTagNames(htmlToReact(html, "light")));
    assert.equal(tags.has("div"), false);
  });

  test("raw HTML inside a fenced code block is unaffected by the new hook", () => {
    // The fence has its own escaping path (renderer.code); the new hook must
    // not change how it looks.
    const html = parseMarkdown("```html\n<svg><path d=\"M0 0\"/></svg>\n```");
    assert.match(html, /class="codeblock-shell"/);
    assert.match(html, /&lt;svg&gt;&lt;path d=&quot;M0 0&quot;\/&gt;&lt;\/svg&gt;/);
    const tags = withDomParserShim(() => hostTagNames(htmlToReact(html, "light")));
    assert.equal(tags.has("svg"), false);
    assert.equal(tags.has("code"), true);
  });
});

describe("P17 — generated SVG still renders (the fix must not over-reach)", () => {
  test("KaTeX geometry still emits real svg and path elements", () => {
    // KaTeX output comes from the `webuiMath` inline extension's own renderer,
    // which never passes through `renderer.html`. If this assertion ever goes
    // red, the escape hook has swallowed renderer-generated markup and every
    // radical, fraction and stretchy delimiter has lost its shape.
    const html = parseMarkdown("面积是 $\\sqrt{x}$ 这样");
    assert.match(html, /class="katex"/);
    assert.match(html, /<svg/);
    assert.match(html, /<path/);
  });

  test("the React tree for a formula contains svg and path elements", () => {
    const tags = tagsFor("$\\sqrt{x}$");
    assert.equal(tags.has("svg"), true);
    assert.equal(tags.has("path"), true);
  });
});
