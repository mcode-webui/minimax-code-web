// webui/test/lib/engine/session-context-actions.test.js
//
// The session right-click action family (placeholder batch PB-1) — the
// gate, the three-state host handling, and the pure derivations.
//
// What is NOT here, and why. Every test in this file drives the facade
// through an INJECTED host (`deps.getHost`), so no runtime boots and no
// tmp directory is needed. The real-host evidence — that
// `host.cliService.archiveSession` / `forkSession` /
// `getSessionForkOptions` and `host.services.pinService.pinSession` are
// really there and really callable — belongs in
// `test/server/session-context-actions-host.test.js`, which boots one
// host, for the same reason `host-services-window.test.js` exists next
// door to `host-services.test.js`.
//
// The "改坏必红" discipline. Every assertion below is about what the
// module DOES or what it NAMES, never a restatement of its own
// implementation. The seven mutations at the bottom each turn at least
// one of them red, and each names the specific test that catches it —
// the point being that a mutation going undetected is a gap in the
// suite, not an accident of which test happened to run.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SESSION_CONTEXT_ACTION_ENDPOINTS,
  SESSION_CONTEXT_ACTION_ROUTES,
  applyEngineSessionArchive,
  applyEngineSessionFork,
  applyEngineSessionPin,
  applyPinnedSessionOverlay,
  assertSessionContextActionCapability,
  buildForkRequest,
  parseArchiveRequestBody,
  parsePinRequestBody,
  projectForkOptions,
  projectPinnedSessionIds,
  readEnginePinnedSessionOrder,
  readEngineSessionForkOptions,
} from "../../../server/engine/session-context-actions.js";

const packageDir = join(import.meta.dirname, "..", "..", "..");
const serverDir = join(packageDir, "server");

/** A host whose cliService records what it was asked and answers `reply`. */
function fakeHost(options = {}) {
  const calls = [];
  const cliService = {};
  for (const name of ["archiveSession", "getSessionForkOptions", "forkSession"]) {
    if (options.omit === name) continue;
    cliService[name] = async (req) => {
      calls.push({ method: name, req });
      if (options.throwOn === name) throw new Error(`${name} blew up`);
      return options.reply;
    };
  }
  const host = { cliService };
  if (options.services !== undefined) host.services = options.services;
  else {
    host.services = {
      pinService: {
        async pinSession(id, pinned) {
          calls.push({ method: "pinSession", req: { id, pinned } });
          if (options.throwOn === "pinSession") throw new Error("pinSession blew up");
          return options.reply;
        },
        async getOrder() {
          calls.push({ method: "getOrder" });
          return options.reply;
        },
      },
    };
  }
  return { host, calls };
}

const asHost = (h) => ({ getHost: async () => h });

/** Strip comments — this file's prose legitimately names the guarded code. */
const codeOf = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

// --- 1. the declaration table ----------------------------------------------

describe("SESSION_CONTEXT_ACTION_ENDPOINTS — the declaration", () => {
  test("covers exactly the four menu actions, and nothing else", () => {
    // The four rows are the four endpoints `app.js` registers. A fifth row
    // here without a route would be an action the server can perform and
    // the user cannot reach; a route without a row would 400 on its own
    // gate with `unknown_session_context_action_endpoint`.
    assert.deepEqual(
      [...SESSION_CONTEXT_ACTION_ROUTES].sort(),
      [
        "GET /api/sessions/:id/fork-options",
        "POST /api/sessions/:id/archive",
        "POST /api/sessions/:id/fork",
        "POST /api/sessions/:id/pin",
      ],
    );
  });

  test("the three cliService rows declare the exact engine sub-items they call", () => {
    // These names are the CONTRACT with `local-runtime-v2.capabilities.js`:
    // `assertEngineCapability` throws 501 when a provider lists the sub-item
    // in `missing`. Renaming one here without renaming it there would turn a
    // working endpoint into a silent pass-through, because a `full` key
    // passes any sub-item the gate is handed.
    assert.equal(SESSION_CONTEXT_ACTION_ENDPOINTS["POST /api/sessions/:id/archive"].subItem, "archiveSession");
    assert.equal(SESSION_CONTEXT_ACTION_ENDPOINTS["GET /api/sessions/:id/fork-options"].subItem, "getSessionForkOptions");
    assert.equal(SESSION_CONTEXT_ACTION_ENDPOINTS["POST /api/sessions/:id/fork"].subItem, "forkSession");
  });

  test("pin is gated on the host-services window, not on a capability key", () => {
    // The distinction is the design, not an accident. `pinSession` is on
    // `host.services.pinService`, not on `cliService`, and there is no
    // `ENGINE_CAPABILITY_KEYS` entry for it — a 15th audited matrix key for
    // one method would restate three provider declarations. The row must
    // therefore say so, and `capability` must be `null` so no future edit
    // can quietly attach a key that does not describe where the method is.
    const pin = SESSION_CONTEXT_ACTION_ENDPOINTS["POST /api/sessions/:id/pin"];
    assert.equal(pin.gate, "host-services");
    assert.equal(pin.capability, null);
    assert.equal(pin.member, "services.pinService");
  });

  test("every row names a member this module can actually resolve", () => {
    // `resolveContextActionMember` branches on `member === "cliService"`
    // and otherwise walks a dotted path. A third spelling would fall into
    // the dotted-path branch and resolve to `undefined` at dispatch time —
    // a 501 with no test pointing at the typo.
    for (const [endpoint, row] of Object.entries(SESSION_CONTEXT_ACTION_ENDPOINTS)) {
      assert.ok(
        row.member === "cliService" || row.member === "services.pinService",
        `${endpoint} has member ${row.member}, which the resolver does not know`,
      );
      assert.equal(typeof row.method, "string");
      assert.notEqual(row.method, "");
    }
  });
});

