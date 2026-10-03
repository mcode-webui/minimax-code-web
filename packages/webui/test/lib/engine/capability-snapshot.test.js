// webui/test/lib/engine/capability-snapshot.test.js
//
// M2 — capability-declaration snapshot audit against the REAL host
// (design doc §2.4, migration step M2; doc/engine-abstraction-design.md).
//
// M1 (test/lib/engine/capabilities.test.js) pins every declared LEVEL
// against the audited matrix. That alone cannot catch the more dangerous
// drift: the declaration saying "full"/"partial" while the live object no
// longer carries the promised methods (or has grown the ones `missing`
// denies). This file closes that gap by booting ONE real catalogue host
// against an isolated tmp data dir and auditing every full/partial key
// against the reflected method surfaces:
//
//   full    → every REQUIRED_METHODS entry must be typeof "function" on
//             the declared surface member;
//   partial → methods of the key that ARE named in `missing` must be
//             absent; the ones NOT named must be present; kebab-case
//             `missing` items (sub-capability names such as "file-write")
//             must have NO method on the surface whose name contains all
//             their segments (a future getWorkspaceGitDiff would make the
//             "git-diff" entry go red until the declaration is re-audited);
//   none    → not method-checked (a provider may legitimately expose no
//             surface for the capability).
//
//   PLUS, INDEPENDENT OF THE LEVEL ABOOVE:
//
//   unimplemented → a method-named sub-item that a bridge in
//             `MODE_WRITE_BRIDGED_CONFIG_IDS` points at and that NO
//             surface implements. The audit asserts it is ABSENT and
//             goes red the moment a surface grows one. This is the
//             honesty slot, added in M3-B14, and it is the reason the
//             third bridge is not an unchecked exemption: without it a
//             gate that asks for a method nobody implements would be
//             indistinguishable, in this file, from a gate that asks
//             for a method both surfaces really carry.
//
// The audit function is a PURE function over (declaration, method-name
// sets), so the mutation checks below feed it hand-built mutant surfaces
// and assert it reports the drift — the "flip a level / delete a method
// must go red" requirement is thereby pinned as a test of the checker
// itself, not just performed once by hand.
//
// Isolation: the host boots against a per-run tmp dir via mkTmpDir and
// MINIMAX_DATA_DIR / MCODE_WEBUI_* are pinned BEFORE the dynamic import
// of the engine provider (node:test runs each file in its own process;
// setting only MCODE_WEBUI_DATA_DIR is NOT enough — the engine dir would
// fall back to ~/.minimax and rewrite the user's real config).

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";

import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";

// Set BEFORE any dynamic import of config-reading / host modules below.
const tmpBase = mkTmpDir("mcode-webui-engine-snapshot-");
process.env.MINIMAX_DATA_DIR = tmpBase;
process.env.MCODE_WEBUI_DATA_DIR = tmpBase;
process.env.MCODE_WEBUI_SETTINGS_PATH = `${tmpBase}/settings.json`;
process.env.MCODE_WEBUI_EVENTS_PATH = `${tmpBase}/events.jsonl`;
process.env.MCODE_WEBUI_SESSIONS_DB = `${tmpBase}/sessions.db`;
process.env.MCODE_WEBUI_UPLOAD_DIR = `${tmpBase}/uploads`;

// Declaration modules are import-light (no @mavis/* tree), and the env
// above is already pinned, so loading them at top level is safe here.
const {
  ACP_CAPABILITIES,
  ENGINE_CAPABILITY_KEYS,
  LOCAL_RUNTIME_V2_CAPABILITIES,
  MODE_WRITE_BRIDGED_CONFIG_IDS,
  TUI_RUNTIME_ADAPTER_CAPABILITIES,
  getEngineProvider,
  listEngineProviderIds,
  validateEngineCapabilities,
} = await import("../../../server/engine/index.js");

// The acp wire surface, checked in as the flat method→boolean table
// `server/lib/mcode-rpc.js` exports for the frontend's own capability
// detection. It is the closest thing the acp protocol has to a
// reflectable surface: the protocol is a subprocess, so there is no
// object to walk a prototype chain over, and the audit below runs
// against this table instead. Unlike a hand-typed list it is LIVE — it
// is the same constant the routes read — so a protocol method that
// appears here without a re-audit turns the audit red rather than
// leaving the declaration quietly out of date.
const { MCODE_ACP_CAPABILITIES } = await import("../../../server/lib/mcode-rpc.js");

// ---------------------------------------------------------------------------
// ACP_WIRE — the acp protocol's declared surface, in wire-method terms
// ---------------------------------------------------------------------------
//
// M4-1 gave the acp transport a declaration. Two runtime providers are
// audited by REFLECTING a real host object; the acp protocol cannot be,
// because it is a subprocess behind a stdio JSON-line wire. So this
// table states, per capability key, what the wire offers:
//
//   present      — wire methods that exist, so the key can be full or
//                 partial with this much covered;
//   absent       — wire methods that are registered but unavailable
//                 (`MCODE_ACP_CAPABILITIES.<name> === false`), which is
//                 what makes a `partial` honest rather than pessimistic;
//   notification — wire methods that exist but are NOTIFICATIONS. This
//                 third bucket is the one that matters: `cancel` is
//                 `true` on the wire and the declaration is still
//                 `none`, because a notification carries no reply and
//                 therefore cannot certify that a turn stopped (see
//                 server/engine/interrupt.js fact 1). A declaration
//                 that read the wire table alone would call it `full`.
//
// For the `none` keys the check runs the other way: NONE_CAPABILITY_NAME
// FRAGMENTS lists, per key, the substrings a wire method would have to
// contain to serve it. A protocol that grew `session/diff` would make
// the turnDiff entry go red until someone re-audited the declaration —
// the same tripwire `subCapabilityHasMethods` provides for the runtime
// surfaces' kebab-case sub-items.

