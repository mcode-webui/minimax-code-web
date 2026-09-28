// webapp/test/markdown-math.test.ts
//
// KaTeX math rendering (lib/math-renderer.ts) — the three input shapes the
// acceptance criteria name, the degradation contract for invalid formulas,
// and the sanitiser policy the math markup depends on.
//
// Test strategy mirrors markdown.test.ts / markdown-registry.test.ts:
// `marked` + KaTeX + the registry are pure string functions, so the emitted
// markup is asserted in Node. The DOM-walking half of the sanitiser and the
// React style handling are verified against a real page in the live
// self-check (browser screenshots) — this file pins the *policy*, not the
// browser.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_ATTRS,
  ALLOWED_TAGS,
  isSafeStyleValue,
  parseInlineStyle,
  parseMarkdown,
  _clearLanguageRenderersForTest,
} from "../lib/markdown";
import { registerMathRenderer } from "../lib/math-renderer";
import { registerMermaidRenderer } from "../lib/mermaid-renderer";

beforeEach(() => {
  // Both renderers self-register on module import; the registry is a
  // `Map.set`, so re-registering after a clear keeps test order irrelevant.
  _clearLanguageRenderersForTest();
  registerMathRenderer();
  registerMermaidRenderer();
});

after(() => {
  _clearLanguageRenderersForTest();
});

describe("math: the three input shapes render as formulas", () => {
  test("inline `$…$` renders KaTeX markup, not the raw source", () => {
    const html = parseMarkdown("energy $E=mc^2$ is conserved");
    assert.match(html, /class="katex"/);
    assert.doesNotMatch(html, /katex-display/);
    assert.match(html, /^<p>energy <span class="katex">/);
    assert.match(html, /is conserved<\/p>\s*$/);
  });

  test("display `$$…$$` renders block-level KaTeX", () => {
    const html = parseMarkdown("$$\\frac{a}{b}$$");
    assert.match(html, /class="katex-display"/);
    assert.match(html, /class="katex"/);
  });

  test("a ```math fence renders block-level KaTeX, not the codeblock shell", () => {
    const html = parseMarkdown("```math\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n```");
    assert.match(html, /class="katex-display"/);
    assert.doesNotMatch(html, /codeblock-shell/);
  });

  test("table-driven: valid formulas render through KaTeX in all three shapes", () => {
    const formulas = [
      "E=mc^2",
      "\\sqrt{2}",
      "x^2 + y^2 = z^2",
      "\\sum_{i=1}^{n} i",
      "\\int_0^1 x\\,dx",
      "\\alpha\\beta\\gamma",
      "\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}",
    ];
    for (const formula of formulas) {
      const inline = parseMarkdown(`$${formula}$`);
      assert.match(inline, /class="katex"/, `inline failed: ${formula}`);
      const display = parseMarkdown(`$$${formula}$$`);
      assert.match(display, /class="katex-display"/, `display failed: ${formula}`);
      const fence = parseMarkdown("```math\n" + formula + "\n```");
      assert.match(fence, /class="katex-display"/, `fence failed: ${formula}`);
    }
  });

  test("the fence language matches case-insensitively with trailing metadata", () => {
    assert.match(parseMarkdown("```MATH\n\\sqrt{2}\n```"), /class="katex-display"/);
    assert.match(parseMarkdown("```math {display}\n\\sqrt{2}\n```"), /class="katex-display"/);
  });
});

