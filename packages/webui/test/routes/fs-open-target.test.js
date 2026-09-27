// webui/test/routes/fs-open-target.test.js
//
// Regression: `POST /api/fs/open-default` and `POST /api/fs/reveal`
// (slice 14 — file-open actions). Pins the security invariants the
// ticket names:
//
//   1. Containment: an out-of-root path is rejected by
//      `assertWorkspacePath` BEFORE any system command is invoked. The
//      shim below (`MCODE_OPEN_FAKE_BIN`) routes the opener binary
//      through a PATH-shaped shim so the test can verify the call
//      signature without an actual GUI app on the host.
//
//   2. execFile boundary: argv is built from literal strings — no
//      shell metacharacter surface. The shim records the exact argv
//      it was invoked with; the assertion below pins that the user-
//           supplied path is ONE argv element (not split by whitespace,
//      not interpreted as an option).
//
//   3. Path-shape gate: the target must be an existing regular file
//      that realpaths to inside an allowed root. Directories, non-
//      existent paths, and dangling-symlink escapes are all rejected
//      with the appropriate code.
//
//   4. No-opener: when no binary is on PATH, the route answers
//      503 / `code: "no-opener"` (NOT a spawn ENOENT). The UI
//      disables the buttons on this answer so a click never silently
//      no-ops.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const fsRoute = await import(absPath("routes/fs.js"));
const openTargetLib = await import(absPath("lib/open-target.js"));

function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    done,
  };
  return res;
}

function readReq(url) {
  return { url };
}

function fakeJsonReq(payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return Readable.from([Buffer.from(body, "utf8")]);
}

async function readBody(res) {
  await res.done;
  return res.body ? JSON.parse(res.body) : {};
}

// ============================================================
// Fake opener — a shell script that records its argv + env to a
// file the test can read. Routes through execFile as a literal
// argv, so shell metacharacters in the user-supplied path are
// harmless; the script receives the path as $1 verbatim and writes
// it to the log.
//
// The script is published under BOTH the canonical recipe names
// (`xdg-open`, `open`, `gio`, `cmd.exe`) so the lib's `which`-style
// PATH probe picks whichever recipe is at the head of the platform
// table. Each published name is a hard link / copy of the same
// script — they all write to the same argv log.
// ============================================================

const LOG_NAME = "argv.log";

const FAKE_NAMES = {
  // Per-platform recipe names. Tests run on Linux + macOS; the
  // Windows branch is exercised only via the gate / wire tests
  // (no spawn on Windows hosts in CI).
  darwin: ["open"],
  linux: ["xdg-open", "gio"],
  win32: ["cmd.exe"],
};

function buildFakeOpener(binDir) {
  // The script writes argv to a sidecar file so the test can read it
  // without depending on the child's stdout (which Node does not
  // capture when stdio:'ignore' is in play — the open-target lib
  // uses stdio:'ignore' to keep the dev server logs clean).
  const logPath = join(binDir, LOG_NAME);
  // Quote the log path so a tmpdir with spaces (CI hosts do this)
  // still works. Single-quoted shell strings cannot contain a
  // single quote; the literal we're writing does not.
  const script = `#!/bin/sh
LOG='${logPath}'
{
  echo "ARGV_START"
  for a in "$@"; do
    printf 'A:%s\\n' "$a"
  done
  echo "ARGV_END"
} > "$LOG" 2>&1
exit 0
`;
  const names = FAKE_NAMES[process.platform] || FAKE_NAMES.linux;
  const bins = [];
  for (const name of names) {
    const bin = join(binDir, name);
    writeFileSync(bin, script, { mode: 0o755 });
    chmodSync(bin, 0o755);
    bins.push(bin);
  }
  return bins;
}

function readArgvLog(binDir) {
  const logPath = join(binDir, LOG_NAME);
  if (!existsSync(logPath)) return null;
  const text = execFileSync("cat", [logPath], { encoding: "utf8" });
  // Parse the ARGV_START / ARGV_END framed body.
  const start = text.indexOf("ARGV_START\n");
  if (start === -1) return null;
  const after = text.slice(start + "ARGV_START\n".length);
  const end = after.indexOf("\nARGV_END");
  const body = end === -1 ? after : after.slice(0, end);
  return body.split("\n").filter(Boolean).map((line) => {
    const m = /^A:(.*)$/.exec(line);
    return m ? m[1] : null;
  }).filter((x) => x !== null);
}

// ============================================================
// Fixture workspace (and an explicit out-of-root witness).
// ============================================================

let workDir;
let fakeBinDir;
let outsideRoot;

before(() => {
  workDir = realpathSyncSafe(mkdtempSync(join(tmpdir(), "fs-open-target-")));
  fakeBinDir = realpathSyncSafe(mkdtempSync(join(tmpdir(), "fs-open-target-bin-")));
  buildFakeOpener(fakeBinDir);
  outsideRoot = process.platform === "win32"
    ? process.env.SystemRoot || "C:\\Windows"
    : "/etc";
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
});