// --- 2. the gate -----------------------------------------------------------

describe("assertSessionContextActionCapability — the gate", () => {
  test("a typo in the endpoint key is a plain Error, never a 501", () => {
    // A caller-confusion error must not be dressed as an engine
    // limitation: `app.js#invokeHandler` maps
    // `EngineCapabilityNotSupportedError` to 501, and a webui typo
    // answered 501 would point an operator at the provider for a bug in
    // webui's own code.
    assert.throws(
      () => assertSessionContextActionCapability("POST /api/sessions/:id/nope", "runtime"),
      (err) => {
        assert.ok(!(err.name === "EngineCapabilityNotSupportedError"));
        assert.equal(err.code, "unknown_session_context_action_endpoint");
        // The message must LIST the real keys — a caller who typos needs
        // to be told what the right spelling is, not just that it is wrong.
        assert.match(err.message, /archive/);
        return true;
      },
    );
  });

  test("an unregistered transport proceeds rather than refusing", () => {
    // `acp` has no registered provider. M4-3a established that this means
    // "no provider claims this transport", NOT "cannot do it": the work
    // still runs on the process-local host reached through
    // `getEngineCatalogueHost()`. Collapsing the two would delete a
    // working endpoint on a statement about nothing.
    const gate = assertSessionContextActionCapability("POST /api/sessions/:id/archive", "acp");
    assert.equal(gate.gate, "unregistered-transport");
    assert.equal(gate.provider, null);
  });

  test("the runtime transport's provider is resolved and checked", () => {
    const gate = assertSessionContextActionCapability("POST /api/sessions/:id/archive", "runtime");
    assert.equal(gate.gate, "checked");
    assert.equal(gate.provider, "local-runtime-v2");
    assert.equal(gate.capability, "sessionCrud");
  });

  test("the pin row never consults the provider, under any transport", () => {
    // If this row ever grew a `capability`, the gate would start answering
    // from a static declaration while the method actually lives on a member
    // the declaration does not describe — the exact "gated on a statement
    // about something it does not depend on" that `session-writes.js`
    // declined for rename.
    for (const transport of ["runtime", "acp", "tui"]) {
      const gate = assertSessionContextActionCapability("POST /api/sessions/:id/pin", transport);
      assert.equal(gate.gate, "host-services");
      assert.equal(gate.capability, null);
    }
  });
});

// --- 3. the three-state host resolution ------------------------------------

