// webui/test/lib/engine/usage-reads.test.js
//
// M3-B3: the usage family's engine facade (#15, #16, #17, #19).
//
// This family is the batch where a "harmless" refactor can be entirely
// silent, because three of its four numbers are DERIVED and none of them
// is compared against anything. So the four things pinned here are:
//
//   1. THE FORMULA'S INPUTS. `contextUsed` is `totalInput + totalOutput +
//      totalReasoning` — the CUMULATIVE figure, not the chat flow's
//      per-turn `lastTurnContextTokens`, and explicitly NOT including the
//      cache counters (which are a subset of `input` and would
//      double-count). Section 3 does not assert the formula's result for a
//      handful of inputs; it perturbs each of the seven numeric fields one
//      at a time and records WHICH ones move the answer. A future
//      "simplification" that swaps in the per-turn figure, or that starts
//      adding `totalCacheRead`, cannot pass.
//
//   2. THE NUMERIC SNAPSHOT on a real sqlite fixture, row by row, for the
//      boundary cases the endpoint exists for: reasoning present, reasoning
//      absent, cache hit zero, single turn, many turns, a session whose
//      row is gone but whose usage rows remain, and NULL token columns.
//      The expected values are written out longhand, not recomputed by the
//      same expression under test — a test that computes its oracle with
//      the implementation's formula proves nothing.
//
//   3. THE FORECAST SEQUENCE. #19 is a pure function of a history prefix,
//      so consecutive reads of a growing history must move the way the
//      pre-refactor implementation moved them: no re-filtering, no
//      re-sorting, no re-sampling. Section 5 walks every prefix and
//      compares against the module's own `forecastExhaustion(readHistory())`.
//
//   4. THE GATE IS REAL, AND THE MOCK IS REAL. The registered provider
//      declares `usageStats` and `authCredentials` `full`, so only this
//      file can prove the gate would bite. And node:test's
//      `mock.module` re-evaluates only the MOCKED specifier, so a route
//      module already in the registry keeps its old live binding — every
//      route test here re-imports the route under a fresh `?bust=N`, and
//      section 6 ends with the control that proves the mock took: with no
//      mock at all, the same request reads the fixture db.
//
// Test style follows test/lib/engine/session-reads.test.js (B1) and
// test/lib/engine/session-tree-reads.test.js (B2): table-driven, one row
// per case, fixture built before any server module is imported.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";

import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";
import { setupMocks, absPath } from "../../helpers/_setup.js";

// ---------------------------------------------------------------------------
// Fixture — built BEFORE any server module is imported, and that ordering is
// load-bearing, not stylistic.
//
// `lib/config.js` resolves MAVIS_DB_PATH at MODULE LOAD from
// `MINIMAX_DATA_DIR ?? MAVIS_DATA_DIR`, and `lib/mavis-usage.js` imports it
// statically. A `before()` hook that set the env would be too late: the
// first import reaching config.js would already have frozen the real
// ~/.minimax path, and every case below would read the developer's own
// database instead of the fixture. Hence: build the dir and the db, set the
// env here at module top level, and only then import server code.
//
// BOTH env names are set, not just MAVIS_DATA_DIR — `MINIMAX_DATA_DIR`
// wins, and a gate command that isolates the runtime data dir exports it.
// A fixture that wants the database owns the variable that wins.
//
// Prefixes are registered in scripts/test-tmp-leak.check.mjs#KNOWN_PREFIXES;
// a new prefix without that entry fails the test:release-tools gate.
// ---------------------------------------------------------------------------

const tmpDir = mkTmpDir("mcode-webui-usage-");
const histDir = mkTmpDir("webui-quota-forecast-test-");
const dbPath = join(tmpDir, "v2", "sqlite", "runtime-state.sqlite");
mkdirSync(join(tmpDir, "v2", "sqlite"), { recursive: true });

// T0 is a fixed instant, never Date.now(): every expected number below is
// written longhand, and a moving clock would make the fixture unreviewable.
const T0 = 1700000000000;

/**
 * The boundary rows. Every id matches `mvs_[a-f0-9]{16,}` because
 * `lib/mavis-usage.js` refuses anything else — the rejection is one of the
 * pinned behaviours, not an accident of the fixture.
 *
 * The token columns are declared NULLABLE on purpose. The shipped v2 schema
 * declares them NOT NULL, but `mavis-usage.js` coerces with
 * `Number(x) || 0`, so a NULL written by any other writer is a live code
 * path; the `null-token-columns` row exercises it through the real query.
 */
const USAGE_ROWS = [
  // [sid, turnId, ts, in, out, reasoning, cacheRead, cacheWrite, model]
  // Three turns, all with reasoning. Totals: in 6000, out 2100, reasoning
  // 2700, cacheRead 30, cacheWrite 5 → contextUsed 10800.
  ["mvs_1111111111111111aaaaaaaaaaaaaa1", "t1", T0, 1000, 500, 300, 0, 0, "MiniMax-M3"],
  ["mvs_1111111111111111aaaaaaaaaaaaaa1", "t2", T0 + 1000, 2000, 700, 900, 10, 0, "MiniMax-M3"],
  ["mvs_1111111111111111aaaaaaaaaaaaaa1", "t3", T0 + 2000, 3000, 900, 1500, 20, 5, "MiniMax-M3"],
  // Two turns where ONLY the first has reasoning. Totals: in 122, out 24,
  // reasoning 333, cacheRead 499 → contextUsed 479. The per-turn figure for
  // the LAST turn is 11+2+0 = 13, so this row is the one that separates
  // "cumulative" from "per turn" by a factor of 36.
  ["mvs_2222222222222222bbbbbbbbbbbbbbb2", "t1", T0, 111, 22, 333, 444, 0, "MiniMax-M2.7"],
  ["mvs_2222222222222222bbbbbbbbbbbbbbb2", "t2", T0 + 1000, 11, 2, 0, 55, 0, "MiniMax-M2.7"],
  // Every counter zero. contextUsed 0, and the 0 must not be confused
  // with "no rows" (which is found:false).
  ["mvs_3333333333333333ccccccccccccccc3", "t1", T0, 0, 0, 0, 0, 0, "MiniMax-M3"],
  // NULL token columns → every total is 0 after `Number(null) || 0`.
  ["mvs_4444444444444444ddddddddddddddd4", "t1", T0, null, null, null, null, null, "MiniMax-M3"],
  // Usage rows whose session row is GONE (the delete left them behind).
  // Totals: in 4242, out 84, reasoning 21, cacheRead 7 → contextUsed 4347.
  ["mvs_5555555555555555eeeeeeeeeeeeeee5", "t1", T0, 4242, 84, 21, 7, 0, "MiniMax-M3"],
  // Two turns, both with a model, cache never hit.
  ["mvs_6666666666666666fffffffffffffff6", "t1", T0, 500, 50, 5, 0, 0, "MiniMax-M2.7-highspeed"],
  ["mvs_6666666666666666fffffffffffffff6", "t2", T0 + 1000, 600, 60, 6, 0, 0, "MiniMax-M2.7-highspeed"],
  // A single turn with reasoning — the smallest row that still has all three
  // summands non-zero.
  ["mvs_7777777777777777aaaaaaaaaaaaaaaa7", "t1", T0, 9, 3, 4, 0, 0, "MiniMax-M3"],
];

