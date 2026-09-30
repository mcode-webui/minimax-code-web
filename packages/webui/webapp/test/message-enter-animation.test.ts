// webapp/test/message-enter-animation.test.ts
//
// The message entry animation (webui-parity 61, G1).
//
// `message-animate-in` has been carried on the five message containers since
// ticket 46 PR1, but no stylesheet ever declared it. The class was present and
// the animation was structurally zero — the worst shape of defect, because
// every source-level check still passed. This suite is the regression net for
// exactly that shape of hole.
//
// The suite has no DOM or computed-style channel (no jsdom/happy-dom by
// policy), so it works the way webui-parity 43 taught: prove the *rule* is
// present and prove it *wins* the cascade by replaying the cascade over the
// real stylesheets in layout.tsx import order, rather than trusting that a
// rule "obviously" applies.
//
// Two independent claims are pinned:
//
//   1. The animation exists, carries the desktop's parameters, is reachable
//      from a globally loaded stylesheet, and is switched off explicitly
//      under `prefers-reduced-motion` (not left to the duration catch-all).
//   2. It cannot restart per streamed token. A CSS animation begins when its
//      element is created; it does not re-run because React re-rendered it.
//      So the property that matters is element identity across a stream, and
//      that is tested behaviourally against the pure `groupActivity` fold
//      rather than asserted as prose.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { groupActivity, type TranscriptBlock } from "../lib/transcript";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "..");

const readWebapp = (rel: string): string => readFileSync(resolve(webapp, rel), "utf8");
const globalsCss = readWebapp("app/globals.css");
const layoutSource = readWebapp("app/layout.tsx");
const chatSource = readWebapp("components/chat.tsx");
const activityGroupSource = readWebapp("components/activity-group.tsx");

/**
 * The reference package's declaration, transcribed. Held as a constant so the
 * parity test states the contract in one place instead of restating a literal
 * that the production rule could be quietly edited to match.
 */
const REFERENCE_ANIMATION = "message-appear 0.18s ease-out both";

// ---------------------------------------------------------------------------
// A deliberately small CSS reader.
//
// It parses only what this assertion needs — rules whose selector mentions
// the class, at any nesting — and skips @keyframes and @tailwind wholesale.
// @layer is *descended into* rather than skipped, and the layer name is
// recorded on the result, so "the rule is not inside a layer" is a stated
// assertion with a legible failure instead of an inference from the rule
// being invisible. That distinction is the whole Tailwind-purge question:
// Tailwind purges the utilities it generates, never hand-written rules, but
// only when they sit outside a layer.
//
// With no competing declaration anywhere in the app, cascade resolution for
// G1 is a lookup rather than a ranking problem, so no full cascade engine is
// needed — the checks below establish there is exactly one declaration.

type FoundRule = {
  sheet: string;
  selector: string;
  media: string | null;
  layer: string | null;
  body: string;
};

const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Slice the balanced `{ ... }` block whose "{" is at `open`. */
function braceSlice(text: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  throw new Error("unbalanced braces in css");
}

const REDUCED_MOTION = /prefers-reduced-motion:\s*reduce/;

/** Every rule in `css` whose selector list mentions `className`, with its context. */
function rulesForClass(css: string, sheet: string, className: string): FoundRule[] {
  const out: FoundRule[] = [];
  const walk = (text: string, media: string | null, layer: string | null): void => {
    let i = 0;
    while (i < text.length) {
      if (/\s/.test(text[i] ?? "")) {
        i += 1;
        continue;
      }
      if (text[i] === "@") {
        const brace = text.indexOf("{", i);
        const semi = text.indexOf(";", i);
        if (semi >= 0 && (brace < 0 || semi < brace)) {
          i = semi + 1; // statement at-rule, e.g. `@tailwind base;`
          continue;
        }
        if (brace < 0) return;
        const prelude = text.slice(i, brace);
        const block = braceSlice(text, brace);
        if (/^@media\b/.test(prelude)) {
          if (media !== null) throw new Error("nested @media is not modelled");
          walk(block.inner, prelude.replace(/^@media\s*/, "").trim(), layer);
        } else if (/^@layer\b/.test(prelude)) {
          walk(block.inner, media, prelude.replace(/^@layer\s*/, "").trim() || "(anonymous)");
        }
        // @keyframes / @supports / anything else: skipped, by design.
        i = block.end + 1;
        continue;
      }
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const selectorText = text.slice(i, open).trim();
      const block = braceSlice(text, open);
      if (selectorText.split(",").some((s) => s.trim().split(/\s+/).includes(`.${className}`))) {
        out.push({ sheet, selector: selectorText, media, layer, body: block.inner });
      }
      i = block.end + 1;
    }
  };
  walk(stripCssComments(css), null, null);
  return out;
}