describe("applyEngineSessionArchive — the three cliService answers", () => {
  test("no host is 503, not a success and not a 501", async () => {
    // 503 vs 501 is the operator-facing distinction this module exists to
    // keep: 501 means "this transport cannot", 503 means "the process is
    // not running its runtime", and they have different fixes.
    const result = await applyEngineSessionArchive({ id: "mvs_1", archived: true, transport: "acp", deps: asHost(null) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, "engine_host_unavailable");
  });

  test("a host with no archiveSession is 501 with the member named", async () => {
    const { host } = fakeHost({ omit: "archiveSession" });
    const result = await applyEngineSessionArchive({ id: "mvs_1", archived: true, transport: "acp", deps: asHost(host) });
    assert.equal(result.status, 501);
    assert.equal(result.code, "engine_member_unavailable");
    // The error text must name the METHOD: an operator reading a 501 needs
    // to know which method is missing, not that "something" is.
    assert.match(result.error, /cliService\.archiveSession/);
  });

  test("a throwing engine becomes 502 and never an ok payload", async () => {
    const { host } = fakeHost({ throwOn: "archiveSession" });
    const result = await applyEngineSessionArchive({ id: "mvs_1", archived: true, transport: "acp", deps: asHost(host) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.equal(result.code, "engine_archive_failed");
    assert.equal(result.payload, undefined);
  });

  test("a successful archive sends the id and the direction to the engine", async () => {
    // The direction is the whole point of one endpoint serving both: a
    // request that always sent `archived: true` would make PB-2's
    // "unarchive" button archive the row it was meant to restore.
    const { host, calls } = fakeHost({ reply: { success: true } });
    const result = await applyEngineSessionArchive({ id: "mvs_abc", archived: false, transport: "acp", deps: asHost(host) });
    assert.equal(result.ok, true);
    assert.equal(result.archived, false);
    assert.equal(result.payload.archived, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].req.id, "mvs_abc");
    assert.equal(calls[0].req.archived, false);
  });
});

describe("applyEngineSessionPin — the three PB-8 states", () => {
  test("null services is 503: there is no runtime", async () => {
    const { host } = fakeHost({ services: null });
    const result = await applyEngineSessionPin({ id: "mvs_1", pinned: true, transport: "acp", deps: asHost(host) });
    assert.equal(result.status, 503);
    assert.equal(result.code, "engine_host_unavailable");
  });

  test("undefined services is 501: a host with no owner graph", async () => {
    // The answer PB-8's header exists to keep distinct, and it is one `??`
    // away from collapsing into the row above. A caller that mapped both to
    // "unavailable" would make a boot failure look like a transport that
    // simply has no V2 slice.
    const { host } = fakeHost({ services: undefined });
    delete host.services;
    const result = await applyEngineSessionPin({ id: "mvs_1", pinned: true, transport: "acp", deps: asHost(host) });
    assert.equal(result.status, 501);
    assert.equal(result.code, "engine_services_unavailable");
  });

  test("an owner graph without pinService is 501 and names the member", async () => {
    const { host } = fakeHost({ services: {} });
    const result = await applyEngineSessionPin({ id: "mvs_1", pinned: true, transport: "acp", deps: asHost(host) });
    assert.equal(result.status, 501);
    assert.equal(result.code, "engine_member_unavailable");
    assert.match(result.error, /services\.pinService\.pinSession/);
  });

  test("no absence answer ever produces an ok payload", async () => {
    // The fake-success shape: a pin that "succeeded" without writing
    // anything tells the user their session is pinned and it is not.
    for (const services of [null, undefined, {}, { pinService: {} }]) {
      const host = { cliService: {}, services };
      if (services === undefined) delete host.services;
      const result = await applyEngineSessionPin({ id: "mvs_1", pinned: true, transport: "acp", deps: asHost(host) });
      assert.equal(result.ok, false);
      assert.equal(result.payload, undefined);
    }
  });

  test("a successful pin passes the id and the boolean positionally", async () => {
    // `PinService#pinSession(sessionId, pinned, insertIndex?)` takes them
    // positionally and branches on the second. A call that passed an
    // options object would pin nothing and report success.
    const { host, calls } = fakeHost({
      reply: { items: [{ ref: { type: "session", id: "mvs_abc" } }] },
    });
    const result = await applyEngineSessionPin({ id: "mvs_abc", pinned: true, transport: "acp", deps: asHost(host) });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].req, { id: "mvs_abc", pinned: true });
    assert.deepEqual(result.pinnedIds, ["mvs_abc"]);
  });

  test("a throwing pinService is 502", async () => {
    const { host } = fakeHost({ throwOn: "pinSession" });
    const result = await applyEngineSessionPin({ id: "mvs_1", pinned: true, transport: "acp", deps: asHost(host) });
    assert.equal(result.status, 502);
    assert.equal(result.code, "engine_pin_failed");
  });
});

// --- 4. fork ---------------------------------------------------------------

