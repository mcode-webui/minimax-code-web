// webapp/test/edited-files-card.test.ts
//
// The 「已编辑 N 个文件」 card, per turn (ticket 77 G3 of 61; webui-parity 83).
//
// The card is the one place in the transcript surface that must NOT invent
// numbers. It has two sources now — the transcript's own scan of which paths a
// turn's edit tools named, and the engine's per-turn record (real `+N`/`-N`
// plus the `canUndo` / `canReapply` gates) — and one rule between them:
//
//   * the engine record REPLACES the scan, it never merges with it. Picking
//     one authority per turn is what stops the header count and the line
//     totals describing two different file sets;
//   * no record → the ticket-77 card and nothing else. No `+0`, no disabled
//     button, no "this turn changed nothing" claim.
//
// So the suite pins the derivations, both renderings, and the three absences
// that keep it honest — plus the wiring in chat.tsx, because a card whose
// button is gated on anything but the engine's own flag is the dead control
// this repository already had to delete once (ticket 114).
//
// createElement, not JSX: this is a `.test.ts` file (the test:webapp glob is
// `**/*.test.ts`) and the tsx loader only transpiles JSX in `.tsx`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RenderUnit, TranscriptBlock } from "../lib/transcript";

// components/icons.tsx (pulled in through the card's graph) compiles its JSX
// under the classic runtime in this process, which resolves a bare `React`
// identifier. Stub the ambient global through a typed alias rather than
// re-declaring it (a `var React` narrower than the lib's fails tsc), and do
// it BEFORE the component modules load — hence the dynamic imports.
{
  const reactModule = React;
  Object.defineProperty(globalThis, "React", {
    value: reactModule,
    configurable: true,
    writable: true,
  });
}

const { EditedFilesCard, reduceEditedFilesCardState, initialEditedFilesCardState, COLLAPSED_FILE_ROWS } =
  await import("../components/edited-files-card");
const {
  collectEditedFilesByTurn,
  isTurnTailUnit,
  resolveEditedFiles,
  totalLineChanges,
  turnCoordinatesByTurn,
} = await import("../lib/edited-files");
type EditedFiles = import("../lib/edited-files").EditedFiles;
const { computeTurnLayout } = await import("../lib/turn-stats");
const { normaliseTurnDiff } = await import("../lib/turn-diff");
const { NAMED_EVENTS, parseSseFrame } = await import("../lib/sse");
const { __testApplyAction, __testReset, __testSnapshot } = await import("../lib/store");
type TurnDiff = import("../lib/turn-diff").TurnDiff;
const { translate } = await import("../lib/i18n");
const { groupActivity, isFileEditTool, summarizeActivity, decodeTranscript } = await import("../lib/transcript");

const here = dirname(fileURLToPath(import.meta.url));
const chatSource = readFileSync(resolve(here, "../components/chat.tsx"), "utf8");
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");
const sseSource = readFileSync(resolve(here, "../lib/sse.ts"), "utf8");
const panelsSource = readFileSync(resolve(here, "../components/panels.tsx"), "utf8");
const previewSource = readFileSync(resolve(here, "../components/file-preview.tsx"), "utf8");

const t = (key: Parameters<typeof translate>[1]) => translate("zh", key);
const noop = () => {};

// --- fixtures -------------------------------------------------------------

function editBlock(name: string, ...paths: string[]): TranscriptBlock {
  return {
    role: "tool",
    text: `→ ${name}`,
    toolName: name,
    toolArgs: "{}",
    toolStatus: "completed",
    toolOutput: [],
    toolPaths: paths,
  };
}

function readBlock(path: string): TranscriptBlock {
  return editBlock("read_file", path);
}

function shellBlock(text: string): TranscriptBlock {
  return { role: "assistant", text };
}

function userBlock(text: string): TranscriptBlock {
  return { role: "user", text };
}

/** Fold blocks into units the way chat.tsx does. */
function unitsOf(...blocks: TranscriptBlock[]): RenderUnit[] {
  return groupActivity(blocks);
}

