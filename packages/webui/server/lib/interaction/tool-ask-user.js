// webui/server/lib/interaction/tool-ask-user.js
// Per-tool ask dialog seam. Owns the `cs.ask` state shape used by the
// AskUser tool modal in the webui.
//
// NOTE: the `cs.ask` state is currently mutated by mcode-acp.js
// stream code paths; this module provides the helper API so future
// Borrow 1 (transcript) and Borrow 3 (hook seam) call sites can
// route through one chokepoint. Stream writes always go via
// state-bus.pushStateFor — no direct stream writes from here.

import { pushStateFor } from "../state-bus.js";

// Canonical ask state shape (ARCHITECTURE.md §4). All fields present
// even when inactive so consumers never see `undefined`.
export function makeAskState() {
  return {
    active: false,
    total: 0,
    answered: 0,
    currentIdx: 0,
    question: "",
    options: [],
    // The canonical ask shape must match `state-bus.js`'s default ask shape
    // key-for-key; two shapes for one contract is how a field silently goes
    // missing on one path. `false` (not undefined) keeps the UI's
    // `ask.multiSelect === true` read falling through to single-select.
    multiSelect: false,
  };
}

// setAskPending — populate cs.ask with a new ask payload and push state.
//   payload: { questions: Array<{header,question,options,multiSelect}> }
//     per ARCHITECTURE.md §5 (ask event).
//   Returns true on success, false when payload is empty or cs missing.
export function setAskPending(cs, cid, payload) {
  if (!cs) return false;
  const questions = Array.isArray(payload?.questions)
    ? payload.questions
    : [];
  if (questions.length === 0) return false;
  const first = questions[0] || {};
  cs.ask = {
    active: true,
    total: questions.length,
    answered: 0,
    currentIdx: 0,
    question: first.question || "",
    options: Array.isArray(first.options) ? first.options : [],
    // multiSelect is read defensively by the UI (`ask.multiSelect === true`).
    // Normalise to a boolean so an absent / wrong-type value cannot trick
    // the modal into rendering checkboxes for a single-select prompt.
    multiSelect: first.multiSelect === true,
  };
  pushStateFor(cid);
  return true;
}

// clearAskPending — close the ask modal. Idempotent (no-op if inactive).
export function clearAskPending(cs, cid) {
  if (!cs || !cs.ask) return;
  cs.ask = { ...cs.ask, active: false };
  pushStateFor(cid);
}

// isAskPending — convenience predicate so callers don't poke cs.ask.active.
export function isAskPending(cs) {
  return !!(cs && cs.ask && cs.ask.active);
}

// recordAskProgress — mark the current question answered and advance idx.
//   Returns the next currentIdx, or total when all answered.
//   When advancing to the "next" question preview, also copies the
//   preview's multiSelect so a follow-up single/multi question does not
//   inherit the previous step's flag (a regression class introduced
//   when the field began flowing through this chokepoint).
export function recordAskProgress(cs) {
  if (!cs || !cs.ask || !cs.ask.active) return 0;
  const next = cs.ask.currentIdx + 1;
  const done = next >= cs.ask.total;
  cs.ask = {
    ...cs.ask,
    answered: cs.ask.answered + 1,
    currentIdx: done ? cs.ask.currentIdx : next,
    active: !done,
  };
  if (done && cs.ask.nextQuestion) {
    cs.ask.question = cs.ask.nextQuestion;
    cs.ask.options = cs.ask.nextOptions || [];
    // Carry the next question's multiSelect so a step-2 single-select
    // question doesn't render checkboxes inherited from a step-1
    // multi-select (and vice versa). The preview field is cleared
    // after the handoff so the snapshot doesn't carry stale data.
    cs.ask.multiSelect = cs.ask.nextMultiSelect === true;
    cs.ask.nextQuestion = "";
    cs.ask.nextOptions = [];
    cs.ask.nextMultiSelect = false;
  }
  return done ? cs.ask.total : next;
}

// hydrateAskFromQuestions — populate cs.ask from a normalized
//   questions list (typically output of user-questions.normalizeQuestions).
//   Peeks ahead so the UI can show the "next" question's preview.
//   Both the active question's `multiSelect` and the preview's
//   `nextMultiSelect` are carried so the ported AskModal's defensive
//   `ask.multiSelect === true` read activates at the right step.
export function hydrateAskFromQuestions(cs, cid, questions) {
  if (!cs) return false;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  const first = questions[0];
  const second = questions[1];
  cs.ask = {
    ...(cs.ask || makeAskState()),
    active: true,
    total: questions.length,
    answered: 0,
    currentIdx: 0,
    question: first.question || "",
    options: Array.isArray(first.options) ? first.options : [],
    multiSelect: first.multiSelect === true,
    nextQuestion: second ? second.question || "" : "",
    nextOptions: second && Array.isArray(second.options) ? second.options : [],
    nextMultiSelect: !!(second && second.multiSelect === true),
  };
  pushStateFor(cid);
  return true;
}