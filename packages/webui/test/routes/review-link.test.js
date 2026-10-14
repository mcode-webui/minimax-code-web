// webui/test/routes/review-link.test.js
// PB-16 (`doc/placeholder-batch-plan.md` §6.3) — the window over
// `cliService.getWorkspaceReviewLink` that backs the 「Review」 button on the
// edited-files card.
//
// Hermetic by construction: the handler takes an optional fourth argument
// that reaches the engine facade's `getHost` seam, so every test drives a
// fake `host` — no runtime boot, no network, no temporary directory, no
// spawned server.
//
// SEVEN invariants, in the order they matter:
//
//   1. THE SESSION ID NEVER COMES FROM THE REQUEST. Every answer reads it
//      from `ctx.cs.mcodeSessionId`, the same rule `/api/queue` and
//      `/api/follow-up` follow. A query parameter naming another
//      conversation must not change whose review is read — and the test
//      proves it by supplying one and asserting the engine saw the ctx's.
//   2. THE WORKSPACE IS THE ENGINE'S ANSWER, NOT A PARAMETER. The store is
//      keyed by `<workspaceDir>\n<branch>`
//      (packages/local-runtime/src/review-link/store.ts), so a
//      client-supplied directory would be a client-supplied read key.
//   3. NO RECORD IS 200, NOT AN ERROR. A repository nobody ran `gh pr view`
//      on is the ordinary case; it answers with `reviewLink:null` and a
//      reason, never a 4xx and never a 200 that omits the reason.
//   4. A HALF-RECORD IS DROPPED WHOLE. The engine's answer is a widened
//      `Record<string, unknown>`; an entry missing its url, or carrying a
//      non-http scheme, must not become a clickable control.
//   5. NO HOST / NO MEMBER IS 503 / 501 AND NEVER "NO REVIEW". A runtime
//      that failed to boot has no review to report, and answering
//      "there is none" would be the fake-empty shape #110 exists to
//      prevent.
//   6. A DECLARED-AWAY CAPABILITY KEEPS THE SHARED 501 PAYLOAD. The
//      frontend already treats `engine_capability_not_supported` as "hide
//      the entry point"; a second vocabulary for the same fact would
//      break it.
//   7. NOTHING IS CALLED AFTER A GATE FAILS. A status-only assertion would
//      not notice that `getWorkspaceReviewLink` ran anyway, so the fake
//      records every call.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const reviewRoute = await import(absPath("routes/review-link.js"));
const reviewEngine = await import(absPath("engine/review-link.js"));
const { EngineCapabilityNotSupportedError } = await import(absPath("engine/errors.js"));

const SESSION = "mvs_session_for_review_link";
const WORKSPACE = "/workspace/demo";

/** A recorded entry, exactly as `LocalReviewLinkStore` spells it. */
const RECORDED = {
  vendor: "github",
  url: "https://github.com/acme/demo/pull/42",
  number: 42,
  branch: "feat/review",
  origin: "created",
  recordedAt: 1_700_000_000_000,
};

/** A stand-in for the Node ServerResponse. */
function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  return {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    done,
  };
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body);
}

const ctx = (sessionId) => ({ cid: "c", cs: { mcodeSessionId: sessionId } });

function fakeReq(query = "") {
  const req = { url: `/api/review-link${query}`, method: "GET", headers: {} };
  return req;
}

/**
 * A fake host whose review calls are counted, so a test can assert a method
 * was NOT reached.
 */
function fakeHost(overrides = {}) {
  const calls = [];
  const host = {
    calls,
    adapter: {
      getSession: async (sessionId) => {
        calls.push(["getSession", sessionId]);
        return { sessionId, workspaceDir: WORKSPACE };
      },
    },
    cliService: {
      getWorkspaceGitMetadata: async (dir) => {
        calls.push(["getWorkspaceGitMetadata", dir]);
        return { isGitRepo: true, branch: "feat/review", hasHead: true };
      },
      getWorkspaceReviewLink: async (dir, branch) => {
        calls.push(["getWorkspaceReviewLink", dir, branch]);
        return { ...RECORDED };
      },
    },
  };
  return { ...host, ...overrides, calls };
}

