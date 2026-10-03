// webui/server/engine/providers/exec.capabilities.js
//
// Capability declaration for the `exec` transport — the one-shot
// `mcode exec` subprocess, client `packages/webui/server/lib/mcode-exec.js`
// (`runMcodeExec` / `collectExecResult`), server side the `mcode exec`
// command in `packages/tui/src/cli/` (`applyExecCliContract`,
// `run-exec-command.ts`). Declaration ONLY, like its three siblings: no
// `@mavis/*` import and no subprocess construction, so
// `/api/engine-capabilities` can answer `?provider=exec` from the boot
// path without spawning anything.
//
// ---------------------------------------------------------------------------
// WHAT THE `exec` TRANSPORT ACTUALLY IS — the fact this file exists to record
// ---------------------------------------------------------------------------
//
// It is the third of the three `MCODE_WEBUI_TRANSPORT` values
// (`packages/webui/server/lib/config.js:224`), and it is a REAL transport
// with a real wire surface, not an alias of the tui package and not a mode
// of the acp one:
//
//   - No persistent engine session. `lib/mcode-rpc.js:90-93` states it: an
//     exec run registers a raw `ChildProcess`, "the one-shot `mcode exec`
//     CLI has no persistent engine session to configure". Every turn is a
//     fresh process; `--session <id>` re-enters an EXISTING active session,
//     it does not create, list, load or close one.
//   - No JSON-RPC channel at all. `mcode-exec.js` writes the prompt to
//     stdin (line 210) and reads newline-delimited `stream-json` off
//     stdout (lines 250-294). There is no request to send and therefore
//     no method to call — the whole "which method is registered" question
//     that decides the acp column does not arise here.
//
// That second point is the whole design constraint on this file, and it
// is why the interface is stated as ARGV + EVENT TYPES below rather than
// as a method table. `MCODE_ACP_CAPABILITIES` is a flat method→boolean
// wire table because the acp protocol has methods. `mcode exec` has
// exactly two axes:
//
//   1. what the process is TOLD (the CLI options in
//      `applyExecCliContract`, packages/tui/src/cli/contract.ts:102-152),
//   2. what the process SAYS BACK (the `ExecEvent` union in
//      packages/tui/src/headless/events.ts:27-48, plus its `ExecItem`
//      kinds at events.ts:21).
//
// `EXEC_INTERFACE` states both, transcribed with per-item evidence, and
// `test/lib/engine/capability-snapshot.test.js` keeps them honest
// mechanically — see the "Keeping this table honest" note on
// `EXEC_INTERFACE` for the two live cross-checks. The audit function the
// acp provider got (`auditAcpCapabilities`) has its counterpart here
// (`auditExecCapabilities`), and the mutation checks under it pin both.
//
// ---------------------------------------------------------------------------
// WHERE `exec` IS WEAKER THAN `acp`, AND WHERE IT IS STRONGER
// ---------------------------------------------------------------------------
//
// Weaker on six keys, and every one of them is structural rather than a
// missing implementation on the engine side:
//
//   interrupt       acp has a `session/cancel` NOTIFICATION; exec has
//                   nothing at all. `run-exec-command.ts:51-53` registers
//                   SIGINT/SIGTERM/SIGHUP, but those are OS signals on
//                   the child webui itself spawned — they are how
//                   webui's own `/api/stop` kill cascade works, not a
//                   method the transport offers. A declaration reading
//                   "there is a way to stop it" would be describing
//                   webui's process management and calling it a
//                   capability.
//   subagents       acp at least carries sub-agent activity on its
//                   sessionUpdate stream. The exec event union has no
//                   delegation or background-task kind at all
//                   (events.ts:27-48), and `runner.ts:899-902` says why:
//                   "Sub-agent Sessions are internal and cannot be
//                   opened."
//   authCredentials acp exposes `mcode/account/status` and
//                   `session/set_config_option`. exec has no RPC channel,
//                   so `getAccountStatus` and `setConfigOption` are
//                   unreachable: `/api/account` and `/api/usage` read
//                   through `lib/mcode-rpc.js` to a client that only the
//                   acp transport starts. `--model` / `--effort`
//                   (contract.ts:113-114) are per-run spawn flags, not a
//                   readable or writable account surface.
//   sessionCrud     only re-entry and resume; none of list/new/load/
//                   close/delete/rename/archive/fork.
//   mcp             config-file driven, no method.
//   toolSkillInvocation  carries `tool_call` items but no permission
//                   request/reply pair and no skill enumeration.
//
// Stronger on exactly one key, and the suite says so out loud rather than
// letting a future "harmonisation" flatten it: `usageStats` gets
// per-turn token usage over the wire (`turn.completed.usage`,
// events.ts:36), which the acp protocol does not carry at all — acp's
// `usageStats` partial has to name all three per-session methods because
// it has nothing underneath them.
//
// ---------------------------------------------------------------------------
// THE REVERSE EXCEPTION IS THE SAME TWO KEYS, FOR THE SAME REASON
// ---------------------------------------------------------------------------
//
// `turnDiff` and `plugins` are honestly `none` here — the exec CLI has
// no diff method and no plugin method — and the thirteen webui endpoints
// behind them still work, because `routes/turn-diff.js` and
// `routes/plugins.js` reach the in-process local-runtime-v2 host through
// `getEngineCatalogueHost()` and are gated on NO transport. This is the
// plan's one reverse exception (doc/m3-batch-plan.md §6) and it is not
// acp-specific: it is a property of those two ROUTES, so every transport
// inherits it. M4-1's `servedBy` mechanism carries it unchanged.
//
// NOT in this batch, on purpose: no `providerByTransport()` table names
// `exec` yet, so no consumer resolves to this provider and no gate's
// verdict changed. See engine/index.js and
// test/lib/engine/capabilities.test.js, which pins that gap from both
// sides so it cannot close by accident.