describe("math: invalid formulas degrade to visible source", () => {
  test("table-driven: an invalid inline/display formula degrades to inline code with the raw source", () => {
    const cases = [
      { source: "$\\sqrt$", raw: "$\\sqrt$" },
      { source: "$\\notacommand$", raw: "$\\notacommand$" },
      { source: "$$\\frac$$", raw: "$$\\frac$$" },
      { source: "$\\left(x\\right$", raw: "$\\left(x\\right$" },
    ];
    for (const { source, raw } of cases) {
      const html = parseMarkdown(`before ${source} after`);
      assert.match(html, /<code class="inline-code">/, `not degraded to code: ${source}`);
      assert.ok(html.includes(raw), `raw source not preserved: ${source}`);
      assert.doesNotMatch(html, /class="katex"/, `must not render katex: ${source}`);
      // The rest of the document is intact around the degraded formula.
      assert.match(html, /before /);
      assert.match(html, / after/);
    }
  });

  test("an invalid ```math fence falls back to the plain codeblock shell with the source", () => {
    const html = parseMarkdown("```math\n\\frac{\n```\n\nstill here");
    assert.match(html, /class="codeblock-shell"/);
    assert.match(html, /class="codeblock-code language-math"/);
    assert.ok(html.includes("\\frac{"), "source must stay visible");
    assert.doesNotMatch(html, /class="katex/);
    assert.match(html, /still here/);
  });

  test("a trust-gated command (\\href) cannot smuggle a javascript: URL", () => {
    // KaTeX renders `\href` without `trust: true` as a red warning text node
    // (no anchor is ever emitted), so no `href` attribute — javascript: or
    // otherwise — can reach the DOM through the math path.
    const html = parseMarkdown("$\\href{javascript:alert(1)}{x}$");
    assert.doesNotMatch(html, /href\s*=/i);
    assert.doesNotMatch(html, /<a[\s>]/);
    assert.doesNotMatch(html, /javascript:/);
  });

  test("markup inside a formula is escaped, never executed", () => {
    const html = parseMarkdown("$\\text{<script>alert(1)</script>}$");
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe("math: prose with dollar signs stays prose", () => {
  test("table-driven: dollar-bearing prose is not tokenised as math", () => {
    const cases = [
      "costs $5 and $10 total", // single-$ bodies starting with a digit
      "export $HOME/bin", // shell-style variable, no closing pair
      "a $ b", // lone dollar
      "unclosed $\\frac{ never", // unclosed delimiter
      "price is 100$", // trailing dollar, nothing after
    ];
    for (const source of cases) {
      const html = parseMarkdown(source);
      assert.doesNotMatch(html, /class="katex"/, `false positive: ${source}`);
      // The text itself is never lost.
      for (const word of source.replace(/\$+/g, " ").split(/\s+/).filter(Boolean)) {
        assert.ok(html.includes(word), `lost "${word}" from: ${source}`);
      }
    }
  });

  test("two independent inline formulas in one paragraph both render", () => {
    const html = parseMarkdown("$a^2$ and $b_2$");
    assert.equal((html.match(/class="katex"/g) ?? []).length >= 2, true);
  });
});

describe("math: mermaid and math coexist in one document", () => {
  test("math before a mermaid fence — both render", () => {
    const html = parseMarkdown(
      "$x^2$ inline\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```math\n\\sqrt{2}\n```",
    );
    assert.match(html, /class="katex"/);
    assert.match(html, /<pre class="mermaid-source" hidden>/);
    assert.match(html, /<div class="mermaid-block"/);
    // Two math shapes present: the inline formula and the ```math fence.
    assert.match(html, /class="katex-display"/);
  });

  test("mermaid fence before math — both render (order does not matter)", () => {
    const html = parseMarkdown(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\nthen $$\\pi r^2$$",
    );
    assert.match(html, /<pre class="mermaid-source" hidden>/);
    assert.match(html, /class="katex-display"/);
  });

  test("the math renderer is registered on module import, next to mermaid", () => {
    // registerMathRenderer is exported for test resets (same contract as
    // registerMermaidRenderer); the module import already installed it.
    registerMathRenderer();
    assert.match(parseMarkdown("```math\n\\sqrt{2}\n```"), /class="katex-display"/);
  });
});

describe("sanitiser policy for the KaTeX surface", () => {
  test("the tags KaTeX emits are all allowlisted", () => {
    for (const tag of ["span", "svg", "path"]) {
      assert.equal(ALLOWED_TAGS.has(tag), true, `${tag} is KaTeX output and must survive`);
    }
  });

  test("table-driven: isSafeStyleValue admits KaTeX geometry, rejects CSS injection", () => {
    const allowed = [
      "height:0.6833em;",
      "margin-right:0.0576em;",
      "height:1.7936em;vertical-align:-0.686em;",
      "color:#ff0000",
      "top:-0.5em; height:1.2em; margin-right:0.1em",
      "", // empty string — nothing to reject
    ];
    for (const value of allowed) {
      assert.equal(isSafeStyleValue(value), true, `must allow: ${value}`);
    }
    const rejected = [
      "background:url(javascript:alert(1))", // url() — parentheses rejected
      "background:url(http://beacon.example/x)",
      "left:expression(alert(1))",
      "position:fixed", // overlay hijack
      "behavior:url(#default#time2)", // legacy IE vector
      "-moz-binding:url(http://x)", // legacy XBL vector
      "top:0;content:'</style>'", // quotes rejected
      "color:red;background-image:url(x)", // second declaration rejected
      "@import url(x)", // @ rejected
      "font-family:\"Times New Roman\"", // quotes rejected
    ];
    for (const value of rejected) {
      assert.equal(isSafeStyleValue(value), false, `must reject: ${value}`);
    }
  });

  test("table-driven: parseInlineStyle camelCases declarations and skips malformed ones", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["height:0.6833em;", { height: "0.6833em" }],
      ["margin-right:0.0576em;", { marginRight: "0.0576em" }],
      ["height:1.7936em;vertical-align:-0.686em;", { height: "1.7936em", verticalAlign: "-0.686em" }],
      ["top:-0.5em; ", { top: "-0.5em" }],
      ["", {}],
      ["garbage-without-colon", {}],
      [":novalue;", {}],
      ["width:;empty-value", {}],
    ];
    for (const [value, expected] of cases) {
      assert.deepEqual(parseInlineStyle(value), expected, `parsing: ${value}`);
    }
  });
});
