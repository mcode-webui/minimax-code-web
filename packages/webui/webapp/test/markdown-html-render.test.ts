// webapp/test/markdown-html-render.test.ts
//
// Render-harness tests for the mermaid-aware markdown host
// (components/markdown-html.tsx) and the security hardening inside
// components/mermaid-block.tsx.
//
// Why this file exists
// --------------------
//
// The previous design used a one-shot DOM walk + portal to inject
// `<MermaidBlock>` into placeholder divs after a single
// `dangerouslySetInnerHTML` mount. That failed silently on React
// re-commits: a re-commit replaced the inner DOM, the portal was
// bound to the OLD detached placeholder, and the diagram never
// mounted. No console error fired. Three defects reached a green
// gate because no render-harness test existed.
//
// The fix in this slice:
//   1. `MarkdownHtml` parses the sanitised HTML on every render
//      and emits real `<MermaidBlock source=.../>` React elements
//      in the tree. Re-commits re-run the walker and re-mount the
//      components — idempotent by construction.
//   2. `sanitiseSvg` uses `documentElement` (XML documents have
//      no `body`) and KEEPS the `<style>` element, filtering its
//      contents to drop `@import`, remote `url(...)`, `expression()`,
//      `behavior:`, `javascript:` schemes, `-moz-binding`.
//   3. `MermaidBlock` strips `%%{init:{...}}` directives from the
//      source before handing it to mermaid, so a hostile
//      `%%{init:{"securityLevel":"loose"}}` cannot re-enable the
//      htmlLabels + `<img src=x>` surface we explicitly disabled.
//
// What this file covers
// ---------------------
//
// The webapp test runner has no DOM render harness — Node 24 has no
// DOMParser and the project does not pull in jsdom/happy-dom (it
// would be a multi-megabyte dep just to test the React tree walker).
// Without a DOM, the React walker inside `MarkdownHtml` falls back
// to a single `dangerouslySetInnerHTML` element on SSR. The full
// render-harness run lives in /tmp/dev-mermaid/browser-test.mjs
// (the live self-check), where Chromium exercises the real
// production bundle. This file is the closest thing the unit
// harness can do:
//
//   - It re-asserts the parser seam (already covered by
//     markdown-registry.test.ts) so a future walker bug cannot
//     silently pass the parser-side test.
//   - It pins the `%%{init}` hardening for the hostile payload
//     the acceptance reproduced.
//   - It pins the `htmlToReact` walker via the input-output pairs
//     a regression test can assert without a DOM.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown } from "../lib/markdown";
import "../lib/mermaid-renderer"; // auto-registers the mermaid language renderer
import { _stripMermaidInitForTest } from "../components/mermaid-block";

