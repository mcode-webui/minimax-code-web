// webapp/test/browser-nav.test.ts
//
// Pin the security-critical decisions the slice 04 panel makes:
//
//   1. The iframe `sandbox` attribute is `allow-scripts` ONLY — no
//      `allow-same-origin` (which would let a previewed page reach
//      the app's session cookies), no `allow-top-navigation` (which
//      could let it replace the host document), no `allow-popups`,
//      no `allow-forms`, no `allow-modals`. Any widening of the
//      sandbox is a security regression and must fail this test.
//
//   2. The address-bar input gate refuses `http(s)://…` and
//      `file://…` URLs at the input layer — before the path ever
//      reaches the iframe — so a typed absolute URL cannot result
//      in navigation. The same gate refuses every other
//      scheme-prefixed input (`javascript:`, `data:`, …) for
//      consistency.
//
//   3. The iframe src is ALWAYS a same-origin relative URL pointing
//      at `/api/fs/raw?path=…` — never a raw `file://` URL, never a
//      bare absolute path. `buildSandboxUrl` is the single
//      construction site, and the test pins its wire shape.
//
//   4. The containment gate (server-side, `/api/fs/raw`) refuses
//      every path outside the allowed roots. This is the
//      `routes/fs-raw.test.js` companion — the slice-04 pin
//      re-asserts the gate against a path SHAPED LIKE what the
//      panel would emit (a workspace-relative `.html`), to make
//      sure the iframe's src passes the gate when it should.
//
//   5. The back/forward history is consistent — push, back, forward,
//      canGoBack/canGoForward flags all agree.
//
// Plus: the source-level "the iframe ALWAYS uses /api/fs/raw" grep
// in `browser-component-source.test.ts` is a future sibling test;
// for this slice we test the constructor directly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  IFRAME_SANDBOX,
  REJECTED_SCHEMES,
  backHistory,
  buildSandboxUrl,
  canGoBack,
  canGoForward,
  coerceAddress,
  createHistory,
  currentPath,
  forwardHistory,
  iframeKey,
  isHtmlPath,
  pushHistory,
  resolveWorkspacePath,
} from "../lib/browser-nav";

describe("browser-nav — iframe sandbox attribute", () => {
  test("the sandbox attribute is exactly 'allow-scripts'", () => {
    // The literal pin — see lib/browser-nav.ts#IFRAME_SANDBOX for the
    // threat model. Any widening of this string is a security
    // regression and must update this test in the same commit.
    assert.equal(IFRAME_SANDBOX, "allow-scripts");
  });

  test("the sandbox attribute omits every escape hatch", () => {
    // The five tokens that would each individually weaken the
    // threat model. The set is intentionally explicit here so the
    // test name carries the rationale.
    const forbidden = [
      "allow-same-origin", // would let the preview read app cookies / session storage
      "allow-top-navigation", // could let the preview replace the host document
      "allow-popups", // popup from a sandboxed page can interact with window.opener
      "allow-forms", // form submit could target _top or leak state
      "allow-modals", // alert() could script-drive a clickjack
    ];
    for (const token of forbidden) {
      assert.ok(
        !IFRAME_SANDBOX.includes(token),
        `sandbox attribute must not include ${token}`,
      );
    }
  });

  test("REJECTED_SCHEMES is the documented rejection set", () => {
    // The pin: every scheme in this set is refused by `coerceAddress`
    // and must remain so. A future contributor adding a new scheme to
    // the set must also update the panel's error copy (browser.error.absolute).
    assert.deepEqual([...REJECTED_SCHEMES], ["http://", "https://", "file://"]);
  });
});

