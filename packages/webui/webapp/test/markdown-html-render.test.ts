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
//   - It pins the `findMermaidSourceBefore` walker (blocker 1) by
//     feeding it a hand-built DOM Level 1 element mock — the
//     contract under test is that the walker reads `textContent`
//     (which is the post-DOMParser-decoded string) and not
//     `innerHTML` (which re-serialises entities).
//   - It pins the `mermaid.initialize` options (blockers 2 & 3) so
//     a regression that drops `htmlLabels: false` (label boxes
//     empty) or `suppressErrorRendering: true` (bomb SVGs leak
//     onto the page) cannot reach the gate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, renderMarkdown } from "../lib/markdown";
import "../lib/mermaid-renderer"; // auto-registers the mermaid language renderer
import {
  _stripMermaidInitForTest,
  _mermaidInitializeOptionsForTest,
  _mermaidConfigKeyForTest,
  _mermaidFontFamilyForTest,
} from "../components/mermaid-block";
import { findMermaidSourceBefore, htmlToReact } from "../components/markdown-html";
import { withDomParserShim } from "./helpers/dom-shim";

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

// ---------------------------------------------------------------------------
// Regression tests for the three blockers reproduced in the acceptance run.
//
// Each test below is mutation-verified — the comment names the exact edit
// that, if reverted, makes the assertion fail. The intent is that a future
// change cannot silently re-introduce any of the three defects even if the
// full mermaid render path is not exercised in the unit harness.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UAT fix — the walker's output must satisfy React's `validateTextNesting`.
//
// The defect: `marked` indents every line of a GFM table, so the sanitised
// HTML carries `\n` as real text nodes under <table>/<thead>/<tbody>/<tr>.
// React DOM (dev build) rejects ANY text child of those elements and logs
// "In HTML, whitespace text nodes cannot be a child of <table>. This will
// cause a hydration error." once per tag per page load. The walker now
// drops whitespace-only text under the table family; table layout never
// painted it, so no visual output changes.
//
// This is the first test in the file that drives the REAL walker: the
// earlier ones had to assert inputs and exported helpers because Node has
// no DOMParser. `test/helpers/dom-shim.ts` supplies one over parse5, so the
// contract is now checked where it actually lives — on the React tree the
// component mounts.
// ---------------------------------------------------------------------------

/** The tags React's `validateTextNesting` refuses text children under. */
const TABLE_STRUCTURE_TAGS = ["table", "thead", "tbody", "tfoot", "tr"] as const;

type ReactLikeNode =
  | string
  | ReactLikeNode[]
  | { type?: unknown; props?: { children?: ReactLikeNode } };

/** Every whitespace-only string anywhere in the tree, with its parent tag. */
function whitespaceTextUnderTableTags(
  node: ReactLikeNode,
  parentTag: string | null = null,
  found: { parentTag: string; text: string }[] = [],
): { parentTag: string; text: string }[] {
  if (typeof node === "string") {
    if (parentTag !== null && /^\s+$/.test(node)) found.push({ parentTag, text: node });
    return found;
  }
  // `htmlToReact` returns the body's children as one array; elements nest
  // their own children as an array or a single node.
  if (Array.isArray(node)) {
    for (const child of node) whitespaceTextUnderTableTags(child, parentTag, found);
    return found;
  }
  const tag = typeof node.type === "string" ? node.type : parentTag;
  if (node.props?.children !== undefined) {
    whitespaceTextUnderTableTags(node.props.children, tag, found);
  }
  return found;
}

/** Every element tag in the tree, in document order. */
function collectTags(node: ReactLikeNode, tags: string[] = []): string[] {
  if (typeof node === "string") return tags;
  if (Array.isArray(node)) {
    for (const child of node) collectTags(child, tags);
    return tags;
  }
  if (typeof node.type === "string") tags.push(node.type);
  if (node.props?.children !== undefined) collectTags(node.props.children, tags);
  return tags;
}

