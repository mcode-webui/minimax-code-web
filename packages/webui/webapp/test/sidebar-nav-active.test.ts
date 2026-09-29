// webapp/test/sidebar-nav-active.test.ts
//
// Sidebar alignment regression tests (webui-parity ticket 47).
//
// Why this test exists: ticket 47 wires four behaviours whose loss would be
// silent — nav-row activation (N2), the session-row selected token (S1),
// the state-flipping rail toggle label (C2/C3), and the `?session=` deep
// link on session rows (S8) — plus three reverse-parity capabilities that
// must NOT disappear (drag-resize, narrow-viewport auto-collapse, collapsed
// persistence, C9). The suite has no DOM render harness (no jsdom by
// policy), so the decision logic runs against the exported pure functions
// and the wiring half is a static-source tripwire on the call sites, in the
// style of loading-skeleton.test.ts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { isSidebarNavActive } from "../lib/sidebar-nav";
import { sessionHref, SESSION_QUERY } from "../lib/url-restore";
import { translate } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(resolve(here, "../components/shell.tsx"), "utf8");
const treeSource = readFileSync(resolve(here, "../components/session-tree.tsx"), "utf8");
const pageSource = readFileSync(resolve(here, "../app/page.tsx"), "utf8");
const globalsCss = readFileSync(resolve(here, "../app/globals.css"), "utf8");

// ---------------------------------------------------------------------------
// N2 — nav-row activation (pure decision logic)
// ---------------------------------------------------------------------------

