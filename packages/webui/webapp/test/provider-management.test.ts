// webapp/test/provider-management.test.ts
//
// Unit tests for lib/provider-management.ts — the pure helpers that
// back the settings-modal provider management panel (ticket 03).
//
// Why this test exists: the management panel is render-heavy and the
// suite has no render harness for it, so the load-bearing logic has
// to be pinned without a DOM. These helpers drive:
//   - id / model-row validation (the Save button's enable rule);
//   - draft → wire conversion (the shape PUT /api/providers sees);
//   - the test-connection outcome → UI string mapping (structured
//     error rendering).
// A regression in any of those surfaces as a UI that "doesn't work"
// rather than a test failure, so the pinning here matters.
//
// Style note: the helpers are pure, the tests are pure — no DOM,
// no fetch, no React. They run under `pnpm test:webapp`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  THINKING_LEVELS,
  MODALITIES,
  blankAuth,
  blankModel,
  describeTestOutcome,
  draftFromView,
  draftToWire,
  newDraftProvider,
  validateModelRow,
  validateProviderId,
  type DraftProvider,
} from "../lib/provider-management";
import type { ProviderView } from "../lib/api";

const T = (key: string) =>
  ({
    "providers.testOk": "Connected in {{ms}}ms",
    "providers.testInvalidKey": "API key is invalid or missing",
    "providers.testBadProtocol": "Unsupported protocol",
    "providers.testProbeFailed": "Could not reach the endpoint",
    "providers.testTimeout": "Timed out",
    "providers.testHttp": "Endpoint replied {{status}}",
  } as Record<string, string>)[key] ?? key;