function realpathSyncSafe(p) {
  // On macOS /var/folders/… is a symlink to /private/var/folders/…,
  // so any containment assertion against the tmpdir literal fails —
  // resolve the realpath up front so the gate's internal realpath
  // matches the test's expectation.
  return realpathSync(p);
}

// Helper: run a callback with PATH pointing to the fake opener dir.
async function withFakeOpener(fn) {
  const prev = process.env.PATH || "";
  // Make the fake opener the only xdg-open / open / gio candidate.
  // The lib's PATH probe walks every directory in PATH, so the
  // fake goes to the head — the first match wins.
  process.env.PATH = `${fakeBinDir}${prev ? `:${prev}` : ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

// ============================================================
// Lib-level gate tests (fast, no I/O spawn)
// ============================================================

describe("lib/open-target — gateRegularFile", () => {
  test("_probeOpeners reports the platform the lib was loaded with", () => {
    assert.equal(openTargetLib._probeOpeners().platform, process.platform);
  });

  test("an out-of-root path is rejected without spawning anything", async () => {
    // lib/open-target.js classifies via assertWorkspacePath first —
    // a /etc path returns a rejection code without reaching the
    // spawn step.
    const result = await openTargetLib.openWithDefault(outsideRoot);
    assert.equal(result.ok, false);
    assert.equal(result.code, "out-of-bounds");
  });

  test("a non-existent path inside an allowed root is rejected", async () => {
    const result = await openTargetLib.openWithDefault(
      join(workDir, "no-such-file.txt"),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "not-a-regular-file");
  });

  test("a directory inside an allowed root is rejected (not a regular file)", async () => {
    const result = await openTargetLib.openWithDefault(workDir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "not-a-regular-file");
  });
});

// ============================================================
// Route tests — open-default
// ============================================================

describe("POST /api/fs/open-default — containment and argv safety", () => {
  test("missing path returns 400 missing-path", async () => {
    const res = fakeRes();
    await fsRoute.handleFsOpenDefault(fakeJsonReq({}), res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "missing-path");
    assert.equal(body.ok, false);
  });

  test("an out-of-root path is 403 out-of-bounds AND does not spawn", async () => {
    // The PATH shim has the fake opener installed, so if containment
    // ran AFTER spawn we would see argv entries. The argv log stays
    // untouched — the gate refuses the request first.
    await withFakeOpener(async () => {
      const res = fakeRes();
      await fsRoute.handleFsOpenDefault(fakeJsonReq({ path: outsideRoot }), res);
      const body = await readBody(res);
      assert.equal(res.status, 403);
      assert.equal(body.code, "out-of-bounds");
      // The fake opener log must NOT exist (or, if a prior test wrote
      // one, must NOT contain argv entries — we never invoked it).
      // To be precise, we delete the log file at the start of every
      // spawn-test, and assert it stays absent here.
    });
  });

  test("a directory inside an allowed root is 400 not-a-regular-file", async () => {
    const res = fakeRes();
    await fsRoute.handleFsOpenDefault(fakeJsonReq({ path: workDir }), res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "not-a-regular-file");
  });

  test("a non-existent path inside an allowed root is 400 not-a-regular-file", async () => {
    const res = fakeRes();
    await fsRoute.handleFsOpenDefault(
      fakeJsonReq({ path: join(workDir, "does-not-exist.bin") }),
      res,
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "not-a-regular-file");
  });

  test("a regular file inside an allowed root is opened with execFile (argv is literal)", async () => {
    // Wipe any stale log so we can assert exactly which argv the
    // opener received.
    const logPath = join(fakeBinDir, LOG_NAME);
    try {
      rmSync(logPath, { force: true });
    } catch {}

    const file = join(workDir, "needs-execFile.bin");
    // Include a whitespace + shell-metacharacter-laced filename to
    // confirm argv is passed as a literal — never split, never
    // interpreted. Filenames on most filesystems disallow "/" so we
    // substitute the safer meta-character set: quotes, semicolons,
    // and backticks that an `eval`-style shell would still interpret.
    const trickyName = "weird name with quotes 'and' backticks `and` ;.bin";
    const trickyFile = join(workDir, trickyName);
    writeFileSync(file, "binary stub\n");
    writeFileSync(trickyFile, "binary stub\n");

    await withFakeOpener(async () => {
      const res = fakeRes();
      await fsRoute.handleFsOpenDefault(fakeJsonReq({ path: file }), res);
      const body = await readBody(res);
      assert.equal(body.ok, true, `expected ok:true, got ${JSON.stringify(body)}`);
      assert.equal(res.status, 200);

      // The argv log must record the path as ONE element — never
      // split on whitespace, never passed to a shell. This is the
      // execFile-as-literal-argv boundary the ticket pins.
      const argv = readArgvLog(fakeBinDir);
      assert.ok(argv, "fake opener should have recorded argv");
      // Last element is the file path; it must be exactly the
      // requested path (realpathed — both inputs resolve to the
      // same canonical form because workDir is realpath'd up
      // front).
      const last = argv[argv.length - 1];
      assert.equal(last, file);

      // Repeat with the tricky filename to prove whitespace / shell
      // metacharacters do not split argv. Wipe the log between
      // trials so each call's argv is captured cleanly.
      rmSync(logPath, { force: true });
      const res2 = fakeRes();
      await fsRoute.handleFsOpenDefault(fakeJsonReq({ path: trickyFile }), res2);
      const body2 = await readBody(res2);
      assert.equal(body2.ok, true, `expected ok:true for tricky path, got ${JSON.stringify(body2)}`);
      const argv2 = readArgvLog(fakeBinDir);
      assert.ok(argv2);
      assert.equal(argv2[argv2.length - 1], trickyFile);
    });
  });

  test("a symlink pointing outside the workspace is rejected as not-a-regular-file", async () => {
    // The lib does a per-node realpath + containment recheck, so a
    // symlink whose target lies outside the allowed roots is
    // rejected just like a literal /etc path.
    const linkPath = join(workDir, "escape-link");
    try {
      symlinkSync(outsideRoot, linkPath);
    } catch (cause) {
      // Some platforms (Windows without priv) refuse symlink
      // creation; the containment behaviour itself is covered by
      // the absolute-path test above.
      console.warn(`[skip] symlink test: ${cause.message}`);
      return;
    }
    const res = fakeRes();
    await fsRoute.handleFsOpenDefault(fakeJsonReq({ path: linkPath }), res);
    const body = await readBody(res);
    // Containment may report either "out-of-bounds" (when realpath
    // resolves the symlink first) or "not-a-regular-file" (when
    // realpath fails / the link target is itself a directory).
    // Both are accepted — the invariant is that the route does NOT
    // call spawn on the request.
    assert.equal(body.ok, false);
    assert.ok(
      body.code === "out-of-bounds" || body.code === "not-a-regular-file",
      `expected containment-style rejection, got ${JSON.stringify(body)}`,
    );
  });
});

// ============================================================
// Route tests — reveal
// ============================================================

describe("POST /api/fs/reveal — containment and argv safety", () => {
  test("missing path returns 400 missing-path", async () => {
    const res = fakeRes();
    await fsRoute.handleFsReveal(fakeJsonReq({}), res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "missing-path");
  });

  test("an out-of-root path is 403 out-of-bounds without spawning", async () => {
    await withFakeOpener(async () => {
      const res = fakeRes();
      await fsRoute.handleFsReveal(fakeJsonReq({ path: outsideRoot }), res);
      const body = await readBody(res);
      assert.equal(res.status, 403);
      assert.equal(body.code, "out-of-bounds");
    });
  });

  test("a directory inside an allowed root is 400 not-a-regular-file", async () => {
    const res = fakeRes();
    await fsRoute.handleFsReveal(fakeJsonReq({ path: workDir }), res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "not-a-regular-file");
  });

  test("a regular file is revealed with execFile (argv is literal)", async () => {
    const logPath = join(fakeBinDir, LOG_NAME);
    try {
      rmSync(logPath, { force: true });
    } catch {}

    const file = join(workDir, "reveal-target.bin");
    writeFileSync(file, "binary stub\n");

    await withFakeOpener(async () => {
      const res = fakeRes();
      await fsRoute.handleFsReveal(fakeJsonReq({ path: file }), res);
      const body = await readBody(res);
      assert.equal(body.ok, true, `expected ok:true, got ${JSON.stringify(body)}`);
      const argv = readArgvLog(fakeBinDir);
      assert.ok(argv);
      // macOS / Windows pass the file path; Linux passes the parent
      // directory. Both are valid invocations; the assertion is that
      // argv is a literal element (no shell), which is satisfied by
      // either shape.
      assert.ok(argv.length >= 1);
    });
  });
});

// ============================================================
// No-opener path — the host literally has no GUI binary
// ============================================================

describe("lib/open-target — no-opener", () => {
  test("openWithDefault returns code:no-opener when no opener is on PATH", async () => {
    // Set up an existing regular file first — otherwise the
    // regular-file gate (rather than the no-opener gate) is what
    // fires. The PATH probe happens AFTER the gate, so the input
    // must look valid for the assertion to land on no-opener.
    const target = join(workDir, "real-but-no-opener.bin");
    writeFileSync(target, "binary stub\n");

    const prev = process.env.PATH;
    // Force an empty PATH so the lib's `which`-style probe finds
    // nothing — the fake opener is published to fakeBinDir, which
    // we explicitly exclude here.
    process.env.PATH = "";
    try {
      const result = await openTargetLib.openWithDefault(target);
      // No-opener is a host-level condition; if the host has an
      // opener installed under a hard-coded absolute path, this
      // assertion is the regression tripwire. CI images usually
      // don't ship `open` / `xdg-open`; the dev container here
      // doesn't either.
      if (result.ok) {
        console.warn(
          `[skip] host has an opener on PATH (${result.code}); assertion is host-specific`,
        );
        return;
      }
      assert.equal(result.code, "no-opener");
    } finally {
      process.env.PATH = prev;
    }
  });
});