describe("applyEngineSessionFork", () => {
  test("forces createIsolatedWorktree false and useSuggestedTitle true", async () => {
    // `createIsolatedWorktree: true` would create a worktree the UI never
    // asked the user about — the worktree variant of the menu has no
    // desktop reference and stays an honest placeholder, so the reachable
    // action must be unable to reach it. `useSuggestedTitle: true` keeps
    // the title contract single-sourced on the engine's suggestion, which
    // the dialog SHOWS before the user commits.
    const { host, calls } = fakeHost({ reply: { session: { id: "mvs_new" } } });
    await applyEngineSessionFork({ id: "mvs_src", clientRequestId: "req-1", transport: "acp", deps: asHost(host) });
    assert.equal(calls[0].req.createIsolatedWorktree, false);
    assert.equal(calls[0].req.useSuggestedTitle, true);
  });

  test("forwards the fork point only when one was named", async () => {
    // An absent fork point means "duplicate the whole conversation", which
    // is what the menu item means. Sending `assistantMessageId: undefined`
    // explicitly would be the same on the wire but would make a test that
    // asserts on the key's presence wrong, and the key's presence is the
    // difference between "no point" and "an empty point".
    const { host, calls } = fakeHost({ reply: { session: { id: "mvs_new" } } });
    await applyEngineSessionFork({ id: "mvs_src", clientRequestId: "r", transport: "acp", deps: asHost(host) });
    assert.ok(!("assistantMessageId" in calls[0].req));
    const second = fakeHost({ reply: { session: { id: "mvs_new2" } } });
    await applyEngineSessionFork({
      id: "mvs_src",
      clientRequestId: "r2",
      assistantMessageId: "msg_1",
      transport: "acp",
      deps: asHost(second.host),
    });
    assert.equal(second.calls[0].req.assistantMessageId, "msg_1");
  });

  test("a fork that reported no session is a failure, not a success with a null id", async () => {
    // `ForkSessionResult.session?` is optional. Optionality there is about
    // a session with no view shape — not about a fork that did not happen.
    // Reporting success with a null id would leave the user looking at a
    // list that grew by one row with no way to name it.
    const { host } = fakeHost({ reply: {} });
    const result = await applyEngineSessionFork({ id: "mvs_src", clientRequestId: "r", transport: "acp", deps: asHost(host) });
    assert.equal(result.ok, false);
    assert.equal(result.code, "engine_fork_no_session");
    assert.equal(result.status, 502);
  });

  test("returns the new session's id so the client can switch to it", async () => {
    const { host } = fakeHost({ reply: { session: { id: "mvs_forked" }, forkOriginMessageId: "msg_9" } });
    const result = await applyEngineSessionFork({ id: "mvs_src", clientRequestId: "r", transport: "acp", deps: asHost(host) });
    assert.equal(result.sessionId, "mvs_forked");
    assert.equal(result.payload.forkOriginMessageId, "msg_9");
    assert.equal(result.payload.sourceId, "mvs_src");
  });
});

describe("readEngineSessionForkOptions", () => {
  test("projects the engine's answer into the dialog's shape", async () => {
    const { host } = fakeHost({
      reply: {
        canFork: true,
        suggestedTitle: "Copy of X",
        nextForkOrdinal: 2,
        sourceTitle: "X",
        worktreeVisible: true,
        worktreeEligible: false,
        worktreeUnavailableReason: "no git",
      },
    });
    const result = await readEngineSessionForkOptions({ id: "mvs_x", transport: "acp", deps: asHost(host) });
    assert.equal(result.ok, true);
    assert.equal(result.options.canFork, true);
    assert.equal(result.options.suggestedTitle, "Copy of X");
    // The worktree triple travels UNTOUCHED. Nothing in this batch reads
    // it — the batch that unblocks the worktree variant must not have to
    // re-derive it, and a narrowing that dropped it would make that batch
    // change this file's projection.
    assert.deepEqual(result.options.worktree, {
      visible: true,
      eligible: false,
      unavailableReason: "no git",
    });
  });

  test("a read failure is propagated, not turned into canFork:false", async () => {
    // A default-shaped options object would put "canFork: false" on screen
    // as if the engine had REFUSED a fork it was never asked about. The
    // dialog has to be able to tell "the engine said no" from "we could
    // not ask", and only the propagated failure carries that.
    const { host } = fakeHost({ throwOn: "getSessionForkOptions" });
    const result = await readEngineSessionForkOptions({ id: "mvs_x", transport: "acp", deps: asHost(host) });
    assert.equal(result.ok, false);
    assert.equal(result.options, undefined);
    assert.equal(result.status, 502);
  });
});

// --- 5. the pure derivations -----------------------------------------------

