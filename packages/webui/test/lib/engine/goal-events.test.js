// webui/test/lib/engine/goal-events.test.js
// The engine → SSE goal bridge (PB-14, batch B).
//
// Hermetic by construction: every seam is injected — the bridge's `getHost`
// returns a fake host whose `cliService` is a plain object with a fake
// `watchEvents` generator — so no runtime boots and no network opens. The
// shared `_setup.js` harness registers the acp / sessions mocks that
// `pushStateFor` reaches, so the per-tab write never triggers a real
// session-list fetch.
//
// The invariants, in the order they matter:
//
//   1. THE FRAME IS THE ENGINE'S SNAPSHOT. A `thread_goal.updated`
//      snapshot reaches the frame field-for-field; a narrowing projection
//      would be a second copy of `GlobalThreadGoal` that goes stale.
//   2. A WRITE LANDS ONLY ON TABS LOOKING AT THAT CONVERSATION. The match
//      is `cs.mcodeSessionId`; a foreign conversation's goal must never
//      be painted into another tab's view.
//   3. AN EVENT THAT CANNOT BE ATTRIBUTED IS DROPPED, NEVER GUESSED.
//      Unknown type, wrong payload shape, snapshot without an identity,
//      a steering re-read that finds nothing — several ways for a frame to
//      be wrong, all of which must produce no write at all.
//   4. NO HOST IS NO-OP, NOT AN ERROR. Under the `acp` transport the turn
//      and its goal live in another process; the bridge must neither boot
//      a runtime (PB-1's 10 s `/api/state` timeout) nor raise.

import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupMocks,
  absPath,
  registerAcpMock,
  registerSessionsStore,
} from "../../helpers/_setup.js";

let goalEventToWrite;
let isGoalSnapshot;
let pumpGoalEvents;
let ensureGoalEventBridge;
let stopGoalEventBridge;
let isGoalEventBridgeRunning;
let applyThreadGoalToClients;
let clients;
let getClient;
let resetCoalesceState;

before(async (t) => {
  await setupMocks(t);
  const bridge = await import(absPath("engine/goal-events.js"));
  goalEventToWrite = bridge.goalEventToWrite;
  isGoalSnapshot = bridge.isGoalSnapshot;
  pumpGoalEvents = bridge.pumpGoalEvents;
  ensureGoalEventBridge = bridge.ensureGoalEventBridge;
  stopGoalEventBridge = bridge.stopGoalEventBridge;
  isGoalEventBridgeRunning = bridge.isGoalEventBridgeRunning;
  const bus = await import(absPath("lib/state-bus.js"));
  applyThreadGoalToClients = bus.applyThreadGoalToClients;
  clients = bus.clients;
  getClient = bus.getClient;
  resetCoalesceState = bus.resetCoalesceState;
});

/** A snapshot shaped exactly like the engine's `GlobalThreadGoal`. */
function goal(over = {}) {
  return {
    goalId: "g_1",
    sessionId: "mvs_a",
    objective: "ship the goal banner",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    tokensUsed: 120,
    turnsUsed: 3,
    timeUsedSeconds: 9,
    tokenBudget: 50000,
    statusReason: "turn_completed",
    executionWait: null,
    ...over,
  };
}

/** Every cid this suite registered, removed again in teardown. */
const touchedCids = [];

function makeCid(name, mcodeSessionId) {
  touchedCids.push(name);
  const cs = getClient(name);
  cs.mcodeSessionId = mcodeSessionId;
  cs.threadGoal = null;
  return cs;
}

beforeEach(() => {
  stopGoalEventBridge();
  for (const cid of touchedCids.splice(0)) clients.delete(cid);
  resetCoalesceState();
  // pushStateFor asks the acp-client for the cached session list; with an
  // empty cache it would fire a real fetch. Serve a cache so the write path
  // stays entirely in-process.
  registerAcpMock({ getMcodeSessionsCacheSync: () => [] });
  registerSessionsStore({ initial: [] });
});

// ---------------------------------------------------------------------------
// 1. The parse layer — pure, no state.
// ---------------------------------------------------------------------------

test("all three engine events translate into the write they imply", () => {
  // updated: the snapshot rides along, field for field.
  const updated = goalEventToWrite({ type: "thread_goal.updated", payload: { goal: goal() } });
  assert.equal(updated.sessionId, "mvs_a");
  assert.deepEqual(updated.goal, goal(), "the frame is the engine's snapshot, unprojected");

  // cleared: identifiers only on the wire, null goal on the frame.
  assert.deepEqual(
    goalEventToWrite({ type: "thread_goal.cleared", payload: { sessionId: "mvs_a", goalId: "g_1" } }),
    { sessionId: "mvs_a", goal: null },
  );

  // steering: identifiers only from the engine, so the snapshot is read back.
  const steering = goalEventToWrite(
    { type: "thread_goal.objective_updated_steering", payload: { sessionId: "mvs_a", goalId: "g_1" } },
    () => goal({ objective: "steered", updatedAt: 7 }),
  );
  assert.equal(steering.sessionId, "mvs_a");
  assert.equal(steering.goal.objective, "steered");
  assert.equal(steering.goal.updatedAt, 7);
});

