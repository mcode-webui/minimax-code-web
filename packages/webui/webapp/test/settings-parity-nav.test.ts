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
//   2. The 暂不支持 placeholders stay honest — but NOTHING new may join
//      them, and every enabled tab must map to the section it claims. The
//      nav literal is PARSED here (not grepped), so any added item —
//      enabled or placeholder — changes the parsed list and fails the
//      exact-id assertions. This is the "capability table must stay
//      honest" pin. (Ticket 55a moved voice / shortcuts / personalization
//      / code-review out of the placeholder set by giving them real
//      pure-frontend section bodies.)
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
  icon: string | null;
  alias: string | null;
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
 * each group's slice recovers id / key / optional icon / alias / section.
 * Parsing (rather than counting matches of "section:") is what makes the
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
    // Ticket 55a widened the section union with camelCase ids
    // (`codeReview`), so the section capture takes letters of both
    // cases (plus the historical hyphen).
    const itemRe =
      /\{\s*id:\s*"([a-z-]+)",\s*key:\s*"([^"]+)"(?:,\s*icon:\s*"([a-zA-Z]+)")?(?:,\s*alias:\s*"([a-z-]+)")?(?:,\s*section:\s*"([a-zA-Z-]+)")?\s*\}/g;
    for (const match of slice.matchAll(itemRe)) {
      items.push({
        id: match[1] as string,
        key: match[2] as string,
        icon: match[3] ?? null,
        alias: match[4] ?? null,
        section: match[5] ?? null,
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

  test("only the 4 data-source-less items stay unsupported — the 55a pages enabled", () => {
    const all = groups.flatMap((g) => g.items);
    const disabled = all.filter((item) => item.section === null);
    assert.deepEqual(
      disabled.map((item) => item.id),
      ["browser", "account", "worktree", "archived"],
      "a new item without a section is a new placeholder; the capability table must stay honest",
    );
    assert.equal(all.length, 11, "11 items after the appearance tab folded into general");
    // Ticket 55a — the four pure-frontend pages became reachable sections.
    const byId = new Map(all.map((item) => [item.id, item]));
    assert.equal(byId.get("voice")?.section, "voice");
    assert.equal(byId.get("shortcuts")?.section, "shortcuts");
    assert.equal(byId.get("personalization")?.section, "personalization");
    assert.equal(byId.get("code-review")?.section, "codeReview");
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

  test("providers section body renders the segmented-tab UsageModelsSection", () => {
    const bodyStart = panelsSource.indexOf("const body = {");
    const providersAt = panelsSource.indexOf("providers: (", bodyStart);
    assert.ok(providersAt >= 0, "providers case not found in the body object");
    const closeAt = panelsSource.indexOf("[section];", providersAt);
    assert.ok(closeAt > providersAt, "body object terminator not found");
    const providersBody = panelsSource.slice(providersAt, closeAt);
    assert.ok(
      providersBody.includes("<UsageModelsSection"),
      "ticket 53: the section is the desktop's segmented-tab page (UsageModelsSection)",
    );
    // Ticket 53 moved the layout decision inside UsageModelsSection; the
    // card-above-panel stacking this test used to pin here is re-pinned
    // per-view by the ticket-53 describe below.
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

describe("settings visuals and search (ticket 48)", () => {
  const groups = parseSettingsNav(panelsSource);
  const all = groups.flatMap((g) => g.items);

  test("every nav item carries an icon — the 18×18 reference glyph slot", () => {
    for (const item of all) {
      assert.ok(item.icon, `${item.id} must declare an icon (ticket 48, V3)`);
    }
  });

  test("reference key aliases cover the renamed tabs so search finds them", () => {
    const byId = new Map(all.map((item) => [item.id, item]));
    assert.equal(byId.get("general")?.alias, "desktop");
    assert.equal(byId.get("personalization")?.alias, "custom-instructions");
    assert.equal(byId.get("providers")?.alias, "usage");
    assert.equal(byId.get("code-review")?.alias, "coding");
  });

  test("the search filter matches label AND alias/id, not label alone", () => {
    assert.ok(
      panelsSource.includes("${t(item.key)} ${item.alias ?? item.id}"),
      "the filter must concatenate the localized label with the alias-or-id (V11)",
    );
  });

  test("content column: keyed re-mount, fade-in class, and an <h2> header", () => {
    assert.ok(
      panelsSource.includes("key={active}"),
      "the content scroll container re-mounts per tab so the transition replays (V2)",
    );
    assert.ok(
      panelsSource.includes("webui-settings-content-animate"),
      "the 180ms fade-in class must be applied (V1/V2)",
    );
    const h2At = panelsSource.indexOf("<h2 className=\"m-0 text-base font-medium leading-[26px]");
    assert.ok(h2At >= 0, "the content header carries the reference's <h2> (V1)");
    assert.ok(
      panelsSource.includes("max-w-[840px]") && panelsSource.includes("max-w-[760px]"),
      "General page is 840px, other panels 760px (V9)",
    );
  });

  test("General-page sections sit 32px apart; other pages keep the 12px stack", () => {
    assert.ok(
      panelsSource.includes('section === "general" ? "gap-8" : "gap-3"'),
      "the General column follows the reference's .webui-generic-page 32px rhythm (acceptance I-1); usage/connection keep gap-3",
    );
  });

  test("sidebar geometry: 46px top padding, h3 group titles, 30px nav rows", () => {
    assert.ok(panelsSource.includes("pt-[46px]"), "sidebar top padding is 46px (V13)");
    assert.ok(
      panelsSource.includes('<h3 className="px-2 pt-4 pb-1.5 text-sm font-medium leading-5'),
      "group titles are <h3> with the reference's 16/6px padding (V4)",
    );
    assert.ok(
      panelsSource.includes("flex min-h-[30px] w-full items-center gap-2 rounded-[8px] px-2.5"),
      "nav rows use the reference's 8px gap / 30px height / 10px padding (V5)",
    );
  });

  test("general body renders the ticket-48 sections in the reference's order", () => {
    const bodyStart = panelsSource.indexOf("const body = {");
    const generalAt = panelsSource.indexOf("general: (", bodyStart);
    const connectionAt = panelsSource.indexOf("connection: (", bodyStart);
    const generalBody = panelsSource.slice(generalAt, connectionAt);
    const order = [
      'testId="application-section"',
      'testId="file-section"',
      'testId="session-management-section"',
      'testId="preference-settings"',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = generalBody.indexOf(marker);
      assert.ok(at > cursor, `${marker} must appear, in reference order (engine card first)`);
      cursor = at;
    }
    // The horizontal row + divider geometry the reference pins (V6/V7).
    assert.ok(
      generalBody.includes("<SettingRow"),
      "the General page renders rows through the horizontal SettingRow (V6)",
    );
    assert.ok(
      panelsSource.includes("min-h-[56px]"),
      "SettingRow carries the reference's 56px minimum height (V6)",
    );
    assert.ok(
      generalBody.includes("<RowDivider />"),
      "adjacent rows are separated by RowDivider (V7)",
    );
    // The four localStorage-backed switches / radios (G4/G5/G7).
    assert.ok(generalBody.includes("file-open-in-new-tab-switch"));
    assert.ok(generalBody.includes("file-line-wrap-switch"));
    assert.ok(generalBody.includes("context-window-usage-switch"));
  });

  test("the unreachable no-section fallback is gone", () => {
    assert.ok(
      !panelsSource.includes("if (!section) {"),
      "ticket 48 removed the dead branch; the section prop is now required",
    );
  });

  test("reverse-parity survivors stay: engine card, connection body, unsupported badge", () => {
    const bodyStart = panelsSource.indexOf("const body = {");
    const generalAt = panelsSource.indexOf("general: (", bodyStart);
    const connectionAt = panelsSource.indexOf("connection: (", bodyStart);
    const generalBody = panelsSource.slice(generalAt, connectionAt);
    // R2 — engine facts card stays the first card of the General page.
    assert.ok(generalBody.includes('label={t("settings.engine")}'), "engine facts rows stay (R2)");
    assert.ok(generalBody.includes('label={t("settings.localUrl")}'));
    assert.ok(generalBody.includes('label={t("settings.lanUrl")}'));
    // R1 — the connection body keeps its real toggles + token actions.
    const providersAt = panelsSource.indexOf("providers: (", bodyStart);
    const connectionBody = panelsSource.slice(connectionAt, providersAt);
    for (const key of ["settings.readOnly", "settings.lan", "settings.lanBind", "settings.tokenEnabled", "settings.resetToken"]) {
      assert.ok(connectionBody.includes(key), `connection row ${key} stays (R1)`);
    }
    // R3 — disabled tabs still carry the 暂不支持 badge.
    assert.ok(panelsSource.includes('title={disabled ? t("common.unsupported") : undefined}'));
  });
});

// Ticket 53 — the 用量与模型 page rework: the desktop's segmented tabs over
// the Token Plan view (plan card, usage bars, credits switch, invoice link)
// and the custom-models view (the provider panel, unchanged).
//
// Division of labour with usage-models-cards.test.ts: the four cards are
// pure display components living in components/usage-models-cards.tsx and
// are pinned by RENDER tests there (placeholders, disabled actions, the
// F-1 track token, the F-2 outline, the F-3' caption). This describe pins
// what only panels.tsx can betray — the segmented wiring, the view
// branches, the deep-link seed, and the usage container's quota honesty.
//
// What the decisions need pinned:
//
//   - The segmented header (Token Plan 使用中 ⌄ | hairline | 自定义模型) —
//     a revert to the flat two-card stack fails the segment assertions.
//   - The Token Plan branch renders the four cards in the reference order,
//     imported from the render-tested module.
//   - The one live data path stays honest: the 5-hour / weekly bars read
//     the quota store (no fabricated figures), and the video bar carries
//     the notLocal placeholder key, not a made-up "0/5".
//   - The add-provider deep-link must land on the custom-models view —
//     otherwise the auto-add flow fires behind the Token Plan view.
describe("usage-models segmented tabs (ticket 53)", () => {
  const sectionAt = panelsSource.indexOf("function UsageModelsSection");
  assert.ok(sectionAt >= 0, "UsageModelsSection not found in panels.tsx");
  const sectionEnd = panelsSource.indexOf("\nfunction UsageCard", sectionAt);
  assert.ok(sectionEnd > sectionAt, "UsageCard not found after UsageModelsSection");
  const segmentSource = panelsSource.slice(sectionAt, sectionEnd);
  const usageCardAt = panelsSource.indexOf("function UsageCard");
  assert.ok(usageCardAt > 0, "the usage container must stay in panels.tsx");
  const usageCardSource = panelsSource.slice(
    usageCardAt,
    panelsSource.indexOf("\n// --- alerts", usageCardAt),
  );

  test("segmented header: two tabs, the active badge, the chevron, a hairline", () => {
    assert.ok(
      segmentSource.includes('data-testid="usage-models-segment"'),
      "the tablist container must carry its testid",
    );
    assert.ok(
      segmentSource.includes('data-testid="usage-models-tab-token-plan"'),
      "the Token Plan tab button must carry its testid",
    );
    assert.ok(
      segmentSource.includes('data-testid="usage-models-tab-custom-models"'),
      "the custom-models tab button must carry its testid",
    );
    assert.ok(
      segmentSource.includes('t("usage.tab.inUse")'),
      "the green 使用中 badge renders inside the Token Plan tab",
    );
    assert.ok(
      segmentSource.includes('<Icon name="chevronDown"'),
      "the reference's disclosure chevron renders in the tab",
    );
    assert.ok(
      segmentSource.includes("bg-bg_interaction_tertiary_selected"),
      "the selected tab uses the grey pill treatment",
    );
    // The hairline between the two tabs.
    assert.ok(
      segmentSource.includes('className="h-4 w-px bg-border_light" aria-hidden'),
      "a vertical hairline separates the two tabs",
    );
  });

  test("the Token Plan view stacks the desktop's four cards in order", () => {
    const branchAt = segmentSource.indexOf('view === "tokenPlan" ? (');
    assert.ok(branchAt >= 0, "the Token Plan branch not found");
    const branch = segmentSource.slice(branchAt);
    const order = ["<PlanCard", "<UsageCard", "<CreditsCard", "<InvoiceCard"];
    let cursor = -1;
    for (const marker of order) {
      const at = branch.indexOf(marker);
      assert.ok(
        at > cursor,
        `${marker} must render inside the Token Plan view, in reference order`,
      );
      cursor = at;
    }
  });

  test("the four cards come from the render-tested usage-models-cards module", () => {
    assert.ok(
      panelsSource.includes('from "./usage-models-cards"'),
      "panels.tsx must import the split-out card module (render tests live there)",
    );
  });

  test("the custom-models view forwards the provider panel with its deep-link props", () => {
    const elseAt = segmentSource.indexOf(") : (");
    assert.ok(elseAt > 0, "the custom-models branch not found");
    const elseBranch = segmentSource.slice(elseAt);
    assert.ok(
      elseBranch.includes("<ProviderManagementPanel"),
      "the provider panel lives in the custom-models view",
    );
    assert.ok(
      elseBranch.includes("autoAddProvider={autoAddProvider}"),
      "the add-provider flag is forwarded to the panel",
    );
  });

  test("the add-provider deep-link seeds the custom-models view, not Token Plan", () => {
    assert.ok(
      segmentSource.includes('autoAddProvider ? "customModels" : "tokenPlan"'),
      "autoAddProvider must land on the custom-models view (the add flow fires on mount)",
    );
  });

  test("A1: the usage container reads the quota store honestly", () => {
    assert.ok(
      usageCardSource.includes('key: "fiveHour"') && usageCardSource.includes('key: "weekly"'),
      "the two engine-backed windows keep their live rows",
    );
    assert.ok(
      usageCardSource.includes("usedFromRemaining(quota?.ok ? quota.remaining : undefined)"),
      "the 5-hour figure reads the quota store, not a constant",
    );
    assert.ok(
      usageCardSource.includes('key: "video"') &&
        usageCardSource.slice(usageCardSource.indexOf('key: "video"')).includes('"usage.notLocal"'),
      "the video window has no local source — its figure slot renders the placeholder",
    );
    assert.ok(
      !usageCardSource.includes("0/5"),
      "no fabricated 0/5 figure may ship",
    );
    assert.ok(
      usageCardSource.includes("resetCaption"),
      "the bars print the reference's relative reset caption",
    );
    assert.ok(
      usageCardSource.includes("<UsageBar"),
      "the rows render through the render-tested UsageBar",
    );
  });

  test("the retired usage.used / usage.reset label strings have no consumer", () => {
    assert.ok(
      !panelsSource.includes('t("usage.used")') && !panelsSource.includes('t("usage.reset")'),
      "the old label-style usage strings must not be referenced after the bar rework",
    );
  });
});

// Ticket 55a — the four pure-frontend sub-pages (Shortcuts / Voice /
// Personalization / Code review) became reachable sections. What only
// panels.tsx can betray is pinned here; the rendered markup of the pages
// themselves (placeholders, disabled controls, persisted textareas) is
// pinned by RENDER tests in settings-extra-pages.test.ts.
describe("settings pure sub-pages (ticket 55a)", () => {
  test("panels.tsx imports the four pages from the split-out module", () => {
    assert.ok(
      panelsSource.includes('from "./settings-extra-pages"'),
      "the pages live in components/settings-extra-pages.tsx (render-test isolation)",
    );
  });

  test("each new section id routes to its page component before the snapshot gate", () => {
    const switchAt = panelsSource.indexOf("const pureSection = (() => {");
    assert.ok(switchAt >= 0, "the pure-section switch not found in SettingsPanel");
    const gateAt = panelsSource.indexOf("if (!snapshot) {", switchAt);
    assert.ok(gateAt > switchAt, "the snapshot gate must come after the pure-section switch");
    const body = panelsSource.slice(switchAt, gateAt);
    // One case per new section id, each rendering its page component —
    // a revert to placeholders fails the nav test above, a wiring slip
    // (right id, wrong component) fails here.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['case "voice"', "<VoiceSection"],
      ['case "shortcuts"', "<ShortcutsSection"],
      ['case "personalization"', "<PersonalizationSection"],
      ['case "codeReview"', "<CodeReviewSection"],
    ];
    for (const [caseMark, component] of pairs) {
      assert.ok(body.includes(caseMark), `${caseMark} branch missing`);
      assert.ok(body.includes(component), `${component} must render in its branch`);
    }
  });

  test("the pure pages keep the desktop's 32px block rhythm inside their own column", () => {
    const pagesSource = readFileSync(
      resolve(here, "../components/settings-extra-pages.tsx"),
      "utf8",
    );
    // Every page root uses the reference's .webui-generic-page 32px stack
    // (gap-8), the same rhythm the General page carries — the usage and
    // connection sections keep their 12px card stack instead.
    const pageRoots = pagesSource.match(/data-testid="settings-(?:shortcuts|voice|personalization|code-review)-page"[^>]*className="([^"]+)"/g) ?? [];
    assert.equal(pageRoots.length, 4, "four page roots expected");
    for (const root of pageRoots) {
      assert.ok(root.includes("gap-8"), `page root must carry the 32px rhythm: ${root}`);
    }
  });

  test("existing testids untouched: the modal and search ids this ticket must not rename", () => {
    for (const testId of ["settings-modal", "settings-search-input"]) {
      assert.ok(panelsSource.includes(`data-testid="${testId}"`), `${testId} must stay`);
    }
  });
});