/** Run the handler and return `{status, body}`. */
async function run({ host, ctxValue = ctx(SESSION), query = "" } = {}) {
  const res = fakeRes();
  await reviewRoute.handleReviewLink(fakeReq(query), res, ctxValue, {
    getHost: async () => host,
  });
  return { status: res.status, body: await readBody(res) };
}

describe("GET /api/review-link — the recorded review", () => {
  test("passes the engine's own record through, unchanged", async () => {
    const host = fakeHost();
    const { status, body } = await run({ host });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.reason, null);
    assert.equal(body.branch, "feat/review");
    assert.deepEqual(body.reviewLink, RECORDED);
  });

  test("invariant 1: the engine session id comes from ctx, not from the query", async () => {
    const host = fakeHost();
    // A forged query naming another conversation must not reach the engine.
    const { status } = await run({
      host,
      query: "?cid=someone-else&sessionId=mvs_victim",
    });
    assert.equal(status, 200);
    const sessionCall = host.calls.find(([name]) => name === "getSession");
    assert.deepEqual(sessionCall, ["getSession", SESSION]);
  });

  test("invariant 2: the workspace and branch are the engine's own reads", async () => {
    const host = fakeHost();
    await run({ host });
    assert.deepEqual(
      host.calls.find(([name]) => name === "getWorkspaceGitMetadata"),
      ["getWorkspaceGitMetadata", WORKSPACE],
    );
    assert.deepEqual(
      host.calls.find(([name]) => name === "getWorkspaceReviewLink"),
      ["getWorkspaceReviewLink", WORKSPACE, "feat/review"],
    );
  });

  test("a tab with no engine session answers 400 and calls nothing", async () => {
    const host = fakeHost();
    const { status, body } = await run({ host, ctxValue: ctx("") });
    assert.equal(status, 400);
    assert.equal(body.code, "no_active_conversation");
    assert.deepEqual(host.calls, []);
  });
});

describe("GET /api/review-link — the honest absences", () => {
  test("invariant 3: no recorded review is 200 with a reason", async () => {
    const host = fakeHost({
      cliService: {
        getWorkspaceGitMetadata: async () => ({ branch: "feat/review" }),
        getWorkspaceReviewLink: async () => undefined,
      },
    });
    const { status, body } = await run({ host });
    assert.equal(status, 200);
    assert.equal(body.reviewLink, null);
    assert.equal(body.reason, "no_review_link");
    assert.equal(body.branch, "feat/review");
  });

  test("a session the engine does not know answers 200 / unknown_workspace", async () => {
    const host = fakeHost({ adapter: { getSession: async () => null } });
    const { status, body } = await run({ host });
    assert.equal(status, 200);
    assert.equal(body.reviewLink, null);
    assert.equal(body.reason, "unknown_workspace");
    assert.deepEqual(
      host.calls.filter(([name]) => name.startsWith("getWorkspace")),
      [],
    );
  });

  test("a detached HEAD answers 200 / no_branch without a review read", async () => {
    const host = fakeHost({
      cliService: {
        getWorkspaceGitMetadata: async () => ({ branch: "", hasHead: false }),
        getWorkspaceReviewLink: async () => ({ ...RECORDED }),
      },
    });
    const { status, body } = await run({ host });
    assert.equal(status, 200);
    assert.equal(body.reason, "no_branch");
    assert.equal(
      host.calls.some(([name]) => name === "getWorkspaceReviewLink"),
      false,
    );
  });

  test("invariant 4: a record without a usable url is dropped whole", async () => {
    for (const broken of [
      { ...RECORDED, url: undefined },
      { ...RECORDED, url: "javascript:alert(1)" },
      { ...RECORDED, url: "not a url" },
      { ...RECORDED, vendor: "bitbucket" },
      { ...RECORDED, number: 0 },
      { ...RECORDED, branch: "" },
      "a string",
      null,
    ]) {
      const host = fakeHost({
        cliService: {
          getWorkspaceGitMetadata: async () => ({ branch: "feat/review" }),
          getWorkspaceReviewLink: async () => broken,
        },
      });
      const { status, body } = await run({ host });
      assert.equal(status, 200, `for ${JSON.stringify(broken)}`);
      assert.equal(body.reviewLink, null, `for ${JSON.stringify(broken)}`);
      assert.equal(body.reason, "no_review_link", `for ${JSON.stringify(broken)}`);
    }
  });
});