describe("isSidebarNavActive", () => {
  const cases: Array<{
    label: string;
    key: Parameters<typeof isSidebarNavActive>[0];
    sessionId: string | null;
    surface: Parameters<typeof isSidebarNavActive>[2];
    expected: boolean;
  }> = [
    // Surface rows follow the tree-column signal only.
    { label: "search row lights when search surface owns the column", key: "sidebar.search", sessionId: "s1", surface: "search", expected: true },
    { label: "search row is dark while a session is open", key: "sidebar.search", sessionId: "s1", surface: null, expected: false },
    { label: "plugins row lights when plugins surface owns the column", key: "sidebar.plugins", sessionId: "s1", surface: "plugins", expected: true },
    { label: "plugins row is dark when the search surface is active", key: "sidebar.plugins", sessionId: "s1", surface: "search", expected: false },
    // The action row mirrors the reference's home-mode rule: lit only with
    // no session selected AND no sibling surface owning the screen.
    { label: "new-session row lights on the home screen", key: "topbar.newSession", sessionId: null, surface: null, expected: true },
    { label: "new-session row is dark once a session is selected", key: "topbar.newSession", sessionId: "s1", surface: null, expected: false },
    { label: "new-session row is dark while a sibling surface owns the screen", key: "topbar.newSession", sessionId: null, surface: "plugins", expected: false },
  ];

  for (const item of cases) {
    test(item.label, () => {
      assert.equal(isSidebarNavActive(item.key, item.sessionId, item.surface), item.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// S8 — session-row deep-link grammar (pure)
// ---------------------------------------------------------------------------

describe("sessionHref", () => {
  test("uses the ?session= query grammar the restore pipeline parses", () => {
    assert.equal(sessionHref("abc"), "?session=abc");
    assert.equal(SESSION_QUERY, "session");
  });

  test("encodes ids that carry URL metacharacters", () => {
    assert.equal(sessionHref("a b&c"), "?session=a%20b%26c");
  });

  test("never emits the reference's #session= fragment grammar", () => {
    assert.ok(!sessionHref("abc").includes("#"));
  });
});

// ---------------------------------------------------------------------------
// C3 — the toggle label flips with state, in both locales
// ---------------------------------------------------------------------------

describe("rail toggle labels", () => {
  test("both locales carry distinct expand/collapse strings", () => {
    for (const locale of ["zh", "en"] as const) {
      const expand = translate(locale, "sidebar.expand");
      const collapse = translate(locale, "sidebar.collapse");
      assert.ok(expand.length > 0, `sidebar.expand must exist in ${locale}`);
      assert.ok(collapse.length > 0, `sidebar.collapse must exist in ${locale}`);
      assert.notEqual(expand, collapse, `${locale} labels must differ per state`);
    }
  });

  test("both locales carry the loadError prefix for the alert state", () => {
    for (const locale of ["zh", "en"] as const) {
      assert.ok(translate(locale, "sidebar.loadError").length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring tripwires (static source)
// ---------------------------------------------------------------------------

describe("sidebar wiring", () => {
  test("N2: NavRow receives a real `active` prop at the call site", () => {
    assert.match(shellSource, /active=\{isNavActive\(entry\.key\)\}/);
    assert.match(shellSource, /isSidebarNavActive/);
  });

  test("N2: page.tsx computes and passes the tree-surface signal down", () => {
    assert.match(pageSource, /activeNavSurface: "search" \| "plugins" \| null/);
    assert.match(pageSource, /activeNavSurface=\{activeNavSurface\}/);
  });

  test("S1: the selected row uses tertiary_selected while hover keeps tertiary_hover", () => {
    // Both the session row and the subagent row carry the selected token…
    const selected = treeSource.match(/bg-bg_interaction_tertiary_selected/g) ?? [];
    assert.ok(selected.length >= 2, "session + subagent rows must use the selected token");
    // …and neither active branch may fall back to the hover fill any more.
    assert.ok(
      !/"bg-bg_interaction_tertiary_hover text-text_default_primary"/.test(treeSource),
      "the active branch must not paint with the hover token",
    );
  });

  test("S2: the section header is a plain div — no dead <button>, no arrow", () => {
    const header = treeSource.slice(
      treeSource.indexOf("function SectionHeader"),
      treeSource.indexOf("function RowAction"),
    );
    assert.ok(header.includes("data-testid=\"sidebar-section-header\""));
    assert.ok(!header.includes("<button"), "the header must not render a focusable control");
    assert.ok(header.includes("h-7"), "28px geometry (h-7)");
    assert.ok(!header.includes("chevronDown"), "no disclosure arrow");
  });

  test("S5: disclosures mount through the animated expandable wrapper", () => {
    const wrappers = treeSource.match(/<Expandable open=\{[^}]+\}>/g) ?? [];
    assert.ok(wrappers.length >= 3, "project, directory and subagent disclosures");
    assert.match(treeSource, /className=\{`webui-expandable-motion\$\{open \? " is-open" : ""\}`\}/);
    assert.match(treeSource, /toggleAttribute\("inert", !open\)/);
  });

  test("S5: globals.css carries the motion rule and its reduced-motion kill switch", () => {
    assert.match(globalsCss, /\.webui-expandable-motion\s*\{/);
    assert.match(globalsCss, /grid-template-rows:\s*1fr/);
    const reduced = globalsCss.slice(globalsCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(reduced, /\.webui-expandable-motion\s*\{\s*transition:\s*none/);
    // The open state is carried by the track, not the transition, so the
    // reduced-motion branch must not touch opacity or the grid track.
    assert.ok(!/webui-expandable-motion[^}]*opacity:\s*1/.test(reduced));
  });

  test("S3: the empty state uses the card-face class", () => {
    assert.match(treeSource, /webui-empty-state/);
    assert.match(globalsCss, /\.webui-empty-state\s*\{/);
  });

  test("S4: the error state is an alert and names the live reason", () => {
    assert.match(treeSource, /role="alert"/);
    assert.match(treeSource, /\{t\("sidebar\.loadError"\)\}\s*\{error\}/);
  });

  test("S8: session and subagent rows are <a> deep links over sessionHref", () => {
    const links = treeSource.match(/href=\{sessionHref\(session\.id\)\}/g) ?? [];
    assert.ok(links.length >= 2, "session row and subagent row");
    // Modified clicks must fall through to the browser (open-in-new-tab).
    assert.match(treeSource, /event\.metaKey/);
    assert.match(treeSource, /event\.preventDefault\(\);\s*\n\s*onOpen\(\);/);
  });

  test("C1/C5: rail is 64px, transition 180ms, background clears when collapsed", () => {
    assert.match(shellSource, /const SIDEBAR_RAIL = 64;/);
    assert.match(shellSource, /duration-\[180ms\]/);
    assert.match(shellSource, /collapsed \? "bg-transparent" : "bg-bg_default_scrim"/);
  });

  test("C2/C3: the toggle lives outside the sidebar with a state-flipping label", () => {
    assert.match(shellSource, /data-testid="sidebar-collapse-toggle"/);
    assert.match(shellSource, /collapsed \? t\("sidebar\.expand"\) : t\("sidebar\.collapse"\)/);
    assert.match(shellSource, /aria-expanded=\{!collapsed\}/);
    // The overlay itself must not eat clicks meant for the content beneath.
    assert.match(shellSource, /pointer-events-none absolute top-0/);
  });

  test("C6: the toolbar column gains the collapsed left compensation", () => {
    assert.match(shellSource, /collapsed \? "pl-\[142px\]" : undefined/);
  });

  test("C9 reverse-parity red line: resize, auto-collapse and persistence stay", () => {
    assert.match(shellSource, /SIDEBAR_AUTO_COLLAPSE_PX = 980/);
    assert.match(shellSource, /readShellCollapsedFromPersistedState\(\)/);
    assert.match(shellSource, /writePersistedShellCollapsed\(collapsed\)/);
    assert.match(shellSource, /Math\.min\(SIDEBAR_MAX, Math\.max\(SIDEBAR_MIN, next\)\)/);
  });

  test("data-testid names required by the ticket are unchanged", () => {
    for (const id of ["sidebar-session-row", "sidebar-project-header", "sidebar-directory-more"]) {
      assert.ok(treeSource.includes(`data-testid="${id}"`), id);
    }
  });

  test("per-directory reveal limit is still 6", () => {
    assert.match(treeSource, /const SESSION_VISIBLE_LIMIT = 6;/);
  });
});