import { ENGINE_CAPABILITY_KEYS, validateEngineCapabilities } from "../capabilities.js";

/**
 * The `mcode exec` interface surface, in the only two axes the transport
 * has. Transcribed from packages/tui/src/cli/contract.ts:102-152
 * (`applyExecCliContract`) and packages/tui/src/headless/events.ts:19-48
 * (`ExecItem` / `ExecEvent`) at the 5c07d6c9 baseline.
 *
 * Keeping this table honest. The acp provider audits against
 * `MCODE_ACP_CAPABILITIES`, which is LIVE — it is the same constant the
 * routes read, so a protocol method appearing turns the audit red. This
 * table has no such constant behind it, because the exec contract lives
 * in another package's TypeScript and importing it would put
 * `@mavis/*` on the boot path. So the two live cross-checks live in
 * `test/lib/engine/capability-snapshot.test.js` instead, and they are
 * what stops this being a hand-typed claim:
 *
 *   - every `--option` in contract.ts's exec block is read out of the
 *     source and compared to `cliOptions`, and every `type:` in the
 *     `ExecEvent` union is read out of events.ts and compared to
 *     `streamEvents` / `itemKinds` — so an option or event the tui side
 *     grows without a re-audit goes red;
 *   - `buildExecArgs()` (mcode-exec.js:134, a pure function) is invoked
 *     and its argv compared to `cliOptions`, so `cliOptions` can never
 *     shrink below what webui actually sends either.
 *
 * @typedef {{cliOptions: readonly string[], streamEvents: readonly string[],
 *            itemKinds: readonly string[], processSignals: readonly string[],
 *            consumedEvents: readonly string[]}} ExecInterface
 */
