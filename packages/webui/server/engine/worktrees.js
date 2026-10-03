// webui/server/engine/worktrees.js
//
// Placeholder batch PB-3: the 工作树 settings page.
//
//   GET  /api/worktrees          → services.managedWorktrees.list(workspace)
//   POST /api/worktrees/remove   → services.managedWorktrees.removeBatch(items)
//
// What this batch is, stated plainly: an HTTP window. The capability was
// always there. `ManagedWorktreeServicePort`
// (packages/local-runtime/src/files/managed-worktrees.ts:39-50) declares
// `list` / `remove` / `removeBatch`, all three are implemented in the same
// file (`:52-82`), the v2 runtime constructs the service
// (local-runtime-v2/src/compat/v1/runtime.ts:467) and hangs it on the owner
// graph (`services.ts:229`, `:584`). Before this batch the settings tab
// rendered a one-line sentence reading 「本地版暂不支持工作树管理」 — which
// was true about the ROUTE and false about the CAPABILITY. The portal that
// let webui see the owner graph at all is PB-8's `getHostServices()`
// (engine/host-services.js), and this is the first consumer of it.
//
// The gate is PB-8's presence gate, and it is the same one PB-1's `pin`
// uses (`engine/session-context-actions.js`), for the same reason: there is
// no capability key for it. `ENGINE_CAPABILITY_KEYS` is a fixed audited
// matrix (`engine/capabilities.js:44`) and adding a key for one service
// would restate three provider declarations and the snapshot audit to
// describe three methods. The honest answer is the three-state member
// read, and all three of its answers are distinct failures:
//
//   null      → no runtime booted          → 503 engine_host_unavailable
//   undefined → a host with no owner graph → 501 engine_services_unavailable
//   object    → but no managedWorktrees    → 501 worktree_service_unavailable
//
// None of them may fall through to a success payload. A 工作树 page that
// answered "no worktrees" for a runtime that failed to boot is the
// fake-empty-list shape this repository refuses to reintroduce: the user
// would read it as "clean up done" and never learn the engine was down.
//
// The list failure is a FOURTH answer and it is NOT a gate failure. When
// the member is present and the workspace simply is not a Git repository,
// the engine's own envelope says so (`WorkspaceGitWorktreeList.code`,
// packages/local-runtime/src/files/worktrees.ts:22-28:
// `not_git_repository` / `workspace_unavailable` / `worktree_list_failed`).
// That is a fact about the user's folder, reported as `200 {ok:false,
// code, error, worktrees: []}` — the same soft-fail shape
// `engine/account-reads.js` uses, because the REQUEST succeeded and the
// engine reported a reading. A silent empty list would be a lie
// (doc/placeholder-batch-plan.md §3.5.1).
//
// Removal is verbatim pass-through, and that is the whole design.
//
// `removeBatch` already returns `{success, removedPaths, failedItems[]}`
// with a per-item `reason` from the closed set `WorktreeRemovalReason`
// (`main_worktree` / `active_worktree` / `not_found` /
// `locked_worktree` / `dirty_worktree` / `unknown`). The engine refuses
// the main worktree, the worktree an active session is running in, locked
// and dirty worktrees, and every running directory the runtime safety
// adapter found — `listRunningWorktreeDirs()` is consulted INSIDE the
// service, so there is nothing for the UI to bypass. This layer
// therefore adds no rule of its own and reorders no field: it maps the
// envelope onto the wire and stops. Reasons reach the browser as the
// engine spelled them, and the page maps them to sentences in one table
// (webapp/components/settings-worktree-section.tsx#REASON_TEXT).
//
// A note on the workspace parameter, and on why only ONE of the two paths
// is containment-gated. The `workspace` comes from the browser, so it goes
// through the same `assertWorkspacePath` gate `/api/fs/*` uses — a path
// outside the allowed roots is rejected before Git is invoked. The
// `worktreeDir` does NOT get that gate, and the reason is that the engine
// applies a strictly stronger one: `prepareManagedWorktreeRemoval`
// (managed-worktrees.ts:205-220) looks the requested path up in the
// repository's own `git worktree list` snapshot and returns `not_found`
// for anything that is not a registered linked worktree of THAT repo. A
// client cannot aim a removal at an arbitrary directory — the worst a
// forged path achieves is a 404-shaped refusal, and the removal itself is
// always `git worktree remove -- <path>` from the repo root, never an
// `rm -rf` of a client-supplied string. Adding a second, weaker gate in
// front of that would only turn legitimate out-of-root worktrees
// (a sibling checkout next to the repo) into unremovable ones.
//
// Boot-path discipline, unchanged from `host-services.js`: nothing heavy is
// imported statically. The PB-8 window is reached through `await import()`
// inside the resolver.

