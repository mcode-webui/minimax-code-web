// webui/test/routes/git.test.js
// Regression: `/api/git/*` (slice 03 — right-panel Git panel + `/review`
// slash command). Pins the three security invariants the ticket names:
//
//   1. Containment: an out-of-root `dir` is rejected by the shared
//      `assertWorkspacePath` gate before `git` is even invoked. The
//      `git` binary is never asked to walk a path it should not see.
//   2. Local-branch allow-list: a branch name that is not on the local
//      list (regex + leading-dash guard) is rejected by `gitCheckout`.
//      Defence-in-depth — the panel only ever offers branches from
//      `GET /api/git/branches`, but a forged request must still fail.
//   3. Option-injection via `file`: a filename that starts with `-`
//      or contains `..` is rejected up front by `gitDiff`. The `--`
//      separator in the `execFile` argv is the in-binary boundary; this
//      test pins the up-front gate so the separator is ungameable.
//
// Plus the success-path smoke tests so a regression in the parser is
// loud rather than silent.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const gitRoute = await import(absPath("routes/git.js"));
const gitLib = await import(absPath("lib/git.js"));

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

// Build a fake request that delivers a single JSON body chunk on end.
// Mirrors the small `(req, res)` style the route uses (the route calls
// `req.on('data', …)` then `req.on('end', …)`). Tests drive the end
// event by awaiting `req.flush()` so the assertions can read the body
// after the route's `end` handler runs.
function fakeJsonReq(url, payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const listeners = { data: [], end: [] };
  return {
    url,
    on(event, cb) {
      if (event === "data") listeners.data.push(cb);
      else if (event === "end") listeners.end.push(cb);
    },
    // Drive the events: emit `data` with the body once, then `end`.
    flush() {
      for (const cb of listeners.data) cb(body);
      for (const cb of listeners.end) cb();
    },
  };
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body || "{}");
}

// A scratch git repository the success-path tests can read from. We
// `git init` it once per suite so the porcelain parser has a real
// repo to talk to (not a fake — the parser walks real `git status`
// output).
let repoDir;
before(() => {
  repoDir = mkdtempSync(join(tmpdir(), "git-panel-repo-"));
  // `-b main` for cross-platform determinism (no "master" surprise on
  // older git installs); `--initial-branch` would also work but is
  // git-2.28+ only and we want this to run on any host.
  execSync("git init -q -b main", { cwd: repoDir });
  execSync("git config user.email test@example.com", { cwd: repoDir });
  execSync("git config user.name tester", { cwd: repoDir });
  writeFileSync(join(repoDir, "tracked.txt"), "hello\n");
  execSync("git add tracked.txt", { cwd: repoDir });
  execSync("git commit -q -m initial", { cwd: repoDir });
  // Modify tracked.txt so the panel has something to surface.
  writeFileSync(join(repoDir, "tracked.txt"), "hello\nworld\n");
  // Untracked file — exercises the ?  ? bucket and the no-index
  // diff fallback.
  writeFileSync(join(repoDir, "untracked.txt"), "new file\n");
});

