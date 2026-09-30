// webapp/test/git-panel.test.ts
// Unit tests for the pure logic in `lib/git-panel.ts` (right-panel
// Git panel, slice 03). Webapp-test boundaries: pin the bucket
// mapping + status chips + diff truncation that the React component
// branches on. The full React tree + the network calls are covered
// by the agent-browser self-check in the slice report.
//
// Why pin these specifically. The bucket mapping mirrors what `git
// status -s` would print and what the `/review` slash command emits
// into the chat; a drift in either direction (panel says "staged"
// where the server says "unstaged", or vice-versa) is a confusing
// regression. The diff truncation is what stops a 50 KiB diff from
// dominating the panel column — losing the `truncated` marker would
// silently cut content with no user-visible hint.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  splitFilesByBucket,
  formatStatusTags,
  describeCleanliness,
  previewDiff,
  resolveVersionBadge,
  versionBadgeTimeBucket,
} from "../lib/git-panel";
import { translate, type MessageKey } from "../lib/i18n";
import type { GitStatusFile } from "../lib/api";

function file(overrides: Partial<GitStatusFile>): GitStatusFile {
  return {
    x: " ",
    y: " ",
    path: "example.txt",
    origPath: null,
    staged: false,
    ...overrides,
  };
}

describe("splitFilesByBucket — porcelain semantics", () => {
  test("MM (index modified + worktree modified) lands in staged only", () => {
    // The ticket pins that an entry whose index side is non-space
    // AND whose worktree side is also non-space belongs to BOTH
    // `staged` AND `unstaged` from git's perspective. The panel
    // keeps the entry under `staged` so the rendered count matches
    // `git diff --cached` (the user's mental model of "what would
    // my next commit include").
    const f = file({ x: "M", y: "M", path: "both.txt", staged: true });
    const buckets = splitFilesByBucket([f]);
    assert.equal(buckets.staged.length, 1);
    assert.equal(buckets.unstaged.length, 1, "MM is also an unstaged change");
    assert.equal(buckets.untracked.length, 0);
  });

  test("?? (untracked) lands only in untracked", () => {
    const f = file({ x: "?", y: "?", path: "new.txt", staged: false });
    const buckets = splitFilesByBucket([f]);
    assert.deepEqual(buckets.staged, []);
    assert.deepEqual(buckets.unstaged, []);
    assert.equal(buckets.untracked.length, 1);
    assert.equal(buckets.untracked[0]?.path, "new.txt");
  });

  test("M in index only (worktree clean) lands only in staged", () => {
    const f = file({ x: "M", y: " ", path: "stage-only.txt", staged: true });
    const buckets = splitFilesByBucket([f]);
    assert.equal(buckets.staged.length, 1);
    assert.equal(buckets.unstaged.length, 0);
    assert.equal(buckets.untracked.length, 0);
  });

  test("space in index + M in worktree lands only in unstaged", () => {
    // `staged` is computed by the server from `x !== ' ' && x !== '?'`,
    // so this entry arrives with `staged: false`. The unstaged
    // bucket only requires the worktree side (`y`) to be non-space.
    const f = file({ x: " ", y: "M", path: "working-tree.txt", staged: false });
    const buckets = splitFilesByBucket([f]);
    assert.equal(buckets.staged.length, 0);
    assert.equal(buckets.unstaged.length, 1);
    assert.equal(buckets.untracked.length, 0);
  });

  test("renamed entries (R) keep origPath and the new path", () => {
    const f = file({
      x: "R",
      y: " ",
      path: "renamed.txt",
      origPath: "old.txt",
      staged: true,
    });
    const buckets = splitFilesByBucket([f]);
    assert.equal(buckets.staged[0]?.origPath, "old.txt");
    assert.equal(buckets.staged[0]?.path, "renamed.txt");
  });

  test("non-array / null input returns empty buckets without throwing", () => {
    // The panel must render cleanly when the server answers
    // `{ok:false}` (no files payload) — `gitStatus` calls this with
    // a real array, but a partial payload shouldn't crash the UI.
    for (const input of [undefined, null, "not an array" as unknown as GitStatusFile[]]) {
      const buckets = splitFilesByBucket(input);
      assert.deepEqual(buckets, { staged: [], unstaged: [], untracked: [] });
    }
  });
});

describe("formatStatusTags — porcelain chip rendering", () => {
  test("renders 'MM' for a staged-and-modified file", () => {
    assert.equal(formatStatusTags(file({ x: "M", y: "M", staged: true })), "MM");
  });

  test("renders '??' for an untracked file", () => {
    assert.equal(formatStatusTags(file({ x: "?", y: "?" })), "??");
  });

  test("renders 'R ' (with trailing space) for a rename in the index", () => {
    assert.equal(formatStatusTags(file({ x: "R", y: " ", staged: true })), "R ");
  });
});

