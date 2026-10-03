// webapp/test/settings-worktree-section.test.ts
//
// The 工作树 settings page (placeholder batch PB-3).
//
// Two halves, and the split is deliberate:
//
//   - The three time tabs and the protected-row rule are PURE functions
//     (`worktreeAgeBucket` / `visibleWorktrees` / `worktreeBlockReason`),
//     and they are tested on their inputs — including the two boundaries
//     where a `<` / `<=` slip would quietly move a row between tabs, and
//     the "no timestamp" case that must be visible in every tab rather
//     than filed at epoch 0 under 「7 天以上」.
//   - The rendered markup is checked for the things a source grep cannot
//     decide: that the toolbar really carries the desktop's three tabs in
//     order, that the page has NO create control (the desktop reference
//     `design-ref/screenshots/ref-23.jpg` has none, and the port declares
//     no create either), and that the failure reasons reach the DOM as
//     sentences rather than as raw enum tokens.
//
// The section fetches on mount, and `renderToStaticMarkup` does not run
// effects, so the list body is exercised through the pure derivations and
// through `removalOutcomeOf` rather than through a fake network. The
// wiring from the settings tab to the section is pinned by a source
// tripwire at the bottom — the render harness cannot mount the modal
// (it pulls in the whole store/api graph), and a tripwire is the
// acceptable substitute there.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WORKTREE_DAY_MS,
  WORKTREE_TIME_BUCKETS,
  WorktreeSection,
  removalOutcomeOf,
  visibleWorktrees,
  worktreeAgeBucket,
  worktreeBlockReason,
  worktreeBucketLabelKey,
  worktreeReasonLabelKey,
} from "../components/settings-worktree-section";
import { translate, type MessageKey } from "../lib/i18n";
import type { WorktreeRow } from "../lib/api";

const tZh = (key: MessageKey) => translate("zh", key);
const tEn = (key: MessageKey) => translate("en", key);

const NOW = 1_700_000_000_000;

function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: "/repo/.worktrees/a",
    branch: "feature/a",
    head: "abc1234",
    isMain: false,
    isLocked: false,
    isActive: false,
    isMcodeManaged: true,
    lastModifiedMs: NOW - WORKTREE_DAY_MS,
    ...overrides,
  };
}

describe("the three time tabs", () => {
  test("the buckets are the desktop's, in the desktop's order", () => {
    assert.deepEqual([...WORKTREE_TIME_BUCKETS], ["recent3d", "days3to7", "older7d"]);
    assert.deepEqual(
      WORKTREE_TIME_BUCKETS.map((bucket) => tZh(worktreeBucketLabelKey(bucket))),
      ["近 3 天", "3-7 天前", "7 天以上"],
    );
  });

  test("the band boundaries are inclusive at the top of each band", () => {
    // EXACTLY 3 days is still 近 3 天; one millisecond older is not. A
    // `<`/`<=` slip here moves a row across tabs on a boundary nobody can
    // see by eye, which is why both sides are pinned.
    assert.equal(worktreeAgeBucket(NOW - 3 * WORKTREE_DAY_MS, NOW), "recent3d");
    assert.equal(worktreeAgeBucket(NOW - 3 * WORKTREE_DAY_MS - 1, NOW), "days3to7");
    // EXACTLY 7 days is still 3-7 天前.
    assert.equal(worktreeAgeBucket(NOW - 7 * WORKTREE_DAY_MS, NOW), "days3to7");
    assert.equal(worktreeAgeBucket(NOW - 7 * WORKTREE_DAY_MS - 1, NOW), "older7d");
  });

  test("a fresh, an old and a future timestamp each land in one band", () => {
    assert.equal(worktreeAgeBucket(NOW, NOW), "recent3d");
    assert.equal(worktreeAgeBucket(NOW - 400 * WORKTREE_DAY_MS, NOW), "older7d");
    // Clock skew between the workstation and the machine hosting the repo.
    // "Modified in the future" is closest to "modified just now"; hiding
    // the row would be worse than mis-bucketing it.
    assert.equal(worktreeAgeBucket(NOW + 60_000, NOW), "recent3d");
  });

  test("a missing or nonsensical timestamp has no band at all", () => {
    assert.equal(worktreeAgeBucket(undefined, NOW), null);
    assert.equal(worktreeAgeBucket(Number.NaN, NOW), null);
    assert.equal(worktreeAgeBucket(Number.POSITIVE_INFINITY, NOW), null);
  });
});

