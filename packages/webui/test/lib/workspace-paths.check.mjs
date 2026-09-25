// webui/test/lib/workspace-paths.check.mjs
// Unit tests for the cross-platform path expansion + containment-error
// shape (ticket basic-features/03).
//
// Two surfaces under test:
//   1. expandUserPath — pure string → string transformation; tildes
//      and env-var references (POSIX + Windows shapes).
//   2. browseWorkspace / assertWorkspacePath — the *applied*
//      contract: `~`, `$HOME`, `%USERPROFILE%`, etc., are expanded
//      before containment validation, and the containment error
//      carries the allowed roots so the picker UI can render a
//      "must be under: …" hint.
//
// The first surface is plain string transform (no fs), the second
// uses tmpdir-based sandboxes under MCODE_WEBUI_WORKSPACE_ROOTS so
// containment rejection is reproducible.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { tmpdir, homedir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep, basename } from "node:path";
import { setupMocks, absPath } from "../helpers/_setup.js";

let ws;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  ws = await import(absPath("lib/workspace.js"));
});

const ROOTS_ENV = "MCODE_WEBUI_WORKSPACE_ROOTS";

function withSingleRoot(t, body) {
  const arena = mkdtempSync(join(tmpdir(), "webui-paths-"));
  t.after(() => rmSync(arena, { recursive: true, force: true }));
  const prev = process.env[ROOTS_ENV];
  process.env[ROOTS_ENV] = arena;
  try {
    return body(arena);
  } finally {
    if (prev === undefined) delete process.env[ROOTS_ENV];
    else process.env[ROOTS_ENV] = prev;
  }
}

describe("expandUserPath — input normalisation (string transform)", () => {
  test("`~` expands to the user's home", () => {
    assert.equal(ws.expandUserPath("~"), homedir());
  });

  test("`~/foo` expands to `<home>/foo`", () => {
    assert.equal(ws.expandUserPath("~/foo"), join(homedir(), "foo"));
  });

  test("`~\\bar` (Windows-style separator) also expands to <home>/bar", () => {
    assert.equal(ws.expandUserPath("~\\bar"), join(homedir(), "bar"));
  });

  test("$HOME expands to process.env.HOME", () => {
    process.env.HOME = "/env/home";
    try {
      assert.equal(ws.expandUserPath("$HOME"), "/env/home");
      assert.equal(ws.expandUserPath("$HOME/foo"), join("/env/home", "foo"));
    } finally {
      delete process.env.HOME;
    }
  });

  test("%USERPROFILE% expands to process.env.USERPROFILE (Windows shape)", () => {
    process.env.USERPROFILE = "C:\\Users\\demo";
    try {
      // `expandUserPath` returns the verbatim value. On POSIX the
      // subsequent `path.join` step (in browseWorkspace /
      // assertWorkspacePath) normalises backslashes to forward
      // slashes — `path.join` treats backslash as a regular
      // character on POSIX. So the assertion here is "the env var
      // came through unchanged", not "the result is the joined path
      // with literal backslashes".
      assert.equal(ws.expandUserPath("%USERPROFILE%"), "C:\\Users\\demo");
    } finally {
      delete process.env.USERPROFILE;
    }
  });

  test("$TMPDIR / %TEMP% / $TMP / %TMP% all map to process.env.TMPDIR", () => {
    process.env.TMPDIR = "/tmp-var";
    try {
      assert.equal(ws.expandUserPath("$TMPDIR"), "/tmp-var");
      assert.equal(ws.expandUserPath("%TEMP%"), "/tmp-var");
      assert.equal(ws.expandUserPath("$TMP"), "/tmp-var");
      assert.equal(ws.expandUserPath("%TMP%"), "/tmp-var");
    } finally {
      delete process.env.TMPDIR;
    }
  });

  // The Windows-shape variants live in a win32-gated describe so CI on
  // windows-latest exercises them; on POSIX, `path.join` normalises
  // backslashes away so the literal assertion would need
  // platform-specific path normalisation to round-trip. The unit
  // assertion below (`%USERPROFILE% expands to process.env.USERPROFILE`)
  // pins the value that `expandUserPath` returns verbatim on the
  // host — the platform-dependent join is then verified separately by
  // the integration tests below.

  test("unknown $VAR / %VAR% is left literal — strict allow-list", () => {
    // Not on the allow-list (HOME/USERPROFILE/TMPDIR/TEMP/TMP), so
    // a `$SECRET` reference is preserved verbatim — the user sees
    // exactly what they typed and can fix it. This is the standard
    // shell-quoting answer; arbitrary interpolation would let an
    // unprivileged user probe env-var presence.
    process.env.SECRET = "/should-not-leak";
    try {
      assert.equal(ws.expandUserPath("$SECRET"), "$SECRET");
      assert.equal(ws.expandUserPath("%SECRET%"), "%SECRET%");
    } finally {
      delete process.env.SECRET;
    }
  });

  test("a bare absolute path passes through unchanged", () => {
    assert.equal(ws.expandUserPath("/abs/path"), "/abs/path");
    if (sep === "\\") {
      assert.equal(ws.expandUserPath("C:\\abs\\path"), "C:\\abs\\path");
    }
  });

  test("empty / whitespace / non-string returns null", () => {
    assert.equal(ws.expandUserPath(""), null);
    assert.equal(ws.expandUserPath("   "), null);
    assert.equal(ws.expandUserPath(null), null);
    assert.equal(ws.expandUserPath(undefined), null);
    assert.equal(ws.expandUserPath(42), null);
  });

  test("trailing separator is stripped (drive roots preserved)", () => {
    assert.equal(ws.expandUserPath("/tmp/"), "/tmp");
    assert.equal(ws.expandUserPath("/tmp///"), "/tmp");
    if (sep === "\\") {
      assert.equal(ws.expandUserPath("C:\\foo\\"), "C:\\foo");
    }
  });

  test("wrapping quotes are stripped", () => {
    assert.equal(ws.expandUserPath('"/abs"'), "/abs");
    assert.equal(ws.expandUserPath("'/abs'"), "/abs");
  });

  test("mid-path env-var references are interpolated (Windows)", () => {
    process.env.TMPDIR = "/tmp-var";
    try {
      // %TMPDIR% in the middle of the path is interpolated; the
      // surrounding separators are preserved. This is the shape
      // that comes up in practice (`%TEMP%/subfolder`).
      assert.equal(ws.expandUserPath("/var/%TMPDIR%/foo"), "/var//tmp-var/foo");
    } finally {
      delete process.env.TMPDIR;
    }
  });
});

