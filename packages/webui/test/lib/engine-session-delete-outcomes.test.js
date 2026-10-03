// webui/test/lib/engine-session-delete-outcomes.test.js
// PR#55 review pt 4 regression tests — deleteSessionThroughEngine must
// NEVER report success after an arbitrary SQL/IO error. Pinned contract:
//
//   ok:true  + outcome:"deleted"          rows were removed
//   ok:true  + outcome:"already_absent"   tx committed, nothing matched
//                                         (tables absent OR zero rows)
//   ok:false + reason:"unsupported_schema" table exists without the
//                                         session_id key column (rolled back)
//   ok:false + reason:"db_error"          lock / prepare / run / IO
//                                         failure (rolled back)
//
// Fixture strategy mirrors test/lib/engine-session-delete.test.js (real
// sqlite3 CLI builds the fixture db; the real mcode-bundled better-
// sqlite3 loads through sqlite-resolver.js's resolver chain), gated on
// the same honest environment preconditions so the suites skip — never
// fail — on hosts without either piece.
//
// Audit hygiene: MCODE_WEBUI_EVENTS_PATH is redirected to a temp file
// so these tests never append to the real ~/.mcode-webui/events.ndjson
// (node --test runs each file in its own process, so the module-scope
// env set below cannot leak into other test files).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {rmSync, readFileSync, writeFileSync} from "node:fs";

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const SQLITE3_BIN = process.env.SQLITE3_BIN || "sqlite3";

const db = await import(absPath("engine/session-delete.js"));
// The lock-conflict test below holds a writer open from a second connection
// — that connection is built from better-sqlite3 through the resolver.
const resolver = await import(absPath("lib/sqlite-resolver.js"));

