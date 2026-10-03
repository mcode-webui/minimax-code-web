// webui/server/engine/interrupt.js
//
// Migration step M3, batch B7 (part 1 of 2): the INTERRUPT family —
//
//   #13  POST /api/stop              — gentle cancel, then the kill cascade
//   #69  POST /api/protocol/cancel   — the gentle half, on its own
//
// What this file is for. Both endpoints end in a claim the user can act
// on — "your turn stopped", or "I could not stop it and here is the
// button that can" — and before M3 that claim was assembled in two
// routes, each of which reached into `lib/mcode-rpc.js#cancelSession`
// and `lib/state-bus.js#getActiveChild` directly. Three facts about
// that claim are load-bearing and none of them is visible from the
// route's edge any more:
//
//   1. `cancelled` DOES NOT MEAN "THE PROMPT STOPPED". `session/cancel`
//      is a NOTIFICATION (mcode-rpc.js: the engine registers it with
//      `app.onNotification`, which aborts the active prompt's
//      AbortController; a request would come back "Method not found").
//      A notification carries no reply, so a success here means "SENT",
//      and the word in the response is `cancelled` for historical
//      reasons. The two endpoints answer that differently on purpose and
//      both differences are pinned by the suite: #13 pairs `cancelled:true`
//      with `hardKilled:false` and never escalates, while #69 pairs it
//      with a pointer to the endpoint that CAN escalate.
//
//   2. `hardKilled` IS A REPORT ABOUT THE FIRST DECISION, NOT ABOUT THE
//      PROCESS. It is true exactly when a child was registered AND the
//      gentle path did not take (`child && !cancelled`) — i.e. webui
//      called `child.kill()` on its way out of the handler. It is written
//      into the response body BEFORE the bounded escalation timer can
//      possibly fire, so `hardKilled:true` never certifies that anything
//      is dead. The same asymmetry is why the `note` string says "hard
//      kill (session/cancel could not be delivered)" even when NO kill
//      ran at all (no child, no session id): the note names why the
//      gentle path did not happen, not what followed. Both are load-
//      bearing wording, and both are pinned.
//
//   3. THE ESCALATION IS BOUNDED, AND THE BOUND IS PART OF THE
//      CONTRACT. If the gentle cancel does not take, a `setTimeout` at
//      `STOP_FORCE_KILL_MS` re-checks the CACHED raw child handle and
//      kills it if it is still alive. Two properties are load-bearing
//      and both are pinned: the timer is `unref()`ed (an unexpired stop
//      timer must never hold the process open), and it reads the handle
//      captured BEFORE the timer was armed — `child.child` may be nulled
//      by the runner's own stop() in the meantime, and a nulled handle
//      read at fire time would silently skip the escalation the whole
//      cascade exists for.
//
// Why this family's gate is SOFT. The question B5 and B6 each answered
// for their own family was "if the provider declares this capability
// absent, can the endpoint still serve a truthful answer?" — and here
// the answer differs by endpoint, which is the honest answer:
//
//   - #13's escalation is webui's OWN child-process management. The
//     child was registered on webui's state bus by webui's own runner;
//     killing it does not consult a provider, and neither does the
//     zombie-claim reset (the 2026-09-20 audit escape hatch, which
//     exists precisely for the case where the runner died before its
//     own finalize ran). Hard-gating #13 would DELETE the user's only
//     way out of a stuck 思考中 panel, in order to express a doubt
//     about the GENTLE half of a two-mechanism endpoint. That is the
//     `session-export.js` argument again: a missing enrichment must not
//     be dressed up as a failure.
//   - #69 already HAS a truthful "I could not do it" answer, and it is
//     its documented contract: 200 `{ok:true, cancelled:false, warning,
//     code, killEndpoint}`. A provider with no interrupt surface produces
//     exactly that shape (the notification is inapplicable, which is
//     what "no client" already means), so a hard gate would replace an
//     accurate 200 with a 501 and teach the frontend a shape it does not
//     have today.
//
// So `checkInterruptCapability` REPORTS and never throws, and the 501
// machinery in `errors.js` stays unused by this family — a policy
// statement, and the suite pins that it stays unused.
//
// What this file deliberately does NOT do:
//
//   - It does not own the client-state reset. `resetThinkingClaim` is
//     shared with `routes/chat.js#handleSend` (the start-phase failure
//     path), so it stays in the route; the DECISION to run it
//     (`claimStale`) is computed here and the mutation stays put.
//   - It does not own the process-kill policy beyond the bounded timer
//     and its two guards. Whether a running session may be killed at all
//     is a product question this batch does not reopen (KNOWN DEBT).
//   - It does not own the session store, the state bus, the RPC wrapper
//     or the config. All four are reached through `await import()`.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It statically imports nothing
// heavier than `engine/capabilities.js` and `engine/index.js` (both pure
// declaration modules) and nothing else; `lib/state-bus.js`,
// `lib/mcode-rpc.js` and `lib/config.js` are reached through
// `await import()` inside the data-plane functions. That split is the M1
// lesson, and it is what lets this module be re-exported from
// `engine/index.js` at all.
//
// Provider selection is M4's job, same as B1 through B6:
// `providerByTransport()` maps a transport to a REGISTERED provider id;
// today only `runtime` has one, so under the default `acp` transport the
// gate reports `gate: "unregistered-transport"` and the interrupt
// proceeds — which is correct, because the pre-M4 behaviour under `acp`
// is the only behaviour this endpoint has ever had.