/** The transcript's own scan for a SINGLE-turn transcript — the tier that
 *  every turn with no engine record renders. A transcript that opens with a
 *  user block is turn 1 by `computeTurnLayout`'s own counting (it starts at 0
 *  and increments on the first user block), so the fixture matches what the
 *  decoder actually produces. */
function scanOf(...blocks: TranscriptBlock[]): EditedFiles {
  const units = unitsOf(userBlock("q"), ...blocks);
  const { turnIndexByUnit } = computeTurnLayout(units);
  const byTurn = collectEditedFilesByTurn(units, turnIndexByUnit);
  assert.equal(byTurn.size <= 1, true, "the fixture is one turn");
  return byTurn.get(1) ?? [];
}

function renderCard(files: EditedFiles, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(EditedFilesCard, { files, t, onOpenFile: noop, ...props }),
  );
}

/** An engine record shaped exactly like the runtime's answer. */
function engineRecord(
  files: { file: string; additions: number; deletions: number }[],
  gates: { canUndo?: boolean; canReapply?: boolean } = {},
): TurnDiff {
  const diff = normaliseTurnDiff({
    changeSetId: "cs_test",
    sourceMessageId: "m1",
    status: "active",
    undoable: true,
    fileChanges: files,
    ...gates,
  });
  assert.ok(diff, "the fixture must normalise to a record");
  return diff;
}

/**
 * Exactly what `chat.tsx` hands the card for a turn WITH a record: the
 * resolved files, plus the engine's own gate values copied through untouched.
 * Deriving the props from the record (rather than hard-coding `canUndo`) is
 * what keeps the suite honest — a card that drew a button the engine had not
 * enabled would still pass a test that set the prop by hand.
 */
function engineCard(
  files: { file: string; additions: number; deletions: number }[],
  gates: { canUndo?: boolean; canReapply?: boolean } = {},
) {
  const diff = engineRecord(files, gates);
  return {
    files: resolveEditedFiles([], diff),
    props: {
      canUndo: diff.canUndo === true,
      canReapply: diff.canReapply === true,
      onUndo: noop,
      onRedo: noop,
    },
  };
}

// --- 1. the scan is truthful ----------------------------------------------

describe("the transcript scan reports only paths the turn's edit tools named", () => {
  test("collects the paths of an edit tool call", () => {
    const files = scanOf(editBlock("edit_file", "/ws/src/a.ts"), editBlock("write_file", "/ws/src/b.ts"));
    assert.deepEqual(
      files.map((f) => f.path),
      ["/ws/src/a.ts", "/ws/src/b.ts"],
    );
  });

  test("counts a file once however many times it was edited", () => {
    const files = scanOf(
      editBlock("edit_file", "/ws/src/a.ts"),
      editBlock("edit_file", "/ws/src/b.ts"),
      editBlock("edit_file", "/ws/src/a.ts"),
    );
    assert.deepEqual(
      files.map((f) => f.path),
      ["/ws/src/a.ts", "/ws/src/b.ts"],
    );
  });

  test("folds a separator style so one file cannot read as two", () => {
    assert.equal(scanOf(editBlock("edit_file", "/ws/src/a.ts"), editBlock("edit_file", "\\ws\\src\\a.ts")).length, 1);
  });

  test("ignores tools that are not edits", () => {
    assert.deepEqual(scanOf(readBlock("/ws/src/read-only.ts"), editBlock("bash"), shellBlock("done")), []);
  });

  test("an edit call that named no path contributes nothing, not a blank row", () => {
    assert.deepEqual(scanOf(editBlock("edit_file")), []);
  });

  test("a turn with no tools yields an empty list", () => {
    assert.deepEqual(scanOf(shellBlock("hello")), []);
    assert.equal(collectEditedFilesByTurn([], []).size, 0);
  });

  test("the card and the activity summary agree on what an edit is", () => {
    for (const name of ["edit", "edit_file", "write_file", "create_file", "apply_patch", "multi_edit", "notebook_edit"]) {
      const summary = summarizeActivity([editBlock(name, "/ws/x.ts")]);
      const edited = summary.contributions.find((c) => c.category === "file-edit");
      assert.equal(edited !== undefined, isFileEditTool(name), `category agreement for ${name}`);
    }
    for (const name of ["bash", "read_file", "web_search", "task", undefined]) {
      assert.equal(isFileEditTool(name), false, `${String(name)} is not an edit`);
    }
  });

  test("each turn keeps its OWN files — the scan is per turn, not per session", () => {
    const units = unitsOf(
      userBlock("q1"),
      editBlock("edit_file", "/ws/first.ts"),
      shellBlock("a1"),
      userBlock("q2"),
      editBlock("edit_file", "/ws/second.ts"),
      shellBlock("a2"),
    );
    const { turnIndexByUnit } = computeTurnLayout(units);
    const byTurn = collectEditedFilesByTurn(units, turnIndexByUnit);
    assert.deepEqual(byTurn.get(1)?.map((f) => f.path), ["/ws/first.ts"]);
    assert.deepEqual(byTurn.get(2)?.map((f) => f.path), ["/ws/second.ts"]);
  });
});