/**
 * The removal reasons this module accepts from the engine, as the closed
 * set `WorktreeRemovalReason` spells it
 * (packages/local-runtime/src/files/managed-worktrees.ts:7-13).
 *
 * Read as an allow-list rather than trusted blindly: `removeBatch` runs
 * the reason through this module, so a value outside the set is reported
 * as `unknown` instead of becoming a free-form string the UI has no
 * sentence for. The engine's own default is already `unknown`, so this
 * narrows nothing that was going to be readable — it only stops a future
 * reason from shipping as raw text before anyone wrote a translation.
 */
export const WORKTREE_REMOVAL_REASONS = Object.freeze([
  "main_worktree",
  "active_worktree",
  "not_found",
  "locked_worktree",
  "dirty_worktree",
  "unknown",
]);

/**
 * The endpoint declaration of this family.
 *
 * `gate` is always `"host-services"`: there is no capability key for
 * `services.managedWorktrees` (see the header), so the row is enforced by
 * the member read at dispatch time against the live host, exactly as
 * PB-8's own header prescribes — "Consumers that need cron must gate on
 * its presence rather than assume it."
 *
 * `method` names the PORT method, and each endpoint uses a different one
 * on purpose. The page never calls `remove` for a single row: the desktop
 * action is 「一键移除」 over a selection (doc/placeholder-batch-plan.md
 * §3.3 step 4 — "一键移除（多选）"), and `removeBatch` is the method that
 * carries the per-item failure list the page has to render. `remove` stays
 * reachable through the same service for any future single-row caller; it
 * is deliberately not wired here so there is one removal path, not two
 * with two different failure shapes.
 *
 * @type {Readonly<Record<string, {gate: "host-services", member: "services.managedWorktrees", method: string}>>}
 */
export const WORKTREE_ENDPOINTS = Object.freeze({
  "GET /api/worktrees": Object.freeze({
    gate: "host-services",
    member: "services.managedWorktrees",
    method: "list",
  }),
  "POST /api/worktrees/remove": Object.freeze({
    gate: "host-services",
    member: "services.managedWorktrees",
    method: "removeBatch",
  }),
});

/** The endpoint keys of this family, for the ledger and the tests. */
export const WORKTREE_ROUTES = Object.freeze(Object.keys(WORKTREE_ENDPOINTS));

/**
 * @typedef {{ok: true, service: object, list: Function, removeBatch: Function}} ResolvedWorktreeService
 * @typedef {{ok: false, code: string, status: number, error: string}} ResolvedWorktreeFailure
 */

// ---------------------------------------------------------------------------
// Member resolution — the three-state rule, once
// ---------------------------------------------------------------------------

/**
 * Read `services.managedWorktrees` off a booted catalogue host, honouring
 * PB-8's three-state answer without collapsing any of them.
 *
 * @param {object} options
 * @param {string} options.endpoint Endpoint key, for the error text.
 * @param {object} [options.deps] Injection seams. `getServices` defaults to
 *   the PB-8 window; a test hands in a fake rather than booting a runtime.
 * @returns {Promise<ResolvedWorktreeService|ResolvedWorktreeFailure>}
 */