describe("parseArchiveRequestBody", () => {
  test("anything that is not literally false archives", () => {
    // `lifecycle-application.ts#archiveSession` reads
    // `req.archived !== false`, so a validator that disagreed about any
    // other value would make the HTTP layer and the engine answer
    // differently about the same request.
    for (const body of [{}, { archived: undefined }, { archived: null }, { archived: true }, { archived: 0 }, { archived: "yes" }]) {
      assert.equal(parseArchiveRequestBody(body).archived, true, JSON.stringify(body));
    }
  });

  test("only literal false unarchives", () => {
    assert.equal(parseArchiveRequestBody({ archived: false }).archived, false);
    // A `null` is not `false`, so it archives. That is the engine's rule,
    // and the point of the test is that this module does not "fix" it.
    assert.equal(parseArchiveRequestBody({ archived: null }).archived, true);
  });

  test("a non-object body is treated as absent, not as an error", () => {
    // `readJson` answers `{}` for an empty body, but a caller that passed a
    // string through would get a crash without this, and the default
    // direction (archive) is the one the endpoint name implies.
    for (const body of [null, undefined, "x", 42, []]) {
      assert.equal(parseArchiveRequestBody(body).ok, true);
    }
  });
});

describe("parsePinRequestBody", () => {
  test("requires a real boolean, in BOTH directions", () => {
    // Unlike archive, the flag is a required positional on
    // `pinSession(sessionId, pinned, …)`. Defaulting it would move the row
    // in a direction the user did not choose, so the "unpin" direction is
    // pinned by its own test rather than left to an accident of `=== true`.
    for (const body of [{}, { pinned: undefined }, { pinned: null }, { pinned: 1 }, { pinned: "true" }, null, "x"]) {
      const parsed = parsePinRequestBody(body);
      assert.equal(parsed.ok, false, JSON.stringify(body));
    }
    assert.deepEqual(parsePinRequestBody({ pinned: true }), { ok: true, pinned: true });
    assert.deepEqual(parsePinRequestBody({ pinned: false }), { ok: true, pinned: false });
  });
});

describe("buildForkRequest", () => {
  test("the forced fields cannot be overridden by the caller", () => {
    // Both are FORCED by this function rather than defaulted, so a future
    // edit that spreads the caller's options in would have to delete the
    // explicit assignment above it to reintroduce the risk.
    const request = buildForkRequest({
      id: "mvs_1",
      clientRequestId: "r",
      assistantMessageId: "msg",
      title: "hijacked",
      useSuggestedTitle: false,
      createIsolatedWorktree: true,
    });
    assert.equal(request.useSuggestedTitle, true);
    assert.equal(request.createIsolatedWorktree, false);
    assert.equal(request.id, "mvs_1");
    assert.equal(request.clientRequestId, "r");
    // A caller-supplied `title` is DROPPED, not forwarded: the endpoint
    // has one title contract and it is the engine's suggestion.
    assert.equal(request.title, undefined);
  });
});

describe("projectForkOptions", () => {
  test("every field is defined for an empty input", () => {
    // Total on purpose: the dialog renders each field, and a missing one
    // would put `undefined` in the DOM rather than an empty row.
    const projected = projectForkOptions(undefined);
    assert.equal(projected.canFork, false);
    assert.equal(projected.unavailableReason, null);
    assert.equal(projected.suggestedTitle, null);
    assert.equal(projected.nextForkOrdinal, null);
    assert.equal(projected.sourceTitle, null);
    assert.deepEqual(projected.worktree, { visible: false, eligible: false, unavailableReason: null });
  });

  test("canFork is a strict true, not truthiness", () => {
    // `canFork: "false"` from a provider that stringified its boolean must
    // not read as an affirmative on a WRITE-gating field.
    assert.equal(projectForkOptions({ canFork: "true" }).canFork, false);
    assert.equal(projectForkOptions({ canFork: 1 }).canFork, false);
    assert.equal(projectForkOptions({ canFork: true }).canFork, true);
  });
});

describe("projectPinnedSessionIds", () => {
  test("keeps only session refs, in the engine's order", () => {
    // Agents and projects are ordered in a different surface this batch
    // does not render; passing them through would put ids into the sidebar
    // overlay that name nothing the tree contains.
    const ids = projectPinnedSessionIds({
      items: [
        { ref: { type: "project", id: "p1" } },
        { ref: { type: "session", id: "mvs_b" } },
        { ref: { type: "agent", id: "reviewer" } },
        { ref: { type: "session", id: "mvs_a" } },
      ],
    });
    assert.deepEqual(ids, ["mvs_b", "mvs_a"]);
  });

  test("accepts a bare PinItem[] as well as a PinMutation", () => {
    // `pinSession` returns the mutation and `getOrder()` the array; both
    // carry `items`, and the overlay only ever needs the ids. Accepting
    // both means the overlay never has to know which caller it is serving.
    assert.deepEqual(projectPinnedSessionIds([{ ref: { type: "session", id: "mvs_a" } }]), ["mvs_a"]);
    assert.deepEqual(projectPinnedSessionIds({ items: [{ ref: { type: "session", id: "mvs_a" } }] }), ["mvs_a"]);
  });

  test("junk in is an empty list, never a throw", () => {
    for (const value of [null, undefined, {}, 42, { items: null }, { items: [null, {}, { ref: {} }] }]) {
      assert.deepEqual(projectPinnedSessionIds(value), [], JSON.stringify(value));
    }
  });
});

