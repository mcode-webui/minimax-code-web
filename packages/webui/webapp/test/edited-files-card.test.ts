// webapp/test/edited-files-card.test.ts
//
// Tests for the 「已编辑 N 个文件」 summary card (ticket 77, G3 of ticket 61).
//
// The card is the one place in the transcript surface that must NOT invent
// numbers. Its data comes from `collectEditedFiles`, which reports only file
// paths the turn's edit tools actually named; the desktop's added/deleted
// badges and 撤销 button have no reachable data source or capability in this
// repo. So the suite pins three things deliberately:
//
//   - the derivation is truthful: distinct real paths, edit tools only, and
//     it agrees with the category table the activity summary already uses;
//   - the absences are absences: no diff badges, no undo button, no review
//     button, and an empty list renders nothing at all (A1);
//   - the mount is real: chat.tsx derives the card from the FULL unit list
//     (so virtual scrolling cannot make it flicker) and renders it as the
//     turn's last block.
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
const { collectEditedFiles } = await import("../lib/edited-files");
const { translate } = await import("../lib/i18n");
const { groupActivity, isFileEditTool, summarizeActivity } = await import("../lib/transcript");

const here = dirname(fileURLToPath(import.meta.url));
const chatSource = readFileSync(resolve(here, "../components/chat.tsx"), "utf8");
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");

const t = (key: Parameters<typeof translate>[1]) => translate("zh", key);
const noop = () => {};

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

/** Fold blocks into units the way chat.tsx does, so the tests exercise the
 *  same shape the card receives rather than hand-built units. */
function unitsOf(...blocks: TranscriptBlock[]): RenderUnit[] {
  return groupActivity(blocks);
}

function renderCard(
  files: ReturnType<typeof collectEditedFiles>,
  props: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    createElement(EditedFilesCard, { files, t, onOpenFile: noop, ...props }),
  );
}

// --- 1. the derivation is truthful ----------------------------------------

describe("collectEditedFiles reports only paths the turn's edit tools named", () => {
  test("collects the paths of an edit tool call", () => {
    const files = collectEditedFiles(
      unitsOf(editBlock("edit_file", "/ws/src/a.ts"), editBlock("write_file", "/ws/src/b.ts")),
    );
    assert.deepEqual(
      files.map((f) => f.path),
      ["/ws/src/a.ts", "/ws/src/b.ts"],
    );
  });

  test("counts a file once however many times it was edited", () => {
    // Three calls, two distinct files. The card header is a count of FILES;
    // a call count here would overstate the work the same way a stale
    // `activity.editedFiles` summary does.
    const files = collectEditedFiles(
      unitsOf(
        editBlock("edit_file", "/ws/src/a.ts"),
        editBlock("edit_file", "/ws/src/b.ts"),
        editBlock("edit_file", "/ws/src/a.ts"),
      ),
    );
    assert.equal(files.length, 2);
    assert.deepEqual(
      files.map((f) => f.path),
      ["/ws/src/a.ts", "/ws/src/b.ts"],
    );
  });

  test("folds a separator style so one file cannot read as two", () => {
    const files = collectEditedFiles(
      unitsOf(editBlock("edit_file", "/ws/src/a.ts"), editBlock("edit_file", "\\ws\\src\\a.ts")),
    );
    assert.equal(files.length, 1);
  });

  test("ignores tools that are not edits", () => {
    const files = collectEditedFiles(
      unitsOf(readBlock("/ws/src/read-only.ts"), editBlock("bash"), shellBlock("done")),
    );
    assert.deepEqual(files, []);
  });

  test("an edit call that named no path contributes nothing, not a blank row", () => {
    const files = collectEditedFiles(unitsOf(editBlock("edit_file")));
    assert.deepEqual(files, []);
  });

  test("a turn with no tools yields an empty list", () => {
    assert.deepEqual(collectEditedFiles(unitsOf(shellBlock("hello"))), []);
    assert.deepEqual(collectEditedFiles([]), []);
  });

  test("spans every activity run, not just the last", () => {
    const units = unitsOf(
      editBlock("edit_file", "/ws/first.ts"),
      shellBlock("interlude"),
      editBlock("edit_file", "/ws/second.ts"),
    );
    assert.equal(units.filter((u) => u.kind === "activity").length, 2);
    assert.deepEqual(
      collectEditedFiles(units).map((f) => f.path),
      ["/ws/first.ts", "/ws/second.ts"],
    );
  });

  test("the card and the activity summary agree on what an edit is", () => {
    // One classification, one answer. If `isFileEditTool` drifted from the
    // `TOOL_CATEGORY` table the activity header summarises, the same turn
    // would claim "edited 1 file" while listing none.
    for (const name of ["edit", "edit_file", "write_file", "create_file", "apply_patch", "multi_edit", "notebook_edit"]) {
      const summary = summarizeActivity([editBlock(name, "/ws/x.ts")]);
      const edited = summary.contributions.find((c) => c.category === "file-edit");
      assert.equal(edited !== undefined, isFileEditTool(name), `category agreement for ${name}`);
    }
    for (const name of ["bash", "read_file", "web_search", "task", undefined]) {
      assert.equal(isFileEditTool(name), false, `${String(name)} is not an edit`);
    }
  });
});

// --- 2. the absences are absences -----------------------------------------

