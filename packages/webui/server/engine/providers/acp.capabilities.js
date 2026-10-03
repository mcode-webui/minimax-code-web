// webui/server/engine/providers/acp.capabilities.js
//
// Capability declaration for the `acp` provider — the `mcode acp`
// subprocess protocol, client `webui/acp.mjs` (`McodeAcpClient`),
// server `packages/tui/src/acp/`. Declaration ONLY, like its two
// siblings: no `@mavis/*` import, no protocol client construction, so
// `/api/engine-capabilities` can answer `?provider=acp` from the boot
// path without booting anything. That split is the same one
// local-runtime-v2.capabilities.js exists for (see its header).
//
// What changed in M4-1. Before this file the registry carried two
// entries, both on transport "runtime", and NOTHING described the
// default transport webui has always run on. That absence was
// structural, not an oversight: every consumer resolved its provider
// through a transport→provider table that mapped only `runtime`, so an
// `acp` entry would have been unreachable and the declaration would
// have been documentation. M4-1 registers it as the FIRST transport
// provider — the declaration is now queryable and auditable — while
// every one of those tables stays exactly as it was. Reading the
// transport→provider table instead of the registry is M4-3's change,
// not this batch's, and `test/lib/engine/capabilities.test.js` pins the
// gap so it cannot close by accident.
//
// Evidence base. Levels are transcribed from the audited matrix in
// doc/engine-abstraction-design.md §1.2 (acp column) with per-cell
// evidence in §1.3, and every `partial` was re-derived at the 49f5b9f4
// baseline against the protocol's actual wire surface — the flat
// `MCODE_ACP_CAPABILITIES` table in `lib/mcode-rpc.js`, the request
// calls in `acp.mjs`, and the handlers registered in
// `packages/tui/src/acp/agent.ts` +
// `packages/tui/src/acp/extensions.ts`. The snapshot suite
// (test/lib/engine/capability-snapshot.test.js) checks the claim
// against `MCODE_ACP_CAPABILITIES` rather than against this comment.
//
// ---------------------------------------------------------------------------
// THE ONE EXCEPTION: `turnDiff` and `plugins` carry `servedBy`.
// ---------------------------------------------------------------------------
//
// This is the single REVERSE exception the M3 plan records
// (doc/m3-batch-plan.md §6, "唯一反向例外"). Both keys are honestly
// `none` here — the protocol has no diff method and no plugin method
// at all, which `routes/plugins.js:27` states in its own words
// ("ACP has no plugin method at all"). But the
// thirteen webui endpoints behind them WORK on the default acp
// transport, and have since before M3: they boot the in-process
// local-runtime-v2 catalogue host through the engine facade
// (`getEngineCatalogueHost()`, M3-B0) and are not gated on any
// provider declaration. `routes/plugins.js` says so in its header, and
// `routes/turn-diff.js` says the same.
//
// So the level answers "what can the acp PROTOCOL do" and `servedBy`
// answers "who actually answers the request" — two different
// questions, which is why they are two fields and not one level. If
// `level` alone carried the truth, the capability-driven UI (design
// §4.2: `none` → hide the entry point) would delete two working
// features the first time a frontend started reading the transport's
// provider instead of the default one.
//
// The field is deliberately NOT allowed on `full` or `partial`
// (`validateEngineCapabilities` rejects it there): a provider that
// partially implements a capability is not "served elsewhere", and
// letting the word appear on those keys would make it mean two things.
// It is also cross-checked against the registry at import — a
// `servedBy` naming a provider that is not registered is a boot-time
// error, not a runtime 404 (see engine/index.js).
//
// What is NOT here, on purpose:
//
//   - `interrupt` is `none`, and the reason names the notification
//     that exists: `session/cancel` IS registered
//     (packages/tui/src/acp/agent.ts, `app.onNotification(acp.methods
//     .agent.session.cancel)`), and it does abort the active prompt's
//     AbortController. It is still not an interrupt SURFACE a
//     capability can be declared over, for the reason
//     `engine/interrupt.js` records as fact 1: a notification carries
//     no reply, so "cancelled" certifies that a cancel was SENT and not
//     that the turn stopped. A `full` here would license a caller to
//     skip the kill cascade that webui's own child management owns.
//   - No `unimplemented` sub-item is listed for `thinkingEffort`. The
//     M3-B14 bridge names `setThinkingEffort` and no surface
//     implements it, but B14 established the rule that NO declaration
//     lists it as missing — doing so would remove the control for
//     every user today. The acp row joins the other two in the
//     snapshot's `unimplemented` slot instead, which asserts the
//     absence without changing what a gate refuses.