/** The `@keyframes <name> { ... }` body, or null. */
function keyframesBody(css: string, name: string): string | null {
  const at = css.indexOf(`@keyframes ${name}`);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  if (open < 0) return null;
  return braceSlice(css, open).inner;
}

/** The `@media (prefers-reduced-motion: reduce) { ... }` body. */
function reducedMotionBody(css: string): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(start >= 0, "globals.css must carry a prefers-reduced-motion block");
  return braceSlice(css, css.indexOf("{", start)).inner;
}

/** Declarations of a single-selector rule body, as "prop: value" strings. */
function decls(body: string): string[] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
}

/** Every stylesheet the app loads, as { sheet, css } in layout.tsx import order. */
function loadedStylesheets(): { sheet: string; css: string }[] {
  const out: { sheet: string; css: string }[] = [];
  // Import order is the cascade order, so it is read off the layout in order
  // rather than from a directory listing.
  for (const match of layoutSource.matchAll(/import\s+"(\.[^"]*\.css)";/g)) {
    const specifier = match[1] as string;
    // Specifiers are relative to app/layout.tsx, so they resolve from app/ —
    // "./globals.css" and "../styles/x.css" both land inside the webapp root.
    out.push({ sheet: specifier, css: readFileSync(resolve(webapp, "app", specifier), "utf8") });
  }
  assert.ok(out.length > 0, "layout.tsx must import at least one stylesheet");
  return out;
}

// ---------------------------------------------------------------------------
// Claim 1 — the rule exists, is loaded, and is switched off under reduce.

describe("G1 — the message entry animation is defined and reachable", () => {
  const rules = rulesForClass(globalsCss, "app/globals.css", "message-animate-in");

  test("globals.css defines .message-animate-in at the desktop's parameters", () => {
    const unconditional = rules.filter((r) => r.media === null);
    assert.equal(
      unconditional.length,
      1,
      `expected exactly one unconditional .message-animate-in rule, got ${JSON.stringify(unconditional.map((r) => r.selector))}`,
    );
    const declsOfRule = decls(unconditional[0]!.body);
    assert.ok(
      declsOfRule.includes(`animation: ${REFERENCE_ANIMATION}`),
      `the animation shorthand must be "${REFERENCE_ANIMATION}" (transcribed from the reference package's styles/shell.css)`,
    );
  });

  test("the rule sits outside every @layer, so Tailwind's purge cannot reach it", () => {
    // The one thing that would put a hand-written rule at the mercy of
    // Tailwind's content scanner is nesting it in a layer: layer order then
    // decides the winner against generated utilities. Outside a layer the
    // rule is unconditional and unscannable.
    assert.ok(rules.length > 0, ".message-animate-in must be defined in globals.css");
    for (const rule of rules) {
      assert.equal(rule.layer, null, `the rule must be top-level, found it inside @layer ${rule.layer}`);
    }
    // Model sanity: this file does use layers elsewhere, so the assertion
    // above is doing work rather than passing on a file that has none.
    assert.match(globalsCss, /@layer\s+base/, "globals.css declares @layer base; the layer check must be live");
  });

  test("app/layout.tsx loads globals.css globally, from the root layout", () => {
    // A CSS import outside the root layout is scoped to a route segment; a
    // scoped or tree-shaken sheet is how a correct-looking rule stays dead.
    assert.match(layoutSource, /import\s+"\.\/globals\.css";/);
    assert.match(layoutSource, /export default function RootLayout/);
  });

  test("no other stylesheet in the app competes for the class or the keyframes", () => {
    // The cascade question for G1 is a lookup, not a ranking: with one
    // declaration in the whole app there is nothing to outrank it. This
    // tripwire is what keeps that true, and it is the check that would have
    // caught a same-specificity re-declaration the way ticket 43 was bitten.
    for (const { sheet, css } of loadedStylesheets()) {
      const competing = rulesForClass(css, sheet, "message-animate-in");
      if (sheet === "./globals.css") {
        assert.equal(competing.length, rules.length, "globals.css was read consistently");
        continue;
      }
      assert.deepEqual(
        competing,
        [],
        `${sheet} re-declares .message-animate-in and would fight globals.css in the cascade`,
      );
      assert.equal(
        keyframesBody(css, "message-appear"),
        null,
        `${sheet} also defines @keyframes message-appear; the animation's own definition must be the only one`,
      );
    }
  });

  test("@keyframes message-appear is the desktop's 2px rise with a fade-in", () => {
    const body = keyframesBody(globalsCss, "message-appear");
    assert.ok(body, "globals.css must define @keyframes message-appear");
    const flat = body.replace(/\s+/g, " ").trim();
    assert.match(flat, /from\s*\{[^}]*opacity:\s*0[^}]*\}/, "the first frame is fully transparent");
    assert.match(flat, /from\s*\{[^}]*transform:\s*translateY\(2px\)[^}]*\}/, "the first frame sits 2px low");
    assert.match(flat, /to\s*\{[^}]*opacity:\s*1[^}]*\}/, "the last frame is opaque");
    assert.match(flat, /to\s*\{[^}]*transform:\s*translateY\(0\)[^}]*\}/, "the last frame is settled");
  });
});

