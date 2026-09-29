// webapp/test/settings-parity-nav.test.ts
//
// Static-source tripwire for the settings-page parity rework.
//
// Why a tripwire and not a render test: the webapp suite has no render
// harness — the settings surface is a client-side modal over a static
// Next.js export, so the server tests cannot see it either. The suite's
// standing pattern for render-critical wiring is therefore a
// static-source pin (see composer-submit-tripwire.test.ts).
//
// webui-parity 58 line A moved the modal shell (nav registry, search,
// mask, tab dispatch) from panels.tsx into settings-modal-port.tsx,
// carrying the reference SettingsModal structure over as-is: 10 tabs in
// 4 groups keyed by the reference's internal keys (desktop / voice /
// shortcuts / custom-instructions / usage / connection / account /
// coding / worktree / archived). This file pins that registry and the
// port's wiring; the ticket-53 describe below keeps pinning
// UsageModelsSection inside panels.tsx, which the port mounts headless
// as its token-plan landing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const panelsSource = readFileSync(resolve(here, "../components/panels.tsx"), "utf8");
const portSource = readFileSync(resolve(here, "../components/settings-modal-port.tsx"), "utf8");
const shellSource = readFileSync(resolve(here, "../components/shell.tsx"), "utf8");
const pageSource = readFileSync(resolve(here, "../app/page.tsx"), "utf8");
const cssSource = readFileSync(resolve(here, "../styles/settings-modal.css"), "utf8");

interface ParsedTab {
  key: string;
  labelKey: string;
  icon: string | null;
}

/**
 * Parse the DESKTOP_SETTINGS_TABS literal out of settings-modal-port.tsx.
 *
 * The literal is formatted one item per line, so a per-item regex
 * recovers key / labelKey / icon. Parsing (rather than counting matches)
 * keeps the exact-tab-set pin honest: every added or removed tab changes
 * the parsed list and fails the exact-key assertions.
 */
function parseDesktopSettingsTabs(source: string): ParsedTab[] {
  const start = source.indexOf("export const DESKTOP_SETTINGS_TABS");
  assert.ok(start >= 0, "DESKTOP_SETTINGS_TABS declaration not found in settings-modal-port.tsx");
  const end = source.indexOf("\n];", start);
  assert.ok(end > start, "DESKTOP_SETTINGS_TABS closing bracket not found");
  const body = source.slice(start, end);
  const tabs: ParsedTab[] = [];
  const tabRe =
    /\{\s*key:\s*"([a-z-]+)",\s*group:\s*"[a-z]+",\s*labelKey:\s*"([^"]+)",\s*icon:\s*"([a-zA-Z-]+)"\s*\}/g;
  for (const match of body.matchAll(tabRe)) {
    tabs.push({ key: match[1] as string, labelKey: match[2] as string, icon: match[3] as string });
  }
  assert.ok(tabs.length > 0, "DESKTOP_SETTINGS_TABS parsed with zero items");
  return tabs;
}

describe("settings tab registry parity (webui-parity 58 line A)", () => {
  const tabs = parseDesktopSettingsTabs(portSource);

  test("exactly the reference's 10 tabs, in the reference's order", () => {
    assert.deepEqual(
      tabs.map((tab) => tab.key),
      [
        "desktop",
        "voice",
        "shortcuts",
        "custom-instructions",
        "usage",
        "connection",
        "account",
        "coding",
        "worktree",
        "archived",
      ],
      "the registry must stay the reference DESKTOP_SETTINGS_TABS list, verbatim",
    );
  });

  test("the renamed tabs carry the reference's internal keys as their ids", () => {
    const keys = new Set(tabs.map((tab) => tab.key));
    // Pre-port our ids differed (general/personalization/providers/
    // code-review); the port adopts the reference keys so the search
    // filter and testids match the reference without aliases.
    for (const referenceKey of ["desktop", "custom-instructions", "usage", "coding"]) {
      assert.ok(keys.has(referenceKey), `${referenceKey} must be a tab key`);
    }
  });

  test("every tab carries an icon from the reference ICONS path table", () => {
    for (const tab of tabs) {
      assert.ok(tab.icon, `${tab.key} must declare an icon`);
      assert.ok(
        portSource.includes(`"${tab.icon}"`) || tab.icon === "desktop",
        `${tab.icon} must resolve in SETTINGS_ICON_PATHS`,
      );
    }
  });

  test("the search filter matches label AND reference key, not label alone", () => {
    assert.ok(
      portSource.includes("${t(tab.labelKey)} ${tab.key}"),
      "filterSettingsTabs must concatenate the localized label with the reference key",
    );
  });

  test("the shell mounts the port; panels.tsx keeps only section bodies", () => {
    assert.ok(
      pageSource.includes('from "@/components/settings-modal-port"'),
      "page.tsx must import the SettingsModal shim from the port",
    );
    assert.ok(
      !panelsSource.includes("const SETTINGS_NAV"),
      "the pre-port SETTINGS_NAV literal must be gone from panels.tsx",
    );
    assert.ok(
      portSource.includes('from "./panels"'),
      "the port mounts the existing section bodies (SettingsPanel / UsageModelsSection)",
    );
  });

  test("usage tab dispatches the three-source switch with its landings", () => {
    assert.ok(
      portSource.includes('data-testid="settings-usage-source-tab"'),
      "the reference's source pill carries its testid",
    );
    assert.ok(
      portSource.includes('data-testid="settings-usage-token-plan"'),
      "token-plan landing (53's cards, headless UsageModelsSection)",
    );
    assert.ok(
      portSource.includes('data-testid="settings-minimax-api-panel"'),
      "minimax-api landing (reference API Key panel form)",
    );
    assert.ok(
      portSource.includes('data-testid="settings-custom-models-panel"'),
      "custom landing (54's ProviderManagementPanel)",
    );
    assert.ok(
      portSource.includes("<UsageModelsSection t={t} headless />"),
      "the token-plan landing renders the ticket-53 cards without the internal header",
    );
  });

  test("the reference's empty-panel tabs stay honest placeholders", () => {
    // voice / shortcuts / custom-instructions / coding / worktree render
    // the reference's empty panel until 55a's sub-page content lands on
    // the deploy branch. The dispatch must keep them grouped in one
    // catch-all rather than growing per-tab stubs.
    const emptyAt = portSource.indexOf('aria-label="空设置面板"');
    assert.ok(emptyAt > 0, "the reference's empty-panel affordance must stay");
    for (const tab of ["voice", "shortcuts", "custom-instructions", "coding", "worktree"]) {
      assert.ok(
        !portSource.includes(`active === "${tab}" ?`),
        `${tab} must not grow a bespoke body before its content lands (55a)`,
      );
    }
  });

  test("user menu usage row jumps to settings instead of hosting a hover popover", () => {
    assert.ok(
      shellSource.includes("onClick: () => pick(() => onOpenUsage?.())(),"),
      "the usage menu item's onClick must invoke onOpenUsage",
    );
    assert.ok(!shellSource.includes("UsageLabel"), "the popover-hosting UsageLabel must be gone");
    assert.ok(!shellSource.includes("UsagePopover"), "the UsagePopover flyout must be gone");
  });

  test("page wires an openUsage callback that lands on the usage tab", () => {
    const openUsageAt = pageSource.indexOf("const openUsage");
    assert.ok(openUsageAt >= 0, "openUsage callback missing in page.tsx");
    const region = pageSource.slice(openUsageAt, openUsageAt + 400);
    assert.ok(
      region.includes('setSettingsSection("providers")'),
      "openUsage keeps seeding the providers section id; the shim maps it onto the usage tab",
    );
    assert.ok(region.includes("setSettingsOpen(true)"), "openUsage must open the settings modal");
  });

  test("the initialSection shim maps the legacy ids onto reference tabs", () => {
    const mapAt = portSource.indexOf("INITIAL_SECTION_TO_TAB");
    assert.ok(mapAt > 0, "the shim's mapping table must exist");
    const region = portSource.slice(mapAt, portSource.indexOf("};", mapAt));
    assert.ok(region.includes('general: "desktop"'), "general → desktop");
    assert.ok(region.includes('providers: "usage"'), "providers → usage");
    assert.ok(region.includes('connection: "connection"'), "connection → connection");
  });
});