const ACP_WIRE = {
  sessionCrud: {
    present: ["new", "load", "list", "close", "fork", "resume", "activate"],
    absent: ["delete"],
  },
  streamingSend: { present: ["prompt"] },
  interrupt: { notification: ["cancel"] },
  // `session/set_mode` is a real request here (packages/tui/src/acp/
  // agent.ts:924), which neither runtime surface has — the acp column
  // is genuinely STRONGER on this key than the v2 one.
  toolSkillInvocation: { present: ["set_mode"] },
  authCredentials: { present: ["set_config_option"] },
};

/** For each `none` key: substrings any wire method would need to match. */
const NONE_CAPABILITY_NAME_FRAGMENTS = {
  turnDiff: ["diff"],
  turnRewindRedo: ["rewind", "redo", "revert", "reapply"],
  plugins: ["plugin"],
  mcp: ["mcp"],
  subagents: ["delegation", "background_task"],
  usageStats: ["usage"],
  updateCheck: ["update", "upgrade"],
  fileReadWrite: ["file", "workspace"],
  gitOperations: ["git"],
};

/**
 * The config ids `session/set_config_option` actually dispatches
 * (packages/tui/src/acp/agent.ts:956 branches on exactly these two;
 * the engine names them ACP_CONFIG_MODEL / ACP_CONFIG_PERMISSION_MODE
 * in packages/tui/src/acp/control-state.ts:14-15). This is what makes
 * the declaration's claim that the two bridged writers of
 * MODE_WRITE_BRIDGED_CONFIG_IDS are reachable over acp checkable, and
 * what pins the third bridge in the `unimplemented` slot.
 */
const ACP_CONFIG_OPTION_IDS = ["model", "permissionMode"];

/**
 * Audit the acp declaration against the protocol's wire table.
 *
 * @param {Record<string, {level: string, missing?: string[]}>} declaration
 * @param {Record<string, boolean>} wireTable  The flat method→boolean table.
 * @param {string[]} configIds  Config ids set_config_option dispatches.
 * @returns {string[]} problems; empty means the declaration matches the wire.
 */
