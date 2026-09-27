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

describe("classifyUnsupported — credential (slice 16)", () => {
  test("payload.code='credential' → reason:credential, confirmable, actions enabled", () => {
    const view = classifyUnsupported(
      "credential file — preview disabled",
      payload({ code: "credential", credentialReason: "dotenv" }),
      "/some/workspace/.env",
    );
    assert.equal(view.reason, "credential");
    assert.equal(view.actionsAvailable, true);
    assert.equal(view.confirmable, true);
    assert.equal(view.credentialSubReason, "dotenv");
    assert.equal(view.params.error, "credential file — preview disabled");
    assert.equal(view.params.subReason, "dotenv");
  });

  test("credential reason is detected even without payload.code when the path matches and the error matches", () => {
    // Defensive: if a future server response drops `code` but the
    // path matches the credential predicate AND the error carries the
    // refusal string, the classifier still routes the panel to the
    // credential branch.
    const view = classifyUnsupported(
      "credential file — preview disabled",
      payload({}),
      "/home/user/.ssh/id_rsa",
    );
    assert.equal(view.reason, "credential");
    assert.equal(view.confirmable, true);
    assert.equal(view.credentialSubReason, "ssh-key");
  });

  test("credential reason surfaces the ssh-meta sub-reason for known_hosts", () => {
    const view = classifyUnsupported(
      "credential file — preview disabled",
      payload({ code: "credential" }),
      "/home/user/.ssh/known_hosts",
    );
    assert.equal(view.reason, "credential");
    assert.equal(view.credentialSubReason, "ssh-meta");
  });

  test("credential reason surfaces the key-file sub-reason for *.pem", () => {
    const view = classifyUnsupported(
      "credential file — preview disabled",
      payload({ code: "credential" }),
      "/etc/ssl/server.pem",
    );
    assert.equal(view.reason, "credential");
    assert.equal(view.credentialSubReason, "key-file");
  });

  test("path-based defensive fallback ONLY fires when the server's code field is missing", () => {
    // The classifier has two routes to "credential":
    //   1. payload.code === "credential" (authoritative)
    //   2. (defensive) path matches AND error string matches
    // The defensive route MUST NOT overrule the server's structured
    // code — `environment.ts` matching the credential predicate would
    // be a false positive that breaks every workspace that uses one,
    // so the predicate must not flag it. With the server's
    // `code: "credential"` set, the classifier correctly routes to
    // credential regardless of the path. The path-based check is only
    // there for version-skew resilience, not as a primary signal.
    const serverSaysCredential = classifyUnsupported(
      "credential file — preview disabled",
      payload({ code: "credential" }),
      "/work/environment.ts",
    );
    assert.equal(serverSaysCredential.reason, "credential");
    // Path-based defensive branch fires only when the server did NOT
    // emit code but the path + error string both match.
    const pathSaysCredential = classifyUnsupported(
      "credential file — preview disabled",
      payload({ /* code omitted */ }),
      "/home/user/.env",
    );
    assert.equal(pathSaysCredential.reason, "credential");
    // And the path alone (no error match) does NOT route to credential.
    const pathNoError = classifyUnsupported(
      "some other error",
      payload({ /* code omitted */ }),
      "/home/user/.env",
    );
    assert.equal(pathNoError.reason, "unknown");
    // And the error alone (no path match) does NOT route to credential.
    const errorNoPath = classifyUnsupported(
      "credential file — preview disabled",
      payload({ /* code omitted */ }),
      "/work/environment.ts",
    );
    assert.equal(errorNoPath.reason, "unknown");
  });

  test("environment.ts does NOT match the credential predicate itself", () => {
    // Direct check on the predicate: it must not flag files whose
    // names happen to contain "env" without the leading dot pattern.
    // This is the legibility check the fixture table also pins.
    const view = classifyUnsupported(
      "credential file — preview disabled",
      payload({ /* code omitted */ }),
      "/work/environment.ts",
    );
    assert.equal(view.reason, "unknown");
  });

  test("credential priority beats binary (defensive)", () => {
    // If the server reports both code:"credential" and binary:true, the
    // credential branch wins — the server already refused the path,
    // the binary flag is informational at that point.
    const view = classifyUnsupported(
      "credential file — preview disabled",
      payload({ code: "credential", binary: true }),
      "/home/user/.npmrc",
    );
    assert.equal(view.reason, "credential");
    assert.equal(view.confirmable, true);
  });
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