describe("settings visuals (reference CSS carry-over)", () => {
  test("the reference settings CSS classes are carried with the component layer", () => {
    for (const marker of [
      ".webui-settings-mask",
      ".webui-settings-sidebar",
      ".webui-settings-nav-item.is-active",
      ".webui-generic-page",
      ".webui-generic-row",
      ".webui-mode-card",
      ".webui-toggle-switch.is-checked",
      ".webui-ant-select",
      ".webui-mavis-button-black",
      "webui-settings-content-in",
    ]) {
      assert.ok(cssSource.includes(marker), `${marker} must exist in the carried stylesheet`);
    }
  });

  test("the port renders through the reference class names, not restyled copies", () => {
    for (const marker of [
      'className="webui-settings-mask"',
      'className="webui-settings-sidebar"',
      "webui-settings-nav-item",
      'className="webui-settings-content"',
      'className="webui-generic-page"',
      "webui-generic-section",
      "webui-generic-row",
      "webui-mode-card",
    ]) {
      assert.ok(portSource.includes(marker), `${marker} must be used by the port`);
    }
  });

  test("General page keeps its live localStorage-backed switches on the same keys", () => {
    const genericAt = portSource.indexOf("function GenericPage");
    const genericBody = portSource.slice(genericAt, portSource.indexOf("\nfunction Appearance", genericAt));
    for (const marker of [
      "commitFileOpenInNewTab",
      "commitFileLineWrap",
      "commitContextWindowUsage",
      "commitFollowUpBehavior",
      'testId="file-open-in-new-tab-switch"',
      'testId="file-line-wrap-switch"',
      'testId="context-window-usage-switch"',
    ]) {
      assert.ok(genericBody.includes(marker), `${marker} must stay wired in the port's GenericPage`);
    }
  });
});

// Ticket 53 — the 用量与模型 page rework: the desktop's segmented tabs over
// the Token Plan view (plan card, usage bars, credits switch, invoice link)
// and the custom-models view (the provider panel, unchanged).
//
// Division of labour with usage-models-cards.test.ts: the four cards are
// pure display components living in components/usage-models-cards.tsx and
// are pinned by RENDER tests there. This describe pins what only
// panels.tsx can betray — the segmented wiring, the view branches, the
// deep-link seed, and the usage container's quota honesty. The port
// mounts this section headless under its three-source switch; the
// non-headless header assertions keep pinning the standalone shape.
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
    // 58 line A: the header is wrapped in the headless conditional so the
    // port can mount the section without it.
    assert.ok(
      segmentSource.includes("{!headless ? (<>"),
      "the segmented header must be suppressible via the headless prop",
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

  test("the add-provider deep-link seeds the custom-models view when standalone", () => {
    assert.ok(
      segmentSource.includes('autoAddProvider && !headless ? "customModels" : "tokenPlan"'),
      "autoAddProvider lands on the custom-models view when the header renders; headless mounts pin token-plan (the port routes its own custom landing)",
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