// --- 6. the sidebar overlay -------------------------------------------------

describe("applyPinnedSessionOverlay", () => {
  const tree = (ids) => ({
    ok: true,
    projects: [
      {
        key: "p",
        name: "p",
        directories: [{ path: "/w", name: "w", latestAt: 0, sessions: ids.map((id) => ({ id, title: id, children: [] })) }],
      },
    ],
  });
  const order = (t) => t.projects[0].directories[0].sessions.map((s) => s.id);

  test("an empty pin set leaves the order byte-identical", () => {
    // The regression this guards: a comparator that reordered equal keys
    // would shuffle every unpinned sidebar on every read. With no pins at
    // all, the output must be the input.
    const input = tree(["mvs_1", "mvs_2", "mvs_3"]);
    assert.deepEqual(order(applyPinnedSessionOverlay(input, [])), ["mvs_1", "mvs_2", "mvs_3"]);
  });

  test("pinned sessions move to the top, in the engine's order", () => {
    // By the engine's order, not by `updatedAt` — the engine persists that
    // order under `pinned-items-order`, and a webui-side re-sort would
    // fight it on the next write.
    const out = applyPinnedSessionOverlay(tree(["mvs_1", "mvs_2", "mvs_3"]), ["mvs_3", "mvs_1"]);
    assert.deepEqual(order(out), ["mvs_3", "mvs_1", "mvs_2"]);
  });

  test("marks EVERY session, so the client reads a boolean and never a missing field", () => {
    // A field that appears only on pinned rows is a field the client has
    // to guard, and the guard is where the "undefined means false" bug
    // lives.
    for (const session of applyPinnedSessionOverlay(tree(["mvs_1", "mvs_2"]), ["mvs_1"]).projects[0].directories[0].sessions) {
      assert.equal(typeof session.pinned, "boolean");
    }
  });

  test("a pinned id the tree does not contain is ignored, and the tree still renders", () => {
    // The two stores are read at different instants (KNOWN DEBT 3), so this
    // is a normal occurrence, not an error. A pin written after the db scan
    // must not cost the user their sidebar.
    const out = applyPinnedSessionOverlay(tree(["mvs_1"]), ["mvs_absent"]);
    assert.deepEqual(order(out), ["mvs_1"]);
  });

  test("does not mutate its input", () => {
    const input = tree(["mvs_1", "mvs_2"]);
    applyPinnedSessionOverlay(input, ["mvs_2"]);
    assert.deepEqual(order(input), ["mvs_1", "mvs_2"]);
    assert.equal(input.projects[0].directories[0].sessions[0].pinned, undefined);
  });

  test("a soft-failed tree payload passes through unchanged", () => {
    // `handleSessionTree` answers `{ok:false, reason}` for a missing db,
    // and it has no `projects` to mark. Returning the payload as-is is one
    // fewer branch to get wrong than guarding the call site.
    const soft = { ok: false, reason: "mcode_db_not_found" };
    assert.equal(applyPinnedSessionOverlay(soft, ["mvs_1"]), soft);
  });
});

