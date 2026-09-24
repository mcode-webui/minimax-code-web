// webui/test/lib/interaction/ask-multiselect-wire.test.js
// Regression test for the `multiSelect` flag that the AskUser tool modal
// reads defensively (`(ask as { multiSelect?: boolean }).multiSelect === true`
// in webapp/components/modals.tsx:89). The engine sends `multiSelect: true`
// for prompts that should render checkboxes; `user-questions.js` already
// carries the flag through normalisation (user-questions.js:65), but the
// flag was DROPPED at three wire hops before reaching the browser:
//
//   1. setAskPending built cs.ask without multiSelect
//      (tool-ask-user.js, around the old :45)
//   2. hydrateAskFromQuestions built cs.ask + nextQuestion without
//      multiSelect / nextMultiSelect (around the old :99)
//   3. state-bus.js's default ask shape (makeClientState) omitted the
//      field, so an inactive ask had undefined multiSelect
//
// This test pins the wire contract on the server side so future
// refactors cannot silently re-introduce the drop. It does NOT assert
// on the frontend read — that's covered by the AskModal's own
// component-level tests in webapp/test/.
//
// The test does NOT mock the engine — `multiSelect` is asserted to flow
// through both payload construction sites regardless of how the raw
// payload arrived (engine, debug inject, hydrate from a transcript).
// Whether the engine actually populates `multiSelect` on real ACP ask
// events is an engine contract outside this file's reach (see the
// report).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { setupMocks, absPath, registerSessionsStore } from "../../helpers/_setup.js";

let askUser;
let stateBus;

before(async (t) => {
  // setupMocks handles the acp-client / sessions / settings / config /
  // mcode-acp / mcode-exec / mcode-rpc / models / slash mocks. Without
  // these, the dynamic import of state-bus.js (transitive from
  // tool-ask-user.js → pushStateFor) would crash on real IO / spawn.
  // We pass `acp.getMcodeSessionsCacheSync: () => null` so pushStateFor
  // for a cid without an SSE res takes the no-write short circuit (see
  // state-bus.js _schedulePush: "if (!res) return").
  await setupMocks(t, {
    acp: {
      getMcodeSessionsCacheSync: () => null,
      getMcodeSessionsStaleSync: () => null,
      getMcodeSessionsForWorkspace: async () => [],
    },
  });
  registerSessionsStore({ initial: [] });
  askUser = await import(absPath("lib/interaction/tool-ask-user.js"));
  stateBus = await import(absPath("lib/state-bus.js"));
});

// Minimal cs (we only care about cs.ask) — avoids depending on the
// full makeClientState shape, which is verified separately below.
function fakeCs() {
  // Reuse makeClientState so the default ask shape (which we're
  // asserting on) is present from the start. The default carries
  // multiSelect: false — verified in "default ask shape" describe.
  const cs = stateBus.makeClientState();
  return cs;
}

// Drive setAskPending with a synthetic payload that resembles the
// {questions:[{question,options,multiSelect}]} shape documented at
// tool-ask-user.js:32-33 / ARCHITECTURE.md §5.
function driveSetAskPending(cs, cid, questions) {
  return askUser.setAskPending(cs, cid, { questions });
}

// Drive hydrateAskFromQuestions with a normalized list (the shape
// user-questions.js#normalizeQuestions produces — every entry already
// carries a boolean multiSelect).
function driveHydrate(cs, cid, questions) {
  return askUser.hydrateAskFromQuestions(cs, cid, questions);
}