// --- 2. honest degradation (constraint 1) ----------------------------------

describe("with no engine record the card stays the path-only card", () => {
  test("renders nothing when no file was edited", () => {
    assert.equal(renderCard([]), "");
  });

  test("no +0 and no -0 anywhere — an unknown count is not zero", () => {
    const markup = renderCard(scanOf(editBlock("edit_file", "/ws/a.ts")));
    assert.ok(markup.includes('data-has-turn-diff="false"'), "the card says it has no record");
    assert.ok(!markup.includes(">+0<"), "no invented added-lines badge");
    assert.ok(!markup.includes(">-0<"), "no invented deleted-lines badge");
    assert.ok(!/edited-files-card-(row-)?additions/.test(markup), "no counts element at all");
  });

  test("totalLineChanges answers null for a scanned turn, not 0/0", () => {
    assert.equal(totalLineChanges(scanOf(editBlock("edit_file", "/ws/a.ts"))), null);
    assert.equal(totalLineChanges([]), null);
  });

  test("no undo or redo button — there is no gate to honour", () => {
    const markup = renderCard(scanOf(editBlock("edit_file", "/ws/a.ts")));
    assert.ok(!markup.includes("撤销"), "the undo control must not be drawn");
    assert.ok(!markup.includes("重做"), "the redo control must not be drawn");
    assert.ok(!markup.includes("edited-files-card-actions"));
  });

  test("a gate WITHOUT a handler draws nothing — a button with no click path is dead", () => {
    // A caller that passes canUndo but no onUndo is a wiring bug; the card
    // answers it with no button rather than an inert one (#114).
    const markup = renderCard(scanOf(editBlock("edit_file", "/ws/a.ts")), { canUndo: true });
    assert.ok(!markup.includes("edited-files-card-undo"));
    const withHandler = renderCard(scanOf(editBlock("edit_file", "/ws/a.ts")), {
      canUndo: true,
      onUndo: noop,
    });
    assert.ok(withHandler.includes("edited-files-card-undo"));
  });

  test("an unknown coordinate never becomes another turn's numbers", () => {
    // The engine answers an id it does not know with an all-undefined view
    // and the route answers `turnDiff: null` when there was no id at all.
    // Neither shape may reach the counts path.
    assert.equal(normaliseTurnDiff(null), null);
    assert.equal(normaliseTurnDiff({ fileChanges: [] }), null);
    assert.equal(normaliseTurnDiff({ changeSetId: "", fileChanges: [] }), null);
    assert.equal(totalLineChanges(resolveEditedFiles([], null)), null);
    const markup = renderCard(resolveEditedFiles([], null));
    assert.equal(markup, "");
  });

  test("no reference-only state attributes", () => {
    const markup = renderCard(scanOf(editBlock("edit_file", "/ws/a.ts")));
    assert.ok(!markup.includes("data-change-set-id"));
    assert.ok(!markup.includes("data-webui-diff-state"));
  });
});

