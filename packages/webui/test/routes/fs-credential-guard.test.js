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
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
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

  // v2.5 (slice 16 fix): symlink aliasing. A workspace symlink
  // `innocent.txt → id_rsa` used to pass the gate with the link's
  // basename (innocent.txt), bypassing the credential predicate.
  // The fix is to make `safePath` return the realpath, so the
  // basename check sees the target's name. Hardlinks are an
  // inherent limit of any name-based predicate and are NOT
  // covered by these tests.
  describe("symlink aliasing — credential must see through to the target", () => {
    test("innocent.txt → id_rsa: read-file returns 403 credential", () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-symlink-read-"));
      try {
        const target = join(dir, "id_rsa");
        writeFileSync(
          target,
          "cred_canary_symlink_target_one\n",
          "utf8",
        );
        const link = join(dir, "innocent.txt");
        symlinkSync(target, link);
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(link), res);
        assert.equal(res.status, 403, `symlink must be refused, got ${res.status}`);
        const body = JSON.parse(res.body);
        assert.equal(body.code, "credential");
        assert.equal(body.credentialReason, "ssh-key");
        assert.equal(
          res.body.includes("cred_canary_symlink_target_one"),
          false,
          "symlink response must not include the target's plaintext",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("notes.md → .env: read-file returns 403 credential", () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-symlink-env-"));
      try {
        const target = join(dir, ".env");
        writeFileSync(target, "cred_canary_symlink_env_target\n", "utf8");
        const link = join(dir, "notes.md");
        symlinkSync(target, link);
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(link), res);
        assert.equal(res.status, 403);
        const body = JSON.parse(res.body);
        assert.equal(body.code, "credential");
        assert.equal(body.credentialReason, "dotenv");
        assert.equal(res.body.includes("cred_canary_symlink_env_target"), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("page.html → .env: raw route refuses credential (browser panel must not render)", async () => {
      // The built-in browser panel (slice 04) loads HTML files via
      // `/api/fs/raw`. If a workspace symlink points an .html file
      // at a credential, the panel would otherwise render the
      // secret as a webpage. The raw route has the same gate.
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-symlink-html-"));
      try {
        const target = join(dir, ".env");
        writeFileSync(target, "cred_canary_browser_panel_secret\n", "utf8");
        const link = join(dir, "page.html");
        symlinkSync(target, link);
        const res = fakeRes();
        fsRoute.handleFsRaw(rawReq(link), res);
        await res.done;
        assert.equal(res.status, 403);
        const body = JSON.parse(res.body);
        assert.equal(body.code, "credential");
        assert.equal(res.body.includes("cred_canary_browser_panel_secret"), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("innocent.txt → server.pem: raw route refuses credential", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-symlink-pem-"));
      try {
        const target = join(dir, "server.pem");
        writeFileSync(target, "cred_canary_symlink_pem_target\n", "utf8");
        const link = join(dir, "innocent.txt");
        symlinkSync(target, link);
        const res = fakeRes();
        fsRoute.handleFsRaw(rawReq(link), res);
        await res.done;
        assert.equal(res.status, 403);
        const body = JSON.parse(res.body);
        assert.equal(body.code, "credential");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("symlink with confirm=1 releases bytes (the override is end-to-end)", () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-symlink-override-"));
      try {
        const target = join(dir, "id_rsa");
        writeFileSync(target, "cred_canary_symlink_override_target\n", "utf8");
        const link = join(dir, "innocent.txt");
        symlinkSync(target, link);
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(link, /* confirm */ true), res);
        assert.equal(res.status, 200);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.ok, true);
        assert.match(parsed.content, /cred_canary_symlink_override_target/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // v2.5 (slice 16 fix): backup-suffix shapes (`.bak` / `.old` /
  // `.orig` / `.backup` / `.save` / `.swp`) applied to credential
  // stems. An operator who saves a backup of `.env` next to
  // itself does NOT remove the credential risk — the file is still
  // a credential.
  describe("backup-suffix shapes", () => {
    for (const file of [
      "id_rsa.bak", "id_rsa.old", "id_rsa.orig", "id_rsa.backup", "id_rsa.save",
      "known_hosts.bak", "known_hosts.old",
      "server.pem.bak", "server.pem.old",
      ".env.bak", ".env.old", ".env.orig",
      "credentials.bak", "credentials.old",
      ".npmrc.bak", ".pypirc.old",
    ]) {
      test(`${file} → 403 credential (no prompt at all is a leak)`, () => {
        const dir = mkdtempSync(join(tmpdir(), "fs-cred-backup-"));
        try {
          const fullPath = join(dir, file);
          writeFileSync(fullPath, "cred_canary_backup_target\n", "utf8");
          const res = fakeRes();
          fsRoute.handleFsReadFile(readFileReq(fullPath), res);
          assert.equal(res.status, 403, `${file}: must refuse, got ${res.status}`);
          const body = JSON.parse(res.body);
          assert.equal(body.code, "credential");
          assert.equal(res.body.includes("cred_canary_backup_target"), false);
          assert.equal(res.body.includes("token"), false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    // Negative: backup suffix on a NON-credential basename stays
    // previewable. The suffix alone is not enough; the predicate
    // strips the suffix and re-tests the stem.
    for (const file of ["readme.md.bak", "notes.txt.bak", "package.json.bak"]) {
      test(`${file} previews normally (suffix alone is not credential)`, () => {
        const dir = mkdtempSync(join(tmpdir(), "fs-cred-backup-miss-"));
        try {
          const fullPath = join(dir, file);
          writeFileSync(fullPath, "no secrets here\n", "utf8");
          const res = fakeRes();
          fsRoute.handleFsReadFile(readFileReq(fullPath), res);
          assert.equal(res.status, 200, `${file}: must preview, got ${res.status}: ${res.body}`);
          const parsed = JSON.parse(res.body);
          assert.equal(parsed.ok, true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });

  // v2.5 (slice 16 fix): the credential audit log. When the user
  // explicitly confirms (`confirm=1` on a credential-shaped path),
  // the server writes one JSON line to stderr. A path that is NOT
  // credential-shaped does NOT produce noise; the log is end-to-end
  // for both read-file and raw routes.
  describe("audit log of override use", () => {
    test("confirm=1 on .env writes one audit line to stderr", () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-audit-"));
      const origWrite = process.stderr.write.bind(process.stderr);
      let captured = "";
      process.stderr.write = (chunk) => {
        captured += String(chunk);
        return true;
      };
      try {
        const file = join(dir, ".env");
        writeFileSync(file, "cred_canary_audit_target\n", "utf8");
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(file, /* confirm */ true), res);
        assert.equal(res.status, 200);
        // The audit line is one JSON object ending with `\n`.
        const line = captured
          .split("\n")
          .filter((l) => l.includes("credential.override"))
          .pop();
        assert.ok(line, `expected audit line, got: ${captured}`);
        const parsed = JSON.parse(line);
        assert.equal(parsed.event, "credential.override");
        assert.match(parsed.path, /\.env$/);
        assert.equal(parsed.reason, "dotenv");
        assert.equal(parsed.endpoint, "read-file");
        assert.ok(parsed.ts);
      } finally {
        process.stderr.write = origWrite;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("confirm=1 on a NON-credential file does NOT write an audit line", () => {
      // Confirm on a normal file is a no-op; the audit log
      // specifically tracks the override of a credential gate.
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-audit-miss-"));
      const origWrite = process.stderr.write.bind(process.stderr);
      let captured = "";
      process.stderr.write = (chunk) => {
        captured += String(chunk);
        return true;
      };
      try {
        const file = join(dir, "note.md");
        writeFileSync(file, "# normal\n", "utf8");
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(file, /* confirm */ true), res);
        assert.equal(res.status, 200);
        assert.equal(
          captured.includes("credential.override"),
          false,
          `non-credential confirm must not produce audit noise; got: ${captured}`,
        );
      } finally {
        process.stderr.write = origWrite;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("confirm=1 on .env via raw route writes raw-download audit line", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fs-cred-audit-raw-"));
      const origWrite = process.stderr.write.bind(process.stderr);
      let captured = "";
      process.stderr.write = (chunk) => {
        captured += String(chunk);
        return true;
      };
      try {
        const file = join(dir, ".env");
        writeFileSync(file, "cred_canary_raw_audit_target\n", "utf8");
        const res = fakeRes();
        fsRoute.handleFsRaw(rawReq(file, { confirm: true, download: true }), res);
        await res.done;
        const line = captured
          .split("\n")
          .filter((l) => l.includes("credential.override"))
          .pop();
        assert.ok(line, `expected raw audit line, got: ${captured}`);
        const parsed = JSON.parse(line);
        assert.equal(parsed.endpoint, "raw-download");
      } finally {
        process.stderr.write = origWrite;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // v2.5 (slice 16 followup): the credential guard must work
  // regardless of which spelling of the path the caller passes —
  // the macOS /var ↔ /private/var case is the canonical example,
  // but a Linux bind-mount or a tempdir on a symlink can produce
  // the same two-spelling shape. The canonical form the server
  // uses internally is the realpath; this block pins that the
  // gate produces the same refusal when handed either spelling.
  describe("canonical-form (macOS /var↔/private/var shape on Linux)", () => {
    test("realpath input vs literal-symlink input produce the same refusal", () => {
      const realRoot = mkdtempSync(join(tmpdir(), "fs-cred-can-real-"));
      const linkRoot = join(tmpdir(), `fs-cred-can-link-${Date.now()}`);
      try {
        symlinkSync(realRoot, linkRoot);
        // Create a credential file under the REAL root.
        const realFile = join(realRoot, "id_rsa");
        writeFileSync(
          realFile,
          "cred_canary_canonical_form_target\n",
          "utf8",
        );
        const canonical = realpathSync(realFile);

        // 1) Request via the canonical (realpath) spelling — must
        // be refused as a credential.
        const res1 = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(canonical), res1);
        assert.equal(res1.status, 403);
        const body1 = JSON.parse(res1.body);
        assert.equal(body1.code, "credential");
        assert.equal(body1.credentialReason, "ssh-key");
        // The audit log records the canonical form.
        assert.equal(body1.path, canonical);

        // 2) Request via the literal-symlink spelling — same
        // refusal, same credentialReason, same canonical path in
        // the audit log. (This is the macOS /var ↔ /private/var
        // shape reproduced on Linux.)
        const spelledInput = join(linkRoot, "id_rsa");
        const res2 = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(spelledInput), res2);
        assert.equal(res2.status, 403);
        const body2 = JSON.parse(res2.body);
        assert.equal(body2.code, "credential");
        assert.equal(body2.credentialReason, "ssh-key");
        // CRITICAL: both spellings must resolve to the same
        // canonical path in the audit log — otherwise an
        // operator grep'ing the log for the canonical path
        // could miss the literal-spelling call.
        assert.equal(body2.path, canonical);

        // 3) Both responses must contain no plaintext — the
        // content is identical across both spellings of the
        // credential, so the tripwire holds in either case.
        assert.equal(res1.body.includes("cred_canary_canonical_form_target"), false);
        assert.equal(res2.body.includes("cred_canary_canonical_form_target"), false);
      } finally {
        rmSync(realRoot, { recursive: true, force: true });
        try { rmSync(linkRoot, { recursive: true, force: true }); } catch {}
      }
    });

    test("a credential behind a symlink-spelled dir is still refused (innocent.txt → id_rsa through a symlink root)", () => {
      // Reproduces: macOS /var/folders/.../proj (symlink) with a
      // credential symlink inside. Both the dir and the file
      // symlink must be resolved, and the credential must still
      // be refused.
      const realRoot = mkdtempSync(join(tmpdir(), "fs-cred-dbl-real-"));
      const linkRoot = join(tmpdir(), `fs-cred-dbl-link-${Date.now()}`);
      try {
        symlinkSync(realRoot, linkRoot);
        const target = join(realRoot, "id_rsa");
        writeFileSync(target, "cred_canary_double_symlink_root\n", "utf8");
        // Inside the symlink root, create a credential symlink
        // pointing at the target.
        const linkInDir = join(realRoot, "innocent.txt");
        symlinkSync(target, linkInDir);
        // Use the LITERAL symlink-root spelling of the dir to
        // reach the credential link.
        const spelledInput = join(linkRoot, "innocent.txt");
        const res = fakeRes();
        fsRoute.handleFsReadFile(readFileReq(spelledInput), res);
        assert.equal(res.status, 403);
        const body = JSON.parse(res.body);
        assert.equal(body.code, "credential");
        assert.equal(body.credentialReason, "ssh-key");
        // Audit path is the realpath of the credential file,
        // not the spelled input.
        assert.equal(body.path, realpathSync(target));
        assert.equal(res.body.includes("cred_canary_double_symlink_root"), false);
      } finally {
        rmSync(realRoot, { recursive: true, force: true });
        try { rmSync(linkRoot, { recursive: true, force: true }); } catch {}
      }
    });
  });
});