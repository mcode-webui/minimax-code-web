// webapp/test/turn-diff-api.test.ts
//
// The client half of webui-parity 83: the three `/api/turn-diff*` wrappers and
// the projection the card reads.
//
// Two things are load-bearing, and both are invisible to a type checker:
//
//   1. **The coordinate is not optional.** The engine's selector degrades to
//      "the session's latest turn" when it is handed no `assistantMessageId`,
//      so a wrapper whose parameter had a default would make the wrong turn's
//      diff reachable from a forgetting call site. Every signature here takes
//      it as a required `string`, and a source tripwire holds that line.
//
//   2. **The 409 keeps its sentence.** "Only the latest turn diff can be
//      changed" is the only thing that tells the user why the undo did
//      nothing; a client that wrapped it in a generic error would delete the
//      explanation. `request` throws on a non-2xx, and the message it builds
//      is the engine's own — this suite proves the whole chain preserves it.
//
// `fetch` is stubbed, so nothing here talks to a server, and no turn is
// invented: the fixtures are the shapes the real engine returned.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getTurnDiff,
  reapplyTurnDiff,
  revertTurnDiff,
  type TurnDiffResult,
} from "../lib/api";
import { normaliseTurnDiff, turnDiffFailureOf } from "../lib/turn-diff";

const here = dirname(fileURLToPath(import.meta.url));
const apiSource = readFileSync(join(here, "..", "lib", "api.ts"), "utf8");

const SID = "mvs_8a72d81d93cf48df9ea5d4e750302c00";
const TURN_A = "ed8b9ddd-9bb0-4b06-a8fc-e863036830e3";
const TURN_B = "8c3ac6a7-3fb7-483a-99a5-233467adfc31";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const originalFetch = globalThis.fetch;

/**
 * Install a fetch stub that answers with `respond(body, status)` and record
 * what was sent. The stub is restored even when an assertion throws, so a
 * red test cannot poison the next one.
 */
async function withFetch(
  respond: (req: Recorded) => { status?: number; body: unknown },
  run: (calls: Recorded[]) => Promise<void>,
): Promise<void> {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const record: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(record);
    const { status = 200, body } = respond(record);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- 1. the three wrappers, on the wire ------------------------------------

describe("the turn-diff wrappers name the turn on every call", () => {
  test("GET carries both coordinates in the query", async () => {
    await withFetch(
      () => ({ body: { ok: true, turnDiff: null } }),
      async (calls) => {
        await getTurnDiff(SID, TURN_A);
        assert.equal(calls.length, 1);
        const sent = calls[0]!;
        assert.equal(sent.url, `/api/turn-diff?sessionId=${SID}&assistantMessageId=${TURN_A}`);
        assert.equal(sent.method, "GET");
        assert.equal(sent.body, undefined, "a read sends no body");
      },
    );
  });

  test("revert POSTs the coordinate as JSON", async () => {
    await withFetch(
      () => ({ body: { ok: true, turnDiff: null } }),
      async (calls) => {
        await revertTurnDiff(SID, TURN_A);
        const sent = calls[0]!;
        assert.equal(sent.url, "/api/turn-diff/revert");
        assert.equal(sent.method, "POST");
        assert.equal(sent.headers["content-type"], "application/json");
        assert.deepEqual(sent.body, { sessionId: SID, assistantMessageId: TURN_A });
      },
    );
  });

  test("reapply POSTs the same coordinate to its own path", async () => {
    await withFetch(
      () => ({ body: { ok: true, turnDiff: null } }),
      async (calls) => {
        await reapplyTurnDiff(SID, TURN_B);
        const sent = calls[0]!;
        assert.equal(sent.url, "/api/turn-diff/reapply");
        assert.equal(sent.method, "POST");
        assert.deepEqual(sent.body, { sessionId: SID, assistantMessageId: TURN_B });
      },
    );
  });

  test("the coordinate is a required parameter, never defaulted", () => {
    // The tripwire: `assistantMessageId?: string` or `= ""` in any of the three
    // signatures would make a selector-less request — and therefore the
    // engine's "latest turn" fallback — a compile-clean call away.
    for (const name of ["getTurnDiff", "revertTurnDiff", "reapplyTurnDiff"]) {
      const signature = new RegExp(
        `export function ${name}\\(\\s*\\n?\\s*sessionId: string,\\s*\\n?\\s*assistantMessageId: string,`,
      );
      assert.ok(
        signature.test(apiSource),
        `${name} must take a required assistantMessageId: string`,
      );
    }
  });
});

// --- 2. the 409 keeps its sentence -----------------------------------------

describe("a refused mutation reaches the caller with the engine's own words", () => {
  test("the only-latest gate surfaces verbatim", async () => {
    const sentence = "Only the latest turn diff can be changed";
    await withFetch(
      () => ({ status: 409, body: { ok: false, code: "TURN_DIFF_CONFLICT", error: sentence } }),
      async () => {
        await assert.rejects(
          () => revertTurnDiff(SID, TURN_A),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, sentence);
            return true;
          },
        );
      },
    );
  });

  test("and it is classified as a conflict, not a generic failure", async () => {
    const failure = turnDiffFailureOf(new Error("Only the latest turn diff can be changed"));
    assert.equal(failure.kind, "conflict");
    assert.match(failure.message, /Only the latest turn diff/);
  });

  test("a missing runtime is its own kind", () => {
    assert.equal(turnDiffFailureOf(new Error("runtime unavailable")).kind, "unavailable");
    assert.equal(turnDiffFailureOf("socket hang up").kind, "other");
  });
});

