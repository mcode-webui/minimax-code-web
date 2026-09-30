// webui/test/routes/git.test.js
// Regression: `/api/git/*` (slice 03 — right-panel Git panel + `/review`
// slash command). Pins the security invariants the ticket names:
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
//   4. File-axis containment: an absolute file path (e.g. `/etc/hostname`)
//      is rejected by `gitDiff` even though it starts with neither `-`
//      nor `..` — without this gate, `git diff --no-index -- /dev/null
//      <abs>` would happily read any server-readable file. The new
//      gate is `gateFile`, which `realpath`s the resolved path and
//      refuses any escape outside the contained dir.
//   5. Body cap: the checkout body goes through `readJson` (1 MiB
//      cap, 413 on overflow), not a hand-rolled buffer.
//
// Plus the success-path smoke tests so a regression in the parser is
// loud rather than silent.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdirSync, realpathSync, rmSync, writeFileSync} from "node:fs";

import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";

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

// Build a fake POST request whose body is the JSON-encoded `payload`.
// `readJson` consumes the body through `for await (const chunk of req)`,
// so the fake must be a Node `Readable`, not an event-emitter. The
// route does not need any GET URL, but the handler only checks `req.url`
// for `handleGitCheckout`; pass an empty string.
function fakeJsonReq(payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  // `Readable.from([chunk])` is the standard pattern for a finite stream.
  // Encoding the body as UTF-8 mirrors what `readJson` does.
  return Readable.from([Buffer.from(body, "utf8")]);
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body || "{}");
}

