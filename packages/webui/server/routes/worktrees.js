// webui/server/routes/worktrees.js
//
// The 工作树 family (placeholder batch PB-3):
//
//   GET  /api/worktrees         ?workspace=<repo>   list one repository's worktrees
//   POST /api/worktrees/remove  {items, activeWorktreeDir?}
//
// This file is the HTTP shape and nothing else. The member resolution
// (PB-8's three-state `getHostServices()`), the body validation, the
// envelope mapping and the failure taxonomy live in `../engine/worktrees.js`,
// which is where every other family keeps them. What stays here is what
// only an HTTP layer can own: the query/body read, the containment gate on
// the one path that comes from the browser as free text, the status line
// and the JSON body.
//
// THE CONTAINMENT GATE, and why it covers one path and not two.
//
// `workspace` is browser-supplied, so it goes through the same
// `assertWorkspacePath` boundary as `/api/fs/*`: a path outside the
// allowed roots is refused with 403 before Git is invoked. `worktreeDir` is
// deliberately NOT gated here, and the engine applies a stronger check
// instead — `prepareManagedWorktreeRemoval` only removes a path that
// `git worktree list` reports as a linked worktree of THAT repository, so
// the worst a forged path achieves is a `not_found` refusal. The full
// reasoning is in `engine/worktrees.js`; a second, weaker gate in front of
// it would only make legitimate out-of-root worktrees unremovable.
//
// THE STATUS MAP, because 200 is not the only success here:
//
//   200 {ok:true,  …}   the engine reported a reading (including the honest
//                       `ok:false` list failures — a non-git directory is a
//                       fact about the user's folder, not a bad request)
//   400                 the body is not a removal request
//   403                 the named workspace is outside the allowed roots
//   503                 no runtime booted
//   501                 the host has no owner graph, or no worktree service
//
// A `413` for an oversized body comes from `readJson` itself, the same
// bounded reader every other JSON route uses.

import { readJson } from "../lib/read-json.js";
import { assertWorkspacePath } from "../lib/workspace.js";
import {
  parseWorktreeRemoveBody,
  readEngineWorktreeList,
  removeEngineWorktrees,
  resolveWorktreeWorkspace,
} from "../engine/worktrees.js";

/**
 * One JSON answer. The engine facade already decided the status and the
 * code; this only serialises it.
 *
 * @param {object} res
 * @param {number} status
 * @param {object} payload
 * @returns {number} The status written.
 */
function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
  return status;
}

/**
 * `GET /api/worktrees` — the page's list.
 *
 * `workspace` is optional: without it the request's own conversation
 * workspace is used, so the page can open with a bare `GET` while the user
 * is in a project. Neither source exists → 400, never a guess.
 *
 * Every handler takes an optional FOURTH argument forwarded to the engine
 * facade's `deps` (`{getServices}` — nothing in production, a fake window
 * in `test/routes/worktrees.test.js`). `app.js#invokeHandler` passes three
 * arguments, so the seam costs production nothing and keeps the suite
 * hermetic: no runtime boot, no network, no tmpdir.
 */
export async function handleGetWorktrees(req, res, ctx, deps = {}) {
  const url = new URL(req.url, "http://localhost");
  const workspace = resolveWorktreeWorkspace(
    { workspace: url.searchParams.get("workspace") },
    ctx,
  );
  if (!workspace.ok) {
    return json(res, 400, { ok: false, code: "no_workspace", error: workspace.error });
  }
  const gate = assertWorkspacePath(workspace.workspace);
  if (!gate.ok) {
    return json(res, 403, {
      ok: false,
      code: "workspace_outside_allowed_roots",
      error: gate.error,
    });
  }
  // `gate.real` is the symlink-resolved form, and the engine compares
  // paths by realpath too (`worktrees.ts#listWorkspaceGitWorktrees`), so
  // the symlinked form is the one that must go to Git — see
  // `routes/fs.js#safePath` for the same rule and the reason.
  const answer = await readEngineWorktreeList({
    workspace: gate.real ?? gate.path ?? workspace.workspace,
    deps,
  });
  return json(res, answer.status, answer.payload);
}

/**
 * `POST /api/worktrees/remove` — the page's 一键移除 over a selection.
 *
 * Body: `{ "items": [{ "workspace": string, "worktreeDir": string }],
 *          "activeWorktreeDir"?: string }`.
 *
 * 200 with the engine's own per-item verdicts: `removedPaths[]` and
 * `failedItems[]` where every failure carries its `WorktreeRemovalReason`.
 * The page renders those reasons; this layer never collapses them.
 */
export async function handleRemoveWorktrees(req, res, _ctx, deps = {}) {
  const parsed = parseWorktreeRemoveBody(await readJson(req));
  if (!parsed.ok) {
    return json(res, 400, { ok: false, code: "invalid_removal_request", error: parsed.error });
  }
  // Every item names a repository, so every item's repository is gated the
  // same way the query parameter is. One refusal fails the request rather
  // than being reported per item: an out-of-root repository is a forged
  // request, not a worktree that happened to fail.
  const items = [];
  for (const [index, item] of parsed.items.entries()) {
    const gate = assertWorkspacePath(item.workspace);
    if (!gate.ok) {
      return json(res, 403, {
        ok: false,
        code: "workspace_outside_allowed_roots",
        error: `items[${index}]: ${gate.error}`,
      });
    }
    items.push({ ...item, workspace: gate.real ?? gate.path ?? item.workspace });
  }
  const answer = await removeEngineWorktrees({
    items,
    activeWorktreeDir: parsed.activeWorktreeDir,
    deps,
  });
  return json(res, answer.status, answer.payload);
}
