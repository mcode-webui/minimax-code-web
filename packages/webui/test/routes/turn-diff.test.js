// webui/test/routes/turn-diff.test.js
// The `/api/turn-diff*` surface (webui-parity 83, ticket 80's plan B).
//
// The route handlers take their data source as an injected
// `deps.getDiffApplication`, so these tests drive a fake
// `applications.session.diff` instead of booting the runtime — hermetic, no
// environment, no spawned server, no temporary directory.
//
// The suite is organised around ONE invariant, because everything else is
// bookkeeping next to it:
//
//   **A request without an `assistantMessageId` must not reach the engine.**
//
// The engine's selector falls back to `latestForSession` when it is handed no
// id (`local-runtime/src/turns/diff-api.ts:209-220`), so a request that lost
// the coordinate on the way here would answer with ANOTHER turn's counts and —
// through the undo button — rewrite that turn's files. The tests therefore
// assert both halves: the empty answer, AND that the fake was never called.
// A fake-call counter is the only way to catch the regression where the route
// "helpfully" falls back to something.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const turnDiffRoute = await import(absPath("routes/turn-diff.js"));
const { ownsRequest } = await import(absPath("app.js"));

const SID = "mvs_8a72d81d93cf48df9ea5d4e750302c00";
const TURN_MSG = "ed8b9ddd-9bb0-4b06-a8fc-e863036830e3";

/** A stand-in for the Node ServerResponse, mirroring test/routes/git.test.js. */
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

function getReq(query = "") {
  return { url: `/api/turn-diff${query}` };
}

function postReq(path, payload) {
  const stream = Readable.from([Buffer.from(JSON.stringify(payload ?? {}), "utf8")]);
  stream.url = `/api/turn-diff${path}`;
  return stream;
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body || "{}");
}

/**
 * A fake `applications.session.diff` plus the call log. `calls` is the whole
 * point: a test asserts the engine was asked zero times or exactly once with
 * exactly this request, which is what "does not fall back" means concretely.
 */
function fakeDiff(overrides = {}) {
  const calls = [];
  const diff = {
    calls,
    async getTurnDiff(_ctx, req) {
      calls.push(["getTurnDiff", req]);
      return {
        changeSetId: "cs_ffc8873c6",
        sourceMessageId: req.assistantMessageId,
        status: "active",
        undoable: true,
        canUndo: false,
        canReapply: false,
        fileChanges: [{ file: "webui-turn.txt", additions: 2, deletions: 0, status: "added" }],
      };
    },
    async revertTurnDiff(_ctx, req) {
      calls.push(["revertTurnDiff", req]);
      return { success: true, turnDiff: { changeSetId: "cs_ffc8873c6", status: "reverted", canReapply: true } };
    },
    async reapplyTurnDiff(_ctx, req) {
      calls.push(["reapplyTurnDiff", req]);
      const { success, error, ...turnDiff } = {
        success: true,
        changeSetId: "cs_ffc8873c6",
        status: "active",
        canUndo: true,
      };
      return { success, error, ...turnDiff };
    },
    ...overrides,
  };
  return { diff, calls };
}

// --- 1. the no-fallback invariant ------------------------------------------

describe("a request without a turn coordinate never reaches the engine", () => {
  test("GET without assistantMessageId answers empty and calls nothing", async () => {
    const { diff, calls } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(getReq(`?sessionId=${SID}`), res, {}, { getDiffApplication: async () => diff });
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, turnDiff: null });
    assert.equal(calls.length, 0, "the engine must not be consulted for a coordinate-less turn");
  });

  test("GET with a blank assistantMessageId is the same case", async () => {
    const { diff, calls } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(getReq(`?sessionId=${SID}&assistantMessageId=%20`), res, {}, { getDiffApplication: async () => diff });
    await readBody(res);
    assert.equal(calls.length, 0);
  });

  test("revert without assistantMessageId is a no-op, not a latest-turn revert", async () => {
    const { diff, calls } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiffRevert(postReq("/revert", { sessionId: SID }), res, {}, { getDiffApplication: async () => diff });
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, turnDiff: null });
    assert.equal(calls.length, 0, "an undo with no coordinate must not touch the workspace");
  });

  test("reapply without assistantMessageId is a no-op too", async () => {
    const { diff, calls } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiffReapply(postReq("/reapply", { sessionId: SID }), res, {}, { getDiffApplication: async () => diff });
    await readBody(res);
    assert.equal(calls.length, 0);
  });

  test("the runtime is not even resolved when there is no coordinate", async () => {
    // A stricter form of the same rule: booting the catalogue host for a
    // request that cannot use it would be a real cost (the host owns a
    // CliService) for a guaranteed-empty answer.
    let resolved = 0;
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(getReq(`?sessionId=${SID}`), res, {}, {
      getDiffApplication: async () => {
        resolved += 1;
        return fakeDiff().diff;
      },
    });
    await readBody(res);
    assert.equal(resolved, 0);
  });
});

