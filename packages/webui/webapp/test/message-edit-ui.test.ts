// webapp/test/message-edit-ui.test.ts
//
// PB-15: the inline editor on a user message — 「编辑消息 → 从该处重发」.
//
// Five things this suite pins, and they are the five ways the feature could
// quietly lie to a user:
//
//   1. THE CONTROL EXISTS ONLY WHERE THERE IS A TARGET. A user block with no
//      engine coordinate renders NO 编辑 button. A button that would send an
//      empty selector is a dead control, and this repository has already had
//      to delete one of those.
//   2. THE CONTROL IS HIDDEN WHILE THE ENGINE IS MID-TURN. A rewind rewrites
//      history; pressing it during a running turn is at best a refusal.
//   3. WHICH CALL A CONFIRM MAKES IS A DECISION, NOT A BRANCH IN A RENDER.
//      Changed text → the engine's atomic edit. Unchanged text → rewind plus
//      an ordinary send. The comparison is EXACT: a draft differing only in
//      trailing whitespace is a different message and must be sent as one.
//   4. `rewound:false` IS NOT A SUCCESS. Both endpoints can answer 200
//      without rewinding, and every reader here keeps that distinguishable
//      from a success all the way to the wording.
//   5. THE MARKER IS CONSUMED AND THE ID LANDS ON THE USER BLOCK. A
//      `§§ user_msg=<id>` line that leaked into the rendered body would be a
//      visible string of protocol in the user's conversation.
//
// createElement, not JSX: the `test:webapp` glob is `**/*.test.ts` and the
// tsx loader only transpiles JSX in `.tsx`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// components/*.tsx (pulled in through the component's graph) compile their
// JSX under the classic runtime in this process, which resolves a bare
// `React` identifier. Stub the ambient global through a typed alias rather
// than re-declaring it (a `var React` narrower than the lib's fails tsc), and
// do it BEFORE the component modules load.
{
  const reactModule = React;
  Object.defineProperty(globalThis, "React", {
    value: reactModule,
    configurable: true,
    writable: true,
  });
}

const { MessageEditControl, describeOutcome } = await import("../components/message-editor");
const {
  planMessageEdit,
  readDiffRewindVerdict,
  readEditOutcome,
  readRefusalOutcome,
  readRewindOutcome,
} = await import("../lib/message-edit");
const { decodeTranscript } = await import("../lib/transcript");
const { translate } = await import("../lib/i18n");

const here = dirname(fileURLToPath(import.meta.url));
const transcriptServerSource = readFileSync(resolve(here, "../../server/lib/transcript.js"), "utf8");
const chatSource = readFileSync(resolve(here, "../components/chat.tsx"), "utf8");
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");

const t = (key: Parameters<typeof translate>[1]) => translate("zh", key);
const noop = () => {};

const renderControl = (overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(MessageEditControl, {
      text: "the original message",
      editable: true,
      editing: false,
      draft: "the original message",
      busy: false,
      note: null,
      t,
      onStart: noop,
      onDraftChange: noop,
      onConfirm: noop,
      onCancel: noop,
      ...overrides,
    } as never),
  );

describe("the 编辑 control's presence", () => {
  test("an editable bubble renders the control and the original text", () => {
    const html = renderControl();
    assert.match(html, /data-testid="user-message-edit"/);
    assert.match(html, /the original message/);
  });

  test("a bubble with no engine coordinate renders NO control", () => {
    const html = renderControl({ editable: false });
    assert.doesNotMatch(html, /data-testid="user-message-edit"/);
    // The text still renders — the absence is the affordance, not the bubble.
    assert.match(html, /the original message/);
  });

  test("the control is revealed on hover, not always on", () => {
    const html = renderControl();
    assert.match(html, /group-hover:opacity-100/);
    assert.match(html, /opacity-0/);
  });

  test("the control is gone while a turn runs", () => {
    const html = renderControl({ editable: false });
    assert.doesNotMatch(html, /group-hover:opacity-100/);
  });
});

describe("the inline editor", () => {
  test("editing replaces the bubble with a textarea carrying the draft", () => {
    const html = renderControl({ editing: true, draft: "the corrected text" });
    assert.match(html, /data-testid="user-message-editor"/);
    assert.match(html, /data-testid="user-message-editor-field"/);
    assert.match(html, /the corrected text/);
    assert.doesNotMatch(html, /data-testid="user-message-edit"/);
  });

  test("both 确认 and 取消 are present while editing", () => {
    const html = renderControl({ editing: true });
    assert.match(html, /data-testid="user-message-editor-confirm"/);
    assert.match(html, /data-testid="user-message-editor-cancel"/);
  });

  test("a busy editor disables both controls and says so", () => {
    const html = renderControl({ editing: true, busy: true });
    assert.match(html, /data-message-id-busy="1"/);
    assert.match(html, /disabled/);
    assert.match(html, /处理中/);
  });

  test("an outcome note renders as written, outside the bubble", () => {
    const html = renderControl({ note: translate("en", "chat.messageEdit.notRewound") });
    assert.match(html, /data-testid="user-message-edit-note"/);
    assert.match(html, /did not rewind this message/);
  });
});

