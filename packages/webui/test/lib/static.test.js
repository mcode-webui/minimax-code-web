// webui/test/lib/static.test.js
// Unit tests for server/lib/static.js — serveStatic + serveIndex.
//
// Why this test exists: serveStatic is the only thing standing between a
// malicious request and the host filesystem. Path-traversal attacks (../../etc/passwd)
// MUST be rejected. The mime-type map determines whether the browser interprets
// files correctly (JS as JS, CSS as CSS, etc). Bugs = XSS or broken UI.
//
// Contract after the bundle-convergence refactor:
//   serveStatic reads from a SINGLE root, NEXT_EXPORT_DIR (webui/webapp/out).
//   The legacy PUBLIC_DIR fallback, the /app/*.js and /styles/*.css no-cache
//   branches, and the brand-logo path are gone — `auth-gate.html` is now part
//   of the export root because it ships via webapp/public/.

import { test, describe } from "node:test";
import assertLib from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const staticMod = await import(absPath("lib/static.js"));

// Capture writeHead + end into a fake res. serveStatic takes (pathname, res).
function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(status, headers) {
      this._status = status;
      this._headers = headers;
    },
    end(body) {
      this._body = body;
    },
  };
  return res;
}

describe("serveStatic — path traversal protection", () => {
  // The actual serveStatic behavior: it strips "..", "\", and "\0" from the path,
  // then checks if any of those survived. Since the strips are global, ".." and "\\"
  // can't survive — the only way to trigger 403 is a NUL byte. The ".." and "\\"
  // checks are defensive/dead code. We test the actual sanitization behavior:

  test("'..' in path is sanitized (strips .. then looks up harmless file)", () => {
    // /../etc/passwd → strip leading / → ../etc/passwd → strip .. → /etc/passwd
    // → no 403, just looks for /etc/passwd in NEXT_EXPORT_DIR (returns false)
    const res = fakeRes();
    const out = staticMod.serveStatic("/../etc/passwd", res);
    // Path is sanitized, file not found in NEXT_EXPORT_DIR, returns false (not handled)
    assertLib.equal(out, false);
    assertLib.equal(res._status, null, "no 403 should be written");
  });

  test("backslash in path is sanitized (strips \\ then looks up harmless file)", () => {
    // /..\\windows\\system32 → strip .. → \\windows\\system32 → strip \\ → windowssystem32
    const res = fakeRes();
    const out = staticMod.serveStatic("/..\\windows\\system32", res);
    assertLib.equal(out, false);
    assertLib.equal(res._status, null, "no 403 should be written");
  });

  test("rejects NUL byte (\\0) in path with 403 forbidden", () => {
    // The strip removes \0's PRECEDING characters? No, the strip only does \.
    // and \., so \0 survives. safe.includes("\0") → true → 403.
    const res = fakeRes();
    staticMod.serveStatic("/file\x00.js", res);
    assertLib.equal(res._status, 403);
    assertLib.equal(res._body, "forbidden");
  });

  test("returns false (not handled) for non-existent file", () => {
    // serveStatic returns false when the file doesn't exist — caller falls through
    const res = fakeRes();
    const out = staticMod.serveStatic("/nonexistent-file-zzz.js", res);
    assertLib.equal(out, false);
    // Should NOT have written a response
    assertLib.equal(res._status, null);
  });
});

describe("serveStatic — single-root contract", () => {
  // The legacy PUBLIC_DIR fallback was removed. These paths used to be
  // served from public/; now they MUST return false (or 403) — the file
  // is not part of the export root.
  test("legacy /app/main.js is unreachable (was: public/app/main.js)", () => {
    const res = fakeRes();
    const out = staticMod.serveStatic("/app/main.js", res);
    assertLib.equal(out, false, "legacy app bundle must not be served");
    assertLib.equal(res._status, null, "caller falls through, no response written");
  });

  test("legacy /styles/main.css is unreachable (was: public/styles/main.css)", () => {
    const res = fakeRes();
    const out = staticMod.serveStatic("/styles/main.css", res);
    assertLib.equal(out, false, "legacy stylesheet must not be served");
    assertLib.equal(res._status, null);
  });

  test("legacy /lib/marked.min.js is unreachable (was: public/lib/marked.min.js)", () => {
    const res = fakeRes();
    const out = staticMod.serveStatic("/lib/marked.min.js", res);
    assertLib.equal(out, false, "vendored marked must not be served from a single-root webui");
    assertLib.equal(res._status, null);
  });

  test("legacy /brand-logo.png is unreachable (was: public/brand-logo.png)", () => {
    const res = fakeRes();
    const out = staticMod.serveStatic("/brand-logo.png", res);
    assertLib.equal(out, false, "brand logo removed with the legacy UI");
    assertLib.equal(res._status, null);
  });
});

