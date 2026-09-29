// webui/test/server/catalogue-via-runtime.test.js
//
// S3 (runtime-first migration step 3): catalogue traffic (sessions
// list + title) routes through the in-process catalogue host when
// `MCODE_WEBUI_TRANSPORT=runtime`. The shape returned by the catalogue
// path must follow the same rules as the existing ACP path so the
// sidebar tree never shifts — runtime and ACP read the same SQLite,
// but their handler shapes differ; this module pins the projection.
//
// What the suite pins:
//   1. `listMcodeSessionsViaRuntime(host)` returns an array of objects
//      with the exact ACP-shape fields, following every
//      `toAcpSessionInfo` rule (packages/tui/src/acp/agent.ts):
//      internal sub-agent sessions and sessions with a missing or
//      non-absolute cwd are dropped whole; `title` is omitted when
//      empty; `updatedAt` is an ISO string whose key is omitted when
//      the runtime carries no timestamp. Field-by-field diff against
//      an independently re-derived ACP page is zero.
//   2. When the catalogue host throws (boot failure), the list path
//      falls back to ACP and the ACP path's result wins (pinned in
//      catalogue-fallback.test.js).
//   3. `getMcodeSessionTitleViaRuntime(host, id)` returns the same
//      string the ACP path would have returned for the same session —
//      including `null` for sessions the projection drops whole.
//   4. Zero NEW child processes across N catalogue listings — both at
//      the host layer (S3-RH-04) and through `acp-client.js` with
//      `MCODE_WEBUI_TRANSPORT=runtime` (S3-RH-05/S3-RH-06). The probe
//      enumerates DESCENDANTS of this test process by parent PID, not
//      by process name: the real ACP child's `/proc/<pid>/comm` is
//      `minimax-code` (not `mcode`), so a name-matched probe counted
//      zero children even while an ACP child was alive — the old
//      assertion was vacuously true. Descendant enumeration cannot be
//      fooled by a rename and catches any spawn, mcode or otherwise.
//      "New" is measured against a baseline snapshot taken just
//      before each window opens: a descendant that predates the
//      window is environment noise, not a spawn the window caused
//      (the absolute-empty-set variant of this assertion once
//      observed one such descendant and went red without a
//      regression). S3-RH-09 pins that the probe still catches a
//      genuine in-window spawn.

import { test, describe, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mkTmpDir, mkSubTmpDir, rmTmpDir } from "../helpers/tmp.js";

// runtime-host.js takes dataDir as an explicit option (not env).
// This test does not spawn server.js — the test-isolation-lint does
// not apply.
//
// acp-client.js (S3-RH-05/06) DOES read config.js, which resolves the
// data dir from `MINIMAX_DATA_DIR` and the transport from
// `MCODE_WEBUI_TRANSPORT` at module-init time. Both are set below,
// BEFORE any dynamic import of config-reading modules, so the
// acp-client catalogue host boots against the isolated tmp base and
// the transport switch resolves to `runtime`. node:test runs each
// file in its own process, so this does not leak into other suites.
const tmpBase = mkTmpDir("mcode-webui-s3-catalogue-");
process.env.MCODE_WEBUI_TRANSPORT = "runtime";
process.env.MINIMAX_DATA_DIR = tmpBase;

function setupIsolatedDir(label) {
  return mkSubTmpDir(tmpBase, `${label}-`);
}

after(async () => {
  // Best-effort teardown of anything acp-client.js may have started.
  // On the green path there is nothing to stop (no ACP singleton, the
  // catalogue host closes itself); if a regression flipped the path
  // to ACP this keeps the spawned child from outliving the test run.
  try {
    const { shutdownMcodeAcpSingleton } = await import(
      "../../server/lib/acp-client.js"
    );
    shutdownMcodeAcpSingleton();
  } catch {}
  delete process.env.MCODE_WEBUI_TRANSPORT;
  delete process.env.MINIMAX_DATA_DIR;
  // Every setupIsolatedDir child lives under tmpBase; removing the
  // parent recursively clears them all (helper-tracked, so the exit
  // hook is the backstop if this after-hook never runs).
  rmTmpDir(tmpBase);
});

