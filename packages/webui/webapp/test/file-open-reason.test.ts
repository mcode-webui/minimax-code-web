// webapp/test/file-open-reason.test.ts
//
// Unit tests for lib/file-open-reason.ts — the pure classifier the
// right-hand preview panel uses to decide which unsupported-state
// reason copy to render and which action buttons to enable.
//
// Coverage contract:
//
//   1. Each of the four reason categories (`binary`, `oversize`,
//      `outOfBounds`, `unknown`) maps from a recognisable read-file
//      response shape. The server already encodes the four categories
//      via different fields (`payload.binary`, `error.startsWith("file
//      too large")`, the containment regex, anything else), and the
//      UI must keep them straight.
//
//   2. `actionsAvailable` is FALSE only when the path is out of the
//      workspace (containment refused) — the OS opener cannot help
//      when the path the user clicked is not one the server would
//      hand to a child process. For every other reason the buttons
//      stay enabled; the server can still answer `code:"no-opener"`
//      at click time, which is a separate, per-button disable.
//
//   3. The `params` bag carries the substitution data the i18n
//      template needs (`mime` / `error`) so the React layer does not
//      have to re-implement the field-walk.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyUnsupported } from "../lib/file-open-reason";
import type { FsFilePayload } from "../lib/api";

function payload(overrides: Partial<FsFilePayload>): FsFilePayload {
  return {
    ok: false,
    size: 0,
    mime: "",
    language: "",
    binary: false,
    error: "unreadable",
    ...overrides,
  };
}

describe("classifyUnsupported — binary", () => {
  test("payload.binary === true → reason:binary, actions enabled", () => {
    const view = classifyUnsupported(
      "binary file not supported",
      payload({
        binary: true,
        mime: "application/pdf",
        language: "plain",
      }),
    );
    assert.equal(view.reason, "binary");
    assert.equal(view.actionsAvailable, true);
    assert.equal(view.params.mime, "application/pdf");
  });

  test("binary reason falls back to a placeholder mime when payload.mime is empty", () => {
    // The server can return binary=true without a mime (the
    // binary-detection path in fs-util.js only sets mime via the
    // extension map, which has a few entries that resolve to null).
    // The UI still wants to render something readable — the helper
    // substitutes "unknown type" so the panel body does not read
    // "binary ()".
    const view = classifyUnsupported(
      "binary file not supported",
      payload({ binary: true, mime: "" }),
    );
    assert.equal(view.reason, "binary");
    assert.equal(view.params.mime, "unknown type");
  });

  test("containment error wins over the binary flag (priority order)", () => {
    // If the server somehow reports BOTH binary and out-of-bounds,
    // the containment message takes precedence — the buttons stay
    // disabled because the path is unreachable, regardless of
    // whether the bytes happen to be binary.
    const view = classifyUnsupported(
      "路径不在允许的工作区内",
      payload({ binary: true, mime: "application/pdf" }),
    );
    assert.equal(view.reason, "outOfBounds");
    assert.equal(view.actionsAvailable, false);
  });
});

describe("classifyUnsupported — oversize", () => {
  test("'file too large' error → reason:oversize, actions enabled", () => {
    const view = classifyUnsupported(
      "file too large (max 524288 bytes)",
      payload({ size: 1_048_576 }),
    );
    assert.equal(view.reason, "oversize");
    assert.equal(view.actionsAvailable, true);
    // Oversize reason does not need a substitution parameter; the
    // helper returns an empty bag for the React layer.
    assert.deepEqual(view.params, {});
  });

  test("'file too large' error with no payload still classifies as oversize", () => {
    // Defensive — the network layer sometimes swallows the body
    // (e.g. a 413 without a JSON payload). The error string alone
    // is enough for the classifier to pick the right branch.
    const view = classifyUnsupported("file too large", null);
    assert.equal(view.reason, "oversize");
    assert.equal(view.actionsAvailable, true);
  });
});

describe("classifyUnsupported — outOfBounds", () => {
  for (const msg of [
    "路径不在允许的工作区内",
    "out of allowed roots",
    "MCODE_WEBUI_WORKSPACE_ROOTS not set",
  ]) {
    test(`'${msg}' → reason:outOfBounds, actions disabled`, () => {
      const view = classifyUnsupported(msg, payload({}));
      assert.equal(view.reason, "outOfBounds");
      assert.equal(view.actionsAvailable, false);
      assert.equal(view.params.error, msg);
    });
  }
});

describe("classifyUnsupported — unknown (catch-all)", () => {
  test("unrecognised error string → reason:unknown, actions enabled", () => {
    const view = classifyUnsupported("HTTP 500", payload({}));
    assert.equal(view.reason, "unknown");
    assert.equal(view.actionsAvailable, true);
    assert.equal(view.params.error, "HTTP 500");
  });

  test("network failure message → reason:unknown, actions enabled", () => {
    const view = classifyUnsupported("no response within 5000ms", null);
    assert.equal(view.reason, "unknown");
    assert.equal(view.actionsAvailable, true);
    assert.equal(view.params.error, "no response within 5000ms");
  });

  test("empty error string falls through to unknown (defensive)", () => {
    const view = classifyUnsupported("", null);
    assert.equal(view.reason, "unknown");
    assert.equal(view.actionsAvailable, true);
  });
});