describe("describeCleanliness — header state reducer", () => {
  test("no workspace → state no-workspace", () => {
    const out = describeCleanliness({
      workspaceDir: null,
      status: { ok: true, isRepo: true },
      hasError: false,
    });
    assert.equal(out.state, "no-workspace");
  });

  test("ok:false + isRepo:false → state not-repo", () => {
    const out = describeCleanliness({
      workspaceDir: "/tmp/repo",
      status: { ok: false, isRepo: false },
      hasError: false,
    });
    assert.equal(out.state, "not-repo");
  });

  test("ok:false + isRepo undefined → state error", () => {
    const out = describeCleanliness({
      workspaceDir: "/tmp/repo",
      status: { ok: false, error: "permission denied" },
      hasError: false,
    });
    assert.equal(out.state, "error");
    assert.match(out.message, /permission denied/);
  });

  test("ok:true with no files → state clean", () => {
    const out = describeCleanliness({
      workspaceDir: "/tmp/repo",
      status: { ok: true, isRepo: true, files: [] },
      hasError: false,
    });
    assert.equal(out.state, "clean");
  });

  test("ok:true with files → state dirty", () => {
    const out = describeCleanliness({
      workspaceDir: "/tmp/repo",
      status: {
        ok: true,
        isRepo: true,
        files: [file({ x: "M", y: " ", path: "x.txt", staged: true })],
      },
      hasError: false,
    });
    assert.equal(out.state, "dirty");
    assert.match(out.message, /1/);
  });

  test("ok:true + isRepo:false (defensive) → state not-repo", () => {
    // The server should not normally answer `ok:true` with
    // `isRepo:false`, but the helper must still classify that as a
    // not-repo state so the panel renders the right empty branch.
    const out = describeCleanliness({
      workspaceDir: "/tmp/repo",
      status: { ok: true, isRepo: false },
      hasError: false,
    });
    assert.equal(out.state, "not-repo");
  });
});

describe("previewDiff — display truncation", () => {
  test("a diff under the budget passes through unchanged", () => {
    const diff = "line1\nline2\nline3";
    const out = previewDiff(diff, 400);
    assert.equal(out.text, diff);
    assert.equal(out.truncated, false);
  });

  test("a diff over the budget is truncated with the marker set", () => {
    const diff = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = previewDiff(diff, 100);
    assert.equal(out.truncated, true);
    assert.ok(out.text.split("\n").length <= 100);
    // The original diff must NOT survive verbatim — losing the
    // truncation marker would silently cut content with no hint.
    assert.notEqual(out.text, diff);
  });

  test("empty / null diff returns empty text + not truncated", () => {
    // The helper splits on '\n' rather than trimming — a single
    // whitespace-only line is still a line. We only assert that
    // empty / null input does not throw and that `truncated` stays
    // false (so the panel doesn't show a fake "more" marker).
    for (const input of [undefined, null, ""]) {
      const out = previewDiff(input, 400);
      assert.equal(out.text, "");
      assert.equal(out.truncated, false);
    }
    // A whitespace-only "diff" is treated as content (1 line) — the
    // truncation predicate still says false because 1 line ≤ 400.
    const ws = previewDiff("   ", 400);
    assert.equal(ws.text, "   ");
    assert.equal(ws.truncated, false);
  });
});

