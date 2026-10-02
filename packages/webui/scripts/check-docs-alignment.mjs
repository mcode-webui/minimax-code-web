// webui/scripts/check-docs-alignment.mjs
// CI gate for mcode-webui v2 — lease B05.
//
// Asserts the three "single-source-of-truth" relationships between
// the manifest (`package.json`), the documentation set
// (`README.md` + `docs/API.md` + `docs/CAPABILITIES.md` +
// `docs/CAPABILITIES.zh-CN.md`), the security disclosure
// (`references/SECURITY-NOTES.md`), the architecture document pair
// (`docs/ARCHITECTURE.md` + `docs/ARCHITECTURE.zh-CN.md`), and the
// server code (`server/router.js`, `server/lib/config.js`).
//
// Each check prints a one-line PASS or a list of mismatches with the
// file path + missing identifier. Exits 0 when everything is aligned,
// 1 when at least one mismatch was found, 2 when the script itself
// fails to load its inputs (missing file, malformed JSON, etc.).
//
// Usage:
//   node scripts/check-docs-alignment.mjs
//   npm run check
//
// No external deps — Node 22+ stdlib only.

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// -----------------------------------------------------------------------
// Tiny helpers
// -----------------------------------------------------------------------

const TAG = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function read(rel) {
  try {
    return readFileSync(resolve(ROOT, rel), "utf8");
  } catch (e) {
    console.error(`${TAG.red("ERROR")} cannot read ${rel}: ${e.message}`);
    process.exit(2);
  }
}

