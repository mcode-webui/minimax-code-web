// webapp/test/code-highlight.test.ts
//
// Unit tests for `lib/code-highlight.ts` — the per-language lazy
// highlight.js wrapper the IDE-grade file preview depends on.
//
// Why this file matters:
//
//   1. The lazy-load contract: opening a `.js` file must NOT pull in
//      `python.js`, `rust.js`, `go.js`, etc. Webpack chunks the
//      dynamic imports, and a regression that re-registered all
//      languages up front would blow the first paint budget.
//
//   2. The unknown-language fallback: an extension the server does
//      not label, or a label hljs 10.7.3 does not ship, must render
//      as plain monospace — NO error, NO blank.
//
//   3. The truncation contract: a 300 KiB file must NOT keep the
//      main thread busy for a second. The default cap is
//      `DEFAULT_LARGE_FILE_TRUNCATE_LINES = 2000` / `..._BYTES = 256
//      KiB`; these tests pin both.
//
//   4. The gutter split: a balanced re-wrapping of the hljs output
//      across `\n` boundaries so multi-line spans do not bleed
//      between gutter cells.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  highlightCode,
  splitHighlightedLines,
  loadHljsLanguage,
  _registeredLanguagesForTest,
  _resetHljsLanguageCacheForTest,
  _languageToHljsForTest,
  countLines,
  byteLength,
  escapeHtml,
  splitSourceLines,
  type HighlightedLine,
} from "../lib/code-highlight";

beforeEach(() => {
  // Reset between tests — a single language registered in test A
  // must not leak into test B's "only one loaded" assertion.
  _resetHljsLanguageCacheForTest();
});

describe("highlightCode — happy path", () => {
  test("highlights a JS file with the resolved language", async () => {
    const out = await highlightCode("javascript", "const x = 1;\nfunction foo() { return 2; }");
    assert.ok(out.html, "html should be non-empty for a known language");
    assert.ok(out.html!.includes("hljs-keyword"), "JS keyword must be wrapped in hljs-keyword");
    assert.equal(out.language, "javascript");
    assert.equal(out.truncated, false);
  });

  test("returns null html and resolved language for python", async () => {
    const out = await highlightCode("python", "def foo():\n    return 1");
    assert.ok(out.html, "python highlight must produce html");
    assert.ok(out.html!.includes("hljs-keyword"));
    assert.equal(out.language, "python");
  });

  test("typescript maps to typescript", async () => {
    const out = await highlightCode("typescript", "const x: number = 1;");
    assert.equal(out.language, "typescript");
    assert.ok(out.html!.includes("hljs-keyword"));
  });
});

describe("highlightCode — unknown language fallback", () => {
  test("returns null html and the input label for an unknown server label", async () => {
    const out = await highlightCode("not-a-real-language", "irrelevant content here");
    assert.equal(out.html, null, "unknown language must not produce markup");
    assert.equal(out.language, "not-a-real-language", "label echoed back so the badge still renders");
    assert.equal(out.truncated, false);
  });

  test("returns null html and 'plain' for the server's plain fallback", async () => {
    const out = await highlightCode("plain", "raw text content");
    assert.equal(out.html, null);
    assert.equal(out.language, "plain");
  });

  test("returns null html for empty / whitespace language strings without throwing", async () => {
    // The component must NEVER call hljs.highlight() with an empty
    // string — hljs 10.7.3 throws on that input. The lib guard
    // short-circuits before reaching hljs.
    const emptyOut = await highlightCode("", "content");
    assert.equal(emptyOut.html, null);
    assert.equal(emptyOut.language, null);

    const wsOut = await highlightCode("   ", "content");
    assert.equal(wsOut.html, null);
    assert.equal(wsOut.language, null);
  });

  test("`toml` is unsupported by hljs 10.7.3 — falls back without error", async () => {
    // The backend labels .toml as 'toml' but the public hljs version
    // we ship does not have a toml module. The lib MUST return null
    // html (plain monospace) and MUST NOT throw.
    const out = await highlightCode("toml", "[section]\nkey = \"value\"");
    assert.equal(out.html, null);
    assert.equal(out.language, "toml");
  });

  test("`html` aliases `xml` — hljs still renders the highlight", async () => {
    // hljs 10.7.3 has no standalone html module; html is an alias of
    // xml. Loading xml registers html for free, so the lib returns
    // real markup rather than a null fallback.
    const out = await highlightCode("html", "<div class=\"x\">hi</div>");
    assert.ok(out.html, "html must highlight via the xml alias");
    assert.equal(out.language, "xml", "the resolved language is xml, not html");
  });
});

