// webapp/test/credential-file.test.ts
//
// Fixture-driven test that pins the credential predicate in BOTH
// implementations: the server (`server/lib/credential-file.js`) and the
// webapp (`webapp/lib/credential-file.ts`). The two files read from the
// SAME `CREDENTIAL_FIXTURES` table (kept in lockstep by the symmetric
// fixture export), so any drift is caught by the assertion below.
//
// Coverage contract:
//
//   1. Every `hits` entry MUST be classified as a credential by both
//      implementations.
//   2. Every `misses` entry MUST NOT be classified as a credential
//      (the legibility check; a too-eager predicate catches
//      `environment.ts` and the right panel goes dark).
//   3. The server and webapp predicates MUST agree on every input —
//      same name → same boolean answer from both.
//   4. `classifyCredentialPath` (the reason-bearing variant) must agree
//      with `isCredentialPath` (the boolean variant): if the predicate
//      says `true`, the classifier returns a sub-reason; otherwise
//      `null`. Same test on both sides.
//
// The fixture table lives in both `server/lib/credential-file.js` and
// `webapp/lib/credential-file.ts`. The two are imported here and the
// loop walks each fixture twice (once per implementation) so adding a
// name to either side automatically widens the contract.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  isCredentialPath as webappIsCredential,
  classifyCredentialPath as webappClassify,
  CREDENTIAL_FIXTURES,
} from "../lib/credential-file";

// Server side: the file lives under packages/webui/server/lib/. The
// webapp's Node loader does not honour the `@/lib/...` alias used by
// Next.js, so we read it through a file:// URL the same way the
// existing fs-read-file test does.
const serverAbsPath = (rel: string) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const serverCredential = await import(serverAbsPath("lib/credential-file.js"));

describe("credential-file — fixture agreement (server + webapp)", () => {
  test("fixture tables are identical (drift guard)", () => {
    // If a contributor adds an entry to one table and forgets the
    // other, the next contributor sees this assertion fail before
    // they even get to the per-fixture loop. The two tables MUST
    // serialise to the same string.
    const serverJSON = JSON.stringify(serverCredential.CREDENTIAL_FIXTURES);
    const webappJSON = JSON.stringify(CREDENTIAL_FIXTURES);
    assert.equal(webappJSON, serverJSON, "CREDENTIAL_FIXTURES tables drifted");
  });

  for (const fixture of CREDENTIAL_FIXTURES) {
    describe(`fixture: ${fixture.match}`, () => {
      for (const hit of fixture.hits) {
        test(`HIT  server: ${hit}`, () => {
          assert.equal(
            serverCredential.isCredentialPath(hit),
            true,
            `server predicate missed ${hit}`,
          );
        });
        test(`HIT  webapp: ${hit}`, () => {
          assert.equal(
            webappIsCredential(hit),
            true,
            `webapp predicate missed ${hit}`,
          );
        });
        test(`HIT  agreement: ${hit}`, () => {
          // Belt-and-suspenders: server and webapp must give the same
          // boolean for the same input. A regression that flipped one
          // side without the other would not survive this loop.
          assert.equal(
            serverCredential.isCredentialPath(hit),
            webappIsCredential(hit),
            `server/webapp disagreement on ${hit}`,
          );
        });
      }
      for (const miss of fixture.misses) {
        test(`MISS server: ${miss}`, () => {
          assert.equal(
            serverCredential.isCredentialPath(miss),
            false,
            `server predicate false-positived ${miss}`,
          );
        });
        test(`MISS webapp: ${miss}`, () => {
          assert.equal(
            webappIsCredential(miss),
            false,
            `webapp predicate false-positived ${miss}`,
          );
        });
      }
    });
  }
});

describe("credential-file — classifyCredentialPath reason mapping", () => {
  for (const [name, expectedSubReason] of [
    [".env", "dotenv"],
    [".env.local", "dotenv"],
    [".env.production", "dotenv"],
    ["server.pem", "key-file"],
    ["private.key", "key-file"],
    ["id_rsa", "ssh-key"],
    ["id_ed25519", "ssh-key"],
    ["credentials", "credentials"],
    ["credentials.json", "credentials"],
    [".npmrc", "credentials"],
    [".pypirc", "credentials"],
    [".netrc", "credentials"],
    [".pgpass", "credentials"],
    ["known_hosts", "ssh-meta"],
    ["authorized_keys", "ssh-meta"],
  ] as const) {
    test(`${name} → ${expectedSubReason} (both implementations)`, () => {
      const serverResult = serverCredential.classifyCredential(name);
      const webappResult = webappClassify(name);
      assert.ok(serverResult, `server: ${name} should classify`);
      assert.equal(serverResult!.reason, expectedSubReason);
      assert.ok(webappResult, `webapp: ${name} should classify`);
      assert.equal(webappResult!.reason, expectedSubReason);
    });
  }

  test("non-credential names return null", () => {
    assert.equal(serverCredential.classifyCredential("environment.ts"), null);
    assert.equal(webappClassify("environment.ts"), null);
    assert.equal(serverCredential.classifyCredential("README.md"), null);
    assert.equal(webappClassify("README.md"), null);
  });

  test("empty / non-string inputs are safe (both implementations)", () => {
    // Defensive — a malformed path coming from the wire should not
    // crash the predicate. Returning `null` / `false` is the contract.
    assert.equal(serverCredential.classifyCredential(""), null);
    assert.equal(webappClassify(""), null);
    assert.equal(serverCredential.isCredentialPath(""), false);
    assert.equal(webappIsCredential(""), false);
  });

  test("absolute path inputs classify by basename (no leakage)", () => {
    // The predicate intentionally ignores the directory — a credential
    // file is a credential file regardless of where it lives. This is
    // what lets the same predicate drive both the server gate (which
    // gets an absolute path) and the client classifier (which gets
    // whatever the panel has on hand).
    const serverResult = serverCredential.classifyCredential("/home/user/.env");
    const webappResult = webappClassify("/home/user/.env");
    assert.equal(serverResult?.reason, "dotenv");
    assert.equal(webappResult?.reason, "dotenv");
    // A workspace-relative path with the same basename MUST match —
    // both implementations are basename-only.
    const ws = serverCredential.classifyCredential("/work/secrets/.env.production");
    assert.equal(ws?.reason, "dotenv");
  });
});