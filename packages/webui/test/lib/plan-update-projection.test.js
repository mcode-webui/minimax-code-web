// webui/test/lib/plan-update-projection.test.js
// Ticket 70 — the plan modal's payload mapping was invented, not read.
//
// The engine's ONLY plan_update producer is the ACP bridge in
// packages/tui/src/acp/agent.ts:1356, and it sends
//
//   { sessionUpdate:'plan_update', plan:{ type:'markdown', planId, content } }
//
// The projection in server/lib/mcode-acp.js read `planId` / `title` /
// `summary` / `options` off the TOP level of the update, where the engine
// puts none of them. Every field therefore landed empty: `plan.active` was
// true with an empty title, an empty summary and no options — a blank
// dialog whose three buttons posted to a no-op endpoint.
//
// This drives the real streamAcpPrompt with a fake ACP client and asserts
// the projection reads the shape the engine actually sends. It is a
// behaviour test, not a source pin: reverting the mapping turns it red
// because the projected fields go empty, not because a string changed.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";

// Isolation FIRST — lib/config.js resolves SESSIONS_DB from
// MCODE_WEBUI_DATA_DIR at import time.
const _tmpDataDir = mkTmpDir("webui-plan-projection-");
process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;

const WEBUI_DIR = resolve(import.meta.dirname, "..", "..");
const SERVER_DIR = resolve(WEBUI_DIR, "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;
const absWebuiPath = (rel) => pathToFileURL(resolve(WEBUI_DIR, rel)).href;

class FakeMcodeAcpClient {
  static lastOnChunk = null;
  static pending = [];

  static reset() {
    this.lastOnChunk = null;
    this.pending = [];
  }

  static emit(chunk) {
    const cb = this.lastOnChunk;
    if (!cb) throw new Error("no live prompt callback");
    cb(chunk);
  }

  static release(extra = {}) {
    const resolveFn = this.pending.shift();
    if (resolveFn) {
      resolveFn({
        answer: null,
        thinking: null,
        stopReason: "end_turn",
        usage: null,
        ...extra,
      });
    }
  }

  constructor() {}
  async start() {}
  async newSession() {
    return { sessionId: "mvs_fake_plan", configOptions: [] };
  }
  async loadSession(sessionId) {
    return { sessionId, configOptions: [] };
  }
  async request() {
    return {};
  }
  prompt(_sessionId, _blocks, onChunk) {
    FakeMcodeAcpClient.lastOnChunk = onChunk;
    return new Promise((resolveFn) => {
      FakeMcodeAcpClient.pending.push((extra) => resolveFn(extra));
    });
  }
  stop() {}
}

let mcodeAcp;
let sessions;

before(async (t) => {
  t.mock.module(absWebuiPath("acp.mjs"), {
    namedExports: { McodeAcpClient: FakeMcodeAcpClient },
  });
  t.mock.module(absPath("lib/acp-client.js"), {
    namedExports: {
      getCachedMcodeCommands: () => [],
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => null,
      getMcodeSessionsStaleSync: () => null,
      getMcodeSessionTitle: async () => null,
      deleteMcodeSessionFromDb: () => ({ ok: true }),
      getMcodeAcpClient: async () => null,
      listAllMcodeSessions: async () => [],
      getMcodeServerInfo: () => null,
      invalidateMcodeSessionsCache: () => {},
      shutdownMcodeAcpSingleton: () => {},
      dropMcodeSessionFromCache: () => {},
      ensureMcodeCommands: async () => ({
        mcode: [],
        webui: [],
        fetchedAt: 0,
        source: "test-default",
      }),
    },
  });
  t.mock.module(absPath("lib/mavis-usage.js"), {
    namedExports: {
      getMavisTokenUsage: async () => null,
      getMavisTokenUsageModel: async () => null,
      applyMavisUsageToCs: async () => false,
    },
  });
  t.mock.module(absPath("lib/slash.js"), {
    namedExports: {
      handleLocalSlash: async () => ({ handled: false, continueMcode: false }),
      handleCmdCommand: async () => ({ handled: true, continueMcode: false }),
      matchSlash: (content) => {
        const m = content.match(/^\/([a-zA-Z][\w-]*)\b\s*(.*)/);
        if (!m) return null;
        return { cmd: m[1], rest: m[2] || "" };
      },
    },
  });
  mcodeAcp = await import(absPath("lib/mcode-acp.js"));
  sessions = await import(absPath("lib/sessions.js"));
});

beforeEach(() => {
  sessions._resetSessionsCacheForTests();
  FakeMcodeAcpClient.reset();
});

after(() => {
  try {
    rmSync(_tmpDataDir, { recursive: true, force: true });
  } catch {}
});

function makeCs() {
  return {
    model: { name: "minimax_api/MiniMax-M3" },
    workspace: { dir: "/tmp" },
    sessionId: null,
    mcodeSessionId: null,
    sessionTitle: "Untitled",
    chat: ["› hi"],
    usage: {},
    context: { used: 0, limit: 0, percent: 0, tokens: 0 },
    running: { active: false },
  };
}

/** Drive one prompt through the real runMcodeAcp; returns { r, cs }. */
async function runPrompt(chunks) {
  const cid = "cid-plan-projection";
  const cs = makeCs();
  sessions.clearActiveChild?.(cid);
  FakeMcodeAcpClient.lastOnChunk = null;
  FakeMcodeAcpClient.pending = [];
  try {
    const p = mcodeAcp.runMcodeAcp("hi", {
      label: "test",
      cs,
      cid,
      sessionId: null,
    });
    for (let i = 0; i < 50 && !FakeMcodeAcpClient.lastOnChunk; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!FakeMcodeAcpClient.lastOnChunk) {
      throw new Error("prompt callback never registered");
    }
    for (const c of chunks) FakeMcodeAcpClient.emit(c);
    FakeMcodeAcpClient.release({ stopReason: "end_turn", usage: null });
    const r = await p;
    return { r, cs };
  } finally {
    sessions.clearActiveChild?.(cid);
    FakeMcodeAcpClient.lastOnChunk = null;
    FakeMcodeAcpClient.pending = [];
  }
}

const PLAN_MARKDOWN = "# Implementation plan\n\n1. Add the endpoint\n2. Wire the modal";

describe("plan_update projection — the shape the engine actually sends (ticket 70)", () => {
  test("plan content and id land on cs.plan from update.plan", async () => {
    // Byte-for-byte the payload agent.ts:1356 emits.
    const { cs } = await runPrompt([
      {
        kind: "plan_update",
        update: {
          sessionId: "mvs_fake_plan",
          plan: {
            type: "markdown",
            planId: "plan-req-1",
            content: PLAN_MARKDOWN,
          },
        },
      },
    ]);

    assert.equal(cs.plan.active, true, "a plan_update must open the plan state");
    assert.equal(
      cs.plan.planId,
      "plan-req-1",
      "planId must come from update.plan.planId",
    );
    assert.equal(
      cs.plan.summary,
      PLAN_MARKDOWN,
      "the plan document must land on cs.plan.summary verbatim",
    );
    assert.deepEqual(
      cs.plan.options,
      [],
      "a plan_update carries no options; the review's single `approve` " +
        "option lives on the questionnaire side, not on this notification",
    );
  });

  test("the top-level shape webui used to invent is not read", async () => {
    // The pre-fix projection read u.planId / u.title / u.summary /
    // u.options. The engine never sends them there, so accepting them
    // would re-open the door to a projection that disagrees with the
    // only producer in the codebase.
    const { cs } = await runPrompt([
      {
        kind: "plan_update",
        update: {
          sessionId: "mvs_fake_plan",
          planId: "invented-id",
          title: "Invented title",
          summary: "Invented summary",
          options: [{ label: "Agree" }],
        },
      },
    ]);

    assert.equal(
      cs.plan.planId,
      null,
      "planId must not be read off the top level — the engine does not send it there",
    );
    assert.equal(
      cs.plan.summary,
      "",
      "summary must not be read off the top level either",
    );
    assert.deepEqual(cs.plan.options, [], "options must stay empty");
  });

  test("plan_removed closes the plan state", async () => {
    const { cs } = await runPrompt([
      {
        kind: "plan_update",
        update: {
          sessionId: "mvs_fake_plan",
          plan: { type: "markdown", planId: "plan-req-2", content: "x" },
        },
      },
      {
        kind: "plan_removed",
        update: { sessionId: "mvs_fake_plan", planId: "plan-req-2" },
      },
    ]);

    assert.equal(cs.plan.active, false, "plan_removed must close the plan state");
    assert.equal(cs.plan.planId, null);
    assert.equal(cs.plan.summary, "");
  });

  test("a malformed plan payload degrades to an open-but-empty notice", async () => {
    // The modal renders a notice either way; it must not throw and must
    // not invent content.
    const { cs } = await runPrompt([
      { kind: "plan_update", update: { sessionId: "mvs_fake_plan" } },
    ]);
    assert.equal(cs.plan.active, true);
    assert.equal(cs.plan.planId, null);
    assert.equal(cs.plan.summary, "");
  });
});