describe("G1 — reduced motion switches the animation off explicitly", () => {
  const reduceBody = reducedMotionBody(globalsCss);
  const reduceRules = rulesForClass(`@media (prefers-reduced-motion: reduce) { ${reduceBody} }`, "globals.css reduced-motion block", "message-animate-in");

  test("the existing reduced-motion block carries an explicit .message-animate-in rule", () => {
    // Deliberately the SAME block ticket 43 hardened, not a second one: the
    // catch-all below it only forces `animation-duration`, never
    // `animation-name`, so an animation that is merely made instant would
    // still compute `animation-name: message-appear` — which is the value
    // acceptance is stated in.
    assert.equal(reduceRules.length, 1, "exactly one explicit rule in the shared block");
    const rule = reduceRules[0]!;
    assert.equal(rule.selector, ".message-animate-in");
    assert.match(rule.body, /animation:\s*none\s*;?/);
  });

  test("it needs no !important precisely because nothing else declares the class", () => {
    // Asserted as an invariant rather than assumed: if a later sheet ever
    // re-declares the class, this flips and the rule has to gain !important
    // (the ticket-43 shape). Keeping the reasoning in the suite stops the
    // `!important` from being added or removed on a hunch.
    assert.doesNotMatch(reduceRules[0]!.body, /!important/);
    for (const { sheet, css } of loadedStylesheets()) {
      if (sheet === "./globals.css") continue;
      assert.deepEqual(rulesForClass(css, sheet, "message-animate-in"), [], `${sheet} must not re-declare the class`);
    }
  });

  test("the duration catch-all is still present (it covers everything else)", () => {
    assert.match(reduceBody, /animation-duration:\s*0\.001ms\s*!important/);
  });
});

// ---------------------------------------------------------------------------
// Claim 2 — the animation cannot restart per streamed token.
//
// A CSS animation starts when its element is created. React re-rendering the
// same keyed element does not restart it, and does not restart it when only
// the element's *text* changes. So the property to pin is: while a message
// streams, the container element that carries the class stays the same
// element. Two links carry that, and both are tested here:
//
//   - chat.tsx keys each unit by its position, and `groupActivity` only ever
//     appends units while the transcript grows — tested behaviourally below.
//   - every call site writes a static className literal, so nothing patches
//     the animated properties mid-stream.

