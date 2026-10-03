// webapp/test/project-reveal.test.ts
//
// SB-6 — the project right-click menu's 在文件夹中显示, unlocked.
//
// Three layers, in decreasing order of how much they can actually see:
//
//   1. BEHAVIOUR (`lib/project-reveal.ts`, driven directly). The
//      pre-check ("a project with no local directory fires no
//      request") and the failure reporting ("a refusal the server
//      states in a 4xx body is not a thrown error") are the two claims
//      this batch actually makes, and both are provable in node:test
//      with injected transports. This layer is the reason the logic
//      lives in its own module instead of inline in the component.
//
//   2. BILINGUAL COVERAGE. `projectMenu.revealUnavailableNoPath` is
//      the ONLY new user-visible string in this batch, and it is a
//      tooltip — the one place a disabled reason is stated. A zh
//      dictionary entry that silently falls back to English would ship
//      an English sentence as the only explanation of a greyed row.
//
//   3. STATIC-SOURCE TRIPWIRES. The render harness cannot mount an
//      antd popup, so the MENU WIRING is pinned on the source. These
//      are not a substitute for layers 1–2; they catch a different
//      failure, the one where the row stays grey (or gets re-wired to
//      nothing) while the helper below it stays perfectly green.
//
// The SESSION-level reveal is NOT in scope — the desktop reference
// disables it too (`session-tree.tsx`, `buildSessionContextMenu`), so
// it stays a placeholder. A test that "fixed" it would be inventing a
// product decision, and one that pinned it as live would be a lie; this
// file pins it as still-honest, which is the only claim SB-6 makes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { translate, type MessageKey } from "../lib/i18n";
import { projectRevealTarget, runProjectReveal, type ProjectRevealDeps } from "../lib/project-reveal";
import type { FileOpenResult, TreeProject } from "../lib/api";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");
const treeSrc = read("../components/session-tree.tsx");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project = (overrides: Partial<TreeProject> = {}): TreeProject => ({
  key: "p1",
  name: "repo",
  repoPaths: ["/w/repo"],
  latestAt: 0,
  sessionCount: 1,
  directories: [
    { path: "/w/repo/src", name: "src", latestAt: 0, sessions: [] },
  ],
  ...overrides,
});

/** Collects what the component would have been told, and what was sent. */
function recorder(behaviour: (path: string) => Promise<FileOpenResult>) {
  const sent: string[] = [];
  const reported: Array<[string, unknown]> = [];
  const deps: ProjectRevealDeps = {
    reveal: (path) => {
      sent.push(path);
      return behaviour(path);
    },
    report: (label, cause) => {
      reported.push([label, cause]);
    },
  };
  return { deps, sent, reported };
}

const ok: FileOpenResult = { ok: true };

// ---------------------------------------------------------------------------
// 1. Behaviour — the pre-check and the failure path
// ---------------------------------------------------------------------------

describe("projectRevealTarget — which path a project row offers", () => {
  test("prefers the first repository root", () => {
    assert.equal(projectRevealTarget(project()), "/w/repo");
  });

  test("falls back to the first directory when no repo root is known", () => {
    const target = projectRevealTarget(
      project({ repoPaths: [], directories: [{ path: "/w/loose", name: "loose", latestAt: 0, sessions: [] }] }),
    );
    assert.equal(target, "/w/loose");
  });

  test("is empty when the project is bound to nothing local", () => {
    // The pre-check's premise. A project can reach the tree with no
    // repository root AND no directory (a session whose workspace the
    // engine no longer reports), and that is the ONLY state in which
    // the menu row is greyed.
    assert.equal(projectRevealTarget(project({ repoPaths: [], directories: [] })), "");
  });

  test("trims, so a padded path is not reported as empty", () => {
    assert.equal(projectRevealTarget(project({ repoPaths: ["  /w/repo  "] })), "/w/repo");
  });
});