export const EXEC_INTERFACE = Object.freeze({
  // `applyExecCliContract` options, contract.ts:104-152. `--file`,
  // `--prompt-mode`, `--continue`, `--diagnostics-dir`, `--output-schema`
  // and `--output-last-message` are part of the contract even though
  // `buildExecArgs` does not pass them; the table states the INTERFACE,
  // and the cross-check proves the subset webui sends is inside it.
  cliOptions: Object.freeze([
    "--input",
    "--input-format",
    "--cwd",
    "--file",
    "--model",
    "--effort",
    "--prompt-mode",
    "--session",
    "--continue",
    "--config",
    "--permission",
    "--timeout",
    "--max-steps",
    "--output-format",
    "--diagnostics-dir",
    "--output-schema",
    "--output-last-message",
  ]),
  // `ExecEvent` union, events.ts:29-47. `session.started` and
  // `session.resumed` are the whole of exec's session surface: they tell
  // webui WHICH session the run entered, and can be told to enter one.
  streamEvents: Object.freeze([
    "exec.started",
    "session.started",
    "session.resumed",
    "turn.started",
    "item.started",
    "item.updated",
    "item.completed",
    "turn.completed",
    "turn.failed",
    "exec.completed",
  ]),
  // `ExecItem.type`, events.ts:21. `tool_call` is what keeps
  // toolSkillInvocation from being `none` on this transport.
  itemKinds: Object.freeze(["agent_message", "reasoning", "tool_call"]),
  // `run-exec-command.ts:51-53`. Recorded so a reader can see that the
  // interrupt path EXISTS and why it is still not a capability: these
  // are signals webui delivers to its own child, not a method the
  // transport answers.
  processSignals: Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]),
  // The stream-json types `collectExecResult` actually branches on
  // (mcode-exec.js:259, 278, 284) — recorded because they are NOT the
  // types the transport emits, and that fact is load-bearing rather
  // than a curiosity.
  //
  // `--output-format stream-json` writes exactly what
  // `ExecEventProjector` produces and nothing else: `output.ts:34-36`
  // refuses the format outright when no projector is supplied, and
  // `runner.ts:218-232` always supplies one. So the wire carries
  // `streamEvents` and nothing else — and `consumedEvents` has an EMPTY
  // intersection with it. `delta`, `message` and `exec.result` are the
  // supervisor's INTERNAL stream-event names (packages/tui/src/headless/
  // supervisor.ts:189 and the family around it), not the projected wire
  // names.
  //
  // This is recorded rather than papered over for three reasons. It caps
  // what the declaration may claim: every level below is justified by
  // the WIRE, and the `consumedEvents` note is what stops a reader from
  // believing webui currently reads any of it. It explains the
  // `toolSkillInvocation` reason, which is otherwise puzzling: the
  // transport produces `tool_call` items and webui has no branch for
  // them. And it is pinned by a test in capability-snapshot.test.js that
  // fails if the intersection ever becomes non-empty in either
  // direction, so the two families cannot drift into each other by
  // accident. M4-2 does NOT fix it: the mismatch is in the exec DATA
  // PLANE, and this batch registers a declaration and changes no
  // routing. See KNOWN DEBT in the M4-2 report.
  consumedEvents: Object.freeze(["delta", "message", "exec.result"]),
});

/**
 * The 14-key declaration for the exec transport provider. Levels follow
 * the same rule as every sibling: the question is whether the TRANSPORT'S
 * OWN interface carries the capability, never whether a webui route
 * happens to exist for it.
 */
