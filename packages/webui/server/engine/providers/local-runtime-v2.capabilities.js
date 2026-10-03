// webui/server/engine/providers/local-runtime-v2.capabilities.js
//
// Capability declaration for the local-runtime-v2 provider — declaration
// ONLY, no `@mavis/*` imports. This split is deliberate and
// load-bearing: the declaration must be reachable from the boot path
// (the /api/engine-capabilities route) without dragging the v2 host's
// TypeScript dependency tree into it. The host construction
// (`createCatalogueHost`, which does import `@mavis/local-runtime-v2`
// and `@minimax/code/runtime-adapter`) lives in local-runtime-v2.js and
// stays behind the same lazy boundary runtime-host.js always had — see
// acp-client.js's "Lazy import — keeps runtime-host.js out of the boot
// path" note. Loading that tree costs seconds of first-compile; putting
// it on the boot path broke the integration tests' 3 s server-start
// window once and must not happen again.
//
// Every value below is transcribed from the audited capability matrix in
// doc/engine-abstraction-design.md §1.2 (local-runtime-v2 column), with
// per-cell evidence in §1.3, re-verified against the live surfaces at the
// 26043e9b baseline (94 CliService methods + the applications.session.diff
// facade). Do not edit a level without re-auditing the source first; the
// snapshot tests in test/lib/engine/capabilities.test.js pin this object.

import { validateEngineCapabilities } from "../capabilities.js";

/**
 * The 14-key declaration for the local-runtime-v2 provider. The declared
 * surface is the catalogue host as a whole: `cliService` +
 * `applications` (the process-local feature facades) — matching how
 * webui actually consumes the host today.
 */
export const LOCAL_RUNTIME_V2_CAPABILITIES = Object.freeze({
  // createSession / updateSession / archiveSession / deleteSession /
  // forkSession (+ getSessionForkOptions preview) + session-system.
  sessionCrud: { level: "full" },
  // sendMessage / resumeSession / steerSession / watchEvents.
  streamingSend: { level: "full" },
  // abortSession.
  interrupt: { level: "full" },
  // listSkills / listRuntimeSkills + pending-permission interaction.
  // M3-B9: the session-mode WRITE is missing, and is listed as such.
  // v2 has no `setMode` anywhere on the cliService surface — it can
  // read plan state (getPlanModeCapabilities / getLatestPlanReview) and
  // enters plan through the questionnaire mechanism, but nothing sets
  // it (plan §3a row 67). The snapshot audit
  // (test/lib/engine/capability-snapshot.test.js) proves the absence
  // mechanically: it fails the moment a method named `setMode`
  // appears, so this entry cannot rot into an unearned claim.
  toolSkillInvocation: {
    level: "partial",
    missing: ["setMode"],
    reason:
      "no session-mode write on the v2 surface: plan state is read-only here and plan entry goes through the questionnaire mechanism (design §1.3 v2; plan §3a row 67)",
  },
  // service/session-system/diffs + application/session/diff-application
  // (getTurnDiff / revertTurnDiff / reapplyTurnDiff) — already consumed
  // by webui's /api/turn-diff routes.
  turnDiff: { level: "full" },
  // revert/reapply + getSessionRewindPreview / rewindSession +
  // editSessionMessage (message-level edit, backed by v1 forkPrefix).
  turnRewindRedo: { level: "full" },
  // The most complete plugin surface: ten CliService methods
  // (refresh/marketplace/installed/enabled/install/enable/disable/
  // uninstall/previewGithub/importGithub) + service/plugin-system.
  plugins: { level: "full" },
  // configureSessionMcpServers / inspectProjectMcp /
  // clearSessionMcpServers / listMcpServers + service/mcp.
  mcp: { level: "full" },
  // listBackgroundTasks is on the CliService surface, but the delegation
  // snapshot/stop pair lives on the TuiRuntimeAdapter access-context,
  // not on the CliService itself (verified: neither method on the
  // 94-method surface) — they stay reachable through the adapter the
  // host constructs.
  subagents: {
    level: "partial",
    missing: ["getDelegationSnapshot", "stopDelegation"],
    reason:
      "delegation snapshot/stop live on the TuiRuntimeAdapter access-context, not on the v2 CliService surface (design §1.3 v2)",
  },
  // getSessionUsage / getSessionUsageSummary / watchSessionUsageCommits
  // + service/session-system/usage.
  usageStats: { level: "full" },
  // getAccountStatus + Codex OAuth flow + MiniMax key + full user model
  // provider CRUD/test/discover, same source as service/model-system.
  // M3-B9: the GENERIC config-option write is missing, and is listed as
  // such. v2 has no general `setConfigOption`; the plan (§3a, row 68)
  // records dedicated equivalents only ("只有 selectModel/
  // setPermissionMode 专用"), which is why the `model` and
  // `permissionMode` config ids bridge AROUND this entry in
  // `engine/mode-writes.js` and every other config id is refused. The
  // snapshot audit proves the absence mechanically. KNOWN DEBT 2 in
  // that module records that the two bridged names are themselves not
  // yet on an audited host.
  authCredentials: {
    level: "partial",
    missing: ["setConfigOption"],
    reason:
      "no generic config-option write on the v2 surface; only the dedicated model and permission-mode writers exist (design §1.3 v2; plan §3a row 68)",
  },
  // grep of the whole package finds no update-check surface; update
  // checking exists only in the TUI app layer and the CLI command.
  updateCheck: {
    level: "none",
    reason:
      "interface-absent: no update-check method anywhere in local-runtime-v2 (design §1.3 v2)",
  },
  // listWorkspaceFileTree / searchWorkspaceFiles are read-only; writes go
  // through in-turn tools. "file-write" names the absent sub-capability
  // (no method exists to name).
  fileReadWrite: {
    level: "partial",
    missing: ["file-write"],
    reason:
      "workspace read browsing only; no write API — writes go through in-turn tools (design §1.3 v2)",
  },
  // getWorkspaceGitMetadata / getWorkspaceReviewLink are read-only;
  // change mutation is deliberately outside this package (same
  // discipline as v1's read-only Git facade).
  gitOperations: {
    level: "partial",
    missing: ["git-diff", "git-commit", "git-branch"],
    reason:
      "read-only metadata + review link; change mutation is outside this package (design §1.3 v2)",
  },
});

if (validateEngineCapabilities(LOCAL_RUNTIME_V2_CAPABILITIES).length > 0) {
  throw new Error(
    "LOCAL_RUNTIME_V2_CAPABILITIES is not a valid EngineCapabilities declaration",
  );
}