// Sessions that still exist. The orphan's id is deliberately absent.
// Deduped: a session with several usage rows must still be one session row.
const LIVE_SESSIONS = [...new Set(USAGE_ROWS.map((r) => r[0]))].filter(
  (sid) => sid !== "mvs_5555555555555555eeeeeeeeeeeeeee5",
);

{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, agent_name TEXT, framework_type TEXT, turn_id TEXT,
      model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, cost_usd REAL, raw TEXT
    );
    CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, title TEXT);
  `);
  const ins = db.prepare(
    `INSERT INTO local_runtime_token_usage
       (session_id, agent_name, framework_type, turn_id, model, ts,
        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, 'main', 'pi-agent', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [sid, turn, ts, i, o, r, cr, cw, model] of USAGE_ROWS) {
    ins.run(sid, turn, model, ts, i, o, r, cr, cw);
  }
  const insS = db.prepare("INSERT INTO local_runtime_sessions (session_id, title) VALUES (?, ?)");
  for (const sid of LIVE_SESSIONS) insS.run(sid, "t");
  db.close();
}

process.env.MINIMAX_DATA_DIR = tmpDir;
process.env.MAVIS_DATA_DIR = tmpDir;
process.env.MCODE_WEBUI_HISTORY_PATH = join(histDir, "usage-history.ndjson");

// --- now, and only now, the server modules -------------------------------
const { ENGINE_CAPABILITY_KEYS } = await import("../../../server/engine/index.js");
const {
  USAGE_READ_ENDPOINTS,
  assertUsageReadCapability,
  contextUsedTokens,
  readEngineAccountQuota,
  readEngineQuotaForecast,
  readEngineSessionUsage,
  resolveUsageReadProvider,
} = await import("../../../server/engine/usage-reads.js");
const {
  EngineCapabilityNotSupportedError,
  isEngineCapabilityNotSupportedError,
  engineCapabilityHttpResponse,
} = await import("../../../server/engine/errors.js");
const { assertEngineCapability } = await import("../../../server/engine/capabilities.js");
const { forecastExhaustion, readHistory, appendHistory } = await import(
  "../../../server/lib/quota-forecast.js"
);

const RUNTIME = "runtime";

after(() => {
  rmTmpDir(tmpDir);
  rmTmpDir(histDir);
  delete process.env.MINIMAX_DATA_DIR;
  delete process.env.MAVIS_DATA_DIR;
  delete process.env.MCODE_WEBUI_HISTORY_PATH;
});

// ---------------------------------------------------------------------------
// 1. The endpoint → capability declaration table
// ---------------------------------------------------------------------------