describe("planMessageEdit — which engine call a confirm makes", () => {
  test("changed text is one atomic edit", () => {
    assert.deepEqual(planMessageEdit("a", "b"), { kind: "edit", content: "b" });
  });

  test("unchanged text is a rewind plus a resend", () => {
    assert.deepEqual(planMessageEdit("a", "a"), { kind: "resend", content: "a" });
  });

  test("the comparison is exact — trailing whitespace is an edit", () => {
    assert.deepEqual(planMessageEdit("a", "a "), { kind: "edit", content: "a " });
    assert.deepEqual(planMessageEdit("a\n", "a"), { kind: "edit", content: "a" });
  });

  test("whitespace-only and non-string drafts are blocked, never sent", () => {
    assert.deepEqual(planMessageEdit("a", "   \n\t "), { kind: "blocked", reason: "empty" });
    assert.deepEqual(planMessageEdit("a", ""), { kind: "blocked", reason: "empty" });
    assert.deepEqual(planMessageEdit("a", undefined as never), { kind: "blocked", reason: "empty" });
  });

  test("a blocked draft keeps the ORIGINAL text out of the payload", () => {
    // The blocked branch carries no `content` at all: a caller that fell
    // through to the send would have nothing to send, which is the point.
    assert.equal("content" in planMessageEdit("a", " "), false);
  });
});

describe("readEditOutcome — a 200 that did not rewind is not a success", () => {
  test("rewound:true is the only success", () => {
    assert.deepEqual(readEditOutcome({ rewound: true, deletedCount: 3 }), {
      status: "edited",
      deletedCount: 3,
    });
  });

  test("rewound:false is its own outcome", () => {
    assert.deepEqual(readEditOutcome({ rewound: false }), { status: "not_rewound" });
  });

  test("a missing rewound is not defaulted to true", () => {
    assert.deepEqual(readEditOutcome({}), { status: "not_rewound" });
    assert.deepEqual(readEditOutcome(undefined as never), { status: "not_rewound" });
    assert.deepEqual(readEditOutcome({ rewound: "yes" } as never), { status: "not_rewound" });
  });

  test("a missing deletedCount reads as 0 rather than NaN", () => {
    assert.deepEqual(readEditOutcome({ rewound: true, deletedCount: -3 as never }), {
      status: "edited",
      deletedCount: 0,
    });
  });
});

describe("readRewindOutcome — the file outcome is never invented", () => {
  test("a reverted report is the only fully-successful reading", () => {
    assert.deepEqual(
      readRewindOutcome({
        rewound: true,
        deletedCount: 2,
        turnDiffRewind: { status: "reverted", revertedTurnIds: ["t1"] },
      }),
      { status: "resent", deletedCount: 2, diffRewind: "reverted" },
    );
  });

  test("NO report is `partial`, never `reverted`", () => {
    assert.equal(readDiffRewindVerdict(null), "partial");
    assert.equal(readDiffRewindVerdict(undefined), "partial");
    assert.equal(readDiffRewindVerdict({ status: "" }), "partial");
  });

  test("an errorCode makes the outcome `partial` whatever the status says", () => {
    assert.equal(readDiffRewindVerdict({ status: "reverted", errorCode: "DIFF_CONFLICT" }), "partial");
    assert.equal(readDiffRewindVerdict({ status: "skipped" }), "other");
  });

  test("rewound:false wins over any file report", () => {
    assert.deepEqual(
      readRewindOutcome({ rewound: false, turnDiffRewind: { status: "reverted" } }),
      { status: "not_rewound" },
    );
  });
});

describe("readRefusalOutcome — the server's sentence survives", () => {
  test("the engine's own code and message are carried through", () => {
    assert.deepEqual(
      readRefusalOutcome({ code: "CONVERSATION_MUTATION_BUSY", message: "Plan Mode is active" }),
      { status: "refused", code: "CONVERSATION_MUTATION_BUSY", message: "Plan Mode is active" },
    );
  });

  test("a shapeless throw still gets a code and a sentence", () => {
    const out = readRefusalOutcome(new Error("boom"));
    assert.equal(out.status, "refused");
    assert.equal(out.code, "edit_failed");
    assert.equal(out.message, "boom");
  });

  test("a null throw is a refusal, never a success", () => {
    assert.equal(readRefusalOutcome(null).status, "refused");
  });
});