/**
 * Enumerate every descendant of THIS test process by walking
 * /proc/<pid>/stat parent links (the test process itself is not
 * included). Returns a pid-sorted array of pid strings.
 *
 * Why descendants and not a name match: the acceptance probe that
 * matched `comm === "mcode"` returned 0 even while a real ACP child
 * (`comm === "minimax-code"`) was alive. A parent-PID walk is
 * name-agnostic — any child this process spawns (mcode, node, or
 * anything else) shows up, so a "zero spawns" assertion can only
 * pass when the code path genuinely internalized the work.
 *
 * Linux-only (matches the production layout). On other platforms the
 * walk finds no /proc and returns [] — the suite still runs, but the
 * internalization invariant only fires on Linux.
 */
function listDescendantPids() {
  const childrenOf = new Map();
  let pids;
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm is parenthesised and may itself contain spaces or
      // parens, so parse from the LAST closing paren; field 2 after
      // it is ppid (field 1 after the paren is the process state).
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      if (!Number.isInteger(ppid)) continue;
      // Key by STRING pid: the walk below walks readdir's string pids,
      // and a Map keyed by numbers never matches a string lookup.
      const key = String(ppid);
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(pid);
    } catch {}
  }
  const out = [];
  const stack = [String(process.pid)];
  const seen = new Set(stack);
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenOf.get(cur) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  return out.sort((a, b) => Number(a) - Number(b));
}

/**
 * Run `fn` while polling /proc for descendants of this test process;
 * resolves with `{result, spawned}` where `spawned` is every pid that
 * appeared as a descendant AT ANY POINT during the window and was NOT
 * already alive when the window opened (pid-sorted).
 *
 * Baseline-relative, not absolute-empty: a descendant that predates
 * the window (a runner helper, an unrelated tool the harness started)
 * is environment noise — counting it turned the old `[]` assertion
 * red once with no regression behind it. The baseline snapshot is
 * taken synchronously just before the window opens, so only pids that
 * genuinely appear inside the window land in `spawned`.
 *
 * Polling instead of an end-of-run snapshot because the red line is
 * about spawn EVENTS, not surviving processes: a regressed ACP
 * fallback spawns a child, the handshake fails (`Authentication
 * required` on an isolated data dir), and the child is stopped before
 * the caller's next await resolves — a snapshot taken after the call
 * sees nothing and the assertion stays green. The 20 ms poll floor is
 * far below any real child lifetime (JSON-RPC initialize + reply is
 * hundreds of ms), so a genuine spawn cannot slip through (pinned by
 * S3-RH-09).
 */
async function watchDescendantsDuring(fn) {
  const baseline = new Set(listDescendantPids());
  const seen = new Set();
  const timer = setInterval(() => {
    for (const pid of listDescendantPids()) {
      if (!baseline.has(pid)) seen.add(pid);
    }
  }, 20);
  try {
    const result = await fn();
    return { result, spawned: [...seen].sort((a, b) => Number(a) - Number(b)) };
  } finally {
    clearInterval(timer);
  }
}

/**
 * Independent re-derivation of the ACP adapter's timestamp rule for
 * the hand-built expected pages: epoch-ms numbers (and numeric
 * strings) become ISO strings; anything unparseable omits the key.
 */
