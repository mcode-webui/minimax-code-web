// webapp/test/settings-parity-nav.test.ts
//
// Static-source tripwire for the settings-page parity rework (ticket 37).
//
// Why a tripwire and not a render test: the webapp suite has no render
// harness — the settings surface is a client-side modal over a static
// Next.js export, so the server tests cannot see it either. The suite's
// standing pattern for render-critical wiring is therefore a
// static-source pin (see composer-submit-tripwire.test.ts), and this
// file applies it to the three files the ticket touches:
// panels.tsx (nav + section bodies), shell.tsx (user menu) and
// page.tsx (open callbacks).
//
// What the three user decisions need pinned, and why each assertion
// exists:
//
//   1. Appearance folded into 通用 — the standalone nav item is gone
//      and the picker + language switch render inside the general
//      section body. A revert re-adds the nav item and this fails on
//      the parsed preferences group.
//
//   2. The 8 pre-existing 暂不支持 placeholders stay — but NOTHING new
//      may join them. The nav literal is PARSED here (not grepped), so
//      any added item — enabled or placeholder — changes the parsed
//      list and fails the exact-id assertions. This is the
//      "capability table must stay honest" pin.
//
//   3. Usage lives in the settings page — the management group's first
//      item is 用量与模型 (the desktop reference's order and name), its
//      section body renders the usage card above the provider panel,
//      and the user menu's usage row jumps there instead of opening a
//      hover popover.
//
// The item id stays "providers" (not "usage-models") on purpose: the
// model selector's "Add provider" deep-link targets that id, and the
// label is the only thing the reference changed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const panelsSource = readFileSync(resolve(here, "../components/panels.tsx"), "utf8");
const shellSource = readFileSync(resolve(here, "../components/shell.tsx"), "utf8");
const pageSource = readFileSync(resolve(here, "../app/page.tsx"), "utf8");

interface ParsedNavItem {
  id: string;
  key: string;
  section: string | null;
}
interface ParsedNavGroup {
  group: string;
  items: ParsedNavItem[];
}

/**
 * Parse the SETTINGS_NAV literal out of panels.tsx.
 *
 * The literal is formatted one item per line, so a per-item regex over
 * each group's slice recovers id / key / optional section. Parsing
 * (rather than counting matches of "section:") is what makes the
 * no-new-placeholders pin exact: every item is accounted for by id.
 */
function parseSettingsNav(source: string): ParsedNavGroup[] {
  const start = source.indexOf("const SETTINGS_NAV");
  assert.ok(start >= 0, "SETTINGS_NAV declaration not found in panels.tsx");
  const end = source.indexOf("\n];", start);
  assert.ok(end > start, "SETTINGS_NAV closing bracket not found in panels.tsx");
  const body = source.slice(start, end);

  const marks: { key: string; at: number }[] = [];
  for (const match of body.matchAll(/group:\s*"(settings\.group\.[a-z]+)"/g)) {
    // noUncheckedIndexedAccess: capture groups on a matched RegExp are
    // always present — narrow once rather than at each use.
    const key = match[1] as string;
    marks.push({ key, at: match.index ?? 0 });
  }
  assert.ok(marks.length > 0, "no settings.group headers found in SETTINGS_NAV");

  return marks.map((mark, index) => {
    const from = mark.at;
    const next = marks[index + 1];
    const to = next ? next.at : body.length;
    const slice = body.slice(from, to);
    const items: ParsedNavItem[] = [];
    const itemRe =
      /\{\s*id:\s*"([a-z-]+)",\s*key:\s*"([^"]+)"(?:,\s*section:\s*"([a-z]+)")?\s*\}/g;
    for (const match of slice.matchAll(itemRe)) {
      items.push({
        id: match[1] as string,
        key: match[2] as string,
        section: match[3] ?? null,
      });
    }
    assert.ok(items.length > 0, `group ${mark.key} parsed with zero items`);
    return { group: mark.key, items };
  });
}