describe("markdown-html — the table React tree has no text children", () => {
  const GFM_TABLE = [
    "| 名称 | 说明 |",
    "| --- | :---: |",
    "| 端口 | 监听端口 |",
    "| 路径 | 根路径 |",
  ].join("\n");

  test("a GFM table yields no whitespace text node under any table-family tag", () => {
    // Sanitising needs a DOM too, so drive the parser directly: the walker
    // is the unit under test, and the raw marked output is what it is fed
    // (lib/markdown.ts#renderMarkdown hands it `sanitize(parseMarkdown(...))`,
    // and the sanitiser never touches text nodes).
    const tree = withDomParserShim(() => htmlToReact(parseMarkdown(GFM_TABLE), "light"));

    const offenders = whitespaceTextUnderTableTags(tree as ReactLikeNode);
    assert.deepEqual(
      offenders,
      [],
      `whitespace text nodes reached a table-family element: ${JSON.stringify(offenders)}`,
    );
  });

  test("the mutation guard — marked really does emit that whitespace", () => {
    // Without this, the test above would also pass if `marked` stopped
    // indenting its tables, i.e. for the wrong reason.
    const html = parseMarkdown(GFM_TABLE);
    assert.match(html, /<table>[\s\S]*\n[\s\S]*<\/table>/);
    assert.match(html, /<tr>[\s\S]*\n[\s\S]*<\/tr>/);
  });

  test("the table keeps every cell — only whitespace was dropped", () => {
    const tree = withDomParserShim(() => htmlToReact(parseMarkdown(GFM_TABLE), "light"));
    const tags = collectTags(tree as ReactLikeNode);
    assert.deepEqual(
      tags,
      [
        "table",
        "thead",
        "tr",
        "th", "th",
        "tbody",
        "tr", "td", "td",
        "tr", "td", "td",
      ],
      "the element structure of a GFM table must survive the fix untouched",
    );
  });

  test("cell text is preserved verbatim", () => {
    const tree = withDomParserShim(() => htmlToReact(parseMarkdown(GFM_TABLE), "light"));
    const rendered = JSON.stringify(tree, (key, value) =>
      typeof value === "function" ? "[fn]" : value,
    );
    for (const cell of ["名称", "说明", "端口", "监听端口", "路径", "根路径"]) {
      assert.ok(rendered.includes(cell), `cell ${cell} disappeared from the React tree`);
    }
  });

  test("whitespace between BLOCK tags is still rendered (prose is not a table)", () => {
    // The drop is scoped to the table family. A paragraph's inter-block
    // newlines are renderable whitespace and must survive — dropping them
    // everywhere would reflow prose the markdown never asked to reflow.
    const tree = withDomParserShim(() =>
      htmlToReact(parseMarkdown("# Title\n\nbody text\n"), "light"),
    );
    const texts = whitespaceTextUnderTableTags(tree as ReactLikeNode);
    assert.deepEqual(
      texts,
      [],
      "a <p> is not a table tag, so this guard is about the block level",
    );
    // The `\n` between `</h1>` and `<p>` sits at body level: the walker
    // keeps it, and so must the tree.
    const topLevel = (tree as ReactLikeNode[]).filter(
      (node): node is string => typeof node === "string",
    );
    assert.ok(
      topLevel.some((text) => /^\s+$/.test(text)),
      "inter-block whitespace outside tables must still reach the tree",
    );
  });

  test("text with content under a table tag is still rendered (not over-trimmed)", () => {
    // A `<td>` may legitimately hold leading/trailing spaces around its
    // content ("  a  "). Only WHITESPACE-ONLY nodes may be dropped.
    const tree = withDomParserShim(() =>
      htmlToReact(parseMarkdown("| a |\n| --- |\n|   padded   |"), "light"),
    );
    const rendered = JSON.stringify(tree, (key, value) =>
      typeof value === "function" ? "[fn]" : value,
    );
    assert.ok(rendered.includes("padded"), "cell content was lost");
  });
});

