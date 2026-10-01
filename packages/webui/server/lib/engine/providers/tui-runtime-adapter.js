// webui/server/lib/engine/providers/tui-runtime-adapter.js
//
// Capability declaration for the TuiRuntimeAdapter engine surface
// (`@minimax/code/runtime-adapter`, source: packages/tui/src/runtime/adapter.ts).
//
// The adapter is constructed inside the local-runtime-v2 catalogue host
// (see local-runtime-v2.js#createCatalogueHost) and consumed directly by
// webui for catalogue/turn traffic — it is one of the two engine sources
// webui is currently hard-wired to, so it carries its own declaration.
//
// Every value below is transcribed from the audited capability matrix in
// doc/engine-abstraction-design.md §1.2 (tui column) with per-cell
// evidence in §1.3, and re-verified against the live method surface
// (91 methods, reflected at the 26043e9b baseline). Do not edit a level
// without re-auditing the adapter source first; the snapshot tests in
// test/lib/engine/capabilities.test.js pin this object.

import { validateEngineCapabilities } from "../capabilities.js";

/**
 * The 14-key declaration for the TuiRuntimeAdapter surface.
 * Levels: full | partial | none — see capabilities.js for the contract.
 */
export const TUI_RUNTIME_ADAPTER_CAPABILITIES = Object.freeze({
  // createSession / listSessions / getSession / renameSession /
  // archiveSession / deleteSession / forkSession — the full set.
  sessionCrud: { level: "full" },
  // sendMessage (AsyncGenerator) + watchSessionTurn + watchEvents.
  streamingSend: { level: "full" },
  // abortSession (protocol-level) + steer.
  interrupt: { level: "full" },
  // listSkills + permission interaction (listPendingPermissions /
  // replyPermission); tool execution events flow over sendMessage.
  toolSkillInvocation: { level: "full" },
  // No getTurnDiff anywhere on the adapter's 91-method surface — the
  // capability itself lives in local-runtime v1/v2 and webui's turn-diff
  // routes bypass the adapter for exactly this reason (§1.3 tui).
  turnDiff: {
    level: "none",
    reason:
      "implementation-absent: TuiRuntimeAdapter exposes no turn-diff method; the capability lives behind local-runtime-v2 applications.session.diff (design §1.3 tui)",
  },
  // rewindSession exists (undo); redo does not — v1's
  // mutateTurnDiff(action:'reapply') is not exposed on the adapter.
  turnRewindRedo: {
    level: "partial",
    missing: ["reapplyTurnDiff"],
    reason:
      "rewindSession is exposed; reapply (redo) is not opened on the adapter surface (design §1.3 tui)",
  },
  // Only four coarse methods: listInstalledPlugins / listMarketplacePlugins
  // / mutatePlugin / refreshPlugins. webui's plugin routes therefore go
  // through the bare cliService instead (runtime-host.js comment).
  plugins: {
    level: "partial",
    missing: ["previewGithubPlugin", "importGithubPlugin", "listEnabledPlugins"],
    reason:
      "adapter exposes only 4 read/coarse plugin methods; preview/import/listEnabled are not on this surface (design §1.3 tui)",
  },
  // configureSessionMcpServers / clearSessionMcpServers / inspectProjectMcp
  // / listMcpServers — configure + query + per-session effect.
  mcp: { level: "full" },
  // getDelegationSnapshot / stopDelegation / listBackgroundTasks — the
  // most complete of the five surfaces.
  subagents: { level: "full" },
  // getSessionUsage / getSessionUsageSummary / watchSessionUsageCommits.
  usageStats: { level: "full" },
  // getAccountStatus + OAuth + API key + user model provider CRUD.
  authCredentials: { level: "full" },
  // No update method on the adapter surface at all; update checking lives
  // in the TUI application layer (packages/tui/src/update/) and the CLI
  // `mcode update` command.
  updateCheck: {
    level: "none",
    reason:
      "implementation-absent: no update method on the adapter surface; update lives in the TUI app layer and CLI (design §1.3 tui)",
  },
  // Read browsing exists (listWorkspaceFileTree / searchWorkspaceFiles);
  // file writes go through in-turn tools, never through this API surface.
  // "file-write" names the absent sub-capability (no method exists to name).
  fileReadWrite: {
    level: "partial",
    missing: ["file-write"],
    reason:
      "workspace read browsing only; file writes go through in-turn tools, not this API surface (design §1.3 tui)",
  },
  // getWorkspaceGitMetadata is read-only; no diff/commit/branch change
  // methods (design §1.3 tui wording).
  gitOperations: {
    level: "partial",
    missing: ["git-diff", "git-commit", "git-branch"],
    reason:
      "read-only metadata (getWorkspaceGitMetadata); no diff/commit/branch change methods (design §1.3 tui)",
  },
});

// Fail fast at import time if the declaration drifts from the contract
// (missing keys, partial without missing, …). The test suite pins the
// levels themselves; this pins the shape.
if (validateEngineCapabilities(TUI_RUNTIME_ADAPTER_CAPABILITIES).length > 0) {
  throw new Error(
    "TUI_RUNTIME_ADAPTER_CAPABILITIES is not a valid EngineCapabilities declaration",
  );
}
