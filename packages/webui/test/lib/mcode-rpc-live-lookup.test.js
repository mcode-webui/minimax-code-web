// webui/test/lib/mcode-rpc-live-lookup.test.js
//
// `requireLive` must distinguish "no turn in flight" from "this turn is on a
// transport that has no engine session".
//
// Background. `activeChildByCid` holds two unrelated kinds of object: an
// `McodeAcpClient` for the ACP transport (`.request` / `.notify` / `.alive`)
// and a raw `ChildProcess` for the exec transport (none of those). The lookup
// originally gated on `.alive` alone, which excluded the exec child only
// because that class happens to lack the property — so every exec-mode
// `requireLive` call failed with "mcode acp client unavailable", a message
// that reads as a transient outage. It is not: `runMcodeAcp` selects exec
// whenever `cs.permissions !== "Full access"`, and the one-shot `mcode exec`
// CLI has no persistent session for `session/set_config_option` or
// `session/cancel` to address. `POST /api/permissions` and `POST /api/set-model`
// surface that string as a `warning`, so a working feature (the change applies
// to the next turn) looked broken.
//
// Uses the real `state-bus` and `mcode-rpc` singletons rather than fresh
// imports: `mcode-rpc` reaches the registry through its own import of
// `state-bus`, so re-instantiating either one independently would give the test
// a different registry from the one it is asserting on.

import test from "node:test";
import assert from "node:assert/strict";

import { setActiveChild, clearActiveChild, beginRun, endRun, activeRunCount } from "../../server/lib/state-bus.js";
import { clientForCid, setConfigOption, cancelSession } from "../../server/lib/mcode-rpc.js";

/** A stand-in for `ChildProcess`: liveness-ish fields, no RPC surface. */
function execChild() {
  return { pid: 4242, exitCode: null, killed: false, signalCode: null };
}

/** A stand-in for `McodeAcpClient`. */
function acpClient(alive = true) {
  return {
    alive,
    request: async () => ({ ok: 1 }),
    notify: async () => undefined,
  };
}

const CID = "rpc-live-lookup";

test("clientForCid — capability, not a property the exec child merely lacks", async (t) => {
  t.afterEach(() => clearActiveChild(CID));

  await t.test("an ACP child is returned", async () => {
    setActiveChild(CID, acpClient());
    const c = await clientForCid(CID, true);
    assert.ok(c, "ACP child should be returned");
    assert.equal(typeof c.request, "function");
  });

  await t.test("an exec child is NOT returned — it has no RPC surface", async () => {
    setActiveChild(CID, execChild());
    assert.equal(await clientForCid(CID, true), null);
  });

  await t.test("a dead ACP child is not returned", async () => {
    setActiveChild(CID, acpClient(false));
    assert.equal(await clientForCid(CID, true), null);
  });

  await t.test("nothing registered is null under requireLive", async () => {
    clearActiveChild(CID);
    assert.equal(await clientForCid(CID, true), null);
  });
});

test("requireLive failure — the code distinguishes the two cases", async (t) => {
  t.afterEach(() => clearActiveChild(CID));

  await t.test("exec transport: no_acp_session, not no_client", async () => {
    setActiveChild(CID, execChild());
    const r = await setConfigOption("mvs_x", "permissionMode", "default", CID);
    assert.equal(r.ok, false);
    assert.equal(r.code, "no_acp_session");
    assert.match(r.error, /exec transport/);
    assert.match(r.error, /next turn/);
  });

  await t.test("nothing in flight: the plain no_client case", async () => {
    clearActiveChild(CID);
    const r = await setConfigOption("mvs_x", "permissionMode", "default", CID);
    assert.equal(r.ok, false);
    assert.equal(r.code, "no_client");
  });

  await t.test("cancelSession carries the same distinction", async () => {
    setActiveChild(CID, execChild());
    const r = await cancelSession("mvs_x", CID);
    assert.equal(r.ok, false);
    assert.equal(r.code, "no_acp_session");
  });
});

test("a live ACP child still receives the RPC", async (t) => {
  t.afterEach(() => clearActiveChild(CID));
  const seen = [];
  setActiveChild(CID, {
    alive: true,
    request: async (method, params) => {
      seen.push([method, params]);
      return { applied: true };
    },
    notify: async (method) => {
      seen.push([method]);
    },
  });
  const r = await setConfigOption("mvs_x", "permissionMode", "default", CID);
  assert.equal(r.ok, true);
  assert.equal(r.data.applied, true);
  assert.deepEqual(seen[0], ["session/set_config_option", {
    sessionId: "mvs_x",
    configId: "permissionMode",
    value: "default",
  }]);
});

test("the run registry and the live lookup coexist", async (t) => {
  t.afterEach(() => {
    endRun(CID);
    clearActiveChild(CID);
  });
  // Both the P0 turn guard and this lookup key off the cid; claiming a run
  // must not disturb the active-child registration the RPC path consults.
  assert.equal(beginRun(CID, null).ok, true);
  setActiveChild(CID, acpClient());
  assert.ok(await clientForCid(CID, true));
  endRun(CID);
  assert.equal(activeRunCount(), 0);
  // The child registration outlives the run claim — the runner clears it in its
  // own `finally`, and the lookup is independent of the claim.
  assert.ok(await clientForCid(CID, true));
});