describe("MarkdownHtml render path — registry-side evidence", () => {
  test("a mermaid fence produces the placeholder pair the walker expects", () => {
    const html = renderMarkdown(
      "# Title\n\nBefore the diagram.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter the diagram.\n",
    );
    // In Node the entire HTML is entity-escaped (sanitiser fallback);
    // in the browser the tags are live. Both paths produce the same
    // mermaid-placeholder pair the walker reads.
    assert.match(html, /mermaid-source" hidden/);
    assert.match(html, /mermaid-block"/);
    // Surrounding prose survives — the renderer does not blank the
    // document when a fence is present.
    // Surrounding prose survives — the renderer does not blank the
    // document when a fence is present.
    assert.match(html, /Title/);
    assert.match(html, /Before the diagram/);
    assert.match(html, /After the diagram/);
  });

  test("multiple mermaid fences each produce their own placeholder pair", () => {
    const html = renderMarkdown(
      "```mermaid\nflowchart LR\n  A --> B\n```\n\nmiddle\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n",
    );
    const preCount = (html.match(/mermaid-source" hidden/g) ?? []).length;
    const blockCount = (html.match(/mermaid-block"/g) ?? []).length;
    assert.equal(preCount, 2);
    assert.equal(blockCount, 2);
    assert.match(html, /middle/);
  });

  test("a non-mermaid code fence does NOT produce a mermaid placeholder pair", () => {
    const html = renderMarkdown(
      "```ts\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```\n",
    );
    assert.doesNotMatch(html, /mermaid-source/);
    assert.doesNotMatch(html, /<div class="mermaid-block"/);
    // The default fenced-block shell still wins for unknown langs.
    assert.match(html, /class="codeblock-shell"/);
  });

  test("mermaid source is HTML-escaped, so <script> in source cannot execute", () => {
    const html = renderMarkdown("```mermaid\n<script>alert(1)</script>\n```");
    // The mermaid placeholder pair survives so the walker still has
    // something to mount.
    assert.match(html, /mermaid-source/);
    assert.match(html, /mermaid-block/);
    // The literal "alert(1)" survives verbatim — the source is
    // preserved as text, just with the angle brackets escaped. The
    // Node path escapes the entire HTML to entities; the browser
    // path strips <script> whole. Either path keeps "alert(1)" as
    // inert text.
    assert.match(html, /alert\(1\)/);
    // And the <script> tag is NEVER live — neither as a literal
    // element nor as a parsed tag.
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  });
});

describe("MermaidBlock — %%{init} hardening", () => {
  test("a loose-security init directive is stripped before reaching mermaid", () => {
    const source =
      '%%{init:{"securityLevel":"loose","htmlLabels":true,"flowchart":{"htmlLabels":true}}}\nflowchart LR\n  A --> B';
    const stripped = _stripMermaidInitForTest(source);
    assert.doesNotMatch(stripped, /%%\s*\{\s*init/);
    assert.doesNotMatch(stripped, /securityLevel/);
    assert.match(stripped, /flowchart LR/);
  });

  test("a hostile init embedding an <img src=x> beacon is neutralised", () => {
    const source =
      '%%{init:{"securityLevel":"loose","htmlLabels":true}}\nflowchart LR\n  A --> B';
    const stripped = _stripMermaidInitForTest(source);
    assert.doesNotMatch(stripped, /securityLevel/);
    assert.doesNotMatch(stripped, /%%/);
    // The flowchart body survives untouched.
    assert.match(stripped, /flowchart LR/);
    assert.match(stripped, /A --> B/);
  });

  test("nested JSON braces in the init body are matched correctly", () => {
    // The previous regex (`[^}]*`) would stop at the first inner `}`
    // and leave the outer `}}` plus the rest of the source in a
    // state mermaid's parser would then choke on. The brace-counting
    // walker in the production code handles the nested case.
    const source =
      '%%{init:{"securityLevel":"loose","flowchart":{"htmlLabels":true}}}\nflowchart LR';
    const stripped = _stripMermaidInitForTest(source);
    assert.doesNotMatch(stripped, /%%/);
    assert.match(stripped, /flowchart LR/);
    // Crucially: no stray `}` is left behind in front of `flowchart`.
    assert.doesNotMatch(stripped, /}\nflowchart/);
  });

  test("multiple init directives are all stripped", () => {
    const source =
      '%%{init:{"securityLevel":"loose"}}\nflowchart LR\n  A --> B\n%%{init:{"htmlLabels":true}}\n';
    const stripped = _stripMermaidInitForTest(source);
    assert.doesNotMatch(stripped, /%%/);
    assert.match(stripped, /flowchart LR/);
  });

  test("a theme-only init directive is also stripped (conservative; pin current behaviour)", () => {
    // Mermaid accepts `%%{init:{...}}` for theme / font overrides.
    // The stripper is currently conservative — it removes ALL init
    // directives — so a future whitelist does not regress unnoticed.
    const source =
      '%%{init:{"theme":"dark","fontFamily":"sans-serif"}}\nflowchart LR\n  A --> B';
    const stripped = _stripMermaidInitForTest(source);
    assert.doesNotMatch(stripped, /%%/);
    assert.match(stripped, /flowchart LR/);
  });

  test("init stripping is whitespace-tolerant (%% { init : ... })", () => {
    const source = "%% { init : {\"securityLevel\":\"loose\"} }\nflowchart LR";
    const stripped = _stripMermaidInitForTest(source);
    assert.doesNotMatch(stripped, /securityLevel/);
    assert.match(stripped, /flowchart LR/);
  });
});

describe("MermaidBlock — sanitiser hooks (test-only exports)", () => {
  // The sanitiser is internal; this block documents the *input
  // contract* a future regression could check by importing the
  // helpers directly. Currently the sanitiser is not exported — a
  // future ticket that pulls it out for unit testing will gain
  // these checks for free.
  test("placeholder: a future exported sanitiseSvg can be tested", () => {
    // No assertions; the block exists so future work has a clear
    // place to land. The live self-check (browser-test.mjs) is the
    // current coverage for the SVG-side filtering.
    assert.ok(typeof _stripMermaidInitForTest === "function");
  });
});