function parseJson(rel) {
  const raw = read(rel);
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`${TAG.red("ERROR")} ${rel} is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

// Does `path` resolve somewhere in `routerSrc` or `appSrc`?
//
// router.js uses two patterns:
//   1. literal matchers: `match: (p) => p === "/api/foo"`
//   2. dynamic prefix matchers: `match: (p) => p.startsWith("/api/sessions/") && p.length > ...`
//
// server/app.js (the Hono layer) uses `app.get("/api/foo", ...)` /
// `app.post(...)` / `app.delete(...)` with the path as a string literal
// in the first argument. The Hono-owned routes live in `OWNED_ROUTES`
// and are not in router.js's ROUTES table, so a docs endpoint that
// migrated across must still be findable here.
//
// `:id`-style placeholders in the docs (e.g. `/api/sessions/:id`) need
// to be normalized to their prefix before lookup so that they match
// the dynamic case.
function pathMatches(path, routerSrc, appSrc) {
  const sources = [routerSrc];
  if (appSrc) sources.push(appSrc);
  for (const src of sources) {
    if (src.includes(path)) return true;
  }
  // `:id`-style placeholders — strip the parameter and look for a
  // startsWith(prefix + "/") guard. This is what router.js does for
  // `DELETE /api/sessions/:id`. Hono takes the literal `:id` so we
  // don't need a special case there.
  const colonMatch = path.match(/^(.*)\/:[A-Za-z_][A-Za-z0-9_]*$/);
  if (colonMatch) {
    const prefix = colonMatch[1];
    for (const src of sources) {
      if (src.includes(`p.startsWith("${prefix}/"`)) return true;
      if (src.includes(`p.startsWith('${prefix}/'`)) return true;
    }
  }
  return false;
}

// Is this (method, path) registered somewhere — either the legacy
// dispatcher (`routerSrc`) or the Hono layer (`appSrc`)?
//
// The legacy dispatcher stores routes as `{ method: "GET", match: ... }`
// entries; the Hono layer wires them as `app.get(path, ...)` calls.
// Either representation counts as "registered", and the docs only need
// the path to be reachable by *some* layer.
function isRegistered(method, path, routerSrc, appSrc) {
  const routerMethod = new RegExp(`\\bmethod:\\s*["']${method}["']`).test(routerSrc);
  if (routerMethod && pathMatches(path, routerSrc, null)) return true;
  if (!appSrc) return false;
  const verb = method.toLowerCase();
  const callRegex = new RegExp(`\\bapp\\.${verb}\\(\\s*["']${escapeRegex(path)}["']`);
  if (callRegex.test(appSrc)) return true;
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const mismatches = [];
function check(label, ok, details) {
  if (ok) {
    console.log(`  ${TAG.green("✓")} ${label}`);
    return true;
  }
  console.log(`  ${TAG.red("✗")} ${label}`);
  for (const d of details || []) console.log(`      ${TAG.red("-")} ${d}`);
  mismatches.push({ label, details: details || [] });
  return false;
}

// -----------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------

const pkgJson = parseJson("package.json");
const readme = read("README.md");
const apiDoc = read("docs/API.md");
const capabilitiesDoc = read("docs/CAPABILITIES.md");
const capabilitiesZhDoc = read("docs/CAPABILITIES.zh-CN.md");
const securityDoc = read("references/SECURITY-NOTES.md");
const routerSrc = read("server/router.js");
const appSrc = read("server/app.js");
const configSrc = read("server/lib/config.js");

// -----------------------------------------------------------------------
// Check 1: every package.json capability is mentioned in README.md and
//          in docs/CAPABILITIES.md at least once, and the hand-written
//          docs/CAPABILITIES.zh-CN.md mirror stays aligned with the
//          English document (ticket 51 F3).
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[1/7]")} package.json → README.md + docs/CAPABILITIES.md; zh-CN mirror alignment`);

// Ordered `## N. ` heading numbers of a CAPABILITIES document.
function sectionNumbers(doc) {
  return [...doc.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
}

// Number of capability rows (`| `name` | §N … |`) in the §0 index
// table. Returns -1 when the document has no `## 0.` section.
function indexRowCount(doc) {
  const m = doc.match(/^## 0\. [^\n]*\n([\s\S]*?)(?=^## )/m);
  if (!m) return -1;
  return [...m[1].matchAll(/^\| `[^`]+` \|/gm)].length;
}

const caps = (pkgJson.mcodeWebui?.capabilities ?? [])
  .map((c) => (typeof c === "string" ? c : c.name))
  .filter(Boolean);

if (caps.length === 0) {
  check(
    "package.json capabilities list is non-empty",
    false,
    ["package.json has zero capabilities; manifest is invalid"],
  );
}

for (const cap of caps) {
  const inReadme = readme.includes(cap);
  const inCapabilities = capabilitiesDoc.includes(cap);
  check(
    `capability "${cap}" appears in README.md`,
    inReadme,
    [`README.md does not mention the capability "${cap}"`],
  );
  check(
    `capability "${cap}" appears in docs/CAPABILITIES.md`,
    inCapabilities,
    [`docs/CAPABILITIES.md does not mention the capability "${cap}"`],
  );
}

// The zh-CN document is hand-maintained, so a renumber or an index
// addition that lands on one side only used to pass this gate
// silently. Assert both mirrors stay in lock-step (ticket 51 F3).
const enSections = sectionNumbers(capabilitiesDoc);
const zhSections = sectionNumbers(capabilitiesZhDoc);
const sectionsAligned =
  enSections.length === zhSections.length &&
  enSections.every((n, i) => n === zhSections[i]);
check(
  "docs/CAPABILITIES.zh-CN.md section numbering matches docs/CAPABILITIES.md",
  sectionsAligned,
  [
    `English headings are numbered [${enSections.join(", ")}] but zh-CN headings are numbered [${zhSections.join(", ")}]`,
  ],
);

const enIndexRows = indexRowCount(capabilitiesDoc);
const zhIndexRows = indexRowCount(capabilitiesZhDoc);
check(
  "docs/CAPABILITIES.zh-CN.md §0 index row count matches docs/CAPABILITIES.md",
  enIndexRows > 0 && enIndexRows === zhIndexRows,
  [
    `English §0 index has ${enIndexRows} capability rows but zh-CN §0 index has ${zhIndexRows} — a capability row is missing on one side`,
  ],
);

// -----------------------------------------------------------------------
// Check 2: every README.md endpoint reference resolves in server/router.js.
//
// We extract `\`\`METHOD /api/path\`\``-style references from README. The
// "Configuration" / "Endpoints" sections of README point to docs/API.md
// for the canonical list; we only assert on what README itself mentions.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[2/7]")} README.md endpoint mentions → server/router.js`);
const readmeEndpoints = [
  ...readme.matchAll(/`(GET|POST|DELETE|PUT|PATCH)\s+(\/api\/[A-Za-z0-9_\-\/:.]+)`/g),
].map((m) => ({ method: m[1], path: m[2].split("?")[0] }));

if (readmeEndpoints.length === 0) {
  console.log(`  ${TAG.dim("(no inline endpoint references found — skip)")}`);
}

for (const { method, path } of readmeEndpoints) {
  const ok = isRegistered(method, path, routerSrc, appSrc);
  check(
    `README endpoint ${method} ${path} is registered (router or Hono)`,
    ok,
    [
      !ok
        ? `server/router.js has no route entry with method "${method}" and server/app.js has no app.${method.toLowerCase()}("${path}") call`
        : null,
    ].filter(Boolean),
  );
}

// -----------------------------------------------------------------------
// Check 3: every endpoint documented in docs/API.md resolves in
//          server/router.js.
//
// API.md uses the form `### \`METHOD /api/path\`` for each entry; we
// scan those and assert each (method, path) is wired up in router.js.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[3/7]")} docs/API.md endpoints → server/router.js`);
const apiEndpoints = [
  ...apiDoc.matchAll(/### `((?:GET|POST|DELETE|PUT|PATCH)(?:\s*\|\s*(?:GET|POST|DELETE|PUT|PATCH))*) (\/api\/[^`?]+)/g),
].map((m) => {
  const methods = m[1].split("|").map((s) => s.trim());
  const path = m[2].trim();
  return { methods, path };
});

// Also pick up the loose combined headings like
//   ### `GET /api/usage` and `POST /api/usage` and `POST /api/usage-trigger`
// which the regex above will only catch the first verb for; we add a
// fallback pass to handle the "and" form.
const apiEndpointsCombined = [
  ...apiDoc.matchAll(
    /### `((?:GET|POST|DELETE|PUT|PATCH)(?:\/api\/[^`]+` and `)?(?:GET|POST|DELETE|PUT|PATCH)?(?:\/api\/[^`]+`)?(?: and `(?:GET|POST|DELETE|PUT|PATCH) \/api\/[^`]+`)*)/g,
  ),
].map(() => null); // signal — handled below by a smarter extractor

// Helper: every path literal that appears inside a `### \`...\`` heading.
const headingEndpoints = [];
for (const m of apiDoc.matchAll(/^### `([^`]+)`/gm)) {
  const inner = m[1];
  // Split on " and " / "|" — API.md mixes both styles.
  const parts = inner.split(/\s+and\s+|\s*\|\s*/);
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) continue;
    const mm = part.match(
      /^(GET|POST|DELETE|PUT|PATCH)\s+(\/api\/[A-Za-z0-9_\-\/:.]+)/,
    );
    if (mm) headingEndpoints.push({ method: mm[1], path: mm[2] });
  }
}

if (headingEndpoints.length === 0) {
  check(
    "docs/API.md has at least one ### `METHOD /api/...` heading",
    false,
    ["no endpoint headings found — the docs may be malformed"],
  );
}

for (const { method, path } of headingEndpoints) {
  // Collapse `?query` for matching — router matchers strip the query.
  const basePath = path.split("?")[0];
  const ok = isRegistered(method, basePath, routerSrc, appSrc);
  check(
    `docs/API.md endpoint ${method} ${basePath} is registered (router or Hono)`,
    ok,
    [
      !ok
        ? `server/router.js has no route entry with method "${method}" and server/app.js has no app.${method.toLowerCase()}("${basePath}") call`
        : null,
    ].filter(Boolean),
  );
}

// -----------------------------------------------------------------------
// Check 4: every env var mentioned in references/SECURITY-NOTES.md is
//          exported by server/lib/config.js.
//
// SECURITY-NOTES is the canonical disclosure; it lists the env vars
// the plugin reads. If it mentions one that config.js doesn't export,
// the docs are lying about what the plugin actually does.
// -----------------------------------------------------------------------

// Known env vars documented in SECURITY-NOTES.md (and the README /
// API.md). Keep this list explicit — heuristics over the prose are
// fragile and we'd rather under-report than over-report.
const KNOWN_ENV_VARS = new Set([
  "TOKEN",
  "HOST",
  "PORT",
  "MCODE_CMD",
  "MCODE_MODEL",
  "MCODE_WORKSPACE",
  "MCODE_TIMEOUT",
  "MCODE_MAX_STEPS",
  "MCODE_MAX_CONCURRENT",
  "MCODE_RUNTIME_DB",
  "MCODE_WEBUI_UPLOAD_DIR",
  "MCODE_WEBUI_SETTINGS_PATH",
  "MCODE_WEBUI_SESSIONS_DB",
  "MCODE_BETTER_SQLITE3",
  "MAVIS_DATA_DIR",
  "SQLITE3_BIN",
  "DEBUG_INJECT",
]);

console.log(`${TAG.dim("[4/7]")} references/SECURITY-NOTES.md env vars → server/lib/config.js`);
// Env-var tokens in SECURITY-NOTES are mostly `TOKEN`, `HOST`, `PORT`,
// `MCODE_RUNTIME_DB`, `MCODE_WEBUI_UPLOAD_DIR`, `MCODE_WEBUI_SETTINGS_PATH`,
// `MAVIS_DATA_DIR`, `MCODE_MODEL`, `MCODE_CMD`, `MCODE_WORKSPACE`,
// `MCODE_BETTER_SQLITE3`, `DEBUG_INJECT`, `MCODE_TIMEOUT`,
// `MCODE_MAX_STEPS`, `MCODE_MAX_CONCURRENT`, `SQLITE3_BIN`.
// Match any SCREAMING_SNAKE_CASE identifier of length ≥ 4 that isn't
// part of a code-fence block.
const envVarPattern = /\b([A-Z][A-Z0-9_]{3,})\b/g;
const envVars = new Set();
for (const m of securityDoc.matchAll(envVarPattern)) {
  // Skip obvious non-env matches: `MIT`, `URL`, `JSON`, `JSONRPC`,
  // `BOM`, `UTF`, `SQL`, `API`, `HTTP`, `SSE`, `POST`, `GET`,
  // `DELETE`, `OPTIONS`, `LAN`, `UI`, `JS`, `CSS`, `HTML`, `OS`,
  // `Node`, `URL`. We only care about vars we know the plugin reads.
  const v = m[1];
  if (KNOWN_ENV_VARS.has(v)) envVars.add(v);
}

for (const v of envVars) {
  // config.js exports the variable as either `export const FOO` or
  // `export const FOO_BAR`. Accept either.
  const exported = new RegExp(
    `export\\s+const\\s+${v}\\b`,
  ).test(configSrc);
  check(
    `SECURITY-NOTES env var "${v}" is exported by server/lib/config.js`,
    exported,
    [`server/lib/config.js has no \`export const ${v}\``],
  );
}

if (envVars.size === 0) {
  console.log(`  ${TAG.dim("(no env vars detected in SECURITY-NOTES.md — skip)")}`);
}

// -----------------------------------------------------------------------
// Check 5: package.json round-trip parse + capability shape.
// (We re-parse package.json — a cheap belt-and-braces assertion that the
// manifest is JSON-clean. Already done implicitly by parseJson() above.)
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[5/7]")} package.json round-trip parse + capability shape`);
const capsObjects = pkgJson.mcodeWebui?.capabilities ?? [];
check(
  "package.json round-trip JSON parse",
  true,
  [],
);
check(
  "every package.json capability is an object with name + description",
  capsObjects.length > 0 &&
    capsObjects.every(
      (c) =>
        typeof c === "object" &&
        typeof c.name === "string" &&
        c.name.length > 0 &&
        typeof c.description === "string" &&
        c.description.length >= 30,
    ),
  capsObjects.length === 0
    ? ["no capabilities defined"]
    : capsObjects
        .filter(
          (c) =>
            !c ||
            typeof c.name !== "string" ||
            c.name.length === 0 ||
            typeof c.description !== "string" ||
            c.description.length < 30,
        )
        .map(
          (c) =>
            `capability ${JSON.stringify(c)} missing name or has description < 30 chars`,
        ),
);

// -----------------------------------------------------------------------
// Check 6: known drift — assert
//          there is no `cleanup-orphans` endpoint in docs/API.md that
//          is missing from a registered location (or vice-versa).
//
// This is the specific drift the anti-pattern doc calls out; the
// check makes it mechanical so future PRs can't reintroduce the same
// bug silently.
//
// As of the Hono-layer migration, the endpoint can live in either
// `server/router.js` (legacy ROUTES table) or `server/app.js`
// (Hono `OWNED_ROUTES` set). Either side satisfies the anti-pattern.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[6/7]")} known drift: cleanup-orphans endpoint consistency`);
const apiHasCleanup = apiDoc.includes("cleanup-orphans");
// Legacy: `{ method: "POST", match: ... cleanup-orphans ... }` style.
// Hono: a literal `"POST /api/sessions/cleanup-orphans"` in OWNED_ROUTES.
const routerHasCleanup = /method:\s*["'](?:GET|POST|DELETE)["'][^}]*cleanup-orphans/.test(
  routerSrc,
);
const honoHasCleanup = /["']POST \/api\/sessions\/cleanup-orphans["']/.test(appSrc);
const registeredAnywhere = routerHasCleanup || honoHasCleanup;
if (apiHasCleanup && !registeredAnywhere) {
  check(
    "docs/API.md does NOT document a missing endpoint (cleanup-orphans)",
    false,
    [
      "docs/API.md mentions POST /api/sessions/cleanup-orphans but no layer registers it (router.js or app.js OWNED_ROUTES)",
      "Either delete the docs/API.md entry or add the route (see docs/ANTI-PATTERNS-FIX-PLAN.md §AP11)",
    ],
  );
} else if (!apiHasCleanup && registeredAnywhere) {
  check(
    "server/router.js / server/app.js do NOT expose an undocumented endpoint (cleanup-orphans)",
    false,
    [
      "cleanup-orphans is registered in a layer but not documented in docs/API.md",
      "Either remove the registration or add the docs/API.md entry",
    ],
  );
} else {
  check(
    "cleanup-orphans endpoint is consistent between docs/API.md and the registered layers",
    true,
    [],
  );
}

// -----------------------------------------------------------------------
// Check 7: every `file#symbol` and bare-path citation in
//          docs/ARCHITECTURE.md + docs/ARCHITECTURE.zh-CN.md resolves.
//
// Ticket 95 measured a 24% distortion rate on this document's
// symbol→file citations (12 of 50 wrong, spread across all four
// failure classes: wrong file, removed symbol, removed file, ambiguous
// phrasing). Both reported cites were *plausible* — a reader greps,
// lands on a real file, and reads the wrong code. A citation gate is
// the only thing that catches that before review does.
//
// Three mechanical sub-checks, because each catches a different class:
//   7a  a bare `path.ext` cited in either document exists on disk
//       (catches "the file was deleted" — e.g. the old `render.js`)
//   7b  a `file.ext#symbol` cite resolves AND that file *defines* the
//       symbol, with import lines stripped so "X imports it" does not
//       count as "X defines it" (catches the reported bug:
//       `getCachedMcodeCommands()` cited as "(in `state-bus.js`)"
//       when acp-client.js is the defining module)
//   7c  both language mirrors cite the same file#symbol pairs, so a
//       correction cannot land on one side only
//
// What this does NOT cover, stated plainly so nobody over-trusts it:
// a symbol named in prose with no file binding ("Both expose
// `stopExec()`") is invisible to a path-driven gate. Those still need
// a human, or a bespoke assertion for that specific symbol.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[7/7]")} docs/ARCHITECTURE*.md symbol→file citations`);

const REPO_ROOT = resolve(ROOT, "..", "..");
const archDoc = read("docs/ARCHITECTURE.md");
const archZhDoc = read("docs/ARCHITECTURE.zh-CN.md");

// Paths a source checkout legitimately has no copy of. Keep this short
// and justified — every entry is a path whose absence is correct.
const NOT_ON_DISK = new Set([
  "dist/webui/server.js", // build output; produced by scripts/build.mjs
  "server/routes/foo.js", // the illustrative path in §9's recipe
  "sessions.json", // runtime data under WEBUI_DATA_DIR, not a source file
  "mcp.json", // user-authored MCP server config, not a source file
  "models.json", // operator-authored provider catalogue (cwd layer), not a source file
  "config.yaml", // the ENGINE's own config under its data dir, not a source file
  "index.html", // Next export output (webapp/out/index.html), not a source file
]);

// Filename-shaped tokens that are not citations of a file in this repo.
const NOT_A_CITATION = new Set([
  "Next.js", // "Next.js 14.2.35" — a framework version
]);

// A doc citation is relative to one of these roots, tried in order. The
// architecture doc is written from several vantages at once — "config.js"
// is a lib module, "app/page.tsx" sits under webapp/ — so a single root
// would produce false failures.
const PATH_ROOTS = [
  ROOT,
  resolve(ROOT, "webapp"),
  resolve(ROOT, "webapp", "app"),
  resolve(ROOT, "webapp", "components"),
  resolve(ROOT, "webapp", "lib"),
  resolve(ROOT, "webapp", "public"),
  resolve(ROOT, "webapp", "styles"),
  resolve(ROOT, "server"),
  resolve(ROOT, "server", "lib"),
  resolve(ROOT, "server", "routes"),
  resolve(ROOT, "server", "trajectory"),
  resolve(ROOT, "docs"),
  resolve(ROOT, "public"),
  resolve(ROOT, "public", "trajectory", "js"),
  REPO_ROOT,
  resolve(REPO_ROOT, "scripts"),
];

// File extensions a citation may carry. Extensionless tokens
// (`agent-modules/skills`) and directory-ish tokens (`out/`) are
// deliberately out of scope.
const CITE_EXT = "(?:js|mjs|cjs|ts|tsx|css|html|json|md|yml|yaml)";

function resolveDocPath(docPath) {
  for (const base of PATH_ROOTS) {
    const abs = resolve(base, docPath);
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  }
  return null;
}

// `mcode-{acp,exec}.js#finalize` → ["mcode-acp.js#finalize",
// "mcode-exec.js#finalize"]. Brace alternation is the only expansion the
// documents use.
function expandBraces(token) {
  const m = token.match(/^([^{}]*)\{([^{}]*)\}([^{}]*)$/);
  if (!m) return [token];
  return m[2]
    .split(",")
    .flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`));
}

// Capture group 1 of every `re` match in `doc`, brace alternation expanded.
// `matchAll`, not `match` — a global `String.match` yields full-match
// STRINGS, so `m[1]` would index a character rather than a group.
function expandAll(doc, re) {
  return [...doc.matchAll(re)].flatMap((m) => expandBraces(m[1]));
}

// Does `fileAbs` *define* `symbol`? Import lines are stripped first: a
// module that imports a symbol obviously mentions it, and accepting
// that would let the very bug this check exists for pass silently.
function definesSymbol(fileAbs, symbol) {
  let src;
  try {
    src = readFileSync(fileAbs, "utf8");
  } catch {
    return false;
  }
  const body = src
    .split("\n")
    .filter(
      (line) =>
        !/^\s*import\b/.test(line) && !/^\s*export\b.*\bfrom\b/.test(line),
    )
    .join("\n");
  const esc = escapeRegex(symbol);
  return new RegExp(
    [
      `(?:^|[\\s;{(=])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\*?\\s+${esc}\\b`,
      `(?:export\\s+)?(?:const|let|var|class|type|interface|enum)\\s+${esc}\\b`,
      `export\\s*(?:type\\s*)?\\{[^}]*\\b${esc}\\b[^}]*\\}`,
    ].join("|"),
  ).test(body);
}

// A path citation, matched ANYWHERE in the document — not only inside
// backticks. The reported drift included a path written bare inside a
// mermaid participant label (`participant B as Browser render.js`), which
// a backtick-scoped pattern walks straight past.
const BARE_RE = new RegExp(
  "(?:^|[^\\w./@-])([\\w][\\w./@-]*\\.(?:" + CITE_EXT + "))(?![\\w])",
  "g",
);
// `file.ext#symbol` — the compact cite form.
const HASH_RE = new RegExp(
  "`([^`\\s]+\\.(?:" + CITE_EXT + "))#([A-Za-z_$][\\w$]*)`",
  "g",
);
// `symbol()` (in `file.ext`) and the Chinese equivalents
// `symbol()`（位于 `file.ext`） / （在 `file.ext` 中） — the parenthetical
// cite form. This is the shape the reported `getCachedMcodeCommands()`
// defect actually used, so a gate that ignores it guards nothing.
//
// The paren class accepts half- and full-width forms; the zh-CN mirror
// writes （）, and a gate that only understood the ASCII pair would pass
// the Chinese document by never matching anything in it.
const PAREN_RE = new RegExp(
  "`([A-Za-z_$][\\w$]*)\\(\\)?`[^\\n]{0,24}?[(\\uFF08](?:in|位于|在)\\s+`" +
    "([^`\\s]+\\.(?:" + CITE_EXT + "))`",
  "g",
);

const barePaths = new Map(); // token → [doc names]
const hashCites = new Map(); // "file#symbol" → [doc names]

function note(map, key, docName) {
  if (!map.has(key)) map.set(key, []);
  const list = map.get(key);
  if (!list.includes(docName)) list.push(docName);
}

for (const [name, doc] of [
  ["ARCHITECTURE.md", archDoc],
  ["ARCHITECTURE.zh-CN.md", archZhDoc],
]) {
  for (const token of expandAll(doc, BARE_RE)) {
    if (token.includes("*") || NOT_ON_DISK.has(token)) continue;
    // A product name that merely looks like a filename. `Next.js 14.2.35`
    // is a version, not a citation — keep this list explicit and justified.
    if (NOT_A_CITATION.has(token)) continue;
    // A route table entry or a URL fragment is not a file citation.
    if (token.startsWith("/") || token.startsWith("http")) continue;
    note(barePaths, token, name);
  }
  // The parenthetical form names its symbol in a separate backtick span,
  // so record it as a `file#symbol` pair and reuse the same verdict path.
  for (const m of doc.matchAll(PAREN_RE)) {
    for (const file of expandBraces(m[2])) {
      note(hashCites, `${file}#${m[1]}`, name);
    }
  }
  // Brace alternation can sit in the file half (`mcode-{acp,exec}.js#x`),
  // so expand per match rather than over a pre-flattened token list.
  for (const m of doc.matchAll(HASH_RE)) {
    for (const file of expandBraces(m[1])) {
      note(hashCites, `${file}#${m[2]}`, name);
    }
  }
}

if (barePaths.size === 0 && hashCites.size === 0) {
  check(
    "docs/ARCHITECTURE.md contains file citations to verify",
    false,
    ["no path or file#symbol citation was extracted — the extractor regex probably broke"],
  );
}

for (const [token, docs] of [...barePaths].sort()) {
  check(
    `${docs.join(" + ")}: cited path \`${token}\` exists`,
    resolveDocPath(token) !== null,
    [
      `\`${token}\` is cited in ${docs.join(" and ")} but no file with that name exists under packages/webui/ or the repo root.`,
      "If it was removed, delete the citation or state what replaced it; if it is build output, add it to NOT_ON_DISK with a reason.",
    ],
  );
}

for (const [token, docs] of [...hashCites].sort()) {
  const hashAt = token.indexOf("#");
  const file = token.slice(0, hashAt);
  const symbol = token.slice(hashAt + 1);
  const abs = resolveDocPath(file);
  if (abs === null) {
    check(`${docs.join(" + ")}: cited path \`${file}\` exists`, false, [
      `\`${file}#${symbol}\` is cited in ${docs.join(" and ")} but \`${file}\` does not exist.`,
    ]);
    continue;
  }
  check(
    `${docs.join(" + ")}: \`${file}\` defines \`${symbol}\``,
    definesSymbol(abs, symbol),
    [
      `\`${symbol}\` is cited in ${docs.join(" and ")} as living in \`${file}\`, but that file does not define it.`,
      `It may have moved (locate it with: grep -rn "${symbol}" packages/webui) or the file may only import it — say which.`,
    ],
  );
}

const citeSet = (doc) =>
  new Set(
    [...doc.matchAll(HASH_RE)].flatMap((m) =>
      expandBraces(m[1]).map((f) => `${f}#${m[2]}`),
    ),
  );

const enCites = citeSet(archDoc);
const zhCites = citeSet(archZhDoc);
const onlyEn = [...enCites].filter((c) => !zhCites.has(c));
const onlyZh = [...zhCites].filter((c) => !enCites.has(c));
check(
  "docs/ARCHITECTURE.md and .zh-CN.md cite the same file#symbol pairs",
  onlyEn.length === 0 && onlyZh.length === 0,
  [
    ...onlyEn.map((c) => `cited only in ARCHITECTURE.md: ${c}`),
    ...onlyZh.map((c) => `cited only in ARCHITECTURE.zh-CN.md: ${c}`),
    "Both documents are hand-maintained at equal weight; a correction must land on both sides.",
  ],
);

// -----------------------------------------------------------------------
// Summary + exit code
// -----------------------------------------------------------------------

console.log("");
if (mismatches.length === 0) {
  console.log(`${TAG.green("OK")} all checks passed.`);
  process.exit(0);
} else {
  console.log(
    `${TAG.red("FAIL")} ${mismatches.length} check group(s) reported mismatches.`,
  );
  process.exit(1);
}