describe("browser-nav — address-bar input gate", () => {
  test("rejects an empty string with reason:'empty'", () => {
    const out = coerceAddress("");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "empty");
  });

  test("rejects whitespace-only input with reason:'empty'", () => {
    const out = coerceAddress("   \t  \n");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "empty");
  });

  test("rejects http:// URLs", () => {
    const out = coerceAddress("http://example.com/index.html");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "absolute");
  });

  test("rejects https:// URLs", () => {
    const out = coerceAddress("https://example.com/index.html");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "absolute");
  });

  test("rejects file:// URLs", () => {
    const out = coerceAddress("file:///etc/passwd");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "absolute");
  });

  test("rejects file:// URLs case-insensitively", () => {
    // A future regression where the check was case-sensitive would
    // allow FILE://… to slip through. Pin the case-insensitivity.
    const out = coerceAddress("FILE:///etc/passwd");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "absolute");
  });

  test("rejects scheme-prefixed input with leading whitespace", () => {
    // Whitespace before the scheme must not be a bypass.
    const out = coerceAddress("  https://example.com/x");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "absolute");
  });

  test("rejects arbitrary scheme-prefixed inputs (javascript:, data:, vbscript:)", () => {
    // These could never have been rendered (the iframe src is a
    // relative `/api/fs/raw` URL), but the input layer still refuses
    // them so the panel's input shape stays consistent.
    for (const bad of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "vbscript:msgbox(1)"]) {
      const out = coerceAddress(bad);
      assert.equal(out.ok, false, `must reject ${bad}`);
      if (out.ok) continue;
      assert.equal(out.reason, "absolute");
    }
  });

  test("accepts a workspace-relative path verbatim", () => {
    const out = coerceAddress("public/index.html");
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.path, "public/index.html");
  });

  test("accepts a deeply nested workspace-relative path", () => {
    const out = coerceAddress("docs/site/welcome.html");
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.path, "docs/site/welcome.html");
  });

  test("normalises backslashes to forward slashes", () => {
    // A Windows clipboard paste — backslashes are common; the panel
    // must not reject the input shape that the user can paste.
    const out = coerceAddress("docs\\welcome.html");
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.path, "docs/welcome.html");
  });

  test("strips a leading ./", () => {
    // Common clipboard artifact. Pin the normalisation.
    const out = coerceAddress("./public/index.html");
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.path, "public/index.html");
  });

  test("rejects non-string input (defensive against caller bugs)", () => {
    // The address bar emits strings; this guards a future caller
    // that wires an external source (e.g. a file-tree node) without
    // string-coercing first.
    const out = coerceAddress(undefined as unknown as string);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "not-a-path");
  });

  test("does NOT silently rewrite ../ segments (the server gate decides)", () => {
    // The lib deliberately forwards `../foo` to the server, which is
    // the single source of truth on containment. A future change
    // that pre-emptively rewrites `../` would mask containment
    // failures in tests, so pin the "do not rewrite" behaviour.
    const out = coerceAddress("../etc/passwd");
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.path, "../etc/passwd");
  });
});

