// webui/test/routes/worktrees.test.js
// The `/api/worktrees` family (placeholder batch PB-3) — the 工作树 page's
// two windows over `services.managedWorktrees`.
//
// Hermetic by construction: both handlers take an optional FOURTH argument
// that reaches the engine facade's `deps.getServices` seam, so these tests
// hand in a fake owner graph — no runtime boot, no network, no temporary
// directory, no spawned server.
//
// SIX invariants, in the order they matter:
//
//   1. THE THREE-STATE GATE STAYS THREE STATES. No host → 503, a host with
//      no `services` → 501, an owner graph without `managedWorktrees` → 501.
//      None of them may answer 200 with an empty list: a 工作树 page that
//      says "nothing to clean up" for a runtime that failed to boot tells
//      the user their project is clean when it was never read.
//   2. THE LIST IS THE ENGINE'S ENVELOPE, FIELD FOR FIELD. Rows pass
//      through unchanged — in particular `lastModifiedMs` stays OPTIONAL,
//      because "no timestamp" is a real reading the page must be able to
//      show, and a coerced `0` would file a fresh worktree under
//      「7 天以上」.
//   3. A NON-GIT DIRECTORY IS A REPORT, NOT AN EMPTY LIST. `ok:false` plus
//      the engine's own `code`, with 200 — the request succeeded and the
//      engine reported a fact about the user's folder.
//   4. THE BROWSER-SUPPLIED PATH IS CONTAINMENT-GATED. A workspace outside
//      the allowed roots is refused with 403 before Git is invoked, on BOTH
//      endpoints, and a removal batch is refused as a whole rather than
//      item by item: an out-of-root repository is a forged request, not a
//      worktree that happened to fail.
//   5. REMOVAL VERDICTS PASS THROUGH PER ITEM. A batch where every item was
//      refused is `ok:true` with a full `failedItems` list; the reasons
//      reach the browser as the engine spelled them, narrowed to the closed
//      `WorktreeRemovalReason` set.
//   6. THE PAGE IS NOT A CREATE PAGE. No endpoint in this family creates
//      anything, and the engine's `remove` method is not reachable from
//      here — the desktop's 「一键移除」 is a batch action, and one removal
//      path means one failure shape.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const absFile = (rel) => join(import.meta.dirname, "..", "..", rel);
const route = await import(absPath("routes/worktrees.js"));
const engine = await import(absPath("engine/worktrees.js"));
const { ownsRequest } = await import(absPath("app.js"));

/** A stand-in for the Node ServerResponse. */
function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  return {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    done,
  };
}

/** A GET request carrying a query string. */
function getReq(url) {
  const req = new Readable({ read() {} });
  req.url = url;
  return req;
}

/** A POST request carrying `body` as JSON. */
function postReq(body) {
  const req = new Readable({ read() {} });
  req.url = "/api/worktrees/remove";
  process.nextTick(() => {
    req.push(JSON.stringify(body));
    req.push(null);
  });
  return req;
}

/**
 * A fake owner graph exposing only what the route touches. `list` and
 * `removeBatch` record their arguments so the tests can assert the wiring
 * rather than only the payload.
 */
function fakeServices(overrides = {}) {
  const calls = { list: [], removeBatch: [] };
  const managedWorktrees = {
    async list(workspace) {
      calls.list.push(workspace);
      return overrides.list ? overrides.list(workspace) : { success: true, worktrees: [] };
    },
    async removeBatch(items, activeWorktreeDir) {
      calls.removeBatch.push({ items, activeWorktreeDir });
      return overrides.removeBatch
        ? overrides.removeBatch(items, activeWorktreeDir)
        : { success: true, removedPaths: [], failedItems: [] };
    },
  };
  return { services: { managedWorktrees }, calls };
}

async function readJsonBody(res) {
  await res.done;
  return JSON.parse(res.body);
}

