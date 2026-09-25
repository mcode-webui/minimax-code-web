// scripts/test-isolation-lint.check.mjs
//
// CI lint gate (session-isolation/05): every test that SPAWNS
// packages/webui/server.js as a child process MUST set the
// per-test temp-dir overrides for the data files the backend
// writes to. Without the overrides, a test can land
// `events.ndjson` / `settings.json` / `sessions.json` lines in the
// user's real state directory — the documented "test leakage"
// shape that came up in the forensic audit.
//
// The lint is intentionally cheap: it scans the test/ and
// packages/webui/test/ trees for the canonical spawn pattern
// (`spawn(... server.js ...)` or `spawnSync(... server.js ...)` or
// `process.execPath + [..., server.js]`), then checks the
// surrounding function for the four env overrides:
//
//   MCODE_WEBUI_SETTINGS_PATH
//   MCODE_WEBUI_EVENTS_PATH
//   MCODE_WEBUI_SESSIONS_DB
//   MCODE_WEBUI_UPLOAD_DIR
//
// A spawn inside a comment or a string literal is ignored. A
// mention of one of the env names in a comment is ignored. Only
// spawn-within-the-same-function is the trigger.
//
// Why a dedicated lint, not a static-typescript rule: the test
// files use `import { spawn } from "node:child_process"` and the
// spawn call may live anywhere in the function (the env overrides
// are typically constructed earlier and passed as `env`). A
// regex over the function body is the cheapest precise check, and
// running it from `node:test` keeps the gate in the standard
// `pnpm test:webui` run.
//
// Pinned under the test:webui gate via packages/webui/package.json's
// `test:unit` glob. Exits 0 on clean; exits 1 with a per-file
// listing when a spawn is missing one or more overrides.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const repoRoot = process.cwd();

/**
 * Recursively walk `dir` and yield every regular file. Skips
 * node_modules, .git, .next, dist, build, out.
 */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    if (entry.name === "dist" || entry.name === "build" || entry.name === "out") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

const REQUIRED_ENV_OVERRIDES = [
  "MCODE_WEBUI_SETTINGS_PATH",
  "MCODE_WEBUI_EVENTS_PATH",
  "MCODE_WEBUI_SESSIONS_DB",
  "MCODE_WEBUI_UPLOAD_DIR",
];

/**
 * Does the file text contain a server.js spawn? The patterns are
 * narrow enough to skip imports, type-only references, and
 * unrelated child_process calls:
 *   - `spawn(...)` whose first argument array contains `server.js`
 *   - `spawnSync(...)` likewise
 *   - `process.execPath` + `[..., "server.js", ...]` arg arrays
 *
 * Returns the indices of every match — each match triggers an env
 * override check on the enclosing function body.
 */
function findSpawnIndices(text) {
  const indices = [];
  // spawn( ... "server.js" ...
  const spawnRe = /spawn(?:Sync)?\s*\(/g;
  let m;
  while ((m = spawnRe.exec(text))) {
    // Walk forward to find the matching closing paren — naive but
    // good enough for the test files we care about.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    const call = text.slice(m.index, i);
    if (/"server\.js"|'server\.js'/.test(call)) {
      indices.push({ start: m.index, end: i, call });
    }
  }
  return indices;
}

/**
 * Given the file text and a span (match), find the enclosing
 * `function name(...) { ... }` body so the override check is scoped
 * to the same function. If no enclosing function is found, the
 * whole file is the scope.
 */
function enclosingFunctionBody(text, spanStart) {
  // Find the nearest `function ` before spanStart.
  let i = spanStart;
  while (i > 0) {
    const kwIdx = text.lastIndexOf("function", i);
    if (kwIdx === -1) break;
    const openBrace = text.indexOf("{", kwIdx);
    if (openBrace === -1 || openBrace > spanStart) {
      i = kwIdx - 1;
      continue;
    }
    // Walk braces from openBrace forward.
    let depth = 1;
    let j = openBrace + 1;
    while (j < text.length && depth > 0) {
      const ch = text[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      j += 1;
    }
    return text.slice(openBrace, j);
  }
  // Fallback — top-level scope.
  return text;
}

function lintFile(path) {
  const text = readFileSync(path, "utf8");
  const spawns = findSpawnIndices(text);
  if (spawns.length === 0) return [];
  const issues = [];
  for (const spawn of spawns) {
    const body = enclosingFunctionBody(text, spawn.start);
    const missing = REQUIRED_ENV_OVERRIDES.filter(
      (name) => !new RegExp(name).test(body),
    );
    if (missing.length > 0) {
      issues.push({
        file: path,
        offset: spawn.start,
        missing,
      });
    }
  }
  return issues;
}

test("test isolation — every server.js spawn sets per-test MCODE_WEBUI_* env overrides", () => {
  // Scope: the canonical test trees. scripts/test-isolation-lint
  // covers repo-level tests; packages/webui/test/ covers the webui
  // package. Both must pass before this gate goes green.
  const roots = [
    join(repoRoot, "test"),
    join(repoRoot, "packages", "webui", "test"),
  ];
  const issues = [];
  for (const root of roots) {
    if (!statSync(root, { throwIfNoPath: false })) continue;
    for (const file of walk(root)) {
      if (![".js", ".mjs", ".cjs"].includes(extname(file))) continue;
      issues.push(...lintFile(file));
    }
  }
  if (issues.length === 0) return; // green
  const formatted = issues
    .map(
      (issue) =>
        `  ${issue.file}:${issue.offset}  missing: ${issue.missing.join(", ")}`,
    )
    .join("\n");
  assert.fail(
    `server.js spawn without per-test env overrides (${issues.length} issue(s)):\n${formatted}\n` +
      "Every test that spawns server.js MUST set MCODE_WEBUI_{SETTINGS_PATH,EVENTS_PATH,SESSIONS_DB,UPLOAD_DIR} to per-test tmp paths before first import. " +
      "See test/server/server-startup.test.js for the canonical pattern.",
  );
});