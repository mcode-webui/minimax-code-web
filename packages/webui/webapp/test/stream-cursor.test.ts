// webapp/test/stream-cursor.test.ts
//
// The streaming cursor's rhythm (webui-parity 61, G6).
//
// The trailing cursor glyph of a streaming assistant block shipped on
// Tailwind's stock `animate-pulse` — `pulse 2s cubic-bezier(0.4, 0, 0.6, 1)
// infinite` over `@keyframes pulse { 50% { opacity: .5 } }` (tailwindcss
// 3.4.19). A symmetric eased breath between 1 and 0.5: no instant edge, no off
// state. It is a loading tell, not a caret. The replacement is a square wave
// (`.stream-cursor`), and this suite is the regression net for it.
//
// Like webui-parity 43 / 61-G1, the suite has no DOM or computed-style
// channel (no jsdom by policy), so the two claims are pinned at the two seams
// that actually exist:
//
//   1. BEHAVIOURAL — when the cursor is on screen at all. The gate is the
//      decoder: `decodeTranscript` sets `streaming` on exactly one block, the
//      trailing assistant line the server wrote with a cursor suffix
//      (`server/lib/chat-line.js#streamUpdateLine`). That is real code driven
//      with real wire frames, so "the cursor shows while tokens arrive and
//      vanishes when the turn settles" is a behavioural claim, not prose.
//
//   2. CASCADE — what the glyph does while it is on screen. `MarkdownBody` is
//      a private function inside chat.tsx, whose `@/`-aliased import graph the
//      node test runner cannot resolve (the reason activity-group.test.ts
//      renders from a lifted component instead), so the render seam is read as
//      source and the stylesheet is parsed and replayed over the sheets
//      layout.tsx actually loads, in import order. What that buys is stated in
//      each test.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { decodeTranscript } from "../lib/transcript";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "..");

const readWebapp = (rel: string): string => readFileSync(resolve(webapp, rel), "utf8");
const globalsCss = readWebapp("app/globals.css");
const layoutSource = readWebapp("app/layout.tsx");
const chatSource = readWebapp("components/chat.tsx");

// ---------------------------------------------------------------------------
// A deliberately small CSS reader.
//
// It parses only what these assertions need — rules whose selector mentions
// the class at any nesting — and skips @keyframes and @tailwind wholesale.
// @layer is descended into rather than skipped, with the name recorded, so
// "the rule is not inside a layer" is a stated assertion (that distinction is
// the whole Tailwind-purge question: hand-written rules outside a layer are
// never purged, rules inside one compete with generated utilities).

type FoundRule = {
  sheet: string;
  selector: string;
  media: string | null;
  layer: string | null;
  body: string;
};

const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The balanced `{ ... }` block whose "{" is at `open`. */
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

/** Every rule in `css` whose selector list mentions `.className`. */
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

/** Declarations of a rule body, as "prop: value" strings. */
function decls(body: string): string[] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
}

/** Every stylesheet the app loads, as { sheet, css } in layout.tsx import order. */
function loadedStylesheets(): { sheet: string; css: string }[] {
  const out: { sheet: string; css: string }[] = [];
  for (const match of layoutSource.matchAll(/import\s+"(\.[^"]*\.css)";/g)) {
    const specifier = match[1] as string;
    // Specifiers are relative to app/layout.tsx, so they resolve from app/ —
    // "./globals.css" and "../styles/x.css" both land inside the webapp root.
    out.push({ sheet: specifier, css: readFileSync(resolve(webapp, "app", specifier), "utf8") });
  }
  assert.ok(out.length > 0, "layout.tsx must import at least one stylesheet");
  return out;
}

// The animation shorthand is pinned as a contract constant, so the production
// rule cannot be quietly retuned to match whatever the test currently reads.
const REFERENCE_ANIMATION = "stream-cursor-blink 1.1s steps(1, end) infinite";

/** Every unconditional `.stream-cursor` rule in globals.css. */
function cursorRules(): FoundRule[] {
  return rulesForClass(globalsCss, "app/globals.css", "stream-cursor").filter((r) => r.media === null);
}

/** The animation value the real `.stream-cursor` rule declares. */
function cursorAnimationShorthand(): string {
  const rules = cursorRules();
  assert.equal(rules.length, 1, "expected exactly one unconditional .stream-cursor rule");
  const animation = decls(rules[0]!.body).find((d) => d.startsWith("animation:"));
  assert.ok(animation, "the rule must declare an animation");
  return animation.replace(/^animation:\s*/, "").replace(/;$/, "").trim();
}

