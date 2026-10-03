// webui/test/routes/protocol.check.mjs
// Unit tests for server/routes/protocol.js — HTTP status code mapping for
// mcode acp protocol endpoints (set-mode, set-config-option, cancel,
// load-session, activate-session, list-sessions, capabilities).
//
// Why this test exists: routes/protocol.js maps mcode acp's `code` field
// to an HTTP status code:
//   - "unsupported" → 501 (mcode 0.1.5 doesn't implement this method)
//   - "no_client"   → 503 (mcode acp client not running)
//   - /not.found|invalid/ → 404
//   - /conflict|policy/  → 409
//   - other → 500
// Plus 400 for input validation (missing sessionId/mode/key).
// Bugs here = the front-end gets a 500 instead of a 501 and shows the user
// a generic "something broke" instead of "this feature is not available".
//
// Test strategy: USE setupMocks to mock mcode-rpc.js. We can control the
// returned code per test to verify each branch of the status-code mapping.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath } from "../helpers/_setup.js";
// M3-B9: type discrimination goes through the exported predicate, never
// `err.name` — `name` is writable, so one stray assignment would turn the
// gate's structured 501 into an unrelated failure mode.
const { isEngineCapabilityNotSupportedError } = await import(
  "../helpers/_setup.js"
).then(() => import(absPath("engine/errors.js")));

let protoRoute;
before(async (t) => {
  await setupMocks(t, {});
  protoRoute = await import(absPath("routes/protocol.js"));
});

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body || {}), "utf8")]);
}
function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}
function fakeCs() {
  return {
    workspace: { dir: "/ws-X", branch: null, tree: null },
    permissions: "Full access",
    planMode: false,
  };
}