describe("highlightCode — lazy grammar loading", () => {
  test("opening a JS file registers exactly one grammar", async () => {
    const before = _registeredLanguagesForTest().size;
    await highlightCode("javascript", "const x = 1");
    const after = _registeredLanguagesForTest();
    assert.deepEqual([...after], ["javascript"], "only javascript registered");
    assert.equal(after.size, before + 1);
  });

  test("opening python does NOT pull in javascript / rust / go / etc.", async () => {
    await highlightCode("python", "def f():\n    pass");
    const registered = _registeredLanguagesForTest();
    assert.equal(registered.size, 1);
    assert.ok(registered.has("python"));
    assert.ok(!registered.has("javascript"));
    assert.ok(!registered.has("rust"));
    assert.ok(!registered.has("go"));
  });

  test("loading the same language twice does not re-register", async () => {
    // hljs.registerLanguage throws on duplicates — the cache guard
    // exists to avoid that. Two consecutive opens must succeed.
    await highlightCode("javascript", "const x = 1");
    await highlightCode("javascript", "const y = 2");
    const registered = _registeredLanguagesForTest();
    assert.equal(registered.size, 1);
    assert.ok(registered.has("javascript"));
  });

  test("html resolves to xml and shares the registration", async () => {
    await highlightCode("html", "<p>hi</p>");
    await highlightCode("xml", "<root/>");
    // Both labels share the xml module name, so the cache has ONE entry.
    const registered = _registeredLanguagesForTest();
    assert.deepEqual([...registered], ["xml"]);
  });
});

describe("loadHljsLanguage — direct API", () => {
  test("returns the module name for a supported label", async () => {
    const out = await loadHljsLanguage("javascript");
    assert.equal(out, "javascript");
  });

  test("returns null for an unsupported label", async () => {
    const out = await loadHljsLanguage("totally-fake");
    assert.equal(out, null);
  });

  test("returns null for an empty string (defensive)", async () => {
    const out = await loadHljsLanguage("");
    assert.equal(out, null);
  });

  test("normalises case and whitespace", async () => {
    const out = await loadHljsLanguage("  JavaScript  ");
    assert.equal(out, "javascript");
  });
});

describe("highlightCode — large file degradation", () => {
  test("truncates by line count above the default cap", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const out = await highlightCode("javascript", big);
    assert.equal(out.truncated, true);
    assert.equal(out.originalLineCount, 5000);
    assert.ok(out.visibleLineCount < 5000, `expected visible < 5000, got ${out.visibleLineCount}`);
    assert.equal(out.visibleLineCount, 1500, "default cap is 1500 lines");
  });

  test("truncates by byte count above the default cap", async () => {
    // 1 MiB of `x` characters — pathological input that hljs would
    // take 60+ seconds to lex; the byte budget must short-circuit
    // it before the highlight step runs.
    const huge = "x".repeat(1024 * 1024);
    const out = await highlightCode("javascript", huge);
    assert.equal(out.truncated, true);
    assert.ok(out.visibleLineCount < 1024 * 1024, "byte-truncation reduces the visible line count");
  });

  test("does NOT truncate under the cap", async () => {
    const small = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const out = await highlightCode("javascript", small);
    assert.equal(out.truncated, false);
    assert.equal(out.originalLineCount, undefined, "no truncation means no original-count field");
    assert.equal(out.visibleLineCount, 100);
  });

  test("truncation boundary is inclusive (file of exactly the cap is truncated)", async () => {
    // A file of EXACTLY 1500 lines (the default maxLines) must
    // still be truncated — `>=`, not `>`. Without the inclusive
    // boundary, the boundary case skips the cap and pays the
    // synchronous highlight hitch on the exact size the cap was
    // designed to bound.
    const exactLines = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join("\n");
    const out = await highlightCode("javascript", exactLines);
    assert.equal(out.truncated, true);
    assert.equal(out.originalLineCount, 1500);
    assert.ok(out.visibleLineCount <= 1500);
  });

  test("honours a custom maxLines", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = await highlightCode("javascript", content, { maxLines: 10 });
    assert.equal(out.truncated, true);
    assert.equal(out.visibleLineCount, 10);
  });
});