describe("describeOutcome — every ending has one honest sentence", () => {
  test("edited and resent are worded as different acts", () => {
    const edited = describeOutcome({ status: "edited", deletedCount: 0 }, t);
    const resent = describeOutcome({ status: "resent", deletedCount: 0, diffRewind: "reverted" }, t);
    assert.notEqual(edited, resent);
    assert.match(edited, /新内容/);
  });

  test("a resend that did not restore every file says so", () => {
    const note = describeOutcome({ status: "resent", deletedCount: 0, diffRewind: "partial" }, t);
    assert.match(note, /未全部恢复/);
  });

  test("a refusal is the server's own sentence, verbatim", () => {
    const note = describeOutcome({ status: "refused", code: "X", message: "engine said no" }, t);
    assert.equal(note, "engine said no");
  });

  test("not_rewound is never worded as a success", () => {
    const note = describeOutcome({ status: "not_rewound" }, t);
    assert.match(note, /没有回退/);
  });
});

describe("the §§ user_msg marker", () => {
  test("the server writes it after a user message that carries a msg id", () => {
    assert.match(transcriptServerSource, /§§ user_msg=\$\{m\.msgId\}/);
  });

  test("the decoder attaches the id to the user block and never renders it", () => {
    const blocks = decodeTranscript(["› hello", "§§ user_msg=msg_42", "● hi"]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]?.role, "user");
    assert.equal(blocks[0]?.userMessageId, "msg_42");
    assert.equal(blocks[0]?.text, "hello");
    assert.doesNotMatch(JSON.stringify(blocks), /§§/);
  });

  test("a marker after the user block already closed still finds its owner", () => {
    const blocks = decodeTranscript(["› hello", "→ tool  {}", "§§ user_msg=msg_42"]);
    assert.equal(blocks[0]?.userMessageId, "msg_42");
  });

  test("a user message with no marker has NO id and therefore no target", () => {
    const blocks = decodeTranscript(["› hello"]);
    assert.equal(blocks[0]?.userMessageId, undefined);
  });

  test("a turn marker never leaks onto a user block", () => {
    const blocks = decodeTranscript(["› hello", "§§ turn_msg=asst_9", "§§ processed_duration=1200ms"]);
    assert.equal(blocks[0]?.userMessageId, undefined);
    assert.equal(blocks[0]?.assistantMessageId, undefined);
  });

  test("two user messages in different turns keep their own coordinates", () => {
    const blocks = decodeTranscript([
      "› first",
      "§§ user_msg=msg_1",
      "● reply",
      "› second",
      "§§ user_msg=msg_2",
    ]);
    assert.equal(blocks[0]?.userMessageId, "msg_1");
    assert.equal(blocks[2]?.userMessageId, "msg_2");
  });

  test("two ADJACENT user lines merge into one block, and the FIRST id wins", () => {
    // `pushText` merges consecutive same-speaker lines, so this is one block
    // holding both texts with two markers on it. Taking the LAST would point
    // the editor at a message whose text is the block's second half.
    const blocks = decodeTranscript(["› first", "§§ user_msg=msg_1", "› second", "§§ user_msg=msg_2"]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.userMessageId, "msg_1");
  });
});

describe("wiring in chat.tsx and i18n", () => {
  test("the user branch renders UserMessage, not a bare bubble", () => {
    assert.match(chatSource, /import \{ UserMessage \} from "\.\/message-editor"/);
    assert.match(chatSource, /<UserMessage/);
    assert.match(chatSource, /messageId=\{block\.userMessageId\}/);
    assert.match(chatSource, /sessionRunning=\{sessionRunning\}/);
  });

  test("the edit control is gated on the coordinate, not on hover alone", () => {
    const editorSource = readFileSync(resolve(here, "../components/message-editor.tsx"), "utf8");
    assert.match(editorSource, /editable=\{!!messageId && !sessionRunning\}/);
  });

  test("every PB-15 key exists in both locales", () => {
    const keys = [
      "chat.messageEdit.action",
      "chat.messageEdit.field",
      "chat.messageEdit.confirm",
      "chat.messageEdit.cancel",
      "chat.messageEdit.busy",
      "chat.messageEdit.empty",
      "chat.messageEdit.edited",
      "chat.messageEdit.resent",
      "chat.messageEdit.resentFilesKept",
      "chat.messageEdit.notRewound",
    ];
    for (const key of keys) {
      const en = translate("en", key as never);
      const zh = translate("zh", key as never);
      assert.notEqual(en, key, `${key} is missing from en`);
      assert.notEqual(zh, key, `${key} is missing from zh`);
      assert.notEqual(en, zh, `${key} must differ between en and zh`);
      assert.match(i18nSource, new RegExp(`"${key.replace(/\./g, "\\.")}"`));
    }
  });

  test("the endpoints the client calls are the ones the server registered", () => {
    assert.match(i18nSource, /"chat\.messageEdit\.action"/);
  });
});