const block = (role: TranscriptBlock["role"], text: string, streaming?: boolean): TranscriptBlock =>
  streaming === undefined ? { role, text } : { role, text, streaming };

/** A unit's identity as far as React's reconciliation is concerned. */
const fingerprint = (unit: ReturnType<typeof groupActivity>[number]): string =>
  unit.kind === "activity" ? "activity" : `block:${unit.block.role}`;

describe("G1 — streaming does not re-trigger the entry animation", () => {
  /**
   * Replays one turn the way the server does: the trailing assistant line is
   * rewritten with more text on every frame, and thinking / tool blocks are
   * appended behind it. The entry animation is bound to `key={originalIndex}`
   * in chat.tsx, so it replays exactly when a unit's *index* moves.
   */
  function streamTurn(): TranscriptBlock[][] {
    const user = block("user", "ping");
    const frames: TranscriptBlock[][] = [[user, block("assistant", "", true)]];
    for (const text of ["H", "He", "Hel", "Hell", "Hello"]) {
      frames.push([user, block("assistant", text, true)]);
    }
    const first = frames[frames.length - 1]!;
    frames.push([...first, block("thinking", "▲ weighing the options")]);
    const withThinking = frames[frames.length - 1]!;
    frames.push([...withThinking, { ...block("tool", "→ read {src/a.ts}"), toolName: "read", toolStatus: "completed" }]);
    const withTool = frames[frames.length - 1]!;
    for (const text of ["R", "Re", "Rea", "Read"]) {
      frames.push([...withTool, block("assistant", text, true)]);
    }
    return frames;
  }

  test("no unit changes index while a turn streams, so no message remounts", () => {
    const frames = streamTurn();
    assert.ok(frames.length >= 10, "the fixture must exercise more than a token or two");

    let previous = groupActivity(frames[0]!);
    const seenIndices = new Map<string, number[]>();

    for (const [frameIndex, frame] of frames.entries()) {
      const current = groupActivity(frame);
      assert.ok(
        current.length >= previous.length,
        `frame ${frameIndex} dropped units; the transcript stream is append-only`,
      );
      for (let i = 0; i < previous.length; i += 1) {
        assert.equal(
          fingerprint(current[i]!),
          fingerprint(previous[i]!),
          `frame ${frameIndex}: unit ${i} changed identity, which re-keys its message container and replays the entry animation mid-stream`,
        );
      }
      // Record where each live assistant block sits across the whole stream.
      current.forEach((unit, i) => {
        if (unit.kind === "block" && unit.block.role === "assistant") {
          const key = `assistant@${i}`;
          seenIndices.set(key, [...(seenIndices.get(key) ?? []), frameIndex]);
        }
      });
      previous = current;
    }

    // The live assistant unit never changes slot: one key covers every frame
    // in which it exists. Two keys would mean the container moved and
    // re-animated while text was still arriving.
    const keys = [...seenIndices.keys()];
    assert.equal(
      keys.length,
      2,
      `expected a settled and a live assistant unit, saw ${JSON.stringify(keys)} — a slot change means a mid-stream remount`,
    );
  });

  test("the unit count only ever grows, and activity runs fold into one unit", () => {
    const frames = streamTurn();
    const counts = frames.map((f) => groupActivity(f).length);
    for (let i = 1; i < counts.length; i += 1) {
      assert.ok(counts[i]! >= counts[i - 1]!, `unit count shrank at frame ${i}: ${counts.join(" -> ")}`);
    }
    // The thinking + tool pair collapses into a single activity unit rather
    // than pushing two new keyed nodes per step.
    assert.equal(
      counts[counts.length - 1],
      4,
      `user / assistant / [thinking+tool] / assistant, got ${counts[counts.length - 1]}`,
    );
  });
});