// --- 3. the three degradation tiers, on the client -------------------------

describe("an answer with no record never becomes a record", () => {
  test("a real record is projected and undefined fields are dropped", async () => {
    const payload: TurnDiffResult = {
      ok: true,
      turnDiff: {
        fileChanges: [{ file: "webui-turn.txt", additions: 2, deletions: 0, status: "added" }],
        sourceMessageId: TURN_A,
        changeSetId: "cs_ffc8873c6",
        status: "active",
        undoable: true,
        canUndo: true,
        canReapply: false,
      },
    };
    await withFetch(() => ({ body: payload }), async (calls) => {
      const result = await getTurnDiff(SID, TURN_A);
      const diff = normaliseTurnDiff(result.turnDiff);
      assert.ok(diff);
      assert.equal(diff.changeSetId, "cs_ffc8873c6");
      assert.equal(diff.fileChanges[0]?.additions, 2);
      assert.equal("canReapply" in diff, true);
      // Absent stays absent: the engine did not fill `patch`, so the card
      // must not read `false` there.
      assert.equal(Object.hasOwn(diff, "previewState"), false);
    });
  });

  test("an unknown id (fileChanges empty) is no record at all", () => {
    // What the engine returns for an `assistantMessageId` it does not know.
    assert.equal(normaliseTurnDiff({ fileChanges: [] }), null);
  });

  test("no coordinate on the request is the same null", async () => {
    await withFetch(() => ({ body: { ok: true, turnDiff: null } }), async () => {
      const result = await getTurnDiff(SID, TURN_A);
      assert.equal(result.turnDiff, null);
      assert.equal(normaliseTurnDiff(result.turnDiff), null);
    });
  });

  test("a record with no changeSetId selected nothing", () => {
    // The engine's all-undefined view, should it ever arrive with a stray
    // fileChanges array. Still no record: there is no change set to undo.
    assert.equal(normaliseTurnDiff({ fileChanges: [{ file: "x", additions: 1, deletions: 0 }] }), null);
    assert.equal(normaliseTurnDiff(undefined), null);
    assert.equal(normaliseTurnDiff("nonsense"), null);
  });

  test("a file entry without a path is dropped, not rendered", () => {
    const diff = normaliseTurnDiff({
      changeSetId: "cs_1",
      fileChanges: [{ file: "a.ts", additions: 1, deletions: 0 }, { additions: 2, deletions: 0 }, null],
    });
    assert.equal(diff?.fileChanges.length, 1);
    assert.equal(diff?.fileChanges[0]?.file, "a.ts");
  });
});