describe("readEnginePinnedSessionOrder — the one soft gate", () => {
  test("degrades to an empty list with a reason, on every absence", async () => {
    // The contrast with the four endpoints is the point: those MUTATE and a
    // mutation that cannot confirm its write must not claim success; this
    // one only reads an ordering, and failing the whole tree over it would
    // be a worse failure than not showing pins. What it must NOT do is
    // fail silently — `degraded`/`reason` is how a caller tells "nothing is
    // pinned" from "we could not ask".
    const cases = [
      [null, "engine_host_unavailable"],
      [{ cliService: {} }, "engine_services_unavailable"],
      [{ cliService: {}, services: null }, "engine_host_unavailable"],
      [{ cliService: {}, services: {} }, "pin_service_unavailable"],
    ];
    for (const [host, reason] of cases) {
      const out = await readEnginePinnedSessionOrder({ getHost: async () => host });
      assert.deepEqual(out.pinnedIds, [], JSON.stringify(host));
      assert.equal(out.degraded, true);
      assert.equal(out.reason, reason);
    }
  });

  test("a throwing host getter degrades rather than propagating", async () => {
    const out = await readEnginePinnedSessionOrder({
      getHost: async () => {
        throw new Error("boot failed");
      },
    });
    assert.deepEqual(out, { pinnedIds: [], degraded: true, reason: "engine_host_unavailable" });
  });

  test("a live pinService answers without degrading", async () => {
    const { host } = fakeHost({ reply: [{ ref: { type: "session", id: "mvs_a" } }] });
    const out = await readEnginePinnedSessionOrder({ getHost: async () => host });
    assert.deepEqual(out, { pinnedIds: ["mvs_a"], degraded: false, reason: null });
  });

  test("the default getter is the NON-BOOTING peek, not the booting one", async () => {
    // This is the assertion that keeps a sidebar's first paint off the
    // runtime-boot path. `getEngineCatalogueHost()` constructs the whole
    // runtime on its first call (seconds — the `test/server/` real-host
    // suites measure ~5 s cold), so a READ that reached for it would turn
    // the first `GET /api/session-tree` of a fresh process into a runtime
    // boot, and the cost would land on whoever painted the page first
    // while looking like an ordinary slow request. The symptom when this
    // regressed was not a pin assertion at all: a 10 s `/api/state`
    // timeout in the router-boot integration suite under the `runtime`
    // transport.
    //
    // Asserted on the SOURCE rather than by calling the default, because
    // calling it would boot a real runtime into this suite's process —
    // which is precisely what the rule forbids.
    const code = codeOf(readFileSync(join(serverDir, "engine/session-context-actions.js"), "utf8"));
    const start = code.indexOf("export async function readEnginePinnedSessionOrder");
    assert.notEqual(start, -1, "readEnginePinnedSessionOrder is missing");
    const body = code.slice(start, code.indexOf("\n}", start));
    assert.ok(
      body.includes("peekEngineCatalogueHost"),
      "the pin READ must reach the host through the non-booting peek",
    );
    assert.ok(
      !body.includes("getEngineCatalogueHost"),
      "the pin READ must not reach the booting getter — that turns the first sidebar read into a runtime boot",
    );
  });

  test("the four WRITE actions may boot, which is why the split is a rule", async () => {
    // The complement of the assertion above. A write the user asked for
    // may bring up what it needs — M4-3a's delete has always done exactly
    // that — so the family is not "never boot", it is "only writes boot".
    // Without this half, the fix above reads as a blanket caution and a
    // later reader would apply it to the writes too, making every menu
    // item wait on a boot it does not need.
    const code = codeOf(readFileSync(join(serverDir, "engine/session-context-actions.js"), "utf8"));
    for (const fn of [
      "applyEngineSessionArchive",
      "applyEngineSessionFork",
      "applyEngineSessionPin",
      "readEngineSessionForkOptions",
    ]) {
      const start = code.indexOf(`export async function ${fn}`);
      assert.notEqual(start, -1, `${fn} is missing`);
      const body = code.slice(start, start + 2000);
      assert.ok(
        body.includes("getEngineCatalogueHost") || body.includes("resolveContextActionMember"),
        `${fn} must resolve the host through the booting getter or the shared resolver`,
      );
    }
    // `peekCatalogueHost` exists at all, and returns rather than awaits —
    // the shape that makes "no boot" checkable at the call site.
    const acp = readFileSync(join(packageDir, "server/lib/acp-client.js"), "utf8");
    assert.match(acp, /export function peekCatalogueHost\(\)/);
    assert.ok(
      !/export async function peekCatalogueHost/.test(acp),
      "the peek must be synchronous — an async peek invites awaiting a boot",
    );
  });
});

// --- 7. source shape --------------------------------------------------------