// --- 2. a real coordinate reaches the engine --------------------------------

describe("a real coordinate is passed through verbatim", () => {
  test("GET forwards the id and projects the record", async () => {
    const { diff, calls } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(
      getReq(`?sessionId=${SID}&assistantMessageId=${TURN_MSG}`),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "getTurnDiff");
    // The selector is EXACTLY the id the transcript carried — no
    // normalisation, no default, nothing added.
    assert.deepEqual(calls[0][1], { id: SID, assistantMessageId: TURN_MSG });
    assert.equal(body.turnDiff.changeSetId, "cs_ffc8873c6");
    assert.equal(body.turnDiff.fileChanges[0].additions, 2);
  });

  test("an unknown assistantMessageId is an empty record, NOT the latest turn", async () => {
    // The middle of the three degradation tiers, and the one that decides
    // whether a stale card can undo the wrong files. A fake that mirrors the
    // real engine: an id it does not know yields an all-undefined view, and
    // ONLY a selector-less request would have reached `latestForSession`.
    const UNKNOWN = "00000000-0000-4000-8000-000000000000";
    const { diff, calls } = fakeDiff({
      async getTurnDiff(_ctx, req) {
        calls.push(["getTurnDiff", req]);
        if (req.assistantMessageId !== TURN_MSG) {
          return { fileChanges: [] };
        }
        return {
          changeSetId: "cs_ffc8873c6",
          sourceMessageId: TURN_MSG,
          canUndo: true,
          fileChanges: [{ file: "webui-turn.txt", additions: 2, deletions: 0 }],
        };
      },
    });
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(
      getReq(`?sessionId=${SID}&assistantMessageId=${UNKNOWN}`),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.equal(res.status, 200);
    // The unknown id was forwarded verbatim, so the engine — not the route —
    // decided this turn has no record.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], { id: SID, assistantMessageId: UNKNOWN });
    assert.deepEqual(body.turnDiff, { fileChanges: [] });
    // The point: the route substituted nothing. A "helpful" default would have
    // answered with TURN_MSG's `+2` and an undo button pointed at another turn.
    assert.notEqual(JSON.stringify(body.turnDiff).includes("cs_ffc8873c6"), true);
  });

  test("the answer carries no previewState, which this path never fills", async () => {
    // The protocol declares the field; the runtime leaves it undefined. A
    // route that started inventing one would be promising a contract the
    // engine does not keep.
    const { diff } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(
      getReq(`?sessionId=${SID}&assistantMessageId=${TURN_MSG}`),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.equal("previewState" in body.turnDiff, false);
  });

  test("a bad sessionId is a 400 and still calls nothing", async () => {
    const { diff, calls } = fakeDiff();
    for (const bad of ["", "not-a-session", "mvs_short", "../../etc/passwd"]) {
      const res = fakeRes();
      await turnDiffRoute.handleTurnDiff(
        getReq(`?sessionId=${encodeURIComponent(bad)}&assistantMessageId=${TURN_MSG}`),
        res,
        {},
        { getDiffApplication: async () => diff },
      );
      const body = await readBody(res);
      assert.equal(res.status, 400, `sessionId ${JSON.stringify(bad)}`);
      assert.equal(body.code, "invalidRequest");
    }
    assert.equal(calls.length, 0);
  });

  test("revert forwards the id and answers the new state", async () => {
    const { diff, calls } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiffRevert(
      postReq("/revert", { sessionId: SID, assistantMessageId: TURN_MSG }),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.deepEqual(calls[0][1], { id: SID, assistantMessageId: TURN_MSG });
    assert.equal(body.turnDiff.status, "reverted");
    assert.equal(body.turnDiff.canReapply, true);
  });

  test("reapply answers the diff fields, not a nested envelope", async () => {
    const { diff, calls } = fakeDiff();
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiffReapply(
      postReq("/reapply", { sessionId: SID, assistantMessageId: TURN_MSG }),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.equal(calls[0][0], "reapplyTurnDiff");
    assert.equal(body.turnDiff.changeSetId, "cs_ffc8873c6");
    assert.equal(body.turnDiff.success, undefined, "the success flag is not a diff field");
  });
});

// --- 3. the engine's refusals are passed through, not flattened ------------

describe("the engine's own refusals reach the client intact", () => {
  test("the only-latest gate keeps its 409 and its message", async () => {
    // `AppError(409, "TURN_DIFF_CONFLICT", …)` is how the engine refuses to
    // revert a non-latest turn. Flattening it into 200 would leave the card
    // unable to say why the undo did nothing.
    const { diff, calls } = fakeDiff({
      async revertTurnDiff() {
        calls.push(["revertTurnDiff"]);
        const error = new Error("Only the latest turn diff can be changed");
        error.status = 409;
        error.key = "TURN_DIFF_CONFLICT";
        throw error;
      },
    });
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiffRevert(
      postReq("/revert", { sessionId: SID, assistantMessageId: TURN_MSG }),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.equal(res.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.code, "TURN_DIFF_CONFLICT");
    assert.match(body.error, /Only the latest turn diff/);
  });

  test("an unknown session keeps its 404", async () => {
    const { diff } = fakeDiff({
      async getTurnDiff() {
        const error = new Error("Session not found: " + SID);
        error.status = 404;
        error.key = "SESSION_NOT_FOUND";
        throw error;
      },
    });
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(
      getReq(`?sessionId=${SID}&assistantMessageId=${TURN_MSG}`),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.equal(res.status, 404);
    assert.equal(body.code, "SESSION_NOT_FOUND");
  });

  test("a `{success:false}` mutation is a 409, not a silent success", async () => {
    const { diff } = fakeDiff({ async revertTurnDiff() { return { success: false, error: "conflict on disk" }; } });
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiffRevert(
      postReq("/revert", { sessionId: SID, assistantMessageId: TURN_MSG }),
      res,
      {},
      { getDiffApplication: async () => diff },
    );
    const body = await readBody(res);
    assert.equal(res.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.error, "conflict on disk");
  });

  test("a runtime that never booted answers RUNTIME_UNAVAILABLE", async () => {
    const res = fakeRes();
    await turnDiffRoute.handleTurnDiff(
      getReq(`?sessionId=${SID}&assistantMessageId=${TURN_MSG}`),
      res,
      {},
      { getDiffApplication: async () => null },
    );
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.code, "RUNTIME_UNAVAILABLE");
  });
});

// --- 4. the exposed surface is the diff, and only the diff -----------------

describe("the route exposes session.diff and nothing else", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "..", "server", "routes", "turn-diff.js"),
    "utf8",
  );
  // The tripwires below are about CODE. The file's prose names `lifecycle`
  // precisely to explain why it is not used, so comments are stripped before
  // the grep — otherwise the explanation would trip its own guard.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

  test("it never reaches for session.lifecycle, which can delete a session", () => {
    assert.ok(!code.includes("lifecycle"), "the applications tree's lifecycle member is off limits");
    assert.ok(!/deleteSession/.test(code), "and no session deletion is spelled out either");
  });

  test("the only member of the applications tree it touches is session.diff", () => {
    // One assertion over EVERY `applications` occurrence, so a future
    // `applications.queue.…` (which can enqueue work) is caught as surely as
    // a lifecycle call. The path must always be `applications` → `session` and
    // stop there.
    const occurrences = [...code.matchAll(/applications\s*(?:\?\s*)?\.(\w+)/g)].map((m) => m[1]);
    assert.ok(occurrences.length > 0, "sanity: the route must dereference applications at all");
    for (const member of occurrences) {
      assert.equal(member, "session", `applications.${member} is outside this route's contract`);
    }
    // And the leaf it keeps is the diff, reached through that same member.
    assert.ok(/applications\.session\?\.diff/.test(code));
  });

  test("it never hands the whole applications handle to a caller", () => {
    // A route that returned `host.applications` would publish queue, lifecycle
    // and everything else the runtime grows next year.
    assert.ok(!/return\s+host\.applications\b/.test(code));
    assert.ok(!/=\s*host\s*;/.test(code), "the host itself is never captured for a caller");
  });

  test("auth, rate limit and read-only are inherited, not re-implemented", () => {
    for (const forbidden of ["runGates", "rateLimit", "isRequestAuthorized", "getReadOnly", "getLanBroadcast"]) {
      assert.ok(!code.includes(forbidden), `${forbidden} belongs to lib/gates.js`);
    }
  });
});

// --- 5. the routes are registered where the dispatcher expects them ---------

describe("the turn-diff routes are owned by the Hono layer", () => {
  for (const [method, path] of [
    ["GET", "/api/turn-diff"],
    ["POST", "/api/turn-diff/revert"],
    ["POST", "/api/turn-diff/reapply"],
  ]) {
    test(`${method} ${path} is owned`, () => {
      assert.equal(ownsRequest(method, path), true, `${method} ${path} must be listed in OWNED_ROUTES`);
    });
  }
});