// --- 3. with a record, the four elements appear ---------------------------

describe("with an engine record the card carries real numbers and real controls", () => {
  const twoFiles = [
    { file: "/ws/src/a.ts", additions: 12, deletions: 3 },
    { file: "/ws/src/b.ts", additions: 0, deletions: 4 },
  ];
  const record = () => engineCard(twoFiles, { canUndo: true });

  test("the header totals add up the turn's real line counts", () => {
    const card = record();
    const markup = renderCard(card.files, card.props);
    assert.ok(markup.includes('data-has-turn-diff="true"'));
    assert.ok(markup.includes(">+12<"), "12 + 0 additions across files");
    assert.ok(markup.includes(">-7<"), "3 + 4 deletions across files");
  });

  test("a header side at zero is not drawn either", () => {
    const card = engineCard([{ file: "/ws/a.ts", additions: 4, deletions: 0 }]);
    const markup = renderCard(card.files, card.props);
    assert.ok(markup.includes(">+4<"));
    assert.ok(!markup.includes(">-0<"), "an additions-only turn draws no -0 in the header");
  });

  test("each row carries its own counts", () => {
    const card = record();
    const markup = renderCard(card.files, card.props);
    assert.ok(markup.includes(">+12<") && markup.includes(">-3<"), "a.ts row");
    assert.ok(markup.includes(">-4<"), "b.ts row has no additions to draw");
  });

  test("a side at zero draws no badge at all", () => {
    const card = engineCard([{ file: "/ws/added.txt", additions: 5, deletions: 0 }]);
    const markup = renderCard(card.files, card.props);
    const row = markup.slice(markup.indexOf("added.txt"));
    assert.ok(!row.includes(">-0<"), "an added-only file draws no -0");
  });

  test("a recorded file with no line movement draws no counts element at all", () => {
    // A real record CAN carry a +0/-0 file (a rename, a mode change). The row
    // must not leave an empty counts wrapper behind — the header totals are
    // still drawn, because the record exists and its total is a real 0.
    const card = engineCard([{ file: "/ws/renamed.ts", additions: 0, deletions: 0 }]);
    const markup = renderCard(card.files, card.props);
    const row = markup.slice(markup.indexOf("renamed.ts"));
    assert.ok(!row.includes("edited-files-card-row-additions"), "no counts element in a 0/0 row");
    assert.ok(!row.includes("-wrapper"), "not even an empty counts wrapper is left behind");
    assert.ok(!markup.includes("edited-files-card-totals"), "and no header total either");
  });

  test("the undo button is drawn, and only because the engine said canUndo", () => {
    const card = record();
    const markup = renderCard(card.files, card.props);
    assert.ok(markup.includes('data-testid="edited-files-card-undo"'));
    assert.ok(markup.includes("\u64a4\u9500"));
    assert.ok(markup.includes('data-can-undo="true"'));
  });

  test("the redo button is driven by canReapply, independently", () => {
    const undoOnly = record();
    const undoMarkup = renderCard(undoOnly.files, undoOnly.props);
    assert.ok(undoMarkup.includes("edited-files-card-undo"));
    assert.ok(!undoMarkup.includes("edited-files-card-redo"), "canReapply was not set");
    assert.ok(undoMarkup.includes('data-can-reapply="false"'));

    const redoCard = engineCard(twoFiles, { canUndo: true, canReapply: true });
    const redoMarkup = renderCard(redoCard.files, redoCard.props);
    assert.ok(redoMarkup.includes("edited-files-card-redo"), "canReapply draws it");
    assert.ok(redoMarkup.includes("\u91cd\u505a"));
  });

  test("a disabled-looking button is never drawn (constraint 3)", () => {
    // canUndo=false must produce ABSENCE, not `disabled`. A greyed control
    // promises an action the engine has already refused with 409.
    for (const gates of [{}, { canUndo: false }, { canReapply: false }, { canUndo: false, canReapply: false }]) {
      const card = engineCard(twoFiles, gates);
      const markup = renderCard(card.files, card.props);
      assert.ok(!markup.includes("edited-files-card-undo"), `undo absent for ${JSON.stringify(gates)}`);
      assert.ok(!markup.includes("edited-files-card-redo"), `redo absent for ${JSON.stringify(gates)}`);
      assert.ok(!markup.includes("disabled"), "nothing is drawn disabled");
    }
  });

  test("a refused mutation is shown with the engine's own sentence", () => {
    const card = record();
    const markup = renderCard(card.files, {
      ...card.props,
      error: { kind: "conflict", message: "Only the latest turn diff can be changed" },
    });
    assert.ok(markup.includes("Only the latest turn diff can be changed"), "verbatim, not paraphrased");
    assert.ok(markup.includes('data-error-kind="conflict"'));
    assert.ok(markup.includes("\u6539\u52a8\u672a\u751f\u6548"));
  });

  test("an in-flight mutation is labelled, not silently dropped", () => {
    const card = record();
    const markup = renderCard(card.files, { ...card.props, busy: true });
    assert.ok(markup.includes("\u6b63\u5728\u5e94\u7528"));
    assert.ok(markup.includes('aria-busy="true"'));
  });

  test("the record REPLACES the scan, it never merges with it", () => {
    // A tool that named a path the engine never captured (the write failed)
    // must not linger as a row, and a file the engine captured that no tool
    // block named must not be dropped.
    const scanned = scanOf(editBlock("edit_file", "/ws/asked-but-absent.ts"));
    const resolved = resolveEditedFiles(
      scanned,
      engineRecord([{ file: "/ws/captured-only.ts", additions: 2, deletions: 0 }]),
    );
    assert.deepEqual(
      resolved.map((f) => f.path),
      ["/ws/captured-only.ts"],
    );
    assert.equal(resolved[0]?.additions, 2);
  });

  test("an empty record with a changeSetId still lists nothing (no phantom card)", () => {
    assert.deepEqual(resolveEditedFiles([], engineRecord([])), []);
    assert.equal(renderCard(resolveEditedFiles([], engineRecord([]))), "");
  });

  test("totalLineChanges refuses to total a partially-counted list", () => {
    const mixed: EditedFiles = [
      { path: "/ws/a.ts", name: "a.ts", additions: 3, deletions: 1 },
      { path: "/ws/b.ts", name: "b.ts" },
    ];
    assert.equal(totalLineChanges(mixed), null);
  });
});