import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport`, `session-tree-reads.js`,
 * `usage-reads.js`, `account-reads.js`, `session-writes.js` and
 * `session-switch.js`, which this mirrors rather than merges: six
 * families with separate contracts, and a shared table would force this
 * one to inherit another's policy.
 *
 * Built per call rather than frozen at module scope: `engine/index.js`
 * re-exports this module, so a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
 * temporal dead zone on a cold `import("./engine/index.js")`. Every
 * consumer of the table is a function anyway.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

// ---------------------------------------------------------------------------
// The bound the whole cascade hangs off
// ---------------------------------------------------------------------------

/**
 * How long the gentle cancel has before webui force-kills the child.
 *
 * Exported because it is part of #13's contract, not an implementation
 * detail: the window is what makes "已停止" mean "已停止" — without a
 * bound, a turn that ignores the notification would keep running while
 * the UI already reported success, which is the defect the third branch
 * of the cascade was written for.
 *
 * The value is 5000 ms. The file this batch migrated ran 2000 ms; the
 * batch plan transcribed the bound as "abort 5s" and the product call
 * (2026-10-03) is to take the plan's value — the longer grace gives
 * stubborn children more time to finalize, at the cost of "already
 * stopped" staying a lie for three extra seconds. See KNOWN DEBT 1 —
 * the number is pinned by a named test either way, so a future change
 * to it is a deliberate one.
 *
 * @type {number}
 */
export const STOP_FORCE_KILL_MS = 5000;

// ---------------------------------------------------------------------------
// The declaration, and the gate policy that goes with it
// ---------------------------------------------------------------------------

/**
 * The declaration this family's engine-facing half needs.
 *
 * `interrupt` is the honest mapping and it is the same key the
 * capability matrix row "中断" names: aborting an in-flight turn. The
 * ACP surface behind it is `session/cancel` (a notification) plus
 * `abortSession` on the runtime surfaces, and the two providers both
 * declare it `full` (see `providers/local-runtime-v2.capabilities.js`).
 *
 * One declaration covers both endpoints on purpose. #13 is not a
 * different capability with a kill in it — the kill is webui's own
 * process management, which is exactly why neither endpoint gates hard
 * (see the module header). Declaring them separately would invite a
 * future edit to make #13 "partial" on the strength of the kill branch
 * and quietly produce two policies for one capability.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "soft"}>>}
 */
export const INTERRUPT_ENDPOINTS = Object.freeze({
  "POST /api/stop": Object.freeze({
    capability: "interrupt",
    subItem: "abortSession",
    enforcement: "soft",
  }),
  "POST /api/protocol/cancel": Object.freeze({
    capability: "interrupt",
    subItem: "abortSession",
    enforcement: "soft",
  }),
});

/**
 * Resolve the provider that answers the interrupt family on `transport`,
 * or `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveInterruptProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Read the declaration for this endpoint WITHOUT enforcing it.
 *
 * Returns a descriptor whose `gate` field says what happened:
 *
 *   - `"checked"`               — provider resolved, capability is `full`.
 *   - `"unregistered-transport"` — no provider claims this transport yet.
 *     This is the DEFAULT `acp` transport, and the interrupt proceeding
 *     here is the pre-M3 behaviour, not a hole in the gate.
 *   - `"capability-absent"`     — the provider WAS found and DOES declare
 *     the capability as `none`. The caller's next move is to fall back
 *     to the endpoint's own truthful "I could not deliver it" answer,
 *     never to fail the request.
 *   - `"partial"`               — provider is `partial` and this sub-item
 *     is absent; same fallback, said precisely.
 *
 * Deliberately never throws `EngineCapabilityNotSupportedError`. A
 * genuinely unknown endpoint key is still a plain Error — caller
 * confusion is not a capability question, and the HTTP layer must never
 * answer 501 for a typo in webui's own code.
 *
 * @param {string} endpoint  A key of INTERRUPT_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null, enforcement: "soft"}}
 */