describe("GET /api/worktrees — the three-state presence gate", () => {
  test("no host answers 503 and never an empty list", async () => {
    const res = fakeRes();
    const status = await route.handleGetWorktrees(
      getReq("/api/worktrees"),
      res,
      { cs: { workspace: { dir: homedir() } } },
      { getServices: async () => null },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 503);
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.code, "engine_host_unavailable");
    assert.equal("worktrees" in body, false, "a gate failure must not look like an empty list");
  });

  test("a host with no owner graph answers 501, not 503", async () => {
    const res = fakeRes();
    const status = await route.handleGetWorktrees(
      getReq("/api/worktrees"),
      res,
      { cs: { workspace: { dir: homedir() } } },
      { getServices: async () => undefined },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 501);
    assert.equal(body.code, "engine_services_unavailable");
  });

  test("an owner graph without the service answers 501 with its own code", async () => {
    const res = fakeRes();
    const status = await route.handleGetWorktrees(
      getReq("/api/worktrees"),
      res,
      { cs: { workspace: { dir: homedir() } } },
      { getServices: async () => ({ agent: {}, pinService: {} }) },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 501);
    assert.equal(body.code, "worktree_service_unavailable");
  });

  test("a throwing host getter becomes a 503 with a body, not a rejection", async () => {
    const res = fakeRes();
    const status = await route.handleGetWorktrees(
      getReq("/api/worktrees"),
      res,
      { cs: { workspace: { dir: homedir() } } },
      {
        getServices: async () => {
          throw new Error("runtime socket closed");
        },
      },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.match(body.error, /runtime socket closed/);
  });
});

describe("GET /api/worktrees — the payload is the engine's envelope", () => {
  const workspace = homedir();
  const rows = [
    {
      path: "/repo",
      branch: "main",
      head: "abc123",
      isMain: true,
      isLocked: false,
      isActive: true,
      isMcodeManaged: false,
      lastModifiedMs: 1_700_000_000_000,
    },
    {
      path: "/repo/.worktrees/feature",
      branch: "feature",
      head: "def456",
      isMain: false,
      isLocked: false,
      isActive: false,
      isMcodeManaged: true,
      // `lastModifiedMs` genuinely absent: the engine could read neither the
      // directory mtime nor the reflog. This must stay absent.
    },
  ];

  test("rows pass through unchanged, including the absent timestamp", async () => {
    const { services } = fakeServices({
      list: () => ({ success: true, current: "/repo", worktrees: rows }),
    });
    const res = fakeRes();
    await route.handleGetWorktrees(
      getReq(`/api/worktrees?workspace=${encodeURIComponent(workspace)}`),
      res,
      null,
      { getServices: async () => services },
    );
    const body = await readJsonBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.workspace, workspace);
    assert.equal(body.current, "/repo");
    assert.deepEqual(body.worktrees, rows);
    assert.equal("lastModifiedMs" in body.worktrees[1], false);
  });

  test("a non-git directory is reported with its code, not as an empty list", async () => {
    const { services } = fakeServices({
      list: () => ({
        success: false,
        worktrees: [],
        error: "fatal: not a git repository",
        code: "not_git_repository",
      }),
    });
    const res = fakeRes();
    await route.handleGetWorktrees(
      getReq(`/api/worktrees?workspace=${encodeURIComponent(workspace)}`),
      res,
      null,
      { getServices: async () => services },
    );
    const body = await readJsonBody(res);
    assert.equal(res.status, 200, "the request succeeded; the engine reported a fact");
    assert.equal(body.ok, false);
    assert.equal(body.code, "not_git_repository");
    assert.match(body.error, /not a git repository/);
  });

  test("the query parameter wins over the conversation workspace", async () => {
    const { services, calls } = fakeServices();
    const res = fakeRes();
    await route.handleGetWorktrees(
      getReq(`/api/worktrees?workspace=${encodeURIComponent(workspace)}`),
      res,
      { cs: { workspace: { dir: "/somewhere/else" } } },
      { getServices: async () => services },
    );
    assert.deepEqual(calls.list, [workspace]);
  });

  test("without a parameter the conversation workspace is used", async () => {
    const { services, calls } = fakeServices();
    const res = fakeRes();
    await route.handleGetWorktrees(getReq("/api/worktrees"), res, {
      cs: { workspace: { dir: workspace } },
    }, { getServices: async () => services });
    assert.deepEqual(calls.list, [workspace]);
  });

  test("neither source present is a 400, never a guess at the server's cwd", async () => {
    const res = fakeRes();
    const status = await route.handleGetWorktrees(
      getReq("/api/worktrees"),
      res,
      null,
      { getServices: async () => fakeServices().services },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 400);
    assert.equal(body.code, "no_workspace");
  });

  test("a workspace outside the allowed roots is refused before Git is called", async () => {
    const { services, calls } = fakeServices();
    const res = fakeRes();
    const status = await route.handleGetWorktrees(
      getReq("/api/worktrees?workspace=%2Fproc%2Fself%2Fenviron"),
      res,
      null,
      { getServices: async () => services },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 403);
    assert.equal(body.code, "workspace_outside_allowed_roots");
    assert.deepEqual(calls.list, [], "the engine must not be reached at all");
  });
});

