// webui/server/engine/streaming-send.js
//
// Migration step M3, batch B8a: the STREAMING SEND family's PURE LAYER
// and its capability gate —
//
//   #12  POST /api/send  — the main chat entry
//
// MIDDLE STATE, stated plainly because a reader of this file will
// otherwise assume a working endpoint: NOTHING IS WIRED YET. The
// declaration, the gate and the derivations are here and are tested;
// no route calls them, no runner consumes them, and #12 behaves
// exactly as it did at 32277c3a on every transport. Batch B8b adds the
// runner (`lib/mcode-acp.js#runMcodeRuntime`) and the route branch
// (`routes/chat.js#handleSend`). This file is written to be consumed by
// both without either half having to be renamed.
//
// What this layer is for. #12 was the single endpoint whose whole
// behaviour lived in one route body: it claims the turn, answers, and
// then runs a turn whose OUTPUT never crosses the HTTP response — it
// crosses the `/api/events` SSE channel as webui chat lines (`▲`
// thinking, `●` answer, `→ tool`, `##tc:<id>` markers). Under the ACP
// transport that stream arrives as `mcode acp` session-update
// notifications. Under the `runtime` transport it arrives as something
// structurally different, and the difference is the whole risk of the
// B8 work:
//
//   - ACP gives an EVENT vocabulary (`thought` / `message` / `tool_call`
//     / `tool_update` / `plan_update` / …) that happens to be close to
//     webui's line syntax.
//   - The runtime gives a FRAME vocabulary (SSE `dataJson` envelopes)
//     that webui has never consumed. The per-turn wrapper
//     (`lib/runtime-host.js` → `TuiRuntimeAdapter.sendMessage`) already
//     projects those frames into structured `TuiStreamEvent`s
//     (`@minimax/code/runtime-adapter` → `projectTuiSessionStreamFrame`),
//     so the bridge this file owns starts one level above the wire.
//
// The bridge is TuiStreamEvent → webui line, and it is split into a
// PURE classification layer (this file) and an imperative runner (B8b),
// because the classification is where a regression is INVISIBLE: a
// dropped `●` line does not crash, it just makes the answer disappear.
// A pure function is the only shape in which "invisible" is testable,
// and that is why this layer exists before any runner does.
//
// THE RED LINES, and which half of each is here. The plan names
// `run-mirror`, the finalize drain and `promoteDraftToMcodeSid` as the
// red lines of #12. All three are STRUCTURAL — they are the route's
// post-run tail, the state bus's per-(cid, session) line buffer, and
// the single-identity record promotion — and none of them is
// transport-specific. What this file owns is the part that is: which
// line each event produces, which line family the accumulator is
// currently in, and the two predicates the drain and the run-mirror
// consult. Two of the three red lines have their judgement expressed
// here as pure functions (`sendStillViewing`, `rewriteDrainedAnswerLine`)
// precisely so that the runner cannot re-derive them differently. The
// third — the draft promotion — is deliberately NOT re-derived here;
// the module explains why at the point where it would have gone.
//
// The fourth red line, the 409 claim, is entirely the route's and is
// taken before any transport branch exists. What this file contributes
// to it is the gate, which a future batch will call at the same place.
//
// Why this family's gate is HARD, which is the opposite of B7's. B5
// and B7 gate soft because both endpoints have a truthful degradation:
// a stop whose escalation is webui's own child management can still
// stop the turn, and a cancel already HAS a documented "I could not
// do it" 200. #12 has no degradation at all. Its response is
// `{ok:true}` written BEFORE the engine is called — fire-and-forget by
// contract, because the output arrives on a different channel. A
// provider with no `streamingSend` surface cannot produce a truthful
// answer to any of: the turn never runs, the panel shows 思考中 with no
// stream behind it, and nothing resets the claim. That is #110's fake
// success exactly, so the gate throws and `app.js#invokeHandler` maps
// it to 501 with the shared payload. The gate is UNREACHABLE on both
// transports today — v2 declares `streamingSend: full`, and `acp` has
// no registered provider at all (M4's registry) — so no existing
// response changes, and B8a changes none either because nothing calls
// the gate yet. The suite pins both halves of that sentence, so making
// it reachable is a deliberate edit rather than a discovery.
//
// What this file deliberately does NOT do:
//
//   - It does not run a turn. There is no runner, no host access and no
//     IO here at all: every export below is a total function over its
//     arguments. The data plane is B8b's.
//   - It does not own the run claim, the run-mirror buffer, the drain
//     or the draft promotion. Those are the route's and the state
//     bus's, and moving them would be a second, unrelated change to
//     the most fragile tail in the server.
//   - It does not construct a host. `Never build a second host` is not
//     even at stake: there is no host reference in this file.
//   - It does not own the ACP path. `runMcodeAcp` and
//     `streamAcpPrompt` are not imported, referenced or reached from
//     here.
//
// Boot-path weight. B8b will make `routes/chat.js` import this file, so
// it will be on the boot path. It statically imports
// `engine/capabilities.js` and `engine/index.js` (both pure declaration
// modules) and nothing else; no `await import()`, no state bus, no
// config, no host. That is the M1 lesson, and it is what lets this
// module be re-exported from `engine/index.js` at all.
//
// Provider selection is M4's job, same as B1 through B7:
// `providerByTransport()` maps a transport to a REGISTERED provider id;
// only `runtime` has one, so under the default `acp` transport the gate
// reports `gate: "unregistered-transport"` — which is correct, because
// the pre-M4 behaviour under `acp` is the only behaviour this endpoint
// has ever had.