// --- 4. where the card hangs, and which turn it asks about ----------------

describe("the card hangs off the turn's LAST unit and asks by coordinate", () => {
  const threeTurns = (): RenderUnit[] =>
    unitsOf(
      userBlock("q1"),
      editBlock("edit_file", "/ws/first.ts"),
      shellBlock("a1"),
      userBlock("q2"),
      editBlock("edit_file", "/ws/second.ts"),
      shellBlock("a2"),
    );

  test("only a turn's last unit carries its card", () => {
    const units = threeTurns();
    const { turnIndexByUnit } = computeTurnLayout(units);
    const tails = turnIndexByUnit.map((_, index) => index).filter((index) => isTurnTailUnit(turnIndexByUnit, index));
    assert.deepEqual(tails, [2, 5], "turn 1 ends at the 'a1' block, turn 2 at 'a2'");
  });

  test("an index past the end is not a tail, and a gap in the layout is not either", () => {
    assert.equal(isTurnTailUnit([0, 0, 1], 2), true, "the final unit of the layout is a tail");
    assert.equal(isTurnTailUnit([0, 0, 1], 9), false, "an index the layout never covered");
  });

  test("the coordinate is the turn's LAST assistant block, not its first", () => {
    // The engine keys a turn's record under its final assistant message id, so
    // asking with the first block's id selects nothing.
    const units = unitsOf(
      userBlock("q"),
      { role: "assistant", text: "first", assistantMessageId: "m-first" },
      editBlock("edit_file", "/ws/a.ts"),
      { role: "assistant", text: "last", assistantMessageId: "m-last" },
    );
    const { turnIndexByUnit } = computeTurnLayout(units);
    const coordinates = turnCoordinatesByTurn(units, turnIndexByUnit);
    assert.equal(coordinates.get(1), "m-last");
    assert.equal(coordinates.size, 1);
  });

  test("a turn with no marker has no coordinate and is never queried", () => {
    const units = unitsOf(userBlock("q"), editBlock("edit_file", "/ws/a.ts"), shellBlock("a"));
    const { turnIndexByUnit } = computeTurnLayout(units);
    assert.equal(turnCoordinatesByTurn(units, turnIndexByUnit).has(1), false);
  });

  test("each turn's coordinate is its own", () => {
    // Built from a real decode so the marker → block wiring is exercised, not
    // just the helper. If a marker were attached to the wrong turn, these two
    // ids would come back swapped or equal.
    const lines = [
      "› q1",
      "● a1",
      "§§ processed_duration=900ms",
      "§§ turn_msg=id-one",
      "› q2",
      "● a2",
      "§§ processed_duration=800ms",
      "§§ turn_msg=id-two",
    ];
    const units = groupActivity(decodeTranscript(lines, { workspaceDir: "/ws" }));
    const { turnIndexByUnit } = computeTurnLayout(units);
    const coordinates = turnCoordinatesByTurn(units, turnIndexByUnit);
    assert.equal(coordinates.get(1), "id-one");
    assert.equal(coordinates.get(2), "id-two");
  });
});