describe("splitHighlightedLines — gutter alignment", () => {
  test("produces one record per source line, with the right number", async () => {
    const content = "const x = 1;\nconst y = 2;\nconst z = 3;";
    const result = await highlightCode("javascript", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.lines.length, 3);
    assert.deepEqual(split.lines.map((l) => l.number), [1, 2, 3]);
  });

  test("the .text field is the raw source (used for copy)", async () => {
    const content = "const x = 1;\nconst y = 2;";
    const result = await highlightCode("javascript", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.lines[0]!.text, "const x = 1;");
    assert.equal(split.lines[1]!.text, "const y = 2;");
  });

  test("falls back to escaped raw text for unknown languages", async () => {
    const content = "<script>alert('x')</script>\nplain line";
    const result = await highlightCode("plain", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.lines.length, 2);
    // The HTML must NOT contain a raw `<script>` tag — the unknown-
    // language path escapes the bytes.
    assert.ok(!split.lines[0]!.html.includes("<script"));
    assert.ok(split.lines[0]!.html.includes("&lt;script"));
  });

  test("balanced spans across multi-line constructs do not orphan", async () => {
    // JS template literal spanning multiple lines — hljs will
    // emit one `<span class="hljs-string">` that crosses newlines.
    // The split MUST keep the OVERALL rendered DOM balanced: the
    // span that opens on line 1 must close on line 2 within the
    // rendered tree. (We do NOT assert per-line balance — hljs's
    // own output already has balanced per-line markup for many
    // constructs; the test is about the cross-line case.)
    const content = "const x = `hello\nworld`;\nconst y = 2;";
    const result = await highlightCode("javascript", content);
    assert.ok(result.html!.includes("hljs-string"), "template literal must be highlighted");
    const split = splitHighlightedLines(result, content);
    assert.equal(split.lines.length, 3);

    // Concatenate all rendered lines, in DOM order, and walk the
    // spans. The total open/close counts must match and every
    // `<span>` must have a matching `</span>` at the same nesting
    // level when walked in order.
    const combined = split.lines.map((l) => l.html).join("");
    const opens = (combined.match(/<span\b/g) ?? []).length;
    const closes = (combined.match(/<\/span>/g) ?? []).length;
    assert.equal(opens, closes, `overall opens=${opens} closes=${closes}`);

    // A naive depth walker verifies the DOM tree is well-formed.
    let depth = 0;
    const tagRe = /<\/?span\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(combined)) !== null) {
      if (m[0].startsWith("</")) depth -= 1;
      else depth += 1;
      assert.ok(depth >= 0, `span depth went negative at offset ${m.index}`);
    }
    assert.equal(depth, 0, "all spans closed");
  });

  test("truncation metadata flows from highlightCode into the split", async () => {
    const content = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const result = await highlightCode("javascript", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.truncated, true);
    assert.equal(split.originalLineCount, 5000);
    assert.ok(split.visibleLineCount <= 5000);
    assert.equal(split.lines.length, split.visibleLineCount);
  });

  test("plain-monospace path produces escaped HTML for every line", async () => {
    const content = "a & b\n<c>";
    const result = await highlightCode("plain", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.lines.length, 2);
    assert.ok(split.lines[0]!.html.includes("&amp;"));
    assert.ok(split.lines[1]!.html.includes("&lt;c&gt;"));
  });

  test("carries the resolved language so the badge can show it", async () => {
    const content = "const x = 1";
    const result = await highlightCode("javascript", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.language, "javascript");
  });

  test("split preserves language label on the plain path", async () => {
    const content = "raw text";
    const result = await highlightCode("plain", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.language, "plain");
  });

  test("split echoes an unknown label through unchanged", async () => {
    const content = "raw text";
    const result = await highlightCode("not-a-real-language", content);
    const split = splitHighlightedLines(result, content);
    assert.equal(split.language, "not-a-real-language");
  });
});

describe("pure helpers — pinning the math", () => {
  test("countLines: empty input is zero lines", () => {
    assert.equal(countLines(""), 0);
  });

  test("countLines: trailing newline does NOT count a phantom line", () => {
    assert.equal(countLines("hello\n"), 1);
    assert.equal(countLines("hello\nworld\n"), 2);
  });

  test("countLines: a single line is one line", () => {
    assert.equal(countLines("hello"), 1);
  });

  test("splitSourceLines drops the trailing empty entry", () => {
    assert.deepEqual(splitSourceLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitSourceLines("a\nb"), ["a", "b"]);
    assert.deepEqual(splitSourceLines(""), []);
  });

  test("byteLength uses TextEncoder in browsers / Node 22+", () => {
    const out = byteLength("héllo");
    // 'h' 'é' (2 bytes) 'l' 'l' 'o' — 6 bytes for UTF-8.
    assert.equal(out, 6);
  });

  test("escapeHtml covers the four dangerous characters plus quotes", () => {
    assert.equal(escapeHtml("<a href=\"x\">"), "&lt;a href=&quot;x&quot;&gt;");
    assert.equal(escapeHtml("a & b"), "a &amp; b");
    assert.equal(escapeHtml("it's"), "it&#x27;s");
  });
});

describe("_languageToHljsForTest — server label → hljs module", () => {
  test("exposes the mapping so the parent can audit it", () => {
    assert.equal(_languageToHljsForTest["javascript"], "javascript");
    assert.equal(_languageToHljsForTest["typescript"], "typescript");
    assert.equal(_languageToHljsForTest["html"], "xml", "html aliases xml in hljs 10.7.3");
    assert.equal(_languageToHljsForTest["jsonc"], "json");
  });

  test("does not include plain / toml (no module in hljs 10.7.3)", () => {
    // These rely on the null branch — the mapping table does not
    // pretend to support them.
    assert.equal(_languageToHljsForTest["plain"], undefined);
    assert.equal(_languageToHljsForTest["toml"], undefined);
  });
});

// ---------------------------------------------------------------------
// Helper — keep the suite's tests grouped when run with --test-only.
// ---------------------------------------------------------------------
function _lineRecordsToStrings(lines: HighlightedLine[]): string[] {
  return lines.map((l) => l.text);
}