// ---------------------------------------------------------------------
// (A) setAskPending — construction site #1
// ---------------------------------------------------------------------
describe("setAskPending carries multiSelect through to cs.ask", () => {
  test("multiSelect: true on the first question → cs.ask.multiSelect === true", () => {
    // ASSERTION THAT WOULD FAIL BEFORE THE FIX:
    //   Before this fix, setAskPending built cs.ask with options + question
    //   only — `multiSelect` was never assigned. The flag existed on the
    //   raw payload (and on user-questions.js's normalised output) but was
    //   dropped at the construction site, so cs.ask.multiSelect was
    //   undefined and the AskModal's `(ask as ...).multiSelect === true`
    //   defensive read never activated the checkbox branch.
    const cs = fakeCs();
    driveSetAskPending(cs, "cid-multi-true", [
      {
        question: "Pick toppings",
        header: "Toppings",
        options: ["cheese", "pepperoni", "mushrooms"],
        multiSelect: true,
      },
    ]);
    assert.equal(cs.ask.active, true, "ask must be active");
    assert.equal(cs.ask.multiSelect, true, "multiSelect must survive the construction site");
    // Strict typeof — anything other than boolean would trip the
    // UI's `=== true` check.
    assert.equal(typeof cs.ask.multiSelect, "boolean");
  });

  test("multiSelect: false → cs.ask.multiSelect === false (NOT undefined)", () => {
    const cs = fakeCs();
    driveSetAskPending(cs, "cid-multi-false", [
      {
        question: "Confirm?",
        options: ["yes", "no"],
        multiSelect: false,
      },
    ]);
    assert.equal(cs.ask.active, true);
    assert.equal(cs.ask.multiSelect, false, "explicit false must be preserved as boolean false");
    assert.equal(typeof cs.ask.multiSelect, "boolean");
  });

  test("multiSelect omitted from the question → cs.ask.multiSelect === false (safe default)", () => {
    // An engine that doesn't know about multiSelect would send no flag at
    // all. The construction site must normalise that to boolean false,
    // not undefined — otherwise the UI's `=== true` check would still
    // fall through (undefined !== true), but downstream code that does
    // a truthy check (or JSON.stringify round-trip) would behave
    // inconsistently. Pin the boolean contract.
    const cs = fakeCs();
    driveSetAskPending(cs, "cid-multi-absent", [
      { question: "Pick one", options: ["a", "b"] },
    ]);
    assert.equal(cs.ask.active, true);
    assert.equal(
      cs.ask.multiSelect,
      false,
      "absent multiSelect must normalise to boolean false",
    );
    assert.equal(typeof cs.ask.multiSelect, "boolean");
  });

  test("multiSelect with wrong type (string 'true') → cs.ask.multiSelect === false", () => {
    // The UI uses `=== true`, so any non-boolean-true value (including
    // string "true" that some upstream serializer might produce) must
    // be normalised at the construction site. A truthy-but-not-true
    // flag would render single-select for what is actually multi-select,
    // which is silent data loss.
    const cs = fakeCs();
    driveSetAskPending(cs, "cid-multi-string", [
      {
        question: "Pick",
        options: ["a", "b"],
        multiSelect: "true",
      },
    ]);
    assert.equal(cs.ask.multiSelect, false);
  });

  test("multiSelect on a multi-question payload uses the FIRST question's flag", () => {
    // The construction site only surfaces the first question to the
    // modal (the rest are not yet active). Pin: first wins. The "second
    // question loses the flag" case is covered by the recordAskProgress
    // describe block below.
    const cs = fakeCs();
    driveSetAskPending(cs, "cid-multi-step1", [
        { question: "q1", options: ["a", "b"], multiSelect: true },
        { question: "q2", options: ["x", "y", "z"], multiSelect: false },
      ],
    );
    assert.equal(cs.ask.total, 2);
    assert.equal(cs.ask.multiSelect, true, "first question's multiSelect wins for step 1");
  });
});