async function resolveWorktreeService(options) {
  const { endpoint, deps = {} } = options;
  const getServices =
    deps.getServices ?? (await import("./host-services.js")).getHostServices;
  let window;
  try {
    window = await getServices();
  } catch (e) {
    // A throwing host getter propagates unchanged everywhere else in the
    // facade; here it is caught so the route can answer 503 with a body
    // instead of an unhandled rejection. Same rule as
    // `session-context-actions.js#resolveContextActionMember`.
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: e && e.message ? e.message : String(e),
    };
  }
  if (window === null) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: `${endpoint}: the engine catalogue host is not available`,
    };
  }
  if (window === undefined) {
    return {
      ok: false,
      code: "engine_services_unavailable",
      status: 501,
      error: `${endpoint}: this engine host carries no services owner graph`,
    };
  }
  const service = window.managedWorktrees;
  if (!service || typeof service.list !== "function" || typeof service.removeBatch !== "function") {
    return {
      ok: false,
      code: "worktree_service_unavailable",
      status: 501,
      error: `${endpoint}: host.services.managedWorktrees is absent or does not implement the port`,
    };
  }
  return {
    ok: true,
    service,
    list: service.list.bind(service),
    removeBatch: service.removeBatch.bind(service),
  };
}

// ---------------------------------------------------------------------------
// Pure derivations — exported and tested on their INPUTS
// ---------------------------------------------------------------------------

/**
 * The workspace this request is about.
 *
 * The explicit query parameter wins; otherwise the request's own
 * conversation workspace (`ctx.cs.workspace.dir`, the same field
 * `routes/workspace.js:52` reads) is used. A caller that names neither has
 * no repository in mind, and this refuses rather than guessing the
 * server's own cwd — a page that silently listed the wrong repository
 * would offer to delete worktrees from a project the user never opened.
 *
 * @param {{workspace?: unknown}|undefined|null} query Parsed query.
 * @param {{cs?: {workspace?: {dir?: unknown}}}|undefined|null} ctx Request context.
 * @returns {{ok: true, workspace: string}|{ok: false, error: string}}
 */
export function resolveWorktreeWorkspace(query, ctx) {
  const named = query && typeof query.workspace === "string" ? query.workspace.trim() : "";
  if (named) return { ok: true, workspace: named };
  const fromCtx =
    ctx && ctx.cs && ctx.cs.workspace && typeof ctx.cs.workspace.dir === "string"
      ? ctx.cs.workspace.dir.trim()
      : "";
  if (fromCtx) return { ok: true, workspace: fromCtx };
  return {
    ok: false,
    error:
      "no workspace: pass ?workspace=<repo path>, or open the page from a conversation that has one",
  };
}

/**
 * The removal request body, validated into the shape the port takes.
 *
 * Every field is required and type-checked, because every one of them ends
 * up as an argument to a Git subprocess: `items` must be a non-empty array,
 * each entry an object with two non-empty strings. An absent
 * `activeWorktreeDir` is allowed and means "the engine decides" — it
 * defaults to the item's own workspace inside the service, which is the
 * protection that matters.
 *
 * @param {unknown} body
 * @returns {{ok: true, items: Array<{workspace: string, worktreeDir: string}>, activeWorktreeDir: string|undefined}|{ok: false, error: string}}
 */
export function parseWorktreeRemoveBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: "items must be a non-empty array" };
  }
  const items = [];
  for (const [index, item] of rawItems.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `items[${index}] must be an object` };
    }
    const workspace = typeof item.workspace === "string" ? item.workspace.trim() : "";
    const worktreeDir = typeof item.worktreeDir === "string" ? item.worktreeDir.trim() : "";
    if (!workspace) return { ok: false, error: `items[${index}].workspace must be a non-empty string` };
    if (!worktreeDir) {
      return { ok: false, error: `items[${index}].worktreeDir must be a non-empty string` };
    }
    items.push({ workspace, worktreeDir });
  }
  const active = typeof body.activeWorktreeDir === "string" ? body.activeWorktreeDir.trim() : "";
  return { ok: true, items, activeWorktreeDir: active || undefined };
}