describe("POST /api/worktrees/remove — per-item verdicts", () => {
  const workspace = homedir();

  test("a batch where every item was refused is ok:true with the reasons", async () => {
    const { services, calls } = fakeServices({
      removeBatch: () => ({
        success: true,
        removedPaths: [],
        failedItems: [
          { worktreeDir: "/repo", reason: "main_worktree", error: "The main worktree cannot be removed" },
          { worktreeDir: "/repo/.worktrees/a", reason: "dirty_worktree" },
          { worktreeDir: "/repo/.worktrees/b", reason: "active_worktree" },
          { worktreeDir: "/repo/.worktrees/c", reason: "locked_worktree" },
        ],
      }),
    });
    const res = fakeRes();
    const status = await route.handleRemoveWorktrees(
      postReq({
        items: [
          { workspace, worktreeDir: "/repo" },
          { workspace, worktreeDir: "/repo/.worktrees/a" },
          { workspace, worktreeDir: "/repo/.worktrees/b" },
          { workspace, worktreeDir: "/repo/.worktrees/c" },
        ],
      }),
      res,
      null,
      { getServices: async () => services },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 200);
    assert.equal(body.ok, true, "the request was carried out; nothing was removed");
    assert.deepEqual(body.removedPaths, []);
    assert.deepEqual(
      body.failedItems.map((item) => item.reason),
      ["main_worktree", "dirty_worktree", "active_worktree", "locked_worktree"],
      "the four refusals the acceptance criteria name must each survive verbatim",
    );
    assert.equal(calls.removeBatch.length, 1);
    assert.equal(calls.removeBatch[0].items.length, 4);
  });

  test("removed paths come back and the optional active dir is forwarded", async () => {
    const { services, calls } = fakeServices({
      removeBatch: () => ({
        success: true,
        removedPaths: ["/repo/.worktrees/gone"],
        failedItems: [],
      }),
    });
    const res = fakeRes();
    await route.handleRemoveWorktrees(
      postReq({
        items: [{ workspace, worktreeDir: "/repo/.worktrees/gone" }],
        activeWorktreeDir: workspace,
      }),
      res,
      null,
      { getServices: async () => services },
    );
    const body = await readJsonBody(res);
    assert.deepEqual(body.removedPaths, ["/repo/.worktrees/gone"]);
    assert.equal(calls.removeBatch[0].activeWorktreeDir, workspace);
  });

  test("a reason outside the closed set is reported as unknown, never raw", async () => {
    const { services } = fakeServices({
      removeBatch: () => ({
        success: true,
        removedPaths: [],
        failedItems: [{ worktreeDir: "/repo/.worktrees/x", reason: "brand_new_reason" }],
      }),
    });
    const res = fakeRes();
    await route.handleRemoveWorktrees(
      postReq({ items: [{ workspace, worktreeDir: "/repo/.worktrees/x" }] }),
      res,
      null,
      { getServices: async () => services },
    );
    const body = await readJsonBody(res);
    assert.equal(body.failedItems[0].reason, "unknown");
  });

  test("the gate fires before the body is even read as a removal", async () => {
    for (const [services, code, status] of [
      [null, "engine_host_unavailable", 503],
      [undefined, "engine_services_unavailable", 501],
      [{}, "worktree_service_unavailable", 501],
    ]) {
      const res = fakeRes();
      const written = await route.handleRemoveWorktrees(
        postReq({ items: [{ workspace, worktreeDir: "/repo/.worktrees/a" }] }),
        res,
        null,
        { getServices: async () => services },
      );
      const body = await readJsonBody(res);
      assert.equal(written, status);
      assert.equal(body.code, code);
    }
  });
});