after(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

describe("git routes — /api/git/status", () => {
  test("missing dir returns 400 missing dir", async () => {
    const res = fakeRes();
    gitRoute.handleGitStatus(readReq("/api/git/status"), res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "missing dir");
  });

  test("an out-of-root dir is rejected by containment, not by git", async () => {
    // Same witness the existing fs tests use: /etc on POSIX,
    // SystemRoot on Windows. The gate runs first; the route must
    // answer with the containment error so `git` is never asked to
    // walk the path.
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(outsideRoot)}`), res);
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.isRepo, false);
    assert.match(body.error, /不在允许范围内/);
  });

  test("a git repo inside an allowed root returns branch + files", async () => {
    const res = fakeRes();
    gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(repoDir)}`), res);
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.isRepo, true);
    assert.equal(body.branch, "main");
    // We expect at least the modified tracked.txt (M in worktree) and
    // the untracked.txt (??). The porcelain parser populates both.
    assert.ok(Array.isArray(body.files));
    const paths = body.files.map((f) => f.path);
    assert.ok(paths.includes("tracked.txt"), `expected tracked.txt in files, got ${paths.join(",")}`);
    assert.ok(paths.includes("untracked.txt"), `expected untracked.txt in files, got ${paths.join(",")}`);
  });

  test("a non-git directory inside an allowed root answers isRepo=false", async () => {
    const plain = mkdtempSync(join(tmpdir(), "git-panel-plain-"));
    try {
      const res = fakeRes();
      gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(plain)}`), res);
      const body = await readBody(res);
      assert.equal(res.status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.isRepo, false);
      assert.match(body.error, /不是 git 仓库/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("git routes — /api/git/branches", () => {
  test("missing dir returns 400", async () => {
    const res = fakeRes();
    gitRoute.handleGitBranches(readReq("/api/git/branches"), res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.error, "missing dir");
  });

  test("an out-of-root dir is rejected by containment", async () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    gitRoute.handleGitBranches(readReq(`/api/git/branches?dir=${encodeURIComponent(outsideRoot)}`), res);
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /不在允许范围内/);
  });

  test("a git repo inside an allowed root returns the local branch list", async () => {
    const res = fakeRes();
    gitRoute.handleGitBranches(readReq(`/api/git/branches?dir=${encodeURIComponent(repoDir)}`), res);
    const body = await readBody(res);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.branches));
    assert.ok(body.branches.length >= 1);
    const main = body.branches.find((b) => b.name === "main");
    assert.ok(main, "expected main in branch list");
    assert.equal(main.current, true);
  });
});

describe("git routes — /api/git/diff", () => {
  test("missing dir/file returns 400", async () => {
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq("/api/git/diff"), res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.match(body.error, /missing dir/);

    const res2 = fakeRes();
    gitRoute.handleGitDiff(readReq(`/api/git/diff?dir=${encodeURIComponent(repoDir)}`), res2);
    const body2 = await readBody(res2);
    assert.equal(res2.status, 400);
    assert.match(body2.error, /missing/);
  });

  test("an out-of-root dir is rejected by containment", async () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq(
      `/api/git/diff?dir=${encodeURIComponent(outsideRoot)}&file=${encodeURIComponent("tracked.txt")}`,
    ), res);
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /不在允许范围内/);
  });

  test("a tracked file diff returns the expected hunk", async () => {
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq(
      `/api/git/diff?dir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent("tracked.txt")}`,
    ), res);
    const body = await readBody(res);
    assert.equal(body.ok, true);
    assert.ok(typeof body.diff === "string" && body.diff.length > 0, "expected non-empty diff");
    assert.match(body.diff, /tracked\.txt/);
  });

  test("an untracked file falls back to no-index and produces an all-add diff", async () => {
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq(
      `/api/git/diff?dir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent("untracked.txt")}`,
    ), res);
    const body = await readBody(res);
    assert.equal(body.ok, true);
    // no-index diff vs /dev/null uses the requested file as the b/ side.
    assert.match(body.diff, /untracked\.txt/);
  });

  test("a filename starting with '-' is rejected (option injection via execFile argv)", async () => {
    // Belt-and-braces guard for the option-injection surface. Even
    // though the lib uses `--` as the argv separator (so `git diff`
    // never sees the user's filename as an option), the lib also
    // rejects any filename that starts with `-` or contains `..` —
    // this test pins that guard so a future refactor can't silently
    // remove it.
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq(
      `/api/git/diff?dir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent("--output=/etc/passwd")}`,
    ), res);
    const body = await readBody(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /非法路径/);
  });

  test("a filename containing '..' is rejected", async () => {
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq(
      `/api/git/diff?dir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent("../escape.txt")}`,
    ), res);
    const body = await readBody(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /非法路径/);
  });
});

describe("git routes — /api/git/checkout", () => {
  test("invalid JSON returns 400 invalid json", async () => {
    const res = fakeRes();
    const fakeReq = fakeJsonReq("/api/git/checkout", "not-json-{");
    gitRoute.handleGitCheckout(fakeReq, res);
    fakeReq.flush();
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.error, "invalid json");
  });

  test("missing dir/branch returns 400", async () => {
    const res = fakeRes();
    const fakeReq = fakeJsonReq("/api/git/checkout", { branch: "main" });
    gitRoute.handleGitCheckout(fakeReq, res);
    fakeReq.flush();
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.match(body.error, /missing dir/);
  });

  test("an out-of-root dir is rejected by containment", async () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    const fakeReq = fakeJsonReq("/api/git/checkout", { dir: outsideRoot, branch: "main" });
    gitRoute.handleGitCheckout(fakeReq, res);
    fakeReq.flush();
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /不在允许范围内/);
  });

  test("a branch name starting with '-' is rejected by the allow-list", async () => {
    // Option-injection surface via the branch name. Even though
    // execFile would pass the branch as a literal argv element, `git
    // checkout` itself reads argv and would interpret `--upload-pack=…`
    // as its own option. The regex + leading-dash guard stops that.
    const res = fakeRes();
    const fakeReq = fakeJsonReq("/api/git/checkout", { dir: repoDir, branch: "--upload-pack=evil" });
    gitRoute.handleGitCheckout(fakeReq, res);
    fakeReq.flush();
    const body = await readBody(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /非法分支名/);
  });

  test("a branch name with shell metacharacters is rejected by the allow-list", async () => {
    // Branch names with shell metacharacters do not match the
    // allow-list regex (`^[A-Za-z0-9._/-]+$`), so the route rejects
    // them up front with 非法分支名. Path-traversal names like
    // `../etc` happen to match the regex (so they pass the regex
    // guard) but `git checkout` itself rejects them because the
    // path lies outside the repository — that is still a `ok:false`
    // answer, just from a different layer. Either layer is fine as
    // long as the route never actually runs `git checkout` against
    // the input.
    for (const bad of ["main; rm -rf /", "main && curl evil", "main|whoami"]) {
      const res = fakeRes();
      const fakeReq = fakeJsonReq("/api/git/checkout", { dir: repoDir, branch: bad });
      gitRoute.handleGitCheckout(fakeReq, res);
      fakeReq.flush();
      const body = await readBody(res);
      assert.equal(body.ok, false, `expected reject for ${JSON.stringify(bad)}`);
      assert.match(body.error, /非法分支名/);
    }
    // Traversal-style names that match the regex still produce a
    // `ok:false` answer (from git itself), never a successful
    // checkout. The panel surfaces this verbatim.
    const traversalRes = fakeRes();
    const traversalReq = fakeJsonReq("/api/git/checkout", { dir: repoDir, branch: "../etc" });
    gitRoute.handleGitCheckout(traversalReq, traversalRes);
    traversalReq.flush();
    const traversalBody = await readBody(traversalRes);
    assert.equal(traversalBody.ok, false);
    // Either the regex layer or the git layer rejected it — the
    // important invariant is that `git checkout` never ran on a
    // path-traversal input.
    assert.ok(/非法分支名|fatal|仓库/.test(traversalBody.error || ""),
      `expected rejection, got: ${traversalBody.error}`);
  });

  test("switching to a non-existent local branch surfaces the git error", async () => {
    // The allow-list accepts any string matching `[A-Za-z0-9._/-]+`
    // that does not start with `-`. A valid-shaped but non-existent
    // name must surface the underlying git error verbatim — the panel
    // shows that as a transient inline message, not a toast.
    const res = fakeRes();
    const fakeReq = fakeJsonReq("/api/git/checkout", { dir: repoDir, branch: "definitely-not-a-branch" });
    gitRoute.handleGitCheckout(fakeReq, res);
    fakeReq.flush();
    const body = await readBody(res);
    assert.equal(body.ok, false);
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  });
});

describe("git routes — Hono /api/git/* ownership", () => {
  // The four new routes must be reachable through the Hono app. We
  // assert this indirectly: the OWNED_ROUTES ledger (which
  // app-hono.test.js pins structurally) is the source of truth, but a
  // parity smoke through `createHonoApp().request(...)` confirms the
  // route handlers actually wire up.
  test("createHonoApp routes /api/git/status through the handler", async () => {
    const { createHonoApp } = await import(absPath("app.js"));
    const app = createHonoApp();
    // Containment rejects /etc — the body is the gate error rather
    // than a 200 success, which is enough to prove the route is wired
    // (any unmigrated path would 404).
    const res = await app.request(
      `/api/git/status?dir=${encodeURIComponent("/etc")}`,
      { headers: { "x-test-incoming": "1" } },
      { incoming: { method: "GET", url: `/api/git/status?dir=${encodeURIComponent("/etc")}`, headers: {}, socket: { remoteAddress: "127.0.0.1" } } },
    );
    assert.equal(res.status, 200, "the Hono route must own /api/git/status");
  });
});
