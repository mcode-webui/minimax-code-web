// webui/test/routes/fs-credential-guard.test.js
//
// Slice 16 — server-side credential preview guard.
//
// Pins the contract:
//   - /api/fs/read-file defaults to refusing credential-shaped files
//     (.env, ~/.ssh/id_rsa, *.pem, …) with a structured 403 carrying
//     `code: "credential"` and `credentialReason: <sub-reason>`.
//   - The refusal NEVER returns plaintext: the response body must not
//     contain the file content (this is the security tripwire).
//   - The `confirm=1` query flag is the explicit override the UI uses
//     after the user clicks "open anyway" — the server then releases
//     the bytes. WITHOUT the flag, refusal is unconditional.
//   - Non-credential files (the tripwire: `environment.ts`,
//     `README.md`, …) preview normally; the predicate is not too
//     eager.
//   - /api/fs/raw carries the same gate with the same override knob.
//   - The gate is purely the basename — the predicate is independent
//     of where the file lives inside the workspace.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const fsRoute = await import(absPath("routes/fs.js"));

function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = Object.assign(new EventEmitter(), {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    write(chunk) {
      this.body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("binary");
    },
    done,
  });
  return res;
}

function readFileReq(path, confirm = false) {
  return {
    url: `/api/fs/read-file?path=${encodeURIComponent(path)}${confirm ? "&confirm=1" : ""}`,
  };
}

function rawReq(path, { download = false, confirm = false } = {}) {
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "1");
  if (confirm) params.set("confirm", "1");
  return { url: `/api/fs/raw?${params.toString()}` };
}