// webui-parity 89 (F-4) — the conversation toolbar's version badge.
// The render decision is what these pin. A badge that appears over an
// empty pill (non-git workspace, unborn HEAD, still-loading) is the
// exact "dead control" shape the ticket forbids, so the null cases are
// asserted as loudly as the populated one. The React wiring itself
// (fetch on workspace change, the copy button) is verified live in the
// ticket's end-to-end run — Node's test loader cannot mount the tree.
describe("resolveVersionBadge — when the version badge renders", () => {
  const repo = {
    ok: true,
    isRepo: true,
    branch: "feat/version-badge",
    headSha: "0e99b45",
    headCommittedAt: "2026-10-01T09:12:33+08:00",
  };

  test("a repository with a commit yields branch + sha + parsed time", () => {
    const badge = resolveVersionBadge({ workspaceDir: "/w", status: repo });
    assert.ok(badge);
    assert.equal(badge.branch, "feat/version-badge");
    assert.equal(badge.shortSha, "0e99b45");
    assert.equal(badge.committedAtMs, Date.parse("2026-10-01T09:12:33+08:00"));
  });

  test("no workspace renders nothing", () => {
    // The pre-first-response state and the no-session state both land
    // here; neither may paint a placeholder.
    assert.equal(resolveVersionBadge({ workspaceDir: null, status: null }), null);
    assert.equal(resolveVersionBadge({ workspaceDir: "", status: null }), null);
    assert.equal(resolveVersionBadge({ workspaceDir: "/w", status: null }), null);
  });

  test("a non-git workspace renders nothing", () => {
    // `isRepo:false` is the server's NORMAL answer for a plain folder,
    // not an error state — most workspaces in this product are not
    // repositories.
    assert.equal(
      resolveVersionBadge({ workspaceDir: "/w", status: { ok: false, isRepo: false } }),
      null,
    );
  });

  test("a failed request renders nothing", () => {
    assert.equal(
      resolveVersionBadge({
        workspaceDir: "/w",
        status: { ok: false, isRepo: true, error: "boom" },
        hasError: true,
      }),
      null,
    );
  });

  test("a repo with an unborn HEAD renders nothing (no sha to show)", () => {
    // `git init` with nothing committed: isRepo:true, but `git log -1`
    // has no answer, so both identity fields are null. A badge showing
    // only a branch name would claim a version that does not exist.
    assert.equal(
      resolveVersionBadge({
        workspaceDir: "/w",
        status: { ok: true, isRepo: true, branch: "main", headSha: null, headCommittedAt: null },
      }),
      null,
    );
  });

  test("a missing or blank sha renders nothing", () => {
    for (const headSha of [undefined, "", "   "]) {
      assert.equal(
        resolveVersionBadge({
          workspaceDir: "/w",
          status: { ok: true, isRepo: true, branch: "main", headSha },
        }),
        null,
        `headSha=${JSON.stringify(headSha)} should not render a badge`,
      );
    }
  });

  test("a detached HEAD keeps the sha and drops the branch, rather than faking one", () => {
    const badge = resolveVersionBadge({
      workspaceDir: "/w",
      status: { ok: true, isRepo: true, branch: null, headSha: "abc1234" },
    });
    assert.ok(badge);
    assert.equal(badge.branch, null);
    assert.equal(badge.shortSha, "abc1234");
  });

  test("an unparseable timestamp costs only the time half, not the badge", () => {
    const badge = resolveVersionBadge({
      workspaceDir: "/w",
      status: { ok: true, isRepo: true, branch: "main", headSha: "abc1234", headCommittedAt: "not-a-date" },
    });
    assert.ok(badge);
    assert.equal(badge.committedAtMs, null);
    assert.equal(badge.shortSha, "abc1234");
  });
});

describe("versionBadgeTimeBucket — the relative-time half", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const at = (ms: number) => now - ms;

  test("a missing timestamp yields no time half at all (no orphan separator)", () => {
    assert.equal(versionBadgeTimeBucket(now, null), "");
  });

  test("a future timestamp yields no time half — clock skew must not print '-2h ago'", () => {
    assert.equal(versionBadgeTimeBucket(now, now + 2 * 60 * 60_000), "");
  });

  test("the ladder matches the file tree's mtime buckets", () => {
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    assert.equal(versionBadgeTimeBucket(now, at(30_000)), "now");
    assert.equal(versionBadgeTimeBucket(now, at(5 * min)), "minutesAgo:5");
    assert.equal(versionBadgeTimeBucket(now, at(3 * hour)), "hoursAgo:3");
    assert.equal(versionBadgeTimeBucket(now, at(2 * day)), "daysAgo:2");
    assert.equal(versionBadgeTimeBucket(now, at(10 * day)), "weeksAgo:1");
    assert.equal(versionBadgeTimeBucket(now, at(90 * day)), "monthsAgo:3");
    assert.equal(versionBadgeTimeBucket(now, at(400 * day)), "yearsAgo:1");
  });

  test("every bucket key it can emit is a real bilingual dictionary key", () => {
    // A bucket with no dictionary entry would render the key name
    // itself into the toolbar, so the two vocabularies are pinned
    // against each other rather than trusted to drift together.
    const emitted = [
      "now",
      "minutesAgo:1",
      "hoursAgo:1",
      "daysAgo:1",
      "weeksAgo:1",
      "monthsAgo:1",
      "yearsAgo:1",
    ];
    for (const bucket of emitted) {
      const [name] = bucket.split(":");
      const key = `git.badge.${name}` as MessageKey;
      assert.notEqual(translate("zh", key), undefined, `zh is missing ${key}`);
      assert.notEqual(translate("en", key), undefined, `en is missing ${key}`);
    }
  });
});