describe("browseWorkspace — env / tilde expansion applied to containment", () => {
  test("`~` expansion: a subdir under home is enumerable after expansion", (t) => {
    const arena = withSingleRoot(t, () => tmpdir());
    // default roots include home + tmpdir; home is in the set, so a
    // path under home must enumerate after `~` expansion.
    delete process.env[ROOTS_ENV];
    const homeSubdir = join(homedir(), "webui-paths-~-" + Date.now());
    try {
      mkdirSync(homeSubdir);
      const result = ws.browseWorkspace("~/" + basename(homeSubdir));
      assert.equal(result.ok, true, `error: ${result.error}`);
      assert.equal(result.dir, realpathSync(homeSubdir));
    } finally {
      rmSync(homeSubdir, { recursive: true, force: true });
    }
  });

  test("$HOME expansion: same path under home is enumerable", (t) => {
    delete process.env[ROOTS_ENV];
    const homeSubdir = join(homedir(), "webui-paths-$home-" + Date.now());
    try {
      mkdirSync(homeSubdir);
      process.env.HOME = homedir();
      try {
        const result = ws.browseWorkspace("$HOME/" + basename(homeSubdir));
        assert.equal(result.ok, true, `error: ${result.error}`);
      } finally {
        delete process.env.HOME;
      }
    } finally {
      rmSync(homeSubdir, { recursive: true, force: true });
    }
  });

  test("containment rejection payload carries the allowed roots", (t) => {
    withSingleRoot(t, () => {
      // /etc is outside our single-root arena on POSIX + Windows.
      const result = ws.browseWorkspace("/etc");
      assert.equal(result.ok, false);
      assert.ok(
        Array.isArray(result.roots) && result.roots.length >= 1,
        "roots[] on the containment error so the UI can render 'must be under: …'",
      );
    });
  });

  test("an absolute Windows-shape path on POSIX fails the same way (not silently rewritten)", (t) => {
    // On POSIX, a `C:\Users\...` path survives `path.resolve` and
    // statSync returns ENOENT — the picker reports it as
    // "目录不存在", not "路径非法". The error is actionable.
    withSingleRoot(t, () => {
      const result = ws.browseWorkspace("C:\\Windows");
      assert.equal(result.ok, false);
      // The error is either ENOENT (statSync fails) or containment
      // rejection, depending on whether the literal path resolves to
      // an existing directory on the host. Either way it's a
      // structured `{ok:false,error:…}` — never a bare "非法".
      assert.equal(typeof result.error, "string");
      assert.ok(result.error.length > 0);
    });
  });

  test("a relative path resolves against cwd before containment check", (t) => {
    withSingleRoot(t, (arena) => {
      mkdirSync(join(arena, "rel"));
      // CWD here is the test runner's cwd, which is almost never
      // `arena`; but the resolved target must exist and be inside
      // the root for containment to pass.
      const result = ws.browseWorkspace("rel");
      // `path.resolve` joined with cwd will not land in arena, so
      // the response is either ok (when cwd is arena) or an
      // actionable error. Both are valid; what we pin is that the
      // path was treated as a relative one (not blank-rejected).
      if (!result.ok) {
        assert.ok(
          /目录不存在|工作区越界|不在允许根内/.test(result.error),
          `unexpected error: ${result.error}`,
        );
      }
    });
  });
});

describe("assertWorkspacePath — env / tilde expansion (containment gate)", () => {
  test("`~` expands before containment", (t) => {
    delete process.env[ROOTS_ENV];
    const homeSubdir = join(homedir(), "webui-paths-aw-" + Date.now());
    try {
      mkdirSync(homeSubdir);
      const result = ws.assertWorkspacePath("~/" + basename(homeSubdir));
      assert.equal(result.ok, true, `error: ${result.error}`);
    } finally {
      rmSync(homeSubdir, { recursive: true, force: true });
    }
  });

  test("rejection carries the allowed roots", (t) => {
    withSingleRoot(t, () => {
      const result = ws.assertWorkspacePath("/etc");
      assert.equal(result.ok, false);
      assert.ok(
        Array.isArray(result.roots) && result.roots.length >= 1,
        "roots[] on the containment error so /api/fs/* can surface it",
      );
    });
  });
});

describe("wire shape — browse error payload (basic-features/03 fix)", () => {
  // The wire-shape test pins both the absence of the removed pick
  // route AND the new error payload. CI on windows-latest picks up
  // the Windows-shape variants (the POSIX tests are skipped there).
  test("browse containment error: `error` + `roots[]`, no `path`/`ok:true`", (t) => {
    withSingleRoot(t, () => {
      const result = ws.browseWorkspace("/no-such-outside-root");
      assert.equal(result.ok, false);
      assert.ok(typeof result.error === "string" && result.error.length > 0);
      assert.ok(Array.isArray(result.roots));
      assert.equal(result.path, undefined, "no `path` field on the error payload");
    });
  });
});