// ---------------------------------------------------------------------
// (B) hydrateAskFromQuestions — construction site #2
// ---------------------------------------------------------------------
describe("hydrateAskFromQuestions carries multiSelect through to cs.ask", () => {
  test("multiSelect: true on the first question → cs.ask.multiSelect === true", () => {
    // ASSERTION THAT WOULD FAIL BEFORE THE FIX:
    //   hydrateAskFromQuestions built cs.ask with options + question +
    //   nextQuestion + nextOptions but no multiSelect / nextMultiSelect.
    //   Same drop as setAskPending, plus a second drop on the preview
    //   fields that recordAskProgress copies forward.
    const cs = fakeCs();
    const ok = driveHydrate(cs, "cid-hydrate-true", [
      { kind: "choice", question: "q1", options: [{ label: "a" }, { label: "b" }], multiSelect: true },
    ]);
    assert.equal(ok, true);
    assert.equal(cs.ask.active, true);
    assert.equal(cs.ask.multiSelect, true);
  });

  test("multiSelect omitted → cs.ask.multiSelect === false", () => {
    const cs = fakeCs();
    driveHydrate(cs, "cid-hydrate-absent", [
      { kind: "choice", question: "q1", options: [{ label: "a" }, { label: "b" }] },
    ]);
    assert.equal(cs.ask.active, true);
    assert.equal(cs.ask.multiSelect, false);
  });

  test("with two questions, nextMultiSelect carries step 2's flag", () => {
    // The "second step payload also carries it" case from the bug
    // report. recordAskProgress will pull this through into cs.ask
    // when step 1 is answered.
    const cs = fakeCs();
    driveHydrate(cs, "cid-hydrate-twostep", [
      { kind: "choice", question: "q1", options: [{ label: "a" }], multiSelect: true },
      { kind: "choice", question: "q2", options: [{ label: "b" }, { label: "c" }], multiSelect: false },
    ]);
    assert.equal(cs.ask.total, 2);
    assert.equal(cs.ask.multiSelect, true, "step 1 multiSelect");
    assert.equal(cs.ask.nextQuestion, "q2", "step 2 is queued");
    assert.equal(cs.ask.nextMultiSelect, false, "step 2's flag must be carried on the preview");
  });

  test("with two questions where step 2 is multiSelect and step 1 is not", () => {
    // The reverse direction: step 1 single-select, step 2 multi-select.
    // Without nextMultiSelect, step 2 would inherit step 1's false and
    // render single-select checkboxes-as-buttons (the inverse silent
    // data loss: the user can't tick more than one).
    const cs = fakeCs();
    driveHydrate(cs, "cid-hydrate-twostep-flip", [
      { kind: "choice", question: "q1", options: [{ label: "a" }], multiSelect: false },
      { kind: "choice", question: "q2", options: [{ label: "b" }, { label: "c" }], multiSelect: true },
    ]);
    assert.equal(cs.ask.multiSelect, false, "step 1 multiSelect");
    assert.equal(cs.ask.nextMultiSelect, true, "step 2 multiSelect must be carried on preview");
  });
});