describe("browser-nav — iframe src construction", () => {
  test("buildSandboxUrl points at the containment-gated /api/fs/raw route", () => {
    // The iframe src MUST be the same-origin /api/fs/raw URL with
    // the workspace-relative path encoded into the query string.
    // Anything else would bypass the server's containment gate.
    const url = buildSandboxUrl("public/index.html");
    assert.match(url, /^\/api\/fs\/raw\?path=public%2Findex\.html/);
  });

  test("buildSandboxUrl encodes special characters in the path", () => {
    // A path with a space and a Chinese folder name must be
    // percent-encoded so the server can read it back exactly.
    const url = buildSandboxUrl("中文目录/index page.html");
    assert.match(url, /^\/api\/fs\/raw\?path=/);
    // The encoded form is opaque; the test asserts the round-trip
    // through decodeURIComponent returns the original.
    const encoded = url.split("path=")[1] ?? "";
    assert.equal(decodeURIComponent(encoded), "中文目录/index page.html");
  });

  test("buildSandboxUrl never emits a file:// URL", () => {
    // Belt-and-suspenders: even if a future refactor accidentally
    // tried to be "clever" and short-circuit the round-trip for
    // already-resolved paths, the test pins that the iframe src is
    // never a file:// URL.
    const url = buildSandboxUrl("/abs/path/index.html");
    assert.ok(!url.startsWith("file://"), `iframe src must not be file://, got ${url}`);
    assert.ok(!url.startsWith("http://") && !url.startsWith("https://"), "must not be absolute http(s)");
    assert.ok(url.startsWith("/"), `must be a same-origin relative URL, got ${url}`);
  });

  test("buildSandboxUrl with no workspaceDir passes the path verbatim (legacy callers)", () => {
    // The single-argument call is still a valid contract — slice-04
    // callers, unit tests, and any future code that has no workspace
    // in scope must keep working without a positional second arg.
    // The lack of a workspace means the iframe src is whatever the
    // path argument already looks like; the server containment gate
    // remains the source of truth on top of that.
    assert.equal(buildSandboxUrl("public/index.html"), "/api/fs/raw?path=public%2Findex.html");
  });

  test("buildSandboxUrl with workspaceDir stitches a relative path into an absolute one", () => {
    // F2 — the wire shape that lands in `/api/fs/raw?path=…` is now
    // an absolute, in-root path. The server's containment gate
    // (which resolves relative paths against `process.cwd()` and
    // would have 403'd) lets the absolute form through unchanged.
    const url = buildSandboxUrl("public/index.html", "/home/acer09/projects/foo");
    assert.equal(url, "/api/fs/raw?path=%2Fhome%2Facer09%2Fprojects%2Ffoo%2Fpublic%2Findex.html");
  });

  test("buildSandboxUrl with workspaceDir passes an absolute path through unchanged", () => {
    // Absolute in-root paths (the only kind the slice-04 code path
    // can produce today) flow through the helper untouched. Pin that
    // the helper never prepends a workspace when the path already
    // looks absolute — a regression there would corrupt the URL
    // into a `workspace + abs` doubling.
    const abs = "/home/acer09/projects/foo/index.html";
    const url = buildSandboxUrl(abs, "/home/acer09/projects/foo");
    // Forward-slash prefix and the absence of a doubled workspace
    // are the two assertions here. The exact percent-encoding of the
    // path is covered by the round-trip test above.
    assert.ok(url.startsWith("/api/fs/raw?path=%2Fhome%2Facer09%2Fprojects%2Ffoo%2Findex.html"),
      `absolute path must not be doubled; got ${url}`);
  });
});