describe("settings nav parity (ticket 37)", () => {
  const groups = parseSettingsNav(panelsSource);

  test("preferences group: no standalone appearance tab — it folded into general", () => {
    const prefs = groups.find((g) => g.group === "settings.group.preferences");
    assert.ok(prefs, "preferences group missing from SETTINGS_NAV");
    assert.deepEqual(
      prefs.items.map((item) => item.id),
      ["general", "voice", "shortcuts", "personalization", "browser"],
      "the standalone appearance item must be gone; nothing else may change",
    );
  });

  test("management group: usage-models first, connection second, account third", () => {
    const management = groups.find((g) => g.group === "settings.group.management");
    assert.ok(management, "management group missing from SETTINGS_NAV");
    assert.deepEqual(
      management.items.map((item) => item.id),
      ["providers", "connection", "account"],
      "desktop reference (refs/ui/03-settings-usage-models.jpg) orders the management group 用量与模型 → 连接 → 账户",
    );
    const first = management.items[0];
    assert.ok(first, "management group parsed with zero items");
    assert.equal(first.key, "settings.tab.usageModels");
    assert.equal(first.section, "providers", "the id stays 'providers' so the add-provider deep-link keeps working");
  });

  test("exactly the 8 pre-existing unsupported items remain — no new placeholders", () => {
    const all = groups.flatMap((g) => g.items);
    const disabled = all.filter((item) => item.section === null);
    assert.deepEqual(
      disabled.map((item) => item.id),
      [
        "voice",
        "shortcuts",
        "personalization",
        "browser",
        "account",
        "code-review",
        "worktree",
        "archived",
      ],
      "a new item without a section is a new placeholder; the capability table must stay honest",
    );
    assert.equal(all.length, 11, "11 items after the appearance tab folded into general");
  });

  test("general section body renders the appearance picker and the language switch", () => {
    const bodyStart = panelsSource.indexOf("const body = {");
    assert.ok(bodyStart >= 0, "SettingsPanel body object not found");
    const generalAt = panelsSource.indexOf("general: (", bodyStart);
    const connectionAt = panelsSource.indexOf("connection: (", bodyStart);
    assert.ok(generalAt >= 0, "general case not found in the body object");
    assert.ok(connectionAt > generalAt, "connection case not found after general");
    const generalBody = panelsSource.slice(generalAt, connectionAt);
    assert.ok(
      generalBody.includes("<AppearanceCardPicker"),
      "the three-state appearance picker must render inside the general section",
    );
    assert.ok(
      generalBody.includes("<LanguageSwitch"),
      "the language switch must render inside the general section",
    );
  });

  test("appearance is no longer a settings-section id anywhere in the type surface", () => {
    assert.ok(
      !panelsSource.includes('| "appearance"'),
      "SettingsSection / initialSection unions must not carry an appearance member any more",
    );
    assert.ok(
      !pageSource.includes('| "appearance"'),
      "page.tsx settings-section state must not carry an appearance member any more",
    );
  });

  test("providers section body renders the usage card above the provider panel", () => {
    const bodyStart = panelsSource.indexOf("const body = {");
    const providersAt = panelsSource.indexOf("providers: (", bodyStart);
    assert.ok(providersAt >= 0, "providers case not found in the body object");
    const closeAt = panelsSource.indexOf("[section];", providersAt);
    assert.ok(closeAt > providersAt, "body object terminator not found");
    const providersBody = panelsSource.slice(providersAt, closeAt);
    const usageAt = providersBody.indexOf("<UsageCard");
    const panelAt = providersBody.indexOf("<ProviderManagementPanel");
    assert.ok(usageAt >= 0, "the usage card must render in the usage-and-models section");
    assert.ok(
      panelAt > usageAt,
      "the usage card sits above the provider management panel (reference: 用量 above 模型)",
    );
  });

  test("user menu usage row jumps to settings instead of hosting a hover popover", () => {
    assert.ok(
      shellSource.includes("onClick: () => pick(() => onOpenUsage?.())(),"),
      "the usage menu item's onClick must invoke onOpenUsage",
    );
    assert.ok(!shellSource.includes("UsageLabel"), "the popover-hosting UsageLabel must be gone");
    assert.ok(!shellSource.includes("UsagePopover"), "the UsagePopover flyout must be gone");
    assert.ok(
      !shellSource.includes("sidebar-user-usage-popover"),
      "the popover's testid must not linger",
    );
    assert.ok(
      !shellSource.includes("mavis-usage-popover-overlay"),
      "the popover's overlay class must not linger",
    );
  });

  test("page wires an openUsage callback that lands on the usage-and-models section", () => {
    const openUsageAt = pageSource.indexOf("const openUsage");
    assert.ok(openUsageAt >= 0, "openUsage callback missing in page.tsx");
    const region = pageSource.slice(openUsageAt, openUsageAt + 400);
    assert.ok(
      region.includes('setSettingsSection("providers")'),
      "openUsage must seed the settings modal with the providers (usage & models) section",
    );
    assert.ok(region.includes("setSettingsOpen(true)"), "openUsage must open the settings modal");
    assert.ok(pageSource.includes("onOpenUsage={openUsage}"), "the shell must receive onOpenUsage");
  });
});
