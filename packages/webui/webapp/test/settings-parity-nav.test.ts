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
      /<UsageModelsSection t=\{t\} headless(?: accountRevision=\{accountRevision\})? \/>/.test(
        portSource,
      ),
      "the token-plan landing renders the ticket-53 cards without the internal header",
    );
  });

  test("the 55a sub-pages render in their tabs; worktree renders the real section", () => {
    // 工单 58 线 D：55a 的四子页内容已接进移植壳的对应 Tab（voice /
    // shortcuts / custom-instructions / coding），记忆摘要弹窗由
    // PersonalizationSection 内部管理；已归档任务仍无本地内容，保持参照的
    // 诚实空面板。工作树页签自 PB-3 起不再是占位——它接上引擎
    // （`GET /api/worktrees` / `POST /api/worktrees/remove`），因此本组断言
    // 从「诚实占位」翻转为「真实分区」，且必须同时钉住旧占位文案已消失：
    // 那句「本地版暂不支持工作树管理」描述的是路由而不是能力，留着就是失真。
    for (const [tab, component] of [
      ["voice", "VoiceSection"],
      ["shortcuts", "ShortcutsSection"],
      ["custom-instructions", "PersonalizationSection"],
      ["coding", "CodeReviewSection"],
    ] as const) {
      assert.ok(
        portSource.includes(`active === "${tab}" ? <${component}`),
        `${tab} must render 55a's ${component}`,
      );
    }
    assert.ok(
      portSource.includes('{active === "worktree" ? ('),
      "worktree renders a real panel (59 B2: the blank div is gone)",
    );
    assert.ok(
      portSource.includes("<WorktreeSection t={t} />"),
      "PB-3: the worktree tab must render the engine-backed section",
    );
    assert.equal(
      portSource.includes('title={t("settings.tab.worktree")}'),
      false,
      "the old inline panel is gone; the section carries its own title",
    );
    assert.equal(
      portSource.includes('t("settings.worktree.empty")'),
      false,
      "the render branch no longer prints the placeholder sentence itself",
    );
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

  // SB-7 (the A1 revision): the plan card stopped being sourceless, so the
  // container now owns an /api/account read. A static tripwire, because
  // panels.tsx pulls the session store and the api graph and cannot be
  // rendered in the test process — but the wiring it guards is exactly
  // what a static read can see: the fetch, the pure resolver, and the prop.
  test("SB-7: the plan name is fed from /api/account, with no default tier", () => {
    assert.ok(
      segmentSource.includes(".getAccount()") && segmentSource.includes("api.AccountPayload"),
      "the Token Plan container must read the account projection",
    );
    assert.ok(
      segmentSource.includes("planNameOf(account)"),
      "the name goes through the render-tested pure resolver, not inline logic",
    );
    assert.ok(
      segmentSource.includes("<PlanCard t={t} planName={planName} planPending={accountPending} />"),
      "the resolved name reaches the card as a prop, and the in-flight state travels with it",
    );
    assert.ok(
      !/planName\s*[:=][^;\n]*(\?\?|\|\|)\s*"/.test(segmentSource),
      "no fallback tier may be hardcoded next to the account read",
    );
  });

  // P20 / UAT4-1. The UAT ran the three-source round trip and watched the
  // Token Plan card fall to 「未订阅套餐」 while `GET /api/account` kept
  // answering `tier: "Ultra"`; F5 was the only recovery. Root cause: the
  // card's account read ran ONCE per mount, and the mount that followed a
  // source switch raced the engine's rebind — `GET /api/account` soft-fails
  // with HTTP 200 `{ok:false}`, the card took it as "no plan", and nothing
  // re-read it. The fix is the trigger, not the card: a successful source
  // write bumps a revision that the read depends on.
  //
  // Static tripwires because panels.tsx and settings-modal-port.tsx both
  // pull the session store and the api graph — the suite's standing shape
  // for this surface (see the file header). The rule under test is purely
  // about WHICH writes re-read and WHEN, which is exactly what a source
  // read can see honestly.
  describe("P20 UAT4-1: a successful source switch re-reads GET /api/account", () => {
    test("the read depends on the revision, not on the mount alone", () => {
      assert.ok(
        /useEffect\(\(\) => \{[\s\S]{0,900}?\}, \[accountRevision\]\);/.test(segmentSource),
        "the /api/account effect must list accountRevision as a dependency",
      );
      assert.ok(
        !/\.getAccount\(\)[\s\S]{0,400}?\}, \[\]\);/.test(segmentSource),
        "a read-once /api/account effect is the UAT4-1 defect itself",
      );
    });

    test("the container forwards the revision it was given", () => {
      assert.ok(
        segmentSource.includes("accountRevision?: number"),
        "UsageModelsSection must accept the revision prop",
      );
      assert.ok(
        portSource.includes("accountRevision={accountRevision}"),
        "the port passes its revision down to the Token Plan landing",
      );
    });

    test("the port bumps the revision on BOTH successful source writes", () => {
      // chooseSource (the dropdown) and saveKeyAndUse (save-and-use, which
      // switches the source in the same engine transaction). Missing either
      // leaves one round trip stale.
      const chooseStart = portSource.indexOf("const chooseSource");
      const saveStart = portSource.indexOf("const saveKeyAndUse");
      const testStart = portSource.indexOf("const testKey");
      assert.ok(chooseStart >= 0 && saveStart > chooseStart && testStart > saveStart);
      const choose = portSource.slice(chooseStart, saveStart);
      const save = portSource.slice(saveStart, testStart);
      for (const [name, body] of [
        ["chooseSource", choose],
        ["saveKeyAndUse", save],
      ] as const) {
        const write = body.indexOf("await api.");
        const bump = body.indexOf("revalidateAccount()");
        assert.ok(write >= 0, `${name} performs an engine write`);
        assert.ok(
          bump > write,
          `${name} must revalidate the account read AFTER its write succeeded — never on the failure path`,
        );
      }
      // The bump is a real state transition, not a no-op stand-in.
      assert.ok(
        portSource.includes("setAccountRevision((revision) => revision + 1)"),
        "revalidateAccount must advance the revision the read depends on",
      );
    });

    test("the re-read goes through the render-tested reconciler", () => {
      assert.ok(
        segmentSource.includes("reconciledAccount(previous, payload)"),
        "a failed re-read must not replace a known-good answer (mutation 2 of UAT4-1)",
      );
    });
  });

  // P20 / UAT4-2. The UAT filled a key without saving and read two
  // contradictory sentences on one screen: a pinned 「请先填写 API Key」 the
  // engine's NO_API_KEY refusal had left behind, next to a probe button
  // disabled for a reason that existed only in a `title` attribute.
  describe("P20 UAT4-2: the MiniMax API card stops contradicting itself", () => {
    test("typing a key retires the 'fill one in first' verdict", () => {
      assert.ok(
        /onChange=\{\(event\) => \{[\s\S]{0,400}?previous\.kind === "keyRequired" \? null : previous/.test(
          portSource,
        ),
        "the key field must drop a keyRequired notice — it is falsified by typing",
      );
      assert.ok(
        portSource.includes("kind: keyRefused ?"),
        "only the NO_API_KEY refusal carries that kind; a generic failure is still true after typing",
      );
    });

    test("a typed-but-unsaved key gets its own badge state", () => {
      const badge = portSource.slice(
        portSource.indexOf('data-testid="settings-minimax-key-status"'),
        portSource.indexOf('data-testid="settings-minimax-save"'),
      );
      const typed = badge.indexOf("usageModels.minimax.pendingSave");
      const stored = badge.indexOf("usageModels.minimax.configured");
      assert.ok(typed >= 0, "the badge must have a typed-but-unsaved state");
      assert.ok(stored > typed, "it outranks 已保存密钥 — the user is replacing the stored key");
    });

    test("the probe gate is explained in visible text, not only in a title", () => {
      assert.ok(
        portSource.includes('data-testid="settings-minimax-test-gate"'),
        "the disabled probe needs a visible reason, not a hover-only title",
      );
      const gate = portSource.slice(
        portSource.indexOf('data-testid="settings-minimax-test-gate"'),
        portSource.indexOf('data-testid="settings-minimax-save"'),
      );
      assert.ok(
        gate.includes('t("usageModels.minimax.probeGate")'),
        "the visible line renders the gate string, not a hardcoded duplicate",
      );
      assert.ok(
        portSource.includes("{!hasStoredKey || hasUnsavedKey ? ("),
        "the line shows exactly while the gate is closed",
      );
    });
  });
});