import { validateEngineCapabilities } from "../capabilities.js";

/**
 * The 14-key declaration for the acp transport provider. Levels:
 * full | partial | none — see capabilities.js for the contract, and
 * the header above for what `servedBy` means and why only two keys
 * carry it.
 */
export const ACP_CAPABILITIES = Object.freeze({
  // Present: session/new, session/load, session/list, session/close,
  // plus session/resume, session/fork and session/activate. Absent:
  // the whole destructive family. `session/delete` is REGISTERED by
  // the protocol with no handler — `MCODE_ACP_CAPABILITIES.delete` is
  // literally `false` in lib/mcode-rpc.js for that reason, with the
  // comment "mcode's protocol registers `session/delete` but
  // implements no handler, which is why deletes go through SQL on the
  // local_runtime_* tables". So the sub-items are named after the
  // methods the v2 surface has and the protocol has not, which is what
  // a gate passes as `subItem`; the v2 delete path is webui's own
  // 32-table SQL, not a capability anyone could declare.
  sessionCrud: {
    level: "partial",
    missing: ["deleteSession", "renameSession", "archiveSession"],
    reason:
      "the protocol opens new/load/list/close/resume/fork/activate and nothing else: `session/delete` is registered with no handler (MCODE_ACP_CAPABILITIES.delete === false) and there is no rename or archive method (design §1.3 acp)",
  },
  // session/prompt — a streaming callback per turn, the transport
  // webui's default chat path has always run on.
  streamingSend: { level: "full" },
  // interface-absent, with the notification named so a reader does not
  // have to rediscover it: see the header's first bullet.
  interrupt: {
    level: "none",
    reason:
      "interface-absent: the protocol has no reply-shaped interrupt. `session/cancel` IS registered (packages/tui/src/acp/agent.ts) and aborts the active prompt, but it is a NOTIFICATION — a delivered cancel certifies that it was SENT, never that the turn stopped, which is exactly why engine/interrupt.js keeps webui's own kill cascade (design §1.3 acp; engine/interrupt.js fact 1)",
  },
  // Present: tool events over the sessionUpdate stream (what
  // `lib/agent-team-detect.js` parses) and the permission
  // request/reply pair. Absent: skill enumeration — the protocol has
  // no method for it, and webui calls none. The session-mode write is
  // NOT missing here, unlike on both runtime surfaces: the protocol
  // registers `session/set_mode` as a real request (agent.ts:924).
  toolSkillInvocation: {
    level: "partial",
    missing: ["listSkills", "listRuntimeSkills"],
    reason:
      "tool events and the permission request/reply pair cross the sessionUpdate stream, but the protocol has no skill-enumeration method at all and webui calls none (design §1.3 acp)",
  },
  // none, AND served in process — the plan's reverse exception. See
  // the header.
  turnDiff: {
    level: "none",
    reason:
      "interface-absent: the protocol method list has no diff method of any kind (design §1.3 acp). The three /api/turn-diff endpoints are NOT degraded — they are a projection over `applications.session.diff` on the in-process local-runtime-v2 host, reached through getEngineCatalogueHost() since M3-B0, and routes/turn-diff.js gates on no provider declaration",
    servedBy: "local-runtime-v2",
  },
  // No diff, no rewind, no redo: the protocol has none of the three,
  // and unlike turnDiff nothing in webui serves it from elsewhere.
  turnRewindRedo: {
    level: "none",
    reason:
      "interface-absent: no rewind, redo or message-edit method in the protocol method list; the capability lives in local-runtime v1/v2 and webui exposes no route for it (design §1.3 acp)",
  },
  // The second half of the reverse exception. The protocol has no
  // plugin method at all — routes/plugins.js:27 says so verbatim —
  // and the ten /api/plugins endpoints still work, because they too
  // project the in-process v2 host's cliService.
  plugins: {
    level: "none",
    reason:
      "interface-absent: 'ACP has no plugin method at all' (routes/plugins.js:27). The ten /api/plugins endpoints are NOT degraded — they project the in-process local-runtime-v2 cliService through getEngineCatalogueHost(), and routes/plugins.js boots the host unconditionally on purpose",
    servedBy: "local-runtime-v2",
  },
  // MCP servers load inside a turn, and that is all: the protocol
  // registers no configuration or inspection method, so all four
  // sub-capabilities are missing. The sub-items are kebab-case here
  // rather than method-named for the same reason the v2 declaration
  // uses "file-write": they name SUB-CAPABILITIES, and there is no
  // method anywhere to copy a name from.
  mcp: {
    level: "partial",
    missing: ["mcp-configure", "mcp-inspect", "mcp-clear", "mcp-list"],
    reason:
      "session-scoped MCP servers take effect inside a turn, but the protocol exposes no configure/inspect/clear/list method and webui calls none (design §1.3 acp)",
  },
  // Sub-agent work is visible only as events on the sessionUpdate
  // stream (lib/agent-team-detect.js parses them); there is no
  // snapshot call and no stop call.
  subagents: {
    level: "partial",
    missing: ["getDelegationSnapshot", "stopDelegation", "listBackgroundTasks"],
    reason:
      "sub-agent activity is parsed off the event stream only; the protocol has no delegation snapshot, no delegation stop and no background-task enumeration (design §1.3 acp)",
  },
  // Present: the plan-quota projection, which the engine owns the
  // credential for and answers over the `mcode/account/status`
  // extension (routes/usage.js:6-8). Absent: every per-session usage
  // method, which is why the token detail still comes from the
  // runtime DB instead — the dual source §7 records as debt, now with
  // a declared cause.
  usageStats: {
    level: "partial",
    missing: ["getSessionUsage", "getSessionUsageSummary", "watchSessionUsageCommits"],
    reason:
      "plan quota is queryable over the `mcode/account/status` extension, but no per-session usage projection exists in the protocol; the token detail webui shows next to it is read from the runtime DB, not from the engine (design §1.3 acp; plan §7 dual-source row)",
  },
  // Present: getAccountStatus (the `mcode/account/status` extension)
  // and the config-option write, which agent.ts:956 dispatches for
  // exactly two config ids — `permissionMode` and `model` — so the two
  // bridged writers of `MODE_WRITE_BRIDGED_CONFIG_IDS` really are
  // reachable here. Absent: the whole OAuth flow, the API-key surface
  // and the user model-provider CRUD, none of which the protocol
  // registers. `setThinkingEffort` is deliberately absent from this
  // list; see the header.
  authCredentials: {
    level: "partial",
    missing: [
      "getCodexOAuthStatus",
      "startCodexOAuthLogin",
      "cancelCodexOAuthLogin",
      "getMiniMaxApiKeyStatus",
      "upsertMiniMaxApiKey",
      "listUserModelProviders",
      "createUserModelProvider",
      "updateUserModelProvider",
      "deleteUserModelProvider",
      "testUserModelProvider",
      "discoverUserModelsCandidate",
    ],
    reason:
      "account status crosses the `mcode/account/status` extension and `session/set_config_option` dispatches the model and permissionMode config ids (packages/tui/src/acp/agent.ts:956), but the protocol registers no OAuth flow, no API-key surface and no user model-provider CRUD (design §1.3 acp)",
  },
  // interface-absent: `available_commands_update` refreshes the
  // command catalogue, which is not an update check — the design doc
  // records the same distinction for the acp column.
  updateCheck: {
    level: "none",
    reason:
      "interface-absent: no update method in the protocol; `available_commands_update` only refreshes the advertised command catalogue (design §1.3 acp; server/lib/acp-client.js:288)",
  },
  // interface-absent: webui's /api/fs endpoints are its own node:fs
  // implementation and never consulted an engine surface.
  fileReadWrite: {
    level: "none",
    reason:
      "interface-absent: no workspace file method in the protocol; webui's /api/fs family is its own node:fs implementation (design §1.3 acp; server/lib/git.js:1 on the same boundary)",
  },
  // interface-absent: same boundary as fileReadWrite, for the same
  // reason — `routes/git.js` wraps the OS git binary and no engine.
  gitOperations: {
    level: "none",
    reason:
      "interface-absent: no git method in the protocol; webui's /api/git family wraps the OS git binary (design §1.3 acp; server/lib/git.js:1)",
  },
});

if (validateEngineCapabilities(ACP_CAPABILITIES).length > 0) {
  throw new Error("ACP_CAPABILITIES is not a valid EngineCapabilities declaration");
}
