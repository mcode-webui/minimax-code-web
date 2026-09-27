// webui/test/lib/mcode-acp-ownership.check.mjs
// Unit tests for ticket 08 — ownership-aware mirror in
// server/lib/mcode-acp.js#applyConfigOptionUpdate.
//
// Ticket 07's `applyConfigOptionUpdate` test fixture
// (test/lib/mcode-acp-note.test.js) covered the original contract:
// propagate `permissionMode`, `model.currentValue`, and
// `thinkingEffort.currentValue` into `cs.model`.
//
// The set-model SSE race (ticket 08) splits that contract:
// `handleSetModel` writes the user's recorded pick directly into
// `cs.model` (user-friendly form), and the engine's
// `config_option_update` notification would otherwise overwrite the
// field with the engine's wire form — visible on the chip as an
// alternation `[GLM-5.3, M3, GLM-5.3, ...]`. The fix defers the
// engine mirror for a short window after a local pick so the
// recorded pick stays authoritative on the chip.
//
// This file exercises the new contract in isolation:
//   * outside the pick window the mirror stays as it was — engine
//     truth wins;
//   * inside the window the mirror is suppressed — the user's
//     recorded pick survives an engine notification that would
//     otherwise revert it;
//   * the per-field independence: a thinkingEffort-only pick does
//     NOT block a later engine-driven model mirror (and vice versa);
//   * the `PICK_DEFER_WINDOW_MS` boundary — at the boundary itself
//     the mirror reactivates (defensive: a sluggish engine whose
//     notification arrives >4s after the local pick is allowed to
//     catch up rather than getting silently dropped).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

let applyConfigOptionUpdate;
let shouldMirrorToModelName;
let shouldMirrorToThinkingField;
let PICK_DEFER_WINDOW_MS;

before(async () => {
  const mod = await import(absPath("lib/mcode-acp.js"));
  applyConfigOptionUpdate = mod.applyConfigOptionUpdate;
  shouldMirrorToModelName = mod.shouldMirrorToModelName;
  shouldMirrorToThinkingField = mod.shouldMirrorToThinkingField;
  PICK_DEFER_WINDOW_MS = mod.PICK_DEFER_WINDOW_MS;
});

after(async () => {
  // Stop the resident acp singleton spawned during module load.
  const acp = await import(absPath("lib/acp-client.js"));
  try { await acp.getMcodeAcpClient(); } catch { /* engine never started */ }
  try { acp.shutdownMcodeAcpSingleton(); } catch { /* nothing to stop */ }
  await new Promise((r) => setTimeout(r, 50));
});

// ============================================================
// Helpers / fixtures
// ============================================================

function optsFor({ model, thinking, permissionMode } = {}) {
  const list = [];
  if (permissionMode !== undefined) {
    list.push({
      id: "permissionMode",
      type: "select",
      currentValue: permissionMode,
    });
  }
  if (model !== undefined) {
    list.push({
      id: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "minimax_api:MiniMax-M3", name: "MiniMax-M3" },
        { value: "minimax_api:GLM-5.3", name: "GLM-5.3" },
      ],
    });
  }
  if (thinking !== undefined) {
    list.push({
      id: "thinkingEffort",
      type: "select",
      currentValue: thinking,
      options: [],
    });
  }
  return list;
}

function freshCs({ modelName, thinking, modelPickedAt, thinkingPickedAt } = {}) {
  const model =
    modelName === undefined
      ? undefined
      : { name: modelName, ...(thinking === undefined ? {} : { thinking }) };
  if (typeof modelPickedAt === "number" && model) model.modelPickedAt = modelPickedAt;
  if (typeof thinkingPickedAt === "number" && model) model.thinkingPickedAt = thinkingPickedAt;
  return {
    permissions: "Full access",
    model,
    configOptions: optsFor({ model: "minimax_api:MiniMax-M3" }),
  };
}

// ============================================================
// Original behaviour preserved when there is NO local pick —
// engine truth still wins. This is the cross-client / bootstrap
// path: a different tab flipped the model, or a fresh session is
// reporting the engine's default for the first time.
// ============================================================