/** Every `@keyframes <name>` declaration in a stylesheet, comments stripped. */
function keyframesNames(css: string): string[] {
  return [...stripCssComments(css).matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g)].map((m) => m[1] as string);
}

/** The cursor span as it is written in chat.tsx, with its attributes. */
function cursorSpan(): { classes: string; element: string } {
  const match = /<span([^>]*className="([^"]*)"[^>]*)>(▍)<\/span>/.exec(chatSource);
  assert.ok(match, "the streaming cursor span must be findable in chat.tsx");
  assert.equal(match[3], "▍", "the span matched must be the cursor itself");
  return { classes: match[2] as string, element: match[1] as string };
}

// ---------------------------------------------------------------------------
// Claim 1 — the cursor exists exactly while the trailing assistant line streams.
//
// The frames below are the wire shape `server/lib/chat-line.js#streamUpdateLine`
// writes: one assistant line rewritten in place on every push, carrying a
// trailing cursor suffix, and the suffix stripped the moment the turn settles
// (or a different prefix takes over).

describe("G6 — the cursor rides the streaming flag and nothing else", () => {
  test("only the trailing assistant line is marked streaming while tokens arrive", () => {
    // Frames start at the first non-empty chunk: an empty assistant line
    // reaches the wire as prefix + empty text + cursor, i.e. two spaces
    // between the glyph and the cursor, and the decoder's `^[●•]\s+(.*)$`
    // eats both — leaving a bare cursor with nothing in front of it to strip.
    // Nothing renders differently (there is no text to put a caret after), so
    // the first visible chunk is where the cursor appears, and that is the
    // sequence pinned here.
    const texts = ["H", "He", "Hel", "Hell", "Hello"];
    for (const [index, text] of texts.entries()) {
      const blocks = decodeTranscript(["› ping", `● ${text} ▍`]);
      const streaming = blocks.filter((b) => b.streaming);
      assert.equal(streaming.length, 1, `frame ${index}: exactly one streaming block`);
      assert.equal(streaming[0]?.role, "assistant");
      assert.equal(streaming[0]?.text, text, `frame ${index}: the cursor follows the growing text`);
      // The cursor glyph is the server's, and the decoder strips it before the
      // renderer sees the text — otherwise the paragraph would carry a literal
      // glyph next to the drawn one.
      assert.doesNotMatch(
        streaming[0]?.text ?? "",
        /▍/,
        "the wire cursor must not survive into the rendered text",
      );
    }
  });

  test("no block is streaming once the turn settles", () => {
    const blocks = decodeTranscript(["› ping", "● Hello there"]);
    assert.equal(
      blocks.filter((b) => b.streaming).length,
      0,
      "a settled transcript carries no streaming flag, so the cursor cannot be left behind",
    );
  });

  test("the thinking → assistant handover leaves the cursor on one block only", () => {
    // `streamUpdateLine` strips the cursor suffix from every other line before
    // writing the new one, so a thought that hands over to prose must not keep
    // a blinking caret of its own.
    const blocks = decodeTranscript(["› ping", "▲ weighing the options ▍", "● the answer ▍"]);
    const streaming = blocks.filter((b) => b.streaming);
    assert.equal(streaming.length, 1);
    assert.equal(streaming[0]?.role, "assistant", "the caret follows the prose, not the thought");
  });

  test("a cursor is only ever drawn from the streaming flag, and only while it is set", () => {
    // The one render seam source text can carry: a `streaming` ternary that
    // falls through to null. A cursor on any other condition (a running
    // session, an active tool, a loading state) would outlive the turn it
    // belongs to.
    const body = /function MarkdownBody\([\s\S]*?\n\}/.exec(chatSource);
    assert.ok(body, "MarkdownBody must be findable in chat.tsx");
    assert.match(
      body[0],
      /\{streaming\s*\?\s*\(?\s*<span className="[^"]*stream-cursor[^"]*">▍<\/span>\s*\)?\s*:\s*null\}/,
      "the cursor must be gated on `streaming` alone and render nothing otherwise",
    );
  });
});

// ---------------------------------------------------------------------------
// Claim 2 — the rhythm is a square wave, on an element that never churns.

