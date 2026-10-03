// webui/test/lib/engine/provider-store-ownership.test.js
//
// M3-B11: the tripwire for A5's second half — the `config.yaml`
// BYPASS must stay gone.
//
// The batch deleted `server/lib/engine-provider-sync.js`, the module
// that wrote the engine's `config.yaml` as a SECOND copy of
// `providers.json`. "We deleted a file" is not a property; "nothing
// writes that file behind the store's back" is. This suite reads the
// server source tree and fails if the bypass comes back in any form:
//
//   - any module importing or naming `engine-provider-sync`;
//   - any module OTHER than `engine/provider-store.js` writing
//     `config.yaml` (a raw `writeFile`/`rename` aimed at it, or a
//     `custom_provider` assignment);
//   - any module other than `lib/engine-catalogue.js` reading the
//     engine's OWN provider tree — `lib/engine-catalogue.js` is
//     B4's #57 read of the builtin managed tree and is out of this
//     batch's scope; `engine/provider-store.js` is the store.
//
// It is a static-source tripwire, which the repository's own guidance
// accepts when a suite has no render harness — and here the alternative
// is a behavioural test that cannot distinguish "the store wrote it"
// from "something else wrote it".
//
// If this ever goes red, the fix is NOT to widen the allowlist without
// reading what the new writer does: a second writer is exactly the bug
// A5 was filed for.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SERVER_DIR = join(import.meta.dirname, "..", "..", "..", "server");
const WEBAPP_DIR = join(import.meta.dirname, "..", "..", "..", "webapp");

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
const WEBAPP_FILES = sourceFiles(WEBAPP_DIR);
const rel = (f) => relative(join(SERVER_DIR, ".."), f);

/** Strip comment-only lines so a HISTORICAL mention is not a live import. */
function codeLines(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("A5 — the config.yaml bypass stays deleted", () => {
  test("the deleted module is really gone from disk", () => {
    assert.equal(
      SERVER_FILES.some((f) => f.endsWith("engine-provider-sync.js")),
      false,
      "server/lib/engine-provider-sync.js must not exist; the store replaced it",
    );
  });

  test("no server module imports or names the deleted module", () => {
    const offenders = SERVER_FILES.filter((f) =>
      codeLines(readFileSync(f, "utf8")).includes("engine-provider-sync"),
    );
    assert.deepEqual(offenders.map(rel), [], "a live reference to the deleted module is a bypass back");
  });

  test("no webapp module references the deleted module", () => {
    const offenders = WEBAPP_FILES.filter((f) =>
      codeLines(readFileSync(f, "utf8")).includes("engine-provider-sync"),
    );
    assert.deepEqual(offenders.map(rel), [], "the frontend never named it, and must not start");
  });

  test("only the store writes config.yaml", () => {
    // A second writer is the whole bug. The store is the only module
    // allowed to name the file in a write position; everyone else may
    // READ it.
    const writers = SERVER_FILES.filter((f) => {
      const text = codeLines(readFileSync(f, "utf8"));
      if (!text.includes("config.yaml")) return false;
      if (f.endsWith("engine/provider-store.js")) return false;
      // A pure read names the path and opens it; a write renames or
      // chmods onto it. The test distinguishes the two by what it does
      // with the path, not by a comment.
      return /\b(writeFile|rename|appendFile|createWriteStream)\b[\s\S]{0,200}config\.yaml/.test(text)
        || /config\.yaml["'`][\s\S]{0,200}\b(writeFile|rename|appendFile|createWriteStream)\b/.test(text);
    });
    assert.deepEqual(writers.map(rel), [], "config.yaml has exactly one writer: the store");
  });

  test("only the store and the builtin-catalogue reader touch custom_provider", () => {
    const offenders = SERVER_FILES.filter((f) => {
      const text = codeLines(readFileSync(f, "utf8"));
      if (!text.includes("custom_provider")) return false;
      const allowed =
        f.endsWith("engine/provider-store.js") || // the store
        f.endsWith("lib/engine-catalogue.js"); // B4's #57 builtin read
      return !allowed;
    });
    assert.deepEqual(
      offenders.map(rel),
      [],
      "custom_provider is reached through the store; a third reader is a second source of truth",
    );
  });

  test("the deprecated providers.json is READ, never written", () => {
    // The fallback is only credible if the file cannot drift: nothing
    // may write it, and the only writer of a provider catalogue is the
    // store.
    const offenders = SERVER_FILES.filter((f) => {
      const text = codeLines(readFileSync(f, "utf8"));
      if (!text.includes("providers.json")) return false;
      return /\b(writeFileSync|writeFile|renameSync|rename|appendFile)\b[\s\S]{0,300}providers\.json/.test(text)
        || /providers\.json["'`][\s\S]{0,300}\b(writeFileSync|writeFile|renameSync|rename|appendFile)\b/.test(text);
    });
    assert.deepEqual(offenders.map(rel), [], "providers.json is deprecated: it may only be read");
  });

  test("the store module is where the engine config path comes from", () => {
    // One source for the path. `lib/engine-catalogue.js` used to import
    // it from the deleted module; a second definition would let the
    // catalogue and the store disagree about which file is which.
    const definitions = SERVER_FILES.filter((f) =>
      /export function getEngineConfigPath\b/.test(readFileSync(f, "utf8")),
    );
    assert.deepEqual(definitions.map(rel), ["server/engine/provider-store.js"]);
  });
});