import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";
import { assertEngineCapability } from "./capabilities.js";

// ---------------------------------------------------------------------------
// Transport → provider
// ---------------------------------------------------------------------------

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, exactly as in
 * `session-reads.js#providerByTransport`, `session-tree-reads.js`,
 * `usage-reads.js`, `account-reads.js`, `session-writes.js`,
 * `session-switch.js` and `interrupt.js`, which this mirrors rather
 * than merges: eight families with separate contracts, and a shared
 * table would force this one to inherit another's policy.
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
// The declaration, and the HARD gate that goes with it
// ---------------------------------------------------------------------------

/**
 * The declaration this family's engine-facing half needs.
 *
 * `streamingSend` is the honest mapping and it is the same key the
 * capability matrix row "聊天" names: a turn that produces a stream.
 * The runtime surface behind it is `CliService.sendMessage` reached
 * through the TuiRuntimeAdapter's per-turn wrapper, and the provider
 * declares it `full` (see `providers/local-runtime-v2.capabilities.js`).
 *
 * `subItem` is `sendMessage` — the method name, not a webui concept.
 * It is what a `partial` declaration would list in `missing`, and what
 * the 501 payload reports, so it has to be the name a provider author
 * would recognise from the source.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "hard"}>>}
 */
export const STREAMING_SEND_ENDPOINTS = Object.freeze({
  "POST /api/send": Object.freeze({
    capability: "streamingSend",
    subItem: "sendMessage",
    enforcement: "hard",
  }),
});

/**
 * Resolve the provider that answers the send family on `transport`, or
 * `null` when none is registered yet.
 *
 * @param {string} transport One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveStreamingSendProvider(transport) {
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
 *     This is the DEFAULT `acp` transport, and a send proceeding here is
 *     the pre-M3 behaviour, not a hole in the gate.
 *   - `"capability-absent"`     — the provider WAS found and DOES declare
 *     `streamingSend` as `none`.
 *   - `"partial"`               — the provider is `partial` and
 *     `sendMessage` is in its `missing` list.
 *
 * Never throws `EngineCapabilityNotSupportedError`. A genuinely unknown
 * endpoint key is still a plain Error — caller confusion is not a
 * capability question, and the HTTP layer must never answer 501 for a
 * typo in webui's own code.
 *
 * @param {string} endpoint A key of STREAMING_SEND_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string, subItem: string, enforcement: "hard"}}
 */