describe("G6 — the cursor blinks on a rhythm of its own", () => {
  test("the class is the rhythm, and the stock breathe is gone", () => {
    const { classes } = cursorSpan();
    assert.match(classes, /\bstream-cursor\b/, "the cursor must carry the rhythm class");
    assert.doesNotMatch(
      chatSource,
      /\banimate-pulse\b/,
      "animate-pulse is the symmetric breath G6 replaces; it must not come back",
    );
  });

  test("globals.css defines .stream-cursor with the square-wave shorthand", () => {
    const rules = cursorRules();
    assert.equal(
      rules.length,
      1,
      `expected exactly one unconditional .stream-cursor rule, got ${JSON.stringify(rules.map((r) => r.selector))}`,
    );
    assert.deepEqual(
      decls(rules[0]!.body),
      [`animation: ${REFERENCE_ANIMATION}`],
      "the rule must carry the animation and nothing else — a layout or opacity declaration here would fight the utilities on the same element",
    );
  });

  test("the animation name resolves to one keyframes block that actually exists", () => {
    // A renamed or deleted `@keyframes` leaves the shorthand well-formed and
    // every other assertion here intact while the animation renders nothing —
    // the same "structurally present, behaviourally zero" shape ticket 46 PR1
    // shipped the entry animation in. So the name the rule actually declares is
    // resolved against the keyframes names every loaded sheet declares, by
    // exact match rather than by substring (a prefix test would happily accept
    // `stream-cursor-blink-renamed`).
    const name = cursorAnimationShorthand().split(/\s+/)[0];
    const declared = loadedStylesheets().flatMap(({ sheet, css }) =>
      keyframesNames(css).map((declaredName) => ({ sheet, name: declaredName })),
    );
    assert.deepEqual(
      declared.filter((d) => d.name === name),
      [{ sheet: "./globals.css", name }],
      `the animation must name a keyframes block declared exactly once across the app; "${name}" resolves to ${JSON.stringify(declared.filter((d) => d.name === name))}`,
    );
  });

  test("the timing function is a step, so the glyph blinks instead of fading", () => {
    // `steps(1, end)` holds each level for its whole interval and jumps at the
    // end. A curve here — `ease-in-out`, even the stock `pulse` one — is
    // exactly the defect: the eye reads a fade as "loading", not as a caret.
    const animation = cursorAnimationShorthand();
    assert.match(animation, /\bsteps\(1,\s*end\)/, `the real rule must step, found "${animation}"`);
    assert.doesNotMatch(
      animation,
      /ease|cubic-bezier|linear/,
      `a square wave must not be eased, found "${animation}"`,
    );
    assert.match(animation, /\binfinite\b/, "the caret blinks for the whole turn, so the iteration count must be infinite");
  });

  test("the keyframes have two opacity levels, and only two", () => {
    const body = keyframesBody(globalsCss, "stream-cursor-blink");
    assert.ok(body, "globals.css must define @keyframes stream-cursor-blink");
    const levels = [...stripCssComments(body).matchAll(/opacity:\s*([\d.]+)/g)].map(
      (m) => m[1] as string,
    );
    assert.deepEqual(
      [...new Set(levels)].sort(),
      ["0.2", "1"],
      "the waveform must be a square wave: a fully lit level and a dim floor, nothing in between",
    );
    // The lit plateau spans 0% → 60% and the dark level 60.01% → 100%: a lit
    // majority, so the insertion point is readable most of the cycle, and a
    // dark phase long enough to read as a blink.
    const flat = stripCssComments(body).replace(/\s+/g, " ").trim();
    assert.match(flat, /0%\s*,\s*60%\s*\{\s*opacity:\s*1\s*;?\s*\}/, "lit from 0% to 60%");
    assert.match(flat, /60\.01%\s*,\s*100%\s*\{\s*opacity:\s*0\.2\s*;?\s*\}/, "dim from 60.01% to 100%");
  });

  test("the period is faster than the phrase rotation and coprime with it", () => {
    // The label swaps every 3.5s (webui-parity 61, G5). A cursor period that
    // divides, or is divided by, that would make the two rhythms lock into one
    // slow compound beat; 1.1s does not (3.5 / 1.1 = 3.18).
    const period = Number.parseFloat(/\s([\d.]+)s\s/.exec(` ${cursorAnimationShorthand()} `)?.[1] ?? "");
    assert.ok(period > 0, "the period must be stated in the shorthand");
    assert.ok(period < 3.5, "the caret must beat faster than the 3.5s phrase rotation");
    const ratio = 3.5 / period;
    assert.ok(
      Math.abs(ratio % 1) > 0.05 && Math.abs((1 / ratio) % 1) > 0.05,
      `a ${period}s caret would lock to the 3.5s rotation (ratio ${ratio.toFixed(2)})`,
    );
  });

  test("the rule sits outside every @layer, and nothing else declares the class", () => {
    for (const rule of rulesForClass(globalsCss, "app/globals.css", "stream-cursor")) {
      assert.equal(rule.layer, null, `must be top-level, found it inside @layer ${rule.layer}`);
    }
    assert.match(globalsCss, /@layer\s+base/, "globals.css declares @layer base; the layer check must be live");
    for (const { sheet, css } of loadedStylesheets()) {
      if (sheet === "./globals.css") continue;
      assert.deepEqual(
        rulesForClass(css, sheet, "stream-cursor"),
        [],
        `${sheet} re-declares .stream-cursor and would fight globals.css in the cascade`,
      );
      assert.equal(
        keyframesBody(css, "stream-cursor-blink"),
        null,
        `${sheet} also defines @keyframes stream-cursor-blink; one definition must win`,
      );
    }
  });

  test("streaming does not churn the element, so the beat is never restarted per token", () => {
    // A CSS animation begins when its element is created. React reuses the
    // cursor span across the whole turn — same type, same position, no key —
    // so the phase free-runs instead of snapping back to "lit" on every push.
    // Two things would break that, and both are asserted here rather than
    // assumed: a key on the span, or a className expression whose value could
    // change with the text.
    const { classes, element } = cursorSpan();
    assert.doesNotMatch(element, /\bkey=/, "a key would remount the span per token and restart the animation");
    assert.doesNotMatch(classes, /[{$`]/, `className must stay a static literal, found "${classes}"`);
    assert.match(classes, /\binline-block\b/, "the glyph stays an inline block; the animation needs no layout");
  });
});

// ---------------------------------------------------------------------------
// Claim 3 — reduced motion switches the blink off, and leaves the caret visible.
//
// The shared block's catch-all forces `animation-duration` and
// `animation-iteration-count` only. It never touches `animation-name`, so an
// unhandled class still computes `animation-name: stream-cursor-blink` under
// reduce — which is the value acceptance is stated in. Hence an explicit rule,
// exactly as ticket 43 hardened the skeleton and G1 hardened the entry fade.

describe("G6 — reduced motion stops the blink and keeps the caret", () => {
  const reduceBody = reducedMotionBody(globalsCss);
  const reduceRules = rulesForClass(
    `@media (prefers-reduced-motion: reduce) { ${reduceBody} }`,
    "globals.css reduced-motion block",
    "stream-cursor",
  );

  test("the shared reduced-motion block carries an explicit .stream-cursor rule", () => {
    assert.equal(reduceRules.length, 1, "exactly one explicit rule in the shared block");
    assert.equal(reduceRules[0]!.selector, ".stream-cursor");
    assert.match(reduceRules[0]!.body, /animation:\s*none\s*;?/);
  });

  test("it needs no !important precisely because nothing else declares the class", () => {
    assert.doesNotMatch(reduceRules[0]!.body, /!important/);
    for (const { sheet, css } of loadedStylesheets()) {
      if (sheet === "./globals.css") continue;
      assert.deepEqual(
        rulesForClass(css, sheet, "stream-cursor"),
        [],
        `${sheet} must not re-declare the class`,
      );
    }
  });

  test("stopping the animation leaves the glyph lit, not invisible", () => {
    // The rhythm lives entirely in the keyframes, so `animation: none` drops
    // the element back to the base (fully lit) state. A caret that vanished
    // under reduce-motion would break the insertion point — the exact trade
    // ticket 43 refused for the loading dots, where the copy carries the
    // meaning; here the glyph is the only carrier.
    for (const rule of cursorRules()) {
      assert.doesNotMatch(
        rule.body,
        /opacity/,
        "the rule must not set opacity, or the base state would not be lit",
      );
    }
    assert.doesNotMatch(reduceRules[0]!.body, /opacity/, "the reduced-motion rule must not dim the caret");
  });

  test("the duration catch-all is still present (it covers everything else)", () => {
    assert.match(reduceBody, /animation-duration:\s*0\.001ms\s*!important/);
  });
});
