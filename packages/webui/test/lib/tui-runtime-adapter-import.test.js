// webui/test/lib/tui-runtime-adapter-import.test.js
// S1 webui-side smoke test: the webui can construct a `TuiRuntimeAdapter`
// with a stubbed `CliService` and call `listSessions` end-to-end, importing
// the adapter through the new `@minimax/code/runtime-adapter` subpath export
// (the public symbol was previously locked inside `@minimax/code` because
// the package only exported `./package.json`).
//
// This test is the tripwire for the runtime-first migration's first slice:
// webui must be able to reach the adapter surface without going through the
// ACP protocol layer. If the export goes missing again, the import resolution
// fails before the constructor even runs, so a "module exists" assertion
// would not be enough — we drive the call through and observe the
// normalisation result.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Importing through the public subpath forces the resolver hook in
// packages/webui/server/lib/workspace-source-hooks.mjs to apply the
// exports-map rewrite; a missing export causes ERR_MODULE_NOT_FOUND here,
// which is the failure we want to see when the export is removed.
const adapterModule = await import("@minimax/code/runtime-adapter");
const { TuiRuntimeAdapter } = adapterModule;

// Minimal CliService stub: listSessions is the only method exercised by this
// test, and the adapter's `TuiSessionAccess` only forwards through that one
// call. Casting via `as unknown as CliService` keeps the cast local and
// obvious, matching the pattern used in packages/tui/test/unit/tui-runtime-adapter.test.ts.
function makeStubCliService(sessions) {
  return {
    listSessions: async (req) => {
      return {
        sessions: sessions.map((session) => ({
          sessionId: session.sessionId,
          agentName: req.name ?? "mavis",
          title: session.title ?? null,
          workspaceDir: session.workspaceDir ?? null,
          sessionType: session.sessionType === "branch" ? 0 : 1,
          sessionKind: 1,
          archived: false,
          visibility: "visible",
          status: { statusType: 0 },
          createdAt: session.createdAt ?? 1_700_000_000_000,
          updatedAt: session.updatedAt ?? 1_700_000_000_000,
          interactionMode: 0,
          memoryPolicy: {
            recallEnabled: false,
            writeEnabled: false,
            recallLocked: false,
          },
          frameworkType: null,
          isDefaultWorkspace: false,
        })),
        hasMore: false,
      };
    },
  };
}

describe("webui can import the runtime adapter through @minimax/code/runtime-adapter", () => {
  test("TuiRuntimeAdapter is exported as a constructable class", () => {
    assert.equal(
      typeof TuiRuntimeAdapter,
      "function",
      "@minimax/code/runtime-adapter must export TuiRuntimeAdapter as a constructable class",
    );
  });

  test("listSessions returns the normalised TuiSession array from the stub", async () => {
    const stub = makeStubCliService([
      {
        sessionId: "stub-1",
        title: "first stub session",
        workspaceDir: "/tmp/webui-stub-1",
        sessionType: "root",
      },
      {
        sessionId: "stub-2",
        title: "second stub session",
        workspaceDir: "/tmp/webui-stub-2",
        sessionType: "branch",
      },
    ]);
    const adapter = new TuiRuntimeAdapter(
      /** @type {import('@mavis/local-runtime-v2/cli-service').CliService} */ (
        /** @type {unknown} */ (stub)
      ),
    );

    const sessions = await adapter.listSessions();

    assert.ok(Array.isArray(sessions), "listSessions must resolve to an array");
    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["stub-1", "stub-2"],
    );
    assert.equal(sessions[0].title, "first stub session");
    assert.equal(sessions[0].sessionType, "root");
    assert.equal(sessions[1].sessionType, "branch");
    assert.equal(sessions[0].workspaceDir, "/tmp/webui-stub-1");
  });
});