// Same gating as test/lib/engine-session-delete.test.js: (a) a working sqlite3
// CLI to build fixtures, (b) a CONSTRUCTIBLE better-sqlite3 through
// sqlite-resolver.js's resolver chain (a bare module require is a false
// positive — the native binding loads lazily, so we probe a real Database
// construction).
const SQLITE3_CLI_OK = (() => {
  try {
    const r = spawnSync(SQLITE3_BIN, ["--version"], {
      stdio: "ignore",
      timeout: 2000,
      windowsHide: true,
    });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
})();
const BETTER_SQLITE3_OK = (() => {
  const Mod = resolver.getMcodeBetterSqlite3();
  if (!Mod) return false;
  try {
    const probe = new Mod(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();
const DB_FIXTURE_SKIP = !SQLITE3_CLI_OK
  ? "skipped: sqlite3 CLI not available on this runner"
  : BETTER_SQLITE3_OK
    ? false
    : "skipped: no loadable better-sqlite3 (mcode not installed / ABI mismatch on this runner)";

const VALID_SID = "mvs_deadbeef00000000000000000000aaaa";
const OTHER_SID = "mvs_0000000000000000000000000000bb00";

// Redirect the audit stream BEFORE any delete call can append to it.
// Place the events file inside an isolated tmpdir tracked by helpers/tmp.js
// so the process-exit hook removes it.
const _eventsTmpDir = mkTmpDir("webui-db-outcomes-events-");
const EVENTS_TMP = join(_eventsTmpDir, "events.ndjson");
writeFileSync(EVENTS_TMP, "");
process.env.MCODE_WEBUI_EVENTS_PATH = EVENTS_TMP;

// Helper: run SQL against a fixture db via the sqlite3 CLI; throws with
// stderr if the fixture build fails (a broken fixture must fail the
// suite loudly, not silently pass).
const sql = (dbPath, stmt) => {
  const r = spawnSync(SQLITE3_BIN, [dbPath, stmt], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}\nSQL: ${stmt}`);
  return r.stdout.trim();
};

// Helper: parse the redirected events file into {kind} records.
const readEvents = () =>
  readFileSync(EVENTS_TMP, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

// M4-3a: webui no longer removes the rows — the ENGINE does. Every real
// path below therefore drives `deleteSessionThroughEngine` with a
// recording fake host, and the assertions moved accordingly: what webui
// owns is the count it takes, the id it hands over, the outcome it
// reports and the audit it writes. "The engine really removes the rows" is
// proven by the engine's own suite (local-runtime-v2 SessionDeletionService),
// not by a webui fixture that would only prove a stub did what it was told.
//
// The helper returns both the call log and the host, so a test can assert
// "the engine was asked, exactly once, with this sid" — the property that
// replaced "the row is gone".
const recordingHost = () => {
  const asked = [];
  return {
    asked,
    getHost: async () => ({
      cliService: {
        deleteSession: (req) => {
          asked.push(req);
          return Promise.resolve();
        },
      },
    }),
  };
};

// Two tables are enough to pin the semantics; the rest of the delete
// list exercises the confirmed-missing-table skip path.
const SESSIONS_DDL = `
  CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, data TEXT);
`;

describe("previewSessionDeleteRows — the wire shape is four keys", { skip: DB_FIXTURE_SKIP }, () => {
  test("the dryRun answer carries exactly {ok, dryRun, log, totalRows}", () => {
    // The engine's own `tablesAbsent` count is deliberately NOT projected
    // here: this object is embedded in the HTTP response verbatim, so a
    // new key is a wire change, not an implementation detail. This is the
    // assertion that keeps that decision from drifting.
    const tmpDir = mkTmpDir("webui-db-out-preview-");
    try {
      const dbPath = join(tmpDir, "preview.db");
      sql(dbPath, SESSIONS_DDL);
      // A sid of its own: this preview audits through the REAL event sink,
      // and the ordering test below filters the shared audit file by
      // target. Sharing VALID_SID would put a dryRun line inside the
      // window it asserts on.
      const PREVIEW_SID = "mvs_1111111111111111111111111111beef";
      sql(dbPath, `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${PREVIEW_SID}', 'x')`);
      const r = db.previewSessionDeleteRows(PREVIEW_SID, { MCODE_RUNTIME_DB: dbPath });
      assert.equal(r.ok, true);
      assert.deepEqual(Object.keys(r).sort(), ["dryRun", "log", "ok", "totalRows"]);
      assert.deepEqual(r.log, ["local_runtime_sessions:1"]);
      assert.equal(r.totalRows, 1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("deleteSessionThroughEngine — outcome: deleted (real delete)", { skip: DB_FIXTURE_SKIP }, () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = mkTmpDir("webui-db-out-del-");
    dbPath = join(tmpDir, "del.db");
    sql(dbPath, SESSIONS_DDL);
    sql(
      dbPath,
      `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${VALID_SID}', 'fake-data')`,
    );
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // The ordering that the event list alone cannot prove: the intent line
  // must already be on disk WHEN the engine is handed the id. Mutation
  // testing caught a version of this suite that was green with the two
  // audit events swapped, because swapping them does not change the list
  // of events — only the moment the destructive step was asked for. So
  // the fake host below records what had been written by the time it was
  // called, and that is the assertion.
  test("the intent line is durable BEFORE the engine is asked to destroy", async () => {
    const tmpDir = mkTmpDir("webui-db-out-order-");
    try {
      const dbPath = join(tmpDir, "order.db");
      sql(dbPath, SESSIONS_DDL);
      sql(dbPath, `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${OTHER_SID}', 'x')`);
      const eventsPath = join(tmpDir, "events.ndjson");
      writeFileSync(eventsPath, "");
      const writtenWhenAsked = [];
      await db.deleteSessionThroughEngine(OTHER_SID, {
        MCODE_RUNTIME_DB: dbPath,
        appendEvent: (kind, fields) => {
          const line = { kind, target: fields.target, actor: fields.actor, data: fields.payload, seq: 1, ts: 1 };
          fs.appendFileSync(eventsPath, `${JSON.stringify(line)}\n`);
        },
        getHost: async () => ({
          cliService: {
            deleteSession: () => {
              writtenWhenAsked.push(
                readFileSync(eventsPath, "utf8")
                  .split("\n")
                  .filter((l) => l.trim().length > 0)
                  .map((l) => JSON.parse(l).kind),
              );
              return Promise.resolve();
            },
          },
        }),
      });
      assert.deepEqual(
        writtenWhenAsked,
        [["session.delete.intent"]],
        "the destructive step must find the intent line already written — otherwise a crash mid-delete leaves a destroyed session with no record of the decision",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns {ok:true, outcome:'deleted'} and asks the engine for that sid", async () => {
    assert.equal(
      sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`),
      "1",
      "row should exist before delete",
    );
    const engine = recordingHost();
    const r = await db.deleteSessionThroughEngine(VALID_SID, {
      MCODE_RUNTIME_DB: dbPath,
      getHost: engine.getHost,
    });
    assert.equal(r.ok, true, `expected ok:true, got: ${JSON.stringify(r)}`);
    assert.deepEqual(engine.asked, [{ id: VALID_SID }], "the engine is asked once, with the counted sid");
    assert.equal(r.outcome, "deleted");
    assert.ok(Array.isArray(r.log) && r.log.length > 0, "log should be non-empty");
    assert.ok(
      r.log.some((e) => e.startsWith("local_runtime_sessions:")),
      `log should mention local_runtime_sessions: ${r.log.join(",")}`,
    );
    assert.ok(r.totalRowsDeleted >= 1, "totalRowsDeleted should be >= 1");
    assert.equal(
      typeof r.tablesAbsent,
      "number",
      "tablesAbsent (confirmed missing tables) should be reported",
    );
    // Audit parity: the outcome event carries the explicit outcome.
    const outcomeEv = readEvents().filter((e) => e.kind === "session.delete").pop();
    assert.ok(outcomeEv, "session.delete outcome event should be audited");
    assert.equal(outcomeEv.data.outcome, "deleted");

    // ORDER, not just presence. The intent line must land BEFORE the
    // engine is asked to destroy anything, and the outcome AFTER it: a
    // delete that wrote its intent last would leave a destroyed session
    // with no record that anyone had decided to delete it. Mutation
    // testing found this assertion missing — the suite was green with
    // the two events swapped — so it is pinned here explicitly.
    const mine = readEvents().filter((e) => e.target === VALID_SID);
    assert.deepEqual(
      mine.map((e) => e.kind),
      ["session.delete.intent", "session.delete"],
      "intent must be audited before the destructive step, outcome after it",
    );
  });
});

describe("deleteSessionThroughEngine — outcome: already_absent", { skip: DB_FIXTURE_SKIP }, () => {
  test("all preview-list tables missing → ok:true, outcome:'already_absent', full tablesAbsent count", async () => {
    const tmpDir = mkTmpDir("webui-db-out-absent-");
    try {
      const dbPath = join(tmpDir, "absent.db");
      sql(dbPath, "CREATE TABLE unrelated (x INT)");
      const engine = recordingHost();
      const r = await db.deleteSessionThroughEngine(VALID_SID, {
        MCODE_RUNTIME_DB: dbPath,
        getHost: engine.getHost,
      });
      assert.equal(r.ok, true, `expected ok:true, got: ${JSON.stringify(r)}`);
      assert.equal(r.outcome, "already_absent");
      assert.ok(Array.isArray(r.log) && r.log.length === 0, "log should be empty");
      assert.equal(r.totalRowsDeleted, 0);
      assert.equal(
        r.tablesAbsent,
        db.SESSION_DELETE_PREVIEW_TABLES.length,
        "every delete-list table should be counted as confirmed absent",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("tables present but zero rows for sid → ok:true, outcome:'already_absent', other rows untouched", async () => {
    const tmpDir = mkTmpDir("webui-db-out-zero-");
    try {
      const dbPath = join(tmpDir, "zero.db");
      sql(dbPath, SESSIONS_DDL);
      sql(
        dbPath,
        `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${OTHER_SID}', 'keep-me')`,
      );
      const engine = recordingHost();
      const r = await db.deleteSessionThroughEngine(VALID_SID, {
        MCODE_RUNTIME_DB: dbPath,
        getHost: engine.getHost,
      });
      assert.equal(r.ok, true, `expected ok:true, got: ${JSON.stringify(r)}`);
      assert.equal(r.outcome, "already_absent");
      assert.equal(r.totalRowsDeleted, 0);
      assert.equal(
        r.tablesAbsent,
        db.SESSION_DELETE_PREVIEW_TABLES.length - 1,
        "only the one existing table is present — the rest count absent",
      );
      assert.equal(
        sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${OTHER_SID}'`),
        "1",
        "other session's row must survive",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("deleteSessionThroughEngine — unsupported schema aborts + rolls back (no fake success)", { skip: DB_FIXTURE_SKIP }, () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = mkTmpDir("webui-db-out-schema-");
    dbPath = join(tmpDir, "schema.db");
    // local_runtime_sessions is FIRST in the delete list and holds the
    // row; local_runtime_messages (later in the list) exists WITHOUT a
    // session_id column → the tx must abort AFTER the first delete and
    // roll it back.
    sql(dbPath, SESSIONS_DDL);
    sql(
      dbPath,
      `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${VALID_SID}', 'fake-data')`,
    );
    sql(dbPath, "CREATE TABLE local_runtime_messages (id INTEGER PRIMARY KEY, body TEXT)");
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keyless table → {ok:false, reason:'unsupported_schema'} AND the engine is never asked", async () => {
    const eventsBefore = readEvents().length;
    const engine = recordingHost();
    const r = await db.deleteSessionThroughEngine(VALID_SID, {
      MCODE_RUNTIME_DB: dbPath,
      getHost: engine.getHost,
    });
    assert.equal(r.ok, false, `keyless table must NOT report success: ${JSON.stringify(r)}`);
    assert.equal(r.reason, "unsupported_schema");
    assert.equal(r.table, "local_runtime_messages");
    assert.match(r.error, /session_id/);
    // M4-3a replaced the rollback proof, and the replacement is stronger
    // for what webui owns: the schema failure is detected by the PRE-DELETE
    // COUNT, so the engine is never handed the id at all. Nothing was
    // destroyed because nothing destructive started.
    assert.deepEqual(engine.asked, [], "a count that cannot be trusted must not reach the engine");
    assert.equal(
      sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`),
      "1",
      "the row must survive — nothing deleted it",
    );
    // No outcome audit event for a refused delete (intent only).
    const newEvents = readEvents().slice(eventsBefore);
    assert.deepEqual(
      newEvents.map((e) => e.kind),
      [],
      "a delete refused by the pre-delete count must emit no audit line at all",
    );
  });

  test("dry-run preview surfaces the same failure instead of undercounting", () => {
    const r = db.previewSessionDeleteRows(VALID_SID, {
      MCODE_RUNTIME_DB: dbPath,
    });
    assert.equal(r.ok, false, `preview must not fake success either: ${JSON.stringify(r)}`);
    assert.match(r.error, /session_id/);
  });
});

describe("deleteSessionThroughEngine — a read that cannot be trusted aborts (no fake success)", { skip: DB_FIXTURE_SKIP }, () => {
  // M4-3a rewrote this suite's lock case, and the reason is the change of
  // subject, not a weakened assertion. The retired module opened the
  // database for WRITE, set `busy_timeout = 5000` and could lose a race
  // with a concurrent writer mid-transaction — so "SQLITE_BUSY aborts with
  // a 4s wait and a rollback" was a real webui property. webui's only SQL
  // now is the READ-ONLY pre-delete count, which never blocks a writer and
  // therefore never loses that race: a reader is served from the existing
  // snapshot while a writer holds RESERVED. The write-side lock semantics
  // moved to the engine along with the write.
  //
  // What is left for webui to get wrong is the same class of mistake under
  // a new name: a count that fails must surface as a failure, and a
  // failure must never reach the engine as a delete.
  test("a database that cannot be opened → {ok:false, reason:'db_error'} and no engine call", async () => {
    const tmpDir = mkTmpDir("webui-db-out-readfail-");
    try {
      const dbPath = join(tmpDir, "readfail.db");
      sql(dbPath, SESSIONS_DDL);
      const engine = recordingHost();
      const r = await db.deleteSessionThroughEngine(VALID_SID, {
        MCODE_RUNTIME_DB: dbPath,
        getHost: engine.getHost,
        // A constructor that opens the file and then throws is the
        // shortest honest stand-in for "sqlite refused": the point under
        // test is the CLASSIFICATION and the refusal to continue, neither
        // of which depends on which sqlite error code arrived.
        getDb: () => {
          const Boom = function Boom() {
            throw Object.assign(new Error("unable to open database file"), {
              code: "SQLITE_CANTOPEN",
            });
          };
          return Boom;
        },
      });
      assert.equal(r.ok, false, `must NOT report success: ${JSON.stringify(r)}`);
      assert.equal(r.reason, "db_error");
      assert.match(r.error, /unable to open database file/);
      assert.deepEqual(engine.asked, [], "an unreadable count must not reach the engine");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("the same failure on the dry-run path is a failure too, never a zero count", () => {
    const tmpDir = mkTmpDir("webui-db-out-readfail-dry-");
    try {
      const dbPath = join(tmpDir, "readfail-dry.db");
      sql(dbPath, SESSIONS_DDL);
      const Boom = function Boom() {
        throw new Error("unable to open database file");
      };
      const r = db.previewSessionDeleteRows(VALID_SID, { MCODE_RUNTIME_DB: dbPath, getDb: () => Boom });
      assert.equal(r.ok, false, `preview must not fake success: ${JSON.stringify(r)}`);
      assert.equal(r.reason, "db_error");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