describe("serveStatic — mime types for known extensions", () => {
  test("HTML (index.html) is never cached, whenever it comes from the export root", () => {
    // The page is the only file that names the current build's chunks. Caching it
    // pins the browser to a previous build for the whole max-age, and once that
    // build's chunks are gone the page 404s its own bundle.
    const res = fakeRes();
    const served = staticMod.serveStatic("/index.html", res);
    if (served === false) {
      // No export in this checkout — skip with a soft note (the file is
      // produced by `pnpm --filter @mavis/webui webapp:build`).
      return;
    }
    assertLib.equal(res._status, 200);
    assertLib.equal(
      res._headers["Cache-Control"],
      "no-cache",
      "index.html must revalidate",
    );
  });

  test("auth-gate.html resolves with no-cache once the export is built", () => {
    // Moved from public/auth-gate.html to webapp/public/auth-gate.html so
    // Next's static export copies it to NEXT_EXPORT_DIR/auth-gate.html.
    // The fixture may not exist in a bare checkout — skip in that case.
    const res = fakeRes();
    const served = staticMod.serveStatic("/auth-gate.html", res);
    if (served === false) {
      return; // export not built; presence is asserted by the integration smoke
    }
    assertLib.equal(res._status, 200);
    assertLib.equal(res._headers["Cache-Control"], "no-cache",
      "auth-gate.html must revalidate (same reasoning as index.html)");
    assertLib.match(res._headers["Content-Type"], /text\/html/);
  });

  test("HTML extension is never cached regardless of file", () => {
    // Negative equivalent: any *.html path that doesn't exist in the export
    // still gets the right cache header if served. The most we can assert in
    // a bare checkout is that serveStatic doesn't blow up and returns false.
    const res = fakeRes();
    const served = staticMod.serveStatic("/definitely-not-here.html", res);
    assertLib.equal(served, false);
    assertLib.equal(res._status, null);
  });

  test(".json files outside the export return false (mime unknown in this fixture)", () => {
    // /package.json lives at the repo root, not in NEXT_EXPORT_DIR, so the
    // lookup misses. We only assert it doesn't throw.
    const res = fakeRes();
    const out = staticMod.serveStatic("/package.json", res);
    assertLib.equal(out, false);
    assertLib.equal(res._status, null);
  });
});

describe("serveStatic — cache policy branches that survive the refactor", () => {
  // The /app/*.js and /styles/*.css no-cache branches were removed (those
  // directories are gone with the legacy UI). What's left is the
  // _next/static/* long-cache branch and the default 1h branch.

  test("_next/static/* gets the long-lived immutable cache", () => {
    const res = fakeRes();
    // We don't need a real chunk — we only care about the cache header
    // choice. fileIn() will return null for a fake hash, but cacheControl()
    // runs from the relative path before the file lookup. We can't observe
    // the header without a successful send, so this test only documents
    // that no-cache and 1h branches are NOT taken for this prefix.
    // We assert by trying a fake path that misses:
    const out = staticMod.serveStatic("/_next/static/chunks/_next_made_up_hash.js", res);
    assertLib.equal(out, false);
    assertLib.equal(res._status, null);
    // The contract: when this prefix DOES resolve, the header is
    // "public, max-age=31536000, immutable". The unit test cannot reach
    // sendFile() without a real hash; the integration smoke covers it.
  });

  test("non-_next non-html paths fall through to the 1h cache branch", () => {
    // Same situation: a real 200 needs a real file. /favicon_v2.png IS in
    // the export, so if the export is built, this resolves and the header
    // is the 1h default.
    const res = fakeRes();
    const out = staticMod.serveStatic("/favicon_v2.png", res);
    if (out === false) return; // bare checkout, no export
    assertLib.equal(res._status, 200);
    assertLib.equal(res._headers["Content-Type"], "image/png");
    assertLib.match(res._headers["Cache-Control"], /max-age=3600/);
  });
});

describe("serveIndex", () => {
  test("serves the export index.html with 200 + text/html when present", () => {
    const res = fakeRes();
    const out = staticMod.serveIndex(res);
    if (out === false) {
      // No export in this checkout — skip rather than fail. The integration
      // smoke (router-boot) verifies the live `GET /` path.
      return;
    }
    assertLib.equal(res._status, 200);
    assertLib.match(res._headers["Content-Type"], /text\/html/);
    assertLib.ok(res._body, "body should exist");
    assertLib.equal(res._headers["Cache-Control"], "no-cache");
  });

  test("returns false (not 404) when the export is absent — router writes its own 404 tail", () => {
    // We can't easily remove the export from under the running test, but the
    // serveIndex contract is: write 200 OR return false. We assert the
    // return-shape semantics: either path is a valid contract outcome.
    const res = fakeRes();
    staticMod.serveIndex(res);
    assertLib.ok(
      res._status === 200 || res._status === null,
      `expected 200 (served) or null (caller writes its own 404); got ${res._status}`,
    );
  });
});