export const EXEC_CAPABILITIES = Object.freeze({
  // Partial, and the only session verbs exec has are re-entry and
  // resume. `--session <id>` runs in an existing ACTIVE session
  // (contract.ts:129) and `--continue` picks the latest one in `--cwd`
  // (contract.ts:130); the event side says which session was entered
  // (`session.started` / `session.resumed`, events.ts:30). What is
  // missing is every verb that would let webui CHOOSE a session: the
  // side bar, the title read, the load and the destructive family all
  // have no exec method, which is why the sub-items name the v2 and
  // adapter methods the routes' gates actually pass (`listSessions`,
  // `getSession`, `loadSession`, `activateSession`, `deleteSession` among
  // them) rather than invented exec-shaped names.
  sessionCrud: {
    level: "partial",
    missing: [
      "createSession",
      "listSessions",
      "getSession",
      "updateSession",
      "renameSession",
      "archiveSession",
      "deleteSession",
      "forkSession",
      "getSessionForkOptions",
      "loadSession",
      "activateSession",
    ],
    reason:
      "the CLI can re-enter or resume an existing active session (`--session` / `--continue`, packages/tui/src/cli/contract.ts:129-130) and the stream says which one (events.ts:30), but no list, new, load, close, delete, rename, archive or fork method exists: every turn is a fresh one-shot process with no session store to query (packages/webui/server/lib/mcode-rpc.js:90-93)",
  },
  // The one key the whole transport is FOR. `--input -` feeds the prompt
  // on stdin (contract.ts:105) and `--output-format stream-json`
  // (contract.ts:140) returns the projected event stream.
  streamingSend: { level: "full" },
  // interface-absent, and the process signals are named so a reader does
  // not mistake them for a method: see the header's first bullet.
  interrupt: {
    level: "none",
    reason:
      "interface-absent: the transport has no request channel at all (mcode-exec.js writes the prompt to stdin and parses stdout, lines 206-294), so there is no cancel method to call. `run-exec-command.ts:51-53` registers SIGINT/SIGTERM/SIGHUP, but those are OS signals webui delivers to the child it spawned itself — they are how webui's own kill cascade works, not something the transport answers (engine/interrupt.js fact 1 applies here for the same reason it applies to acp)",
  },
  // Partial, and the reason has to say BOTH halves: the wire carries
  // tool calls and webui has no branch for them.
  toolSkillInvocation: {
    level: "partial",
    missing: ["listSkills", "listRuntimeSkills", "listPendingPermissions", "replyPermission", "setMode"],
    reason:
      "the transport PRODUCES `tool_call` items (packages/tui/src/headless/events.ts:21) and webui does not read them: `collectExecResult` branches on delta/message/exec.result (mcode-exec.js:259-291), none of which is a name the stream-json wire can emit — see EXEC_INTERFACE.consumedEvents for the full account. So on this transport the tool surface exists and is invisible, which is a different fact from acp's, where the events are produced AND parsed. There is no permission request/reply pair either: `--permission` is fixed at spawn time and the CLI says so itself — 'permission policy: smart, full, or off (ask requires TUI/ACP)' (contract.ts:130) — and no skill enumeration method exists",
  },
  // none, AND served in process: the same reverse exception acp carries,
  // because the property belongs to the route, not to the transport.
  turnDiff: {
    level: "none",
    reason:
      "interface-absent: neither the CLI contract (contract.ts:102-152) nor the event union (events.ts:27-48) carries a diff of any kind. The three /api/turn-diff endpoints are NOT degraded — they are a projection over `applications.session.diff` on the in-process local-runtime-v2 host, reached through getEngineCatalogueHost() since M3-B0, and routes/turn-diff.js gates on no provider declaration, so they work on this transport exactly as they do on acp",
    servedBy: "local-runtime-v2",
  },
  // No rewind, no redo, no message edit. `mcode exec review`
  // (packages/tui/src/cli/program.ts:101) is NOT this key: it reviews
  // staged/unstaged/untracked local changes, which is a Git-shaped
  // request with no turn coordinate in it.
  turnRewindRedo: {
    level: "none",
    reason:
      "interface-absent: no rewind, redo or message-edit option in the exec contract and no turn-scoped event to hang one on; `mcode exec review` (packages/tui/src/cli/program.ts:101) reviews LOCAL GIT CHANGES and carries no turn coordinate, so it is not a rewind surface. The capability lives in local-runtime v1/v2 and webui exposes no route for it",
  },
  // The second half of the reverse exception, for the same reason.
  plugins: {
    level: "none",
    reason:
      "interface-absent: no plugin option and no plugin event in the exec contract or its event union. The ten /api/plugins endpoints are NOT degraded — they project the in-process local-runtime-v2 cliService through getEngineCatalogueHost(), and routes/plugins.js boots the host unconditionally on purpose (routes/plugins.js:26-30) so the panel is not gated on any transport",
    servedBy: "local-runtime-v2",
  },
  // Partial, weaker than acp's in the sense that matters: exec can be
  // HANDED an MCP configuration, and can do nothing with it afterwards.
  mcp: {
    level: "partial",
    missing: ["mcp-configure", "mcp-inspect", "mcp-clear", "mcp-list"],
    reason:
      "MCP servers configured in the runtime config take effect inside the turn — `--config <path>` selects one explicitly (contract.ts:131) — but the transport exposes no configure/inspect/clear/list method, and a one-shot process has no session-scoped MCP surface to clear anyway",
  },
  // none, unlike acp's partial. The difference is the whole point of
  // pinning this: acp can at least parse sub-agent activity off its
  // stream, and exec's event union has no such kind at all.
  subagents: {
    level: "none",
    reason:
      "interface-absent: the exec event union has no delegation, sub-agent or background-task kind (packages/tui/src/headless/events.ts:27-48) — the tool calls a sub-agent would appear as are ordinary `tool_call` items with no parent reference, so even a consumer of the item stream could not reconstruct the tree. The engine side confirms the boundary rather than the transport's: `runner.ts:899-902` refuses to open sub-agent Sessions at all ('Sub-agent Sessions are internal and cannot be opened')",
  },
  // Partial, and STRONGER than acp on the WIRE: the per-turn usage is
  // emitted. The three per-session projections are still missing, and
  // the gate passes `getSessionUsage` (usage-reads.js).
  usageStats: {
    level: "partial",
    missing: ["getSessionUsage", "getSessionUsageSummary", "watchSessionUsageCommits"],
    reason:
      "per-turn token usage crosses the wire — `turn.completed.usage` (events.ts:36) is emitted by ExecEventProjector.complete and folded into the conversation counters by webui (mcode-exec.js:362-376) — so this transport is genuinely STRONGER than acp here, whose declaration has nothing underneath its three missing names. What is still absent is every per-session projection: a one-shot process cannot answer a query about a session it is not currently running. Read the level as a claim about the INTERFACE; whether webui's exec parser currently receives that event is a separate fact, recorded in EXEC_INTERFACE.consumedEvents",
  },
  // none, unlike acp's partial, and this is the second place where exec
  // is structurally behind rather than merely unimplemented.
  authCredentials: {
    level: "none",
    reason:
      "interface-absent: with no request channel there is no `mcode/account/status` extension and no `session/set_config_option`, so `getAccountStatus` and `setConfigOption` are both unreachable — `/api/account` and `/api/usage` read through lib/mcode-rpc.js to a client only the acp transport starts. `--model` and `--effort` (contract.ts:113-114) are per-run spawn flags, not a readable or writable account surface: they change the next process, cannot be queried, and carry no credential, plan or OAuth state",
  },
  // interface-absent. `mcode update` (packages/tui/src/cli/update.ts) is
  // a separate CLI command, not a capability of this transport.
  updateCheck: {
    level: "none",
    reason:
      "interface-absent: no update option and no update event in the exec contract or its event union. `mcode update` is a sibling CLI command (packages/tui/src/cli/update.ts) that this transport never invokes and cannot be asked about; it also never emits the ACP `available_commands_update` notification, because there is no channel to notify over",
  },
  // interface-absent, same boundary as acp: webui's /api/fs family is
  // its own node:fs implementation.
  fileReadWrite: {
    level: "none",
    reason:
      "interface-absent: `--file` attaches a file to the PROMPT (contract.ts:108) and is a read of webui's own choosing, not a workspace file surface; no method or event addresses the workspace tree, and webui's /api/fs family is its own node:fs implementation (server/lib/git.js:1 on the same boundary)",
  },
  // interface-absent, same boundary, for the same reason. Named
  // explicitly because `mcode exec review` DOES read local git changes —
  // and it is still not this key, for the reason turnRewindRedo records.
  gitOperations: {
    level: "none",
    reason:
      "interface-absent: no git option and no git event in the exec contract or its event union. `mcode exec review` runs the agent over local changes rather than exposing a git surface, and webui's /api/git family wraps the OS git binary independently (server/lib/git.js:1)",
  },
});