describe("runProjectReveal — the request", () => {
  test("sends the target path and stays silent on success", async () => {
    const { deps, sent, reported } = recorder(async () => ok);
    assert.equal(await runProjectReveal("/w/repo", "Reveal in folder", deps), true);
    assert.deepEqual(sent, ["/w/repo"]);
    assert.deepEqual(reported, [], "a successful reveal has no banner to show");
  });

  test("fires NO request when the project has no local path", async () => {
    // The pre-check, behaviourally. Greying the row is a UI affordance;
    // this is the invariant, and it is asserted on the transport rather
    // than on the prop.
    const { deps, sent, reported } = recorder(async () => ok);
    assert.equal(await runProjectReveal("", "Reveal in folder", deps), false);
    assert.deepEqual(sent, [], "an empty path must not reach the server");
    assert.deepEqual(reported, [], "the row is already disabled; a banner would double-report");
  });

  test("fires NO request for a whitespace-only path", async () => {
    const { deps, sent } = recorder(async () => ok);
    assert.equal(await runProjectReveal("   ", "Reveal in folder", deps), false);
    assert.deepEqual(sent, []);
  });
});

describe("runProjectReveal — failures are reported, never swallowed", () => {
  test("a structured refusal (HTTP 4xx body) reports the server's reason", async () => {
    // `revealInFileManager` RESOLVES with `{ok: false}` on an HTTP error —
    // it does not reject. A try/catch-only implementation therefore
    // treats every containment refusal and every missing opener as
    // success, and the user watches a menu that did nothing. This is the
    // assertion that half exists for.
    const { deps, reported } = recorder(async () => ({
      ok: false,
      code: "out-of-bounds",
      error: "path escapes the workspace root",
    }));
    assert.equal(await runProjectReveal("/w/repo", "Reveal in folder", deps), false);
    assert.equal(reported.length, 1);
    assert.deepEqual(reported[0], ["Reveal in folder", "path escapes the workspace root"]);
  });

  test("a refusal with no message still reports, using the structured code", async () => {
    const { deps, reported } = recorder(async () => ({ ok: false, code: "no-opener" }));
    await runProjectReveal("/w/repo", "Reveal in folder", deps);
    assert.deepEqual(reported, [["Reveal in folder", "no-opener"]]);
  });

  test("a refusal with neither message nor code reports something", async () => {
    // Silence is the failure mode being guarded: `ok: false` with no
    // detail must still produce a banner, not an empty one.
    const { deps, reported } = recorder(async () => ({ ok: false }));
    await runProjectReveal("/w/repo", "Reveal in folder", deps);
    assert.equal(reported.length, 1);
    assert.equal(typeof reported[0]?.[1], "string");
  });

  test("a thrown transport error reports too", async () => {
    const { deps, reported } = recorder(async () => {
      throw new Error("Failed to fetch");
    });
    assert.equal(await runProjectReveal("/w/repo", "Reveal in folder", deps), false);
    assert.deepEqual(reported, [["Reveal in folder", new Error("Failed to fetch")]]);
  });

  test("the label passed through is the one the caller localized", async () => {
    // The banner says what failed, in the user's language. A helper that
    // hard-coded its own English label would be invisible to every other
    // assertion in this file.
    const { deps, reported } = recorder(async () => ({ ok: false, error: "nope" }));
    await runProjectReveal("/w/repo", "在文件夹中显示", deps);
    assert.equal(reported[0]?.[0], "在文件夹中显示");
  });
});

// ---------------------------------------------------------------------------
// 2. Bilingual coverage
// ---------------------------------------------------------------------------

const SB6_KEYS: MessageKey[] = [
  "projectMenu.revealInFolder",
  "projectMenu.revealUnavailableNoPath",
];