// ---------------------------------------------------------------------
// (C) recordAskProgress — the second-step handoff
// ---------------------------------------------------------------------
describe("recordAskProgress carries nextMultiSelect to multiSelect on advance", () => {
  test("after answering step 1, cs.ask.multiSelect reflects step 2's flag", () => {
    // ASSERTION THAT WOULD FAIL BEFORE THE FIX:
    //   recordAskProgress did `...cs.ask` (preserves multiSelect from
    //   step 1) then set nextQuestion/nextOptions but did NOT update
    //   multiSelect. So a step-1-single → step-2-multi transition
    //   would have cs.ask.multiSelect === false even after advance,
    //   and the modal would render single-select for the multi-select
    //   step 2. (And vice versa for step-1-multi → step-2-single.)
    //
    // recordAskProgress advances once per call: with total=2 and
    // currentIdx=0, one call moves to currentIdx=1 (still active);
    // the second call is the one that hits `done` and triggers the
    // nextQuestion handoff. Drive it total - 1 times.
    const cs = fakeCs();
    driveHydrate(cs, "cid-progress-twostep", [
      { kind: "choice", question: "q1", options: [{ label: "a" }], multiSelect: false },
      { kind: "choice", question: "q2", options: [{ label: "b" }, { label: "c" }], multiSelect: true },
    ]);
    assert.equal(cs.ask.active, true);
    assert.equal(cs.ask.multiSelect, false, "pre-advance: step 1 single-select");
    // First call: still active, currentIdx=1, no handoff yet.
    const idx1 = askUser.recordAskProgress(cs);
    assert.equal(idx1, 1);
    assert.equal(cs.ask.active, true, "still active after 1 of 2");
    assert.equal(cs.ask.multiSelect, false, "still on step 1");
    // Second call: done=true → handoff to nextQuestion (step 2).
    const idx2 = askUser.recordAskProgress(cs);
    assert.equal(idx2, 2, "advanced past step 1");
    assert.equal(cs.ask.question, "q2", "step 2 question is now active");
    assert.equal(cs.ask.active, false, "all answered → inactive");
    assert.equal(cs.ask.multiSelect, true, "step 2 multiSelect must be reflected after advance");
    assert.equal(cs.ask.nextQuestion, "", "preview cleared after handoff");
    assert.equal(cs.ask.nextOptions.length, 0, "preview cleared after handoff");
    assert.equal(cs.ask.nextMultiSelect, false, "preview flag cleared after handoff");
  });

  test("step 1 multi → step 2 single flips multiSelect back to false on advance", () => {
    // Inverse direction: confirm the advance is not a one-way street.
    const cs = fakeCs();
    driveHydrate(cs, "cid-progress-twostep-flip", [
      { kind: "choice", question: "q1", options: [{ label: "a" }], multiSelect: true },
      { kind: "choice", question: "q2", options: [{ label: "b" }], multiSelect: false },
    ]);
    // Drive past step 1 to trigger the handoff.
    askUser.recordAskProgress(cs);
    askUser.recordAskProgress(cs);
    assert.equal(cs.ask.question, "q2");
    assert.equal(cs.ask.multiSelect, false, "step 2 single-select must override step 1 multiSelect");
  });
});

// ---------------------------------------------------------------------
// (D) Default ask shape — the safety net
// ---------------------------------------------------------------------
describe("state-bus makeClientState default ask shape is multiSelect-safe", () => {
  test("default ask.multiSelect is exactly false (not undefined)", () => {
    // ASSERTION THAT WOULD FAIL BEFORE THE FIX:
    //   state-bus.js's default ask shape had no multiSelect key. A
    //   fresh per-cid client therefore had cs.ask.multiSelect ===
    //   undefined, which the UI's `=== true` check correctly falls
    //   through from — but JSON.stringify snapshots can drop
    //   undefined fields, leading to inconsistent behaviour across
    //   the wire. Pin the boolean false default.
    const cs = stateBus.makeClientState();
    assert.ok(cs && cs.ask, "default ask shape must exist on a fresh client");
    assert.equal(
      cs.ask.multiSelect,
      false,
      "default ask.multiSelect must be boolean false (not undefined)",
    );
    assert.equal(typeof cs.ask.multiSelect, "boolean");
  });

  test("the default ask shape contains all the documented fields incl. multiSelect", () => {
    // Belt-and-braces: catch a future refactor that drops the field
    // entirely. The set is small enough that the assertion stays
    // readable; if it grows past 10 entries, switch to a `.includes`
    // spot check.
    const cs = stateBus.makeClientState();
    const askKeys = Object.keys(cs.ask).sort();
    assert.ok(
      askKeys.includes("multiSelect"),
      `default ask shape must include multiSelect (got keys: ${askKeys.join(", ")})`,
    );
    // The pre-existing fields must not regress.
    for (const expected of ["active", "answered", "currentIdx", "options", "question", "total"]) {
      assert.ok(
        askKeys.includes(expected),
        `default ask shape must keep field "${expected}" (got keys: ${askKeys.join(", ")})`,
      );
    }
  });
});