// The contract self-check, same discipline as every sibling
// declaration. A malformed entry must stop the module that declared it,
// not surface as a puzzling 501 three layers up.
if (validateEngineCapabilities(EXEC_CAPABILITIES).length > 0) {
  throw new Error("EXEC_CAPABILITIES is not a valid EngineCapabilities declaration");
}

/**
 * Audit this declaration against the interface it claims to describe.
 *
 * The exec counterpart of `auditAcpCapabilities`. Pure, and errors are
 * values, so the mutation checks can feed it synthetic inputs the same
 * way. Two rules, each aimed at a specific flattering mistake:
 *
 *   1. a `full` key must be covered by at least one interface fact, or
 *      `full` is a claim with nothing under it;
 *   2. a `none` key must be covered by NO interface fact — a capability
 *      cannot be denied on a surface that carries it.
 *
 * There is deliberately NO third rule of the shape "a `partial`'s
 * `missing` items must be covered by no interface fact", even though the
 * acp audit's wire table could afford one. The two `missing` namespaces
 * are disjoint here and the comparison would be vacuous: `missing` names
 * provider METHODS (`deleteSession`, `listSkills`) or kebab-case
 * SUB-CAPABILITIES (`mcp-configure`), while coverage names interface
 * MECHANISMS (`--session`, `tool_call`). No entry can ever match, so the
 * rule could not fail, and a check that cannot fail is worse than no
 * check — it reads as coverage in a file whose whole job is honesty.
 * What replaces it is the live cross-check in
 * `test/lib/engine/capability-snapshot.test.js`, which verifies the
 * coverage table against the real tui sources and verifies that every
 * name `missing` relies on is a real provider-surface method (spelled
 * out there in a test of its own).
 *
 * `servedBy` is NOT policed here either: it answers a routing question no
 * interface fact can speak to, and `engine/index.js` cross-checks the
 * name against the registry at import. Asserting it belongs to the
 * registry's own test, not to this one.
 *
 * @param {Record<string, {level: string, missing?: string[]}>} declaration
 * @param {{covers: Readonly<Record<string, readonly string[]>>}} coverage
 *        Per capability key, the interface facts that would serve it.
 * @returns {string[]} problems; empty means the declaration matches the
 *           interface.
 */