describe("GET /api/review-link — the gate failures", () => {
  test("invariant 5: no host is 503 and nothing is called", async () => {
    const res = fakeRes();
    const status = await reviewRoute.handleReviewLink(
      fakeReq(),
      res,
      ctx(SESSION),
      { getHost: async () => null },
    );
    assert.equal(status, 503);
    assert.equal((await readBody(res)).code, "engine_host_unavailable");
  });

  test("a host that throws answers 503 with its own message", async () => {
    const res = fakeRes();
    const status = await reviewRoute.handleReviewLink(fakeReq(), res, ctx(SESSION), {
      getHost: async () => {
        throw new Error("runtime boot failed");
      },
    });
    assert.equal(status, 503);
    assert.match((await readBody(res)).error, /runtime boot failed/);
  });

  test("invariant 7: a missing review method is 501 and the branch is never read", async () => {
    const base = fakeHost();
    const host = {
      ...base,
      cliService: {
        getWorkspaceGitMetadata: base.cliService.getWorkspaceGitMetadata,
      },
    };
    const { status, body } = await run({ host });
    assert.equal(status, 501);
    assert.equal(body.code, "engine_member_unavailable");
    assert.equal(
      host.calls.some(([name]) => name === "getWorkspaceGitMetadata"),
      false,
    );
  });

  test("a missing branch read is 501 / engine_git_metadata_unavailable", async () => {
    const base = fakeHost();
    const host = {
      ...base,
      cliService: { getWorkspaceReviewLink: base.cliService.getWorkspaceReviewLink },
    };
    const { status, body } = await run({ host });
    assert.equal(status, 501);
    assert.equal(body.code, "engine_git_metadata_unavailable");
  });

  test("a missing session reader is 501 / engine_session_reader_unavailable", async () => {
    const base = fakeHost();
    const { status, body } = await run({ host: { ...base, adapter: {} } });
    assert.equal(status, 501);
    assert.equal(body.code, "engine_session_reader_unavailable");
  });

  test("invariant 6: a declared-away capability keeps the shared 501 payload", async () => {
    const host = fakeHost({
      cliService: {
        getWorkspaceGitMetadata: async () => ({ branch: "feat/review" }),
        getWorkspaceReviewLink: async () => {
          throw new EngineCapabilityNotSupportedError({
            capability: "gitOperations",
            provider: "local-runtime-v2",
            missing: ["getWorkspaceReviewLink"],
          });
        },
      },
    });
    const { status, body } = await run({ host });
    assert.equal(status, 501);
    assert.equal(body.code, "engine_capability_not_supported");
    assert.equal(body.capability, "gitOperations");
    assert.deepEqual(body.missing, ["getWorkspaceReviewLink"]);
  });

  test("an ordinary engine failure is a 200 refusal, never a link", async () => {
    const host = fakeHost({
      cliService: {
        getWorkspaceGitMetadata: async () => ({ branch: "feat/review" }),
        getWorkspaceReviewLink: async () => {
          throw new Error("git exploded");
        },
      },
    });
    const { status, body } = await run({ host });
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.code, "review_link_failed");
    assert.match(body.error, /git exploded/);
  });
});

describe("projectReviewLink", () => {
  test("keeps the six fields the store records and adds none", () => {
    assert.deepEqual(reviewEngine.projectReviewLink(RECORDED), RECORDED);
  });

  test("accepts both vendors and both origins", () => {
    for (const vendor of ["github", "gitlab"]) {
      for (const origin of ["created", "viewed"]) {
        const projected = reviewEngine.projectReviewLink({ ...RECORDED, vendor, origin });
        assert.equal(projected.vendor, vendor);
        assert.equal(projected.origin, origin);
      }
    }
  });

  test("rejects arrays and non-objects outright", () => {
    assert.equal(reviewEngine.projectReviewLink([RECORDED]), null);
    assert.equal(reviewEngine.projectReviewLink(7), null);
    assert.equal(reviewEngine.projectReviewLink(undefined), null);
  });
});