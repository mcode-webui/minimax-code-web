// webui/test/lib/engine/session-writes.test.js
//
// M3-B5: the session WRITE family's engine facade — #7 delete, #4
// rename, #6 cleanup-orphans.
//
// This is the first suite in the migration that tests a family which
// DESTROYS data, so the sections below are ordered by how much damage a
// regression in each one does, not by which module the function came
// from:
//
//   1. THE DECLARATION AND ITS POLICY. The hard/none split in here is
//      the batch's most consequential judgement call: #7 and #6 are hard
//      because they destroy the engine's own rows, #4 declares no
//      capability because it touches no engine surface. Section 2 proves
//      the asymmetry is real by driving all three endpoints from ONE
//      provider fixture.
//
//   2. THE FIVE DELETE RED LINES. "Deleted sessions must not come back",
//      "deleting a session is not deleting files", "a running session
//      has defined semantics", "the other tab must lose the entry", and
//      "the audit chain stays intact". These are the checks a reviewer
//      should read first, so they get their own section with one test
//      per line.
//
//   3. THE BYTE-FOR-BYTE PREVIEW SHAPES. #6's dryRun body is a hard red
//      line for this batch; #7's is pinned beside it because the same
//      edit touched both.
//
//   4. THE PURE DERIVATIONS, on their inputs.
//
//   5. THE ROUTE, with the proof that the facade mock actually took.
//
// Two module-mock traps apply here exactly as they did in B3/B4, and
// both are load-bearing rather than incidental:
//
//   1. `t.mock.module` REPLACES the WHOLE NAMESPACE; it does not merge.
//      A mock naming only the export under test leaves every other name
//      undefined and the consumer fails at INSTANTIATION with
//      `SyntaxError: … does not provide an export named …` — a failure
//      that reads like a product bug and is not one. Every mock below
//      goes through `mockAll()`, which fills the un-stubbed names with a
//      function that THROWS, so an unexpected call is loud instead of
//      returning a plausible payload.
//   2. `mock.module` re-evaluates only the MOCKED specifier. A consumer
//      already in the registry keeps its old LIVE BINDING, so a second
//      test in the same file would silently reuse the first test's mock
//      and pass for the wrong reason. Every route re-import carries a
//      fresh `?bust=N`, and section 5 ends with the marker control that
//      proves it.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

import {
  setupMocks,
  absPath,
  registerSessionsStore,
  registerAcpMock,
  withDecisions,
} from "../../helpers/_setup.js";
import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";

// ---------------------------------------------------------------------------
// Per-file path isolation (B5 test-hygiene fix)
// ---------------------------------------------------------------------------
// `readOrphanSessionWriteIds` reads `lib/config.js#SESSIONS_DB`, and that
// constant is frozen when config.js is FIRST evaluated — which happens inside
// the first test that pulls `engine/index.js` into the registry, long before
// the preview test below runs. So the pin has to sit at module scope: setting
// it inside the test body would be a no-op dressed up as isolation.
//
// The bug this kills: the preview test asserted `count:0` because the
// developer's `~/.mcode-webui/sessions.json` "does not exist in this
// environment". On any machine that has actually used the app it DOES exist,
// and the assertion was a statement about the developer's home directory
// rather than about the facade — green on a clean CI runner, red on every
// workstation, and unfixable by editing the product.
//
// Four variables, all rooted in one tracked temp directory (SPEC §7's
// isolation trio plus the file under test):
//
//   MCODE_WEBUI_SESSIONS_DB   — the file the sweep reads; the one that leaked
//   MCODE_WEBUI_DATA_DIR     — its parent, so every other path config.js
//                              derives from the data dir lands here too
//   MCODE_WEBUI_SETTINGS_PATH — settings.json, which config.js reads at import
//   MINIMAX_DATA_DIR         — the engine's data dir; without it the
//                              MCODE_RUNTIME_DB contract still resolves
//                              against the real ~/.minimax
//
// SESSIONS_DB is deliberately left NON-EXISTENT. The empty sweep is the shape
// this red line pins, and after this change it is guaranteed by construction
// instead of by the absence of a file the test never created.
const ISOLATED_DIR = mkTmpDir("webui-session-writes-b5-");
process.env.MCODE_WEBUI_SESSIONS_DB = join(ISOLATED_DIR, "sessions.json");
process.env.MCODE_WEBUI_DATA_DIR = ISOLATED_DIR;
process.env.MCODE_WEBUI_SETTINGS_PATH = join(ISOLATED_DIR, "settings.json");
process.env.MINIMAX_DATA_DIR = ISOLATED_DIR;

after(() => {
  rmTmpDir(ISOLATED_DIR);
  delete process.env.MCODE_WEBUI_SESSIONS_DB;
  delete process.env.MCODE_WEBUI_DATA_DIR;
  delete process.env.MCODE_WEBUI_SETTINGS_PATH;
  delete process.env.MINIMAX_DATA_DIR;
});

// Type discrimination goes through the exported predicate, never
// `err.name`. `engine/capabilities.js` is never `mock.module`d by this
// file, so the `instanceof` inside it resolves against the same class the
// gate throws from; the sibling batches (account-reads, session-export)
// assert the same way. The string comparison it replaces could not tell a
// capability error from any other error that happened to carry a name.
const { isEngineCapabilityNotSupportedError } = await import(
  "../../../server/engine/errors.js"
);

const RUNTIME = "runtime";
const ACP = "acp";

// A syntactically valid engine sid — `isMcodeSessionId` requires exactly
// 32 lowercase hex digits, and every fixture below that wants the ORPHAN
// branch has to satisfy the same regex the pre-facade route spelled
// inline four times.
const ORPHAN_SID = "mvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let bust = 0;

/** A JSON request body the real `lib/read-json.js` can consume. */
function jsonReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}

/** A minimal `ServerResponse` stand-in that records what was written. */
function mkRes() {
  const written = [];
  return {
    written,
    writeHead(status, headers) {
      written.push({ status, headers });
      return this;
    },
    end(body) {
      written.push({ body });
      return this;
    },
  };
}

/**
 * A fresh copy of `routes/sessions.js`.
 *
 * `mock.module` re-evaluates only the MOCKED specifier, but a route
 * module already in the registry keeps its old LIVE BINDING to the
 * facade — without the `?bust=N` re-import a second test would silently
 * exercise the first test's mock and pass for the wrong reason. That is
 * what the PROOF cases below exist to catch.
 */
const loadRoute = async () => import(`${absPath("routes/sessions.js")}?bust=${bust++}`);

/**
 * Register a module mock that satisfies the namespace contract.
 *
 * @param {object} t        The test context.
 * @param {string} rel      Server-relative specifier, e.g. "lib/foo.js".
 * @param {object} impls    The exports this test stubs.
 * @param {string[]} known  Every export name the REAL module has, so
 *        anything this test does not stub is present-but-throwing rather
 *        than absent.
 */
function mockAll(t, rel, impls, known) {
  const namedExports = {};
  for (const name of known) {
    namedExports[name] = (...a) => {
      throw new Error(`B5 test called ${rel}#${name}, which this case did not stub`);
    };
  }
  Object.assign(namedExports, impls);
  t.mock.module(absPath(rel), { namedExports });
}

/**
 * The record-ordering journal the delete tests assert on. Every mutation
 * the write path performs appends its name here, so a test can assert
 * the SEQUENCE rather than the end state — and a sequence is the only
 * thing that distinguishes a correct delete from a resurrecting one.
 */
const journal = [];
function resetJournal() {
  journal.length = 0;
}