export function auditExecCapabilities(declaration, coverage) {
  const problems = [];
  for (const key of ENGINE_CAPABILITY_KEYS) {
    const entry = declaration[key];
    if (!entry) continue; // shape problems are validate's job, not this audit's
    const covered = (coverage.covers && coverage.covers[key]) || [];
    if (entry.level === "full" && covered.length === 0) {
      problems.push(`exec.${key}: declared full with no interface fact covering it`);
    }
    if (entry.level === "none" && covered.length > 0) {
      problems.push(
        `exec.${key}: declared none, but the exec interface exposes ${covered.join(", ")} — re-audit`,
      );
    }
  }
  return problems;
}

/**
 * The per-key interface coverage this declaration is audited against.
 * Exported so the test and the audit cannot drift apart: the table below
 * is the audit's input, and naming it here is what makes "the audit was
 * run over the real table" a checkable statement rather than a promise.
 *
 * `EXEC_COVERAGE` is NOT free-form commentary — every entry is a
 * mechanism named in `EXEC_INTERFACE` above:
 *
 *   sessionCrud         `--session`, `--continue`, session.started/resumed
 *   streamingSend       `--input`, `--output-format stream-json`, the events
 *   toolSkillInvocation `tool_call`
 *   mcp                 `--config`
 *   usageStats          `turn.completed.usage`, `exec.completed`
 *
 * and every other key is covered by NOTHING, which is the claim those
 * `none` entries make.
 */
export const EXEC_COVERAGE = Object.freeze({
  covers: Object.freeze({
    sessionCrud: Object.freeze(["--session", "--continue", "session.started", "session.resumed"]),
    streamingSend: Object.freeze(["--input", "--output-format", "exec.started", "turn.completed"]),
    // `tool_call` is the ONLY fact here, and it is deliberately listed on
    // its own: the fact that webui does not consume the item stream
    // belongs in the reason, not in the coverage, because coverage is
    // about what the transport offers.
    toolSkillInvocation: Object.freeze(["tool_call"]),
    // `--config` is listed as the mechanism, not as an mcp method,
    // because there IS no mcp method to name — the same kebab-case
    // sub-capability convention the acp declaration uses for the keys
    // with no method to copy a name from.
    mcp: Object.freeze(["--config"]),
    usageStats: Object.freeze(["turn.completed.usage", "exec.completed"]),
  }),
});
