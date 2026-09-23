// webapp/test/markdown.test.ts
// Unit tests for lib/markdown.ts — the assistant-message renderer.
//
// Why this test exists: two independent things can go wrong here, and both are
// invisible until a user sees the wrong output.
//
//   1. Container markup. Upstream neutralises the browser default on code blocks
//      (`pre:not(.codeblock-pre){padding:0;background:transparent;border:none}`), so
//      a parser-default `<pre><code>` renders with no background and no padding at
//      all. The renderer has to emit the `codeblock-*` shell those rules expect.
//   2. Sanitisation policy. The rendered HTML goes into the DOM as-is, and its input
//      is model output (which can quote a file it read). The allowlist below is the
//      thing standing between that text and script execution, so it is asserted
//      directly rather than only exercised end to end.
//
// Test strategy: `marked` and the renderer overrides are pure, so the emitted markup
// is asserted in Node. The DOM-walking half of the sanitiser needs a browser, so
// this file pins the *policy* (which tags/attributes/hrefs are admitted) and the
// no-DOM fallback path; the walk itself is verified against a real page in the
// browser validation described in the package docs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ALLOWED_ATTRS, ALLOWED_TAGS, parseMarkdown, renderMarkdown } from "../lib/markdown";

describe("renderMarkdown — prose", () => {
  test("headings, emphasis and links render", () => {
    const html = parseMarkdown("# Title\n\n**bold** and [link](https://example.com)");
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /href="https:\/\/example\.com"/);
  });

  test("gfm tables render", () => {
    const html = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    assert.match(html, /<table>/);
    assert.match(html, /<th>a<\/th>/);
    assert.match(html, /<td>1<\/td>/);
  });

  test("single newlines become breaks (breaks: true, as the previous frontend)", () => {
    const html = parseMarkdown("line one\nline two");
    assert.match(html, /<br\s*\/?>/);
  });
});

describe("renderMarkdown — code", () => {
  test("inline code uses upstream's `inline-code` class", () => {
    const html = parseMarkdown("use `npm ci`");
    assert.match(html, /<code class="inline-code">npm ci<\/code>/);
  });

  test("fenced blocks emit upstream's codeblock shell", () => {
    const html = parseMarkdown("```js\nconst a = 1;\n```");
    // The shell, the toolbar and the pre all carry the classes the upstream
    // stylesheet targets; losing any one of them leaves the block unstyled.
    assert.match(html, /class="codeblock-shell"/);
    assert.match(html, /class="codeblock-toolbar"/);
    assert.match(html, /class="codeblock-lang">js</);
    assert.match(html, /<pre class="codeblock-pre">/);
    assert.match(html, /class="codeblock-code language-js"/);
  });

  test("a fence with no language omits the label but keeps the shell", () => {
    const html = parseMarkdown("```\nplain\n```");
    assert.match(html, /class="codeblock-shell"/);
    assert.doesNotMatch(html, /codeblock-lang/);
  });

  test("code content is escaped, so markup inside a fence cannot execute", () => {
    const html = parseMarkdown("```\n<script>alert(1)</script>\n```");
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });
});

describe("sanitiser policy", () => {
  test("script-bearing and embedding tags are not renderable at all", () => {
    for (const tag of ["script", "style", "iframe", "object", "embed", "svg", "form", "input"]) {
      assert.equal(ALLOWED_TAGS.has(tag), false, `${tag} must not be allowed`);
    }
  });

  test("the tags the renderer emits are allowed", () => {
    for (const tag of ["div", "span", "pre", "code", "p", "strong", "em", "a", "table"]) {
      assert.equal(ALLOWED_TAGS.has(tag), true, `${tag} is emitted and must survive`);
    }
  });

  test("no element may carry event-handler or style attributes", () => {
    // Only `class`, `href`, `title` and table alignment are admitted anywhere;
    // `onclick`, `onerror`, `style` therefore cannot survive.
    const allowedNames = new Set(Object.values(ALLOWED_ATTRS).flatMap((s) => [...s]));
    for (const attr of ["onclick", "onerror", "onload", "style", "srcset", "srcdoc"]) {
      assert.equal(allowedNames.has(attr), false, `${attr} must not be allowed`);
    }
  });

  test("href is only admitted on anchors", () => {
    assert.deepEqual([...(ALLOWED_ATTRS["a"] ?? [])].sort(), ["href", "title"]);
    assert.equal(ALLOWED_ATTRS["img"], undefined);
  });
});

describe("sanitiser fallback without a DOM", () => {
  test("with no DOMParser the output is escaped rather than passed through", () => {
    // This is the static-export prerender path. Node has no DOMParser, so these
    // assertions also cover the Node-side behaviour of renderMarkdown.
    const html = renderMarkdown("<script>alert(1)</script> **bold**");
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});