describe("SB-6 bilingual coverage", () => {
  test("every SB-6 key resolves in both locales", () => {
    for (const key of SB6_KEYS) {
      const en = translate("en", key);
      const zh = translate("zh", key);
      assert.ok(en && en !== key, `en is missing ${key}`);
      assert.ok(zh && zh !== key, `zh is missing ${key}`);
      assert.notEqual(en, zh, `${key} fell back to the English value in zh-CN`);
    }
  });

  test("the disabled reason names the actual condition, not the old one", () => {
    // `common.notLocal` — the string this item carried while it was a
    // placeholder — claimed the local edition cannot do this at all. The
    // reason a row is still grey must be the project having no local
    // directory, and the tooltip is the only place that is said.
    const en = translate("en", "projectMenu.revealUnavailableNoPath");
    const zh = translate("zh", "projectMenu.revealUnavailableNoPath");
    assert.match(en, /not linked to a local folder/i);
    assert.match(zh, /未关联本地文件夹/);
    for (const text of [en, zh]) {
      assert.doesNotMatch(text, /not applicable to the local edition|本地版不适用/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Static-source tripwires — the menu wiring
// ---------------------------------------------------------------------------

describe("SB-6 — the project menu row is wired", () => {
  /**
   * The PROJECT menu's source, isolated from the SESSION menu.
   *
   * Both menus live in one file and the project menu comes FIRST, so a
   * plain `indexOf('key: "reveal"')` on the whole file could read either
   * one — and reading the session row while asserting the project row is
   * a test that passes without covering anything. Same isolation
   * `session-context-actions.test.ts` applies for the same reason.
   */
  const projectMenuSrc = treeSrc.slice(
    treeSrc.indexOf("const menuItems: MenuProps[\"items\"]"),
    treeSrc.indexOf("const header ="),
  );

  /**
   * One row of the PROJECT menu, with its `//` comments stripped.
   *
   * Two things make a naive slice wrong here. The window has to stop at
   * the NEXT row (`archive`), or it runs into that row's own comment —
   * which names `common.notLocal` in order to explain why PB-1 moved
   * away from it, and this file asserts the string is gone from the
   * reveal row. And this row's own comment does the same thing for the
   * same reason. Both are prose about the history; neither is wiring.
   */
  const revealRow = (): string => {
    const start = projectMenuSrc.indexOf('key: "reveal"');
    assert.notEqual(start, -1, "the project menu row `reveal` is missing from session-tree.tsx");
    const end = projectMenuSrc.indexOf('key: "archive"', start);
    assert.notEqual(end, -1, "the project menu row after `reveal` is missing");
    return projectMenuSrc
      .slice(start, end)
      .replace(/^\s*\/\/.*$/gm, "")
      .trim();
  };

  test("the row is no longer hard-disabled", () => {
    const row = revealRow();
    assert.match(
      row,
      /disabled: !switchRepoPath/,
      "the row must be enabled by the pre-check, not disabled outright",
    );
    assert.doesNotMatch(
      row,
      /disabled: true/,
      "a hard `disabled: true` is the placeholder this batch removes",
    );
  });

  test("the click calls the helper with the project's own path", () => {
    const row = revealRow();
    // The mutation target: dropping the path argument still typechecks
    // (`target: string` would reject `undefined` only if the call were
    // removed entirely), so the source is pinned as well as driven.
    assert.match(
      row,
      /runProjectReveal\(switchRepoPath, t\("projectMenu\.revealInFolder"\)/,
      "the reveal must carry the resolved project path",
    );
    assert.match(
      row,
      /reveal: api\.revealInFileManager/,
      "the transport is the registered POST /api/fs/reveal client",
    );
    assert.match(
      row,
      /report: reportActionError/,
      "failures go to the same surface as the menu's other writes",
    );
  });

  test("the disabled state carries the accurate tooltip, not a guessed one", () => {
    const row = revealRow();
    assert.match(
      row,
      /title=\{switchRepoPath \? undefined : t\("projectMenu\.revealUnavailableNoPath"\)\}/,
    );
    assert.doesNotMatch(
      row,
      /common\.notLocal/,
      "`common.notLocal` is the expired claim SB-6 removes",
    );
  });

  test("the path comes from the shared helper, not a second copy of the rule", () => {
    // `switchRepoPath` now reads `projectRevealTarget(project)`. Two
    // copies of "first repo root, else first directory" in one file
    // would drift the moment a third caller appeared.
    assert.match(
      treeSrc,
      /const switchRepoPath = projectRevealTarget\(project\);/,
      "the row and the 切换目录 row must share one resolution rule",
    );
  });

  test("the SESSION-level reveal stays an honest placeholder", () => {
    // Out of scope by decision (`doc/settings-batch-plan.md` §4): the
    // desktop reference disables it too, so unlocking it would be
    // inventing a product decision. Pinned so a future batch that DOES
    // unlock it has to say so here rather than inherit this file's
    // silence.
    const sessionMenuSrc = treeSrc.slice(
      treeSrc.indexOf("function buildSessionContextMenu"),
      treeSrc.indexOf("/** Clipboard write that degrades"),
    );
    const at = sessionMenuSrc.indexOf('key: "reveal"');
    if (at === -1) return; // the row is absent — nothing to be wrong about
    const row = sessionMenuSrc.slice(at, at + 500).replace(/^\s*\/\/.*$/gm, "");
    assert.match(row, /disabled/);
    assert.doesNotMatch(
      row,
      /runProjectReveal/,
      "SB-6 does not unlock the session-level reveal",
    );
  });
});