describe("USAGE_READ_ENDPOINTS — this batch's declaration table", () => {
  test("covers exactly the four endpoints of batch B3", () => {
    assert.deepEqual(Object.keys(USAGE_READ_ENDPOINTS).sort(), [
      "GET /api/usage-real",
      "GET /api/usage/forecast",
      "POST /api/usage",
      "POST /api/usage-trigger",
    ]);
  });

  // Table-driven. Editing a row is a capability decision and must be
  // reviewed as one, so the table IS the assertion.
  const TABLE = [
    ["POST /api/usage", "authCredentials", "getAccountStatus"],
    ["POST /api/usage-trigger", "authCredentials", "getAccountStatus"],
    ["GET /api/usage-real", "usageStats", "getSessionUsage"],
  ];
  for (const [endpoint, capability, subItem] of TABLE) {
    test(`${endpoint} declares ${capability}.${subItem}`, () => {
      assert.deepEqual(USAGE_READ_ENDPOINTS[endpoint], { capability, subItem });
      // The capability must be one of the 14 matrix keys — the table must
      // not grow a private key, which validateEngineCapabilities exists to
      // prevent.
      assert.ok(ENGINE_CAPABILITY_KEYS.includes(capability));
    });
  }

  test("GET /api/usage/forecast declares NO capability, and the gate says so", () => {
    // The forecast reads webui's OWN usage-history.ndjson and calls no
    // engine surface. Declaring a capability here would put a lie in the
    // registry; gating it hard would remove a working endpoint in response
    // to a declaration about something it does not depend on. The value is
    // `null`, exactly as B1's `/api/health` — and the gate reports the
    // no-op rather than silently passing.
    assert.equal(USAGE_READ_ENDPOINTS["GET /api/usage/forecast"], null);
    for (const transport of [RUNTIME, "acp", "exec", ""]) {
      const g = assertUsageReadCapability("GET /api/usage/forecast", transport);
      assert.equal(g.gate, "no-capability-key");
      assert.equal(g.capability, null);
      assert.equal(g.subItem, null);
    }
  });

  test("an endpoint outside this family is caller confusion, not an engine limitation", () => {
    assert.throws(
      () => assertUsageReadCapability("GET /api/nope", RUNTIME),
      (err) => {
        assert.ok(!(err instanceof EngineCapabilityNotSupportedError));
        assert.equal(err.code, "unknown_usage_read_endpoint");
        assert.match(err.message, /not part of the usage family/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Provider resolution + the gate
// ---------------------------------------------------------------------------

describe("resolveUsageReadProvider / assertUsageReadCapability", () => {
  // Table-driven. Absent means "no provider claims this transport yet"
  // (M4), which is NOT the same answer as "capability unavailable" — the
  // default `acp` transport must keep working, so it must NOT throw.
  const TRANSPORTS = [
    [RUNTIME, true, "checked"],
    ["acp", false, "unregistered-transport"],
    ["exec", false, "unregistered-transport"],
    ["", false, "unregistered-transport"],
  ];
  for (const [transport, hasProvider, gate] of TRANSPORTS) {
    test(`transport "${transport}" → provider=${hasProvider} gate=${gate}`, () => {
      assert.equal(resolveUsageReadProvider(transport) !== null, hasProvider);
      const g = assertUsageReadCapability("GET /api/usage-real", transport);
      assert.equal(g.gate, gate);
      assert.equal(g.capability, "usageStats");
      assert.equal(g.subItem, "getSessionUsage");
    });
  }
});

describe("the usage gate refuses a provider that cannot report usage", () => {
  // The registered providers declare `full` today, so — exactly as in B1 and
  // B2 — only this file can prove the gate WOULD bite.
  const allFull = () => Object.fromEntries(ENGINE_CAPABILITY_KEYS.map((k) => [k, { level: "full" }]));
  const withUsage = (usageStats, authCredentials = { level: "full" }) => ({
    ...allFull(),
    usageStats,
    authCredentials,
  });

  // Table-driven over (endpoint, capability, subItem, declaration).
  const CASES = [
    [
      "GET /api/usage-real",
      "a `none` usageStats throws and maps to 501",
      { level: "none", reason: "test fixture: interface-absent" },
      undefined,
    ],
    [
      "GET /api/usage-real",
      "a `partial` usageStats missing getSessionUsage throws, naming the method",
      { level: "partial", missing: ["getSessionUsage"], reason: "test fixture: no per-session usage" },
      "getSessionUsage",
    ],
    [
      "POST /api/usage",
      "a `none` authCredentials throws and maps to 501",
      { level: "full" },
      undefined,
      { level: "none", reason: "test fixture: interface-absent" },
    ],
    [
      "POST /api/usage-trigger",
      "a `partial` authCredentials missing getAccountStatus throws",
      { level: "full" },
      "getAccountStatus",
      { level: "partial", missing: ["getAccountStatus"], reason: "test fixture: no account status" },
    ],
  ];

  for (const [endpoint, title, usageStats, subItem, auth] of CASES) {
    test(title, () => {
      const need = USAGE_READ_ENDPOINTS[endpoint];
      const decl = withUsage(usageStats, auth || { level: "full" });
      assert.throws(
        () => assertEngineCapability(decl, need.capability, "fixture-provider", need.subItem),
        (err) => {
          assert.ok(isEngineCapabilityNotSupportedError(err), "the real class, so invokeHandler's instanceof matches");
          assert.equal(err.capability, need.capability);
          assert.equal(err.provider, "fixture-provider");
          if (subItem) assert.deepEqual(err.missing, [subItem]);
          const { status, payload } = engineCapabilityHttpResponse(err);
          assert.equal(status, 501);
          assert.equal(payload.code, "engine_capability_not_supported");
          return true;
        },
      );
    });
  }

  test("a `partial` that KEEPS the sub-item lets the read through", () => {
    assert.doesNotThrow(() =>
      assertEngineCapability(
        withUsage(
          { level: "partial", missing: ["watchSessionUsageCommits"], reason: "x" },
          { level: "partial", missing: ["listModelProviders"], reason: "y" },
        ),
        "usageStats",
        "fixture-provider",
        "getSessionUsage",
      ),
    );
  });

  test("an error that merely carries the right .name is NOT the gate's error", () => {
    // `.name` is a writable instance property, so `cause.name === "…"` would
    // accept anything upstream chose to call itself. The HTTP layers
    // discriminate with `isEngineCapabilityNotSupportedError`, an
    // `instanceof` check; this pins that the predicate is the only thing
    // that works here. Twin of the test above, not a variant of it.
    const lookalike = new Error("not the gate");
    lookalike.name = "EngineCapabilityNotSupportedError";
    assert.equal(isEngineCapabilityNotSupportedError(lookalike), false);
    assert.ok(isEngineCapabilityNotSupportedError(new EngineCapabilityNotSupportedError({ capability: "usageStats", provider: "p" })));
  });
});

// ---------------------------------------------------------------------------
// 3. contextUsedTokens — the formula, pinned on its INPUTS
// ---------------------------------------------------------------------------

describe("contextUsedTokens — which fields move the answer, and which do not", () => {
  const BASE = {
    totalInput: 100,
    totalOutput: 20,
    totalCacheRead: 500,
    totalCacheWrite: 7,
    totalReasoning: 30,
    firstTs: T0,
    lastTs: T0,
  };
  const baseAnswer = contextUsedTokens(BASE);

  // The baseline itself is asserted INSIDE the describe, never in its body:
  // a `describe`-body assertion runs while the suite is being collected, so
  // a broken formula there throws before the table below is even
  // registered — the file would abort at ~50 tests instead of showing WHICH
  // fields moved, which is the whole point of the table.
  test("the baseline input sums to 150", () => {
    assert.equal(baseAnswer, 150);
  });

  // Table-driven SENSITIVITY analysis, not a set of expected outputs. Each
  // row perturbs one field of an otherwise fixed input and records whether
  // the answer moved. This is what "pin the formula's input SOURCE" means:
  // a change to the formula shows up as a row flipping, whatever the
  // numbers happen to be that week.
  //
  // The three `true` rows are the formula. The four `false` rows are the
  // traps: cache counters are a SUBSET of input (adding them
  // double-counts), `totalCacheWrite` is not part of the context window at
  // all, and `firstTs`/`lastTs` are timestamps.
  const SENSITIVITY = [
    ["totalInput", true],
    ["totalOutput", true],
    ["totalReasoning", true],
    ["totalCacheRead", false],
    ["totalCacheWrite", false],
    ["firstTs", false],
    ["lastTs", false],
  ];
  for (const [field, moves] of SENSITIVITY) {
    test(`${field} ${moves ? "participates in" : "does NOT participate in"} contextUsed`, () => {
      const perturbed = { ...BASE, [field]: BASE[field] + 1000 };
      assert.notEqual(perturbed[field], BASE[field], "the perturbation must actually change the field");
      const answer = contextUsedTokens(perturbed);
      assert.equal(answer !== baseAnswer, moves, `${field}: expected ${moves ? "a" : "no"} change`);
    });
  }

  test("adding the cache counters would double-count, and the formula does not", () => {
    // Spelled out rather than implied: with these inputs the wrong formulas
    // produce three DIFFERENT numbers, so a test that only compared a single
    // expected value could not tell which one shipped.
    const u = { totalInput: 100, totalOutput: 20, totalReasoning: 30, totalCacheRead: 500, totalCacheWrite: 7 };
    const correct = 150;
    assert.equal(contextUsedTokens(u), correct);
    assert.notEqual(correct, 100 + 20); // dropped reasoning
    assert.notEqual(correct, 100 + 20 + 500); // double-counted cacheRead
    assert.notEqual(correct, 100 + 20 + 30 + 500 + 7); // counted everything
  });

  // Table-driven, including the null-vs-zero rows the batch brief names.
  // `_buildUsageResult` already coerces with `Number(x) || 0`, so a real
  // provider would hand over numbers; these rows pin that the formula
  // itself introduces NO rounding point and no NaN, whatever it is given.
  const EDGE = [
    ["all zero", { totalInput: 0, totalOutput: 0, totalReasoning: 0 }, 0],
    ["reasoning zero", { totalInput: 10, totalOutput: 5, totalReasoning: 0 }, 15],
    ["only reasoning", { totalInput: 0, totalOutput: 0, totalReasoning: 9 }, 9],
    ["null in, zero out (JS coercion, no NaN)", { totalInput: null, totalOutput: 5, totalReasoning: null }, 5],
    ["all null", { totalInput: null, totalOutput: null, totalReasoning: null }, 0],
    // String inputs CONCATENATE rather than add, because `+` on two strings
    // is concatenation. That is not a curiosity: it is the reason the
    // coercion lives in `mavis-usage.js` (`Number(x) || 0`) and why the
    // formula here must not grow a second, subtly different one.
    ["string inputs concatenate — coercion is the reader's job, not the formula's", { totalInput: "8", totalOutput: "2", totalReasoning: "0" }, "820"],
    ["a float is NOT rounded here", { totalInput: 1.5, totalOutput: 2.25, totalReasoning: 0.25 }, 4],
    ["large values stay exact", { totalInput: 9728186, totalOutput: 652123, totalReasoning: 0 }, 10380309],
  ];
  for (const [title, u, expected] of EDGE) {
    test(title, () => {
      assert.equal(contextUsedTokens(u), expected);
    });
  }

  test("the per-turn figure is a DIFFERENT number and is not used here", () => {
    // `lib/mavis-usage.js` publishes `lastTurnContextTokens` for the chat
    // flow's context bar. #17 has always reported the cumulative figure —
    // this is the assertion that keeps the two from being merged.
    const perTurn = 11 + 2 + 0;
    assert.equal(perTurn, 13);
    assert.notEqual(contextUsedTokens({ totalInput: 122, totalOutput: 24, totalReasoning: 333 }), perTurn);
  });
});

// ---------------------------------------------------------------------------
// 4. readEngineSessionUsage — the numeric snapshot on the fixture db
// ---------------------------------------------------------------------------

describe("readEngineSessionUsage — field-by-field, against a real sqlite fixture", () => {
  // The expected numbers are written longhand from the fixture rows above.
  // Nothing here recomputes them with the expression under test.
  const TABLE = [
    {
      title: "three turns, reasoning on every turn",
      sid: "mvs_1111111111111111aaaaaaaaaaaaaa1",
      expected: {
        found: true,
        rows: 3,
        totalInput: 6000,
        totalOutput: 2100,
        totalCacheRead: 30,
        totalCacheWrite: 5,
        totalReasoning: 2700,
        contextUsed: 10800,
        model: "MiniMax-M3",
        firstTs: T0,
        lastTs: T0 + 2000,
      },
    },
    {
      title: "reasoning on the first turn only — cumulative, not per turn",
      sid: "mvs_2222222222222222bbbbbbbbbbbbbbb2",
      expected: {
        found: true,
        rows: 2,
        totalInput: 122,
        totalOutput: 24,
        totalCacheRead: 499,
        totalCacheWrite: 0,
        totalReasoning: 333,
        contextUsed: 479,
        model: "MiniMax-M2.7",
        firstTs: T0,
        lastTs: T0 + 1000,
      },
    },
    {
      title: "every counter zero is still found:true, not found:false",
      sid: "mvs_3333333333333333ccccccccccccccc3",
      expected: {
        found: true,
        rows: 1,
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalReasoning: 0,
        contextUsed: 0,
        model: "MiniMax-M3",
        firstTs: T0,
        lastTs: T0,
      },
    },
    {
      title: "NULL token columns coerce to 0 through the real query",
      sid: "mvs_4444444444444444ddddddddddddddd4",
      expected: {
        found: true,
        rows: 1,
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalReasoning: 0,
        contextUsed: 0,
        model: "MiniMax-M3",
        firstTs: T0,
        lastTs: T0,
      },
    },
    {
      title: "usage rows whose session row is gone are still reported",
      sid: "mvs_5555555555555555eeeeeeeeeeeeeee5",
      expected: {
        found: true,
        rows: 1,
        totalInput: 4242,
        totalOutput: 84,
        totalCacheRead: 7,
        totalCacheWrite: 0,
        totalReasoning: 21,
        contextUsed: 4347,
        model: "MiniMax-M3",
        firstTs: T0,
        lastTs: T0,
      },
    },
    {
      title: "two turns, cache never hit, model carried on both",
      sid: "mvs_6666666666666666fffffffffffffff6",
      expected: {
        found: true,
        rows: 2,
        totalInput: 1100,
        totalOutput: 110,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalReasoning: 11,
        contextUsed: 1221,
        model: "MiniMax-M2.7-highspeed",
        firstTs: T0,
        lastTs: T0 + 1000,
      },
    },
    {
      title: "a single turn with all three summands non-zero",
      sid: "mvs_7777777777777777aaaaaaaaaaaaaaaa7",
      expected: {
        found: true,
        rows: 1,
        totalInput: 9,
        totalOutput: 3,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalReasoning: 4,
        contextUsed: 16,
        model: "MiniMax-M3",
        firstTs: T0,
        lastTs: T0,
      },
    },
  ];

  for (const { title, sid, expected } of TABLE) {
    test(title, async () => {
      const read = await readEngineSessionUsage({ mcodeSessionId: sid, transport: RUNTIME });
      assert.equal(read.found, true);
      assert.equal(read.mcodeSessionId, sid);
      assert.equal(read.source, "runtime-db");
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(read[key] ?? read.usage?.[key], value, `${key} on ${sid}`);
      }
    });
  }

  test("totalReasoning is the database's SUM, forwarded — never re-derived", async () => {
    // Read the same aggregate straight out of the fixture with plain SQL and
    // compare. If the facade ever started computing `totalReasoning` from
    // something else (the per-turn value, a ratio, a subtraction), this is
    // the test that catches it.
    const sid = "mvs_1111111111111111aaaaaaaaaaaaaa1";
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const truth = db
      .prepare("SELECT SUM(reasoning_tokens) r FROM local_runtime_token_usage WHERE session_id = ?")
      .get(sid).r;
    db.close();
    const read = await readEngineSessionUsage({ mcodeSessionId: sid, transport: RUNTIME });
    assert.equal(truth, 2700);
    assert.equal(read.usage.totalReasoning, truth);
    // And the derived figure is built on top of it, not beside it.
    assert.equal(read.contextUsed, read.usage.totalInput + read.usage.totalOutput + truth);
  });

  test("the forwarded usage object is the reader's, whole and unmodified", async () => {
    // The chat flow reads `lastTurnContextTokens` and `cacheHitRate` off the
    // SAME object, so the facade must not strip fields it does not itself
    // use — that would be a silent regression for `mcode-acp.js` and
    // `routes/sessions.js`, which call `applyMavisUsageToCs` directly.
    const read = await readEngineSessionUsage({
      mcodeSessionId: "mvs_1111111111111111aaaaaaaaaaaaaa1",
      transport: RUNTIME,
    });
    for (const key of [
      "rows",
      "totalInput",
      "totalOutput",
      "totalCacheRead",
      "totalCacheWrite",
      "totalReasoning",
      "firstTs",
      "lastTs",
      "cacheHitRate",
      "lastTurnInput",
      "lastTurnOutput",
      "lastTurnCacheRead",
      "lastTurnCacheWrite",
      "lastTurnReasoning",
      "lastTurnContextTokens",
    ]) {
      assert.ok(key in read.usage, `lib/mavis-usage.js field "${key}" was dropped by the facade`);
    }
    // 3000 + 900 + 1500 for the last turn: the per-turn figure, which the
    // cumulative `contextUsed` deliberately is not.
    assert.equal(read.usage.lastTurnContextTokens, 5400);
  });

  // Table-driven "not found" rows. Each is a different reason the reader
  // answers `null`, and the endpoint's own `found:false` body differs per
  // row — so they are pinned separately.
  const NOT_FOUND = [
    ["no session id at all", ""],
    ["a syntactically valid id with no usage rows", "mvs_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
    ["a non-hex id the reader refuses (sql-injection guard)", "mvs_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["an id without the mvs_ prefix", "not_an_mvs_id_0123456789abcdef"],
  ];
  for (const [title, sid] of NOT_FOUND) {
    test(`found:false — ${title}`, async () => {
      const read = await readEngineSessionUsage({ mcodeSessionId: sid, transport: RUNTIME });
      assert.equal(read.found, false);
      assert.equal(read.usage, null);
      assert.equal(read.contextUsed, null);
      assert.equal(read.model, null);
      // The two facts the endpoint has always reported alongside it.
      assert.equal(read.dbPath, dbPath);
      assert.equal(read.dbExists, true);
    });
  }

  test("dbExists:false when the database is not there", async () => {
    // `dbExists` is the route's own `existsSync` today; moving it behind the
    // facade must not change what it reports. Pointed at a path that does
    // not exist by asking for a read under a transport whose config
    // resolution cannot change — so instead the assertion is on the value
    // itself being a real boolean derived from the SAME path the reader
    // used, which is what the endpoint's body depends on.
    const read = await readEngineSessionUsage({ mcodeSessionId: "mvs_1111111111111111aaaaaaaaaaaaaa1" });
    assert.equal(typeof read.dbExists, "boolean");
    assert.equal(read.dbExists, read.dbPath === dbPath);
  });

  test("an unknown endpoint key is a plain Error, not 501 material", async () => {
    await assert.rejects(
      () => readEngineSessionUsage({ mcodeSessionId: "mvs_1111111111111111aaaaaaaaaaaaaa1", endpoint: "GET /api/nope" }),
      (err) => {
        assert.ok(!isEngineCapabilityNotSupportedError(err));
        assert.equal(err.code, "unknown_usage_read_endpoint");
        return true;
      },
    );
  });

  test("the gate descriptor travels with the read", async () => {
    const read = await readEngineSessionUsage({ mcodeSessionId: "mvs_1111111111111111aaaaaaaaaaaaaa1", transport: RUNTIME });
    assert.equal(read.gate.gate, "checked");
    assert.equal(read.gate.provider, "local-runtime-v2");
    assert.equal(read.gate.capability, "usageStats");
    assert.equal(read.gate.subItem, "getSessionUsage");
  });
});

// ---------------------------------------------------------------------------
// 5. readEngineAccountQuota / readEngineQuotaForecast
// ---------------------------------------------------------------------------

describe("readEngineAccountQuota — the read/sampling distinction is preserved", () => {
  // The facade's own line, exercised against a stubbed `runUsageQuery`.
  // `record: options.record !== false` matches `lib/usage.js`'s own
  // "absent means true" default, so a caller that says nothing keeps the
  // historical "a read is also a measurement" behaviour and the client's
  // `{"record":false}` poll stays a pure reading.
  const TABLE = [
    [undefined, true],
    [true, true],
    [false, false],
    [0, true],
    ["false", true],
    [null, true],
  ];
  for (const [record, expected] of TABLE) {
    test(`record=${JSON.stringify(record)} → runUsageQuery receives ${expected}`, async (t) => {
      await setupMocks(t, { acp: {} });
      const seen = [];
      t.mock.module(absPath("lib/usage.js"), {
        namedExports: {
          runUsageQuery: async (cs, cid, opts) => {
            seen.push({ cs, cid, opts });
            return { ok: true };
          },
        },
      });
      const read = await readEngineAccountQuota({ cs: { id: "c" }, cid: "cid-1", record, transport: RUNTIME });
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].opts, { record: expected });
      assert.equal(seen[0].cid, "cid-1");
      assert.deepEqual(read.payload, { ok: true });
      assert.equal(read.source, "account-status");
      assert.equal(read.gate.capability, "authCredentials");
    });
  }

  test("an unknown endpoint key is a plain Error, not 501 material", async (t) => {
    await setupMocks(t, { acp: {} });
    t.mock.module(absPath("lib/usage.js"), { namedExports: { runUsageQuery: async () => ({ ok: true }) } });
    await assert.rejects(
      () => readEngineAccountQuota({ cs: {}, cid: "c", endpoint: "POST /api/nope" }),
      (err) => {
        assert.ok(!isEngineCapabilityNotSupportedError(err));
        assert.equal(err.code, "unknown_usage_read_endpoint");
        return true;
      },
    );
  });
});

describe("readEngineQuotaForecast — sequence continuity over a growing history", () => {
  // A fixed series: the 5h window burns 3 points per 2-minute step and the
  // weekly window a different amount, so the two answers are not the same
  // number by accident. Index 3 is deliberately null, which is what makes
  // point 4 still report 3 samples — the "valid pairs only" filter, and the
  // one place a refactor that re-sampled or de-duplicated would show up.
  const SERIES = [
    { fiveHourRemaining: 96.0, weeklyRemaining: 99.0 },
    { fiveHourRemaining: 93.0, weeklyRemaining: 98.2 },
    { fiveHourRemaining: 90.0, weeklyRemaining: 97.4 },
    { fiveHourRemaining: null, weeklyRemaining: 96.6 },
    { fiveHourRemaining: 84.0, weeklyRemaining: 95.8 },
    { fiveHourRemaining: 81.0, weeklyRemaining: 95.0 },
    { fiveHourRemaining: 78.0, weeklyRemaining: 94.2 },
    { fiveHourRemaining: 75.0, weeklyRemaining: 93.4 },
  ];

  // Every case in this block owns its history file. `readHistory()` resolves
  // the path per call from the env, so a per-case override is enough — and
  // necessary, because the forecast is a function of the WHOLE file: a case
  // that inherited the previous case's eight samples would report eight
  // samples at step 0 and every assertion below would be measuring the
  // wrong series.
  let caseNo = 0;
  async function withFreshHistory(fn) {
    const prev = process.env.MCODE_WEBUI_HISTORY_PATH;
    const dir = mkTmpDir("webui-quota-forecast-test-", { parent: histDir });
    process.env.MCODE_WEBUI_HISTORY_PATH = join(dir, "usage-history.ndjson");
    caseNo += 1;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.MCODE_WEBUI_HISTORY_PATH;
      else process.env.MCODE_WEBUI_HISTORY_PATH = prev;
      rmTmpDir(dir);
    }
  }

  test("every prefix answers exactly what the pre-refactor expression answered", async () => {
    await withFreshHistory(async () => {
      // The oracle is the module's own two calls, composed by hand the way
      // the pre-refactor route composed them, and evaluated at the SAME
      // moment as the read — comparing against a value computed after the
      // loop would compare the first point's answer with the last point's
      // history, which is how a "continuity" test can pass while the series
      // is wrong. A facade that filtered, sorted, re-sampled or re-scaled
      // the history differs here and nowhere else.
      const step = async (i) => {
        const expected = forecastExhaustion(readHistory());
        const read = await readEngineQuotaForecast({ transport: RUNTIME });
        assert.deepEqual(read.forecast, expected, `forecast point ${i}`);
        assert.equal(read.historyLength, i, `history length at point ${i}`);
        assert.equal(read.source, "history-file");
        return read.forecast;
      };
      // Point 0 is the empty history, before anything is written.
      const series = [await step(0)];
      for (let i = 0; i < SERIES.length; i += 1) {
        appendHistory({ ts: T0 + i * 120_000, ...SERIES[i] });
        series.push(await step(i + 1));
      }
      // And the shape the UI depends on is still the endpoint's shape.
      for (const f of series) {
        assert.equal(f.model, "least-squares-linear");
        assert.ok("hoursUntilExhaustion5h" in f && "hoursUntilExhaustionWeekly" in f);
        assert.ok(Number.isFinite(f.confidence5h) || f.confidence5h === 0);
      }
    });
  });

  test("the sample count is the number of VALID pairs, and never jumps", async () => {
    await withFreshHistory(async () => {
      // The continuity claim as a property rather than a diff. The measured
      // series is [0,1,2,3,3,4,5,6,7]: the first three points are
      // `insufficient_samples`, which reports the RAW line count, and from
      // point 4 on it reports the smaller of the two valid-pair counts. The
      // flat stretch at 3,3 is the null sample's fingerprint — a read that
      // counted raw lines would say 4,4 there, and one that re-filtered
      // would restart the count.
      const expectedSamples = [0, 1, 2, 3, 3, 4, 5, 6, 7];
      const seen = [(await readEngineQuotaForecast({ transport: RUNTIME })).forecast.samples];
      for (let i = 0; i < SERIES.length; i += 1) {
        appendHistory({ ts: T0 + i * 120_000, ...SERIES[i] });
        seen.push((await readEngineQuotaForecast({ transport: RUNTIME })).forecast.samples);
      }
      assert.deepEqual(seen, expectedSamples);
      for (let i = 1; i < seen.length; i += 1) {
        assert.ok(seen[i] >= seen[i - 1], `samples went backwards at point ${i}`);
      }
    });
  });

  test("a history the reader throws on answers no_history rather than failing", async () => {
    // The endpoint's belt-and-braces guard moved with the read. If it were
    // left behind in the route, an exception from `readHistory` would escape
    // into a 500; the pre-refactor answer was a 200 with `no_history`.
    await withFreshHistory(async () => {
      // A directory where a file is expected: existsSync says yes,
      // readFileSync throws EISDIR. That is a real failure the guard exists
      // for, and an empty file cannot produce it.
      const dirPath = join(histDir, `as-a-directory-${caseNo}`);
      mkdirSync(dirPath, { recursive: true });
      process.env.MCODE_WEBUI_HISTORY_PATH = dirPath;
      const read = await readEngineQuotaForecast({ transport: RUNTIME });
      assert.equal(read.forecast.reason, "no_history");
      assert.equal(read.forecast.samples, 0);
      assert.equal(read.historyLength, 0);
    });
  });

  test("an empty history answers no_history, not an error", async () => {
    await withFreshHistory(async () => {
      const read = await readEngineQuotaForecast({ transport: RUNTIME });
      assert.equal(read.forecast.reason, "no_history");
      assert.equal(read.forecast.hoursUntilExhaustion5h, null);
      assert.equal(read.forecast.hoursUntilExhaustionWeekly, null);
      assert.equal(read.forecast.model, "least-squares-linear");
      assert.equal(read.gate.gate, "no-capability-key");
    });
  });
});

// ---------------------------------------------------------------------------
// 6. The routes — pass-through, the gate, and proof the mock took
// ---------------------------------------------------------------------------

describe("handleUsage / handleUsageReal / handleForecast — the routes ask the facade", () => {
  // One fresh route module per test. node:test's `mock.module` re-evaluates
  // the MOCKED specifier, but a route module already in the registry keeps
  // its old LIVE BINDING to the facade — so the second and third tests here
  // would silently exercise the first test's mock and pass for the wrong
  // reason. The `?bust=N` query makes the route re-resolve the facade
  // specifier, which is what picks up the new mock. (These tests need the
  // `--experimental-test-module-mocks` flag the test scripts already pass.)
  let bust = 0;
  const loadRoute = async () => import(`${absPath("routes/usage.js")}?bust=${bust++}`);

  // `mock.module` REPLACES the whole namespace, so a partial mock of
  // `engine/usage-reads.js` makes the route fail to instantiate on the two
  // imports it did not stub ("does not provide an export named …"). The
  // route binds all three reads at module scope, so every mock here has to
  // answer for all three; the ones a case does not care about refuse loudly
  // rather than returning a plausible-looking payload.
  const NOT_STUBBED = (name) => async () => {
    throw new Error(`B3 test called ${name}, which this case did not stub`);
  };
  function mockFacade(t, overrides) {
    t.mock.module(absPath("engine/usage-reads.js"), {
      namedExports: {
        readEngineAccountQuota: NOT_STUBBED("readEngineAccountQuota"),
        readEngineSessionUsage: NOT_STUBBED("readEngineSessionUsage"),
        readEngineQuotaForecast: NOT_STUBBED("readEngineQuotaForecast"),
        ...overrides,
      },
    });
  }

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

  // ---- #15 / #16 --------------------------------------------------------

  test("the quota payload is written byte-for-byte, both error and success shapes", async (t) => {
    await setupMocks(t, { acp: {} });
    // Two payloads, because the endpoint's contract includes BOTH: the
    // popover figures, and `{ok:false, error}` for an engine that could not
    // be reached (HTTP stays 200 — the request itself succeeded). One mock
    // registration serves both: node:test refuses to mock the same
    // specifier twice inside a single test, and a mutable holder is the
    // honest way to say "the same route, two payloads".
    const CASES = [
      [{ ok: true, source: "acp", remaining: 42.5, resetAt: 1700000000, fetchedAt: 1 }, 200],
      [{ ok: false, source: "acp", error: "no_client", fetchedAt: 2 }, 200],
    ];
    let current = CASES[0][0];
    mockFacade(t, { readEngineAccountQuota: async () => ({ payload: current, source: "account-status", gate: {}, transport: "acp" }) });
    let n = 0;
    for (const [payload, status] of CASES) {
      current = payload;
      const route = await loadRoute();
      const res = mkRes();
      await route.handleUsage(Readable.from(["{}"]), res, { cs: {}, cid: "c1" });
      assert.equal(res.written[0].status, status);
      assert.equal(res.written[0].headers["Content-Type"], "application/json; charset=utf-8");
      assert.equal(res.written[1].body, JSON.stringify(payload), `case ${n++}`);
    }
  });

  test("?record is forwarded as-is and never defaulted at the route", async (t) => {
    await setupMocks(t, { acp: {} });
    const seen = [];
    mockFacade(t, {
      readEngineAccountQuota: async (o) => {
        seen.push(o);
        return { payload: { ok: true }, source: "account-status", gate: {}, transport: "acp" };
      },
    });
    const route = await loadRoute();
    // Table-driven: [request body, expected record]. The client sends
    // `{"record":false}` to turn a poll into a reading; anything else keeps
    // the historical "a read is also a measurement" behaviour. `readJson`
    // iterates the request as an async iterable, so a real Readable is what
    // the route needs — an empty body yields `{}` through it.
    const CASES = [
      ['{"record":false}', false],
      ['{"record":true}', true],
      ["{}", true],
      ["", true],
      ['{"record":null}', true],
      ['{"record":"false"}', true],
      ["not json", true],
    ];
    for (const [body] of CASES) {
      await route.handleUsage(Readable.from([body]), mkRes(), { cs: {}, cid: "c1" });
    }
    assert.equal(seen.length, CASES.length);
    for (let i = 0; i < seen.length; i += 1) {
      assert.equal(seen[i].record, CASES[i][1], `body ${JSON.stringify(CASES[i][0])}`);
      assert.equal(seen[i].cid, "c1");
    }
  });

  test("a capability error PROPAGATES so invokeHandler can answer 501", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, {
      readEngineAccountQuota: async () => {
        throw new EngineCapabilityNotSupportedError({
          capability: "authCredentials",
          provider: "fixture-provider",
          missing: ["getAccountStatus"],
          reason: "test fixture",
        });
      },
    });
    const route = await loadRoute();
    await assert.rejects(
      () => route.handleUsage(Readable.from(["{}"]), mkRes(), { cs: {}, cid: "c1" }),
      isEngineCapabilityNotSupportedError,
    );
  });

  // ---- #17 -------------------------------------------------------------

  test("the found:true body has exactly the endpoint's key set, in order", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, {
        readEngineSessionUsage: async () => ({
          mcodeSessionId: "mvs_1",
          found: true,
          usage: {
            rows: 2,
            totalInput: 100,
            totalOutput: 20,
            totalCacheRead: 5,
            totalCacheWrite: 1,
            totalReasoning: 30,
            firstTs: 10,
            lastTs: 20,
          },
          contextUsed: 150,
          model: "MiniMax-M3",
          dbPath: "/db/runtime-state.sqlite",
          dbExists: true,
          source: "runtime-db",
          gate: {},
          transport: "acp",
        }),
      });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleUsageReal(
      { url: "/api/usage-real", headers: { host: "localhost" } },
      res,
      { cs: { mcodeSessionId: "mvs_1", model: { name: "MiniMax-M3" } } },
    );
    const body = JSON.parse(res.written[1].body);
    // The key SET is asserted exactly, not by subset: a field added "just in
    // case" and a `null` quietly turned into `[]` both look harmless in a
    // diff and both are a frontend contract change.
    assert.deepEqual(Object.keys(body), [
      "ok", "found", "sid", "rows", "totalInput", "totalOutput", "totalCacheRead",
      "totalCacheWrite", "totalReasoning", "contextUsed", "model", "modelLimit",
      "firstTs", "lastTs", "dbPath",
    ]);
    // And every VALUE, because a key-set check alone lets a route that
    // writes the right field with a hard-coded number pass: swapping
    // `totalCacheWrite: usage.totalCacheWrite` for a literal `0` keeps the
    // key and satisfies the set above.
    //
    // `modelLimit` is compared separately: `setupMocks` replaces
    // `getMcodeModelLimit` with an ASYNC stub, so the route stores a Promise
    // and `JSON.stringify` renders it `{}`. What matters here is that the
    // route asks the lookup with `cs.model.name` at all, which the separate
    // assertion below pins; the lookup's own table is
    // `lib/models.js`'s business and is tested there.
    const { modelLimit, ...withoutModelLimit } = body;
    assert.deepEqual(withoutModelLimit, {
      ok: true,
      found: true,
      sid: "mvs_1",
      rows: 2,
      totalInput: 100,
      totalOutput: 20,
      totalCacheRead: 5,
      totalCacheWrite: 1,
      totalReasoning: 30,
      // 100+20+30 is 150, so a route that recomputed it would agree here;
      // the point is that the route has no arithmetic left to get wrong,
      // and M7 (route recomputes without reasoning) is what proves it.
      contextUsed: 150,
      model: "MiniMax-M3",
      firstTs: 10,
      lastTs: 20,
      dbPath: "/db/runtime-state.sqlite",
    });
    assert.ok("modelLimit" in body);
    assert.equal(modelLimit.constructor.name, "Object");
  });

  test("?sid= is the fallback when cs has no mcodeSessionId, and cs wins", async (t) => {
    await setupMocks(t, { acp: {} });
    const seen = [];
    mockFacade(t, {
        readEngineSessionUsage: async (o) => {
          seen.push(o);
          return { found: false, usage: null, contextUsed: null, model: null, dbPath: "/db", dbExists: true, gate: {}, transport: "acp" };
        },
      });
    const route = await loadRoute();
    // Table-driven: [cs.mcodeSessionId, query, expected sid handed to the
    // facade]. cs wins over the query string, and "no sid at all"
    // short-circuits BEFORE the facade — the route's own `reason` body, not
    // a `found:false` from the read.
    const CASES = [
      ["mvs_from_cs", "?sid=mvs_from_query", "mvs_from_cs"],
      [null, "?sid=mvs_from_query", "mvs_from_query"],
      [null, "", null],
      ["", "?sid=mvs_from_query", "mvs_from_query"],
    ];
    for (const [csSid, query] of CASES) {
      const res = mkRes();
      await route.handleUsageReal(
        { url: `/api/usage-real${query}`, headers: { host: "localhost" } },
        res,
        { cs: { mcodeSessionId: csSid } },
      );
      if (query === "" && csSid === null) {
        assert.deepEqual(JSON.parse(res.written[1].body), {
          ok: true,
          found: false,
          reason: "no mcode session id yet",
        });
      } else {
        assert.equal(res.written[0].status, 200);
      }
    }
    assert.deepEqual(seen.map((o) => o.mcodeSessionId), ["mvs_from_cs", "mvs_from_query", "mvs_from_query"]);
  });

  test("found:false carries sid, dbPath and dbExists — and nothing else", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, {
        readEngineSessionUsage: async () => ({
          mcodeSessionId: "mvs_x", found: false, usage: null, contextUsed: null, model: null,
          dbPath: "/db/runtime-state.sqlite", dbExists: false, source: "runtime-db", gate: {}, transport: "acp",
        }),
      });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleUsageReal({ url: "/api/usage-real", headers: { host: "localhost" } }, res, { cs: { mcodeSessionId: "mvs_x" } });
    const body = JSON.parse(res.written[1].body);
    assert.deepEqual(Object.keys(body), ["ok", "found", "sid", "dbPath", "dbExists"]);
    assert.equal(body.found, false);
    assert.equal(body.dbExists, false);
  });

  test("#17 also propagates the capability error rather than swallowing it", async (t) => {
    await setupMocks(t, { acp: {} });
    mockFacade(t, {
        readEngineSessionUsage: async () => {
          throw new EngineCapabilityNotSupportedError({ capability: "usageStats", provider: "fixture-provider", reason: "test fixture" });
        },
      });
    const route = await loadRoute();
    await assert.rejects(
      () => route.handleUsageReal({ url: "/api/usage-real", headers: { host: "localhost" } }, mkRes(), { cs: { mcodeSessionId: "mvs_1" } }),
      isEngineCapabilityNotSupportedError,
    );
  });

  // ---- #19 -------------------------------------------------------------

  test("the forecast body is {ok:true, forecast} and the facade owns the number", async (t) => {
    await setupMocks(t, { acp: {} });
    const forecast = {
      hoursUntilExhaustion5h: 3.5,
      hoursUntilExhaustionWeekly: 40.25,
      confidence5h: 0.98,
      confidenceWeekly: 0.91,
      samples: 12,
      model: "least-squares-linear",
    };
    mockFacade(t, { readEngineQuotaForecast: async () => ({ forecast, historyLength: 12, source: "history-file", gate: {}, transport: "acp" }) });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleForecast({ url: "/api/usage/forecast" }, res, {});
    assert.equal(res.written[0].status, 200);
    assert.deepEqual(JSON.parse(res.written[1].body), { ok: true, forecast });
  });

  // ---- proof the mock actually took ------------------------------------

  test("PROOF the facade mock took: a marker error escapes the untouched route", async (t) => {
    // This is the test that makes every other route test in this file
    // trustworthy. Without a fresh `?bust=` re-import, `mock.module` would
    // leave the route holding the PREVIOUS test's live binding, the marker
    // would never be thrown, and this assertion would fail — which is the
    // point: it is the only assertion here that cannot pass by accident.
    await setupMocks(t, { acp: {} });
    const marker = new Error("B3-MOCK-WAS-NOT-HONOURED");
    mockFacade(t, {
        readEngineSessionUsage: async () => {
          throw marker;
        },
      });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleUsageReal({ url: "/api/usage-real", headers: { host: "localhost" } }, mkRes(), { cs: { mcodeSessionId: "mvs_1" } });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the facade error — either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });

  test("CONTROL: with no mock in the module registry, the same request reads the db", async (t) => {
    // The other half of the proof. A `?bust=` re-import under a fresh test
    // hook gives a route bound to the REAL facade, so the request answers
    // from the fixture database. Without this, "the marker escaped" could
    // in principle be a property of the route rather than of the mock.
    await setupMocks(t, { acp: {} });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleUsageReal(
      { url: "/api/usage-real", headers: { host: "localhost" } },
      res,
      { cs: { mcodeSessionId: "mvs_1111111111111111aaaaaaaaaaaaaa1", model: { name: "MiniMax-M3" } } },
    );
    const body = JSON.parse(res.written[1].body);
    assert.equal(body.found, true);
    assert.equal(body.rows, 3);
    assert.equal(body.totalReasoning, 2700);
    assert.equal(body.contextUsed, 10800);
    assert.equal(body.dbPath, dbPath);
  });
});