export function checkInterruptCapability(endpoint, transport) {
  const need = INTERRUPT_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkInterruptCapability: "${endpoint}" is not part of the interrupt family ` +
        `(known: ${Object.keys(INTERRUPT_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_interrupt_endpoint";
    throw err;
  }
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveInterruptProvider(transport);
  if (!provider) return { ...base, gate: "unregistered-transport" };
  const entry = provider.capabilities ? provider.capabilities[need.capability] : undefined;
  const descriptor = { ...base, provider: provider.id };
  if (entry && entry.level === "full") {
    return { ...descriptor, gate: "checked" };
  }
  if (entry && entry.level === "partial") {
    const absent = Array.isArray(entry.missing) && entry.missing.includes(need.subItem);
    return { ...descriptor, gate: absent ? "partial" : "checked" };
  }
  // `none`, or no entry at all — the provider was found and does not
  // offer this. Report it; the caller degrades to the kill cascade.
  return { ...descriptor, gate: "capability-absent" };
}

// ---------------------------------------------------------------------------
// Pure derivations. Exported and tested on their INPUTS.
// ---------------------------------------------------------------------------

/**
 * Whether a stop left a client state that nothing will ever put back to
 * rest on its own.
 *
 * True exactly when no active child backs the conversation AND the
 * client state still claims a live run. That combination is the
 * 2026-09-20 audit's zombie run: the runner died before its finalize
 * ran (an acp start-phase failure, a mid-run crash that lost the child
 * registration), so every later `pushStateFor` re-asserts
 * `running.active=true` and the panel shows 思考中 forever. `/api/stop`
 * is the user's escape hatch for exactly that moment.
 *
 * The negative half is the other half of the rule and is why this is a
 * derivation rather than an unconditional reset: when a child IS
 * present, the kill cascade rejects the in-flight prompt and the
 * runner's OWN finalize owns the terminal state, including its chat
 * cursor cleanup. Resetting early would race it and could strip a
 * `▍` cursor the stream is still about to rewrite.
 *
 * @param {boolean} wasRunning  Whether an active child backs this cid.
 * @param {object|null|undefined} cs  The requesting client's state.
 * @returns {boolean}
 */
export function stopLeftStaleClaim(wasRunning, cs) {
  if (wasRunning) return false;
  return !!(cs && cs.running && cs.running.active);
}

// ---------------------------------------------------------------------------
// Data plane
// ---------------------------------------------------------------------------

/**
 * #13 — the gentle cancel, the kill cascade, and the bounded
 * escalation.
 *
 * The order below IS the endpoint's contract:
 *
 *   1. LOOK UP THE VIEWED SESSION'S CHILD, not "any child of this tab".
 *      A tab may run two conversations at once, and stopping must not
 *      signal the other turn's subprocess — so the lookup is narrowed
 *      by `(cid, cs.mcodeSessionId)`.
 *   2. GENTLE PATH. `session/cancel`, pinned on the same subprocess via
 *      `cid`. A refusal or a throw is logged and falls through; it is
 *      never fatal, because the cascade below is the actual promise.
 *   3. HARD PATH. `child.kill()` iff a child was registered AND the
 *      gentle path did not take. This is the only thing `hardKilled`
 *      reports.
 *   4. BOUNDED ESCALATION, armed whenever a child was registered — not
 *      only when it was killed. A cancel that was "sent" but ignored
 *      is exactly the case the bound exists for.
 *
 * The response body is built HERE and never re-assembled in the route,
 * so the `hardKilled` / `note` wording has one home. The route keeps the
 * client-state reset (`resetThinkingClaim`, shared with `handleSend`)
 * and the state push, and both are driven by `claimStale`.
 *
 * @param {object} options
 * @param {object} options.cs    The requesting client's state. READ ONLY
 *        here — the claim reset is the route's, because its helper is
 *        shared with the send path.
 * @param {string} [options.cid] Requesting client id.
 * @param {string} [options.transport] Transport override.
 * @param {typeof setTimeout} [options.setTimeoutImpl] Injection seam for
 *        the escalation timer. Defaults to the global; the suite
 *        injects node:test's mock timers through it so the bound can be
 *        tested without waiting two real seconds.
 * @returns {Promise<{payload: object, claimStale: boolean, gate: object, transport: string}>}
 */
export async function applyEngineStop(options = {}) {
  const endpoint = options.endpoint || "POST /api/stop";
  const [bus, rpc, config] = await Promise.all([
    import("../lib/state-bus.js"),
    import("../lib/mcode-rpc.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = checkInterruptCapability(endpoint, transport);
  const cid = options.cid;
  const cs = options.cs;
  // The VIEWED session's child, not "any child of this tab": a tab may
  // run two conversations at once, and stopping must not signal the
  // other turn's subprocess.
  const child = bus.getActiveChild(cid, cs && cs.mcodeSessionId);
  const wasRunning = !!child;
  let cancelled = false;
  let hardKilled = false;
  // 1. Gentle path: send the `session/cancel` notification. The engine
  //    aborts the active prompt's AbortController; there is no reply, so
  //    `cancelled` means "sent".
  if (cs && cs.mcodeSessionId) {
    try {
      const r = await rpc.cancelSession(cs.mcodeSessionId, cid);
      if (r.ok) cancelled = true;
      else {
        // No client to notify — worth a line in the log before the SIGKILL.
        console.warn(`[stop] session/cancel failed cid=${cid}: ${r.error} (code=${r.code})`);
      }
    } catch (e) {
      console.warn(`[stop] session/cancel threw cid=${cid}: ${e.message}`);
    }
  }
  // 2. 兜底路径: hard kill child (RPC 不支持或失败)
  if (child && !cancelled) {
    try {
      child.kill();
    } catch {}
    hardKilled = true;
  }
  // 3. 兜底路径 2: bound the wait, and force-kill if the child survived
  //    the gentle path. The raw child_process handle is captured NOW:
  //    `child.child` may be nulled by the runner's own stop() long
  //    before the timer fires, and a nulled read at fire time would
  //    silently skip the escalation the cascade exists for.
  if (child) {
    const rawChild = child.child; // 缓存 node child_process 实例
    const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    const escalation = setTimeoutImpl(() => {
      try {
        if (rawChild && !rawChild.killed && rawChild.exitCode === null) {
          console.log(`[stop] cid=${cid} child still alive ${STOP_FORCE_KILL_MS}ms after stop, force-killing`);
          child.kill();
        }
      } catch {}
    }, STOP_FORCE_KILL_MS);
    // The real `setTimeout` returns a Timeout with `unref`, so an
    // unexpired escalation can never hold the process open. The
    // injection seam may return a bare id (node:test's mock timers
    // return a plain object), and calling `.unref()` unconditionally
    // would make the bound untestable — so the call is guarded rather
    // than assumed.
    if (escalation && typeof escalation.unref === "function") escalation.unref();
  }
  return {
    payload: {
      ok: true,
      wasRunning,
      cancelled,
      hardKilled,
      // Names why the gentle path did not happen — NOT what followed.
      // A stop with no child and no session id reports the hard-kill
      // note while reporting `hardKilled:false`, because that is the
      // pre-M3 wording this endpoint has always returned.
      note: cancelled
        ? "gentle cancel"
        : "hard kill (session/cancel could not be delivered)",
    },
    claimStale: stopLeftStaleClaim(wasRunning, cs),
    gate,
    transport,
  };
}

/**
 * #69 — the gentle half on its own.
 *
 * Deliberately does NOT escalate. The route's own comment records the
 * reason and the reason is the contract: `session/cancel` is a
 * notification, so the endpoint cannot say whether the prompt actually
 * stopped. A refusal therefore answers 200 with `cancelled:false` and
 * a pointer to `/api/stop`, which is where the cascade lives — claiming
 * a hard kill here would be claiming a kill this handler never performs
 * (#110 fake-success, and the existing suite already pins the absence
 * of a `fallback` key for exactly that reason).
 *
 * The body is built here so the two refusal shapes have one home.
 * `delivered` is returned separately because the state push is
 * conditional on it: the pre-M3 route pushes only when the notification
 * was accepted, and a push on a refusal would re-assert the very claim
 * the caller just failed to clear.
 *
 * @param {object} options
 * @param {string} options.sessionId  Already validated non-empty.
 * @param {string} [options.cid]
 * @param {string} [options.transport]
 * @returns {Promise<{payload: object, delivered: boolean, gate: object, transport: string}>}
 */
export async function sendEngineSessionCancel(options = {}) {
  const endpoint = options.endpoint || "POST /api/protocol/cancel";
  const [rpc, config] = await Promise.all([
    import("../lib/mcode-rpc.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = checkInterruptCapability(endpoint, transport);
  const r = await rpc.cancelSession(options.sessionId, options.cid);
  if (!r.ok) {
    return {
      payload: {
        ok: true,
        cancelled: false,
        warning: r.error,
        code: r.code,
        killEndpoint: "/api/stop",
      },
      delivered: false,
      gate,
      transport,
    };
  }
  return {
    payload: { ok: true, cancelled: true, data: r.data },
    delivered: true,
    gate,
    transport,
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// Recorded here rather than fixed, because each item is a decision that
// belongs to a human and not to a refactor:
//
//   1. THE PLAN SAID 5s AND THE CODE SAID 2s — RESOLVED 2026-10-03: the
//      product call took the plan's value, `STOP_FORCE_KILL_MS` is now
//      5000 (it was 2000 before this batch). The longer grace gives a
//      stubborn child more time to finalize but makes "已停止" lie for
//      three extra seconds; that trade was accepted explicitly. The
//      named test pins the new value, so a future change stays a
//      deliberate one.
//
//   2. #13 KILLS A RUNNING TURN WITHOUT ASKING WHETHER IT MAY. A stop
//      on an in-flight session SIGKILLs the engine subprocess, and the
//      kill cascade runs on the VIEWED session's child without checking
//      whether the child belongs to a turn the user still wants. That
//      is the pre-facade behaviour and it is arguably the correct one
//      (the user pressed stop), but "refuse to stop a turn that has not
//      yet produced output" and "escalate only after a second attempt"
//      are both defensible alternatives. The same shape is recorded in
//      B5's KNOWN DEBT 3 for the delete family, where the mirror-image
//      question is "refuse to delete a running session" — between them
//      they are the same policy question about running sessions, and it
//      deserves one decision rather than two.
//
//   3. `hardKilled` CANNOT MEAN "THE PROCESS IS DEAD", so it does not
//      try. The field is written before the escalation timer can fire,
//      and neither this endpoint nor `/api/protocol/cancel` observes the
//      child's exit. A frontend that wants "is it really gone" has no
//      answer on this endpoint today; the state frame after the runner's
//      finalize is the closest thing, and it is a different request. If
//      that distinction matters to a caller, the fix is a new field
//      carrying the escalation's outcome — which means waiting for the
//      bound before answering, i.e. giving up the fire-and-forget 200.
//      Both halves of that trade are the user's to weigh.