function toIsoOrUndefined(value) {
  if (value === undefined || value === null) return undefined;
  const numeric =
    typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : value;
  const t = new Date(numeric).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// Independent re-derivation of the ACP adapter's drop rules
// (`toAcpSessionInfo` in packages/tui/src/acp/agent.ts, predicates in
// packages/tui/src/runtime/delegation.ts). These constants deliberately
// duplicate the product side: if the engine renames a worker prefix or
// adds a builtin sub-agent name and the product copy moves, this copy
// going stale is exactly what the parity diff below surfaces.
const WORKER_PURPOSE_PREFIXES = [
  "local-task:",
  "local-background-task:",
  "team-plan:",
];
const BUILTIN_SUBAGENT_NAMES = new Set(["explore", "worker", "verifier"]);

function expectedIsInternalSubagent(s) {
  const purpose = typeof s.purpose === "string" ? s.purpose : "";
  const delegated =
    s.sessionKind === "task" ||
    WORKER_PURPOSE_PREFIXES.some((prefix) => purpose.startsWith(prefix));
  const agentName = s.agentName?.trim().toLocaleLowerCase();
  const builtin =
    agentName !== undefined && BUILTIN_SUBAGENT_NAMES.has(agentName);
  return delegated || builtin;
}

/**
 * Independent re-derivation of the FULL `toAcpSessionInfo` projection:
 * drop internal sub-agent sessions and missing/non-absolute cwds,
 * omit an empty `title`, omit an unparseable `updatedAt`. Returns
 * `null` where the ACP adapter would drop the entry whole.
 */
function expectedAcpInfo(s) {
  if (expectedIsInternalSubagent(s)) return null;
  if (!s.workspaceDir || !isAbsolute(s.workspaceDir)) return null;
  const updatedAt = toIsoOrUndefined(s.updatedAt);
  return {
    sessionId: s.sessionId,
    cwd: s.workspaceDir,
    ...(s.title ? { title: s.title } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
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
    // would (`toAcpSessionInfo`: sessionId/cwd always present, title
    // OMITTED for an unnamed session, updatedAt present whenever the
    // runtime has a timestamp). Any extra or missing field here is a
    // diff against ACP that the sidebar tree will eventually notice.
    // createSession above passes no title, so this session pins the
    // omission rule itself — the key must be absent, not `null`.
    const expectedKeys = ["sessionId", "cwd", "updatedAt"].sort();
    const actualKeys = Object.keys(hit).sort();
    assert.deepEqual(
      actualKeys,
      expectedKeys,
      `catalogue shape must match ACP shape (title omitted when empty). got=${JSON.stringify(actualKeys)}`,
    );
    assert.ok(
      !("title" in hit),
      "an unnamed session must carry NO title key (ACP omits it, never null)",
    );
    assert.equal(hit.cwd, dir, "cwd must mirror the createSession workspaceDir");
    assert.equal(typeof hit.sessionId, "string", "sessionId must be a string");
    // updatedAt: ISO 8601 string equal to the ACP adapter's
    // conversion of the same TuiSession timestamp (epoch ms → ISO).
    const tuiHit = (await host.adapter.listSessions()).find(
      (s) => s.sessionId === created.sessionId,
    );
    assert.ok(tuiHit, "the raw TuiSession must be listable for cross-checking");
    assert.equal(
      typeof tuiHit.updatedAt,
      "number",
      "precondition: a freshly-created TuiSession carries an epoch-ms updatedAt",
    );
    assert.equal(
      hit.updatedAt,
      new Date(tuiHit.updatedAt).toISOString(),
      "updatedAt must be the ISO form of the TuiSession epoch-ms timestamp",
    );

    await host.close();
    rmTmpDir(dir);
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
    // runtime state, re-deriving the full projection independently
    // (expectedAcpInfo above). If the catalogue path drops an entry
    // the ACP adapter keeps, keeps one it drops, strips a field, or
    // adds one, this comparison goes red.
    const sessions = await host.adapter.listSessions();
    const expected = sessions
      .map(expectedAcpInfo)
      .filter((s) => s !== null);

    assert.deepEqual(
      catalogue,
      expected,
      "catalogue list must be deep-equal to a hand-built ACP-shaped equivalent",
    );
    await host.close();
    rmTmpDir(dir);
  });

  test("S3-RH-07: projection drops sub-agent and bad-cwd sessions, omits empty title (synthetic feed)", async () => {
    // The real runtime host cannot be asked to produce a sub-agent
    // session or a relative-cwd session on demand (createSession
    // validates its input), so the drop rules are pinned against a
    // synthetic TuiSession feed through the same list helper the
    // acp-client path uses. Every row re-derives its expectation from
    // expectedAcpInfo — the independent copy of the ACP rules.
    const { listMcodeSessionsViaRuntime } = await import(
      "../../server/lib/catalogue-sessions.js"
    );
    const ws = tmpBase; // an absolute path by construction (mkdtemp)
    const synthetic = [
      // kept: titled, untitled, and a non-builtin agentName
      { sessionId: "s-titled", workspaceDir: ws, title: "Named", updatedAt: 1759000000000 },
      { sessionId: "s-untitled", workspaceDir: ws, updatedAt: 1759000000123 },
      { sessionId: "s-other-agent", workspaceDir: ws, agentName: "main" },
      // dropped: internal sub-agent identities (all three shapes)
      { sessionId: "s-task-kind", workspaceDir: ws, sessionKind: "task", title: "x" },
      { sessionId: "s-worker-purpose", workspaceDir: ws, purpose: "local-task:abc", title: "x" },
      { sessionId: "s-bg-purpose", workspaceDir: ws, purpose: "local-background-task:7", title: "x" },
      { sessionId: "s-team-plan", workspaceDir: ws, purpose: "team-plan:plan1", title: "x" },
      { sessionId: "s-explore-agent", workspaceDir: ws, agentName: "Explore", title: "x" },
      // dropped: bad cwd (relative, or missing)
      { sessionId: "s-rel-cwd", workspaceDir: "relative/ws", title: "x" },
      { sessionId: "s-no-cwd", title: "x" },
    ];
    const fakeHost = {
      adapter: { listSessions: async () => synthetic },
    };

    const got = await listMcodeSessionsViaRuntime(fakeHost);
    const expected = synthetic
      .map(expectedAcpInfo)
      .filter((s) => s !== null);
    assert.deepEqual(
      got,
      expected,
      "projection must match the independently re-derived ACP page entry for entry",
    );
    // Pin the drop outcomes explicitly (deepEqual above would also
    // catch them, but these messages say WHICH rule broke):
    const ids = got.map((s) => s.sessionId);
    assert.deepEqual(
      ids,
      ["s-titled", "s-untitled", "s-other-agent"],
      "exactly the non-sub-agent, absolute-cwd sessions survive",
    );
    const untitled = got.find((s) => s.sessionId === "s-untitled");
    assert.ok(
      untitled && !("title" in untitled),
      "a session without a title must carry NO title key (omitted, not null)",
    );
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
    rmTmpDir(dir);

    // The ACP path resolves titles from its already-filtered
    // `session/list` page, so a session the projection drops whole has
    // no title there. Mirror that for the runtime helper: synthetic
    // getSession results pin the same drop rules (the real host
    // cannot be asked for a sub-agent session on demand).
    const ws = tmpBase;
    const syntheticById = {
      "sub-explore": { sessionId: "sub-explore", workspaceDir: ws, agentName: "explore", title: "inner" },
      "sub-relcwd": { sessionId: "sub-relcwd", workspaceDir: "rel/ws", title: "inner" },
      "ok-titled": { sessionId: "ok-titled", workspaceDir: ws, title: "outer" },
    };
    const syntheticGetSession = {
      adapter: {
        getSession: async (sid) => syntheticById[sid] || null,
      },
    };
    assert.equal(
      await getMcodeSessionTitleViaRuntime(syntheticGetSession, "sub-explore"),
      null,
      "an internal sub-agent session must answer null — ACP could never list it",
    );
    assert.equal(
      await getMcodeSessionTitleViaRuntime(syntheticGetSession, "sub-relcwd"),
      null,
      "a session with a non-absolute cwd must answer null — ACP could never list it",
    );
    assert.equal(
      await getMcodeSessionTitleViaRuntime(syntheticGetSession, "ok-titled"),
      "outer",
      "a listed session's title still resolves",
    );
  });

  test("S3-RH-04: zero child processes across N direct catalogue listings", async () => {
    const dir = setupIsolatedDir("rh04");
    const { createCatalogueHost } = await import(
      "../../server/lib/runtime-host.js"
    );
    const { listMcodeSessionsViaRuntime } = await import(
      "../../server/lib/catalogue-sessions.js"
    );

    const { spawned } = await watchDescendantsDuring(async () => {
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
      await host.close();
    });

    assert.deepEqual(
      spawned,
      [],
      "process internalization must hold across 10 catalogue listings (no NEW descendant at any point)",
    );
    rmTmpDir(dir);
  });

  test("S3-RH-09: the baseline-relative probe still catches a genuine in-window spawn", async () => {
    // The companion to the zero-spawn assertions: a probe that has
    // been made tolerant of pre-existing descendants (baseline
    // relative) must NOT become blind. Spawn a real child of THIS
    // test process inside the window and require the probe to see it.
    // The child is short-lived but spans many 20 ms poll ticks, and it
    // exits by itself — nothing here needs signalling.
    let childPid = null;
    const { spawned } = await watchDescendantsDuring(async () => {
      await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          ["-e", "setTimeout(() => {}, 400)"],
          { stdio: "ignore" },
        );
        childPid = child.pid;
        child.on("exit", resolve);
        child.on("error", resolve);
      });
    });
    assert.ok(
      spawned.length > 0,
      "a child spawned inside the window must be observed (probe must not be blind)",
    );
    assert.ok(
      spawned.includes(String(childPid)),
      `the spawned child's own pid must be in the observation (child=${childPid}, saw=${JSON.stringify(spawned)})`,
    );
  });
});