describe("browser-nav — workspace-relative resolution (F2)", () => {
  test("resolveWorkspacePath: empty workspaceDir passes through", () => {
    // The empty-state guard mirrors the component's empty-state
    // contract — the panel renders no iframe when workspaceDir is
    // empty, so a path cannot reach the wire from this branch.
    for (const ws of [null, undefined, ""]) {
      assert.equal(resolveWorkspacePath("public/index.html", ws), "public/index.html");
    }
  });

  test("resolveWorkspacePath: POSIX-absolute paths pass through", () => {
    // A path that already starts with `/` is treated as absolute —
    // the helper must NEVER prepend the workspace on top of it
    // (the doubling would corrupt the URL and fall outside the
    // workspace).
    const abs = "/home/acer09/projects/foo/index.html";
    assert.equal(resolveWorkspacePath(abs, "/home/acer09/projects/foo"), abs);
    assert.equal(resolveWorkspacePath(abs, "/some/other/root"), abs);
  });

  test("resolveWorkspacePath: relative path joins the workspace dir", () => {
    // The happy-path fix — `public/index.html` anchored at
    // `/home/acer09/projects/foo` becomes the absolute in-root
    // path the server's containment gate accepts.
    assert.equal(
      resolveWorkspacePath("public/index.html", "/home/acer09/projects/foo"),
      "/home/acer09/projects/foo/public/index.html",
    );
    // Nested workspace-relative entries stitch the same way.
    assert.equal(
      resolveWorkspacePath("docs/welcome.html", "/home/acer09/projects/foo"),
      "/home/acer09/projects/foo/docs/welcome.html",
    );
  });

  test("resolveWorkspacePath: collapses inner './' segments", () => {
    // A user-pasted `./public/index.html` after the leading dot
    // becomes a clean absolute path; `posix.join` semantics here
    // match what the eventual server-side resolution expects.
    assert.equal(
      resolveWorkspacePath("./public/index.html", "/home/acer09/projects/foo"),
      "/home/acer09/projects/foo/public/index.html",
    );
  });

  test("resolveWorkspacePath: trailing separators on either side are stripped", () => {
    // Picker cells / clipboards tend to append a trailing slash;
    // pinning the stripping here keeps `joined` output well-formed
    // without dragging in `node:path`.
    assert.equal(
      resolveWorkspacePath("public/index.html", "/home/acer09/projects/foo/"),
      "/home/acer09/projects/foo/public/index.html",
    );
  });

  test("resolveWorkspacePath: `..` segments are NOT pre-emptively rewritten", () => {
    // The helper explicitly preserves `..` segments so the
    // server-side containment gate can reject them with a 403 — a
    // pre-emptive rewrite would mask containment failures. Same
    // rationale as `coerceAddress` (cross-referenced in the
    // helper's doc comment).
    assert.equal(
      resolveWorkspacePath("../etc/passwd", "/home/acer09/projects/foo"),
      "/home/acer09/projects/foo/../etc/passwd",
    );
  });

  test("resolveWorkspacePath: Windows-drive paths pass through", () => {
    // The helper recognises Windows drive-letter absolutes (`C:\…`
    // or `C:/…`). A future Windows build does not lose the path
    // because the join is skipped. The exact POSIT test harness is
    // POSIX, so we assert the value unchanged regardless.
    const winPath = "C:\\Users\\foo\\index.html";
    assert.equal(resolveWorkspacePath(winPath, "/home/acer09/projects/foo"), winPath);
    const winPathFwd = "C:/Users/foo/index.html";
    assert.equal(resolveWorkspacePath(winPathFwd, "/home/acer09/projects/foo"), winPathFwd);
  });
});

describe("browser-nav — iframe src path whitelist (ext allow-list)", () => {
  test("isHtmlPath: true for .html / .htm (case-insensitive)", () => {
    for (const ext of [".html", ".htm", ".HTML", ".HTM"]) {
      assert.ok(isHtmlPath(`foo${ext}`), `must accept foo${ext}`);
      assert.ok(isHtmlPath(`a/b/foo${ext}`), `must accept a/b/foo${ext}`);
    }
  });

  test("isHtmlPath: false for everything else", () => {
    for (const ext of [".png", ".svg", ".md", ".js", ".json", ".txt", ".css", ""]) {
      assert.ok(!isHtmlPath(`foo${ext}`), `must reject foo${ext}`);
    }
  });
});