describe("applyConfigOptionUpdate — no local pick (original contract)", () => {
  test("engine currentValue propagates into cs.model.name", () => {
    const cs = { model: { name: "minimax_api:MiniMax-M3" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "minimax_api:GLM-5.3" }),
    });
    assert.equal(cs.model.name, "minimax_api:GLM-5.3");
  });

  test("engine currentValue propagates into cs.model.thinking", () => {
    const cs = {
      model: { name: "minimax_api:MiniMax-M3" },
      permissions: "Full access",
    };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ thinking: "high" }),
    });
    assert.equal(cs.model.thinking, "high");
  });
});

// ============================================================
// Ticket 08 — local pick in flight. The mirror is suppressed for
// PICK_DEFER_WINDOW_MS so a wire-form response from the engine
// does not overwrite the user's recorded pick.
// ============================================================

describe("applyConfigOptionUpdate — local pick (ticket 08 ownership)", () => {
  test("inside the pick window: engine mirror does NOT overwrite cs.model.name", () => {
    const cs = freshCs({
      modelName: "minimax_api/GLM-5.3",
      modelPickedAt: Date.now(),
    });
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "minimax_api:MiniMax-M3" }),
    });
    assert.equal(cs.model.name, "minimax_api/GLM-5.3",
      "engine's rejected/currentValue is NOT mirror'd over the recorded pick");
  });

  test("inside the pick window: engine mirror does NOT overwrite cs.model.thinking", () => {
    const cs = freshCs({
      modelName: "minimax_api:GLM-5.3",
      thinking: "high",
      thinkingPickedAt: Date.now(),
    });
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({
        model: "minimax_api:GLM-5.3",
        thinking: "low",
      }),
    });
    assert.equal(cs.model.thinking, "high",
      "engine's wire response is suppressed; recorded pick survives");
  });

  test("outside the pick window: engine mirror reasserts (cross-client)", () => {
    const cs = freshCs({
      modelName: "minimax_api/GLM-5.3",
      // Set the pick timestamp far in the past so the window has elapsed.
      modelPickedAt: Date.now() - (PICK_DEFER_WINDOW_MS + 1000),
    });
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "minimax_api:MiniMax-M3" }),
    });
    assert.equal(cs.model.name, "minimax_api:MiniMax-M3",
      "stale local pick no longer holds; engine truth wins");
  });

  test("per-field independence: thinkingEffort pick does NOT block a model mirror", () => {
    // User changed ONLY thinking effort. An engine notification
    // carrying a model change (e.g. another tab flipped it) MUST
    // propagate. The model's own pick timestamp is absent, so the
    // model mirror goes through.
    const cs = freshCs({
      modelName: "minimax_api/GLM-5.3",
      thinking: "high",
      thinkingPickedAt: Date.now(),
    });
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({
        model: "minimax_api:MiniMax-M3",
        thinking: "high", // matches the user's recorded pick — no-op there
      }),
    });
    assert.equal(cs.model.name, "minimax_api:MiniMax-M3",
      "thinking-effort pick must NOT block the model mirror");
    assert.equal(cs.model.thinking, "high",
      "matching thinking value is mirrored (no-op form)");
  });

  test("per-field independence: model pick does NOT block a thinkingEffort mirror", () => {
    const cs = freshCs({
      modelName: "minimax_api/GLM-5.3",
      thinking: "high",
      modelPickedAt: Date.now(),
    });
    // Engine notification says the user just changed effort on
    // another tab. Mirror carries the new level. The model's own
    // pick is the same, but its mirror is suppressed because the
    // model pick timestamp is fresh.
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({
        model: "minimax_api:GLM-5.3", // matches the recorded pick
        thinking: "low",
      }),
    });
    assert.equal(cs.model.name, "minimax_api/GLM-5.3",
      "model field untouched (recent local pick)");
    assert.equal(cs.model.thinking, "low",
      "thinkingEffort mirror carried the cross-tab change through");
  });

  test("a clearing thinkingEffort notification still drops the field when outside the pick window", () => {
    // Engine reset thinkingEffort to "" (e.g. model switched and the
    // new model has no effort dimension). The field must drop,
    // regardless of the pick window — the user requested "default
    // stands" semantics, which is the original empty-string case.
    const cs = freshCs({
      modelName: "minimax_api/GLM-5.3",
      thinking: "high",
      thinkingPickedAt: Date.now() - (PICK_DEFER_WINDOW_MS + 1000),
    });
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({
        model: "minimax_api:GLM-5.3",
        thinking: "",
      }),
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(cs.model, "thinking"),
      false,
      "engine clearing the field drops it from cs.model",
    );
  });

  test("a stale matching model currentValue does NOT re-apply (the recorded pick stands)", () => {
    // The user picked GLM-5.3 (recorded: minimax_api/GLM-5.3). The
    // engine accepted and reports currentValue = GLM-5.3 (without the
    // user-friendly provider prefix). The mirror runs:
    //   inside the pick window, the wire form is suppressed; the
    //   recorded pick stays. This is the SUCCESS branch — the chip
    //   keeps showing the user-friendly form.
    const cs = freshCs({
      modelName: "minimax_api/GLM-5.3",
      modelPickedAt: Date.now(),
    });
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "minimax_api:GLM-5.3" }),
    });
    assert.equal(cs.model.name, "minimax_api/GLM-5.3",
      "success path: recorded pick stays; engine wire form is not stamped");
  });
});

