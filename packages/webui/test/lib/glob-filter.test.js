// webui/test/lib/glob-filter.test.js
//
// Server-side port of the workspace-filter glob matcher (server/lib/glob-filter.js).
//
// The webapp's filter box promises `*` any-run / `?` one-char glob
// semantics. The server-side search walker (lib/fs-search.js) MUST
// honour the same promise, so this test pins the server's match
// table against the same cases the webapp regression test
// (`webapp/test/workspace-filter.test.ts`) covers. If the two
// ever drift, a regression on either side breaks the matching and
// this test catches the server side immediately.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const { matchFilter, globToRegex } = await import(absPath("lib/glob-filter.js"));

describe("lib/glob-filter — server-side glob matcher (slice 19a)", () => {
  describe("literal patterns match exactly, case-insensitive", () => {
    for (const name of ["package.json", "README.md", "main.ts", "index.js", ".env"]) {
      test(`"${name}" matches itself`, () => {
        assert.equal(matchFilter(name, name), true);
      });
      test(`"${name}" matches case-insensitive variations`, () => {
        assert.equal(matchFilter(name.toUpperCase(), name), true);
        assert.equal(matchFilter(name.toLowerCase(), name), true);
      });
    }
  });

  describe("wildcards", () => {
    test("* matches anything (including empty runs)", () => {
      assert.equal(matchFilter("package.json", "*"), true);
      assert.equal(matchFilter("anything", "*"), true);
      assert.equal(matchFilter(".hidden", "*"), true);
    });

    test("? matches a single character", () => {
      assert.equal(matchFilter("a", "?"), true);
      assert.equal(matchFilter("ab", "?"), false);
      assert.equal(matchFilter("", "?"), false);
    });

    test("package.json matches package.*", () => {
      assert.equal(matchFilter("package.json", "package.*"), true);
      assert.equal(matchFilter("package.json", "*.json"), true);
      assert.equal(matchFilter("package.txt", "*.json"), false);
    });

    test("package.json matches package-?.json (regression: ? matches one char, not run)", () => {
      assert.equal(matchFilter("package.json", "package-?.json"), false);
      assert.equal(matchFilter("package-X.json", "package-?.json"), true);
    });

    test("patterns are anchored at both ends", () => {
      // "abc" does NOT match "abcdef" — the glob is fully anchored,
      // as the placeholder's "filter" behaviour promises.
      assert.equal(matchFilter("abcdef", "abc"), false);
      assert.equal(matchFilter("abcdef", "def"), false);
      assert.equal(matchFilter("abc", "abc"), true);
    });
  });

  describe("regex metacharacter safety", () => {
    test("a literal-dot pattern does not match a wider name", () => {
      assert.equal(matchFilter("packageXjson", "package.json"), false);
    });
    test("a literal-open-paren pattern does not crash and does not match unrelated names", () => {
      assert.equal(matchFilter("foo(bar", "(bar"), false);
      assert.equal(matchFilter("(bar", "(bar"), true);
    });
    test("a literal-backslash pattern matches a single backslash in the name", () => {
      // POSIX has no single-backslash in basenames, but the
      // matcher is robust to it; the only requirement is that
      // it does not throw.
      assert.doesNotThrow(() => matchFilter("a\\b", "a\\\\b"));
    });
    test("a literal-+ pattern matches itself, not a different character", () => {
      assert.equal(matchFilter("a+b", "a+b"), true);
      assert.equal(matchFilter("aab", "a+b"), false);
    });
  });

  describe("empty input handling", () => {
    test("empty pattern returns false (server-side: empty q is a 400, not 'no filter')", () => {
      assert.equal(matchFilter("anything", ""), false);
      assert.equal(matchFilter("anything", "   "), false);
    });
    test("empty name with non-empty pattern returns false", () => {
      assert.equal(matchFilter("", "*"), false);
      assert.equal(matchFilter("", "?"), false);
    });
    test("non-string inputs do not throw", () => {
      assert.equal(matchFilter(null, "*"), false);
      assert.equal(matchFilter(undefined, "*"), false);
      assert.equal(matchFilter("name", null), false);
      assert.equal(matchFilter("name", undefined), false);
      assert.equal(matchFilter(42, "*"), false);
    });
  });

  describe("globToRegex — direct shape pin", () => {
    test("compiles to a case-insensitive anchored RegExp", () => {
      const re = globToRegex("package.json");
      assert.equal(re.flags.includes("i"), true);
      assert.equal(re.test("package.json"), true);
      assert.equal(re.test("PACKAGE.JSON"), true);
      assert.equal(re.test("package-json"), false);
    });
  });
});