describe("fs routes — credential preview guard (slice 16)", () => {
  describe("read-file default-refuse", () => {
    // The tripwire set: each name must 403 with code:"credential"
    // when accessed without `confirm=1`. The plaintext body of the
    // file MUST NOT appear in the response.
    const cases = [
      { file: ".env", content: "DB_URL=postgres://localhost/x\nAPI_KEY=cred_canary_env_one\n", secret: "cred_canary_env_one" },
      { file: ".env.local", content: "DB_PASS=cred_canary_env_local_two\n", secret: "cred_canary_env_local_two" },
      { file: ".npmrc", content: "//registry.example/_authToken=cred_canary_npmrc_three\n", secret: "cred_canary_npmrc_three" },
      { file: ".pypirc", content: "[pypi]\n  password: cred_canary_pypi_four\n", secret: "cred_canary_pypi_four" },
      { file: "id_rsa", content: "private key body\ncred_canary_id_rsa_five\n----- end placeholder -----\n", secret: "cred_canary_id_rsa_five" },
      { file: "id_ed25519", content: "private key body\ncred_canary_id_ed25519_six\n----- end placeholder -----\n", secret: "cred_canary_id_ed25519_six" },
      { file: "server.pem", content: "pem body\ncred_canary_server_pem_seven\n----- end placeholder -----\n", secret: "cred_canary_server_pem_seven" },
      { file: "private.key", content: "key body\ncred_canary_private_key_eight\n----- end placeholder -----\n", secret: "cred_canary_private_key_eight" },
      { file: "credentials", content: "cred_canary_credentials_nine\n", secret: "cred_canary_credentials_nine" },
      { file: "credentials.json", content: '{"placeholder":"cred_canary_credentials_json_ten"}', secret: "cred_canary_credentials_json_ten" },
      { file: "known_hosts", content: "host.example cred_canary_known_hosts_eleven\n", secret: "cred_canary_known_hosts_eleven" },
      { file: "authorized_keys", content: "cred_canary_authorized_keys_twelve user@example\n", secret: "cred_canary_authorized_keys_twelve" },
    ];
    for (const c of cases) {
      test(`${c.file} → 403 credential (no plaintext leak)`, () => {
        const dir = mkdtempSync(join(tmpdir(), "fs-cred-"));
        try {
          const file = join(dir, c.file);
          writeFileSync(file, c.content, "utf8");
          const res = fakeRes();
          fsRoute.handleFsReadFile(readFileReq(file), res);
          assert.equal(res.status, 403);
          const body = JSON.parse(res.body);
          assert.equal(body.ok, false);
          assert.equal(body.code, "credential");
          assert.match(body.error, /credential/i);
          assert.ok(typeof body.credentialReason === "string");
          // SECURITY TRIPWIRE: the secret MUST NOT be in the body. This
          // is the gate that proves the credential guard actually guards.
          assert.equal(
            body.content === undefined,
            true,
            `${c.file}: response must not include content field`,
          );
          assert.equal(
            res.body.includes(c.secret),
            false,
            `${c.file}: response body must not include the secret token`,
          );
          assert.equal(
            res.body.includes(c.content.trim()),
            false,
            `${c.file}: response body must not include any plaintext from the file`,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });

  describe("read-file confirm=1 override", () => {
    test(".env with confirm=1 returns the content (the user explicitly opened it)", () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-confirm-"));
      try {
        const file = join(dir, ".env");
        const body = "cred_canary_confirm_override\nDB_URL=postgres://localhost/x\n";
        writeFileSync(file, body, "utf8");
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(file, /* confirm */ true), res);
        assert.equal(res.status, 200);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.content, body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("confirm=1 on a non-credential file is harmless (idempotent)", () => {
      // The confirm knob is opt-in: a UI bug that sends it for a
      // normal file must NOT start refusing normal files. The flag
      // only matters when the predicate hits.
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-confirm-noop-"));
      try {
        const file = join(dir, "note.md");
        writeFileSync(file, "# hi\n", "utf8");
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(file, /* confirm */ true), res);
        assert.equal(res.status, 200);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.content, "# hi\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("non-credential files preview normally", () => {
    // The tripwire: if the predicate is too eager, the panel breaks
    // for ordinary code. Pin a small set so a regression on the
    // regex is loud.
    for (const name of ["README.md", "environment.ts", "env.js", "monkey.txt", ".envvars"]) {
      test(`${name} previews as usual (predicate not too eager)`, () => {
        const dir = mkdtempSync(join(tmpdir(), "fs-cred-miss-"));
        try {
          const file = join(dir, name);
          writeFileSync(file, "no secrets here\n", "utf8");
          const res = fakeRes();
          fsRoute.handleFsReadFile(readFileReq(file), res);
          assert.equal(res.status, 200, `expected 200 for ${name}, got ${res.status}: ${res.body}`);
          const parsed = JSON.parse(res.body);
          assert.equal(parsed.ok, true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });

  describe("/api/fs/raw — same gate, same override", () => {
    test(".env without confirm → 403 credential (no plaintext)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-raw-"));
      try {
        const file = join(dir, ".env");
        const secret = "cred_canary_raw_no_confirm_target";
        writeFileSync(file, `RAW_TOKEN=${secret}\n`, "utf8");
        const res = fakeRes();
        fsRoute.handleFsRaw(rawReq(file), res);
        await res.done;
        assert.equal(res.status, 403);
        const body = JSON.parse(res.body);
        assert.equal(body.ok, false);
        assert.equal(body.code, "credential");
        // Raw route has no `content` field on refusal — the body must
        // not contain the file's bytes regardless.
        assert.equal(res.body.includes(secret), false, "raw response must not include the secret");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(".env with confirm=1 streams the bytes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-raw-ok-"));
      try {
        const file = join(dir, ".env");
        const body = "cred_canary_raw_with_confirm_target\n";
        writeFileSync(file, body, "utf8");
        const res = fakeRes();
        fsRoute.handleFsRaw(rawReq(file, { confirm: true }), res);
        await res.done;
        assert.equal(res.status, 200);
        assert.equal(res.body, body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("scope discipline", () => {
    // The user's ticket: credential files stay visible in the tree
    // and remain openable via default-app / file-manager / download.
    // /api/fs/read (the directory listing) does NOT carry the credential
    // gate — files stay listed. We assert that here so a future
    // refactor does not accidentally widen the gate to the listing.
    test("/api/fs/read still returns credential files in the listing", () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-tree-"));
      try {
        const file = join(dir, ".env");
        writeFileSync(file, "TREE_TEST=ok\n", "utf8");
        const res = fakeRes();
        fsRoute.handleFsRead(
          { url: `/api/fs/read?path=${encodeURIComponent(dir)}&showHidden=1` },
          res,
        );
        assert.equal(res.status, 200);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.ok, true);
        const names = (parsed.entries || []).map((e) => e.name);
        assert.ok(names.includes(".env"), "credential files must remain visible in the tree");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});