// A scratch git repository the success-path tests can read from. We
// `git init` it once per suite so the porcelain parser has a real
// repo to talk to (not a fake — the parser walks real `git status`
// output).
//
// The path is realpath'd on creation so the fixture's `dir` string
// matches what `assertWorkspacePath` / `gateFile` resolve against.
// On macOS `tmpdir()` returns a path under `/var/folders/…`, and
// `/var` is itself a symlink to `/private/var` — without realpath, the
// suite's "this path is outside the workspace" assertion would no
// longer hold the way the test assumes (the symlink escape test in
// particular fails because the contained dir's realpath is `/private/
// var/folders/…`, not the `repoDir` literal the request carries).
let repoDir;
before(() => {
  repoDir = realpathSync(mkTmpDir("git-panel-repo-"));
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
    const plain = mkTmpDir("git-panel-plain-");
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

// webui-parity 89 (F-4) — the HEAD identity the conversation
// toolbar's version badge renders. The three states that matter are
// exactly the three the badge branches on: a normal repository
// (branch + sha + commit time), a non-git directory (no identity at
// all, NOT an error — most workspaces here are not repositories),
// and a repository with an unborn HEAD (`git init` with nothing
// committed, where `git log -1` has nothing to report).
describe("git routes — /api/git/status HEAD identity (version badge)", () => {
  test("a normal repo returns the short sha git itself abbreviates", async () => {
    const res = fakeRes();
    gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(repoDir)}`), res);
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.isRepo, true);
    // Compared against git's own answer rather than a hard-coded
    // length: the field is `git log -1 --format=%h`, and git widens
    // the abbreviation when 7 chars would be ambiguous. Pinning "7"
    // would pin an implementation detail that is not the contract.
    const expected = execSync("git rev-parse --short HEAD", { cwd: repoDir }).toString().trim();
    assert.equal(body.headSha, expected);
    assert.match(body.headSha, /^[0-9a-f]{7,40}$/);
  });

  test("the commit time is the COMMITTER time, not the author time", async () => {
    // The two halves are only distinguishable on a commit whose
    // author and committer dates differ, so this builds one: a commit
    // written "long ago" by its author and landed in the tree
    // "recently" by whoever applied it. That is exactly the rebase /
    // cherry-pick / amend shape the field choice is about, and it is
    // why the shared single-commit fixture above cannot make this
    // assertion — there, `%aI` and `%cI` are the same string.
    const repo = realpathSync(mkTmpDir("git-panel-badge-dates-"));
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email test@example.com", { cwd: repo });
    execSync("git config user.name tester", { cwd: repo });
    try {
      writeFileSync(join(repo, "dated.txt"), "dated\n");
      execSync("git add dated.txt", { cwd: repo });
      execSync("git commit -q -m dated", {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2020-01-02T03:04:05+00:00",
          GIT_COMMITTER_DATE: "2026-10-01T09:12:33+00:00",
        },
      });
      const res = fakeRes();
      gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(repo)}`), res);
      const body = await readBody(res);
      const committer = execSync('git log -1 --format=%cI', { cwd: repo }).toString().trim();
      const author = execSync('git log -1 --format=%aI', { cwd: repo }).toString().trim();
      // Precondition: the fixture really does separate the two, or
      // this assertion would pass for the wrong reason.
      assert.notEqual(committer, author, "fixture must give author and committer different dates");
      assert.equal(body.headCommittedAt, committer);
      assert.notEqual(body.headCommittedAt, author, "the author time must not be what ships");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the sha advances after a new commit (the badge is not frozen at first read)", async () => {
    // Its own repository rather than the shared `repoDir` fixture: a
    // commit-then-reset dance on shared state would make the file-list
    // assertions in the describe above order-dependent.
    const repo = realpathSync(mkTmpDir("git-panel-badge-advance-"));
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email test@example.com", { cwd: repo });
    execSync("git config user.name tester", { cwd: repo });
    try {
      writeFileSync(join(repo, "a.txt"), "a\n");
      execSync("git add a.txt", { cwd: repo });
      execSync("git commit -q -m first", { cwd: repo });
      const first = await readBodyOf(fakeRes());
      const before = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();
      assert.equal(first.body.headSha, before);

      writeFileSync(join(repo, "b.txt"), "b\n");
      execSync("git add b.txt", { cwd: repo });
      execSync("git commit -q -m second", { cwd: repo });
      const second = await readBodyOf(fakeRes());
      const after = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();
      assert.equal(second.body.headSha, after);
      assert.notEqual(second.body.headSha, before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }

    async function readBodyOf(res) {
      gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(repo)}`), res);
      return { status: res.status, body: await readBody(res) };
    }
  });

  test("a non-git directory answers no HEAD identity and no error", async () => {
    const plain = mkTmpDir("git-panel-badge-plain-");
    try {
      const res = fakeRes();
      gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(plain)}`), res);
      const body = await readBody(res);
      assert.equal(res.status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.isRepo, false);
      // Absent, not a fake value: the badge renders nothing rather
      // than something that looks like a version.
      assert.equal(body.headSha, undefined);
      assert.equal(body.headCommittedAt, undefined);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("a repo with an unborn HEAD answers null identity, not an error", async () => {
    const empty = realpathSync(mkTmpDir("git-panel-badge-empty-"));
    execSync("git init -q -b main", { cwd: empty });
    try {
      const res = fakeRes();
      gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(empty)}`), res);
      const body = await readBody(res);
      assert.equal(res.status, 200);
      // `git status` succeeds here, so the route answers ok:true — a
      // fresh `git init` is a healthy repository, it simply has no
      // commit to name yet.
      assert.equal(body.ok, true);
      assert.equal(body.isRepo, true);
      assert.equal(body.headSha, null);
      assert.equal(body.headCommittedAt, null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("an unborn HEAD still reports its branch name, not the word 'No'", async () => {
    // `git status --porcelain -b` prints `## No commits yet on main`;
    // the generic branch regex would read the first token as the
    // branch, so the badge would have shown a branch called "No".
    const empty = realpathSync(mkTmpDir("git-panel-badge-unborn-"));
    execSync("git init -q -b feature/unborn", { cwd: empty });
    try {
      const res = fakeRes();
      gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(empty)}`), res);
      const body = await readBody(res);
      assert.equal(body.branch, "feature/unborn");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("an out-of-root dir is still refused — the HEAD probe reuses the same gate", async () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    gitRoute.handleGitStatus(readReq(`/api/git/status?dir=${encodeURIComponent(outsideRoot)}`), res);
    const body = await readBody(res);
    assert.equal(body.ok, false);
    assert.equal(body.isRepo, false);
    // No identity leaks out of a rejected path — the probe runs
    // against the gated dir or not at all.
    assert.equal(body.headSha, undefined);
    assert.equal(body.headCommittedAt, undefined);
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

  test("an absolute file path is rejected (file-axis escape)", async () => {
    // Without the file-axis containment, `git diff --no-index --
    // /dev/null <abs>` would happily read any server-readable file.
    // Pin that this surface refuses absolute paths regardless of
    // whether the resolved realpath is inside the workspace.
    for (const abs of ["/etc/hostname", "/etc/passwd", "/tmp/anything"]) {
      const res = fakeRes();
      gitRoute.handleGitDiff(readReq(
        `/api/git/diff?dir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent(abs)}`,
      ), res);
      const body = await readBody(res);
      assert.equal(body.ok, false, `expected reject for ${abs}`);
      assert.match(body.error, /非法路径/, `expected 非法路径 for ${abs}, got: ${body.error}`);
    }
  });

  test("a symlink pointing outside the workspace is rejected", async () => {
    // Create a symlink inside the repo that points to /etc/hostname.
    // realpath containment must refuse to follow it through the
    // diff file parameter.
    const linkPath = `${repoDir}/evil-link`;
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync("/etc/hostname", linkPath);
    } catch (cause) {
      // Some platforms (Windows without priv) refuse symlink creation
      // — skip rather than fail. The containment behaviour itself is
      // covered by the absolute-path test above; the symlink case is
      // the "best-effort coverage" layer.
      console.warn(`[skip] symlink test: ${cause.message}`);
      return;
    }
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq(
      `/api/git/diff?dir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent("evil-link")}`,
    ), res);
    const body = await readBody(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /非法路径/);
  });

  test("a DANGLING symlink (target does not exist) is rejected", async () => {
    // The previous "symlink escape" test created a symlink whose
    // target DID exist (e.g. /etc/hostname on Linux), so realpathSync
    // succeeded and the realpath-containment check correctly rejected.
    // A *dangling* symlink — one whose target does not exist anywhere
    // on the filesystem — used to slip past: realpathSync threw
    // ENOENT, the lib substituted the unresolved (still-inside-dir)
    // path, and the containment check passed. The macOS CI caught
    // this because `/etc/hostname` does not exist on macOS runners,
    // making every `/etc/hostname`-pointing symlink a dangling one.
    // The fix is to require the symlink to resolve; a dangling link
    // is treated as an escape attempt and rejected.
    //
    // Note: this test fails on the OLD lib regardless of platform —
    // it just happens that on Linux /etc/hostname exists so the
    // previous "symlink" test did not exercise this branch.
    const linkPath = `${repoDir}/dangling-link`;
    const target = `${repoDir}/nonexistent-target-${Math.random().toString(36).slice(2)}`;
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(target, linkPath);
    } catch (cause) {
      console.warn(`[skip] dangling symlink test: ${cause.message}`);
      return;
    }
    const res = fakeRes();
    gitRoute.handleGitDiff(readReq(
      `/api/git/diff?dir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent("dangling-link")}`,
    ), res);
    const body = await readBody(res);
    // Belt-and-braces: make sure the target really does not exist
    // (otherwise the test would not actually exercise the dangling
    // branch and would silently cover the non-dangling case).
    assert.equal(
      existsSync(target),
      false,
      `precondition: target ${target} must NOT exist for the dangling branch to be exercised`,
    );
    assert.equal(body.ok, false, `dangling symlink must be rejected; got body=${JSON.stringify(body)}`);
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
  test("a malformed JSON body answers 'missing dir/branch' (not 500)", async () => {
    // The shared `readJson` helper swallows parse errors and returns
    // `{}`. The route then sees no `dir` / `branch` and answers 400
    // with the normal "missing dir/branch" message — same shape as
    // a request that sends an empty JSON body. The point is that
    // no exception escapes the route, the body cap is honoured, and
    // the panel gets a coherent error message to render.
    const res = fakeRes();
    const fakeReq = fakeJsonReq("not-json-{");
    await gitRoute.handleGitCheckout(fakeReq, res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.match(body.error, /missing dir/);
  });

  test("missing dir/branch returns 400", async () => {
    const res = fakeRes();
    const fakeReq = fakeJsonReq({ branch: "main" });
    await gitRoute.handleGitCheckout(fakeReq, res);
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.match(body.error, /missing dir/);
  });

  test("an out-of-root dir is rejected by containment", async () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    const fakeReq = fakeJsonReq({ dir: outsideRoot, branch: "main" });
    await gitRoute.handleGitCheckout(fakeReq, res);
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
    const fakeReq = fakeJsonReq({ dir: repoDir, branch: "--upload-pack=evil" });
    await gitRoute.handleGitCheckout(fakeReq, res);
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
      const fakeReq = fakeJsonReq({ dir: repoDir, branch: bad });
      await gitRoute.handleGitCheckout(fakeReq, res);
      const body = await readBody(res);
      assert.equal(body.ok, false, `expected reject for ${JSON.stringify(bad)}`);
      assert.match(body.error, /非法分支名/);
    }
    // Traversal-style names that match the regex still produce a
    // `ok:false` answer (from git itself), never a successful
    // checkout. The panel surfaces this verbatim.
    const traversalRes = fakeRes();
    const traversalReq = fakeJsonReq({ dir: repoDir, branch: "../etc" });
    await gitRoute.handleGitCheckout(traversalReq, traversalRes);
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
    const fakeReq = fakeJsonReq({ dir: repoDir, branch: "definitely-not-a-branch" });
    await gitRoute.handleGitCheckout(fakeReq, res);
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
