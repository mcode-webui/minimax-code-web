// webui/test/routes/fs-search.test.js
//
// Slice 19a — bounded workspace search route.
//
// Pins the HTTP contract the webapp will wire into the file-tree
// panel's filter box (slice 19b is the wiring; this slice is the
// server-only contract).
//
// Pinned behaviours:
//   - containment gate: out-of-root paths 403 with the same
//     actionable message the other `/api/fs/*` routes carry;
//     no new escape surface in this slice;
//   - missing `root` / `q` / non-directory `root` → 400;
//   - matches returned with `ancestors`, credential flagging,
//     `truncated: true` honesty on budget hits;
//   - the response body NEVER contains file contents —
//     no content, no size sample, no mtime. The plaintext
//     tripwire is the same shape slice 16 uses for read-file;
//   - symlink-aliasing realpath handed to the credential
//     classifier (slice 16 alignment).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const fsRoute = await import(absPath("routes/fs.js"));

function fakeRes() {
  const res = {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
    },
  };
  return res;
}

function searchReq(path, params = "") {
  // The route only reads `req.url`; the body is not consumed.
  const qs = new URLSearchParams({ root: path });
  for (const [k, v] of Object.entries(params)) qs.set(k, v);
  return { url: `/api/fs/search?${qs.toString()}` };
}

