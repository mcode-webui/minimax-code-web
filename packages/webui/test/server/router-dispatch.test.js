// webui/test/server/router-dispatch.test.js
// Static source assertions for the route-dispatch loop in
// server/router.js — the two CodeQL fixes from the webui-rigor-fix
// batch (S2 cluster):
//
//   1. js/regex-injection (router.js:437): `route.match(pathname)` is
//      name-modeled by CodeQL as String.prototype.match(pattern) with
//      the tainted pathname in the pattern slot. In reality every
//      ROUTES matcher is a static predicate (=== / startsWith /
//      includes / one precompiled regex literal .test(p)); pathname is
//      only ever the *subject*. The fix calls the predicate through a
//      hoisted local, which removes the name-based sink without
//      touching any matcher.
//   2. js/tainted-format-string (router.js:444): the router's error
//      log used a template literal that mixes the tainted pathname
//      into the format string; it now uses printf placeholders in a
//      constant string with the tainted values in argument position.
//
// Style follows test/server/router-cors.test.js: read the source and
// assert mechanically. No server is spawned; we assert on the code
// shape so a regression (someone inlining `route.match(pathname)`
// back, or re-interpolating the error log) fails the suite.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const routerPath = join(__dirname, "..", "..", "server", "router.js");
const routerSource = readFileSync(routerPath, "utf8");
// Routes that have moved to the Hono layer (`server/app.js`, OWNED_ROUTES)
// are wired as `app.<verb>("<path>", ...)` calls there. The matcher-table
// pins split accordingly: legacy routes stay on `routerSource`; migrated
// routes are checked against `appSource` so neither side drifts.
const appPath = join(__dirname, "..", "..", "server", "app.js");
const appSource = readFileSync(appPath, "utf8");

describe("router — dispatch loop shape (CodeQL rigor fixes)", () => {
  test("no `.match(pathname)` property call with tainted pathname", () => {
    assert.doesNotMatch(
      routerSource,
      /\.match\(\s*pathname\s*\)/,
      "the dispatch loop must not call `route.match(pathname)` — CodeQL models any `.match(x)` call as a regex sink with x in the pattern slot",
    );
  });

  test("dispatch calls the route predicate through a hoisted local", () => {
    assert.match(
      routerSource,
      /const\s+matchesPath\s*=\s*route\.match\s*;\s*\n\s*if\s*\(\s*!matchesPath\(pathname\)\s*\)\s*continue;/,
      "dispatch loop should hoist `route.match` into a local and call it with pathname as the subject only",
    );
  });

  test("error log uses printf placeholders in a constant format string", () => {
    assert.match(
      routerSource,
      /console\.error\(\s*"\[router\] %s %s threw:",\s*req\.method,\s*pathname,\s*e\s*\)/,
      "router error log must keep the format string constant and pass req.method/pathname/e as arguments",
    );
    assert.doesNotMatch(
      routerSource,
      /console\.error\(\s*`\[router\][^`]*\$\{/,
      "router error log must not interpolate tainted values into a template-literal format string",
    );
  });
});

describe("router — matcher table semantics unchanged", () => {
  // These pins guard the "no semantic change" claim of the dispatch fix:
  // the matcher bodies themselves stay in their literal forms, which is
  // also what scripts/check-docs-alignment.mjs pathMatches() resolves
  // against (literal substring + `p.startsWith("prefix/"` guards).
  //
  // Migrated routes live in `server/app.js` as `app.<verb>(path, ...)`
  // calls instead of `p === "<path>"` predicates; we check the literal
  // is still present in whichever file owns the route today.
  test("exact-match literals survive (representative sample)", () => {
    // Legacy dispatcher still owns the two SSE channels (every other /api/*
    // route has moved to Hono). A spot-check on each side catches the
    // obvious drift: chat/usage/etc. should NOT appear in router.js anymore.
    assert.match(routerSource, /p === "\/api\/events"/, "events SSE stays on legacy");
    assert.match(routerSource, /p === "\/api\/alerts"/, "alerts SSE stays on legacy");
    // Hono layer now owns these too (regression guard for P1 batch 1).
    assert.match(appSource, /app\.get\(\s*"\/api\/health"/);
    assert.match(appSource, /app\.get\(\s*"\/api\/sessions\/search"/);
    // Newly-migrated routes live only in Hono, not the legacy table.
    assert.doesNotMatch(
      routerSource,
      /p === "\/api\/send"/,
      "POST /api/send must have moved to Hono",
    );
    assert.doesNotMatch(
      routerSource,
      /p === "\/api\/upload"/,
      "POST /api/upload must have moved to Hono",
    );
    assert.match(
      appSource,
      /app\.post\(\s*"\/api\/upload"/,
      "POST /api/upload must be registered in Hono",
    );
  });

  test("parameterised routes live in the Hono layer (DELETE :id, GET :id/export)", () => {
    // Legacy `p.startsWith(...) + p.length > prefix.length` predicate and
    // the `^\\/api\\/sessions\\/[^\\/]+\\/export$` regex have both moved
    // into Hono's `:id` route declarations. The pin lives against the
    // Hono app source now.
    assert.match(
      appSource,
      /app\.delete\(\s*"\/api\/sessions\/:id"/,
      "DELETE /api/sessions/:id must be wired through Hono",
    );
    assert.match(
      appSource,
      /app\.get\(\s*"\/api\/sessions\/:id\/export"/,
      "GET /api/sessions/:id/export must be wired through Hono",
    );
    // The corresponding legacy matchers should be gone from router.js,
    // not silently duplicated.
    assert.doesNotMatch(
      routerSource,
      /p\.startsWith\("\/api\/sessions\/"\)/,
      "DELETE /api/sessions catch-all prefix matcher must not be in router.js anymore",
    );
    assert.doesNotMatch(
      routerSource,
      /\^\\\/api\\\/sessions\\\/\[\^\\\/\]\+\\\/export\$/,
      "GET /api/sessions/:id/export regex literal must not be in router.js anymore",
    );
  });
});