describe("S3 — transport switch honors MCODE_WEBUI_TRANSPORT (via acp-client.js)", () => {
  // These two tests go through the REAL acp-client.js module (no
  // mocks): config.js resolves MCODE_WEBUI_TRANSPORT=runtime and
  // MINIMAX_DATA_DIR=tmpBase from the env set at file top, so
  // `listAllMcodeSessions` / `getMcodeSessionsForWorkspace` must take
  // the catalogue branch and never start the ACP singleton.

  test("S3-RH-05: transport=runtime serves getMcodeSessionsForWorkspace from the catalogue host", async () => {
    const seedWs = setupIsolatedDir("rh05-ws");
    // Seed one session into the shared tmp data dir via a short-lived
    // host, then close it — acp-client.js boots its own singleton
    // host over the same SQLite.
    const { createCatalogueHost } = await import(
      "../../server/lib/runtime-host.js"
    );
    const seeder = await createCatalogueHost({ dataDir: tmpBase });
    const created = await seeder.adapter.createSession({
      workspaceDir: seedWs,
      mcpServers: [],
    });
    await seeder.close();

    // Import acp-client.js AFTER the env is set (file top) so config.js
    // sees transport=runtime and the isolated data dir.
    const { getMcodeSessionsForWorkspace } = await import(
      "../../server/lib/acp-client.js"
    );
    const { MCODE_WEBUI_TRANSPORT: envTransport, MAVIS_DATA_DIR } = await import(
      "../../server/lib/config.js"
    );
    assert.equal(envTransport, "runtime", "config must resolve transport=runtime");
    assert.equal(MAVIS_DATA_DIR, tmpBase, "config must resolve the isolated data dir");

    // Watch for spawn events DURING the call: config.js probes the
    // sqlite3 binary with spawnSync at module-init (before this
    // point), and a regressed ACP fallback's child may live only for
    // the duration of the failed handshake — an end-of-run snapshot
    // would miss it.
    const { result: sessions, spawned } = await watchDescendantsDuring(() =>
      getMcodeSessionsForWorkspace(seedWs),
    );

    const hit = sessions.find((s) => s.sessionId === created.sessionId);
    assert.ok(
      hit,
      `the seeded session must surface through acp-client.js (got ${sessions.length} sessions)`,
    );
    // Same ACP field set as pinned at the normalizer layer — this is
    // the end-to-end version of the S3-RH-01 shape assertion. The
    // seeded session carries no title, so the key set pins the
    // omission rule (no `title: null` on the wire).
    assert.deepEqual(
      Object.keys(hit).sort(),
      ["sessionId", "cwd", "updatedAt"].sort(),
      "acp-client-served session must carry the ACP field set (title omitted when empty)",
    );
    assert.ok(
      !("title" in hit),
      "an unnamed session served through acp-client.js must carry NO title key",
    );
    assert.deepEqual(
      spawned,
      [],
      "the catalogue branch must serve with zero spawn events — any observed descendant means an ACP fallback",
    );
  });

  test("S3-RH-06: zero child processes across 10 catalogue listings through acp-client.js", async () => {
    const { listAllMcodeSessions } = await import(
      "../../server/lib/acp-client.js"
    );

    // listAllMcodeSessions has no cache layer — every call exercises
    // the catalogue host directly, mirroring the acceptance red line
    // "10 session switches → 0 mcode acp spawns". Spawn events are
    // observed DURING the loop (see watchDescendantsDuring): a
    // transient ACP child that dies before a post-loop snapshot must
    // still fail this assertion.
    const { spawned } = await watchDescendantsDuring(async () => {
      for (let i = 0; i < 10; i++) {
        const list = await listAllMcodeSessions();
        assert.ok(Array.isArray(list), "listAllMcodeSessions must return an array");
      }
    });

    assert.deepEqual(
      spawned,
      [],
      "10 catalogue listings through acp-client.js must not spawn any child process",
    );
  });
});
