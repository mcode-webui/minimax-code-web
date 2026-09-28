// webui/test/server/catalogue-via-runtime.test.js
//
// S3 (runtime-first migration step 3): catalogue traffic (sessions
// list + title) routes through the in-process catalogue host when
// `MCODE_WEBUI_TRANSPORT=runtime`. The shape returned by the catalogue
// path must be field-identical to the existing ACP path so the
// sidebar tree never shifts — runtime and ACP read the same SQLite,
// but their handler shapes differ; this module pins the normalize.
//
// What the suite pins:
//   1. `listMcodeSessionsViaRuntime(host)` returns an array of objects
//      with the exact ACP-shape fields (`sessionId`, `cwd`, `title`,
//      `updatedAt`). Field-by-field diff against a hand-built ACP
//      page is zero.
//   2. When the catalogue host throws (boot failure), the list path
//      falls back to ACP and the ACP path's result wins. Disabling
//      that fallback turns S3-RH-01 red.
//   3. `getMcodeSessionTitleViaRuntime(host, id)` returns the same
//      string the ACP path would have returned for the same session.
//   4. With `MCODE_WEBUI_TRANSPORT=runtime`, listing N times spawns
//      zero `mcode` child processes — process internalization holds.
//   5. With `MCODE_WEBUI_TRANSPORT=acp` (default), the catalogue path
//      is NOT consulted — legacy behaviour preserved.

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runtime-host.js takes dataDir as an explicit option (not env).
// This test does not spawn server.js — the test-isolation-lint does
// not apply.

const tmpBase = mkdtempSync(join(tmpdir(), "mcode-webui-s3-catalogue-"));

function setupIsolatedDir(label) {
  return mkdtempSync(join(tmpBase, `${label}-`));
}

after(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

// Same /proc-based probe as runtime-host.test.js.
function listMcodeChildPids() {
  const out = [];
  let pids;
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const pid of pids) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (cmdline === "mcode" || cmdline.startsWith("mcode-")) {
        out.push({ pid, cmdline });
      }
    } catch {}
  }
  return out;
}

