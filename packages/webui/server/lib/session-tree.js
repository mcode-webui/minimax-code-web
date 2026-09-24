// webui/server/lib/session-tree.js
// Sidebar session tree: Project → directory → main session → subagents.
//
// Why this lives here: the sidebar used to group the webui's own wrapper records
// (`sessions.json`) by workspace. That is one flat level and carries no notion of
// which session spawned which, so it cannot express the hierarchy the user asked
// for (项目 → 目录 → mavis 主会话 → subagents). That hierarchy only exists in
// mcode's runtime db, so this module reads `local_runtime_sessions` read-only and
// rebuilds the tree for the sidebar.
//
// Level mapping, mirroring the desktop client's own grouping helpers
// (`rootTaskSessions` / `groupChildren` in its `project` module, extracted from
// the shipped app bundle):
//   1. project      the git repository the session directory belongs to
//   2. directory    the session's `workspace_dir` — a worktree or a checkout
//   3. main session `parent_session_id IS NULL AND session_type = 'branch'`
//   4. subagent     any session whose `parent_session_id` points at a main one
//
// Rows that fit none of those (e.g. `session_type = 'root'`, the container
// objects the runtime keeps beside the real trees) are skipped rather than shown
// as stray sessions. Measured against this machine's db: 0 children point at a
// `root` row, 0 children have a parent outside the visible set, and every child
// is exactly one level deep, so no re-parenting fallback is needed.
//
// Project resolution is git-based, in this order (see `resolveProjectRoots`):
//   1. `<dir>/.git` is a directory      → the dir is a repository root
//   2. `<dir>/.git` is a worktree file  → the repo that owns the worktree
//   3. an ancestor is a repository root → that ancestor
//   4. a resolved sibling in the same parent directory → that sibling's project
//   5. otherwise                        → the directory is its own project
// Rule 4 is what folds a worktree whose `.git` has been removed back into its
// repository instead of listing it as a bogus one-directory project.
//
// The runtime db also records a `project_id`, but it is per-directory (verified:
// `project_workspace_dir` equals `workspace_dir` for every visible row), so it
// cannot distinguish a checkout from its worktrees. Git can.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { MCODE_RUNTIME_DB } from "./config.js";
import { getMcodeBetterSqlite3 } from "./sqlite-resolver.js";
import { loadSessions } from "./sessions.js";

// The sidebar re-reads this on every session-list refresh (which also fires on
// every state push). The db read is a single indexed scan, but the git probe
// touches the filesystem per directory, so the assembled payload is cached.
const CACHE_TTL_MS = 15_000;

// Defensive bound: the runtime db is append-mostly and grows without limit. A cap
// keeps one pathological db from stalling the sidebar; `truncated` tells the
// client the list is incomplete rather than silently short.
const MAX_ROWS = 5000;

let _cache = null;

/**
 * Read the rows that make up the tree.
 *
 * `workspace_dir` is required: a session with no directory has nowhere to sit in
 * a directory-keyed tree. `archived` / `visibility` / `session_kind` follow the
 * desktop's own sidebar filter, so the webui lists the same sessions it does.
 */