function view(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "p1",
    label: "P1",
    enabled: true,
    protocol: "openai",
    auth: {
      type: "byok",
      hasKey: true,
      apiKeyMasked: "sk-a***b",
      baseURL: "https://api.example.com",
    },
    models: [{ id: "m1", label: "M1" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// THINKING_LEVELS / MODALITIES — the enum values the form sends.
// ---------------------------------------------------------------------

describe("provider-management — enum values", () => {
  test("THINKING_LEVELS covers low / medium / high", () => {
    assert.deepEqual([...THINKING_LEVELS], ["low", "medium", "high"]);
  });

  test("MODALITIES covers text / image / audio / video", () => {
    assert.deepEqual([...MODALITIES], ["text", "image", "audio", "video"]);
  });
});

// ---------------------------------------------------------------------
// validateProviderId — server enforces the same regex.
// ---------------------------------------------------------------------

describe("validateProviderId — id format", () => {
  test("empty id is rejected with a stable message", () => {
    const err = validateProviderId("");
    assert.match(err ?? "", /id required/);
    assert.match(err ?? "", /id required/);
  });

  test("whitespace-only id is rejected", () => {
    assert.match(validateProviderId("   ") ?? "", /id required/);
  });

  test("ids starting with a separator are rejected", () => {
    assert.match(validateProviderId("-foo") ?? "", /invalid id/);
    assert.match(validateProviderId(".foo") ?? "", /invalid id/);
    assert.match(validateProviderId("_foo") ?? "", /invalid id/);
  });

  test("ids containing whitespace are rejected", () => {
    assert.match(validateProviderId("foo bar") ?? "", /invalid id/);
  });

  test("valid ids return null", () => {
    assert.equal(validateProviderId("p1"), null);
    assert.equal(validateProviderId("openai_compat"), null);
    assert.equal(validateProviderId("a-b-c.d"), null);
  });
});

// ---------------------------------------------------------------------
// validateModelRow — per-row shape.
// ---------------------------------------------------------------------

describe("validateModelRow — model-row shape", () => {
  test("empty id is rejected", () => {
    const err = validateModelRow(blankModel());
    assert.match(err ?? "", /model id required/);
  });

  test("non-numeric contextLimit is rejected", () => {
    const err = validateModelRow({
      ...blankModel(),
      id: "m1",
      contextLimit: "100k",
    });
    assert.match(err ?? "", /context limit/);
  });

  test("unknown thinking level is rejected", () => {
    const err = validateModelRow({
      ...blankModel(),
      id: "m1",
      thinkingLevels: ["ultra"],
    });
    assert.match(err ?? "", /thinking level/);
  });

  test("unknown modality is rejected", () => {
    const err = validateModelRow({
      ...blankModel(),
      id: "m1",
      modalities: ["hologram"],
    });
    assert.match(err ?? "", /modality/);
  });

  test("a well-formed row returns null", () => {
    const err = validateModelRow({
      ...blankModel(),
      id: "m1",
      label: "M1",
      contextLimit: "128000",
      thinkingLevels: ["low", "high"],
      modalities: ["text", "image"],
    });
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------
// draftFromView — server view → form draft.
// ---------------------------------------------------------------------

describe("draftFromView — view → draft", () => {
  test("apiKey is always the empty sentinel (placeholder carries the masked value)", () => {
    // Pinning this — the load-bearing piece of the keep-existing-key
    // convention. If apiKey ever leaks from the masked placeholder
    // into the controlled field, every edit wipes the plaintext.
    const draft = draftFromView(view());
    assert.equal(draft.auth.apiKey, "");
    assert.equal(draft.apiKeyMasked, "sk-a***b");
    assert.equal(draft.hasKey, true);
  });

  test("preset field is preserved", () => {
    const draft = draftFromView(view({ preset: "openai" }));
    assert.equal(draft.preset, "openai");
    assert.equal(draft.isNew, false);
  });

  test("missing preset defaults to null", () => {
    const draft = draftFromView(view());
    assert.equal(draft.preset, null);
  });

  test("models are converted: contextLimit becomes a string", () => {
    const draft = draftFromView(view({
      models: [{ id: "m1", label: "M1", contextLimit: 128000, thinkingLevels: ["low"], modalities: ["text"] }],
    }));
    assert.equal(draft.models.length, 1);
    const row = draft.models[0];
    assert.ok(row, "model row present");
    assert.equal(row.contextLimit, "128000");
    assert.deepEqual(row.thinkingLevels, ["low"]);
    assert.deepEqual(row.modalities, ["text"]);
  });
});

// ---------------------------------------------------------------------
// draftToWire — form draft → wire shape.
// ---------------------------------------------------------------------

describe("draftToWire — draft → wire", () => {
  test("empty model rows are dropped", () => {
    const draft: DraftProvider = {
      ...newDraftProvider(),
      id: "p1",
      models: [
        { id: "", label: "", contextLimit: "", thinkingLevels: [], modalities: [] },
        { id: "m1", label: "M1", contextLimit: "", thinkingLevels: [], modalities: [] },
      ],
    };
    const wire = draftToWire(draft);
    assert.equal(wire.models.length, 1);
    const row = wire.models[0];
    assert.ok(row, "kept row present");
    assert.equal(row.id, "m1");
  });

  test("empty label is omitted on the wire (server falls back to id)", () => {
    const draft: DraftProvider = { ...newDraftProvider(), id: "p1", label: "" };
    const wire = draftToWire(draft);
    assert.equal(wire.label, undefined);
  });

  test("empty baseURL is omitted", () => {
    const draft: DraftProvider = {
      ...newDraftProvider(),
      id: "p1",
      auth: { type: "byok", apiKey: "sk-x", baseURL: "  " },
    };
    const wire = draftToWire(draft);
    assert.equal(wire.auth.baseURL, undefined);
  });

  test("preset is preserved only when truthy", () => {
    const draft: DraftProvider = { ...newDraftProvider(), id: "p1", preset: null };
    assert.equal(draftToWire(draft).preset, undefined);
    const presetDraft: DraftProvider = { ...newDraftProvider(), id: "p1", preset: "openai" };
    assert.equal(draftToWire(presetDraft).preset, "openai");
  });

  test("apiKey is forwarded verbatim (the sentinel stays empty)", () => {
    // The convention: an empty apiKey on the wire means "keep existing".
    // draftToWire MUST forward "" unchanged — a UI that wrapped it
    // back to a placeholder would silently rewrite keys.
    const draft: DraftProvider = {
      ...newDraftProvider(),
      id: "p1",
      auth: { type: "byok", apiKey: "", baseURL: "" },
    };
    const wire = draftToWire(draft);
    assert.equal(wire.auth.apiKey, "");
  });

  test("a typed apiKey is forwarded verbatim", () => {
    const draft: DraftProvider = {
      ...newDraftProvider(),
      id: "p1",
      auth: { type: "byok", apiKey: "sk-realtype-12345", baseURL: "" },
    };
    const wire = draftToWire(draft);
    assert.equal(wire.auth.apiKey, "sk-realtype-12345");
  });

  test("contextLimit is parsed to a number when present, omitted when blank", () => {
    const draft: DraftProvider = {
      ...newDraftProvider(),
      id: "p1",
      models: [
        { id: "a", label: "", contextLimit: "128000", thinkingLevels: [], modalities: [] },
        { id: "b", label: "", contextLimit: "", thinkingLevels: [], modalities: [] },
      ],
    };
    const wire = draftToWire(draft);
    const first = wire.models[0];
    const second = wire.models[1];
    assert.ok(first && second, "both rows present");
    assert.equal(first.contextLimit, 128000);
    assert.equal(second.contextLimit, undefined);
  });

  test("thinkingLevels and modalities are dropped when empty", () => {
    const draft: DraftProvider = {
      ...newDraftProvider(),
      id: "p1",
      models: [
        { id: "a", label: "", contextLimit: "", thinkingLevels: [], modalities: [] },
        { id: "b", label: "", contextLimit: "", thinkingLevels: ["low"], modalities: ["text"] },
      ],
    };
    const wire = draftToWire(draft);
    const first = wire.models[0];
    const second = wire.models[1];
    assert.ok(first && second, "both rows present");
    assert.equal(first.thinkingLevels, undefined);
    assert.equal(first.modalities, undefined);
    assert.deepEqual(second.thinkingLevels, ["low"]);
    assert.deepEqual(second.modalities, ["text"]);
  });

  test("draftId is never written to the wire", () => {
    // `draftId` is a UI-only identity — the PUT body uses `id`. A
    // regression that accidentally serialises it would leak the
    // `__new_` prefix to the server, where it would fail the id
    // regex validation.
    const draft: DraftProvider = {
      ...newDraftProvider(),
      id: "p1",
      draftId: "__new_should_not_leak",
    };
    const wire = draftToWire(draft) as Record<string, unknown>;
    assert.equal(wire.draftId, undefined);
  });
});

// ---------------------------------------------------------------------
// describeTestOutcome — wire shape → UI string.
// ---------------------------------------------------------------------

describe("describeTestOutcome — wire → UI", () => {
  test("ok=true: tone=ok with the latency interpolated", () => {
    const out = describeTestOutcome(T, { ok: true, code: "OK", latencyMs: 312 });
    assert.equal(out.tone, "ok");
    assert.match(out.text, /312/);
  });

  test("INVALID_KEY: tone=error with the dedicated message", () => {
    const out = describeTestOutcome(T, { ok: false, code: "INVALID_KEY", error: "too short" });
    assert.equal(out.tone, "error");
    assert.match(out.text, /invalid or missing/);
  });

  test("BAD_PROTOCOL: tone=error with the dedicated message", () => {
    const out = describeTestOutcome(T, { ok: false, code: "BAD_PROTOCOL" });
    assert.equal(out.tone, "error");
    assert.match(out.text, /Unsupported/);
  });

  test("PROBE_FAILED with timeout: dedicated timeout message", () => {
    const out = describeTestOutcome(T, { ok: false, code: "PROBE_FAILED", error: "timeout" });
    assert.equal(out.tone, "error");
    assert.match(out.text, /Timed out/);
  });

  test("PROBE_FAILED with HTTP status: status is interpolated", () => {
    const out = describeTestOutcome(T, { ok: false, code: "PROBE_FAILED", error: "HTTP 401" });
    assert.equal(out.tone, "error");
    assert.match(out.text, /401/);
  });

  test("PROBE_FAILED with network error: appended to the generic message", () => {
    const out = describeTestOutcome(T, { ok: false, code: "PROBE_FAILED", error: "ECONNREFUSED" });
    assert.equal(out.tone, "error");
    assert.match(out.text, /ECONNREFUSED/);
  });

  test("unknown code with no error: falls through to the generic message", () => {
    const out = describeTestOutcome(T, { ok: false, code: "MYSTERY" });
    assert.equal(out.tone, "error");
    assert.match(out.text, /Could not reach the endpoint/);
  });
});

// ---------------------------------------------------------------------
// blankAuth / blankModel / newDraftProvider — defaults that affect UX.
// ---------------------------------------------------------------------

describe("defaults — blank fields are well-formed", () => {
  test("blankAuth starts as byok + empty key + empty baseURL", () => {
    const auth = blankAuth();
    assert.equal(auth.type, "byok");
    assert.equal(auth.apiKey, "");
    assert.equal(auth.baseURL, "");
  });

  test("blankModel is empty across every field", () => {
    const m = blankModel();
    assert.equal(m.id, "");
    assert.equal(m.label, "");
    assert.equal(m.contextLimit, "");
    assert.deepEqual(m.thinkingLevels, []);
    assert.deepEqual(m.modalities, []);
  });

  test("newDraftProvider is enabled, openai, byok, isNew=true, no models", () => {
    const d = newDraftProvider();
    assert.equal(d.enabled, true);
    assert.equal(d.protocol, "openai");
    assert.equal(d.auth.type, "byok");
    assert.equal(d.isNew, true);
    assert.equal(d.models.length, 0);
    assert.equal(d.markedForDeletion, false);
  });

  test("newDraftProvider has a unique, opaque draftId starting with __new_", () => {
    // The `__new_` prefix is the UI's signal for "this draft was
    // never saved" — markDeleted uses it to hard-remove rather than
    // soft-delete (which would leave a phantom row after save).
    const a = newDraftProvider();
    const b = newDraftProvider();
    assert.ok(a.draftId.startsWith("__new_"), "draftId starts with __new_");
    assert.notEqual(a.draftId, b.draftId, "each draft has its own id");
  });

  test("draftFromView mirrors the wire id into both `id` and `draftId`", () => {
    // The `draftId` is the selection key; it MUST be stable for an
    // existing provider so the editor stays on the row after a
    // re-render. Mirroring the wire id is the simplest invariant
    // that gives a unique key without extra bookkeeping.
    const d = draftFromView(view());
    assert.equal(d.draftId, "p1");
    assert.equal(d.id, "p1");
  });
});