describe("POST /api/worktrees/remove — the body is validated", () => {
  const workspace = homedir();
  const cases = [
    ["a missing items array", {}, "items must be a non-empty array"],
    ["an empty items array", { items: [] }, "items must be a non-empty array"],
    ["a non-object item", { items: ["x"] }, "items[0] must be an object"],
    ["a blank workspace", { items: [{ workspace: "  ", worktreeDir: "/a" }] }, "items[0].workspace must be a non-empty string"],
    ["a blank worktreeDir", { items: [{ workspace, worktreeDir: "" }] }, "items[0].worktreeDir must be a non-empty string"],
  ];
  for (const [name, body, error] of cases) {
    test(`${name} is a 400 and never reaches the engine`, async () => {
      const { services, calls } = fakeServices();
      const res = fakeRes();
      const status = await route.handleRemoveWorktrees(postReq(body), res, null, {
        getServices: async () => services,
      });
      const answer = await readJsonBody(res);
      assert.equal(status, 400);
      assert.equal(answer.code, "invalid_removal_request");
      assert.equal(answer.error, error);
      assert.deepEqual(calls.removeBatch, []);
    });
  }

  test("an out-of-root repository fails the whole batch, not one item", async () => {
    const { services, calls } = fakeServices();
    const res = fakeRes();
    const status = await route.handleRemoveWorktrees(
      postReq({
        items: [
          { workspace, worktreeDir: "/repo/.worktrees/a" },
          { workspace: "/proc/self/environ", worktreeDir: "/whatever" },
        ],
      }),
      res,
      null,
      { getServices: async () => services },
    );
    const body = await readJsonBody(res);
    assert.equal(status, 403);
    assert.equal(body.code, "workspace_outside_allowed_roots");
    assert.deepEqual(calls.removeBatch, []);
  });
});

describe("the family is a window, not a workspace manager", () => {
  test("the declaration covers exactly the two routes Hono owns", () => {
    assert.deepEqual(engine.WORKTREE_ROUTES, [
      "GET /api/worktrees",
      "POST /api/worktrees/remove",
    ]);
    for (const need of Object.values(engine.WORKTREE_ENDPOINTS)) {
      assert.equal(need.gate, "host-services");
      assert.equal(need.member, "services.managedWorktrees");
    }
    assert.equal(
      Object.values(engine.WORKTREE_ENDPOINTS).some((need) => need.method === "remove"),
      false,
      "the desktop action is a batch remove; a second single-row path would mean two failure shapes",
    );
  });

  test("Hono's own router serves both paths", () => {
    assert.equal(ownsRequest("GET", "/api/worktrees"), true);
    assert.equal(ownsRequest("POST", "/api/worktrees/remove"), true);
  });

  test("the ledger in app.js lists both paths", () => {
    const app = readFileSync(absFile("server/app.js"), "utf8");
    assert.match(app, /"GET \/api\/worktrees"/);
    assert.match(app, /"POST \/api\/worktrees\/remove"/);
  });

  test("no endpoint in this family creates a worktree", () => {
    const code = readFileSync(absFile("server/routes/worktrees.js"), "utf8");
    assert.doesNotMatch(code, /handleCreateWorktree|createWorktree|app\.post\(/);
    const engineCode = readFileSync(absFile("server/engine/worktrees.js"), "utf8");
    assert.doesNotMatch(engineCode, /services\.managedWorktrees\.create/);
  });
});