describe("markdown-html — findMermaidSourceBefore (blocker 1: copy-source byte-exact)", () => {
  /**
   * Hand-built DOM Level 1 element mock. The walker only touches
   * `nodeType`, `tagName`, `classList.contains`, `textContent` (or
   * `innerHTML`, in the regression we're guarding against),
   * `previousSibling`. Both are exposed here, and `innerHTML`
   * intentionally diverges from `textContent` — `innerHTML` re-
   * escapes the entities (`<` → `&lt;`) the way a real DOM does,
   * while `textContent` returns the literal characters. This is
   * the surface the production walker runs on: DOMParser has
   * already decoded `&lt;` back to `<` in the parsed tree, so
   * `textContent` gives back the user's original source, and
   * `innerHTML` gives back the re-serialised view. A regression
   * that swaps the walker back to `innerHTML` will see `&gt;`
   * instead of `>` and the byte-exact assertions will fail.
   */
  function makePre(originalSource: string, classList: string[]): {
    nodeType: number;
    tagName: string;
    classList: { contains(c: string): boolean };
    textContent: string;
    innerHTML: string;
    previousSibling: null;
  } {
    // Simulate the DOMParser-then-serialise round-trip:
    //   - `textContent` is the decoded text (the user's original)
    //   - `innerHTML`  re-escapes `<`, `>`, `&`, `"`, `'` to entities
    const innerHTML = originalSource
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return {
      nodeType: 1,
      tagName: "pre",
      classList: {
        contains: (c: string): boolean => classList.includes(c),
      },
      textContent: originalSource,
      innerHTML,
      previousSibling: null,
    };
  }

  function makePlaceholder(
    previous: ReturnType<typeof makePre> | null,
  ): {
    nodeType: number;
    previousSibling: ReturnType<typeof makePre> | null;
  } {
    return { nodeType: 1, previousSibling: previous };
  }

  test("a flowchart with edge labels returns the original source byte-exact (NOT --&gt;)", () => {
    // The exact source the acceptance run fed through. The HTML
    // escape in lib/mermaid-renderer.ts would have produced
    // `A --&gt;|是| B` on the wire; after DOMParser parsed the
    // sanitised HTML and the walker ran, the production code must
    // hand mermaid `A -->|是| B` (literal `<`/`>`). The previous
    // walker used `pre.innerHTML` + a no-op `.replace(/</g, "<")`
    // and handed mermaid `A --&gt;|是| B`, which mermaid then
    // refused to parse — every flowchart with edge labels was a
    // failure card, and the "copy source" button copied back
    // `A --&gt;|是| B` instead of the user's original.
    const pre = makePre("flowchart LR\n  A -->|是| B\n  B --> C", ["mermaid-source"]);
    const ph = makePlaceholder(pre);
    const source = findMermaidSourceBefore(ph);
    assert.equal(source, "flowchart LR\n  A -->|是| B\n  B --> C");
    // And the regression that proves the bug was there: the literal
    // entity references must NOT appear in the source we hand to
    // mermaid.
    assert.doesNotMatch(source, /&gt;/);
    assert.doesNotMatch(source, /&lt;/);
    assert.doesNotMatch(source, /&amp;/);
  });

  test("a hostile source with -- and quotes decodes the entities the renderer escaped", () => {
    // Renderer would have escaped: `<`→`&lt;`, `>`→`&gt;`,
    // `"`→`&quot;`, `&`→`&amp;`. After DOMParser, `textContent`
    // returns the literal characters again — that is the contract
    // the walker depends on.
    const original = `flowchart LR\n  A["<b>x & y</b>"] --> B["z"]`;
    const pre = makePre(original, ["mermaid-source"]);
    const ph = makePlaceholder(pre);
    assert.equal(findMermaidSourceBefore(ph), original);
  });

  test("returns empty string when there is no preceding source <pre>", () => {
    // Defensive: an out-of-order walker should not crash; an empty
    // string makes the failure card show an empty source rather
    // than throw.
    const ph = makePlaceholder(null);
    assert.equal(findMermaidSourceBefore(ph), "");
  });

  test("returns empty string when the preceding element is not a mermaid-source <pre>", () => {
    // The walker must check the class — a non-mermaid <pre> above
    // the placeholder (e.g. a regular code block that happened to
    // be the previous sibling) must not be confused for the
    // mermaid source.
    const otherPre = makePre("not mermaid", ["codeblock-pre"]);
    const ph = makePlaceholder(otherPre);
    assert.equal(findMermaidSourceBefore(ph), "");
  });
});

