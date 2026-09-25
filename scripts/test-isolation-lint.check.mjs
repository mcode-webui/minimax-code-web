// scripts/test-isolation-lint.check.mjs
//
// Session-isolation/05 lint: every test that SPAWNS
// packages/webui/server.js as a child process MUST set the
// per-test temp-dir overrides for the data files the backend
// writes to. Without the overrides, a test can land
// `events.ndjson` / `settings.json` / `sessions.json` lines in the
// user's real state directory — the documented "test leakage"
// shape that came up in the forensic audit.
//
// The lint is intentionally cheap: it scans the test/ and
// packages/webui/test/ trees for the canonical spawn pattern
// (`spawn(... server.js ...)` or `spawnSync(... server.js ...)`),
// then checks the surrounding function for the four env overrides:
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
// Wiring: this module is exercised by the root `test:release-tools`
// gate (`node --test test/source-sync.test.mjs …`), per the repo
// convention that repository-level node:test suites stay in their
// existing gates and workflow-safety regressions land in
// test/source-sync.test.mjs. The scan roots are resolved relative
// to THIS file's location, so the gate's cwd is irrelevant — an
// earlier attempt ran these paths through packages/webui's
// test:unit runner, whose cwd made every glob match zero files
// (a gate that reported "pass 0" and never scanned anything).
// The file also stays runnable on its own for manual audits:
//   node scripts/test-isolation-lint.check.mjs
// which exits 0 on clean and 1 with a per-file listing otherwise.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Repo root is derived from this file's location (scripts/ is one
// level below the root), never from process.cwd() — see the wiring
// note above.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export const REQUIRED_ENV_OVERRIDES = [
  "MCODE_WEBUI_SETTINGS_PATH",
  "MCODE_WEBUI_EVENTS_PATH",
  "MCODE_WEBUI_SESSIONS_DB",
  "MCODE_WEBUI_UPLOAD_DIR",
];

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

/**
 * Strip line comments (double slash) and block comments (slash-star …
 * star-slash) from JS source, tracking string literals so comment
 * markers inside strings (URLs, regexes-as-text) survive. Spawn shapes
 * written in comments must not produce phantom matches —
 * source-sync.test.mjs documents the fixture shape in prose and would
 * otherwise trip the real-tree scan.
 */
function stripComments(text) {
  let out = "";
  let state = "code"; // code | line | block | single | double | template
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "template";
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; out += " "; i += 2; continue; }
      if (ch === "\n") out += ch;
      i += 1;
      continue;
    }
    // Inside a string literal: copy verbatim, honoring escapes.
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (state === "single" && ch === "'") ||
      (state === "double" && ch === '"') ||
      (state === "template" && ch === "`")
    ) state = "code";
    out += ch;
    i += 1;
  }
  return out;
}

function lintFile(path) {
  const text = stripComments(readFileSync(path, "utf8"));
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

/**
 * Scan the canonical test trees for server.js spawns that lack the
 * per-test MCODE_WEBUI_* env overrides. Returns an empty array when
 * the tree is compliant; each entry otherwise describes one
 * offending spawn. `roots` defaults to the repository's real test
 * trees; test/source-sync.test.mjs passes synthetic fixture trees
 * so CI keeps proving the lint still detects violations (a lint
 * that silently matches nothing must fail the gate, not pass it).
 */
export function collectTestIsolationViolations({ roots } = {}) {
  const scanRoots = roots ?? [
    join(repoRoot, "test"),
    join(repoRoot, "packages", "webui", "test"),
  ];
  const issues = [];
  for (const root of scanRoots) {
    if (!statSync(root, { throwIfNoPath: false })) continue;
    for (const file of walk(root)) {
      if (![".js", ".mjs", ".cjs"].includes(extname(file))) continue;
      issues.push(...lintFile(file));
    }
  }
  return issues;
}

/** Human-readable per-file listing for gate output and CLI stderr. */
export function formatTestIsolationViolations(issues) {
  const formatted = issues
    .map(
      (issue) =>
        `  ${issue.file}:${issue.offset}  missing: ${issue.missing.join(", ")}`,
    )
    .join("\n");
  return (
    `server.js spawn without per-test env overrides (${issues.length} issue(s)):\n${formatted}\n` +
    "Every test that spawns server.js MUST set MCODE_WEBUI_{SETTINGS_PATH,EVENTS_PATH,SESSIONS_DB,UPLOAD_DIR} to per-test tmp paths before first import. " +
    "See packages/webui/test/server/server-startup.test.js for the canonical pattern."
  );
}

// Manual-audit entry point: `node scripts/test-isolation-lint.check.mjs`.
// Inside a node:test run this file is only imported, never executed
// as the main module, so the CLI block is inert in gates.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const issues = collectTestIsolationViolations();
  if (issues.length === 0) {
    console.log(
      "test-isolation-lint: clean — every server.js spawn sets the per-test MCODE_WEBUI_* overrides.",
    );
  } else {
    console.error(formatTestIsolationViolations(issues));
    process.exitCode = 1;
  }
}
