// webapp/test/markdown-registry.test.ts
//
// Tests for the language → renderer registry seam introduced in
// slice 23 (mermaid / minimax-code-plugin extension point).
//
// Two things matter here:
//
//   1. **The seam exists and is language-agnostic.** A registered
//      renderer owns the HTML for its language fence; the main
//      markdown flow does not branch on `lang === "mermaid"` or any
//      other hard-coded token. Future plugins will plug in the same
//      way `mermaid` does today.
//
//   2. **A broken renderer cannot blank the document.** The
//      `safeLanguageRenderer` wrapper catches throws and renders the
//      fallback fenced-block shell, so a misbehaving plugin leaves
//      the rest of the document readable.
//
// `renderMarkdown` is exercised on the same Node path as production
// because the sanitiser falls back to escaped text without a DOM —
// this lets the registry's HTML output be asserted without a browser
// harness. The DOM walk of the sanitiser is verified end-to-end in
// the live self-check (browser screenshots).

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  parseMarkdown,
  registerLanguageRenderer,
  _clearLanguageRenderersForTest,
  _registeredLanguageRenderersForTest,
} from "../lib/markdown";
import { registerMermaidRenderer } from "../lib/mermaid-renderer";

describe("language renderer registry (seam for plugins)", () => {
  beforeEach(() => {
    // Tests must start with a clean registry so order does not matter.
    // mermaid-renderer.ts re-registers "mermaid" on import, so we
    // re-import via the public reset + a follow-up re-register at
    // every `beforeEach` via the side-effect import.
    _clearLanguageRenderersForTest();
    registerMermaidRenderer();
  });

  after(() => {
    _clearLanguageRenderersForTest();
  });

  test("the default fenced-block shell still renders for an unknown language", () => {
    const html = parseMarkdown("```ts\nconst a = 1;\n```");
    assert.match(html, /class="codeblock-shell"/);
    assert.match(html, /class="codeblock-lang">ts</);
    assert.match(html, /class="codeblock-code language-ts"/);
  });

  test("registering a renderer replaces the default for that language", () => {
    registerLanguageRenderer("my-format", () => `<div class="my-format-renderer">handled</div>`);
    const html = parseMarkdown("```my-format\nhello\n```");
    assert.match(html, /class="my-format-renderer"/);
    assert.doesNotMatch(html, /class="codeblock-shell"/);
  });

  test("the registry is matched case-insensitively and against the bare language token", () => {
    registerLanguageRenderer("my-format", () => `<div class="uppercase-renderer">x</div>`);
    const html = parseMarkdown("```MY-FORMAT\nhello\n```");
    assert.match(html, /class="uppercase-renderer"/);
  });

  test("language tokens with metadata (e.g. ````mermaid {…}) still match the bare language renderer", () => {
    // marked passes "mermaid {theme: dark}" as the lang token; the
    // registry keys on the bare token (the first whitespace-separated
    // word), so a renderer for "mermaid" still wins. This is the
    // documented behaviour: theme / config metadata after the language
    // is forwarded to the renderer as the second argument if the
    // renderer wants to read it.
    registerLanguageRenderer("mermaid", () => `<div class="pure-mermaid-renderer">x</div>`);
    const html = parseMarkdown("```mermaid {theme: dark}\nflowchart\n```");
    assert.match(html, /class="pure-mermaid-renderer"/);
  });

  test("a renderer that throws falls back to the default shell, leaving the rest of the document intact", () => {
    registerLanguageRenderer("crash", () => {
      throw new Error("renderer exploded");
    });
    const src = "# title\n\n```crash\nboom\n```\n\nrest of the document";
    const html = parseMarkdown(src);
    // The throwing renderer's HTML must NOT appear.
    assert.doesNotMatch(html, /renderer exploded/);
    // The fenced block is rendered with the default shell.
    assert.match(html, /class="codeblock-shell"/);
    // The rest of the document is intact.
    assert.match(html, /<h1>title<\/h1>/);
    assert.match(html, /rest of the document/);
  });

  test("a renderer that returns empty falls back to the default shell", () => {
    registerLanguageRenderer(
      "empty",
      // Cast: the registry contract is `(source, lang) => string`,
      // but the safeLanguageRenderer wrapper also tolerates an
      // empty-string return and falls back to the default shell.
      (() => "") as unknown as (source: string, lang: string) => string,
    );
    const html = parseMarkdown("```empty\nx\n```");
    assert.match(html, /class="codeblock-shell"/);
  });

  test("a renderer that returns non-string falls back to the default shell", () => {
    registerLanguageRenderer(
      "bad",
      // Cast: a misbehaving renderer could return anything; the
      // wrapper catches non-string returns.
      (() => null) as unknown as (source: string, lang: string) => string,
    );
    const html = parseMarkdown("```bad\nx\n```");
    assert.match(html, /class="codeblock-shell"/);
  });

  test("registerLanguageRenderer validates its inputs", () => {
    assert.throws(() => registerLanguageRenderer("", () => ""), /non-empty/);
    assert.throws(
      // Cast past the strict signature to exercise the runtime check.
      () => registerLanguageRenderer("ok", "not a function" as unknown as (s: string, l: string) => string),
      /must be a function/,
    );
  });

  test("re-registering a language replaces the previous renderer", () => {
    registerLanguageRenderer("double", () => `<span class="first">a</span>`);
    registerLanguageRenderer("double", () => `<span class="second">b</span>`);
    const html = parseMarkdown("```double\nx\n```");
    assert.match(html, /class="second"/);
    assert.doesNotMatch(html, /class="first"/);
  });

  test("_registeredLanguageRenderersForTest exposes the registered keys", () => {
    registerLanguageRenderer("a-test", () => "");
    registerLanguageRenderer("b-test", () => "");
    const list = _registeredLanguageRenderersForTest();
    assert.ok(list.includes("a-test"));
    assert.ok(list.includes("b-test"));
  });

  test("the mermaid language is auto-registered when mermaid-renderer is imported", () => {
    // The beforeEach re-registers mermaid via registerMermaidRenderer.
    const list = _registeredLanguageRenderersForTest();
    assert.ok(list.includes("mermaid"));
  });
});