describe("fs routes — /api/fs/search (slice 19a)", () => {
  test("missing root → 400", () => {
    const res = fakeRes();
    fsRoute.handleFsSearch({ url: "/api/fs/search?q=foo" }, res);
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /missing root/);
  });

  test("missing q → 400", () => {
    const res = fakeRes();
    fsRoute.handleFsSearch({ url: "/api/fs/search?root=/tmp" }, res);
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /missing q/);
  });

  test("root outside the allowed roots → 403 with the actionable error", () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    fsRoute.handleFsSearch({ url: `/api/fs/search?root=${encodeURIComponent(outsideRoot)}&q=*` }, res);
    assert.equal(res.status, 403);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /允许根|MCODE_WEBUI_WORKSPACE_ROOTS/);
  });

  test("root that is a regular file → 400 not-a-directory", () => {
    const dir = mkTmpDir("fs-search-file-");
    try {
      const file = join(dir, "input.txt");
      writeFileSync(file, "");
      const res = fakeRes();
      fsRoute.handleFsSearch(searchReq(file, { q: "*" }), res);
      assert.equal(res.status, 400);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, "not-a-directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("happy path: deep package.json is found without expanding the tree", () => {
    // Reproduces the user's ~/文档/demo002 shape: a file three
    // levels down in a collapsed-equivalent directory shows up
    // in matches even though the client has not loaded anything.
    const root = mkTmpDir("fs-search-happy-");
    try {
      mkdirp(join(root, "codersday"));
      writeFileSync(join(root, "codersday", "package.json"), "{}");
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "README.md"), "");

      const res = fakeRes();
      fsRoute.handleFsSearch(searchReq(root, { q: "package.json" }), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.matches.length, 2);
      // The deep one with ancestors=['codersday'] — the panel
      // uses this chain to "expand to" the hit.
      const deep = parsed.matches.find((m) => m.ancestors.length === 1);
      assert.ok(deep, "expected a deep package.json match with ancestors=['codersday']");
      assert.deepEqual(deep.ancestors, ["codersday"]);
      assert.equal(deep.type, "file");
      // Scanned counter is non-zero and matches the total.
      assert.ok(parsed.scanned.total >= 3, `expected scanned.total >= 3, got ${parsed.scanned.total}`);
      // The endpoint echoes the root + q so the UI can confirm
      // what was actually searched. mkdtempSync appends random
      // bytes after `fs-search-happy-`, so we match the prefix
      // rather than an exact suffix.
      assert.match(parsed.root, /fs-search-happy-/);
      assert.equal(parsed.q, "package.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("node_modules is skipped + reported in skipped counts", () => {
    const root = mkTmpDir("fs-search-skip-");
    try {
      mkdirp(join(root, "node_modules"));
      for (let i = 0; i < 10; i += 1) {
        writeFileSync(join(root, "node_modules", `pkg${i}.js`), "");
      }
      writeFileSync(join(root, "top.js"), "");

      const res = fakeRes();
      fsRoute.handleFsSearch(searchReq(root, { q: "*.js" }), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.matches.length, 1);
      assert.equal(parsed.matches[0].name, "top.js");
      assert.equal(parsed.skipped["node_modules"], 1);
      // None of the 10 pkgN.js files should have appeared.
      const leaked = parsed.matches.some((m) => /pkg\d+\.js/.test(m.name));
      assert.equal(leaked, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncation honesty: oversized budget reports truncated:true with a reason", () => {
    const root = mkTmpDir("fs-search-trunc-");
    try {
      mkdirp(join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i"));
      writeFileSync(join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i", "target.md"), "");

      const res = fakeRes();
      // depth=2 — cannot reach the target at depth 9.
      fsRoute.handleFsSearch(searchReq(root, { q: "target.md", depth: "2" }), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.matches.length, 0);
      assert.equal(parsed.truncated, true);
      assert.equal(parsed.truncatedReason, "depth");
      // Budgets are echoed so the UI can render "truncated by depth" properly.
      assert.equal(parsed.budgets.maxDepth, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hostile budget (maxNodes=999999) is clamped, not honoured", () => {
    const root = mkTmpDir("fs-search-clamp-");
    try {
      mkdirp(join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i"));
      writeFileSync(join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i", "target.md"), "");

      const res = fakeRes();
      fsRoute.handleFsSearch(searchReq(root, { q: "target.md", depth: "2", maxNodes: "999999" }), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      // maxNodes was clamped to the absolute limit (50000), so
      // the depth budget still wins and the response shows
      // truncated=true, reason='depth'. The clamp is visible.
      assert.equal(parsed.budgets.maxNodes, 50_000);
      assert.equal(parsed.truncatedReason, "depth");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("response body NEVER contains file content — plaintext tripwire", () => {
    const root = mkTmpDir("fs-search-plaintext-");
    try {
      // includeHidden so .env (a dotfile credential) is visible
      // — the tripwire here is "search must never leak content
      // even when the user is searching for credentials".
      writeFileSync(join(root, ".env"), "cred_canary_dotenv_route_target\n");
      writeFileSync(join(root, "id_rsa"), "cred_canary_id_rsa_route_target\n");
      writeFileSync(join(root, "server.pem"), "cred_canary_pem_route_target\n");
      writeFileSync(join(root, "credentials"), "cred_canary_credentials_route_target\n");

      const res = fakeRes();
      fsRoute.handleFsSearch(searchReq(root, { q: "*", includeHidden: "1" }), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      // No plaintext from any of the four credential-shaped files.
      assert.equal(res.body.includes("cred_canary_dotenv_route_target"), false);
      assert.equal(res.body.includes("cred_canary_id_rsa_route_target"), false);
      assert.equal(res.body.includes("cred_canary_pem_route_target"), false);
      assert.equal(res.body.includes("cred_canary_credentials_route_target"), false);
      // Each credential-shaped match IS returned with a flag — the
      // decision is "flag, never omit".
      const credentials = parsed.matches.filter((m) => m.credential);
      assert.equal(credentials.length, 4);
      // Each flag carries a stable reason from the slice-16 predicate.
      const reasons = new Set(credentials.map((m) => m.credentialReason));
      assert.deepEqual([...reasons].sort(), ["credentials", "dotenv", "key-file", "ssh-key"].sort());
      // Skipped counter is incremented for each.
      assert.equal(parsed.skipped.credential, 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink aliasing — credential target reached via a link still flags", () => {
    // Mirror the slice-16 test shape: `innocent.txt → id_rsa`
    // must surface as `credential: true` even when the user got
    // there by symlink. The search walker passes the resolved
    // path into classifyCredential.
    //
    // The contract pinned here is **path = realpath(target) on
    // every platform** — not the literal spelling mkdtempSync
    // returned. macOS's temp root is `/var/folders/...` while
    // realpathSync returns `/private/var/folders/...`; comparing
    // against the literal would platform-split the assertion
    // (slice 16 hit the same trap; the fix there was to compare
    // against realpath). We do the same here.
    const root = mkTmpDir("fs-search-sym-");
    try {
      const target = join(root, "id_rsa");
      writeFileSync(target, "cred_canary_symlink_search_target\n");
      const link = join(root, "innocent.txt");
      symlinkSync(target, link);
      // The canonical spelling — what the walker emits and
      // what the downstream /api/fs/read-file gate sees.
      const canonicalTarget = realpathSync(target);

      const res = fakeRes();
      // searchReq spells the root the way `mkdtempSync` returned
      // it — that should work on macOS too because the route's
      // `assertWorkspacePath` is the spelling-tolerant gate.
      fsRoute.handleFsSearch(searchReq(root, { q: "innocent.txt" }), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.matches.length, 1);
      const hit = parsed.matches[0];
      // Credential flag is on (slice-16 alignment) — the path
      // passed to classifyCredential is the realpath form.
      assert.equal(hit.credential, true);
      assert.equal(hit.credentialReason, "ssh-key");
      assert.equal(res.body.includes("cred_canary_symlink_search_target"), false);
      // Path is the realpath form — verbatim with what the route
      // hands the downstream credential guard in /api/fs/read-file.
      assert.equal(hit.path, canonicalTarget);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the 'q' alias is also accepted (limit / maxMatches)", () => {
    const root = mkTmpDir("fs-search-limit-");
    try {
      for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `note${i}.md`), "");
      const res = fakeRes();
      // Use the alias the docs mention (`limit`) — both spellings
      // resolve to the same budget.
      fsRoute.handleFsSearch(searchReq(root, { q: "*.md", limit: "3" }), res);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.matches.length, 3);
      assert.equal(parsed.truncated, true);
      assert.equal(parsed.truncatedReason, "matches");
      assert.equal(parsed.budgets.maxMatches, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Tiny mkdir helper imported by the test fixtures above; placed
// at the bottom so the tests above read top-down without helpers
// breaking the flow.
import { mkdirSync } from "node:fs";
import { mkTmpDir } from "../helpers/tmp.js";
function mkdirp(...parts) {
  const full = join(...parts);
  mkdirSync(full, { recursive: true });
  return full;
}
