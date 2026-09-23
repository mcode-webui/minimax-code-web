// webui/test/lib/session-tree.test.js
// Unit tests for server/lib/session-tree.js — the Project → directory → session →
// subagent tree behind GET /api/session-tree.
//
// Coverage contract:
//   1. `resolveProjectRoots` maps a worktree onto the repository that owns it
//      (the `.git` **file** case), and a plain checkout onto itself (`.git`
//      directory). This is the rule that keeps 56 CTAS worktrees in one project
//      instead of producing 56 one-directory projects.
//   2. Sibling inheritance only fires on a unique winner. Two disagreeing
//      siblings must NOT be merged, and an inherited root must never be
//      inherited again in the same pass (the three-pass ordering).
//   3. `buildTree` nests subagents under the main session that spawned them and
//      drops container rows (`session_type = 'root'`), which are not sidebar
//      entries.
//   4. A main session with no `parent_session_id` but a non-branch `session_type`
//      is not a level-3 row either — it would be a stray.
//
// Strategy: both functions take their filesystem / row inputs as arguments, so
// the git probe is injected (`{ gitRoot }`) and no real repository or database is
// touched. `getSessionTree` itself is not exercised here: it needs the native
// better-sqlite3 binding, and its cache/error paths are thin wrappers over these
// two functions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildTree, resolveProjectRoots } from "../../server/lib/session-tree.js";

const CTAS_REPO = "/repos/CTAS";

/**
 * A fake git probe keyed by directory.
 *
 * The real `gitRootAt(dir)` answers "which repository owns this directory" from
 * `dir`'s own `.git` (a directory → `dir` itself; a worktree pointer file → the
 * repo the pointer names). It is therefore a map lookup, not an ancestor search —
 * the ancestor search is the caller's loop, and a map is what can express a
 * worktree whose repository lives somewhere else entirely.
 */
const probe = (entries) => {
  const map = new Map(entries);
  return (dir) => map.get(dir) ?? null;
};

describe("resolveProjectRoots — worktree and checkout resolution", () => {
  test("a checkout whose own .git is a directory is its own project", () => {
    const roots = resolveProjectRoots(["/repos/web"], { gitRoot: probe([["/repos/web", "/repos/web"]]) });
    assert.equal(roots.get("/repos/web"), "/repos/web");
  });

  test("a worktree resolves to the repository that owns it, not to itself", () => {
    const roots = resolveProjectRoots(["/wt/main-5"], { gitRoot: probe([["/wt/main-5", CTAS_REPO]]) });
    assert.equal(roots.get("/wt/main-5"), CTAS_REPO);
  });

  test("a nested directory resolves through its ancestor", () => {
    const roots = resolveProjectRoots(["/repos/web/sub/dir"], {
      gitRoot: probe([["/repos/web", "/repos/web"]]),
    });
    assert.equal(roots.get("/repos/web/sub/dir"), "/repos/web");
  });

  test("a directory with no git anywhere above it falls back to itself", () => {
    const roots = resolveProjectRoots(["/loose/dir"], { gitRoot: probe([]) });
    assert.equal(roots.get("/loose/dir"), "/loose/dir");
  });

  test("trailing separators are one key, not two", () => {
    const roots = resolveProjectRoots(["/repos/web/"], { gitRoot: probe([["/repos/web", "/repos/web"]]) });
    assert.equal(roots.get("/repos/web"), "/repos/web");
  });
});

