// webui/test/lib/engine/session-delete-ownership.test.js
//
// M4-3a: the tripwire for the retirement of the bare-SQL session delete.
//
// The batch deleted `server/lib/mcode-session-delete.js`, the module that
// opened the engine's runtime database and issued a row-destroying DELETE
// against a hand-curated list of 32 `local_runtime_*` tables inside one
// hand-rolled transaction. The destructive step is now the engine's own
// `deleteSession`, reached through `engine/session-delete.js`.
//
// "We deleted a file" is not a property; "nothing destroys an engine row
// behind the engine's back" is. This suite reads the server source tree
// and fails if the bypass comes back in any form:
//
//   - any module importing or naming the retired module;
//   - any module issuing a DELETE against a `local_runtime_*` table
//     (a template-literal or concatenated statement naming one of the
//     preview tables, whatever the verb's spacing);
//   - any module other than `engine/session-delete.js` opening the
//     engine's runtime database for writing (`better-sqlite3`
//     construction without `readonly: true`).
//
// The third rule is the one that generalises. The 32-table list is
// allowed to exist — `?dryRun=true` counts against it, because the
// engine exposes no preview form of the delete — so a tripwire keyed on
// table NAMES would either be trivially bypassed or would forbid the
// read-only half that the HTTP contract still requires. Keying on the
// WRITE is the property that actually matters: webui reads the engine's
// schema, and the engine destroys the rows.
//
// It is a static-source tripwire, which the repository's own guidance
// accepts when a suite has no render harness — and here the alternative
// is a behavioural test that cannot distinguish "the engine deleted it"
// from "webui deleted it".
//
// If this ever goes red, the fix is NOT to widen the allowlist without
// reading what the new writer does: a second writer of the engine's
// tables is precisely the bug this batch was filed for.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SERVER_DIR = join(import.meta.dirname, "..", "..", "..", "server");

/** The one module allowed to touch the engine's tables, and to open its database. */
const DATA_PLANE = join("engine", "session-delete.js");

/** Every .js/.mjs/.ts file under `dir`, recursively. */
function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "out" || name === ".next") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs|ts|tsx)$/.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const SERVER_FILES = sourceFiles(SERVER_DIR);
const rel = (f) => relative(SERVER_DIR, f);

/**
 * Strip comment-only lines, so a HISTORICAL mention (these files are full
 * of "the module we deleted used to…") is never read as a live import.
 * Block comments are handled by the same rule on their opening line; an
 * inline trailing comment keeps its code, which is what we want.
 */
function codeLines(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

/**
 * A DELETE statement, however it is spelled. The rule is deliberately
 * BROADER than "a DELETE aimed at a `local_runtime_*` table": matching
 * the table name only catches the literal form, and a statement built
 * from a variable — `DELETE FROM ${table}` — is exactly the shape a
 * second writer would use. Nothing in webui issues a DELETE any more
 * (verified against the whole server tree when this rule was written),
 * so the honest boundary is the verb itself: webui does not write to the
 * engine's database, in any form, by any module.
 */
const DELETE_STATEMENT = /\bdelete\s+from\b/gi;

describe("M4-3a — the bare-SQL session delete stays deleted", () => {
  test("the retired module is really gone from disk", () => {
    assert.equal(
      SERVER_FILES.some((f) => f.endsWith("mcode-session-delete.js")),
      false,
      "server/lib/mcode-session-delete.js must not exist; the engine's deleteSession replaced it",
    );
  });

  test("no server module imports or names the retired module", () => {
    const offenders = [];
    for (const file of SERVER_FILES) {
      const code = codeLines(readFileSync(file, "utf8"));
      if (/mcode-session-delete/.test(code)) offenders.push(rel(file));
    }
    assert.deepEqual(
      offenders,
      [],
      `these modules still name the retired module: ${offenders.join(", ")}`,
    );
  });

  test("no server module issues a DELETE at all", () => {
    const offenders = [];
    for (const file of SERVER_FILES) {
      if (rel(file) === DATA_PLANE) continue;
      const code = codeLines(readFileSync(file, "utf8"));
      if (DELETE_STATEMENT.test(code)) offenders.push(rel(file));
    }
    assert.deepEqual(
      offenders,
      [],
      `these modules issue DELETE statements: ${offenders.join(", ")} — webui does not write to the engine's database in any form; the engine owns its rows`,
    );
  });

  test("only the data plane opens the engine database, and it opens it read-only", () => {
    // The read-only half is legitimate and contractual (`?dryRun=true`),
    // so the rule is about the WRITE: a construction without
    // `readonly: true` is a module taking a writable handle on the
    // engine's own database, which is the capability this batch removed.
    const offenders = [];
    for (const file of SERVER_FILES) {
      if (rel(file) === DATA_PLANE) continue;
      const code = codeLines(readFileSync(file, "utf8"));
      if (/new\s+Db\s*\(/.test(code) && !/readonly/.test(code)) offenders.push(rel(file));
    }
    assert.deepEqual(
      offenders,
      [],
      `these modules open a database for writing: ${offenders.join(", ")}`,
    );

    const plane = codeLines(readFileSync(join(SERVER_DIR, DATA_PLANE), "utf8"));
    // Every construction the data plane performs is read-only. The
    // count is 1; the assertion is on the SHAPE so a future second
    // handle cannot slip in as a writable one.
    const constructions = plane.match(/new\s+Db\s*\([^)]*\)/g) || [];
    assert.equal(constructions.length, 1, "the data plane opens the engine database exactly once");
    for (const c of constructions) {
      assert.match(c, /readonly:\s*true/, `the data plane must open the engine database read-only, found: ${c}`);
    }
    assert.ok(
      !DELETE_STATEMENT.test(plane),
      "and the data plane itself must not DELETE — it counts, and the engine destroys",
    );
    // A SELECT is the shape the preview legitimately has. Pinning it
    // keeps the read half from being "simplified" into a delete by a
    // future reader who thinks the engine has a preview form by now.
    assert.match(plane, /SELECT COUNT\(\*\) AS c FROM/, "the preview counts, read-only");
  });

  test("the facade names the engine method, so the bridge is real and not a rename", () => {
    const facade = codeLines(
      readFileSync(join(SERVER_DIR, "engine", "session-writes.js"), "utf8"),
    );
    assert.match(
      facade,
      /deleteSessionThroughEngine/,
      "engine/session-writes.js must reach the data plane's engine entry point",
    );
    assert.match(
      facade,
      /import\("\.\/session-delete\.js"\)/,
      "and it must reach it through a lazy import, keeping the database off the boot path",
    );
  });
});