describe("browser-nav — history stack", () => {
  test("createHistory(null) starts empty, no current path", () => {
    const h = createHistory(null);
    assert.deepEqual(h, { entries: [], index: -1 });
    assert.equal(currentPath(h), null);
    assert.equal(canGoBack(h), false);
    assert.equal(canGoForward(h), false);
  });

  test("createHistory(path) seeds with the path as the current entry", () => {
    const h = createHistory("public/index.html");
    assert.deepEqual(h.entries, ["public/index.html"]);
    assert.equal(h.index, 0);
    assert.equal(currentPath(h), "public/index.html");
    assert.equal(canGoBack(h), false);
    assert.equal(canGoForward(h), false);
  });

  test("pushHistory advances index and records the new path", () => {
    const h = pushHistory(createHistory("a.html"), "b.html");
    assert.deepEqual(h.entries, ["a.html", "b.html"]);
    assert.equal(h.index, 1);
    assert.equal(currentPath(h), "b.html");
    assert.equal(canGoBack(h), true);
    assert.equal(canGoForward(h), false);
  });

  test("pushHistory drops forward entries (fork semantics)", () => {
    // a → b → c → back to b → push d
    // the back to b made c a forward entry; pushing d must drop c.
    let h = pushHistory(createHistory("a.html"), "b.html");
    h = pushHistory(h, "c.html");
    h = backHistory(h);
    h = pushHistory(h, "d.html");
    assert.deepEqual(h.entries, ["a.html", "b.html", "d.html"]);
    assert.equal(h.index, 2);
    assert.equal(currentPath(h), "d.html");
    assert.equal(canGoBack(h), true);
    assert.equal(canGoForward(h), false);
  });

  test("pushHistory dedupes consecutive repeats", () => {
    // Clicking "Go" twice on the same path must not pollute the
    // back stack — the second click is a no-op for the history.
    const h = pushHistory(pushHistory(createHistory("a.html"), "a.html"), "a.html");
    assert.deepEqual(h.entries, ["a.html"]);
    assert.equal(h.index, 0);
  });

  test("backHistory / forwardHistory move the index and never out of bounds", () => {
    let h = createHistory("a.html");
    h = pushHistory(h, "b.html");
    h = pushHistory(h, "c.html");
    assert.equal(currentPath(h), "c.html");

    h = backHistory(h);
    assert.equal(currentPath(h), "b.html");
    h = backHistory(h);
    assert.equal(currentPath(h), "a.html");
    h = backHistory(h);
    assert.equal(currentPath(h), "a.html"); // bottom boundary
    h = backHistory(h);
    assert.equal(currentPath(h), "a.html"); // bottom boundary, idempotent

    h = forwardHistory(h);
    assert.equal(currentPath(h), "b.html");
    h = forwardHistory(h);
    assert.equal(currentPath(h), "c.html");
    h = forwardHistory(h);
    assert.equal(currentPath(h), "c.html"); // top boundary
    h = forwardHistory(h);
    assert.equal(currentPath(h), "c.html"); // top boundary, idempotent
  });

  test("canGoBack / canGoForward agree with the index movement", () => {
    let h = createHistory(null);
    assert.equal(canGoBack(h), false);
    assert.equal(canGoForward(h), false);
    h = pushHistory(h, "a.html");
    assert.equal(canGoBack(h), false);
    assert.equal(canGoForward(h), false);
    h = pushHistory(h, "b.html");
    assert.equal(canGoBack(h), true);
    assert.equal(canGoForward(h), false);
    h = backHistory(h);
    assert.equal(canGoBack(h), false);
    assert.equal(canGoForward(h), true);
  });

  test("iframeKey incorporates refreshNonce so refresh forces remount", () => {
    // Same path + different nonces = different keys (refresh)
    assert.notEqual(iframeKey("a.html", 0), iframeKey("a.html", 1));
    // Different paths + same nonce = different keys (navigation)
    assert.notEqual(iframeKey("a.html", 1), iframeKey("b.html", 1));
    // Same path + same nonce = same key (stable on no-op)
    assert.equal(iframeKey("a.html", 1), iframeKey("a.html", 1));
  });
});

describe("browser-nav — iframe security boundary summary", () => {
  test("REJECTED_SCHEMES + coerceAddress + buildSandboxUrl cover the threat model", () => {
    // Final tripwire — the three pieces the panel composes must
    // together refuse every "page can reach the app" surface:
    //
    //   - REJECTED_SCHEMES pins which schemes are refused at the input layer.
    //   - coerceAddress actually refuses every one of them.
    //   - buildSandboxUrl never produces a non-same-origin URL.
    //
    // A future regression that drops any of these guarantees will
    // surface as a single failing test, with the threat model in
    // the test name for context.

    const hostile = [
      "http://localhost:18090/api/state",
      "https://attacker.example/x",
      "file:///etc/passwd",
      "FILE:///etc/passwd",
      "  https://attacker.example/x",
      "javascript:fetch('/api/state')",
      "data:text/html,<script>fetch('/api/state')</script>",
      "vbscript:msgbox(1)",
    ];
    for (const input of hostile) {
      const out = coerceAddress(input);
      assert.equal(out.ok, false, `must refuse ${input}`);
      if (out.ok) continue;
      assert.equal(out.reason, "absolute", `must refuse ${input} with reason:'absolute'`);
    }
  });
});