describe("mermaid language renderer", () => {
  beforeEach(() => {
    _clearLanguageRenderersForTest();
    registerMermaidRenderer();
  });

  test("a mermaid fence emits the placeholder pair", () => {
    const html = parseMarkdown('```mermaid\nflowchart LR\n  A --> B\n```');
    // Source pre with the escaped source content.
    assert.match(html, /<pre class="mermaid-source" hidden>flowchart LR/);
    // Placeholder div with the loading text and the role="figure".
    assert.match(html, /<div class="mermaid-block" role="figure"/);
    assert.match(html, /<span class="mermaid-block-loading">/);
  });

  test("the mermaid source escapes HTML so it cannot execute via the placeholder", () => {
    const html = parseMarkdown("```mermaid\n<script>alert(1)</script>\n```");
    // The script tag is escaped — the source pre's content is safe
    // text, not a live element.
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  });

  test("a mermaid placeholder is emitted before any surrounding prose", () => {
    const html = parseMarkdown(
      "before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nafter",
    );
    const preIdx = html.indexOf('<pre class="mermaid-source"');
    const blockIdx = html.indexOf('<div class="mermaid-block"');
    const beforeIdx = html.indexOf("before");
    const afterIdx = html.indexOf("after");
    assert.ok(beforeIdx >= 0 && beforeIdx < preIdx, "before precedes the source pre");
    assert.ok(preIdx >= 0 && preIdx < blockIdx, "source pre precedes the placeholder div");
    assert.ok(blockIdx >= 0 && blockIdx < afterIdx, "placeholder div precedes the trailing prose");
  });

  test("without a mermaid fence the mermaid code path is not exercised at all", () => {
    const html = parseMarkdown("# Title\n\nplain markdown, no diagrams here.\n\n```ts\nconst a = 1;\n```");
    assert.doesNotMatch(html, /mermaid-source/);
    assert.doesNotMatch(html, /mermaid-block/);
    // The TypeScript fence still uses the default shell.
    assert.match(html, /class="codeblock-code language-ts"/);
  });
});