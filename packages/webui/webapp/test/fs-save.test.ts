// webapp/test/fs-save.test.ts
//
// Unit tests for the preview save client (slice 27) — `saveFsFile` in
// lib/api.ts. The suite pins the NETWORK ARTIFACT, not a module
// structure: the method, the path, and the exact JSON body the panel
// puts on the wire, plus the parsed shapes for the conflict /
// credential / success answers the toolbar branches on.
//
// Why mock fetch by hand. `saveFsFile` reads the JSON body on non-OK
// responses too (the 409 conflict carries `code`/`diskMtime`/
// `diskSize` the conflict card renders), so the shared `request()`
// helper that throws on non-OK cannot back it. The mock below captures
// the fetch init and answers with a scripted Response-shaped object —
// the minimum DOM surface the client touches (`text()`, `ok`, `status`).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { saveFsFile } from "../lib/api";

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

/** Install a fetch stub through a typed globalThis alias (no var redeclare). */
function installFetchStub(
  answer: (captured: CapturedFetch) => { status: number; ok: boolean; body: unknown },
): CapturedFetch[] {
  const captured: CapturedFetch[] = [];
  const stub = async (url: string, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    const scripted = answer(captured[captured.length - 1] as CapturedFetch);
    const body = JSON.stringify(scripted.body);
    return {
      ok: scripted.ok,
      status: scripted.status,
      text: async () => body,
    } as unknown as Response;
  };
  Object.defineProperty(globalThis, "fetch", {
    value: stub,
    configurable: true,
    writable: true,
  });
  return captured;
}

function restoreFetch() {
  // The original fetch is only absent in the node:test environment if
  // another suite removed it; define a throwing placeholder so a stale
  // stub from THIS suite can never satisfy a later call by accident.
  Object.defineProperty(globalThis, "fetch", {
    value: async () => {
      throw new Error("fetch stub not installed for this test");
    },
    configurable: true,
    writable: true,
  });
}

function parseBody(captured: CapturedFetch): Record<string, unknown> {
  const init = captured.init;
  assert.ok(init, "fetch must be called with an init object");
  assert.equal(init.method, "POST", "save is a POST");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("saveFsFile — wire shape", () => {
  test("POSTs /api/fs/write with path + content + the mtime/size baseline", async () => {
    const captured = installFetchStub(() => ({
      status: 200,
      ok: true,
      body: { ok: true, path: "/w/note.md", size: 12, mtime: 1717000000123 },
    }));
    try {
      const result = await saveFsFile("/w/note.md", "# edited\n", {
        expectedMtime: 1717000000000,
        expectedSize: 9,
      });
      assert.equal(captured.length, 1);
      assert.match(captured[0]!.url, /\/api\/fs\/write/);
      const body = parseBody(captured[0]!);
      assert.equal(body.path, "/w/note.md");
      assert.equal(body.content, "# edited\n");
      assert.equal(body.expectedMtime, 1717000000000);
      assert.equal(body.expectedSize, 9);
      assert.equal(body.confirm, undefined, "no confirm flag unless explicitly requested");
      assert.equal(result.ok, true);
      assert.equal(result.mtime, 1717000000123);
    } finally {
      restoreFetch();
    }
  });

  test("omitting the baseline omits the fields (explicit-overwrite save)", async () => {
    const captured = installFetchStub(() => ({
      status: 200,
      ok: true,
      body: { ok: true, size: 8, mtime: 1 },
    }));
    try {
      await saveFsFile("/w/note.md", "forced\n");
      const body = parseBody(captured[0]!);
      assert.equal("expectedMtime" in body, false);
      assert.equal("expectedSize" in body, false);
    } finally {
      restoreFetch();
    }
  });

  test("confirmCredential adds confirm:true to the body", async () => {
    const captured = installFetchStub(() => ({
      status: 200,
      ok: true,
      body: { ok: true },
    }));
    try {
      await saveFsFile("/w/.env", "SYNTHETIC=1\n", { confirmCredential: true });
      const body = parseBody(captured[0]!);
      assert.equal(body.confirm, true);
    } finally {
      restoreFetch();
    }
  });

  test("sends a JSON content-type header", async () => {
    const captured = installFetchStub(() => ({
      status: 200,
      ok: true,
      body: { ok: true },
    }));
    try {
      await saveFsFile("/w/a.txt", "x");
      const headers = (captured[0]!.init?.headers ?? {}) as Record<string, string>;
      const contentType = headers["Content-Type"] ?? headers["content-type"];
      assert.ok(contentType, "fetch must carry a content-type header");
      assert.equal(contentType.toLowerCase(), "application/json");
    } finally {
      restoreFetch();
    }
  });
});

describe("saveFsFile — structured failures the toolbar renders", () => {
  test("409 conflict parses code + disk baseline (the conflict card's data)", async () => {
    installFetchStub(() => ({
      status: 409,
      ok: false,
      body: {
        ok: false,
        code: "conflict",
        error: "file changed on disk",
        diskMtime: 1717000009999,
        diskSize: 44,
      },
    }));
    try {
      const result = await saveFsFile("/w/a.md", "mine\n", {
        expectedMtime: 1,
        expectedSize: 2,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "conflict");
      assert.equal(result.diskMtime, 1717000009999);
      assert.equal(result.diskSize, 44);
    } finally {
      restoreFetch();
    }
  });

  test("403 credential refusal parses code + credentialReason (same vocabulary as preview)", async () => {
    installFetchStub(() => ({
      status: 403,
      ok: false,
      body: {
        ok: false,
        code: "credential",
        error: "credential file — write disabled",
        credentialReason: "dotenv",
      },
    }));
    try {
      const result = await saveFsFile("/w/.env", "SYNTHETIC=1\n");
      assert.equal(result.ok, false);
      assert.equal(result.code, "credential");
      assert.equal(result.credentialReason, "dotenv");
    } finally {
      restoreFetch();
    }
  });

  test("a non-JSON body surfaces as an error result, not a throw", async () => {
    const captured: CapturedFetch[] = [];
    Object.defineProperty(globalThis, "fetch", {
      value: async (url: string, init?: RequestInit) => {
        captured.push({ url: String(url), init });
        return { ok: false, status: 502, text: async () => "Bad gateway" } as unknown as Response;
      },
      configurable: true,
      writable: true,
    });
    try {
      const result = await saveFsFile("/w/a.md", "x");
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /502/);
    } finally {
      restoreFetch();
    }
  });
});