export function checkStreamingSendCapability(endpoint, transport) {
  const need = STREAMING_SEND_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkStreamingSendCapability: "${endpoint}" is not part of the streaming-send family ` +
        `(known: ${Object.keys(STREAMING_SEND_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_streaming_send_endpoint";
    throw err;
  }
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveStreamingSendProvider(transport);
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
  return { ...descriptor, gate: "capability-absent" };
}

/**
 * Enforce the declaration. Throws `EngineCapabilityNotSupportedError`
 * when a RESOLVED provider does not offer the send surface, which
 * `app.js#invokeHandler` maps to the shared 501 payload.
 *
 * Returns without throwing when no provider claims the transport. That
 * is not a hole: `acp` is the default and the ACP path does not go
 * through this facade at all — the gate only ever speaks about a
 * provider that has been resolved and has made a declaration.
 *
 * @param {string} endpoint A key of STREAMING_SEND_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string, subItem: string}}
 */
export function assertStreamingSendCapability(endpoint, transport) {
  const need = STREAMING_SEND_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `assertStreamingSendCapability: "${endpoint}" is not part of the streaming-send family ` +
        `(known: ${Object.keys(STREAMING_SEND_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_streaming_send_endpoint";
    throw err;
  }
  const provider = resolveStreamingSendProvider(transport);
  if (!provider) {
    return {
      endpoint,
      gate: "unregistered-transport",
      provider: null,
      capability: need.capability,
      subItem: need.subItem,
    };
  }
  assertEngineCapability(provider.capabilities, need.capability, provider.id, need.subItem);
  return {
    endpoint,
    gate: "checked",
    provider: provider.id,
    capability: need.capability,
    subItem: need.subItem,
  };
}

// ---------------------------------------------------------------------------
// Pure derivations, part 1 — the event taxonomy
// ---------------------------------------------------------------------------

/**
 * What one runtime event means to webui's line syntax.
 *
 * These are webui's words, not the runtime's. `thought` / `message` /
 * `tool` are the three families the ACP path accumulates separately;
 * `authoritative` is the settled message that OVERWRITES the
 * accumulator instead of appending to it (the runtime emits both
 * deltas and, at close, one complete message — the ACP transport's
 * `result.answer` is the same fact delivered once instead of thousands
 * of times); `terminal` is a turn outcome; the rest are facts about
 * the stream that produce no line.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SEND_EVENT_KINDS = Object.freeze({
  THOUGHT: "thought",
  MESSAGE: "message",
  TOOL: "tool",
  AUTHORITATIVE: "authoritative",
  STREAM: "stream",
  TERMINAL: "terminal",
  IGNORE: "ignore",
});

/** Tool-call lifecycle stages, from `agent-core`'s `ToolCallStatus`. */
const TOOL_STATUS = Object.freeze({
  START: 1,
  FINISHED: 2,
  FAILED: 3,
  PREPARING: 4,
  PREPARED: 5,
});

/**
 * The stages whose call is still moving, mapped to the ACP path's word
 * for "announced but not done". Kept as its own frozen table so the
 * stage list has one home: adding a stage to `ToolCallStatus` and
 * forgetting to classify it is a silent "completed", which would print
 * a half-streamed argument as if it were the tool's result.
 */
const PENDING_TOOL_STAGES = Object.freeze([
  TOOL_STATUS.START,
  TOOL_STATUS.PREPARING,
  TOOL_STATUS.PREPARED,
]);

/** The session statuses that END a turn, from `TuiStreamEvent`. */
const TERMINAL_SESSION_STATUS = Object.freeze(["finished", "error", "aborted", "interrupted"]);

/**
 * Classify ONE runtime stream event into what webui must do with it.
 *
 * Pure, total, and never throws: an event shape webui does not
 * recognise becomes `{kind: IGNORE}` rather than killing a turn that is
 * otherwise streaming correctly. That asymmetry is deliberate — a
 * bridge that throws on an unknown frame turns every future runtime
 * addition into an outage of the chat endpoint, which is a strictly
 * worse failure than not rendering one line.
 *
 * The return is a small descriptor, not the line itself. The line is
 * text the CALLER owns (`● ` + normalized text), because the
 * normalization is the one thing the ACP path must not change.
 *
 * @param {object|null|undefined} event A `TuiStreamEvent`.
 * @returns {{kind: string, text?: string, toolCalls?: object[], messageId?: string, usage?: object, finishReason?: string, status?: string, errorMessage?: string}}
 */
export function classifySendEvent(event) {
  if (!event || typeof event !== "object") {
    return { kind: SEND_EVENT_KINDS.IGNORE };
  }
  switch (event.type) {
    case "delta": {
      // A delta can carry several families at once (a tool call streamed
      // alongside a text fragment). Tool first, because a `→ name` line
      // must be emitted before the text it interrupted, and because
      // webui's segment discriminator is broken by a tool call
      // regardless of whether text rode along.
      if (Array.isArray(event.toolCalls) && event.toolCalls.length > 0) {
        return {
          kind: SEND_EVENT_KINDS.TOOL,
          toolCalls: event.toolCalls,
          ...(typeof event.content === "string" ? { text: event.content } : {}),
          ...(typeof event.thinking === "string" ? { thinking: event.thinking } : {}),
        };
      }
      if (typeof event.content === "string" && event.content !== "") {
        return { kind: SEND_EVENT_KINDS.MESSAGE, text: event.content };
      }
      if (typeof event.thinking === "string" && event.thinking !== "") {
        return { kind: SEND_EVENT_KINDS.THOUGHT, text: event.thinking };
      }
      // `finish: true` with no payload is the segment terminator. It
      // carries no line, but it IS a segment break, so the runner can
      // recognize it safely as a no-op of the thought family.
      return { kind: SEND_EVENT_KINDS.IGNORE };
    }
    case "message": {
      const m = event.message;
      // `Array.isArray` is not optional here: an array passes
      // `typeof === "object"`, so a malformed frame carrying
      // `message: []` would otherwise be classified AUTHORITATIVE with
      // every field undefined — which reads to the runner as "the engine
      // settled a turn with no text" and lets it clear a good
      // accumulation. Same rule as `isRecord` in the runtime's own
      // decoders.
      if (!m || typeof m !== "object" || Array.isArray(m)) {
        return { kind: SEND_EVENT_KINDS.IGNORE };
      }
      if (m.finishReason === "error") {
        return {
          kind: SEND_EVENT_KINDS.TERMINAL,
          errorMessage:
            typeof m.content === "string" && m.content.trim()
              ? m.content.trim()
              : "Runtime stream failed",
        };
      }
      return {
        kind: SEND_EVENT_KINDS.AUTHORITATIVE,
        ...(typeof m.content === "string" ? { text: m.content } : {}),
        ...(typeof m.thinking === "string" ? { thinking: m.thinking } : {}),
        ...(Array.isArray(m.toolCalls) && m.toolCalls.length > 0
          ? { toolCalls: m.toolCalls }
          : {}),
        ...(m.usage ? { usage: m.usage } : {}),
        ...(typeof m.finishReason === "string" ? { finishReason: m.finishReason } : {}),
        ...(typeof m.id === "string" ? { messageId: m.id } : {}),
        ...(typeof m.error === "string" ? { errorMessage: m.error } : {}),
      };
    }
    case "session-status": {
      if (!TERMINAL_SESSION_STATUS.includes(event.status)) {
        return { kind: SEND_EVENT_KINDS.STREAM, status: event.status };
      }
      return {
        kind: SEND_EVENT_KINDS.TERMINAL,
        status: event.status,
        ...(typeof event.message === "string" ? { errorMessage: event.message } : {}),
      };
    }
    case "error": {
      return {
        kind: SEND_EVENT_KINDS.TERMINAL,
        errorMessage:
          typeof event.message === "string" ? event.message : "Runtime stream failed",
      };
    }
    case "done":
      return { kind: SEND_EVENT_KINDS.TERMINAL, status: "finished" };
    // Liveness, resync and generic projections: real, load-bearing for
    // operators, and none of them a chat line. `resync-required` in
    // particular means webui's view of the turn diverged from the
    // runtime's — see KNOWN DEBT 2, which is the open question about
    // what webui should do with that fact.
    case "heartbeat":
    case "resync-required":
    case "messages-replaced":
    case "messages-rewound":
    case "generic":
    default:
      return { kind: SEND_EVENT_KINDS.IGNORE };
  }
}

/**
 * Advance one accumulator segment.
 *
 * This is the piece of the bridge that is easiest to get subtly wrong,
 * and getting it wrong is invisible: a missing reset makes the next
 * `●` line contain every previous segment's text, which still renders
 * and still looks like an answer.
 *
 * The rule, matching the ACP path's `lastChunkKind` discriminator: a
 * delta of the SAME family appends to the buffer; a delta of a
 * DIFFERENT family — or of any family after a tool call — starts a
 * fresh segment. `lastKind` is the caller's own field, so this stays
 * pure and the whole transition table is testable without a stream.
 *
 * @param {string|null} lastKind The family the buffer currently holds.
 * @param {string} kind The family of the incoming delta.
 * @param {string} buffer The accumulated text so far.
 * @param {string} delta The incoming text.
 * @returns {{reset: boolean, text: string, lastKind: string}}
 */
export function sendSegmentAdvance(lastKind, kind, buffer, delta) {
  if (typeof delta !== "string" || delta === "") {
    return { reset: false, text: buffer, lastKind };
  }
  if (lastKind !== kind) {
    return { reset: true, text: delta, lastKind: kind };
  }
  return { reset: false, text: buffer + delta, lastKind };
}

/**
 * The turn outcome a terminal event implies, in the vocabulary the
 * route already reads.
 *
 * `aborted` is NOT a failure: the user pressed stop, and B7's
 * `abortSession` is what ended the turn. The route's error branch is
 * gated on `r.status === "failed" || r.error`, so reporting an abort as
 * a failure would fire an error alert for a user action. This is the
 * runtime transport's version of B7's "`cancelled` means sent" rule,
 * and it is asserted in both directions.
 *
 * @param {string} status One of the terminal `session-status` values.
 * @returns {{status: "succeeded"|"failed"|"aborted", errorMessage: string|null}}
 */
export function sendTerminalOutcome(status) {
  if (status === "finished") return { status: "succeeded", errorMessage: null };
  if (status === "aborted" || status === "interrupted") {
    return { status: "aborted", errorMessage: null };
  }
  return {
    status: "failed",
    errorMessage: `Runtime turn ended with status "${status}"`,
  };
}

// ---------------------------------------------------------------------------
// Pure derivations, part 2 — the line bodies
// ---------------------------------------------------------------------------

/**
 * Normalize a tool-call payload into the `u` shape
 * `lib/mcode-acp.js#applyToolUpdate` already consumes.
 *
 * Reusing that reducer rather than writing a second one is the point:
 * the indented body syntax, the `@ path` lines, the `! error` line and
 * the subagent-detection wiring have exactly one home, and the runtime
 * transport inherits all of them by producing the same input. A second
 * implementation would be a second place for the `→ name` header to
 * disagree with the body that follows it.
 *
 * Stage mapping, which is the part that is webui's judgement and not
 * the runtime's:
 *
 *   - Start / Preparing / Prepared → `pending`. The call is announced
 *     and its arguments are still moving; a body here would print a
 *     half-streamed argument as if it were the tool's input.
 *   - Finished                   → `completed` (the ACP path's word).
 *   - Failed                     → `error` (also the ACP path's word).
 *
 * The ACP path reads `u.status || "completed"`, so an absent status on
 * a call that has already been announced is treated as completion —
 * matching, not a new default.
 *
 * @param {object} toolCall A `TuiToolCall`.
 * @returns {object} The `applyToolUpdate` update shape.
 */
export function sendToolUpdate(toolCall) {
  const tc = toolCall && typeof toolCall === "object" ? toolCall : {};
  // The runtime sends the stage as a number; a provider that sends the
  // NAME is accepted too, because the ACP path's own `u.status` is a
  // string and a future merge of the two vocabularies would otherwise
  // silently downgrade every stage to "completed".
  const stage =
    typeof tc.status === "number" && Number.isInteger(tc.status)
      ? tc.status
      : TOOL_STATUS[String(tc.status).toUpperCase()];
  const mapped =
    stage === TOOL_STATUS.FAILED
      ? "error"
      : PENDING_TOOL_STAGES.includes(stage)
        ? "pending"
        : "completed";
  const outText = toolResultText(tc.output);
  return {
    ...(typeof tc.id === "string" ? { toolCallId: tc.id } : {}),
    title: typeof tc.name === "string" && tc.name ? tc.name : "tool",
    status: mapped,
    // The ACP header is `→ name  <JSON of the args>`; forwarding the
    // PARSED input (rather than re-encoding it) is what lets
    // `applyToolUpdate`'s own `JSON.stringify` produce the identical
    // string, and it is the only place the `→` line's payload is
    // decided.
    ...(tc.input !== undefined && tc.input !== null ? { rawInput: tc.input } : {}),
    ...(outText ? { rawOutput: { content: [{ type: "text", text: outText }] } } : {}),
    ...(tc.error !== undefined && tc.error !== null
      ? { error: typeof tc.error === "string" ? tc.error : JSON.stringify(tc.error) }
      : {}),
    // Forwarded so a future stage-aware caller can tell a Preparing call
    // from a Finished one without this module having to grow a field
    // for it. `applyToolUpdate` ignores what it does not know.
    wireStatus: stage === undefined ? (tc.status ?? null) : stage,
  };
}

/**
 * The text of a tool result, whatever shape the runtime sent.
 *
 * The runtime parses `tool_call_result_data` into a value; the ACP path
 * received a `rawOutput.content[]` array of typed parts. Both reduce to
 * one string here, and a non-string result (a number, a bare array, a
 * structured preview) is JSON-stringified rather than dropped — a tool
 * whose result webui cannot render is still a tool the user ran.
 *
 * @param {unknown} output
 * @returns {string} Empty when there is nothing to show.
 */
function toolResultText(output) {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts = output
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return null;
      })
      .filter((x) => typeof x === "string" && x !== "");
    if (parts.length > 0) return parts.join("\n");
  }
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

/**
 * The `→ name  <args>` header line, in the ACP path's exact spelling.
 *
 * Why this is here and not in the runner: `applyToolUpdate` only emits
 * a header when it SYNTHESIZES one (a body whose header never arrived),
 * and the synthesized form deliberately carries no arguments — it
 * exists for a body webui attached to mid-stream, where the args are
 * gone. The runtime path is the other case: the first sighting of a
 * call DOES have its arguments, and the ACP path prints them
 * (`streamAcpPrompt`'s `→ ${name}  ${input}`). So the runner writes
 * this header itself for a new id and pre-registers the index, which
 * makes `applyToolUpdate` take its "header already known" branch and
 * write only the body. One home for the header syntax, one home for
 * the body syntax, and the two cannot disagree about spacing or the
 * double space.
 *
 * The double space is load-bearing — it is what the ACP line looks like
 * and the decoder splits on it — so it is transcribed, not tidied.
 *
 * @param {object} update A `sendToolUpdate` result.
 * @returns {string}
 */
export function sendToolHeaderLine(update) {
  const u = update && typeof update === "object" ? update : {};
  const name = typeof u.title === "string" && u.title ? u.title : "tool";
  if (u.rawInput === undefined || u.rawInput === null) return `→ ${name}`;
  let input;
  try {
    input = JSON.stringify(u.rawInput);
  } catch {
    // A circular argument object is not a reason to lose the header.
    return `→ ${name}`;
  }
  return input ? `→ ${name}  ${input}` : `→ ${name}`;
}

/**
 * Project a `TuiTokenUsage` onto the `r.usage` shape the ACP finalize
 * reads (`{totalTokens, inputTokens, outputTokens}`).
 *
 * Returns `null` — not a zeroed object — when the runtime reported
 * nothing usable, because the finalize's "no usage" branch is what
 * falls back to a length-based estimate. A zeroed object would take
 * that branch away and leave the context panel reading zero tokens.
 *
 * @param {object|null|undefined} usage
 * @returns {{totalTokens: number, inputTokens: number, outputTokens: number}|null}
 */
export function sendUsageTotals(usage) {
  if (!usage || typeof usage !== "object") return null;
  const total = num(usage.totalTokens);
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  if (total === null && input === null && output === null) return null;
  return {
    totalTokens: total ?? 0,
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Pure derivations, part 3 — the red lines the route owns
// ---------------------------------------------------------------------------

/**
 * RED LINE 1 (run-mirror) — whether `cs` is still the session this turn
 * is running for.
 *
 * Mid-turn the user can switch conversations, which re-points `cs` at
 * ANOTHER record. A cs mutation after that point stamps this turn's
 * engine id, title or chat onto the session the user switched TO. The
 * test is the same one the ACP runner applies at bind and at finalize,
 * written as one function so the two transports cannot drift:
 *
 *   - no owning record id → the turn never got a draft (a direct
 *     caller); treat as still viewing.
 *   - `cs.sessionId` equals the owning record id → still viewing
 *     (pre-promotion form).
 *   - `cs.sessionId` equals the engine sid → still viewing
 *     (post-promotion form, because the record was renamed to the
 *     engine id at bind time).
 *   - anything else → the user switched away.
 *
 * @param {object|null|undefined} cs The requesting client's state.
 * @param {string|null|undefined} owningWebuiSessionId
 * @param {string|null|undefined} sid The engine sid the turn runs on.
 * @returns {boolean}
 */
export function sendStillViewing(cs, owningWebuiSessionId, sid) {
  if (!owningWebuiSessionId) return true;
  if (!cs) return false;
  if (cs.sessionId === owningWebuiSessionId) return true;
  if (sid != null && cs.sessionId === sid) return true;
  return false;
}

/**
 * RED LINE 2 (finalize drain) — rewrite the last `●` line of a drained
 * run buffer to the authoritative answer.
 *
 * Mirrors the route's own in-place rewrite, which only ever runs when
 * the user is still viewing. The runtime path needs the same operation
 * over a DETACHED list, because a turn that ended while the user was
 * elsewhere must still record the final answer text against the run's
 * own lines rather than the other session's chat.
 *
 * Two behaviours are load-bearing and both are pinned:
 *
 *   - The LAST `●` line wins, scanning from the end. A turn that
 *     produced several answer segments (a tool call between two of
 *     them) has more than one, and the final answer is the last.
 *   - When there is none, the answer is APPENDED. The alternative —
 *     dropping it — loses the turn's only output on a runtime that
 *     streams no `●` at all.
 *
 * Pure: the input array is never mutated, so a caller can compare the
 * before and after.
 *
 * @param {string[]} lines The drained run-chat lines.
 * @param {string|null} oneLine The authoritative one-line answer.
 * @returns {string[]} A new array; the input is untouched.
 */
export function rewriteDrainedAnswerLine(lines, oneLine) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const out = lines.slice();
  if (oneLine === null || oneLine === undefined) return out;
  for (let i = out.length - 1; i >= 0; i--) {
    if (typeof out[i] === "string" && out[i].startsWith("● ")) {
      out[i] = `● ${oneLine}`;
      return out;
    }
  }
  out.push(`● ${oneLine}`);
  return out;
}

/**
 * RED LINE 3 (`promoteDraftToMcodeSid`) is NOT a derivation and is
 * deliberately not re-derived here.
 *
 * The promotion is the route's, and its condition — "the viewed session
 * has an engine id" — is already the right one for both transports:
 * `promoteDraftToMcodeSid` is itself a no-op when
 * `cs.sessionId === cs.mcodeSessionId`, which is the post-bind state of
 * every turn. Narrowing the route's condition with a second predicate
 * would be a behaviour change on the acp path — the batch's survival
 * condition — in exchange for a guarantee the existing guard already
 * makes. So the evidence for this red line is a ROUTE test asserting
 * the promotion on the runtime path and its absence after a mid-run
 * switch, not a new exported function. B8a therefore ships no predicate
 * here, and the suite pins that none exists.
 */

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// Recorded here rather than fixed, because each item is a decision that
// belongs to a human and not to a refactor:
//
//   1. THE HARD GATE IS DECLARED BUT NOT EXERCISED. It throws for a
//      RESOLVED provider that declares no `streamingSend`, and it is
//      unreachable on both transports today: v2 declares `streamingSend:
//      full`, and `acp` has no registered provider (M4's registry). B8a
//      does not even call it — #12 is unwired until B8b — so the honest
//      description of the 501 is "a policy that is stated, tested in
//      isolation, and not yet reachable". The suite pins both halves
//      (`checked` under `runtime`, `unregistered-transport` and no
//      throw under `acp`), so a provider declaration that makes it
//      reachable has to be a deliberate edit rather than a surprise.
//
//   2. `resync-required`, `messages-replaced` AND `messages-rewound` ARE
//      CLASSIFIED `IGNORE`. The runtime can tell webui that its view of
//      the turn diverged — that is what `resync-required` means — and
//      webui keeps the last rendered line buffer and says nothing to the
//      user. The runner's only surface is a log line, which is the right
//      minimum but not a resolution: whether webui should re-derive
//      the turn from the engine's own spine on a resync is a product
//      question, and it interacts with the mirror-retirement work on
//      `lib/transcript.js` (#126), where the question of which lines are
//      authoritative is already being re-argued. Deciding it twice, in
//      two files, is how the two answers drift.
//
//   3. THE BRIDGE PRODUCES A LOSSY MIRROR, DELIBERATELY. `●` carries a
//      single flattened line and `→ name` carries the call's arguments
//      as they were at first sighting — the same lossy form the ACP path
//      has always produced, and producing anything richer here would
//      make the two transports' transcripts incomparable. The
//      consequence is that the #126 mirror-retirement criterion must
//      recognize the RUNTIME form of a lossy mirror as well as the ACP
//      one; the two are the same fact, so the criterion should be
//      written once against the line grammar rather than twice against
//      the transports.
//