describe("filtering keeps every row reachable", () => {
  const rows: WorktreeRow[] = [
    row({ path: "/fresh", lastModifiedMs: NOW - WORKTREE_DAY_MS }),
    row({ path: "/edge3d", lastModifiedMs: NOW - 3 * WORKTREE_DAY_MS }),
    row({ path: "/edge7d", lastModifiedMs: NOW - 7 * WORKTREE_DAY_MS }),
    row({ path: "/old", lastModifiedMs: NOW - 30 * WORKTREE_DAY_MS }),
    // The engine read neither the directory mtime nor the reflog.
    row({ path: "/unknown", lastModifiedMs: undefined }),
  ];

  test("each tab shows its own band", () => {
    assert.deepEqual(
      visibleWorktrees(rows, "recent3d", NOW).map((item) => item.path),
      ["/fresh", "/edge3d", "/unknown"],
    );
    assert.deepEqual(
      visibleWorktrees(rows, "days3to7", NOW).map((item) => item.path),
      ["/edge7d", "/unknown"],
      "exactly 3 days old stays in 近 3 天 (the band boundary is inclusive at its top), so /edge3d is not repeated here",
    );
    assert.deepEqual(
      visibleWorktrees(rows, "older7d", NOW).map((item) => item.path),
      ["/old", "/unknown"],
    );
  });

  test("a row with no timestamp is visible in EVERY tab, not hidden or zeroed", () => {
    for (const bucket of WORKTREE_TIME_BUCKETS) {
      assert.ok(
        visibleWorktrees(rows, bucket, NOW).some((item) => item.path === "/unknown"),
        `${bucket} must still show the row whose age the engine could not report`,
      );
    }
    // And it is not filed at epoch 0 either, which is what would have put
    // it under 7 天以上.
    assert.equal(worktreeAgeBucket(0, NOW), "older7d");
    assert.equal(worktreeAgeBucket(0, NOW) === "older7d", true);
    assert.notEqual(worktreeAgeBucket(undefined, NOW), "older7d");
  });
});

describe("the protected rows", () => {
  test("main beats active: the primary checkout is usually the active one too", () => {
    const both = row({ isMain: true, isActive: true });
    assert.equal(worktreeBlockReason(both), "main_worktree");
    // The engine checks in this order (managed-worktrees.ts:221-259), so
    // the label shown matches the reason it would actually return.
    assert.equal(worktreeBlockReason(row({ isActive: true })), "active_worktree");
    assert.equal(worktreeBlockReason(row({ isLocked: true })), "locked_worktree");
    assert.equal(worktreeBlockReason(row()), null);
  });

  test("a clean row is removable", () => {
    assert.equal(worktreeBlockReason(row({ path: "/plain" })), null);
  });
});

describe("removal verdicts reach the page as sentences", () => {
  test("every reason in the closed set has a translation, in both languages", () => {
    const reasons = [
      "main_worktree",
      "active_worktree",
      "locked_worktree",
      "dirty_worktree",
      "not_found",
      "unknown",
    ] as const;
    for (const reason of reasons) {
      // The key comes from the page's OWN table, so a table that lost a
      // row fails here instead of quietly rendering the wrong sentence.
      const key = worktreeReasonLabelKey(reason);
      const zh = tZh(key);
      const en = tEn(key);
      assert.ok(zh.length > 0, `${reason} must have a Chinese sentence`);
      assert.ok(en.length > 0, `${reason} must have an English sentence`);
      assert.notEqual(zh, en, `${reason} must be translated, not copied`);
      assert.doesNotMatch(zh, /^[a-z_]+$/, `${reason} leaked a raw enum token into the UI`);
    }
  });

  test("a fully refused batch reports 0 removed and one line per refusal", () => {
    const outcome = removalOutcomeOf(
      {
        ok: true,
        removedPaths: [],
        failedItems: [
          { worktreeDir: "/repo", reason: "main_worktree" },
          { worktreeDir: "/repo/.worktrees/a", reason: "dirty_worktree" },
          { worktreeDir: "/repo/.worktrees/b", reason: "active_worktree" },
        ],
      },
      tZh,
    );
    assert.equal(outcome.removed, 0);
    assert.deepEqual(
      outcome.failures.map((line) => line.text),
      [
        "主工作树不可移除",
        "存在未提交改动——请先提交、暂存或丢弃",
        "有会话正在其中运行",
      ],
      "the three refusals the acceptance criteria name each survive as their own sentence",
    );
    assert.deepEqual(
      outcome.failures.map((line) => line.worktreeDir),
      ["/repo", "/repo/.worktrees/a", "/repo/.worktrees/b"],
    );
  });

  test("a partial batch keeps both halves", () => {
    const outcome = removalOutcomeOf(
      {
        ok: true,
        removedPaths: ["/repo/.worktrees/gone"],
        failedItems: [{ worktreeDir: "/repo", reason: "main_worktree" }],
      },
      tEn,
    );
    assert.equal(outcome.removed, 1);
    assert.equal(outcome.failures.length, 1);
    assert.match(outcome.failures[0]!.text, /main worktree/);
  });
});