describe("G1 — call sites cannot re-arm the animation mid-stream", () => {
  const SOURCES = [
    { name: "components/chat.tsx", source: chatSource },
    { name: "components/activity-group.tsx", source: activityGroupSource },
  ];

  test("every message-animate-in className is a static string literal", () => {
    // The mechanism behind "plays once": a literal class list is written once
    // and never patched, so `animation-name` / `opacity` / `transform` cannot
    // change under a running animation. A template literal or a conditional
    // here would let a re-render restart the entry animation per token.
    let total = 0;
    for (const { name, source } of SOURCES) {
      const pattern = /className="([^"]*\bmessage-animate-in\b[^"]*)"/g;
      const literals = [...source.matchAll(pattern)].map((m) => m[1] as string);
      total += literals.length;
      assert.ok(literals.length > 0, `${name} must still carry the class`);
      for (const literal of literals) {
        assert.doesNotMatch(literal, /[{}`$]/, `${name}: the class list must not be an expression — got "${literal}"`);
        assert.doesNotMatch(literal, /streaming/, `${name}: the class list must not vary with the streaming flag`);
      }
      // Nothing may reach the class through an expression form either.
      assert.doesNotMatch(
        source.replace(pattern, ""),
        /className=\{[^}]*message-animate-in/,
        `${name}: a computed className mentions message-animate-in`,
      );
    }
    // Five containers, as of ticket 46 PR1: user, assistant, todo, notice,
    // activity group. A silent drop of one is the original defect in reverse.
    assert.equal(total, 5, "the five message containers must all still carry the class");
  });

  test("no container carries a utility the animation would fight over", () => {
    // The animation drives `transform` and `opacity`, and its `both` fill keeps
    // the `to` state for the rest of the element's life. A Tailwind transform
    // utility on the same element would be silently overridden forever after
    // the first paint while still reading as if it did something — pinned
    // here rather than left as a claim in the stylesheet's comment.
    for (const { name, source } of SOURCES) {
      for (const match of source.matchAll(/className="([^"]*\bmessage-animate-in\b[^"]*)"/g)) {
        const literal = match[1] as string;
        assert.doesNotMatch(
          literal,
          /\b(?:scale|rotate|translate|transform|opacity)-/,
          `${name}: "${literal}" carries a transform/opacity utility that the entry animation overrides`,
        );
      }
    }
  });

  test("the per-token cursor is a separate element and carries no entry animation", () => {
    // The `▍` cursor is re-rendered on every token. If it ever picked up
    // `message-animate-in`, the stream would strobe once per token. (Its
    // rhythm class is gap G6, out of scope here; this suite only pins that
    // the two concerns stay on different elements.)
    const cursor = /<span className="([^"]*)"[^>]*>▍<\/span>/.exec(chatSource);
    assert.ok(cursor, "the streaming cursor span must be findable in chat.tsx");
    assert.doesNotMatch(cursor[1]!, /message-animate-in/, "the cursor must not replay the entry animation");
  });

  test("the containers are keyed by unit position, not by content", () => {
    // React's key is the other half of "plays once": an unstable key would
    // remount the container even though its class list is static.
    const keyed = [...chatSource.matchAll(/<(Block|ActivityGroup)\s+key=\{([^}]+)\}/g)].map((m) => m[2] as string);
    assert.ok(keyed.length >= 2, "both unit renderers must carry a key");
    for (const key of keyed) {
      assert.equal(key, "originalIndex", `unit keys must stay positional, found "${key}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Scope of the cascade checks. `styles/` also holds sheets the app does not
// load, and an unimported file cannot compete for a class — so the checks
// above walk the import list, not the directory. This test exists to make
// that scope visible (a newly loaded sheet is picked up automatically, and a
// path that fails to resolve would otherwise read as "no competitor").
describe("G1 — stylesheet coverage of the cascade checks", () => {
  test("every stylesheet layout.tsx imports was located and read", () => {
    const loaded = loadedStylesheets();
    for (const { sheet, css } of loaded) {
      assert.ok(css.length > 0, `${sheet} resolved to an empty file`);
      assert.ok(css.includes("{"), `${sheet} resolved to something that is not a stylesheet`);
    }
    assert.ok(loaded.some((s) => s.sheet === "./globals.css"), "globals.css is the sheet under test");
  });

  test("the import order puts globals.css first among the app's sheets", () => {
    // Import order is the cascade order, so the first sheet is the one with
    // the fewest chances to be overridden by a later one.
    assert.equal(loadedStylesheets()[0]?.sheet, "./globals.css");
  });
});