test("MUTATION — an unattributable event is dropped, not guessed", () => {
  const cases = [
    ["unknown event name", { type: "thread_goal.objective_updated", payload: { goal: goal() } }, undefined],
    ["no type at all", { payload: { goal: goal() } }, undefined],
    ["payload not an object", { type: "thread_goal.updated", payload: "g_1" }, undefined],
    ["updated without a goal", { type: "thread_goal.updated", payload: {} }, undefined],
    // Field-misalignment mutations: a snapshot whose identity is missing
    // must not be routed, however plausible the rest of it looks.
    ["goal without a session id", { type: "thread_goal.updated", payload: { goal: goal({ sessionId: "" }) } }, undefined],
    ["goal without a goal id", { type: "thread_goal.updated", payload: { goal: goal({ goalId: 7 }) } }, undefined],
    ["goal without a status", { type: "thread_goal.updated", payload: { goal: goal({ status: null }) } }, undefined],
    ["goal as an array", { type: "thread_goal.updated", payload: { goal: [goal()] } }, undefined],
    ["cleared without a session", { type: "thread_goal.cleared", payload: { goalId: "g_1" } }, undefined],
    ["steering without a session", { type: "thread_goal.objective_updated_steering", payload: { goalId: "g_1" } }, () => goal()],
  ];
  for (const [label, event, readGoal] of cases) {
    assert.equal(goalEventToWrite(event, readGoal), null, `${label} must be dropped`);
  }
  assert.equal(goalEventToWrite(null), null);
  assert.equal(goalEventToWrite("thread_goal.updated"), null);
});

test("MUTATION — an envelope that disagrees with the snapshot routes on the snapshot", () => {
  // A bridge that trusted `payload.sessionId` here would write mvs_b's goal
  // into every tab showing mvs_a. The envelope carries no session field on
  // this event today, so a future emitter that adds one must not change
  // which conversation the frame is written to.
  const write = goalEventToWrite({
    type: "thread_goal.updated",
    payload: { sessionId: "mvs_b", goal: goal({ sessionId: "mvs_a" }) },
  });
  assert.equal(write.sessionId, "mvs_a");
});

test("a steering event whose re-read finds nothing writes nothing", () => {
  assert.equal(
    goalEventToWrite(
      { type: "thread_goal.objective_updated_steering", payload: { sessionId: "mvs_a", goalId: "g_1" } },
      () => undefined,
    ),
    null,
  );
  assert.equal(
    goalEventToWrite(
      { type: "thread_goal.objective_updated_steering", payload: { sessionId: "mvs_a", goalId: "g_1" } },
      () => goal({ sessionId: "" }),
    ),
    null,
  );
});

test("isGoalSnapshot accepts the engine's shape and nothing looser", () => {
  assert.equal(isGoalSnapshot(goal()), true);
  assert.equal(isGoalSnapshot({ ...goal(), hasKickoffAttachments: false }), true);
  assert.equal(isGoalSnapshot({ ...goal(), lastVerification: undefined }), true);
  assert.equal(isGoalSnapshot({}), false);
  assert.equal(isGoalSnapshot([]), false);
  assert.equal(isGoalSnapshot(null), false);
});

// ---------------------------------------------------------------------------
// 2. The pump — an injected event stream into an injected write.
// ---------------------------------------------------------------------------