// ============================================================
// shouldMirrorToModelName — the predicate alone, for direct
// reasoning about the rules.
// ============================================================

describe("shouldMirrorToModelName — predicate contract", () => {
  test("false when the model option has no currentValue", () => {
    const cs = freshCs({ modelName: "x", modelPickedAt: Date.now() });
    const modelOption = { id: "model", type: "select", currentValue: null };
    assert.equal(shouldMirrorToModelName(cs, modelOption), false);
  });

  test("false inside the pick window", () => {
    const cs = freshCs({ modelName: "x", modelPickedAt: Date.now() });
    const modelOption = {
      id: "model",
      type: "select",
      currentValue: "engine-wire-form",
      options: [],
    };
    assert.equal(shouldMirrorToModelName(cs, modelOption), false);
  });

  test("true outside the pick window", () => {
    const cs = freshCs({
      modelName: "x",
      modelPickedAt: Date.now() - (PICK_DEFER_WINDOW_MS + 1000),
    });
    const modelOption = {
      id: "model",
      type: "select",
      currentValue: "engine-wire-form",
      options: [],
    };
    assert.equal(shouldMirrorToModelName(cs, modelOption), true);
  });

  test("true when no pick has ever happened", () => {
    const cs = freshCs();
    const modelOption = {
      id: "model",
      type: "select",
      currentValue: "engine-default",
      options: [],
    };
    assert.equal(shouldMirrorToModelName(cs, modelOption), true,
      "fresh session bootstraps from engine truth");
  });
});

// ============================================================
// shouldMirrorToThinkingField — symmetric to the model rule.
// ============================================================

describe("shouldMirrorToThinkingField — predicate contract", () => {
  test("false inside the thinkingEffort pick window", () => {
    const cs = freshCs({
      modelName: "x",
      thinking: "high",
      thinkingPickedAt: Date.now(),
    });
    assert.equal(shouldMirrorToThinkingField(cs), false);
  });

  test("true outside the thinkingEffort pick window", () => {
    const cs = freshCs({
      modelName: "x",
      thinking: "high",
      thinkingPickedAt: Date.now() - (PICK_DEFER_WINDOW_MS + 1000),
    });
    assert.equal(shouldMirrorToThinkingField(cs), true);
  });

  test("true when no thinkingEffort pick has ever happened", () => {
    const cs = freshCs({ modelName: "x" });
    assert.equal(shouldMirrorToThinkingField(cs), true);
  });
});

// ============================================================
// PICK_DEFER_WINDOW_MS — the window size itself, exposed so the
// value can be adjusted deliberately (and reviewed for regressions).
// ============================================================

describe("PICK_DEFER_WINDOW_MS — window size", () => {
  test("exports a positive integer", () => {
    assert.equal(typeof PICK_DEFER_WINDOW_MS, "number");
    assert.ok(PICK_DEFER_WINDOW_MS > 0,
      "the window MUST be positive or the mirror never defers");
    assert.ok(PICK_DEFER_WINDOW_MS < 60_000,
      "the window SHOULD stay short enough that real cross-client picks propagate promptly");
  });
});