describe("M3-B5 — session write family", () => {
  // ---------------------------------------------------------------------
  // 1. The declaration table and the gate policy it records
  // ---------------------------------------------------------------------

  describe("SESSION_WRITE_ENDPOINTS — the three writes, and who owns the rows they destroy", () => {
    test("covers exactly this batch's three endpoints", async () => {
      const { SESSION_WRITE_ENDPOINTS } = await import(
        absPath("engine/session-writes.js")
      );
      assert.deepEqual(Object.keys(SESSION_WRITE_ENDPOINTS), [
        "DELETE /api/sessions/:id",
        "POST /api/sessions/rename",
        "POST /api/sessions/cleanup-orphans",
      ]);
    });

    test("every row declares the same three keys, including the no-capability one", async () => {
      // The uniformity is the point of this family's table shape: a
      // `null` hole for rename would read as "not filled in yet" to the
      // next editor rather than as a decision.
      const { SESSION_WRITE_ENDPOINTS } = await import(
        absPath("engine/session-writes.js")
      );
      for (const [endpoint, row] of Object.entries(SESSION_WRITE_ENDPOINTS)) {
        assert.deepEqual(
          Object.keys(row),
          ["capability", "subItem", "enforcement"],
          `${endpoint} has a different row shape`,
        );
        assert.ok(["hard", "soft", "none"].includes(row.enforcement), endpoint);
      }
    });

    // Table-driven: the table IS the assertion, because editing a row is
    // a capability decision and has to be reviewed as one.
    const TABLE = [
      [
        "DELETE /api/sessions/:id",
        { capability: "sessionCrud", subItem: "deleteSession", enforcement: "hard" },
        "the delete destroys rows in the engine's own local_runtime_* tables",
      ],
      [
        "POST /api/sessions/rename",
        { capability: null, subItem: null, enforcement: "none" },
        "a rename writes webui's store and crosses no engine surface",
      ],
      [
        "POST /api/sessions/cleanup-orphans",
        { capability: "sessionCrud", subItem: "deleteSession", enforcement: "hard" },
        "the sweep delegates to #7, so it destroys the same engine rows",
      ],
    ];
    for (const [endpoint, row, why] of TABLE) {
      test(`${endpoint} → ${row.enforcement}${row.capability ? ` on ${row.capability}.${row.subItem}` : ""} (${why})`, async () => {
        const { SESSION_WRITE_ENDPOINTS } = await import(
          absPath("engine/session-writes.js")
        );
        const { ENGINE_CAPABILITY_KEYS } = await import(absPath("engine/index.js"));
        assert.deepEqual(SESSION_WRITE_ENDPOINTS[endpoint], row);
        if (row.capability) assert.ok(ENGINE_CAPABILITY_KEYS.includes(row.capability));
      });
    }

    test("#6 declares the SAME pair as #7 — the sweep is a delete by another name", async () => {
      // If these two ever drift, a provider that cannot delete engine
      // sessions could still reach the engine's tables through the
      // sweep's back door. The assertion compares against #7's own row,
      // not against a copy, so it fails the moment either one moves.
      const { SESSION_WRITE_ENDPOINTS } = await import(
        absPath("engine/session-writes.js")
      );
      assert.deepEqual(
        SESSION_WRITE_ENDPOINTS["POST /api/sessions/cleanup-orphans"],
        SESSION_WRITE_ENDPOINTS["DELETE /api/sessions/:id"],
      );
    });

    test("an endpoint outside this family is caller confusion, not an engine limitation", async () => {
      const { assertSessionWriteCapability } = await import(
        absPath("engine/session-writes.js")
      );
      assert.throws(
        () => assertSessionWriteCapability("DELETE /api/sessions", RUNTIME),
        (err) => {
          // A caller-typo must NOT answer 501, so the proof is that it is
          // not a capability error at all — a positive check on the code
          // and message alone would also pass if the error carried both
          // by accident.
          assert.ok(!isEngineCapabilityNotSupportedError(err));
          assert.equal(err.code, "unknown_session_write_endpoint");
          assert.match(err.message, /not part of the session write family/);
          return true;
        },
      );
    });
  });

  describe("resolveSessionWriteProvider / assertSessionWriteCapability", () => {
    // Table-driven. Absent means "no provider claims this transport yet"
    // (M4), which is NOT the same answer as "capability unavailable" —
    // the default `acp` transport must keep deleting sessions, so it
    // must NOT throw.
    const TRANSPORTS = [
      [RUNTIME, true, "checked", "local-runtime-v2"],
      [ACP, false, "unregistered-transport", null],
      ["exec", false, "unregistered-transport", null],
      ["", false, "unregistered-transport", null],
    ];
    for (const [transport, hasProvider, gate, providerId] of TRANSPORTS) {
      test(`transport=${JSON.stringify(transport)} → ${gate}`, async () => {
        const { assertSessionWriteCapability, resolveSessionWriteProvider } =
          await import(absPath("engine/session-writes.js"));
        const provider = resolveSessionWriteProvider(transport);
        assert.equal(!!provider, hasProvider);
        const g = assertSessionWriteCapability("DELETE /api/sessions/:id", transport);
        assert.equal(g.gate, gate);
        assert.equal(g.provider, providerId);
        assert.equal(g.capability, "sessionCrud");
        assert.equal(g.subItem, "deleteSession");
        assert.equal(g.endpoint, "DELETE /api/sessions/:id");
        assert.equal(g.enforcement, "hard");
      });
    }

    test("rename reports no-capability-key on EVERY transport, provider or not", async () => {
      // The single most important assertion about #4: renaming a
      // session works on a webui-only store and must not become a 501
      // because of anything a provider declares. Checked across all
      // four transports so a future `if (provider)` shortcut cannot
      // reintroduce the dependency behind the "it only fires on runtime"
      // argument.
      const { assertSessionWriteCapability } = await import(
        absPath("engine/session-writes.js")
      );
      for (const [transport] of TRANSPORTS) {
        const g = assertSessionWriteCapability("POST /api/sessions/rename", transport);
        assert.equal(g.gate, "no-capability-key", transport);
        assert.equal(g.capability, null, transport);
        assert.equal(g.subItem, null, transport);
        assert.equal(g.enforcement, "none", transport);
      }
    });

    test("the descriptor carries the six B1–B4 fields plus `enforcement`", async () => {
      // A consumer reading `gate.provider` under `acp` must get `null`,
      // not `undefined` — the key must EXIST. The six shared fields are
      // asserted by name so the families cannot drift apart, and
      // `enforcement` is the write family's own addition.
      const { assertSessionWriteCapability } = await import(
        absPath("engine/session-writes.js")
      );
      assert.deepEqual(Object.keys(assertSessionWriteCapability("DELETE /api/sessions/:id", RUNTIME)), [
        "endpoint",
        "gate",
        "provider",
        "capability",
        "subItem",
        "enforcement",
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // 2. The hard / none asymmetry, driven from ONE provider fixture
  // ---------------------------------------------------------------------

  // The proof that section 1's policy is enforced by code and not by the
  // provider's shape. One fixture provider, three endpoints, three
  // different answers — and the two "must throw" rows are what stop
  // #7/#6 from silently degrading into a no-op delete on a provider that
  // cannot delete.
  const CAPABILITY_FIXTURES = [
    ["none", { level: "none", reason: "fixture: interface-absent" }],
    [
      "partial missing deleteSession",
      { level: "partial", missing: ["deleteSession"], reason: "fixture: no delete surface" },
    ],
    [
      "partial keeping deleteSession",
      { level: "partial", missing: ["getSession"], reason: "fixture: delete present" },
    ],
    ["full", { level: "full" }],
  ];

  for (const [name, sessionCrud] of CAPABILITY_FIXTURES) {
    test(`provider sessionCrud=${name}: #7 and #6 THROW, #4 never does`, async (t) => {
      await setupMocks(t, { acp: {} });
      // `mock.module` replaces the whole namespace; session-writes.js
      // reads two names from engine/index.js and the test re-imports the
      // facade under a fresh bust so the mock is the one it sees.
      t.mock.module(absPath("engine/index.js"), {
        namedExports: {
          DEFAULT_ENGINE_PROVIDER_ID: "fixture-provider",
          getEngineProvider: () => ({
            id: "fixture-provider",
            transport: "runtime",
            capabilities: { sessionCrud },
          }),
        },
      });
      const mod = await import(`${absPath("engine/session-writes.js")}?caps=${bust++}`);
      // The gate throws when the declaration withholds `deleteSession`
      // itself: `none` withholds the whole capability, and a `partial`
      // withholds the sub-item. A `full`, or a `partial` that still
      // carries `deleteSession`, passes — which is the sub-item
      // granularity the declaration contract exists to provide.
      const throws =
        sessionCrud.level === "none" ||
        (sessionCrud.level === "partial" && sessionCrud.missing.includes("deleteSession"));
      for (const endpoint of ["DELETE /api/sessions/:id", "POST /api/sessions/cleanup-orphans"]) {
        if (throws) {
          assert.throws(
            () => mod.assertSessionWriteCapability(endpoint, "runtime"),
            (err) => {
              assert.ok(isEngineCapabilityNotSupportedError(err));
              assert.equal(err.capability, "sessionCrud");
              assert.equal(err.provider, "fixture-provider");
              return true;
            },
            `${endpoint} should have thrown for sessionCrud=${name}`,
          );
        } else {
          const g = mod.assertSessionWriteCapability(endpoint, "runtime");
          assert.equal(g.gate, "checked", `${endpoint} / ${name}`);
        }
      }
      // Rename, whatever the provider says. This is the assertion that
      // fails loudly if someone "helpfully" gives #4 a capability.
      const rename = mod.assertSessionWriteCapability("POST /api/sessions/rename", "runtime");
      assert.equal(rename.gate, "no-capability-key", name);
      assert.equal(rename.provider, "fixture-provider", "it still reports which provider is live");
    });
  }

  test("the hard gate costs ZERO deletions: it throws before the plan reads the store", async (t) => {
    // Ordering matters for a destructive endpoint. A gate that ran after
    // the store load would still be correct, but a gate that ran after
    // the COMMIT would be theatre — so the proof is that the plan
    // rejects without ever resolving a target.
    await setupMocks(t, { acp: {} });
    registerSessionsStore({ initial: [{ id: "webui-A", title: "A", chat: [] }] });
    t.mock.module(absPath("engine/index.js"), {
      namedExports: {
        DEFAULT_ENGINE_PROVIDER_ID: "fixture-provider",
        getEngineProvider: () => ({
          id: "fixture-provider",
          transport: "runtime",
          capabilities: { sessionCrud: { level: "none", reason: "fixture" } },
        }),
      },
    });
    const mod = await import(`${absPath("engine/session-writes.js")}?order=${bust++}`);
    await assert.rejects(
      () => mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME }),
      (err) => {
        assert.ok(isEngineCapabilityNotSupportedError(err));
        return true;
      },
    );
    // The store is untouched: `getSessionsStore` still holds the record.
    const { getSessionsStore } = await import("../../helpers/_setup.js");
    assert.equal(getSessionsStore().length, 1);
  });

  // ---------------------------------------------------------------------
  // 3. The pure derivations
  // ---------------------------------------------------------------------

  describe("pure derivations", () => {
    test("isMcodeSessionId accepts only the engine's 32-hex shape", async () => {
      const { isMcodeSessionId } = await import(absPath("engine/session-writes.js"));
      const TABLE = [
        [ORPHAN_SID, true],
        [`mvs_${"a".repeat(32)}`, true],
        [`mvs_${"A".repeat(32)}`, false, "uppercase hex is not the engine's shape"],
        [`mvs_${"a".repeat(31)}`, false],
        [`mvs_${"a".repeat(33)}`, false],
        ["mvs_", false],
        ["webui-A", false],
        ["", false],
        [null, false],
        [undefined, false],
        [42, false, "a non-string must not throw — it is simply not an engine sid"],
      ];
      for (const [input, expected, why] of TABLE) {
        assert.equal(isMcodeSessionId(input), expected, `${JSON.stringify(input)}: ${why || "shape"}`);
      }
    });

    test("resolveSessionTarget answers the same three ways for both writes", async () => {
      // Rename and delete used to carry this lookup as two identical
      // copies. Table-driven over one store so the shared predicate is
      // pinned for both.
      const { resolveSessionTarget } = await import(absPath("engine/session-writes.js"));
      const records = [
        { id: "webui-A", mcodeSessionId: "mvs_11111111111111111111111111111111" },
        { id: "webui-B" },
      ];
      const TABLE = [
        ["webui-A", 0, "webuiId", "matched by the webui uuid"],
        ["mvs_11111111111111111111111111111111", 0, "mcodeSessionId", "matched by the bound engine sid"],
        ["webui-B", 1, "webuiId", "a record with no engine sid still matches its own id"],
        ["nope", -1, null, "an unknown id resolves to nothing, and matchKind is null — not \"unknown\""],
      ];
      for (const [id, index, matchKind, why] of TABLE) {
        const r = resolveSessionTarget(records, id);
        assert.equal(r.index, index, why);
        assert.equal(r.matchKind, matchKind, why);
        assert.equal(r.target, index >= 0 ? records[index] : null, why);
      }
      // A non-array store must not throw: the store is a file on disk and
      // a corrupt one answers `[]`, never a TypeError inside a gate.
      assert.deepEqual(resolveSessionTarget(null, "x"), { index: -1, matchKind: null, target: null });
    });

    test("the orphan rule: empty AND default-titled AND older than 24h", async () => {
      const { isOrphanSessionRecord, ORPHAN_STALE_MS } = await import(
        absPath("engine/session-writes.js")
      );
      const NOW = 1_700_000_000_000;
      const old = NOW - ORPHAN_STALE_MS - 1;
      const TABLE = [
        [{ id: "a", title: "Untitled", chat: [], updatedAt: old }, true, "the canonical leftover"],
        [{ id: "b", title: "New session", chat: [], updatedAt: old }, true, "the other default name"],
        [{ id: "c", title: "对话 7", chat: [], updatedAt: old }, true, "the numbered default"],
        [{ id: "d", title: "Untitled", chat: [], updatedAt: NOW }, false, "too fresh"],
        [
          { id: "e", title: "Untitled", chat: [], updatedAt: NOW - ORPHAN_STALE_MS + 1 },
          false,
          "one millisecond inside the window is still fresh",
        ],
        [
          { id: "f", title: "Untitled", chat: [], updatedAt: NOW - ORPHAN_STALE_MS },
          true,
          "exactly at the threshold is stale — the rule is `<`, not `<=`",
        ],
        [{ id: "g", title: "Untitled", chat: ["● hi"], updatedAt: old }, false, "has chat"],
        [{ id: "h", title: "Real work", chat: [], updatedAt: old }, false, "not a default title"],
        [{ id: "i", title: "Untitled", chat: [], updatedAt: 0 }, true, "updatedAt 0 is falsy, so the age check is skipped — preserved"],
        [{ id: "j", title: "  Untitled  ", chat: [], updatedAt: old }, true, "titles are trimmed before matching"],
        [{ id: "k", title: "对话7", chat: [], updatedAt: old }, false, "the numbered form needs the space"],
        [{ id: "", title: "Untitled", chat: [], updatedAt: old }, false, "no id"],
        [null, false, "a null record"],
        [{ title: "Untitled", chat: [], updatedAt: old }, false, "no id"],
        [{ id: "m", title: "Untitled", updatedAt: old }, true, "a missing chat counts as empty"],
      ];
      for (const [record, expected, why] of TABLE) {
        assert.equal(isOrphanSessionRecord(record, NOW, ORPHAN_STALE_MS), expected, why);
      }
    });

    test("selectOrphanSessionIds keeps store order and survives a non-array", async () => {
      const { selectOrphanSessionIds, ORPHAN_STALE_MS } = await import(
        absPath("engine/session-writes.js")
      );
      const now = 1_700_000_000_000;
      const old = now - ORPHAN_STALE_MS - 1;
      assert.deepEqual(
        selectOrphanSessionIds(
          [
            { id: "keep-me", title: "Real", chat: [], updatedAt: old },
            { id: "b", title: "Untitled", chat: [], updatedAt: old },
            { id: "a", title: "Untitled", chat: [], updatedAt: old },
          ],
          { now },
        ),
        ["b", "a"],
        "store order, not sorted order — the ids are reported in the order they would be deleted",
      );
      assert.deepEqual(selectOrphanSessionIds(null, { now }), []);
    });

    test("the two fan-out predicates really are different predicates", async () => {
      // The temptation this test exists to kill: one shared
      // "is this client in this session" helper. It would be wrong in
      // both directions — clearing a tab that was never deleted, and
      // blanking the title of a tab bound to a DIFFERENT wrapper record.
      const { clientMatchesDeletedSession, clientMatchesRenamedSession } = await import(
        absPath("engine/session-writes.js")
      );
      const record = { id: "webui-A", mcodeSessionId: "mvs_sid_A" };
      const inRecord = { sessionId: "webui-A", mcodeSessionId: null };
      const byEngineSid = { sessionId: "webui-OTHER", mcodeSessionId: "mvs_sid_A" };
      const byRequestId = { sessionId: "webui-THIRD", mcodeSessionId: "mvs_sid_B" };

      assert.equal(clientMatchesRenamedSession(inRecord, record), true, "rename: same webui id");
      assert.equal(clientMatchesRenamedSession(byEngineSid, record), true, "rename: same engine sid");
      assert.equal(clientMatchesRenamedSession(byRequestId, record), false, "rename: unrelated tab");

      assert.equal(clientMatchesDeletedSession(inRecord, record, "webui-A"), true, "delete: same webui id");
      assert.equal(clientMatchesDeletedSession(byEngineSid, record, "webui-A"), false,
        "delete: a tab bound to the record's engine sid under ANOTHER wrapper is a different record and must not be cleared");
      assert.equal(clientMatchesDeletedSession(byRequestId, record, "mvs_sid_B"), true,
        "delete: matches the id the REQUEST named, which is the orphan branch's only handle");
    });

    test("the delete reset clears identity, title, chat and the three usage counters", async () => {
      const { applyDeletedSessionToClientState } = await import(
        absPath("engine/session-writes.js")
      );
      const cs = {
        sessionId: "webui-A",
        mcodeSessionId: "mvs_sid_A",
        sessionTitle: "A",
        chat: ["● hi", "● there"],
        usage: { sessionInput: 10, sessionOutput: 20, sessionTotal: 30, cost: 1.5 },
        somethingElse: "kept",
      };
      applyDeletedSessionToClientState(cs);
      assert.equal(cs.sessionId, null);
      assert.equal(cs.mcodeSessionId, null);
      assert.equal(cs.sessionTitle, "Untitled");
      assert.deepEqual(cs.chat, []);
      assert.equal(cs.usage.sessionInput, 0);
      assert.equal(cs.usage.sessionOutput, 0);
      assert.equal(cs.usage.sessionTotal, 0);
      assert.equal(cs.usage.cost, 1.5, "unrelated usage fields survive");
      assert.equal(cs.somethingElse, "kept", "the reset touches only what it names");
    });

    test("the orphan branch does NOT zero usage — the asymmetry is a parameter, not an accident", async () => {
      const { applyDeletedSessionToClientState } = await import(
        absPath("engine/session-writes.js")
      );
      const cs = {
        sessionId: null,
        mcodeSessionId: ORPHAN_SID,
        sessionTitle: "Orphan",
        chat: [],
        usage: { sessionInput: 10, sessionOutput: 20, sessionTotal: 30 },
      };
      applyDeletedSessionToClientState(cs, { resetUsage: false });
      assert.equal(cs.sessionTitle, "Untitled", "the identity and title are still cleared");
      assert.deepEqual(cs.chat, []);
      assert.equal(cs.usage.sessionTotal, 30, "an orphan has no webui record, so no tab accrued usage for it");
    });
  });

  // ---------------------------------------------------------------------
  // 4. The delete red lines
  // ---------------------------------------------------------------------

  // The real store / cache / SQL collaborators, journalled. Every
  // mutation appends its name in the order it happened, because for a
  // delete the ORDER is the feature and an end-state assertion cannot see
  // a resurrected session or an out-of-order cache drop.
  async function loadWritePath(t, options = {}) {
    await setupMocks(t, { acp: {}, sessions: { initial: options.records || [] } });
    registerAcpMock({
      shutdownMcodeAcpSingleton: () => {
        journal.push("kill-acp-child");
      },
      dropMcodeSessionFromCache: (sid) => {
        journal.push(`drop-cache:${sid}`);
      },
    });
    const dbCalls = [];
    // M4-3a: the data plane is `engine/session-delete.js` now, and it has
    // TWO entry points where the retired module had one — the readonly
    // preview (a dry run is still a COUNT, because the engine has no
    // preview form) and the engine call that actually destroys. The mock
    // journals them under the same `sql:` prefix these assertions already
    // read, so the ORDERING assertions below are unchanged in meaning: what
    // they pin is the sequence around the destructive step, not the module
    // the step lives in.
    const engineDeleteResult =
      options.dbResult || {
        ok: true,
        outcome: "deleted",
        log: ["local_runtime_sessions:1"],
        totalRowsDeleted: 1,
        tablesAbsent: 0,
      };
    mockAll(
      t,
      "engine/session-delete.js",
      {
        previewSessionDeleteRows: (sid, o) => {
          journal.push(`sql:${sid}:dryRun=true`);
          dbCalls.push({ sid, dryRun: true, db: o.MCODE_RUNTIME_DB });
          return options.dbPreviewResult || { ok: true, dryRun: true, log: [], totalRows: 0 };
        },
        deleteSessionThroughEngine: async (sid, o) => {
          journal.push(`sql:${sid}:dryRun=false`);
          dbCalls.push({ sid, dryRun: false, db: o.MCODE_RUNTIME_DB });
          return engineDeleteResult;
        },
      },
      ["previewSessionDeleteRows", "deleteSessionThroughEngine", "SESSION_DELETE_PREVIEW_TABLES"],
    );
    mockAll(
      t,
      "lib/session-tree.js",
      {
        invalidateSessionTree: () => {
          journal.push("invalidate-tree");
        },
        getSessionTree: () => {
          journal.push("getSessionTree");
          return { ok: true, tree: [] };
        },
      },
      ["getSessionTree", "invalidateSessionTree"],
    );
    const clients = new Map();
    const pushes = [];
    mockAll(
      t,
      "lib/state-bus.js",
      {
        clients,
        pushStateFor: (c) => {
          journal.push(`push:${c}`);
          pushes.push(c);
        },
        runChatViewChat: () => ({}),
        makeClientState: () => ({ usage: {} }),
      },
      [
        "clients",
        "pushStateFor",
        "runChatViewChat",
        "makeClientState",
        "setState",
        "getClient",
        "sseByCid",
        "pushAlert",
      ],
    );
    return {
      dbCalls,
      clients,
      pushes,
      mod: await import(`${absPath("engine/session-writes.js")}?w=${bust++}`),
    };
  }

  beforeEach(() => {
    resetJournal();
  });

  describe("RED LINE — a deleted session does not come back", () => {
    test("the write path runs kill → SQL → scoped cache drop, in that order", async (t) => {
      // THE ordering assertion. The long-lived mcode ACP child holds the
      // session in memory and rewrites its registry row on its next
      // request, so a delete that removes the rows but leaves the child
      // alive produces a session that reappears on the next read. The
      // tree-cache drop is asserted FIRST because it must precede the
      // engine write: a concurrent read must not be able to repopulate
      // the cache from the pre-delete database.
      const { mod, dbCalls } = await loadWritePath(t, {
        records: [
          { id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: ["● hi"] },
          { id: "webui-B", title: "B", chat: [] },
        ],
      });
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      await mod.commitEngineSessionDelete({ plan, cid: "tab-1" });
      assert.deepEqual(journal, [
        "invalidate-tree",
        "kill-acp-child",
        "drop-cache:mvs_sid_A",
        "sql:mvs_sid_A:dryRun=false",
        // The requesting tab is pushed even though no tab matched it —
        // see the fan-out section. It is part of the delete, not after it.
        "push:tab-1",
      ]);
      assert.equal(dbCalls.length, 1, "exactly one engine delete, for the linked sid");
      assert.equal(dbCalls[0].dryRun, false, "a real delete is never a dry run");
    });

    test("only the DELETED sid leaves the cache — the other session is untouched", async (t) => {
      // The regression this guards is the sidebar flash: invalidating the
      // WHOLE cache empties the list, refills it, and reads to the user
      // like the delete failed. The per-sid drop is why a 42-entry
      // sidebar goes to 41 and stays there.
      const { mod, clients } = await loadWritePath(t, {
        records: [
          { id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: [] },
          { id: "webui-B", mcodeSessionId: "mvs_sid_B", title: "B", chat: [] },
        ],
      });
      clients.set("tab-1", { sessionId: "webui-A", mcodeSessionId: "mvs_sid_A", usage: {} });
      clients.set("tab-2", { sessionId: "webui-B", mcodeSessionId: "mvs_sid_B", usage: {} });
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      const w = await mod.commitEngineSessionDelete({ plan, cid: "tab-1" });
      assert.equal(
        journal.filter((j) => j.startsWith("drop-cache:")).length,
        1,
        "exactly one cache entry dropped",
      );
      assert.ok(!journal.includes("drop-cache:mvs_sid_B"), "the untouched session keeps its cache entry");
      assert.deepEqual(
        w.records.map((r) => r.id),
        ["webui-B"],
        "the sibling record survives in the persisted store",
      );
      const { getSessionsStore } = await import("../../helpers/_setup.js");
      assert.deepEqual(
        getSessionsStore().map((r) => r.id),
        ["webui-B"],
        "and it is gone from the STORE, not just from the returned array",
      );
    });

    test("it is a TRUE delete: re-deleting the same sid still reaches the engine", async (t) => {
      // The distinction the batch's red line 3 turns on — a real delete
      // versus a frontend fake. After the first delete the webui record
      // is gone, so the SECOND delete of the same engine sid resolves as
      // an ORPHAN and goes straight to the SQL deleter. If the first
      // delete had only hidden the record (or if the store save were
      // skipped), this second call would resolve `webuiId` again and the
      // engine would never learn the session is gone.
      const { mod, dbCalls } = await loadWritePath(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: [] }],
      });
      const first = await mod.planEngineSessionDelete({ id: "mvs_sid_A", transport: RUNTIME });
      assert.equal(first.matchKind, "mcodeSessionId");
      await mod.commitEngineSessionDelete({ plan: first, cid: "tab-1" });

      resetJournal();
      const second = await mod.planEngineSessionDelete({ id: "mvs_sid_A", transport: RUNTIME });
      assert.equal(second.isOrphan, true, "the record is really gone from the store");
      assert.equal(second.matchKind, null);
      const w = await mod.commitEngineOrphanSessionDelete({ plan: second, cs: null, cid: "tab-1" });
      assert.equal(w.failed, false);
      assert.equal(dbCalls.length, 2, "the engine was told twice — the delete is not a UI illusion");
      assert.equal(dbCalls[1].sid, "mvs_sid_A");
    });
  });

  describe("RED LINE — deleting a session is not deleting files", () => {
    // The session's ARTEFACTS live on the filesystem under the run
    // directory (`~/tmp/run_*/`), and red line 4 makes the side file
    // tree part of the contract. A session delete removes rows in a
    // SQLite database; it must not remove a single byte of the user's
    // output. This test puts a real file there and checks it afterwards.
    test("a real run-directory artefact survives the delete", async (t) => {
      const dir = mkTmpDir("webui-session-writes-b5-");
      try {
        const runDir = join(dir, "run_20260920_120000");
        mkdirSync(runDir, { recursive: true });
        const artefact = join(runDir, "build.log");
        writeFileSync(artefact, "compiled output the user still wants\n");
        const { mod } = await loadWritePath(t, {
          records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: ["● done"] }],
        });
        const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
        const w = await mod.commitEngineSessionDelete({ plan, cid: "tab-1" });
        assert.equal(w.payload.ok, true, "the delete itself succeeded");
        assert.ok(existsSync(artefact), "the artefact file is still on disk");
        assert.equal(readFileSync(artefact, "utf8"), "compiled output the user still wants\n");
      } finally {
        rmTmpDir(dir);
      }
    });

    test("the same holds for a dryRun preview and for the orphan branch", async (t) => {
      const dir = mkTmpDir("webui-session-writes-b5-");
      try {
        const artefact = join(dir, "report.md");
        writeFileSync(artefact, "# notes\n");
        const { mod } = await loadWritePath(t, {
          records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: [] }],
        });
        const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
        await mod.previewEngineSessionDelete({ plan });
        resetJournal();
        const orphan = await mod.planEngineSessionDelete({ id: ORPHAN_SID, transport: RUNTIME });
        await mod.commitEngineOrphanSessionDelete({ plan: orphan, cs: null, cid: "tab-1" });
        assert.ok(existsSync(artefact), "neither the preview nor the orphan branch touches files");
      } finally {
        rmTmpDir(dir);
      }
    });

    test("the 32-table DELETE is retired — the engine destroys the rows, webui only counts them", async () => {
      // M4-3a collected the write half of this batch's KNOWN DEBT 1. The
      // plan annotated `lib/mcode-session-delete.js` "delete"; the module
      // is gone, and this test is the proof rather than the promise —
      // because the consequence of deleting a module that four suites and
      // one production importer bound to is exactly the kind of thing that
      // "should be fine" gets wrong.
      assert.equal(
        existsSync(fileURLToPath(absPath("lib/mcode-session-delete.js"))),
        false,
        "the bare-SQL delete module is retired — it must not come back",
      );

      // What replaced it still knows the tables, for READING only. The
      // name says so, the list is unchanged in membership and order (a
      // preview report must stay comparable with pre-M4-3a ones), and the
      // facade reaches it rather than duplicating it: a second list is
      // precisely how two readers end up reporting different sets of rows.
      const { SESSION_DELETE_PREVIEW_TABLES } = await import(
        absPath("engine/session-delete.js")
      );
      assert.equal(
        SESSION_DELETE_PREVIEW_TABLES.length,
        32,
        "the 32-table list, still owned by one module",
      );
      assert.equal(SESSION_DELETE_PREVIEW_TABLES[0], "local_runtime_sessions");
      assert.ok(SESSION_DELETE_PREVIEW_TABLES.includes("local_runtime_token_usage"));

      // The red line this batch exists to enforce, stated where the facade
      // is: the facade issues no SQL of its own. Checked on SQL VERBS
      // rather than table names, because this file's comments legitimately
      // name the tables while explaining what it does not do.
      const src = readFileSync(fileURLToPath(absPath("engine/session-writes.js")), "utf8");
      for (const verb of ["DELETE FROM", "SELECT ", "INSERT ", "UPDATE ", "prepare("]) {
        assert.ok(
          !src.includes(verb),
          `the facade must issue no SQL, found ${JSON.stringify(verb)} — the data plane is engine/session-delete.js`,
        );
      }
      // And the data plane is reached through a dynamic import, not a
      // static one — a static import would put the database and the audit
      // chain on the boot path, which is the M1 regression this split
      // exists to prevent.
      assert.match(
        src,
        /import\("\.\/session-delete\.js"\)/,
        "the facade forwards to engine/session-delete.js through a lazy import",
      );
      assert.ok(
        !/^import .*session-delete/m.test(src),
        "and never through a static one",
      );
    });
  });

  describe("RED LINE — a running session has defined semantics", () => {
    test("deleting an in-flight session kills the child that is driving the turn", async (t) => {
      // There is no "refuse to delete a running session" guard, and this
      // pins the semantics that DO exist rather than leaving it implied:
      // the user asked, the child stops, the rows go. Recorded as KNOWN
      // DEBT in the facade header — "refuse" is a defensible product
      // decision, but it is not this batch's to make, and an unstated
      // behaviour is worse than a stated one.
      const { mod, clients } = await loadWritePath(t, {
        records: [
          {
            id: "webui-A",
            mcodeSessionId: "mvs_sid_A",
            title: "Running",
            chat: ["● working"],
          },
        ],
      });
      const cs = {
        sessionId: "webui-A",
        mcodeSessionId: "mvs_sid_A",
        sessionTitle: "Running",
        chat: ["● working"],
        running: { active: true, pid: 4242 },
        usage: { sessionTotal: 99 },
      };
      clients.set("tab-1", cs);
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      const w = await mod.commitEngineSessionDelete({ plan, cid: "tab-1" });
      assert.ok(journal.includes("kill-acp-child"), "the child driving the turn is stopped");
      assert.ok(
        journal.indexOf("kill-acp-child") < journal.findIndex((j) => j.startsWith("sql:")),
        "and it is stopped BEFORE the rows go — otherwise it rewrites them",
      );
      assert.equal(w.payload.ok, true, "and the delete proceeds — there is no refusal semantics");
      assert.equal(w.deletedItem.title, "Running");
      assert.equal(cs.mcodeSessionId, null, "the tab is not left pointing at a dead turn");
    });

    test("the requesting tab's in-flight state is reset by the fan-out, not left dangling", async (t) => {
      const { mod, clients, pushes } = await loadWritePath(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: ["● x"] }],
      });
      const cs = {
        sessionId: "webui-A",
        mcodeSessionId: "mvs_sid_A",
        sessionTitle: "A",
        chat: ["● x"],
        usage: { sessionInput: 5, sessionOutput: 6, sessionTotal: 11 },
      };
      clients.set("tab-1", cs);
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      const w = await mod.commitEngineSessionDelete({ plan, cid: "tab-1" });
      assert.equal(cs.sessionId, null);
      assert.equal(cs.mcodeSessionId, null);
      assert.equal(cs.sessionTitle, "Untitled");
      assert.deepEqual(cs.chat, []);
      assert.equal(cs.usage.sessionTotal, 0, "the tab stops reporting the deleted session's spend");
      assert.deepEqual(pushes, ["tab-1"]);
      assert.equal(w.touchedCids.length, 1);
    });
  });

  describe("RED LINE — the delete fans out to every other tab", () => {
    test("a second tab inside the same session is cleared and pushed", async (t) => {
      const { mod, clients, pushes } = await loadWritePath(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: ["● x"] }],
      });
      const tab1 = { sessionId: "webui-A", mcodeSessionId: "mvs_sid_A", sessionTitle: "A", chat: ["● x"], usage: { sessionTotal: 3 } };
      const tab2 = { sessionId: "webui-A", mcodeSessionId: "mvs_sid_A", sessionTitle: "A", chat: ["● x"], usage: { sessionTotal: 4 } };
      const tab3 = { sessionId: "webui-Z", mcodeSessionId: "mvs_sid_Z", sessionTitle: "Z", chat: ["● z"], usage: { sessionTotal: 5 } };
      clients.set("tab-1", tab1);
      clients.set("tab-2", tab2);
      clients.set("tab-3", tab3);
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      const w = await mod.commitEngineSessionDelete({ plan, cid: "tab-1" });
      assert.equal(tab1.mcodeSessionId, null);
      assert.equal(tab2.mcodeSessionId, null);
      assert.equal(tab2.chat.length, 0, "the OTHER tab loses the entry too — this is the cross-tab red line");
      assert.equal(tab3.mcodeSessionId, "mvs_sid_Z", "an unrelated tab is left completely alone");
      assert.equal(tab3.usage.sessionTotal, 5);
      assert.deepEqual(pushes.sort(), ["tab-1", "tab-2"], "both affected tabs are pushed");
      assert.equal(w.touchedCids.length, 2);
      assert.equal(w.payload.ok, true);
    });

    test("a tab that matched nothing still gets exactly one push, so it cannot render a ghost", async (t) => {
      const { mod, clients, pushes } = await loadWritePath(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: [] }],
      });
      clients.set("tab-elsewhere", { sessionId: "webui-Z", mcodeSessionId: "mvs_sid_Z", usage: {} });
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      const w = await mod.commitEngineSessionDelete({ plan, cid: "tab-1" });
      assert.deepEqual(pushes, ["tab-1"], "the requesting tab is pushed even though it matched nothing");
      assert.equal(w.touchedCids.length, 1);
    });

    test("the orphan branch clears ONLY the requesting tab — there is no record for others to be inside", async (t) => {
      const { mod, clients, pushes } = await loadWritePath(t, { records: [] });
      const cs = { sessionId: "webui-OTHER", mcodeSessionId: ORPHAN_SID, sessionTitle: "Orphan", chat: ["● x"], usage: { sessionTotal: 7 } };
      clients.set("tab-1", cs);
      const plan = await mod.planEngineSessionDelete({ id: ORPHAN_SID, transport: RUNTIME });
      assert.equal(plan.isOrphan, true);
      const w = await mod.commitEngineOrphanSessionDelete({ plan, cs, cid: "tab-1" });
      assert.equal(w.failed, false);
      assert.equal(cs.mcodeSessionId, null, "the tab that was sitting on the orphan is cleared");
      assert.equal(cs.sessionTitle, "Untitled");
      assert.equal(cs.usage.sessionTotal, 7, "and its usage is NOT zeroed — the orphan branch's documented asymmetry");
      assert.deepEqual(pushes, ["tab-1"], "only that one tab is pushed");
      assert.equal(w.payload.matchKind, "orphan_mcode");
    });

    test("the orphan branch leaves a tab that was NOT on the orphan alone", async (t) => {
      const { mod, clients, pushes } = await loadWritePath(t, { records: [] });
      const other = { sessionId: "webui-Z", mcodeSessionId: "mvs_sid_Z", sessionTitle: "Z", usage: {} };
      clients.set("tab-2", other);
      const plan = await mod.planEngineSessionDelete({ id: ORPHAN_SID, transport: RUNTIME });
      await mod.commitEngineOrphanSessionDelete({ plan, cs: null, cid: "tab-1" });
      assert.equal(other.mcodeSessionId, "mvs_sid_Z");
      assert.deepEqual(pushes, [], "no tab matched, so no tab was disturbed");
    });
  });

  // ---------------------------------------------------------------------
  // 5. The byte-for-byte preview shapes
  // ---------------------------------------------------------------------

  describe("preview shapes — #6's dryRun body is a hard red line for this batch", () => {
    test("the cleanup-orphans dryRun body is exactly four keys, in order", async (t) => {
      // Compared as a STRING, not as a parsed object: key ORDER is part
      // of a byte-for-byte contract, and `deepEqual` on objects would not
      // notice a reshuffle.
      await setupMocks(t, { acp: {} });
      const mod = await import(`${absPath("engine/session-writes.js")}?shape=${bust++}`);
      // The store read is against the SESSIONS_DB pinned at module scope, a
      // path that intentionally does not exist, so the answer is the empty
      // case — which is the shape most likely to be "simplified". The same
      // assertion held on a CI runner by accident; here it holds because the
      // test owns the path it reads.
      const sweep = await mod.readOrphanSessionWriteIds({ transport: RUNTIME });
      assert.equal(
        JSON.stringify(sweep.payload),
        '{"ok":true,"dryRun":true,"count":0,"ids":[]}',
      );
      assert.equal(sweep.gate.gate, "checked");
      assert.equal(sweep.gate.enforcement, "hard");
    });

    test("a populated sweep answers the same four keys with the selected ids", async (t) => {
      await setupMocks(t, { acp: {} });
      const { selectOrphanSessionIds } = await import(
        `${absPath("engine/session-writes.js")}?shape=${bust++}`
      );
      // The selection is pure, so the populated case is pinned through it
      // while the SHAPE stays pinned through the real read above. The
      // response is the same object the read would build.
      const ids = selectOrphanSessionIds(
        [
          { id: "old-1", title: "Untitled", chat: [], updatedAt: 1 },
          { id: "keep", title: "Real", chat: [], updatedAt: 1 },
          { id: "old-2", title: "对话 3", chat: [], updatedAt: 1 },
        ],
        { now: Number.MAX_SAFE_INTEGER },
      );
      assert.equal(
        JSON.stringify({ ok: true, dryRun: true, count: ids.length, ids }),
        '{"ok":true,"dryRun":true,"count":2,"ids":["old-1","old-2"]}',
      );
    });

    test("#7's dryRun body keeps its four keys and the webuiEntryWouldBeDeleted block", async (t) => {
      const { mod } = await loadWritePath(t, {
        records: [
          { id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A on tmp", chat: ["● hi"] },
        ],
      });
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      const w = await mod.previewEngineSessionDelete({ plan });
      assert.equal(
        JSON.stringify(w.payload),
        JSON.stringify({
          ok: true,
          dryRun: true,
          matchKind: "webuiId",
          // M4-3a: a dry run is a COUNT, not a delete, so this is the
          // preview shape the data plane returns for it. The assertion is
          // byte-for-byte on the payload for the same reason it always
          // was — `?dryRun=true` is a wire contract, and the refactor
          // that moved the delete onto the engine must not have moved it.
          mcodeDbDel: { ok: true, dryRun: true, log: [], totalRows: 0 },
          webuiEntryWouldBeDeleted: { id: "webui-A", title: "A on tmp", mcodeSessionId: "mvs_sid_A" },
        }),
      );
      assert.deepEqual(Object.keys(w.payload), [
        "ok",
        "dryRun",
        "matchKind",
        "mcodeDbDel",
        "webuiEntryWouldBeDeleted",
      ]);
    });

    test("a webui-only session with no engine sid still previews, with an empty log", async (t) => {
      // A record that never reached the engine has no rows to count.
      // Refusing to preview for those would be a new failure mode, and
      // the empty-log literal is the endpoint's own.
      const { mod, dbCalls } = await loadWritePath(t, {
        records: [{ id: "webui-B", title: "B", chat: [] }],
      });
      const plan = await mod.planEngineSessionDelete({ id: "webui-B", transport: RUNTIME });
      const w = await mod.previewEngineSessionDelete({ plan });
      assert.deepEqual(w.mcodeDbDel, { ok: true, dryRun: true, log: [], totalRows: 0 });
      assert.equal(w.payload.webuiEntryWouldBeDeleted.mcodeSessionId, undefined);
      assert.equal(dbCalls.length, 0, "and the SQL deleter is never asked about a non-sid");
    });

    test("a dryRun mutates nothing: no kill, no cache drop, no tree invalidation, no store write", async (t) => {
      // A preview that shuts down the user's ACP child is a side effect
      // the `?dryRun=true` contract does not include, and a preview that
      // drops the tree cache is a lie ("nothing changed" while the
      // sidebar re-renders). The journal is empty except for the
      // read-only SQL count.
      const { mod, clients } = await loadWritePath(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: [] }],
      });
      clients.set("tab-1", { sessionId: "webui-A", mcodeSessionId: "mvs_sid_A", sessionTitle: "A", chat: ["● x"], usage: {} });
      const plan = await mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME });
      await mod.previewEngineSessionDelete({ plan });
      assert.deepEqual(
        journal,
        ["sql:mvs_sid_A:dryRun=true"],
        "the ONLY thing a preview does is ask the SQL layer to count",
      );
      const { getSessionsStore } = await import("../../helpers/_setup.js");
      assert.equal(getSessionsStore().length, 1, "the record is still there after a preview");
      assert.equal(
        clients.get("tab-1").mcodeSessionId,
        "mvs_sid_A",
        "and the tab is still inside it",
      );
    });
  });

  // ---------------------------------------------------------------------
  // 6. The rename write
  // ---------------------------------------------------------------------

  describe("#4 rename — a webui-side label, and nothing else", () => {
    test("a rename writes the store, drops the tree cache and pushes every matching tab", async (t) => {
      const { mod, clients, pushes } = await loadWritePath(t, {
        records: [
          { id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "Old", chat: ["● x"] },
          { id: "webui-B", title: "B", chat: [] },
        ],
      });
      const tab1 = { sessionId: "webui-A", mcodeSessionId: "mvs_sid_A", sessionTitle: "Old", usage: {} };
      const tab2 = { sessionId: "webui-OTHER", mcodeSessionId: "mvs_sid_A", sessionTitle: "Old", usage: {} };
      const tab3 = { sessionId: "webui-B", mcodeSessionId: null, sessionTitle: "B", usage: {} };
      clients.set("tab-1", tab1);
      clients.set("tab-2", tab2);
      clients.set("tab-3", tab3);
      const w = await mod.applyEngineSessionRename({ id: "webui-A", title: "New", cid: "tab-1" });
      assert.equal(w.outcome, "ok");
      assert.equal(w.matchKind, "webuiId");
      assert.equal(w.from, "Old");
      assert.deepEqual(w.payload, {
        ok: true,
        session: { id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "New", titleCustom: true },
      });
      assert.equal(tab1.sessionTitle, "New");
      assert.equal(tab2.sessionTitle, "New", "a tab bound to the same engine sid sees the new label too");
      assert.equal(tab3.sessionTitle, "B", "an unrelated tab is untouched");
      assert.deepEqual(pushes.sort(), ["tab-1", "tab-2"]);
      // The rename touches NO engine surface: no SQL, no kill, no cache
      // drop. Only the tree cache, because the sidebar projects titles
      // from the engine and would otherwise show a stale one.
      assert.deepEqual(journal, ["invalidate-tree", "push:tab-1", "push:tab-2"]);
    });

    test("a bare mvs_ id gets an overlay record; an unknown id is a 404 outcome", async (t) => {
      // `setupMocks` owns `lib/sessions.js` in this test context and
      // node:test refuses a second registration for the same specifier
      // (ERR_INVALID_STATE), so the store comes from the shared helper's
      // mutable holder. M3-B5 added `ensureOverlayForMcodeSid` to that
      // helper's namespace for exactly this case; the fixture therefore
      // observes the real single-identity behaviour instead of a private
      // stub that could drift from it.
      const { mod, clients } = await loadWritePath(t, { records: [] });
      const w = await mod.applyEngineSessionRename({ id: ORPHAN_SID, title: "Named", cid: "tab-1" });
      assert.equal(w.outcome, "ok");
      assert.equal(w.matchKind, "orphan_mcode");
      assert.equal(w.from, "Mcode session", "the placeholder title the overlay was born with");
      assert.equal(w.to, "Named");
      assert.equal(w.item.id, ORPHAN_SID, "the overlay's webui id IS the engine sid (single identity)");
      assert.equal(w.item.mcodeSessionId, ORPHAN_SID);
      assert.equal(w.item.titleCustom, true);
      assert.deepEqual(w.payload, {
        ok: true,
        session: { id: ORPHAN_SID, mcodeSessionId: ORPHAN_SID, title: "Named", titleCustom: true },
      });
      const { getSessionsStore } = await import("../../helpers/_setup.js");
      assert.deepEqual(
        getSessionsStore().map((r) => r.id),
        [ORPHAN_SID],
        "and the overlay is PERSISTED — a rename that is not saved is a label the next load loses",
      );
      // No workspace is stamped onto someone else's record
      // (webui-parity 63, defect F): the fixture's store never carried a
      // workspace argument and the overlay's is "".
      assert.equal(getSessionsStore()[0].workspace, "");

      // A webui uuid that resolves to nothing is a 404, and it must NOT
      // fabricate a record — a wrong id should say so.
      const missing = await mod.applyEngineSessionRename({ id: "no-such-id", title: "Named", cid: "tab-1" });
      assert.equal(missing.outcome, "not_found");
      assert.deepEqual(missing.payload, { ok: false, error: "session not found" });
      assert.equal(
        getSessionsStore().length,
        1,
        "no second overlay was fabricated for the unknown id",
      );
      void clients;
    });

    test("rename never throws a capability error, whatever the provider says", async (t) => {
      // The end-to-end statement of the `null` declaration row: a
      // provider that has NO session CRUD at all cannot stop a rename,
      // because a rename does not ask the engine for anything.
      await setupMocks(t, { acp: {}, sessions: { initial: [{ id: "webui-A", title: "Old", chat: [] }] } });
      t.mock.module(absPath("engine/index.js"), {
        namedExports: {
          DEFAULT_ENGINE_PROVIDER_ID: "fixture-provider",
          getEngineProvider: () => ({
            id: "fixture-provider",
            transport: "runtime",
            capabilities: { sessionCrud: { level: "none", reason: "fixture: no CRUD at all" } },
          }),
        },
      });
      const mod = await import(`${absPath("engine/session-writes.js")}?ren=${bust++}`);
      // planEngineSessionDelete WOULD throw here — that is the point of
      // the hard row. Rename must not.
      await assert.rejects(() => mod.planEngineSessionDelete({ id: "webui-A", transport: RUNTIME }));
      const w = await mod.applyEngineSessionRename({ id: "webui-A", title: "New", cid: "tab-1" });
      assert.equal(w.outcome, "ok");
      assert.equal(w.gate.gate, "no-capability-key");
    });
  });

  // ---------------------------------------------------------------------
  // 7. The route — and the proof that the facade mock took
  // ---------------------------------------------------------------------

  describe("the routes ask the facade and keep their own HTTP contract", () => {
    // Every export `routes/sessions.js` binds from the facade. A
    // `mock.module` that omits one of these makes the route fail at
    // INSTANTIATION with a `SyntaxError` that reads like a product bug;
    // the ones a case does not want are filled with throwers.
    const FACADE_EXPORTS = [
      "ORPHAN_STALE_MS",
      "SESSION_WRITE_ENDPOINTS",
      "applyDeletedSessionToClientState",
      "applyEngineSessionRename",
      "applyRenamedSessionToClientState",
      "assertSessionWriteCapability",
      "clientMatchesDeletedSession",
      "clientMatchesRenamedSession",
      "commitEngineOrphanSessionDelete",
      "commitEngineSessionDelete",
      "isMcodeSessionId",
      "isOrphanSessionRecord",
      "planEngineSessionDelete",
      "previewEngineSessionDelete",
      "readOrphanSessionWriteIds",
      "resolveSessionTarget",
      "resolveSessionWriteProvider",
      "selectOrphanSessionIds",
    ];
    const NOT_STUBBED = (name) => () => {
      throw new Error(`B5 route test called ${name}, which this case did not stub`);
    };
    function mockFacade(t, overrides) {
      // The route legitimately calls one PURE facade export before it
      // calls any writer: `isMcodeSessionId`, for the arrival log line
      // and the `authorize()` context. It is filled with the REAL
      // implementation rather than a thrower, because it has no side
      // effects and a stubbed copy could disagree with the engine module
      // the CONTROL test exercises. Every export that WRITES keeps the
      // thrower, so an unexpected mutation stays loud.
      const namedExports = {
        isMcodeSessionId: (id) => typeof id === "string" && /^mvs_[a-f0-9]{32}$/.test(id),
        ORPHAN_STALE_MS: 24 * 60 * 60 * 1000,
      };
      for (const name of FACADE_EXPORTS) {
        if (namedExports[name] === undefined) namedExports[name] = NOT_STUBBED(name);
      }
      Object.assign(namedExports, overrides);
      t.mock.module(absPath("engine/session-writes.js"), { namedExports });
    }

    test("#7 writes the facade's 200 body verbatim, with the charset header", async (t) => {
      await setupMocks(t, { acp: {} });
      const payload = {
        ok: true,
        deleted: "webui-A",
        matchKind: "webuiId",
        dryRun: false,
        remaining: 3,
        mcodeDbDel: { ok: true, log: ["local_runtime_sessions:1"] },
      };
      mockFacade(t, {
        planEngineSessionDelete: async () => ({
          id: "webui-A",
          records: [],
          index: 0,
          matchKind: "webuiId",
          target: { id: "webui-A" },
          isOrphan: false,
          chatLen: 0,
          gate: { gate: "checked" },
          transport: RUNTIME,
        }),
        commitEngineSessionDelete: async () => ({
          deletedItem: { id: "webui-A", title: "A" },
          records: [{}, {}, {}],
          mcodeDbDel: payload.mcodeDbDel,
          touchedCids: ["tab-1"],
          payload,
        }),
      });
      const route = await loadRoute();
      const res = mkRes();
      await withDecisions(() =>
        route.handleDeleteSession(
          { url: "/api/sessions/webui-A" },
          res,
          { cs: {}, cid: "tab-1", pathname: "/api/sessions/webui-A" },
        ),
      );
      assert.equal(res.written[0].status, 200);
      assert.equal(
        res.written[0].headers["Content-Type"],
        "application/json; charset=utf-8",
      );
      assert.equal(res.written[1].body, JSON.stringify(payload));
    });

    // Table-driven: the status and the Content-Type per branch. The
    // charset is NOT uniform in the pre-facade code — the 400/404/500
    // branches send bare `application/json` while the 200/403 branches
    // send the charset form — and a refactor that "tidied" that would be
    // a silent contract change, so the exact pair is pinned per branch.
    const STATUSES = [
      ["400", { "Content-Type": "application/json" }, "/api/sessions/"],
      ["404", { "Content-Type": "application/json" }, "/api/sessions/no-such-webui-id"],
    ];
    for (const [status, headers, pathname] of STATUSES) {
      test(`#7 answers ${status} with ${JSON.stringify(headers)} — unchanged`, async (t) => {
        await setupMocks(t, { acp: {} });
        mockFacade(t, {
          planEngineSessionDelete: async () => ({
            id: "no-such-webui-id",
            records: [],
            index: -1,
            matchKind: null,
            target: null,
            isOrphan: true,
            chatLen: 0,
            gate: { gate: "checked" },
            transport: RUNTIME,
          }),
        });
        const route = await loadRoute();
        const res = mkRes();
        await withDecisions(() =>
          route.handleDeleteSession({ url: pathname }, res, {
            cs: {},
            cid: "tab-1",
            pathname,
          }),
        );
        assert.equal(res.written[0].status, Number(status));
        assert.deepEqual(res.written[0].headers, headers);
        if (status === "404") {
          assert.deepEqual(JSON.parse(res.written[1].body), {
            ok: false,
            error: "session not found",
          });
        }
      });
    }

    test("#7 still 403s on a declined authorize(), before anything is mutated", async (t) => {
      await setupMocks(t, { acp: {} });
      let committed = false;
      mockFacade(t, {
        planEngineSessionDelete: async () => ({
          id: "webui-A",
          records: [{ id: "webui-A", title: "A", chat: ["● hi"] }],
          index: 0,
          matchKind: "webuiId",
          target: { id: "webui-A" },
          isOrphan: false,
          chatLen: 1,
          gate: { gate: "checked" },
          transport: RUNTIME,
        }),
        commitEngineSessionDelete: async () => {
          committed = true;
          return { payload: { ok: true } };
        },
      });
      const route = await loadRoute();
      const res = mkRes();
      await withDecisions(
        () =>
          route.handleDeleteSession({ url: "/api/sessions/webui-A" }, res, {
            cs: {},
            cid: "tab-1",
            pathname: "/api/sessions/webui-A",
          }),
        { approve: false },
      );
      assert.equal(res.written[0].status, 403);
      assert.equal(
        JSON.parse(res.written[1].body).error,
        "authorize declined",
      );
      assert.equal(committed, false, "a declined gate must not reach the commit at all");
    });

    test("#4 keeps its three 400 bodies and never reaches the facade", async (t) => {
      await setupMocks(t, { acp: {} });
      let called = false;
      mockFacade(t, {
        applyEngineSessionRename: async () => {
          called = true;
          return { outcome: "ok" };
        },
      });
      const route = await loadRoute();
      // Table-driven over the three validation failures, all of which are
      // request validation and therefore stay in the route.
      const CASES = [
        [{ title: "New" }, "id required"],
        [{ id: "webui-A" }, "title required"],
        [{ id: "webui-A", title: "   " }, "title required"],
        [{ id: "webui-A", title: "x".repeat(201) }, "title too long (max 200)"],
      ];
      for (const [body, error] of CASES) {
        const res = mkRes();
        await route.handleRenameSession(jsonReq(body), res, { cid: "tab-1" });
        assert.equal(res.written[0].status, 400, JSON.stringify(body).slice(0, 40));
        assert.equal(
          res.written[0].headers["Content-Type"],
          "application/json; charset=utf-8",
        );
        assert.deepEqual(JSON.parse(res.written[1].body), { ok: false, error });
      }
      assert.equal(called, false, "validation happens before the facade is consulted");
    });

    test("#4 answers 404 for the facade's not_found outcome and 200 otherwise", async (t) => {
      await setupMocks(t, { acp: {} });
      let current = {
        outcome: "not_found",
        payload: { ok: false, error: "session not found" },
        matchKind: null,
        from: "",
        to: "T",
        item: null,
      };
      mockFacade(t, { applyEngineSessionRename: async () => current });
      const route = await loadRoute();
      for (const [outcome, expectedStatus, body] of [
        ["not_found", 404, { ok: false, error: "session not found" }],
        [
          "ok",
          200,
          { ok: true, session: { id: "webui-A", mcodeSessionId: null, title: "T", titleCustom: true } },
        ],
      ]) {
        current =
          outcome === "not_found"
            ? { outcome, payload: body, matchKind: null, from: "", to: "T", item: null }
            : { outcome, payload: body, matchKind: "webuiId", from: "Old", to: "T", item: { id: "webui-A", title: "T" } };
        const res = mkRes();
        await route.handleRenameSession(jsonReq({ id: "webui-A", title: "T" }), res, {
          cid: "tab-1",
        });
        assert.equal(res.written[0].status, expectedStatus, outcome);
        assert.deepEqual(JSON.parse(res.written[1].body), body);
      }
    });

    test("#6 writes the facade's preview body byte-for-byte", async (t) => {
      await setupMocks(t, { acp: {} });
      const ids = ["old-1", "old-2"];
      mockFacade(t, {
        readOrphanSessionWriteIds: async () => ({
          ids,
          payload: { ok: true, dryRun: true, count: 2, ids },
          gate: { gate: "checked", enforcement: "hard" },
          transport: RUNTIME,
        }),
      });
      const route = await loadRoute();
      const res = mkRes();
      await route.handleCleanupOrphans({ url: "/api/sessions/cleanup-orphans?dryRun=true" }, res, {
        cid: "tab-1",
      });
      assert.equal(res.written[0].status, 200);
      assert.equal(
        res.written[0].headers["Content-Type"],
        "application/json; charset=utf-8",
      );
      // The batch's byte-for-byte red line, asserted at the HTTP edge
      // and not only inside the facade.
      assert.equal(
        res.written[1].body,
        '{"ok":true,"dryRun":true,"count":2,"ids":["old-1","old-2"]}',
      );
    });

    test("#6's no-op real path keeps its own four-key body", async (t) => {
      await setupMocks(t, { acp: {} });
      mockFacade(t, {
        readOrphanSessionWriteIds: async () => ({
          ids: [],
          payload: { ok: true, dryRun: true, count: 0, ids: [] },
          gate: { gate: "checked" },
          transport: RUNTIME,
        }),
      });
      const route = await loadRoute();
      const res = mkRes();
      await route.handleCleanupOrphans({ url: "/api/sessions/cleanup-orphans" }, res, {
        cid: "tab-1",
      });
      assert.equal(res.written[0].status, 200);
      assert.equal(
        res.written[1].body,
        '{"ok":true,"dryRun":false,"deleted":0,"ids":[]}',
      );
    });

    // ---- proof the facade mock actually took ---------------------------

    test("PROOF: a marker error escapes the untouched #7 route", async (t) => {
      // Without a fresh `?bust=` re-import, `mock.module` would leave the
      // route holding the PREVIOUS test's live binding, the marker would
      // never be thrown, and this assertion would fail — which is the
      // point: it is the only assertion in this section that cannot pass
      // by accident.
      await setupMocks(t, { acp: {} });
      const marker = new Error("B5-MOCK-WAS-NOT-HONOURED");
      mockFacade(t, {
        planEngineSessionDelete: async () => {
          throw marker;
        },
      });
      const route = await loadRoute();
      let caught = null;
      try {
        await withDecisions(() =>
          route.handleDeleteSession({ url: "/api/sessions/webui-A" }, mkRes(), {
            cs: {},
            cid: "tab-1",
            pathname: "/api/sessions/webui-A",
          }),
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(
        caught,
        "the route swallowed the facade error — either the mock did not take, or the route grew a catch",
      );
      assert.equal(caught, marker, "the error is the mock's, by identity");
    });

    test("PROOF: a marker error escapes the untouched #6 route", async (t) => {
      // The same proof for the second facade consumer. A single proof
      // would not cover a route that imported a different subset of the
      // module.
      await setupMocks(t, { acp: {} });
      const marker = new Error("B5-SWEEP-MOCK-WAS-NOT-HONOURED");
      mockFacade(t, {
        readOrphanSessionWriteIds: async () => {
          throw marker;
        },
      });
      const route = await loadRoute();
      let caught = null;
      try {
        await route.handleCleanupOrphans({ url: "/api/sessions/cleanup-orphans" }, mkRes(), {
          cid: "tab-1",
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "the sweep route swallowed the facade error");
      assert.equal(caught, marker);
    });

    test("CONTROL: with no facade mock, #7 reaches the real write path", async (t) => {
      // The other half of the proof. A `?bust=` re-import under a fresh
      // test hook gives a route bound to the REAL facade, so the request
      // runs the actual plan → commit sequence against the mocked store
      // and the real SQL deleter. If this answered from a mock, the two
      // PROOF cases above would be proving nothing.
      const { dbCalls } = await loadWritePath(t, {
        records: [{ id: "webui-A", title: "A", chat: ["● hi"] }],
      });
      const route = await loadRoute();
      const res = mkRes();
      await withDecisions(() =>
        route.handleDeleteSession({ url: "/api/sessions/webui-A" }, res, {
          cs: {},
          cid: "tab-1",
          pathname: "/api/sessions/webui-A",
        }),
      );
      assert.equal(res.written[0].status, 200);
      const body = JSON.parse(res.written[1].body);
      assert.equal(body.ok, true);
      assert.equal(body.deleted, "webui-A");
      assert.equal(body.matchKind, "webuiId");
      // A webui-only record has no engine sid, so the deleter is not
      // asked — and the response says so rather than inventing a result.
      assert.equal(body.mcodeDbDel, null);
      assert.equal(dbCalls.length, 0);
    });
  });

  // ---------------------------------------------------------------------
  // 8. The audit chain, across the route/facade boundary
  // ---------------------------------------------------------------------

  describe("RED LINE — the audit chain is intact across the split", () => {
    // The one thing the plan→commit split could have broken: the
    // write-ahead intent line has to land BETWEEN the plan and the
    // mutation. These run the REAL route against the REAL facade, with
    // only the audit sink and the SQL layer journalled, and assert the
    // ORDER of the three events.
    async function loadAuditedRoute(t, options = {}) {
      await setupMocks(t, { acp: {}, sessions: { initial: options.records || [] } });
      const events = [];
      mockAll(
        t,
        "lib/events.js",
        {
          append: (kind, data) => {
            events.push({ kind, data });
          },
        },
        ["append", "read", "readAll", "verifyChain", "EVENTS_PATH"],
      );
      mockAll(
        t,
        "engine/session-delete.js",
        {
          previewSessionDeleteRows: (sid, o) => {
            events.push({ kind: `sql(${sid},dryRun=true)` });
            return { ok: true, dryRun: true, log: [], totalRows: 0 };
          },
          deleteSessionThroughEngine: async (sid, o) => {
            events.push({ kind: `sql(${sid},dryRun=false)` });
            return { ok: true, outcome: "deleted", log: ["local_runtime_sessions:1"], totalRowsDeleted: 1, tablesAbsent: 0 };
          },
        },
        ["previewSessionDeleteRows", "deleteSessionThroughEngine", "SESSION_DELETE_PREVIEW_TABLES"],
      );
      mockAll(
        t,
        "lib/session-tree.js",
        { invalidateSessionTree: () => {}, getSessionTree: () => ({ ok: true, tree: [] }) },
        ["getSessionTree", "invalidateSessionTree"],
      );
      mockAll(
        t,
        "lib/state-bus.js",
        {
          clients: new Map(),
          pushStateFor: () => {},
          runChatViewChat: () => ({}),
          makeClientState: () => ({ usage: {} }),
        },
        ["clients", "pushStateFor", "runChatViewChat", "makeClientState", "setState", "getClient", "sseByCid", "pushAlert"],
      );
      return { events, route: await loadRoute() };
    }

    test("a real delete writes intent BEFORE the rows go, and the outcome after", async (t) => {
      const { events, route } = await loadAuditedRoute(t, {
        records: [
          { id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: ["● hi", "● there"] },
        ],
      });
      const res = mkRes();
      await withDecisions(() =>
        route.handleDeleteSession({ url: "/api/sessions/webui-A" }, res, {
          cs: {},
          cid: "tab-1",
          pathname: "/api/sessions/webui-A",
        }),
      );
      assert.equal(res.written[0].status, 200);
      assert.deepEqual(
        events.map((e) => e.kind),
        ["session.delete.intent", "sql(mvs_sid_A,dryRun=false)", "session.delete"],
        "the intent line lands before the mutation, the outcome line after it",
      );
      // The intent payload carries exactly the three facts the authorize
      // modal showed the user, which is the point of computing them in
      // the plan and passing them through unchanged.
      assert.equal(events[0].data.payload.matchKind, "webuiId");
      assert.equal(events[0].data.payload.isOrphan, false);
      assert.equal(events[0].data.payload.chatLen, 2);
      assert.ok(events[0].data.payload.decidedBy, "and the authorizer's decision");
      assert.equal(events[2].data.payload.dryRun, false);
      assert.equal(events[2].data.payload.title, "A", "the title is logged — it was user-visible in the sidebar");
      assert.ok("touchedCids" in events[2].data.payload, "the fan-out effect is recorded");
    });

    test("a declined authorize writes NO intent line and never touches the engine", async (t) => {
      const { events, route } = await loadAuditedRoute(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: [] }],
      });
      const res = mkRes();
      await withDecisions(
        () =>
          route.handleDeleteSession({ url: "/api/sessions/webui-A" }, res, {
            cs: {},
            cid: "tab-1",
            pathname: "/api/sessions/webui-A",
          }),
        { approve: false },
      );
      assert.equal(res.written[0].status, 403);
      assert.deepEqual(events, [], "a refused delete is not an audited one — nothing was attempted");
    });

    test("a dryRun preview is audited as a PREVIEW and never mutates", async (t) => {
      const { events, route } = await loadAuditedRoute(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "A", chat: [] }],
      });
      const res = mkRes();
      await withDecisions(() =>
        route.handleDeleteSession({ url: "/api/sessions/webui-A?dryRun=true" }, res, {
          cs: {},
          cid: "tab-1",
          pathname: "/api/sessions/webui-A",
        }),
      );
      assert.equal(res.written[0].status, 200);
      assert.deepEqual(
        events.map((e) => e.kind),
        ["sql(mvs_sid_A,dryRun=true)", "session.delete"],
      );
      assert.equal(
        events[1].data.payload.dryRun,
        true,
        "the dryRun marker is what lets an operator tell a preview from a real delete",
      );
      const { getSessionsStore } = await import("../../helpers/_setup.js");
      assert.equal(getSessionsStore().length, 1, "and the record is still there");
    });

    test("a rename is audited with from → to and the resolved match kind", async (t) => {
      const { events, route } = await loadAuditedRoute(t, {
        records: [{ id: "webui-A", mcodeSessionId: "mvs_sid_A", title: "Old", chat: [] }],
      });
      const res = mkRes();
      await route.handleRenameSession(jsonReq({ id: "mvs_sid_A", title: "New" }), res, {
        cid: "tab-1",
      });
      assert.equal(res.written[0].status, 200);
      assert.deepEqual(events.map((e) => e.kind), ["session.rename"]);
      assert.equal(events[0].data.payload.matchKind, "mcodeSessionId", "renamed through the engine sid");
      assert.equal(events[0].data.payload.from, "Old");
      assert.equal(events[0].data.payload.to, "New");
      assert.equal(events[0].data.payload.mcodeSessionId, "mvs_sid_A");
    });
  });
});