describe("handleSetMode — /api/protocol/set-mode", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetMode(
      fakeReq({ mode: "plan_mode" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  test("400 when mode is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetMode(
      fakeReq({ sessionId: "mvs_aaa" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  // M3-B9: the two cases below are now TRANSPORT-DEPENDENT, and the
  // difference is the batch's shipped behaviour rather than a flake.
  // `acp` has no registered engine provider, so the hard gate reports
  // `unregistered-transport` and the route answers exactly as it always
  // has. `runtime` registers `local-runtime-v2`, whose declaration is
  // audited to carry no `setMode`, so the gate throws and the ROUTER
  // answers 501 — the handler under test never writes a status at all,
  // which is why the runtime case below asserts the throw.
  const ENV_TRANSPORT = process.env.MCODE_WEBUI_TRANSPORT || "acp";
  const GATED = ENV_TRANSPORT === "runtime";

  test("200 once the engine accepts the mode", async () => {
    const res = fakeRes();
    const call = protoRoute.handleSetMode(
      fakeReq({ sessionId: "mvs_aaa", mode: "plan" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    if (GATED) {
      // The route must NOT catch the capability error — folding it into
      // a status table here would turn "the engine cannot do this" into
      // a 502. It propagates to app.js, which owns the 501 mapping.
      await assert.rejects(call, (e) => isEngineCapabilityNotSupportedError(e));
      assert.equal(res._status, null, "the handler must not write a status for the gate's 501");
      return;
    }
    await call;
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.mode, "plan");
    assert.equal(body.fallback, undefined);
  });

  test("501 with the slash-command fallback hint when the engine refuses", async () => {
    // The wrapper no longer produces 'unsupported' itself, but the route still
    // maps that code to 501 + the degraded-path hint. The hint survives the
    // engine's own refusal and is deliberately NOT on the gate's 501 — a
    // capability that does not exist has no degraded action to fall back to.
    const { registerRpcMock } = await import("../helpers/_setup.js");
    registerRpcMock({ setMode: async () => ({ ok: false, code: "unsupported", error: "no" }) });
    try {
      if (GATED) {
        // Under a provider that declares no mode write the gate refuses
        // first and the engine is never asked, so the hint is unreachable
        // here. Asserting the refusal is the honest version of this case.
        await assert.rejects(
          protoRoute.handleSetMode(fakeReq({ sessionId: "mvs_aaa", mode: "plan" }), fakeRes(), {
            cs: fakeCs(),
            cid: "cid-1",
          }),
          (e) => isEngineCapabilityNotSupportedError(e),
        );
        return;
      }
      const res = fakeRes();
      await protoRoute.handleSetMode(
        fakeReq({ sessionId: "mvs_aaa", mode: "plan" }),
        res,
        { cs: fakeCs(), cid: "cid-1" },
      );
      assert.equal(res._status, 501);
      const body = JSON.parse(res._body);
      assert.equal(body.code, "unsupported");
      assert.equal(body.fallback, "send_plan_as_prompt");
    } finally {
      registerRpcMock({ setMode: async () => ({ ok: true, data: { modeId: "plan" } }) });
    }
  });
});

describe("handleSetConfigOption — /api/protocol/set-config-option", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetConfigOption(
      fakeReq({ key: "permissionMode", value: "auto" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  test("400 when key is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetConfigOption(
      fakeReq({ sessionId: "mvs_aaa", value: "auto" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  test("200 once the engine accepts the option", async () => {
    const res = fakeRes();
    await protoRoute.handleSetConfigOption(
      fakeReq({ sessionId: "mvs_aaa", key: "permissionMode", value: "auto" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    assert.equal(JSON.parse(res._body).ok, true);
  });
});

describe("handleCancel — /api/protocol/cancel", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleCancel(fakeReq({}), res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 400);
  });

  test("200 with cancelled:true once the notification is sent", async () => {
    const res = fakeRes();
    await protoRoute.handleCancel(
      fakeReq({ sessionId: "mvs_aaa" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.cancelled, true);
    assert.equal(body.fallback, undefined, "no SIGKILL hint when the client answered");
  });

  test("200 with cancelled:false + killEndpoint when the notification cannot be delivered", async () => {
    // Route is a thin notification surface — it must NOT claim a hard kill
    // it never performs. On a refusal it tells the caller the notification
    // failed and points them at /api/stop, which is where the actual
    // gentle-then-SIGKILL cascade lives (chat.js#handleStop).
    const { registerRpcMock } = await import("../helpers/_setup.js");
    registerRpcMock({ cancelSession: async () => ({ ok: false, code: "no_client", error: "client offline" }) });
    try {
      const res = fakeRes();
      await protoRoute.handleCancel(
        fakeReq({ sessionId: "mvs_aaa" }),
        res,
        { cs: fakeCs(), cid: "cid-1" },
      );
      assert.equal(res._status, 200);
      const body = JSON.parse(res._body);
      assert.equal(body.ok, true);
      assert.equal(body.cancelled, false);
      assert.equal(body.warning, "client offline");
      assert.equal(body.code, "no_client");
      assert.equal(
        body.fallback,
        undefined,
        "must not claim a hard_kill fallback the route never executes",
      );
      assert.equal(
        body.killEndpoint,
        "/api/stop",
        "must point the caller at the endpoint that actually carries the kill cascade",
      );
    } finally {
      registerRpcMock({ cancelSession: async () => ({ ok: true, data: { notified: true } }) });
    }
  });

});

describe("handleLoadSession — /api/protocol/load-session", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleLoadSession(fakeReq({}), res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 400);
  });

  test("500 when mcode acp returns code:'unsupported' (handleLoadSession has DIFFERENT mapping than setMode)", async () => {
    // handleLoadSession does NOT have 501 in its status code mapping.
    // It maps: no_client → 503, /not.found|invalid/ → 404, OTHER → 500.
    // 'unsupported' falls through to 500.
    const res = fakeRes();
    await protoRoute.handleLoadSession(
      fakeReq({ sessionId: "mvs_aaa", cwd: "/ws-X" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 500);
  });
});

describe("handleActivateSession — /api/protocol/activate-session", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleActivateSession(fakeReq({}), res, {
      cs: fakeCs(),
      cid: "cid-1",
    });
    assert.equal(res._status, 400);
  });

  test("200 once the engine accepts the activation", async () => {
    const res = fakeRes();
    await protoRoute.handleActivateSession(
      fakeReq({ sessionId: "mvs_aaa" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    assert.equal(JSON.parse(res._body).ok, true);
  });
});

describe("handleListSessions — /api/protocol/list-sessions", () => {
  // The handler reads the engine through the facade
  // (server/engine/session-reads.js → acp-client.js#listAllMcodeSessions),
  // so that is the seam a test has to drive. It used to reach for
  // `mcode-rpc.js#listSessions` and the override below landed on
  // `registerAcpMock({ listSessions })` — a key nothing read, which made
  // both cases assert against a hard-coded empty list. M3-B1 drives the
  // real seam so "the filter works" is actually proven.
  //
  // Note: the engine answer is an array (not `{sessions: [...]}`).
  const WIRE = [
    { sessionId: "mvs_x", cwd: "/ws-X", title: "X", updatedAt: "2026-10-03T00:00:00.000Z" },
    { sessionId: "mvs_y", cwd: "/ws-Other" },
  ];

  beforeEach(async () => {
    const { registerAcpMock } = await import("../helpers/_setup.js");
    registerAcpMock({ listAllMcodeSessions: async () => [...WIRE] });
  });

  test("returns 200 + the unfiltered list when neither ?cwd nor cs.workspace.dir is set", async () => {
    // `fakeCs()` carries workspace.dir = "/ws-X", which the handler uses as
    // the cwd fallback — so the unfiltered branch needs a cs without one.
    const res = fakeRes();
    await protoRoute.handleListSessions(
      { url: "/api/protocol/list-sessions" },
      res,
      { cs: { workspace: { dir: null } }, cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.sessions, WIRE);
    // No cwd to filter by means the endpoint does not echo a cwd key.
    assert.equal("cwd" in body, false);
  });

  test("returns 200 + the cwd-filtered list when cwd query is provided", async () => {
    const req = { url: "/api/protocol/list-sessions?cwd=/ws-X" };
    const res = fakeRes();
    await protoRoute.handleListSessions(req, res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.cwd, "/ws-X");
    assert.deepEqual(body.sessions, [WIRE[0]]);
  });

  test("falls back to cs.workspace.dir when ?cwd is absent", async () => {
    // fakeCs() is exactly that case: no ?cwd, workspace.dir = "/ws-X".
    const res = fakeRes();
    await protoRoute.handleListSessions(
      { url: "/api/protocol/list-sessions" },
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    const body = JSON.parse(res._body);
    assert.equal(body.cwd, "/ws-X");
    assert.deepEqual(body.sessions, [WIRE[0]]);
  });
});

describe("handleCapabilities — /api/protocol/capabilities", () => {
  test("returns 200 + mcodeVersion + capabilities map + notes", async () => {
    const res = fakeRes();
    await protoRoute.handleCapabilities(null, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.mcodeVersion, "string");
    assert.equal(typeof body.capabilities, "object");
    assert.equal(typeof body.notes, "object");
  });
});