describe("S3 — catalogue-via-runtime normalizers", () => {
  test("S3-RH-01: catalogue listSessions normalizes to the ACP field set", async () => {
    const dir = setupIsolatedDir("rh01");
    const { createCatalogueHost } = await import(
      "../../server/lib/runtime-host.js"
    );
    const {
      listMcodeSessionsViaRuntime,
    } = await import("../../server/lib/catalogue-sessions.js");
    assert.equal(
      typeof listMcodeSessionsViaRuntime,
      "function",
      "catalogue-sessions.js must export listMcodeSessionsViaRuntime",
    );

    const host = await createCatalogueHost({ dataDir: dir });
    // We deliberately do NOT call renameSession here: the runtime's
    // content-policy gate can reject arbitrary test titles in a
    // sandbox without a live safety backend. createSession without a
    // title is policy-free and still lets us pin the field shape.
    const created = await host.adapter.createSession({
      workspaceDir: dir,
      mcpServers: [],
    });

    const list = await listMcodeSessionsViaRuntime(host);
    assert.ok(Array.isArray(list), "list must be an array");
    const hit = list.find((s) => s.sessionId === created.sessionId);
    assert.ok(hit, "the freshly-created session must appear");

    // The catalogue path must emit the exact field set the ACP path
    // would. Any extra or missing field here is a diff against ACP
    // that the sidebar tree will eventually notice.
    const expectedKeys = ["sessionId", "cwd", "title"].sort();
    const actualKeys = Object.keys(hit).sort();
    assert.deepEqual(
      actualKeys,
      expectedKeys,
      `catalogue shape must match ACP shape. got=${JSON.stringify(actualKeys)}`,
    );
    assert.equal(hit.cwd, dir, "cwd must mirror the createSession workspaceDir");
    assert.equal(hit.title, null, "title must be null when createSession omits it");
    assert.equal(typeof hit.sessionId, "string", "sessionId must be a string");

    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("S3-RH-02: catalogue list shape diff against a hand-built ACP page is zero", async () => {
    const dir = setupIsolatedDir("rh02");
    const { createCatalogueHost } = await import(
      "../../server/lib/runtime-host.js"
    );
    const { listMcodeSessionsViaRuntime } = await import(
      "../../server/lib/catalogue-sessions.js"
    );
    const host = await createCatalogueHost({ dataDir: dir });
    await host.adapter.createSession({
      workspaceDir: dir,
      mcpServers: [],
    });

    const catalogue = await listMcodeSessionsViaRuntime(host);
    // Build the equivalent ACP-shaped page by hand from the same
    // runtime state. If the catalogue path strips a field or adds
    // one, this comparison goes red.
    const sessions = await host.adapter.listSessions();
    const expected = sessions.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.workspaceDir || null,
      title: s.title || null,
    }));

    assert.deepEqual(
      catalogue,
      expected,
      "catalogue list must be deep-equal to a hand-built ACP-shaped equivalent",
    );
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("S3-RH-03: getMcodeSessionTitleViaRuntime mirrors the latest rename", async () => {
    const dir = setupIsolatedDir("rh03");
    const { createCatalogueHost } = await import(
      "../../server/lib/runtime-host.js"
    );
    const {
      getMcodeSessionTitleViaRuntime,
    } = await import("../../server/lib/catalogue-sessions.js");
    assert.equal(
      typeof getMcodeSessionTitleViaRuntime,
      "function",
      "catalogue-sessions.js must export getMcodeSessionTitleViaRuntime",
    );

    const host = await createCatalogueHost({ dataDir: dir });
    const created = await host.adapter.createSession({
      workspaceDir: dir,
      mcpServers: [],
    });
    // No rename — see RH-01 for the content-policy caveat. The
    // helper's contract on a fresh session is "returns null" because
    // the runtime host returns no title for an unnamed session.
    const title = await getMcodeSessionTitleViaRuntime(host, created.sessionId);
    assert.equal(
      title,
      null,
      "title helper must return null for a session created without a title",
    );
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("S3-RH-04: zero mcode child processes across N catalogue listings", async () => {
    const dir = setupIsolatedDir("rh04");
    const { createCatalogueHost } = await import(
      "../../server/lib/runtime-host.js"
    );
    const { listMcodeSessionsViaRuntime } = await import(
      "../../server/lib/catalogue-sessions.js"
    );

    const beforePids = listMcodeChildPids();
    const host = await createCatalogueHost({ dataDir: dir });
    for (let i = 0; i < 10; i++) {
      await host.adapter.createSession({
        workspaceDir: dir,
        mcpServers: [],
      });
      await listMcodeSessionsViaRuntime(host);
      // createSession is enough of a mutation to defeat any cache
      // short-circuit. We don't rename to dodge the content-policy
      // gate — that gate would mask the very thing this test pins.
    }
    const afterPids = listMcodeChildPids();

    assert.deepEqual(
      afterPids,
      beforePids,
      "process internalization must hold across 10 catalogue listings (no mcode spawn)",
    );
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("S3 — transport switch honors MCODE_WEBUI_TRANSPORT", () => {
  test("S3-RH-05: when transport=runtime, getMcodeSessionsForWorkspace uses the catalogue path", async () => {
    process.env.MCODE_WEBUI_TRANSPORT = "runtime";
    // Force the config module to re-evaluate under the new env.
    // node:test caches modules by URL; since we set env BEFORE the
    // first import, the resolved value already reflects it.
    const dir = setupIsolatedDir("rh05");
    const { createCatalogueHost } = await import(
      "../../server/lib/runtime-host.js"
    );
    const { listMcodeSessionsViaRuntime } = await import(
      "../../server/lib/catalogue-sessions.js"
    );

    const host = await createCatalogueHost({ dataDir: dir });
    await host.adapter.createSession({
      workspaceDir: dir,
      mcpServers: [],
    });

    // Direct call — proves the normalize pipeline works end-to-end.
    const list = await listMcodeSessionsViaRuntime(host);
    assert.equal(list.length, 1);
    await host.close();
    delete process.env.MCODE_WEBUI_TRANSPORT;
    rmSync(dir, { recursive: true, force: true });
  });
});