function readRows(Db, dbPath) {
  const db = new Db(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT session_id, title, agent_name, session_kind, session_type,
                parent_session_id, workspace_dir, status, updated_at_ms, created_at_ms
           FROM local_runtime_sessions
          WHERE archived = 0
            AND visibility = 'visible'
            AND session_kind NOT IN ('peek', 'cron')
            AND workspace_dir IS NOT NULL
            AND workspace_dir <> ''
          ORDER BY updated_at_ms DESC, created_at_ms DESC, session_id ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

/**
 * The repository root that owns `dir`, from `dir`'s own `.git`, or `null`.
 *
 * A `.git` **file** is a worktree (or submodule) pointer. Worktrees live at
 * `<repo>/.git/worktrees/<name>`, so the owning repository is the segment before
 * `/.git` — that is what maps an Orca worktree such as
 * `/…/orca/workspaces/CTAS/main-5` onto its real repository instead of treating
 * every worktree as its own project. Anything else pointed at by a `.git` file
 * (a submodule's `gitdir: ../.git/modules/<name>`) has no such owner, so the
 * directory stands on its own.
 */
function gitRootAt(dir) {
  const marker = path.join(dir, ".git");
  let stat;
  try {
    stat = statSync(marker);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dir;
  if (!stat.isFile()) return null;

  let body;
  try {
    body = readFileSync(marker, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(body);
  if (!match) return null;
  const common = match[1].replace(/\\/g, "/");
  const worktree = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(common);
  return worktree ? worktree[1] : dir;
}

/** Strip trailing separators so `/a/b/` and `/a/b` are one key. */
function normalizeDir(dir) {
  const trimmed = dir.replace(/[/\\]+$/, "");
  return trimmed === "" ? dir : trimmed;
}

/**
 * Resolve every session directory to the project it belongs to.
 *
 * Three passes, because rule 4 (sibling inheritance) must not read a project
 * that was itself produced by rule 4 — that would make the result depend on the
 * order the directories happen to be visited in.
 */
export function resolveProjectRoots(dirs, { gitRoot = gitRootAt } = {}) {
  const byDir = new Map(dirs.map((dir) => [normalizeDir(dir), normalizeDir(dir)]));
  const roots = new Map();
  const resolved = new Set();

  // Pass 1 — the directory itself, then its ancestors.
  for (const dir of byDir.values()) {
    let cursor = dir;
    const seen = new Set();
    for (let depth = 0; depth < 12 && cursor && !seen.has(cursor); depth += 1) {
      seen.add(cursor);
      const root = gitRoot(cursor);
      if (root) {
        roots.set(dir, root);
        resolved.add(dir);
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  // Pass 2 — inherit from siblings under the same parent. Only a unique winner
  // is inherited: when the siblings disagree there is no defensible answer, and
  // guessing would silently merge unrelated repositories.
  for (const dir of byDir.values()) {
    if (resolved.has(dir)) continue;
    const parent = path.dirname(dir);
    const candidates = new Set();
    for (const [other, otherDir] of byDir) {
      if (other === dir || path.dirname(otherDir) !== parent) continue;
      if (resolved.has(other)) candidates.add(roots.get(other));
    }
    if (candidates.size === 1) roots.set(dir, [...candidates][0]);
  }

  // Pass 3 — stand alone.
  for (const dir of byDir.values()) {
    if (!roots.has(dir)) roots.set(dir, dir);
  }
  return roots;
}

/**
 * Project display name.
 *
 * The name is the repository directory's basename, which is also the grouping
 * key — so two checkouts of the same repository (e.g. a worktree whose `.git`
 * was removed inheriting its sibling's root) land in one project, and two
 * unrelated repositories that happen to share a basename would too. The second
 * case is accepted deliberately: a personal sidebar reads better with one
 * "CTAS" node than with two nodes the user has to tell apart by path.
 */
function projectName(root) {
  return path.basename(root) || root;
}

/**
 * Assemble the tree from raw rows plus their directory → project mapping.
 *
 * `customTitles` maps an mcode session id to a title the user set through
 * POST /api/sessions/rename. That title only exists on the webui record
 * (`titleCustom`), never in the runtime db, so it has to be overlaid or the
 * sidebar keeps showing whatever mcode generated.
 */
export function buildTree(rows, projectRoots, customTitles = new Map()) {
  const projects = new Map();

  for (const row of rows) {
    const dir = normalizeDir(row.workspace_dir);
    const root = projectRoots.get(dir) ?? dir;
    const name = projectName(root);

    let project = projects.get(name);
    if (!project) {
      project = {
        key: name,
        name,
        repoPaths: new Set(),
        directories: new Map(),
        latestAt: 0,
      };
      projects.set(name, project);
    }
    project.repoPaths.add(root);

    let directory = project.directories.get(dir);
    if (!directory) {
      directory = { path: dir, name: path.basename(dir) || dir, roots: [], children: new Map(), latestAt: 0 };
      project.directories.set(dir, directory);
    }

    const at = row.updated_at_ms ?? 0;
    directory.latestAt = Math.max(directory.latestAt, at);
    project.latestAt = Math.max(project.latestAt, at);

    const session = {
      id: row.session_id,
      title: customTitles.get(row.session_id) ?? (row.title || ""),
      agent: row.agent_name || "",
      kind: row.session_kind || "",
      status: row.status || "",
      updatedAt: at,
    };

    if (row.parent_session_id) {
      const list = directory.children.get(row.parent_session_id) ?? [];
      list.push(session);
      directory.children.set(row.parent_session_id, list);
    } else if (row.session_type === "branch") {
      directory.roots.push(session);
    }
    // Neither: a container row (`session_type = 'root'`) — not a sidebar entry.
  }

  const byRecency = (a, b) => b.latestAt - a.latestAt || a.name.localeCompare(b.name);
  const byUpdated = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

  return [...projects.values()]
    .sort(byRecency)
    .map((project) => {
      const directories = [...project.directories.values()]
        .sort(byRecency)
        .map((directory) => ({
          path: directory.path,
          name: directory.name,
          latestAt: directory.latestAt,
          sessions: directory.roots.sort(byUpdated).map((session) => ({
            ...session,
            children: (directory.children.get(session.id) ?? []).sort(byUpdated),
          })),
        }));
      // Pill counts the sessions a user started, so it must not grow with each
      // sub-agent a session spawns. Subagent rows are read so the tree can
      // render them as children, but the count tracks user intent, not engine
      // internals.
      const sessionCount = directories.reduce(
        (total, directory) => total + directory.sessions.length,
        0,
      );
      return {
        key: project.key,
        name: project.name,
        repoPaths: [...project.repoPaths].sort(),
        latestAt: project.latestAt,
        sessionCount,
        directories,
      };
    });
}

/**
 * The sidebar payload, cached for `CACHE_TTL_MS`.
 *
 * Returns `{ ok: false, reason }` rather than throwing when the db or the
 * sqlite binding is unavailable — the sidebar must degrade (fall back to the
 * wrapper list) instead of breaking the page.
 */
export function getSessionTree({ force = false, now = Date.now() } = {}) {
  if (!force && _cache && now - _cache.at < CACHE_TTL_MS) {
    return { ..._cache.payload, cached: true };
  }

  if (!MCODE_RUNTIME_DB || !existsSync(MCODE_RUNTIME_DB)) {
    return { ok: false, reason: "mcode_db_not_found" };
  }
  const Db = getMcodeBetterSqlite3();
  if (!Db) return { ok: false, reason: "better_sqlite3_not_loaded" };

  let rows;
  try {
    rows = readRows(Db, MCODE_RUNTIME_DB);
  } catch (cause) {
    return { ok: false, reason: "mcode_db_read_failed", detail: String(cause && cause.message ? cause.message : cause) };
  }

  const truncated = rows.length > MAX_ROWS;
  const usable = truncated ? rows.slice(0, MAX_ROWS) : rows;
  const dirs = [...new Set(usable.map((row) => normalizeDir(row.workspace_dir)))];
  const customTitles = new Map();
  for (const s of loadSessions()) {
    if (s.titleCustom && s.title && s.mcodeSessionId) customTitles.set(s.mcodeSessionId, s.title);
  }
  const projects = buildTree(usable, resolveProjectRoots(dirs), customTitles);

  const payload = {
    ok: true,
    generatedAt: now,
    truncated,
    counts: {
      projects: projects.length,
      directories: dirs.length,
      sessions: usable.length,
    },
    projects,
  };
  _cache = { at: now, payload };
  return { ...payload, cached: false };
}

/** Drop the cache — used by tests and by the refresh query parameter. */
export function invalidateSessionTree() {
  _cache = null;
}