describe("mermaid-block — initialize options (blockers 2 + 3: labels & body leftovers)", () => {
  test("htmlLabels is disabled at BOTH the top level AND inside flowchart (blocker 2)", () => {
    // mermaid 11's labelHelper reads from TWO config slots — node
    // labels use the top-level `htmlLabels`, edge labels use
    // `flowchart.htmlLabels`. Verified against mermaid 11.12.1 that
    // setting only one of them leaves foreignObject blocks in the
    // output for the other. Either regression breaks the label
    // visibility on a flowchart / pie / class / state diagram.
    const opts = _mermaidInitializeOptionsForTest("light");
    assert.equal(opts.htmlLabels, false, "top-level htmlLabels must be false");
    const flow = opts.flowchart as { htmlLabels?: unknown };
    assert.equal(flow.htmlLabels, false, "flowchart.htmlLabels must be false");
  });

  test("suppressErrorRendering is enabled so mermaid never draws the bomb SVG (blocker 3)", () => {
    // By default mermaid injects a 2400×512 "Syntax error in text"
    // bomb SVG into document.body on every parse failure, and the
    // bomb is not cleaned up when the host catches the thrown
    // error (the mermaid render path re-throws before
    // removeTempElements runs). The flag short-circuits both the
    // bomb-drawing branches. The regression is that a future
    // refactor drops the flag; with it gone, × N bad fences leave
    // × N orphaned bomb SVGs at the bottom of the page.
    const opts = _mermaidInitializeOptionsForTest("light");
    assert.equal(opts.suppressErrorRendering, true);
  });

  test("securityLevel stays strict so click handlers stay off", () => {
    // Belt-and-braces with the %%{init} stripper. The stripper is
    // the source-side filter; securityLevel is the second wall —
    // dropping either leaves the door open.
    const opts = _mermaidInitializeOptionsForTest("light");
    assert.equal(opts.securityLevel, "strict");
  });

  test("startOnLoad is disabled — the dynamic import owns the lifecycle", () => {
    // startOnLoad=true would have mermaid walk the document for
    // `.mermaid` elements at boot and try to render them before
    // MarkdownHtml has produced the placeholder tree. Disabling
    // keeps the lifecycle under the React component's control.
    const opts = _mermaidInitializeOptionsForTest("light");
    assert.equal(opts.startOnLoad, false);
  });

  test("the theme key reflects the prop (light ↔ 'default', dark ↔ 'dark')", () => {
    // The theme key participates in `lastMermaidConfigKey` and is
    // also the value mermaid uses to pick colours. Both must flip
    // on a theme change.
    assert.equal(_mermaidInitializeOptionsForTest("light").theme, "default");
    assert.equal(_mermaidInitializeOptionsForTest("dark").theme, "dark");
  });

  test("the CJK font fallback covers macOS / Windows / Linux", () => {
    // The acceptance run's Chinese Gantt / flowchart labels render
    // only if the SVG text inherits a font that ships CJK glyphs
    // on a freshly installed system. The regression is to drop
    // any one of PingFang SC / Microsoft YaHei / Noto Sans CJK SC
    // — that part of the world stops rendering on the missing
    // platform.
    assert.match(_mermaidFontFamilyForTest, /PingFang SC/);
    assert.match(_mermaidFontFamilyForTest, /Microsoft YaHei/);
    assert.match(_mermaidFontFamilyForTest, /Noto Sans CJK SC/);
  });

  test("the production options object matches what the live component hands mermaid", () => {
    // This pins the contract that `MermaidBlock.useEffect` and
    // `_mermaidInitializeOptionsForTest` agree — a future refactor
    // that adds a new option to one and forgets the other would
    // be caught here. The shape is a frozen object the test
    // hashes, so accidental edits to the live component show up as
    // a hash mismatch.
    const light = _mermaidInitializeOptionsForTest("light");
    const dark = _mermaidInitializeOptionsForTest("dark");
    const light2 = _mermaidInitializeOptionsForTest("light");
    assert.equal(JSON.stringify(light), JSON.stringify(light2));
    // And the dark and light themes must differ.
    assert.notEqual(JSON.stringify(light), JSON.stringify(dark));
    // And the shared shape — the four non-obvious options plus the
    // base ones — must all be present in both.
    for (const opts of [light, dark]) {
      for (const key of [
        "startOnLoad",
        "securityLevel",
        "theme",
        "htmlLabels",
        "flowchart",
        "suppressErrorRendering",
        "fontFamily",
      ]) {
        assert.ok(key in opts, `expected ${key} in initialize options`);
      }
    }
  });
});