/** An AsyncGenerator that yields `events` and then waits for the abort. */
async function* fakeStream(events, signal) {
  for (const event of events) {
    if (signal && signal.aborted) return;
    yield event;
  }
  // Park the way the real subscription does, so the pump is still awaiting
  // when the test finishes and stopping the bridge is what ends it.
  if (!signal) return;
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

test("the pump forwards the three events in order and drops the rest", async () => {
  const writes = [];
  const controller = new AbortController();
  const { signal } = controller;
  const events = [
    { type: "thread_goal.updated", payload: { goal: goal() } },
    { type: "session.updated", payload: { goal: goal() } }, // unrelated
    { type: "thread_goal.updated", payload: {} }, // malformed
    { type: "thread_goal.objective_updated_steering", payload: { sessionId: "mvs_a", goalId: "g_1" } },
    { type: "thread_goal.cleared", payload: { sessionId: "mvs_a", goalId: "g_1" } },
  ];
  const pump = pumpGoalEvents({
    watchEvents: () => fakeStream(events, signal),
    readGoal: () => goal({ objective: "steered" }),
    write: (sessionId, g) => writes.push([sessionId, g && g.objective]),
  });
  // Let the generator drain, then abort so the pump resolves.
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await pump;
  assert.deepEqual(writes, [
    ["mvs_a", "ship the goal banner"],
    ["mvs_a", "steered"],
    ["mvs_a", null],
  ]);
});

test("a stream that throws ends the pump without an unhandled rejection", async () => {
  const writes = [];
  async function* exploding() {
    yield { type: "thread_goal.updated", payload: { goal: goal() } };
    throw new Error("bus closed");
  }
  await pumpGoalEvents({
    watchEvents: () => exploding(),
    readGoal: () => null,
    write: (sessionId, g) => writes.push([sessionId, g && g.objective]),
  });
  assert.equal(writes.length, 1, "the event before the failure still landed");
});

// ---------------------------------------------------------------------------
// 3. Production wiring — the singleton, without a runtime.
// ---------------------------------------------------------------------------

test("with no host up the bridge is a no-op that reports it", async () => {
  const started = await ensureGoalEventBridge({ getHost: async () => null });
  assert.equal(started, false);
  assert.equal(isGoalEventBridgeRunning(), false);
});

test("a host without watchEvents does not become a subscription", async () => {
  const started = await ensureGoalEventBridge({ getHost: async () => ({ cliService: {} }) });
  assert.equal(started, false);
  assert.equal(isGoalEventBridgeRunning(), false);
});

test("the bridge subscribes once and is idempotent across reconnects", async () => {
  let watchCalls = 0;
  const cliService = {
    watchEvents(signal) {
      watchCalls += 1;
      return fakeStream([], signal);
    },
    getGoal: () => goal(),
  };
  const getHost = async () => ({ cliService });

  assert.equal(await ensureGoalEventBridge({ getHost }), true);
  assert.equal(isGoalEventBridgeRunning(), true);
  assert.equal(await ensureGoalEventBridge({ getHost }), true, "second connect is a no-op");
  assert.equal(await ensureGoalEventBridge({ getHost }), true);
  assert.equal(watchCalls, 1, "exactly one engine subscription per process");

  assert.equal(stopGoalEventBridge(), true);
  assert.equal(isGoalEventBridgeRunning(), false);
  assert.equal(stopGoalEventBridge(), false, "stopping an idle bridge is a no-op");
});

test("MUTATION — a host whose goal capability throws cannot take the pump down", async () => {
  // `getGoal` goes through the engine's `requireCapability("goals")` gate,
  // which throws on a host without the peripheral. A steering event must not
  // turn that into an unhandled rejection, and must write nothing.
  assert.equal(
    await ensureGoalEventBridge({
      getHost: async () => ({
        cliService: {
          watchEvents() {
            return (async function* () {
              yield {
                type: "thread_goal.objective_updated_steering",
                payload: { sessionId: "mvs_a", goalId: "g_1" },
              };
            })();
          },
          getGoal() {
            throw new Error("capability goals is not available");
          },
        },
      }),
    }),
    true,
  );
  stopGoalEventBridge();
  assert.equal(isGoalEventBridgeRunning(), false, "the pump ended instead of throwing");
});

// ---------------------------------------------------------------------------
// 4. The per-tab write — routing, and the SSE push it triggers.
// ---------------------------------------------------------------------------

test("MUTATION — a goal lands only on tabs showing that conversation", () => {
  const a1 = makeCid("tab-a1", "mvs_a");
  const a2 = makeCid("tab-a2", "mvs_a");
  // `mvs_abc` is a DIFFERENT conversation that happens to start with the
  // same characters — the case a prefix / fuzzy match would get wrong.
  const b1 = makeCid("tab-b1", "mvs_abc");
  const draft = makeCid("tab-draft", null);

  const written = applyThreadGoalToClients("mvs_a", goal());
  assert.deepEqual(written.sort(), ["tab-a1", "tab-a2"]);
  assert.equal(a1.threadGoal.objective, "ship the goal banner");
  assert.equal(a2.threadGoal.objective, "ship the goal banner");
  assert.equal(b1.threadGoal, null, "another conversation's view is untouched");
  assert.equal(draft.threadGoal, null, "a tab with no engine session has no goal");

  // Clearing is routed the same way, and `null` is the "no goal" answer.
  assert.deepEqual(applyThreadGoalToClients("mvs_a", null).sort(), ["tab-a1", "tab-a2"]);
  assert.equal(a1.threadGoal, null);
  assert.equal(b1.threadGoal, null);

  // A non-id is never routed anywhere.
  assert.deepEqual(applyThreadGoalToClients("", goal()), []);
  assert.deepEqual(applyThreadGoalToClients(null, goal()), []);
  assert.deepEqual(applyThreadGoalToClients(42, goal()), []);

  // Re-delivering the SAME snapshot object is not a write: the state-bus
  // guard is reference identity, so a re-published identical reference
  // cannot happen today (every event carries a fresh payload) and would
  // only mean the same bytes going on the wire, which the push diff gate
  // suppresses anyway.
  const same = goal();
  assert.deepEqual(applyThreadGoalToClients("mvs_a", same).sort(), ["tab-a1", "tab-a2"]);
  assert.deepEqual(applyThreadGoalToClients("mvs_a", same), []);
});