// webapp/test/workspace-filter.test.ts
//
// Unit tests for the pure glob matcher used by the workspace picker's filter
// input. Pinned against the legacy filter's semantics so a future
// rewrite cannot drift from what users were already promised by the
// "Filter… (globs like *.txt)" placeholder.
//
// Style note: tests live next to the source under `webapp/test/` and are run
// by `pnpm --filter @mavis/webui test:webapp`. No DOM is required — the
// matcher is pure — so we keep things minimal: `node:test` + assertions.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { globToRegex, matchFilter } from "../lib/workspace-filter";

describe("globToRegex", () => {
  it("matches `*` against any run of characters", () => {
    const re = globToRegex("*.txt");
    assert.equal(re.test("notes.txt"), true);
    assert.equal(re.test(".txt"), true);
    assert.equal(re.test("long.name.with.dots.txt"), true);
  });

  it("matches `?` against exactly one character", () => {
    const re = globToRegex("a?c");
    assert.equal(re.test("abc"), true);
    assert.equal(re.test("axc"), true);
    assert.equal(re.test("ac"), false);
    assert.equal(re.test("abbc"), false);
  });

  it("combines `*` and `?` in the same pattern", () => {
    const re = globToRegex("src/*.ts?");
    // `?` consumes exactly one char after `.ts`, so the file extension must be
    // three letters (e.g. `.tsx`).
    assert.equal(re.test("src/index.tsx"), true);
    assert.equal(re.test("src/lib/foo.tsx"), true);
    // `?` requires at least one character, so `src/.ts` (no char before end)
    // must NOT match — the `?` cannot absorb an empty tail.
    assert.equal(re.test("src/.ts"), false);
    assert.equal(re.test("src/index.js"), false);
    assert.equal(re.test("other/index.tsx"), false);
  });

  it("treats everything else as a literal", () => {
    const re = globToRegex("my file.md");
    assert.equal(re.test("my file.md"), true);
    assert.equal(re.test("myXfile.md"), false);
  });

  it("escapes regex metacharacters so they don't become regex ops", () => {
    // Without escaping, `+` would mean "one or more" and the literal `a+`
    // would also match `aaaa`. The legacy escape set must keep `a+` literal.
    const plus = globToRegex("a+");
    assert.equal(plus.test("a+"), true);
    assert.equal(plus.test("a"), false);
    assert.equal(plus.test("aa"), false);

    // Same idea for the rest of the legacy escape set: `.`, `^`, `$`, `{`, `}`,
    // `(`, `)`, `|`, `[`, `]`, `\`.
    const tricky = "(a+b).md";
    assert.equal(globToRegex(tricky).test(tricky), true);
    assert.equal(globToRegex(tricky).test("aaab.md"), false);
  });

  it("matches case-insensitively (legacy `i` flag)", () => {
    const re = globToRegex("README.md");
    assert.equal(re.test("readme.md"), true);
    assert.equal(re.test("README.MD"), true);
    assert.equal(re.test("ReadMe.Md"), true);
  });

  it("anchors with ^ and $ so partials don't match", () => {
    const re = globToRegex("notes");
    assert.equal(re.test("notes"), true);
    assert.equal(re.test("notes.txt"), false);
    assert.equal(re.test("mynotes"), false);
  });
});

describe("matchFilter", () => {
  it("treats an empty pattern as 'everything matches'", () => {
    assert.equal(matchFilter("anything", ""), true);
    assert.equal(matchFilter("anything", "   "), true);
  });

  it("supports the legacy `*` placeholder promise", () => {
    // The placeholder in the legacy picker was `Filter… (globs like *.txt)`.
    // Match the example users would try first.
    assert.equal(matchFilter("notes.txt", "*.txt"), true);
    assert.equal(matchFilter("notes.md", "*.txt"), false);
  });

  it("supports the legacy `?` placeholder promise", () => {
    assert.equal(matchFilter("a1b", "a?b"), true);
    assert.equal(matchFilter("ab", "a?b"), false);
  });

  it("ignores leading/trailing whitespace in the user's pattern", () => {
    // The legacy filter trimmed the input on input events.
    // We do the same so accidental spaces from a paste don't silently disable
    // every match.
    assert.equal(matchFilter("notes.txt", "  *.txt  "), true);
  });

  it("returns false for non-matching names", () => {
    assert.equal(matchFilter("readme.md", "*.txt"), false);
    assert.equal(matchFilter("image.png", "image.*"), true);
    // `image.*` matches `image.png.bak` too — the `*` swallows the rest of
    // the name. This is the legacy behaviour (`*` is greedy) and is the
    // reason the panel applies the visible-list cap after filtering: a wide
    // glob can still produce a wide list.
    assert.equal(matchFilter("image.png.bak", "image.*"), true);
    // An anchored pattern like `image.??` requires exactly two chars after
    // the dot, so `image.png.bak` no longer matches.
    assert.equal(matchFilter("image.png.bak", "image.??"), false);
  });
});