describe("resolveProjectRoots — sibling inheritance", () => {
  test("an unresolved sibling inherits a unique resolved sibling's project", () => {
    // /wt/main-5 resolves via git; /wt/main-4's .git was removed. Both belong to
    // the same repository, and only the sibling rule can say so.
    const roots = resolveProjectRoots(["/wt/main-5", "/wt/main-4"], {
      gitRoot: probe([["/wt/main-5", CTAS_REPO]]),
    });
    assert.equal(roots.get("/wt/main-5"), CTAS_REPO);
    assert.equal(roots.get("/wt/main-4"), CTAS_REPO);
  });

  test("disagreeing siblings are not merged — each stands alone", () => {
    const roots = resolveProjectRoots(["/wt/a", "/wt/b", "/wt/c"], {
      gitRoot: probe([
        ["/wt/a", "/repo/one"],
        ["/wt/b", "/repo/two"],
      ]),
    });
    assert.equal(roots.get("/wt/a"), "/repo/one");
    assert.equal(roots.get("/wt/b"), "/repo/two");
    assert.equal(roots.get("/wt/c"), "/wt/c");
  });

  test("siblings under different parents never inherit from each other", () => {
    const roots = resolveProjectRoots(["/wt/one/a", "/wt/two/b"], {
      gitRoot: probe([["/wt/one/a", CTAS_REPO]]),
    });
    assert.equal(roots.get("/wt/one/a"), CTAS_REPO);
    assert.equal(roots.get("/wt/two/b"), "/wt/two/b");
  });
});

describe("buildTree — level assembly", () => {
  const rows = [
    {
      session_id: "mvs_root",
      title: "Root task",
      agent_name: "mavis",
      session_kind: "conversation",
      session_type: "branch",
      parent_session_id: null,
      workspace_dir: "/wt/main-5",
      status: "started",
      updated_at_ms: 200,
      created_at_ms: 200,
    },
    {
      session_id: "mvs_child",
      title: "Goal verification",
      agent_name: "verifier",
      session_kind: "task",
      session_type: "branch",
      parent_session_id: "mvs_root",
      workspace_dir: "/wt/main-5",
      status: "completed",
      updated_at_ms: 100,
      created_at_ms: 100,
    },
    {
      // A container row: no parent, but not a branch — never a sidebar entry.
      session_id: "mvs_container",
      title: "",
      agent_name: "mavis",
      session_kind: "conversation",
      session_type: "root",
      parent_session_id: null,
      workspace_dir: "/wt/main-5",
      status: "started",
      updated_at_ms: 300,
      created_at_ms: 300,
    },
  ];

  test("subagents nest under the session that spawned them", () => {
    const tree = buildTree(rows, new Map([["/wt/main-5", CTAS_REPO]]));
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, "CTAS");
    const directory = tree[0].directories[0];
    assert.equal(directory.name, "main-5");
    assert.equal(directory.sessions.length, 1, "only the branch session is a level-3 row");
    assert.equal(directory.sessions[0].id, "mvs_root");
    assert.deepEqual(
      directory.sessions[0].children.map((child) => child.id),
      ["mvs_child"],
    );
    assert.equal(directory.sessions[0].children[0].agent, "verifier");
  });

  test("a directory with no resolvable project stands on its own name", () => {
    const tree = buildTree([rows[0]], new Map());
    assert.equal(tree[0].name, "main-5");
  });

  test("sessionCount counts main sessions and their subagents", () => {
    const tree = buildTree(rows, new Map([["/wt/main-5", CTAS_REPO]]));
    assert.equal(tree[0].sessionCount, 2);
  });

  test("projects are ordered by most recent activity", () => {
    const other = { ...rows[0], session_id: "mvs_new", workspace_dir: "/wt/other", updated_at_ms: 900 };
    const tree = buildTree([...rows, other], new Map());
    assert.deepEqual(tree.map((project) => project.name), ["other", "main-5"]);
  });

  test("a user-set title overlays the runtime db's own title", () => {
    // A rename lands on the webui record as `titleCustom`, never in the runtime
    // db, so the sidebar only shows it because buildTree overlays it.
    const tree = buildTree(rows, new Map(), new Map([["mvs_root", "Renamed by hand"]]));
    assert.equal(tree[0].directories[0].sessions[0].title, "Renamed by hand");
  });

  test("an mcode session with no custom title keeps the db title", () => {
    const tree = buildTree(rows, new Map(), new Map([["mvs_someone_else", "Not this row"]]));
    assert.equal(tree[0].directories[0].sessions[0].title, "Root task");
    assert.equal(tree[0].directories[0].sessions[0].children[0].title, "Goal verification");
  });
});