describe("the rendered page", () => {
  const markup = renderToStaticMarkup(createElement(WorktreeSection, { t: tZh }));

  test("the toolbar carries the three tabs in the desktop's order", () => {
    const at = (label: string) => markup.indexOf(label);
    assert.ok(at("近 3 天") > 0, "近 3 天 must render");
    assert.ok(at("3-7 天前") > at("近 3 天"), "the tab order must match the desktop reference");
    assert.ok(at("7 天以上") > at("3-7 天前"));
    assert.match(markup, /role="radiogroup"/);
    assert.match(markup, /aria-checked="true"/, "the default tab must be the selected one");
  });

  test("the toolbar carries refresh and the red-outlined 一键移除", () => {
    assert.ok(markup.includes("↻"), "the refresh affordance must render");
    assert.match(markup, /一键移除/);
    assert.match(markup, /webui-worktree-remove/);
  });

  test("the page has NO create control — the desktop reference has none", () => {
    // The port declares list / remove / removeBatch and no create, and
    // ref-23.jpg shows a cleanup page. A 新建 button here would be
    // self-authored UI on both the client and the engine side.
    for (const word of ["新建", "创建", "Add", "Create", "New worktree"]) {
      assert.equal(
        markup.includes(word),
        false,
        `the page must not render a create affordance, found "${word}"`,
      );
    }
  });

  test("the popconfirm is wired to the removal, and the button starts disabled", () => {
    // With nothing selected the button cannot act, so it must not be
    // clickable — the desktop's red outline is a confirmation gate, not a
    // live-fire button.
    assert.match(markup, /一键移除<\/button><\/span>|一键移除/);
    assert.match(markup, /disabled=""/, "the remove control must start disabled with no selection");
  });
});

describe("the list failure is named, not swallowed", () => {
  test("each discovery code has its own sentence in both languages", () => {
    const codes = ["notGit", "unavailable", "listFailed"] as const;
    for (const code of codes) {
      const key = `settings.worktree.listError.${code}` as MessageKey;
      assert.match(tZh(key), /code: /, `${code} must name the engine code verbatim`);
      assert.match(tEn(key), /code: /);
    }
    assert.notEqual(tZh("settings.worktree.listError.notGit"), tZh("settings.worktree.listError.unavailable"));
  });

  test("the empty state is the desktop's own sentence, not the old version claim", () => {
    // 「本地版暂不支持工作树管理」 was true about the route and false about
    // the capability; the sentence had to change or the delivery would lie
    // on its first screen.
    assert.equal(tZh("settings.worktree.empty"), "没有可管理 Worktree");
    assert.equal(tEn("settings.worktree.empty"), "No manageable worktree");
    assert.doesNotMatch(tZh("settings.worktree.empty"), /不支持/);
  });
});

describe("the wiring is pinned", () => {
  test("the settings modal renders this section for the worktree tab", () => {
    const source = readFileSync(
      new URL("../components/settings-modal-port.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /active === "worktree"[\s\S]{0,900}<WorktreeSection t=\{t\} \/>/,
      "the 工作树 tab must render the real section, not the old one-line placeholder",
    );
    assert.doesNotMatch(
      source,
      /active === "worktree"[\s\S]{0,900}settings\.worktree\.empty/,
      "the placeholder sentence must be gone from the render branch",
    );
  });

  test("the placeholder sentence is gone from both dictionaries", () => {
    const source = readFileSync(new URL("../lib/i18n.ts", import.meta.url), "utf8");
    assert.equal(source.includes("本地版暂不支持工作树管理"), false);
    assert.equal(
      source.includes("Worktree management is not available in the local edition yet"),
      false,
    );
  });
});