describe("the card draws nothing it cannot back up", () => {
  test("renders nothing when no file was edited", () => {
    assert.equal(renderCard([]), "");
  });

  test("no added/deleted badge — the transcript carries no line counts", () => {
    // A green `+12` here would be a fabricated number. Assert the shape is
    // absent rather than asserting a testid merely exists.
    const markup = renderCard(collectEditedFiles(unitsOf(editBlock("edit_file", "/ws/a.ts"))));
    assert.ok(!markup.includes("webui-diff-add"));
    assert.ok(!/>\+\d+</.test(markup), "no added-lines badge in the markup");
    assert.ok(!/>-\d+</.test(markup), "no deleted-lines badge in the markup");
  });

  test("no 撤销 button — there is no per-turn revert to call", () => {
    const markup = renderCard(collectEditedFiles(unitsOf(editBlock("edit_file", "/ws/a.ts"))));
    assert.ok(!markup.includes("撤销"), "the undo control must not be drawn");
    assert.ok(!markup.includes("turn-diff-undo"));
  });

  test("no Review button — the file rows are the affordance we can honour", () => {
    const markup = renderCard(collectEditedFiles(unitsOf(editBlock("edit_file", "/ws/a.ts"))));
    assert.ok(!markup.includes(">Review<"));
    assert.ok(!markup.includes("turn-diff-review"));
  });

  test("carries no reference-only state attributes", () => {
    const markup = renderCard(collectEditedFiles(unitsOf(editBlock("edit_file", "/ws/a.ts"))));
    assert.ok(!markup.includes("data-change-set-id"));
    assert.ok(!markup.includes("data-webui-diff-state"));
  });
});

// --- 3. the card renders what it does have --------------------------------

describe("the card renders the files it can name", () => {
  const one = () => collectEditedFiles(unitsOf(editBlock("edit_file", "/ws/src/deep/a.ts")));

  test("header carries the distinct-file count", () => {
    const files = collectEditedFiles(
      unitsOf(
        editBlock("edit_file", "/ws/a.ts"),
        editBlock("edit_file", "/ws/b.ts"),
        editBlock("edit_file", "/ws/a.ts"),
      ),
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
    const paths = ["/ws/a.ts", "/ws/b.ts", "/ws/c.ts", "/ws/d.ts", "/ws/e.ts"];
    const files = collectEditedFiles(unitsOf(editBlock("edit_file", ...paths)));
    const markup = renderCard(files);
    assert.equal(COLLAPSED_FILE_ROWS, 3);
    assert.ok(markup.includes(">a.ts<") && markup.includes(">c.ts<"));
    assert.ok(!markup.includes(">d.ts<"), "rows past the fold are not rendered");
    assert.ok(markup.includes('data-testid="edited-files-card-toggle"'));
    assert.ok(markup.includes('data-expanded="false"'));
  });

  test("a short list needs no toggle", () => {
    const files = collectEditedFiles(unitsOf(editBlock("edit_file", "/ws/a.ts", "/ws/b.ts")));
    const markup = renderCard(files);
    assert.ok(markup.includes(">a.ts<") && markup.includes(">b.ts<"));
    assert.ok(!markup.includes("edited-files-card-toggle"));
  });
});

// --- 4. the state machine -------------------------------------------------

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

// --- 5. the mount is real -------------------------------------------------

describe("chat.tsx mounts the card on real data", () => {
  test("derives the card from collectEditedFiles over the full unit list", () => {
    assert.ok(chatSource.includes('from "@/lib/edited-files"'), "imports the derivation");
    assert.ok(/const editedFiles = useMemo\(\(\) => collectEditedFiles\(units\), \[units\]\)/.test(chatSource));
    // The card is a turn footer: it must be derived from `units`, never from
    // the virtualized window, or scrolling past 200 units would make it
    // appear and vanish.
    assert.ok(!/collectEditedFiles\(visibleUnits\)/.test(chatSource));
  });

  test("renders the card once, gated on there being files", () => {
    const mounts = chatSource.match(/<EditedFilesCard\b/g) ?? [];
    assert.equal(mounts.length, 1, "exactly one mount point");
    assert.ok(
      /\{editedFiles\.length > 0 \? \(\s*<EditedFilesCard files=\{editedFiles\} t=\{t\} onOpenFile=\{onOpenFile\} \/>/.test(
        chatSource,
      ),
      "gated on a non-empty list, wired to the real file opener",
    );
  });

  test("the card is the turn's last block, after the message-action row", () => {
    const card = chatSource.indexOf("<EditedFilesCard");
    const actions = chatSource.indexOf("<MessageActions");
    assert.ok(actions !== -1 && card !== -1);
    assert.ok(actions < card, "renders after the assistant body's action row");
  });
});

// --- 6. copy --------------------------------------------------------------

describe("the card reuses the existing copy", () => {
  test("both locales carry the same {{count}} sentence", () => {
    const en = translate("en", "activity.editedFiles");
    const zh = translate("zh", "activity.editedFiles");
    assert.equal(en, "Edited {{count}} files");
    assert.equal(zh, "已编辑{{count}}个文件");
  });

  test("the English side holds no Chinese", () => {
    const en = translate("en", "activity.editedFiles");
    assert.ok(!/[一-鿿]/.test(en), `en value carries Chinese: ${en}`);
  });

  test("the header interpolates the real count", () => {
    const files = collectEditedFiles(
      unitsOf(editBlock("edit_file", "/ws/a.ts"), editBlock("edit_file", "/ws/b.ts")),
    );
    assert.ok(renderCard(files).includes("已编辑2个文件"));
  });

  test("no duplicate edited-files key was added to either dictionary", () => {
    // The card reuses `activity.editedFiles`; a near-duplicate key is how the
    // two copies of the same sentence start saying different things.
    const occurrences = (i18nSource.match(/"activity\.editedFiles"/g) ?? []).length;
    assert.equal(occurrences, 2, "one en entry, one zh entry — no new key");
  });
});
