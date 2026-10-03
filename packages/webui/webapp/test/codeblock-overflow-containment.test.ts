// webapp/test/codeblock-overflow-containment.test.ts
//
// Layout tripwire for P18 (UAT 2026-10-03 17:00, red line 2): a codeblock
// taller than the shell's `max-height: 45vh` painted its overflow on top of
// the prose that follows it — the tail of a Python block overlapped the
// "总结" paragraph and neither layer was readable.
//
// Why a layout tripwire and not a screenshot: the defect is a CSS box-model
// invariant, and the webapp suite has no render harness (same constraint the
// markdown-code-wrap tripwire documents). So the test states the invariant
// explicitly and evaluates the shipped cascade against it:
//
//   .codeblock-shell        flex column, max-height 45vh  → outer bound
//     .codeblock-toolbar    flex-shrink: 0
//     pre.codeblock-pre     flex item  → must be allowed to shrink
//       code.codeblock-code scroll box → must absorb the overflow
//
// The chain only holds if the `<pre>` can shrink (flex items default to
// `min-height: auto`, i.e. "never below my content") and if the `<code>` is
// actually a flex item, so that the upstream `flex: 1 1 auto; min-height: 0;
// overflow: auto` rule on it applies instead of being inert. When the `<pre>`
// refuses to shrink, the shell's `max-height` still applies to the shell box,
// so the prose after it starts at the capped height while the code paints
// straight through — the UAT measurement (shell 285px, pre 375px, pre
// `overflow-y: visible`).
//
// The last case feeds mutated cascades to the same evaluator, so a test that
// cannot fail on a broken sheet is impossible to ship unnoticed here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const utilitiesCss = readFileSync(
  resolve(here, "../styles/official-utilities.css"),
  "utf8",
);
const overridesCss = readFileSync(resolve(here, "../styles/markdown-overrides.css"), "utf8");
const { parseMarkdown } = await import("../lib/markdown");

/** The cascade as the browser sees it: overrides.css loads last (layout.tsx). */
const shippedCss = `${utilitiesCss}\n${overridesCss}`;

/** Declarations of the flat rules whose selector text is exactly `selector`. */
function declarationsFor(css: string, selector: string): Record<string, string> {
  // Comments come off first: a block comment sitting above a rule would
  // otherwise be swallowed into the selector text and hide the rule.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const merged: Record<string, string> = {};
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = match[1] ?? "";
    const body = match[2] ?? "";
    if (selectorText.trim().replace(/\s+/g, " ") !== selector) continue;
    for (const declaration of body.split(";")) {
      const at = declaration.indexOf(":");
      if (at < 0) continue;
      merged[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim();
    }
  }
  return merged;
}

const isClipped = (value: string | undefined): boolean =>
  value !== undefined && value !== "visible";

/**
 * Evaluate the P18 invariant against a cascade and report, in layout terms,
 * whether content taller than the shell's cap can still paint outside it.
 */
function overTallCodeblockEscapes(css: string): boolean {
  const shell = declarationsFor(css, ".codeblock-shell");
  const pre = declarationsFor(css, ".codeblock-shell .codeblock-pre");
  const code = declarationsFor(css, ".codeblock-shell .codeblock-code");

  // The outer bound has to exist at all, otherwise "overflow" is a category
  // error: with no cap there is nothing to escape from.
  const capped = shell["max-height"] !== undefined;
  // A flex item defaults to `min-height: auto` — "at least as tall as my
  // content" — so without an explicit 0 the <pre> pushes past the cap.
  const preShrinks = pre["min-height"] === "0";
  // `overflow:auto` on the <code> is inert unless the <code> is a flex item
  // of the <pre>; the <pre> has to establish that flex context itself.
  const codeIsFlexItem = pre["display"] === "flex" || pre["display"] === "inline-flex";
  const codeScrolls = isClipped(code["overflow"]) || isClipped(code["overflow-y"]);
  const codeShrinks = code["min-height"] === "0";

  return !(capped && preShrinks && codeIsFlexItem && codeScrolls && codeShrinks);
}