// --- 5. the mount is real -------------------------------------------------

describe("chat.tsx mounts one card per turn, gated on the engine", () => {
  test("the card's data comes from the turn scan plus the engine record", () => {
    assert.ok(chatSource.includes('from "@/lib/edited-files"'), "imports the derivations");
    assert.ok(chatSource.includes("turnCoordinatesByTurn(units, turnIndexByUnit)"), "coordinate per turn");
    assert.ok(chatSource.includes("collectEditedFilesByTurn(units, turnIndexByUnit)"), "scan per turn");
    assert.ok(chatSource.includes("resolveEditedFiles("), "the record resolves the scan");
    assert.ok(chatSource.includes("useTurnDiffs("), "the engine is asked once per coordinate");
    // Never the virtualized window: a card that appears and vanishes as the
    // user scrolls would be worse than no card.
    assert.ok(!/collectEditedFilesByTurn\(visibleUnits/.test(chatSource));
  });

  test("the card renders on the turn's tail unit, inside the render loop", () => {
    const mounts = chatSource.match(/<EditedFilesCard\b/g) ?? [];
    assert.equal(mounts.length, 1, "exactly one mount point");
    assert.ok(
      /isTurnTailUnit\(turnIndexByUnit, originalIndex\)/.test(chatSource),
      "gated on the turn's last unit",
    );
    const loop = chatSource.indexOf("visibleUnits.map(");
    const card = chatSource.indexOf("<EditedFilesCard");
    assert.ok(loop !== -1 && card > loop, "the card renders per unit, not once at the end");
  });

  test("the gates are the engine's, passed through verbatim", () => {
    // Constraint 3: no turn ordinal anywhere near the gate. If the client
    // decided "is this the last turn", a replayed or restored session would
    // show a button the engine refuses with 409.
    assert.ok(chatSource.includes("canUndo={diffs.get(turnIndex)?.canUndo === true}"));
    assert.ok(chatSource.includes("canReapply={diffs.get(turnIndex)?.canReapply === true}"));
    for (const forbidden of ["isLastTurn", "lastTurnIndex", "turns.length - 1 ===", "isFinalTurn"]) {
      assert.ok(!chatSource.includes(forbidden), `chat.tsx must not infer ${forbidden}`);
    }
  });

  test("the whole-transcript card mount is gone", () => {
    assert.ok(!/\{editedFiles\.length > 0 \? \(/.test(chatSource), "no session-wide card at the tail");
  });
});

// --- 6. the four-step refresh is actually wired ---------------------------

describe("a revert refreshes the file tree, the preview, the git panel and the tree cache", () => {
  test("the server's named frame is a known SSE event", () => {
    // A name absent from NAMED_EVENTS is never delivered by the browser at
    // all, so the registration is part of the contract, not a comment.
    assert.ok((NAMED_EVENTS as readonly string[]).includes("workspace-files-changed"));
  });

  test("the frame parses into its own action, not into 'ignored'", () => {
    // Asserting the source merely CONTAINS the case label would still pass
    // with a handler that returns `ignored` — the exact regression where the
    // frame arrives and nobody acts on it. Drive the parser instead.
    assert.equal(parseSseFrame("workspace-files-changed", "{}").kind, "workspace-files-changed");
    assert.equal(parseSseFrame("workspace-files-changed", "").kind, "workspace-files-changed");
    // A genuinely broken body is surfaced rather than swallowed, so the
    // connection is not left silently dead.
    assert.equal(parseSseFrame("workspace-files-changed", "{oops").kind, "malformed");
  });

  test("the frame becomes a counter the panels can watch", () => {
    __testReset();
    const before = __testSnapshot().workspaceRevision;
    __testApplyAction({ kind: "workspace-files-changed" });
    assert.equal(__testSnapshot().workspaceRevision, before + 1);
    // Its own counter: an unrelated frame must not move it, or a subagent row
    // would re-read the whole file tree.
    __testApplyAction({ kind: "tree-changed" });
    assert.equal(__testSnapshot().workspaceRevision, before + 1, "tree-changed does not touch it");
    __testApplyAction({ kind: "workspace-files-changed" });
    assert.equal(__testSnapshot().workspaceRevision, before + 2);
  });

  test("the file tree re-reads the root and every expanded directory", () => {
    assert.ok(/\[workspaceDir, workspaceRevision\]/.test(panelsSource), "keyed on the revision");
    assert.ok(
      /void fetchNode\(workspaceDir, \{ force: true \}\);\s*\n\s*for \(const path of expandedRef\.current\)/.test(panelsSource),
      "root plus the expanded set, both forced",
    );
  });

  test("the git panel re-reads status", () => {
    assert.ok(/const \{ state, workspaceRevision \} = useSessionContext\(\);/.test(panelsSource));
    assert.ok(/\[workspaceRevision\]\);/.test(panelsSource), "an effect keyed on the revision");
  });

  test("the open preview re-reads through the refresh channel", () => {
    assert.ok(previewSource.includes("const { workspaceRevision } = useSession();"));
    assert.ok(
      /\[workspaceRevision\]\);/.test(previewSource),
      "an effect keyed on the revision",
    );
    // The refresh channel is the honest one: scroll preserved, a missing file
    // reported, a dirty draft left alone.
    assert.ok(/void load\(\{ isRefresh: true \}\);/.test(previewSource));
  });
});

// --- 7. the card renders the files it can name ----------------------------

describe("the card renders the files it can name", () => {
  const one = () => scanOf(editBlock("edit_file", "/ws/src/deep/a.ts"));

  test("header carries the distinct-file count", () => {
    const files = scanOf(
      editBlock("edit_file", "/ws/a.ts"),
      editBlock("edit_file", "/ws/b.ts"),
      editBlock("edit_file", "/ws/a.ts"),
    );
    const markup = renderCard(files);
    assert.ok(markup.includes("已编辑2个文件"), `header count in ${markup}`);
    assert.ok(markup.includes('data-edited-files-count="2"'));
  });

  test("a file row shows the trailing segment, not the whole path", () => {
    const markup = renderCard(one());
    assert.ok(markup.includes(">a.ts<"), "basename in the row");
    assert.ok(markup.includes('title="/ws/src/deep/a.ts"'), "full path in the title");
  });

  test("the row is a real button that carries the absolute path", () => {
    const markup = renderCard(one());
    assert.ok(markup.includes('data-testid="edited-files-card-file"'));
    assert.ok(markup.includes('data-file-path="/ws/src/deep/a.ts"'));
    assert.ok(markup.includes("<button"), "an openable row is a button");
  });

  test("with no opener wired the row degrades to text, not to a dead button", () => {
    const markup = renderCard(one(), { onOpenFile: undefined });
    assert.ok(!markup.includes("<button"), "no clickable control without a handler");
    assert.ok(markup.includes('data-testid="edited-files-card-file"'));
  });

  test("collapses to the first rows and offers the toggle", () => {
    const files = scanOf(editBlock("edit_file", ...["/ws/a.ts", "/ws/b.ts", "/ws/c.ts", "/ws/d.ts", "/ws/e.ts"]));
    const markup = renderCard(files);
    assert.equal(COLLAPSED_FILE_ROWS, 3);
    assert.ok(markup.includes(">a.ts<") && markup.includes(">c.ts<"));
    assert.ok(!markup.includes(">d.ts<"), "rows past the fold are not rendered");
    assert.ok(markup.includes('data-testid="edited-files-card-toggle"'));
    assert.ok(markup.includes('data-expanded="false"'));
  });

  test("a short list needs no toggle", () => {
    const markup = renderCard(scanOf(editBlock("edit_file", "/ws/a.ts", "/ws/b.ts")));
    assert.ok(markup.includes(">a.ts<") && markup.includes(">b.ts<"));
    assert.ok(!markup.includes("edited-files-card-toggle"));
  });
});

// --- 8. the state machine -------------------------------------------------

describe("the card's state machine", () => {
  test("starts collapsed", () => {
    assert.deepEqual(initialEditedFilesCardState(), { expanded: false });
  });

  test("toggle-expanded expands, then collapses", () => {
    const first = reduceEditedFilesCardState(initialEditedFilesCardState(), { type: "toggle-expanded" });
    assert.deepEqual(first, { expanded: true });
    assert.deepEqual(reduceEditedFilesCardState(first, { type: "toggle-expanded" }), { expanded: false });
  });

  test("does not mutate the state it was handed", () => {
    const before = initialEditedFilesCardState();
    reduceEditedFilesCardState(before, { type: "toggle-expanded" });
    assert.deepEqual(before, { expanded: false });
  });
});

// --- 9. copy --------------------------------------------------------------

describe("the card reuses the existing copy and adds matching pairs", () => {
  test("both locales carry the same {{count}} sentence", () => {
    assert.equal(translate("en", "activity.editedFiles"), "Edited {{count}} files");
    assert.equal(translate("zh", "activity.editedFiles"), "已编辑{{count}}个文件");
  });

  test("the English side holds no Chinese", () => {
    for (const key of ["turnDiff.undo", "turnDiff.redo", "turnDiff.working", "turnDiff.error"] as const) {
      const en = translate("en", key);
      assert.ok(!/[一-鿿]/.test(en), `en value for ${key} carries Chinese: ${en}`);
    }
  });

  test("every new key exists in both dictionaries", () => {
    for (const key of ["turnDiff.undo", "turnDiff.redo", "turnDiff.working", "turnDiff.error"] as const) {
      const occurrences = (i18nSource.match(new RegExp(`"${key.replace(".", "\\.")}"`, "g")) ?? []).length;
      assert.equal(occurrences, 2, `${key} needs one en entry and one zh entry`);
      assert.notEqual(translate("zh", key), "", `${key} has a zh value`);
      assert.notEqual(translate("en", key), "", `${key} has an en value`);
    }
  });

  test("no duplicate edited-files key was added to either dictionary", () => {
    const occurrences = (i18nSource.match(/"activity\.editedFiles"/g) ?? []).length;
    assert.equal(occurrences, 2, "one en entry, one zh entry — no new key");
  });
});