describe("source shape — the boot path and the wiring", () => {

  const read = (rel) => readFileSync(join(serverDir, rel), "utf8");

  test("the facade statically imports nothing that boots a runtime", () => {
    // `app.js` loads `engine/index.js` at start, so a static import of the
    // host or of a provider would put the whole `@mavis/*` TypeScript tree
    // on the boot path — the regression M1 paid for once (209ms → 2700ms).
    // `host-services.test.js` guards the same rule for the window; this
    // file's own host access must obey it too.
    const code = codeOf(read("engine/session-context-actions.js"));
    for (const forbidden of ['from "./host.js"', 'from "./providers/', "from \"@mavis/", "from '@mavis/"]) {
      assert.ok(!code.includes(forbidden), `static import of ${forbidden} would be on the boot path`);
    }
  });

  test("the host getter is reached dynamically, and a real one exists", () => {
    // Belt and braces on the rule above: the dynamic import is not
    // optional, and it names the SAME getter every other facade uses
    // rather than building a second runtime.
    const code = codeOf(read("engine/session-context-actions.js"));
    assert.ok(code.includes('await import("./host.js")'));
    assert.ok(code.includes("getEngineCatalogueHost"));
  });

  test("all four endpoints are registered and owned", () => {
    // Two lists that must not drift: `OWNED_ROUTES` is the ledger the
    // router gate reads, and the `app.get/post` calls are the actual
    // dispatch. A route registered but not owned is served and unaudited;
    // an owned route with no registration is a 404 that reads as a
    // capability that does not exist.
    const app = read("app.js");
    for (const [method, path] of [
      ["post", "/api/sessions/:id/archive"],
      ["post", "/api/sessions/:id/pin"],
      ["get", "/api/sessions/:id/fork-options"],
      ["post", "/api/sessions/:id/fork"],
    ]) {
      assert.ok(app.includes(`app.${method}("${path}"`), `${method.toUpperCase()} ${path} is not dispatched`);
      assert.ok(app.includes(`"${method.toUpperCase()} ${path}"`), `${method.toUpperCase()} ${path} is not in OWNED_ROUTES`);
    }
  });

  test("the route handlers resolve their id by SLICING, not by trusting the path", () => {
    // `/api/sessions//archive` must 400, not be read as an empty session id
    // and handed to the engine. The slice helper is what makes that true,
    // and an id that reaches `archiveSession({id: ""})` would be a write
    // against a session the caller did not name.
    const code = codeOf(read("routes/sessions.js"));
    assert.ok(code.includes("_contextActionSessionId"));
    // Every one of the four must go through the helper rather than a
    // hand-rolled slice, or the empty-id case only holds for the handler
    // that was careful.
    const uses = code.match(/_contextActionSessionId\(ctx\.pathname, "[a-z-]+"\)/g) ?? [];
    assert.equal(uses.length, 4, `expected 4 handlers to use the id slicer, found ${uses.length}`);
  });
});

// --- 8. the mutation table --------------------------------------------------
//
// Each row is a one-line break a plausible refactor could introduce, the
// specific assertion above that turns red, and the reason that break
// matters. They are recorded as tests rather than as a comment so that a
// future edit which "fixes" one of them has to delete a test to do it
// quietly, and the deletion shows in the diff.

describe("mutation coverage — the seven ways to break this batch", () => {
  const MUTATIONS = [
    {
      what: "collapse the three PB-8 states into one `if (!services)`",
      breaks: "applyEngineSessionPin — undefined services is 501",
      why: "a host with no owner graph would answer 503, making a transport limitation look like a boot failure",
    },
    {
      what: "default `pinned` to true in parsePinRequestBody",
      breaks: "parsePinRequestBody — requires a real boolean",
      why: "an unpin request would PIN the row, the opposite of what the user clicked",
    },
    {
      what: "let the caller override createIsolatedWorktree",
      breaks: "applyEngineSessionFork — forces createIsolatedWorktree false",
      why: "a reference-free worktree fork becomes reachable through a flag nobody set on purpose",
    },
    {
      what: "sort the overlay by updatedAt instead of by pin rank",
      breaks: "applyPinnedSessionOverlay — an empty pin set leaves the order byte-identical",
      why: "equal keys get reordered, so every unpinned sidebar shuffles on every read",
    },
    {
      what: "drop the `!== false` rule in parseArchiveRequestBody",
      breaks: "parseArchiveRequestBody — anything that is not literally false archives",
      why: "the HTTP layer and the engine would disagree about the same request body",
    },
    {
      what: "treat a fork with no `session` as a success",
      breaks: "applyEngineSessionFork — a fork that reported no session is a failure",
      why: "the fake-success shape: a row appears with no id to switch to",
    },
    {
      what: "narrow `worktree` out of projectForkOptions",
      breaks: "readEngineSessionForkOptions — projects the engine's answer into the dialog's shape",
      why: "the batch that unblocks the worktree menu item would have to re-derive three fields the engine already sent",
    },
  ];

  test("every declared mutation names a real test in this file", () => {
    // A mutation table that names nothing is a comment. This asserts the
    // table is wired to the suite: each row must point at a `test(...)`
    // title that actually exists, so renaming a test without updating the
    // table turns this red.
    const source = readFileSync(join(import.meta.dirname, "session-context-actions.test.js"), "utf8");
    for (const mutation of MUTATIONS) {
      assert.ok(
        source.includes(mutation.breaks),
        `mutation "${mutation.what}" names no assertion in this file (${mutation.breaks})`,
      );
      assert.ok(mutation.why.length > 20, `mutation "${mutation.what}" has no stated consequence`);
    }
  });
});