/**
 * The engine's list envelope as this endpoint's payload, field for field.
 *
 * The row objects are passed through UNCHANGED — `path` / `branch` /
 * `head` / `isMain` / `isLocked` / `isActive` / `isMcodeManaged` /
 * `lastModifiedMs` (`WorkspaceGitWorktree`,
 * packages/local-runtime/src/files/worktrees.ts:11-20). In particular
 * `lastModifiedMs` stays optional: `worktreeLastModifiedMs` returns
 * `undefined` when neither the directory mtime nor the reflog could be
 * read, and a row with an unknown age is a real reading that the page's
 * three time tabs must be able to show, not a row to drop or a `0` to
 * invent (a `0` would file it under 「7 天以上」 and hide a fresh worktree
 * from the default tab).
 *
 * @param {object} list The engine's `WorkspaceGitWorktreeList`.
 * @param {string} workspace The workspace the list was taken for.
 * @returns {{ok: boolean, workspace: string, current: string|undefined, worktrees: object[], code: string|undefined, error: string|undefined}}
 */
export function worktreeListPayload(list, workspace) {
  const source = list && typeof list === "object" ? list : {};
  const rows = Array.isArray(source.worktrees) ? source.worktrees : [];
  const current = typeof source.current === "string" && source.current ? source.current : undefined;
  return {
    ok: source.success === true,
    workspace,
    ...(current === undefined ? {} : { current }),
    worktrees: rows,
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(typeof source.error === "string" ? { error: source.error } : {}),
  };
}

/**
 * The engine's batch result as this endpoint's payload.
 *
 * `success` is NOT re-derived from "did anything get removed". A batch
 * where every item was refused is a SUCCESSFUL REQUEST whose answer is
 * "nothing was removed, here is why, per item" — `ok: true` with a full
 * `failedItems` list is the honest report, and flattening it to `ok:false`
 * would throw away the per-item reasons the page exists to render
 * (doc/placeholder-batch-plan.md §3.5.3).
 *
 * Reasons are narrowed to the closed set (§ WORKTREE_REMOVAL_REASONS) and
 * the item path is kept verbatim, because it is the string the page must
 * be able to match back to the row it just tried to remove.
 *
 * @param {object} result The engine's `WorktreeBatchRemovalResult`.
 * @returns {{ok: boolean, removedPaths: string[], failedItems: Array<{worktreeDir: string, reason: string, error: string|undefined}>}}
 */
export function worktreeRemovalPayload(result) {
  const source = result && typeof result === "object" ? result : {};
  const removedPaths = Array.isArray(source.removedPaths)
    ? source.removedPaths.filter((path) => typeof path === "string")
    : [];
  const rawFailed = Array.isArray(source.failedItems) ? source.failedItems : [];
  const failedItems = rawFailed
    .filter((item) => item && typeof item === "object" && typeof item.worktreeDir === "string")
    .map((item) => ({
      worktreeDir: item.worktreeDir,
      reason: WORKTREE_REMOVAL_REASONS.includes(item.reason) ? item.reason : "unknown",
      ...(typeof item.error === "string" ? { error: item.error } : {}),
    }));
  return { ok: source.success === true, removedPaths, failedItems };
}

// ---------------------------------------------------------------------------
// The two reads
// ---------------------------------------------------------------------------

/**
 * `GET /api/worktrees` — the page's list.
 *
 * @param {{workspace: string, deps?: {getServices?: Function}}} input
 * @returns {Promise<{status: number, payload: object}>}
 */
export async function readEngineWorktreeList(input) {
  const endpoint = "GET /api/worktrees";
  const resolved = await resolveWorktreeService({ endpoint, deps: input.deps });
  if (!resolved.ok) return { status: resolved.status, payload: resolved };
  const list = await resolved.list(input.workspace);
  return { status: 200, payload: worktreeListPayload(list, input.workspace) };
}

/**
 * `POST /api/worktrees/remove` — the page's 一键移除.
 *
 * @param {{items: Array<{workspace: string, worktreeDir: string}>, activeWorktreeDir?: string, deps?: {getServices?: Function}}} input
 * @returns {Promise<{status: number, payload: object}>}
 */
export async function removeEngineWorktrees(input) {
  const endpoint = "POST /api/worktrees/remove";
  const resolved = await resolveWorktreeService({ endpoint, deps: input.deps });
  if (!resolved.ok) return { status: resolved.status, payload: resolved };
  const result = await resolved.removeBatch(input.items, input.activeWorktreeDir);
  return { status: 200, payload: worktreeRemovalPayload(result) };
}