describe("codeblock overflow containment (P18)", () => {
  test("an over-tall codeblock stays inside its own scroll box", () => {
    assert.equal(
      overTallCodeblockEscapes(shippedCss),
      false,
      "the <pre> must shrink inside the capped shell and hand its overflow to a scrolling <code>",
    );
  });

  test("the <code> is the scroll box, so the shell's scrollbar rules keep applying", () => {
    // Moving the overflow onto the <pre> would be a different fix and a
    // different look: every scrollbar rule upstream and in the override
    // sheet keys on `.codeblock-code`. This pins the choice.
    const code = declarationsFor(shippedCss, ".codeblock-shell .codeblock-code");
    assert.ok(isClipped(code["overflow"]), "the <code> owns the overflow");
    assert.equal(declarationsFor(shippedCss, ".codeblock-shell .codeblock-pre")["overflow"], undefined);
  });

  test("the rendered markup keeps the pre > code shape the fix depends on", () => {
    // Rendered through the real parser, not a source regex: the cascade
    // below only holds while the <code> is a flex item of the <pre>, and
    // that is a statement about the DOM the product emits.
    const html = parseMarkdown("```py\nconst x = 1;\n```\n\n总结：正文段落。\n");
    const shell = html.indexOf('<div class="codeblock-shell">');
    const toolbar = html.indexOf('<div class="codeblock-toolbar">');
    const pre = html.indexOf('<pre class="codeblock-pre">');
    const code = html.indexOf('<code class="codeblock-code');
    assert.ok(shell >= 0 && toolbar > shell, "the shell wraps a toolbar");
    assert.ok(pre > toolbar, "the <pre> follows the toolbar inside the shell");
    assert.ok(code > pre, "the <code> is nested inside the <pre>");
    assert.ok(html.indexOf("</code>") < html.indexOf("</pre>"), "…and closes inside it");
    // The paragraph after the fence is a sibling of the shell, which is what
    // makes the following prose a layout neighbour rather than a painting
    // surface the overflow could reach.
    assert.ok(html.indexOf("总结") > html.indexOf("</pre>"));
  });

  test("the vendored upstream sheet stays untouched — the fix is an override", () => {
    // official-utilities.css is shared verbatim with the desktop build. If
    // someone "fixes" the defect by editing it, this pin goes red.
    const shell = declarationsFor(utilitiesCss, ".codeblock-shell");
    assert.equal(shell["overflow"], undefined);
    assert.match(utilitiesCss, /--codeblock-shell-max-height:45vh/);
    assert.ok(
      /\.codeblock-shell \.codeblock-pre \{/.test(overridesCss),
      "the fix lives in the override sheet",
    );
  });

  // Mutation proof, both directions: a tripwire that cannot go red proves
  // nothing, so both load-bearing declarations are removed in turn and the
  // evaluator has to call the cascade broken.
  test("mutation: dropping min-height:0 on the pre brings the overlap back", () => {
    const mutated = shippedCss.replace(
      /(\.codeblock-shell \.codeblock-pre \{[^}]*?)min-height:\s*0\s*;?/,
      "$1",
    );
    assert.ok(mutated !== shippedCss, "the mutation must actually change the sheet");
    assert.equal(overTallCodeblockEscapes(mutated), true);
  });

  test("mutation: an overflow-less pre — or a code that is not a flex item — also escapes", () => {
    const withoutFlexContext = shippedCss.replace(
      /(\.codeblock-shell \.codeblock-pre \{[^}]*?)display:\s*flex\s*;?/,
      "$1",
    );
    assert.ok(
      withoutFlexContext !== shippedCss,
      "the mutation must actually change the sheet",
    );
    assert.equal(overTallCodeblockEscapes(withoutFlexContext), true);
  });
});
