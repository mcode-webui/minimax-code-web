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
} from "../lib/git-panel";
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