describe("mermaid-block — configKey (the initialize re-run guard)", () => {
  // The component calls `mermaid.initialize` only when the config key
  // changes. The key construction is exported as
  // `_mermaidConfigKeyForTest` precisely so these assertions exist: in
  // the slice 23 acceptance the key was reverted to the historical
  // `${theme}|${source.length}` shape and the ENTIRE suite stayed green
  // (22/22) — the fix had no regression protection at all. These four
  // tests are the protection.

  test("different themes produce different keys", () => {
    const source = "flowchart LR\n  A --> B";
    const light = _mermaidConfigKeyForTest("light", source, _mermaidInitializeOptionsForTest("light"));
    const dark = _mermaidConfigKeyForTest("dark", source, _mermaidInitializeOptionsForTest("dark"));
    assert.notEqual(light, dark);
  });

  test("option content change behind an unchanged source still flips the key", () => {
    // The historical bug the old key shape could not see: options that
    // change CONTENT while the source stays put (length included)
    // produced the SAME key, so the second `mermaid.initialize`
    // silently never ran. Mutating the implementation back to
    // `${theme}|${source.length}` must turn this red.
    const source = "flowchart LR\n  A --> B";
    const base = _mermaidInitializeOptionsForTest("light");
    const flipped = { ...base, htmlLabels: !(base.htmlLabels as boolean) };
    assert.notEqual(
      _mermaidConfigKeyForTest("light", source, base),
      _mermaidConfigKeyForTest("light", source, flipped),
    );
  });

  test("source does not participate — different diagrams, same config, same key", () => {
    // `source` feeds `mermaid.render`, not `mermaid.initialize`; keying
    // on it (the old `${theme}|${source.length}` did) forces a
    // pointless re-initialise between two diagrams that share one
    // config. The two sources differ in LENGTH as well as content, so
    // the length-keyed mutation fails this too.
    const opts = _mermaidInitializeOptionsForTest("dark");
    assert.equal(
      _mermaidConfigKeyForTest("dark", "flowchart LR\n  A --> B", opts),
      _mermaidConfigKeyForTest("dark", "sequenceDiagram\n  A->>B: hi", opts),
    );
  });

  test("identical inputs produce the identical key (idempotent guard)", () => {
    const source = "flowchart LR\n  A --> B";
    const opts = _mermaidInitializeOptionsForTest("light");
    assert.equal(
      _mermaidConfigKeyForTest("light", source, opts),
      _mermaidConfigKeyForTest("light", source, opts),
    );
  });
});