export function auditAcpCapabilities(declaration, wireTable, configIds) {
  const problems = [];
  for (const [key, wire] of Object.entries(ACP_WIRE)) {
    const entry = declaration[key];
    if (!entry) continue; // shape problems are validate's job, not this audit's
    for (const method of wire.present || []) {
      if (wireTable[method] !== true) {
        problems.push(
          `acp.${key}: declared as covered by wire method "${method}", but MCODE_ACP_CAPABILITIES.${method} is not true`,
        );
      }
    }
    for (const method of wire.absent || []) {
      if (wireTable[method] !== false) {
        problems.push(
          `acp.${key}: declared as denied by wire method "${method}", but MCODE_ACP_CAPABILITIES.${method} is now ${wireTable[method]} — re-audit the declaration`,
        );
      }
    }
    // A notification-only method must NOT be what makes the key
    // servable. `interrupt` is the live case: `cancel` is `true` on
    // the wire, and the declaration is `none` precisely because a
    // notification cannot answer. Declaring it `full` would be the
    // flattering claim this audit exists to refuse.
    for (const method of wire.notification || []) {
      if (wireTable[method] !== true) {
        problems.push(
          `acp.${key}: the notification-only wire method "${method}" is no longer on the wire — re-audit whether this key is still none`,
        );
      }
      if (entry.level === "full") {
        problems.push(
          `acp.${key}: declared full, but "${method}" is a NOTIFICATION — a delivered cancel certifies that it was sent, never that the turn stopped`,
        );
      }
      if (entry.level === "none" && !entry.reason.includes(method)) {
        problems.push(
          `acp.${key}: declared none because "${method}" cannot answer, but the reason does not name it — the reader would have to rediscover the notification`,
        );
      }
    }
  }

  // A `full` key must be covered by at least one real (non-notification)
  // wire method, or `full` is a claim with nothing under it.
  for (const key of ENGINE_CAPABILITY_KEYS) {
    const entry = declaration[key];
    if (!entry || entry.level !== "full") continue;
    const wire = ACP_WIRE[key];
    if (!wire || !(wire.present || []).length) {
      problems.push(`acp.${key}: declared full with no covering wire method in ACP_WIRE`);
    }
  }

  // A `none` key must have NO wire method whose name could serve it.
  for (const [key, fragments] of Object.entries(NONE_CAPABILITY_NAME_FRAGMENTS)) {
    const entry = declaration[key];
    if (!entry || entry.level !== "none") continue;
    const matched = Object.keys(wireTable).filter((name) =>
      fragments.some((fragment) => name.toLowerCase().includes(fragment)),
    );
    if (matched.length > 0) {
      problems.push(
        `acp.${key}: declared none, but the protocol now exposes wire method(s) ${matched.join(", ")} — re-audit`,
      );
    }
  }

  // The bridged config ids must be the ones the protocol dispatches,
  // and the effort writer must be among the ids it does NOT. Compared
  // by METHOD name — `MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort` is
  // the writer, not the config id. Comparing the ids would make the
  // check vacuously false, and MUT-G would then pass for the wrong
  // reason, which is worse than having no check.
  for (const [configId, method] of Object.entries(MODE_WRITE_BRIDGED_CONFIG_IDS)) {
    const isEffortWriter = method === MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort;
    if (configIds.includes(configId) && isEffortWriter) {
      problems.push(
        `acp: ${method} is a bridged forward contract the declaration has no method for, but session/set_config_option NOW dispatches the "${configId}" config id — re-audit the bridge and let the control come back`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// REQUIRED_METHODS — what each capability key means ON THE OBJECTS.
// ---------------------------------------------------------------------------
//
// Provenance (how this table was derived, per ticket 104): a one-off
// audit script booted the real catalogue host exactly like this file
// does, walked the prototype chains of host.adapter / host.cliService /
// host.applications.session.diff with getOwnPropertyNames, and dumped
// the full method sets — 91 adapter methods, 94 CliService methods, and
// the session.diff facade (getSessionDiff/getTurnDiff/revertTurnDiff/
// reapplyTurnDiff + the internal requireTarget). The lists below name
// exactly the methods each declaration's own evidence comments cite
// (server/engine/providers/*.js), each re-verified present/absent on
// those dumped sets. `on` is the host member the method must live on:
// the tui-runtime-adapter provider declares the adapter surface; the
// local-runtime-v2 provider declares cliService + applications.

/** Which host member each provider's surface lives on. */
const SURFACE_MEMBERS = {
  "tui-runtime-adapter": ["adapter"],
  "local-runtime-v2": ["cliService", "applications.session.diff"],
};

function resolveMember(host, dottedPath) {
  return dottedPath.split(".").reduce((obj, key) => (obj == null ? obj : obj[key]), host);
}

/**
 * REQUIRED_METHODS[providerId][capabilityKey] pins what the capability
 * key MEANS on that provider's surface:
 *   - `on`: the host member the key's methods live on;
 *   - `methods`: methods that MUST exist when the key is full (and, for
 *     a partial, the parts that are present);
 *   - `absent`: method-NAMED sub-items the partial declarations list in
 *     `missing` — methods of this capability's domain that genuinely do
 *     not exist on this surface (reapplyTurnDiff on the adapter,
 *     getDelegationSnapshot on the bare CliService, and — since M3-B9 —
 *     setMode and setConfigOption on BOTH surfaces, which is what makes
 *     the mode-write family's hard gate an audited fact rather than a
 *     claim). They are part of the snapshot so "missing must really be
 *     absent" is checked, and a partial that stops listing one goes red
 *     (under-declaration);
 *   - `unimplemented`: method-NAMED sub-items a bridge in
 *     `MODE_WRITE_BRIDGED_CONFIG_IDS` points at that NO surface has yet.
 *     Unlike `absent`, these are deliberately NOT in any declaration's
 *     `missing` list — the bridge exempts them from the generic write,
 *     and a provider does not deny a sub-item it simply does not have.
 *     The audit asserts they are absent anyway, because the failure this
 *     catches is silence: a surface quietly growing the method while the
 *     gate and the declaration still treat it as a forward contract.
 *
 * M3-B10 added `selectModel` and `setPermissionMode` to `authCredentials`
 * on BOTH surfaces. They are two of the three sub-items
 * `MODE_WRITE_BRIDGED_CONFIG_IDS` (server/engine/mode-writes.js) names,
 * and until that batch they were the one part of a hard gate that no
 * audit could check: `absent` proves a name is NOT on the surface, and a
 * name that is merely "not in `missing`" proves nothing. Both were
 * verified present by reflection on a booted host BEFORE being added
 * here, and the live audit below keeps proving it, which closes the
 * bridge question B9 recorded as its KNOWN DEBT 2.
 *
 * M3-B14 added the THIRD id, `thinkingEffort` —> `setThinkingEffort`, and
 * it is the one this table cannot express with the existing two lists.
 * The method does not exist on either surface, so putting it in
 * `methods` would be a lie the audit reports as drift on every run, and
 * putting it in `absent` would be a second lie: `absent` means "this
 * partial declares it missing", and no provider does. So it goes in
 * `unimplemented`, which asserts exactly one thing — THIS SURFACE MUST
 * NOT HAVE IT — and which turns red the moment either surface grows a
 * `setThinkingEffort`. That is the whole closure mechanism for the third
 * bridge, and it is deliberately one-directional: a surface acquiring the
 * dedicated writer is an engine-side event nobody here can schedule, and
 * the audit is what makes it impossible to miss.
 */
const REQUIRED_METHODS = {
  "tui-runtime-adapter": {
    sessionCrud: { on: "adapter", methods: ["createSession", "listSessions", "getSession", "renameSession", "archiveSession", "deleteSession", "forkSession"] },
    streamingSend: { on: "adapter", methods: ["sendMessage", "watchSessionTurn", "watchEvents"] },
    interrupt: { on: "adapter", methods: ["abortSession", "steer"] },
    toolSkillInvocation: { on: "adapter", methods: ["listSkills", "listPendingPermissions", "replyPermission"], absent: ["setMode"] },
    turnRewindRedo: { on: "adapter", methods: ["rewindSession", "getSessionRewindPreview"], absent: ["reapplyTurnDiff"] },
    plugins: { on: "adapter", methods: ["listInstalledPlugins", "listMarketplacePlugins", "mutatePlugin", "refreshPlugins"], absent: ["previewGithubPlugin", "importGithubPlugin", "listEnabledPlugins"] },
    mcp: { on: "adapter", methods: ["configureSessionMcpServers", "clearSessionMcpServers", "inspectProjectMcp", "listMcpServers"] },
    subagents: { on: "adapter", methods: ["getDelegationSnapshot", "stopDelegation", "listBackgroundTasks"] },
    usageStats: { on: "adapter", methods: ["getSessionUsage", "getSessionUsageSummary", "watchSessionUsageCommits"] },
    authCredentials: { on: "adapter", methods: ["getAccountStatus", "getCodexOAuthStatus", "startCodexOAuthLogin", "cancelCodexOAuthLogin", "getMiniMaxApiKeyStatus", "upsertMiniMaxApiKey", "selectModel", "setPermissionMode", "listUserModelProviders", "createUserModelProvider", "updateUserModelProvider", "deleteUserModelProvider", "testUserModelProvider", "discoverUserModelsCandidate"], absent: ["setConfigOption"], unimplemented: ["setThinkingEffort"] },
    fileReadWrite: { on: "adapter", methods: ["listWorkspaceFileTree", "searchWorkspaceFiles"] },
    gitOperations: { on: "adapter", methods: ["getWorkspaceGitMetadata"] },
  },
  "local-runtime-v2": {
    sessionCrud: { on: "cliService", methods: ["createSession", "updateSession", "archiveSession", "deleteSession", "forkSession", "getSessionForkOptions"] },
    streamingSend: { on: "cliService", methods: ["sendMessage", "resumeSession", "steerSession", "watchEvents"] },
    interrupt: { on: "cliService", methods: ["abortSession"] },
    toolSkillInvocation: { on: "cliService", methods: ["listSkills", "listRuntimeSkills", "listPendingPermissions", "replyPermission"], absent: ["setMode"] },
    turnDiff: { on: "applications.session.diff", methods: ["getSessionDiff", "getTurnDiff", "revertTurnDiff", "reapplyTurnDiff"] },
    turnRewindRedo: { on: "cliService", methods: ["getSessionRewindPreview", "rewindSession", "editSessionMessage"] },
    plugins: { on: "cliService", methods: ["refreshPlugins", "listMarketplacePlugins", "listInstalledPlugins", "listEnabledPlugins", "installPlugin", "enablePlugin", "disablePlugin", "uninstallPlugin", "previewGithubPlugin", "importGithubPlugin"] },
    mcp: { on: "cliService", methods: ["configureSessionMcpServers", "inspectProjectMcp", "clearSessionMcpServers", "listMcpServers"] },
    subagents: { on: "cliService", methods: ["listBackgroundTasks"], absent: ["getDelegationSnapshot", "stopDelegation"] },
    usageStats: { on: "cliService", methods: ["getSessionUsage", "getSessionUsageSummary", "watchSessionUsageCommits"] },
    authCredentials: { on: "cliService", methods: ["getAccountStatus", "getCodexOAuthStatus", "startCodexOAuthLogin", "cancelCodexOAuthLogin", "getMiniMaxApiKeyStatus", "upsertMiniMaxApiKey", "selectModel", "setPermissionMode", "listUserModelProviders", "createUserModelProvider", "updateUserModelProvider", "deleteUserModelProvider", "testUserModel", "discoverUserModelsCandidate"], absent: ["setConfigOption"], unimplemented: ["setThinkingEffort"] },
    fileReadWrite: { on: "cliService", methods: ["listWorkspaceFileTree", "searchWorkspaceFiles"] },
    gitOperations: { on: "cliService", methods: ["getWorkspaceGitMetadata", "getWorkspaceReviewLink"] },
  },
};

// ---------------------------------------------------------------------------
// The pure audit — errors are values (a problems list), so the mutation
// checks can feed it synthetic surfaces and pin that it reports drift.
// ---------------------------------------------------------------------------

/**
 * Walk an object's prototype chain and collect every own function name
 * (skipping Object.prototype noise). This is the same reflection the
// one-off provenance audit used, so "exists" means exactly what the
 * table was derived against — class methods live on prototypes, so a
 * plain Object.keys() would see none of them.
 */
export function collectMethodNames(obj) {
  const names = new Set();
  let proto = obj;
  const seen = new Set();
  while (proto && proto !== Object.prototype && !seen.has(proto)) {
    seen.add(proto);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      try {
        if (typeof obj[name] === "function") names.add(name);
      } catch {
        // getter that throws — not a method
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names].sort();
}

/**
 * Does any method name on the surface cover all segments of a
 * kebab-case sub-capability name ("file-write" → ["file","write"])?
 * Both segments must appear in the SAME method name: getWorkspaceGit-
 * Metadata contains "git" but not "diff", so it does not satisfy
 * "git-diff"; a future getWorkspaceGitDiff would.
 */
function subCapabilityHasMethods(missingItem, allMethodNames) {
  const segments = missingItem.split("-").map((s) => s.toLowerCase());
  return allMethodNames.filter((name) => {
    const lower = name.toLowerCase();
    return segments.every((segment) => lower.includes(segment));
  });
}

/**
 * Audit one provider's declaration against the live host.
 *
 * @param {string} providerId
 * @param {Record<string, {level: string, missing?: string[]}>} declaration
 * @param {object} host the real catalogue host (adapter/cliService/…)
 * @returns {string[]} problems; empty means the declaration matches the
 *           implementation for every full/partial key.
 */
export function auditProviderCapabilities(providerId, declaration, host) {
  const problems = [];
  const required = REQUIRED_METHODS[providerId] || {};
  const surfaceMethodsByMember = new Map();
  const methodTypeOf = (on, method) => {
    const member = resolveMember(host, on);
    if (member === undefined || member === null) return "undefined";
    try {
      return typeof member[method];
    } catch {
      return "throws";
    }
  };
  const surfaceMethodNames = (on) => {
    if (!surfaceMethodsByMember.has(on)) {
      const member = resolveMember(host, on);
      surfaceMethodsByMember.set(on, member ? collectMethodNames(member) : []);
    }
    return surfaceMethodsByMember.get(on);
  };

  for (const key of Object.keys(required)) {
    const entry = declaration[key];
    if (!entry) continue; // shape problems are M1's validate, not this audit
    const { on, methods, absent = [], unimplemented = [] } = required[key];

    // `unimplemented` is checked BEFORE the level dispatch and never
    // consults the declaration. It is not a statement about what this
    // provider claims; it is a statement about the SURFACE — "this
    // surface must not carry a method, whatever the declaration says",
    // because the bridge names it as a forward contract and the only
    // event that should move it is the engine shipping the writer. A
    // surface that grows one here has outrun its own declaration, and
    // the message says so in the words a reader needs ("re-audit"),
    // rather than reporting a missing entry.
    for (const method of unimplemented) {
      if (methodTypeOf(on, method) === "function") {
        problems.push(
          `${providerId}.${key}: ${on}.${method} is a bridged forward contract the ` +
            `declaration has no method for, but the surface NOW HAS it — re-audit the bridge ` +
            `(move it out of \`unimplemented\` and into the declaration)`,
        );
      }
    }

    if (entry.level === "full") {
      for (const method of methods) {
        if (methodTypeOf(on, method) !== "function") {
          problems.push(
            `${providerId}.${key}: declared full but ${on}.${method} is not a function`,
          );
        }
      }
      continue;
    }

    if (entry.level === "partial") {
      const missing = entry.missing || [];
      // Present part: every tracked method must exist (none of them may
      // appear in `missing` — see the coverage sweep below).
      for (const method of methods) {
        if (methodTypeOf(on, method) !== "function") {
          problems.push(
            `${providerId}.${key}: declared partial, not listing ${on}.${method} as missing, yet it is absent`,
          );
        }
      }
      // Absent part: each method-named missing item must be tracked
      // (else the audit would be vacuous for it) and genuinely absent.
      for (const item of missing) {
        if (item.includes("-")) continue; // sub-capability name, swept below
        if (!absent.includes(item)) {
          problems.push(
            `${providerId}.${key}: missing lists "${item}" which this snapshot does not track as absent for the key`,
          );
          continue;
        }
        if (methodTypeOf(on, item) === "function") {
          problems.push(
            `${providerId}.${key}: missing lists ${on}.${item} but it exists on the surface`,
          );
        }
      }
      // Under-declaration: a tracked absent method the declaration
      // stopped listing would hide a real gap behind "partial".
      for (const item of absent) {
        if (!missing.includes(item)) {
          problems.push(
            `${providerId}.${key}: ${on}.${item} is absent from the surface but the declaration does not list it as missing`,
          );
        }
      }
      // Kebab-case missing items name sub-capabilities, not methods:
      // they must have NO covering method on the key's surface.
      for (const item of missing) {
        if (!item.includes("-")) continue;
        const covered = subCapabilityHasMethods(item, surfaceMethodNames(on));
        if (covered.length > 0) {
          problems.push(
            `${providerId}.${key}: missing lists sub-capability "${item}" but surface method(s) ${covered.join(", ")} cover it`,
          );
        }
      }
      continue;
    }
    // "none": deliberately not method-checked.
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Static guard — registry-driven key-set assertion (no host needed).
// ---------------------------------------------------------------------------

describe("M2 static guard — declarations carry exactly the 14 contract keys", () => {
  test("every REGISTERED provider declares exactly ENGINE_CAPABILITY_KEYS — no typos can pass silently", () => {
    // Registry-driven on purpose: M4 will register acp/exec providers,
    // and this sweep picks them up without editing the test. A key the
    // contract does not know (typo, rename) or a dropped key fails here
    // even before any host is booted.
    const ids = listEngineProviderIds();
    assert.ok(ids.length >= 2, `expected both M1 providers registered, got ${ids.join(", ")}`);
    const expected = [...ENGINE_CAPABILITY_KEYS].sort();
    for (const id of ids) {
      const { capabilities } = getEngineProvider(id);
      assert.deepEqual(
        Object.keys(capabilities).sort(),
        expected,
        `${id} must declare exactly the 14 contract keys`,
      );
      assert.deepEqual(
        validateEngineCapabilities(capabilities),
        [],
        `${id} declaration must pass contract validation`,
      );
    }
  });

  test("REQUIRED_METHODS covers every non-none key of every audited provider (and no others)", () => {
    for (const [providerId, required] of Object.entries(REQUIRED_METHODS)) {
      const { capabilities } = getEngineProvider(providerId);
      for (const key of Object.keys(required)) {
        assert.ok(
          capabilities[key] && capabilities[key].level !== "none",
          `${providerId}.${key} is audited but declared none — none keys are not method-checked`,
        );
        assert.ok(
          SURFACE_MEMBERS[providerId].includes(required[key].on) ||
            required[key].on.startsWith("applications."),
          `${providerId}.${key} surface "${required[key].on}" must be a declared surface member`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Live-host audit — one real catalogue host, both providers audited.
// ---------------------------------------------------------------------------

describe("M2 snapshot — declarations vs the REAL catalogue host", () => {
  let host;
  let declarations;

  before(async () => {
    // Dynamic import AFTER env is pinned: the provider module pulls the
    // @mavis/* TS tree and constructs the real in-process runtime.
    const { createCatalogueHost } = await import(
      "../../../server/engine/providers/local-runtime-v2.js"
    );
    declarations = {
      "local-runtime-v2": LOCAL_RUNTIME_V2_CAPABILITIES,
      "tui-runtime-adapter": TUI_RUNTIME_ADAPTER_CAPABILITIES,
    };
    host = await createCatalogueHost({ dataDir: tmpBase });
  });

  after(async () => {
    if (host) await host.close();
    rmTmpDir(tmpBase);
  });

  test("the host exposes the surfaces the declarations talk about", () => {
    // Precondition tripwire: if the host contract loses a member the
    // audit below would silently degrade to checking nothing.
    assert.equal(typeof host.adapter?.sendMessage, "function", "host.adapter missing");
    assert.equal(typeof host.cliService?.createSession, "function", "host.cliService missing");
    assert.equal(
      typeof host.applications?.session?.diff?.getTurnDiff,
      "function",
      "host.applications.session.diff missing",
    );
  });

  for (const providerId of Object.keys(REQUIRED_METHODS)) {
    test(`${providerId}: every full/partial key matches the live surface (none keys unchecked)`, () => {
      const problems = auditProviderCapabilities(
        providerId,
        declarations[providerId],
        host,
      );
      assert.deepEqual(
        problems,
        [],
        `declaration/implementation drift must be empty — a non-empty list is the CI red light M2 exists for:\n  ${problems.join("\n  ")}`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // M3-B14 — THE THIRD BRIDGE IS PROVEN ABSENT, NOT ASSUMED ABSENT
  // -------------------------------------------------------------------------
  //
  // The other two bridged sub-items (`selectModel`, `setPermissionMode`)
  // are in `methods`, so this file proves they EXIST. The third one cannot
  // be proven that way — no surface has it — so the only honest thing
  // to do is prove the absence, by reflection, on the same real host, and
  // say so in a test that fails if that ever stops being true.
  //
  // These assertions deliberately do NOT mock the surface as present. A
  // suite that asserted "the host has setThinkingEffort" to make the gate
  // look justified would be asserting a falsehood, and the falsehood is
  // the whole risk this block exists to remove: a bridge that reads as
  // verified while resting on a method nobody wrote.
  for (const [providerId, required] of Object.entries(REQUIRED_METHODS)) {
    const [on] = [required.authCredentials.on];
    test(`${providerId}: ${on} has NO ${MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort} method`, () => {
      // A live probe over the real prototype chain — the same
      // reflection the provenance audit used, not a hand-typed list.
      const names = collectMethodNames(resolveMember(host, on));
      assert.equal(
        names.includes(MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort),
        false,
        `the surface grew ${MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort} — move it out of ` +
          `\`unimplemented\`, re-audit the bridge, and let the control come back`,
      );
      // The audit's own verdict on the same fact, from the table rather
      // than from this test's ad-hoc probe. Both halves, because a probe
      // that passes while the audit table has drifted is a probe of the
      // wrong thing.
      const problems = auditProviderCapabilities(
        providerId,
        declarations[providerId],
        host,
      );
      assert.deepEqual(problems, []);
    });
  }

  test("the name the bridge points at is the name the snapshot tracks as unimplemented", () => {
    // The two tables and the bridge share one fact. Nothing in the server
    // asserts this — the tables are separate literals in separate files
    // — so it is asserted here, where both are in scope, by VALUE.
    for (const [providerId, required] of Object.entries(REQUIRED_METHODS)) {
      assert.deepEqual(
        required.authCredentials.unimplemented,
        [MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort],
        providerId,
      );
      assert.equal(
        required.authCredentials.methods.includes(MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort),
        false,
        `${providerId}: it must not ALSO be claimed present — the two would contradict`,
      );
      assert.equal(
        (declarations[providerId].authCredentials.missing || []).includes(
          MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort,
        ),
        false,
        `${providerId}: no provider declares the effort writer missing — listing it would ` +
          `remove the control for every user today`,
      );
    }
  });

  test("method-surface sizes stay in the audited ballpark (gross-loss tripwire)", () => {
    // Not an exact pin (the engine may add methods freely) — this only
    // catches a wholesale surface loss (e.g. a proxy/wrapper hiding the
    // prototype chain) that per-method checks above could otherwise
    // never distinguish from a legitimately smaller surface.
    assert.ok(collectMethodNames(host.adapter).length > 80, "adapter surface collapsed");
    assert.ok(collectMethodNames(host.cliService).length > 85, "cliService surface collapsed");
  });
});

// ---------------------------------------------------------------------------
// Mutation checks — the checker itself must go red on drift. These pin
// the ticket's mutation matrix against synthetic surfaces, so the red
// light is guaranteed by tests, not by a one-time manual run.
// ---------------------------------------------------------------------------

describe("M2 mutation checks — auditProviderCapabilities reports drift", () => {
  /** A minimal fake host from method-name lists per surface member. */
  function fakeHost(adapterNames, cliServiceNames, diffNames) {
    const toObject = (names) =>
      Object.fromEntries(names.map((n) => [n, () => {}]));
    return {
      adapter: toObject(adapterNames),
      cliService: toObject(cliServiceNames),
      applications: { session: { diff: toObject(diffNames) } },
    };
  }

  const ADAPTER_ALL = REQUIRED_METHODS["tui-runtime-adapter"];
  const V2_ALL = REQUIRED_METHODS["local-runtime-v2"];

  /** Method names per surface member, gathered from REQUIRED_METHODS. */
  function namesBySurface(provider) {
    const byOn = {};
    for (const { on, methods } of Object.values(provider)) {
      byOn[on] = [...(byOn[on] || []), ...methods];
    }
    return byOn;
  }

  test("MUT-1: flipping a full to partial (missing a method that EXISTS) goes red", () => {
    // usageStats exists in full on cliService; declaring it partial and
    // listing getSessionUsage as missing must fail the audit — this is
    // the ticket's "flip a full to partial → red" mutation, pinned as a
    // property of the checker.
    const v2 = namesBySurface(V2_ALL);
    const mutated = {
      ...LOCAL_RUNTIME_V2_CAPABILITIES,
      usageStats: { level: "partial", missing: ["getSessionUsage"], reason: "mutant" },
    };
    const problems = auditProviderCapabilities(
      "local-runtime-v2",
      mutated,
      fakeHost([], v2.cliService, v2["applications.session.diff"]),
    );
    assert.ok(
      problems.some((p) => p.includes("usageStats") && p.includes("getSessionUsage")),
      `expected the full→partial flip to be reported, got: ${JSON.stringify(problems)}`,
    );
  });

  test("MUT-2: deleting a method implementation goes red (full key)", () => {
    const byOn = namesBySurface(V2_ALL);
    const withoutDisablePlugin = byOn.cliService.filter((m) => m !== "disablePlugin");
    const problems = auditProviderCapabilities(
      "local-runtime-v2",
      LOCAL_RUNTIME_V2_CAPABILITIES,
      fakeHost([], withoutDisablePlugin, byOn["applications.session.diff"]),
    );
    assert.ok(
      problems.some((p) => p.includes("plugins") && p.includes("disablePlugin")),
      `expected the deleted method to be reported, got: ${JSON.stringify(problems)}`,
    );
  });

  test("MUT-3: deleting a method a partial relies on goes red", () => {
    const byOn = namesBySurface(ADAPTER_ALL);
    const withoutRewind = byOn.adapter.filter((m) => m !== "rewindSession");
    const problems = auditProviderCapabilities(
      "tui-runtime-adapter",
      TUI_RUNTIME_ADAPTER_CAPABILITIES,
      fakeHost(withoutRewind, [], []),
    );
    assert.ok(
      problems.some((p) => p.includes("turnRewindRedo") && p.includes("rewindSession")),
      `expected the deleted partial method to be reported, got: ${JSON.stringify(problems)}`,
    );
  });

  test("MUT-4: a missing sub-capability that GREW a covering method goes red", () => {
    // The engine grows getWorkspaceGitDiff while the declaration still
    // denies "git-diff" — the snapshot must force a re-audit.
    const byOn = namesBySurface(ADAPTER_ALL);
    const problems = auditProviderCapabilities(
      "tui-runtime-adapter",
      TUI_RUNTIME_ADAPTER_CAPABILITIES,
      fakeHost([...byOn.adapter, "getWorkspaceGitDiff"], [], []),
    );
    assert.ok(
      problems.some((p) => p.includes("gitOperations") && p.includes("getWorkspaceGitDiff")),
      `expected the grown sub-capability to be reported, got: ${JSON.stringify(problems)}`,
    );
  });

  test("MUT-6: a surface that GROWS the bridged effort writer goes red", () => {
    // The engine team lands `setThinkingEffort`. Nothing in the gate, in
    // the bridge table or in any declaration changes — the surface
    // simply starts having the method the bridge was a contract FOR. The
    // audit is the only thing in this repository that can notice, so it
    // has to notice: this is the check that makes the third bridge a
    // forward contract with a closing mechanism rather than an
    // unverified exemption.
    for (const [providerId, required] of Object.entries(REQUIRED_METHODS)) {
      const byOn = namesBySurface(required);
      const declared = providerId === "local-runtime-v2"
        ? LOCAL_RUNTIME_V2_CAPABILITIES
        : TUI_RUNTIME_ADAPTER_CAPABILITIES;
      const host = fakeHost(
        [...(byOn.adapter || []), MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort],
        [...(byOn.cliService || []), MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort],
        [...(byOn["applications.session.diff"] || []), MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort],
      );
      const problems = auditProviderCapabilities(providerId, declared, host);
      assert.ok(
        problems.some(
          (p) => p.includes("authCredentials") && p.includes(MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort),
        ),
        `${providerId}: the grown forward contract was not reported, got: ${JSON.stringify(problems)}`,
      );
    }
  });

  test("MUT-7: the SAME surface WITHOUT the writer is clean, on both providers", () => {
    // The reverse half of MUT-6, and the reason the check is worth having
    // at all: a rule that reports drift unconditionally is a rule nobody
    // reads. Both providers, both surfaces, no problems.
    for (const [providerId, required] of Object.entries(REQUIRED_METHODS)) {
      const byOn = namesBySurface(required);
      const declared = providerId === "local-runtime-v2"
        ? LOCAL_RUNTIME_V2_CAPABILITIES
        : TUI_RUNTIME_ADAPTER_CAPABILITIES;
      const problems = auditProviderCapabilities(
        providerId,
        declared,
        fakeHost(byOn.adapter || [], byOn.cliService || [], byOn["applications.session.diff"] || []),
      );
      assert.deepEqual(problems, [], providerId);
    }
  });

  test("MUT-5: a partial listing an absent method as missing is fine; listing a present one is not", () => {
    const byOn = namesBySurface(ADAPTER_ALL);
    const ok = auditProviderCapabilities(
      "tui-runtime-adapter",
      TUI_RUNTIME_ADAPTER_CAPABILITIES,
      fakeHost(byOn.adapter, [], []),
    );
    assert.deepEqual(ok, [], "the pristine declaration over the real method set is clean");
  });
});

// ---------------------------------------------------------------------------
// M4-1 — the acp declaration against the protocol's wire table
// ---------------------------------------------------------------------------

describe("M4-1 acp snapshot — declaration vs the protocol's wire table", () => {
  test("the acp declaration passes the wire audit (the CI red light this provider needs)", () => {
    const problems = auditAcpCapabilities(ACP_CAPABILITIES, MCODE_ACP_CAPABILITIES, ACP_CONFIG_OPTION_IDS);
    assert.deepEqual(
      problems,
      [],
      `declaration/wire drift must be empty:\n  ${problems.join("\n  ")}`,
    );
  });

  // The subtlety this whole provider turns on. `cancel` IS on the wire
  // and IS true; the declaration is still `none`. If a future edit
  // promotes interrupt to `full` because "the protocol has a cancel",
  // the audit above goes red with the reason spelled out — which is
  // the difference between a re-audit and a silent regression.
  test("interrupt is none DESPITE `cancel` being a live wire method", () => {
    assert.equal(MCODE_ACP_CAPABILITIES.cancel, true, "the wire really does carry cancel");
    assert.equal(ACP_CAPABILITIES.interrupt.level, "none");
    assert.match(ACP_CAPABILITIES.interrupt.reason, /cancel/, "the reason must name the notification");
  });

  // Same shape, opposite direction: the protocol registers
  // `session/delete` with NO handler, so the wire table says `false`.
  //
  // M4-3a split this cell in two and both halves are now asserted: the
  // PROTOCOL still cannot delete (this test, unchanged in what it
  // proves), while the TRANSPORT can, because the delete runs on the
  // process-local v2 host's own `deleteSession` rather than on the wire.
  // The declaration therefore stops listing `deleteSession` as missing
  // — and if it ever starts claiming the protocol has a handler, the
  // first assertion below is what goes red.
  test("sessionCrud is partial, and `delete` is registered without a handler", () => {
    assert.equal(MCODE_ACP_CAPABILITIES.delete, false);
    assert.equal(ACP_CAPABILITIES.sessionCrud.level, "partial");
    assert.equal(ACP_CAPABILITIES.sessionCrud.missing.includes("deleteSession"), false);
    assert.match(
      ACP_CAPABILITIES.sessionCrud.reason,
      /MCODE_ACP_CAPABILITIES\.delete === false/,
      "the reason must keep recording that the WIRE cannot delete — the capability comes from elsewhere, not from the protocol",
    );
  });

  // The acp column is stronger than the v2 column on exactly one key,
  // and the suite says so out loud so nobody "harmonises" it away.
  test("acp covers setMode, which neither runtime surface can", () => {
    assert.equal(MCODE_ACP_CAPABILITIES.set_mode, true);
    assert.equal(ACP_CAPABILITIES.toolSkillInvocation.missing.includes("setMode"), false);
  });

  // M3-B14's closure mechanism, extended to the new provider: the
  // effort writer is named by the bridge and implemented by nobody, so
  // it belongs in `unimplemented` and NOT in any `missing` list.
  test("setThinkingEffort is unimplemented over acp, and no declaration claims it missing", () => {
    assert.equal(ACP_CONFIG_OPTION_IDS.includes(MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort), false);
    for (const [name, decl] of [
      ["acp", ACP_CAPABILITIES],
      ["local-runtime-v2", LOCAL_RUNTIME_V2_CAPABILITIES],
      ["tui-runtime-adapter", TUI_RUNTIME_ADAPTER_CAPABILITIES],
    ]) {
      assert.equal(
        (decl.authCredentials.missing || []).includes(MODE_WRITE_BRIDGED_CONFIG_IDS.thinkingEffort),
        false,
        `${name}: listing the effort writer as missing would remove the control for every user today`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Mutation checks for the acp audit — the checker is itself under test
// ---------------------------------------------------------------------------

describe("M4-1 acp audit — mutation checks", () => {
  const wire = () => ({ ...MCODE_ACP_CAPABILITIES });
  const decl = () => structuredClone({ ...ACP_CAPABILITIES });
  const clean = (d, w = wire(), ids = ACP_CONFIG_OPTION_IDS) => auditAcpCapabilities(d, w, ids);

  test("MUT-A: a `full` resting only on a notification is refused", () => {
    const d = decl();
    d.interrupt = { level: "full" };
    const problems = clean(d);
    assert.ok(
      problems.some((p) => p.includes("NOTIFICATION") && p.startsWith("acp.interrupt")),
      problems.join("; "),
    );
  });

  test("MUT-B: a `full` with no covering wire method is refused", () => {
    const d = decl();
    d.mcp = { level: "full" };
    const problems = clean(d);
    assert.ok(problems.some((p) => p.includes("acp.mcp") && p.includes("no covering wire method")), problems.join("; "));
  });

  test("MUT-C: a wire method that appears out of nowhere must not go unnoticed", () => {
    // The drift this suite exists to catch: the protocol grows
    // `session/rewind`, the wire table learns about it, and the
    // declaration still says `none`.
    const w = wire();
    w.rewind = true;
    const problems = clean(decl(), w);
    assert.ok(problems.some((p) => p.startsWith("acp.turnRewindRedo") && p.includes("rewind")), problems.join("; "));
  });

  test("MUT-D: a `present` method the wire no longer has is refused", () => {
    const w = wire();
    w.fork = false;
    const problems = clean(decl(), w);
    assert.ok(problems.some((p) => p.includes("wire method \"fork\"")), problems.join("; "));
  });

  test("MUT-E: `delete` becoming available must force a sessionCrud re-audit", () => {
    const w = wire();
    w.delete = true;
    const problems = clean(decl(), w);
    assert.ok(problems.some((p) => p.includes("denied by wire method \"delete\"")), problems.join("; "));
  });

  test("MUT-F: a none key whose reason stops naming the notification is refused", () => {
    const d = decl();
    d.interrupt = { level: "none", reason: "interface-absent: the protocol has no cancel method" };
    // The reason still says "cancel", so this must be CLEAN — a
    // mutation that proves the check is name-based, not a blanket one.
    assert.deepEqual(clean(d), []);
    d.interrupt = { level: "none", reason: "interface-absent: nothing here" };
    const problems = clean(d);
    assert.ok(problems.some((p) => p.includes("does not name it")), problems.join("; "));
  });

  test("MUT-G: the effort writer appearing on the wire must go red", () => {
    const problems = clean(decl(), wire(), [...ACP_CONFIG_OPTION_IDS, "thinkingEffort"]);
    assert.ok(problems.some((p) => p.includes("setThinkingEffort") && p.includes("re-audit the bridge")), problems.join("; "));
  });

  test("MUT-H: dropping the host exception is a DELETE, not a silent change", () => {
    // The reverse exception is data, so removing it changes
    // `summarizeCapabilityHosting` — and this asserts the registry
    // still reports both keys, so a deletion cannot pass unnoticed.
    const d = decl();
    for (const key of ["turnDiff", "plugins"]) delete d[key].servedBy;
    assert.equal(getEngineProvider("acp").capabilities.turnDiff.servedBy, "local-runtime-v2");
    assert.deepEqual(clean(d), [], "the wire audit does not police servedBy — that is its own test");
  });
});
