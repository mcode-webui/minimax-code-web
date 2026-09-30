// webapp/test/plugins-surface.test.ts
//
// Ticket 60 phase 1, slice B — the five-area plugin surface.
//
// Three families of coverage, in the order they matter:
//
//   1. The DECISIONS (pure): which state the user sees, whether a card may
//      be installed, whether a refusal is silent, whether a cursor survives
//      a filter change, and — the one the dispatch calls out twice — that
//      the panel branches on `sourceKind` and never on the numeric
//      `source`. That last one is pinned BEHAVIOURALLY: a row carrying
//      `source: 1` together with `sourceKind: "local"` must be treated as
//      local. A row whose two fields disagree only exists because slice A
//      keeps the number for the contract and adds the string for the
//      browser, so a panel that reads the number renders the wrong side
//      silently and no other test in the repo would notice.
//
//   2. The LOADS (`loadPluginList` with a fixture client): the four
//      contract states plus the official-market short circuit, which must
//      not issue a request at all.
//
//   3. The RENDER (`renderToStaticMarkup` over the controlled pieces and
//      over the container): every state, every area, both locales. The
//      container's effects do not run under SSR, which is exactly why the
//      loaded states are driven through `PluginSurfaceBody` directly —
//      the same split `add-model-dialog.tsx` uses.
//
// createElement, not JSX: this suite is a `.test.ts` file and the test
// runner's glob is `**/*.test.ts`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type MessageKey } from "../lib/i18n";
import type {
  InstalledPlugin,
  MarketplacePlugin,
  MarketplaceSkill,
  PluginImportPreviewPayload,
  PluginMutationPayload,
  PluginSource,
} from "../lib/api";
import {
  PLUGIN_AREAS,
  PLUGIN_CATEGORY_FILTERS,
  PluginAreaPendingBody,
  PluginAreaTabBar,
  PluginSurfaceBody,
  PluginsSurface,
  derivePluginStatus,
  isPendingArea,
  loadPluginList,
  mayRequestMarketplace,
  pluginActionOutcome,
  projectPluginCards,
  runPluginImport,
  runPluginImportPreview,
  shouldResetCursor,
  toMutationTarget,
  toPluginCard,
  type PluginCard,
  type PluginFilter,
  type PluginSurfaceApi,
} from "../components/plugins-surface";

const here = dirname(fileURLToPath(import.meta.url));

const enT = (key: MessageKey): string => translate("en", key);
const zhT = (key: MessageKey): string => translate("zh", key);

// --- fixtures ----------------------------------------------------------------

function installed(over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    name: "mcode-webui",
    displayName: "mcode-webui",
    enabled: true,
    sourceKind: "local",
    source: 2,
    capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1, hookCount: 0 },
    ...over,
  };
}

// A market row is a `MarketplacePlugin`, not an `InstalledPlugin`: it
// carries `installExists`, which is the field `canInstall` reads. Typing
// the helper as the installed shape hid that behind a cast.
function marketplaceRow(over: Partial<MarketplacePlugin> = {}): MarketplacePlugin {
  return {
    name: "local-pack",
    displayName: "Local pack",
    description: "A package found on this machine",
    enabled: true,
    installExists: false,
    sourceKind: "local",
    source: 2,
    capabilities: { appCount: 1, mcpServerCount: 0, skillCount: 2, hookCount: 0 },
    ...over,
  };
}

function card(over: Partial<PluginCard> = {}): PluginCard {
  return {
    name: "mcode-webui",
    title: "mcode-webui",
    description: "",
    sourceKind: "local",
    enabled: true,
    installed: true,
    skillCount: 0,
    mcpServerCount: 0,
    appCount: 0,
    hookCount: 0,
    canInstall: false,
    canToggle: true,
    canUninstall: true,
    ...over,
  };
}

interface FakeApi {
  api: PluginSurfaceApi;
  calls: string[];
  lastQuery: Record<string, unknown>;
}

function fakeApi(answers: {
  installed?: unknown;
  marketplace?: unknown;
  mutation?: PluginMutationPayload;
  preview?: PluginImportPreviewPayload;
  importAnswer?: unknown;
  throws?: Error;
}): FakeApi {
  const calls: string[] = [];
  let lastQuery: Record<string, unknown> = {};
  const api = {
    listInstalledPlugins: (query: Record<string, unknown> = {}) => {
      calls.push("listInstalledPlugins");
      lastQuery = query;
      if (answers.throws) return Promise.reject(answers.throws);
      return Promise.resolve(answers.installed);
    },
    listMarketplacePlugins: (query: Record<string, unknown> = {}) => {
      calls.push("listMarketplacePlugins");
      lastQuery = query;
      if (answers.throws) return Promise.reject(answers.throws);
      return Promise.resolve(answers.marketplace);
    },
    refreshPlugins: () => {
      calls.push("refreshPlugins");
      return Promise.resolve({ ok: true });
    },
    enablePlugin: () => {
      calls.push("enablePlugin");
      return Promise.resolve(answers.mutation ?? { ok: true, enabled: true });
    },
    disablePlugin: () => {
      calls.push("disablePlugin");
      return Promise.resolve(answers.mutation ?? { ok: true, enabled: false });
    },
    installPlugin: () => {
      calls.push("installPlugin");
      return Promise.resolve(answers.mutation ?? { ok: true, enabled: true });
    },
    uninstallPlugin: () => {
      calls.push("uninstallPlugin");
      return Promise.resolve(answers.mutation ?? { ok: true, installExists: false });
    },
    previewGithubPlugin: () => {
      calls.push("previewGithubPlugin");
      if (answers.throws) return Promise.reject(answers.throws);
      return Promise.resolve(answers.preview);
    },
    importGithubPlugin: () => {
      calls.push("importGithubPlugin");
      if (answers.throws) return Promise.reject(answers.throws);
      return Promise.resolve(answers.importAnswer);
    },
  } as unknown as PluginSurfaceApi;
  return { api, calls, get lastQuery() { return lastQuery; } } as FakeApi;
}

function body(props: Partial<Parameters<typeof PluginSurfaceBody>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PluginSurfaceBody, {
      status: "success",
      domain: "plugins",
      view: "personal",
      t: enT,
      cards: [],
      localSkills: [],
      errorMessage: "",
      busyName: null,
      ...props,
    } as Parameters<typeof PluginSurfaceBody>[0]),
  );
}

// --- 1. the decisions --------------------------------------------------------

describe("plugins surface — the five areas", () => {
  test("the area registry is the desktop order and the plugins area leads", () => {
    assert.deepEqual([...PLUGIN_AREAS], ["plugins", "skills", "apps", "mcp", "agents"]);
    assert.equal(PLUGIN_AREAS.length, 5, "five capability areas, no sixth");
  });

  test("four areas are pending and only the plugins area is not", () => {
    assert.equal(isPendingArea("plugins"), false);
    for (const area of ["skills", "apps", "mcp", "agents"] as const) {
      assert.equal(isPendingArea(area), true, `${area} has no endpoint in phase 1`);
    }
  });

  test("the category filter covers every runtime category exactly once", () => {
    const values = PLUGIN_CATEGORY_FILTERS.map((filter) => filter.value).filter(
      (value) => value !== undefined,
    );
    assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(
      new Set(values).size,
      values.length,
      "a duplicated category id would send an ambiguous query",
    );
    assert.equal(
      PLUGIN_CATEGORY_FILTERS[0]?.value,
      undefined,
      "the first option is 'all' and sends no category at all",
    );
  });
});

describe("plugins surface — status derivation", () => {
  const base = { view: "personal" as const, source: "local" as const };

  test("four contract states on the plugins area", () => {
    assert.equal(derivePluginStatus({ ...base, domain: "plugins", phase: "loading", cardCount: 0 }), "loading");
    assert.equal(derivePluginStatus({ ...base, domain: "plugins", phase: "failed", cardCount: 0 }), "error");
    assert.equal(derivePluginStatus({ ...base, domain: "plugins", phase: "idle", cardCount: 0 }), "empty");
    assert.equal(derivePluginStatus({ ...base, domain: "plugins", phase: "idle", cardCount: 3 }), "success");
  });

  test("a failed load that still holds rows reads as an error, not a success", () => {
    // The phase decides, never the row count: a refresh that fails while
    // stale rows are on screen must not silently look healthy.
    assert.equal(derivePluginStatus({ ...base, domain: "plugins", phase: "failed", cardCount: 7 }), "error");
  });

  test("an area without an endpoint is pending whatever the load did", () => {
    for (const domain of ["skills", "apps", "mcp", "agents"] as const) {
      for (const phase of ["idle", "loading", "failed"] as const) {
        assert.equal(
          derivePluginStatus({ ...base, domain, phase, cardCount: 0 }),
          "pending",
          `${domain}/${phase}`,
        );
      }
    }
  });

  test("the official market is notLocal, and the local one is not", () => {
    assert.equal(
      derivePluginStatus({ domain: "plugins", view: "market", source: "official", phase: "idle", cardCount: 0 }),
      "notLocal",
    );
    assert.equal(
      derivePluginStatus({ domain: "plugins", view: "market", source: "local", phase: "idle", cardCount: 0 }),
      "empty",
    );
  });
});

describe("plugins surface — the sourceKind contract (slice A/C)", () => {
  test("a row is read through sourceKind even when the numeric source disagrees", () => {
    // Slice A keeps `source` (1/2) for the wire contract and adds
    // `sourceKind` for the browser. Reading the number here would put a
    // `source: 1` local row on the official side.
    const row = marketplaceRow({ source: 1, sourceKind: "local" });
    const projected = toPluginCard(row, { view: "market", source: "local" });
    assert.equal(projected.sourceKind, "local");
    assert.equal(
      projected.canInstall,
      false,
      "a local row never offers install — the runtime answers LOCAL_PLUGIN_INSTALL_UNSUPPORTED",
    );
    assert.equal(projected.canToggle, false, "the market view does not toggle");
  });

  test("a missing sourceKind degrades to unknown and to no mutation at all", () => {
    const projected = toPluginCard(
      { ...installed(), sourceKind: undefined } as unknown as InstalledPlugin,
      { view: "personal", source: "local" },
    );
    assert.equal(projected.sourceKind, "unknown");
    assert.equal(projected.canToggle, false);
    assert.equal(projected.canUninstall, false);
    assert.equal(toMutationTarget(projected), null, "an unknown side has no mutation target");
  });

  test("market rows install only when official and not yet installed", () => {
    const base = { view: "market" as const, source: "official" as const };
    assert.equal(toPluginCard(marketplaceRow({ sourceKind: "official", installExists: false }), base).canInstall, true);
    assert.equal(toPluginCard(marketplaceRow({ sourceKind: "official", installExists: true }), base).canInstall, false);
    assert.equal(toPluginCard(marketplaceRow({ sourceKind: "local", installExists: false }), base).canInstall, false);
  });

  test("installed rows offer the toggle and the uninstall; market rows offer neither", () => {
    const personal = toPluginCard(installed(), { view: "personal", source: "local" });
    assert.equal(personal.canToggle, true);
    assert.equal(personal.canUninstall, true);
    const market = toPluginCard(marketplaceRow(), { view: "market", source: "local" });
    assert.equal(market.canToggle, false);
    assert.equal(market.canUninstall, false);
  });

  test("a local row is not installed=false, so the installed chip and uninstall agree", () => {
    const projected = projectPluginCards([installed()], { view: "personal", source: "local" });
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.installed, true);
  });

  test("the mutation target carries the side the card says it is on", () => {
    assert.deepEqual(
      toMutationTarget(card({ name: "p", sourceKind: "official" })),
      { pluginName: "p", source: "official" },
    );
    assert.equal(toMutationTarget(card({ sourceKind: "unknown" })), null);
  });
});

describe("plugins surface — mutation outcomes", () => {
  test("an applied mutation reports the resulting state", () => {
    const outcome = pluginActionOutcome({ ok: true, enabled: true, installExists: true }, "local");
    assert.equal(outcome.kind, "applied");
    assert.equal(outcome.kind === "applied" && outcome.enabled, true);
  });

  test("an official refusal is silent, not a red banner", () => {
    for (const code of ["PLUGIN_AUTH_REQUIRED", "PLUGIN_AUTH_SYNC_TIMEOUT", "SCOPE_CHANGED"]) {
      const outcome = pluginActionOutcome({ ok: false, error: "no", code }, "official");
      assert.equal(outcome.kind, "notLocal", code);
    }
    // The same code on the local side is a real failure worth reporting.
    assert.equal(
      pluginActionOutcome({ ok: false, error: "no", code: "PLUGIN_AUTH_REQUIRED" }, "local").kind,
      "notLocal",
      "the auth codes mean the same thing whichever side asked",
    );
  });

  test("a local failure keeps the server's own text and code", () => {
    const outcome = pluginActionOutcome(
      { ok: false, error: "local Plugin is not installed", code: "PLUGIN_NOT_FOUND" },
      "local",
    );
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.kind === "failed" && outcome.message, "local Plugin is not installed");
    assert.equal(outcome.kind === "failed" && outcome.code, "PLUGIN_NOT_FOUND");
  });
});

describe("plugins surface — cursor discipline (PLUGIN_CURSOR_INVALID)", () => {
  const filter: PluginFilter = { keyword: "", category: null, source: "local", view: "market" };

  test("an unchanged filter keeps the cursor", () => {
    assert.equal(shouldResetCursor(filter, { ...filter }), false);
  });

  test("a keyword, category, source or view change drops it", () => {
    assert.equal(shouldResetCursor(filter, { ...filter, keyword: "a" }), true);
    assert.equal(shouldResetCursor(filter, { ...filter, category: 4 }), true);
    assert.equal(shouldResetCursor(filter, { ...filter, source: "official" }), true);
    assert.equal(shouldResetCursor(filter, { ...filter, view: "personal" }), true);
  });
});

// --- 2. the loads ------------------------------------------------------------

describe("plugins surface — loadPluginList", () => {
  const request = { view: "market" as const, source: "local" as const, keyword: "", category: null };

  test("the official market never issues a request", async () => {
    assert.equal(mayRequestMarketplace("official"), false);
    assert.equal(mayRequestMarketplace("local"), true);
    const fake = fakeApi({ marketplace: { ok: true, plugins: [marketplaceRow()] } });
    const result = await loadPluginList(fake.api, { ...request, source: "official" });
    assert.equal(result.phase, "notLocal");
    assert.equal(result.cards.length, 0, "a placeholder must not carry rows");
    assert.deepEqual(fake.calls, [], "writing the call and catching the failure is what we refuse to do");
  });

  test("a local market page projects rows and keeps the standalone skills", async () => {
    const skills: MarketplaceSkill[] = [{ id: -42, name: "marginal-tracker", added: true }];
    const fake = fakeApi({
      marketplace: { ok: true, sourceKind: "local", plugins: [marketplaceRow()], marketplaceSkills: skills, pluginTotal: 1 },
    });
    const result = await loadPluginList(fake.api, request);
    assert.equal(result.phase, "idle");
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0]?.sourceKind, "local");
    assert.equal(result.localSkills.length, 1);
    assert.equal(result.total, 1);
    assert.deepEqual(fake.calls, ["listMarketplacePlugins"]);
  });

  test("an empty page is idle with no rows — not an error", async () => {
    const fake = fakeApi({ marketplace: { ok: true, plugins: [] } });
    const result = await loadPluginList(fake.api, request);
    assert.equal(result.phase, "idle");
    assert.equal(result.cards.length, 0);
  });

  test("an ok:false answer keeps the code and the message", async () => {
    const fake = fakeApi({
      marketplace: { ok: false, error: "Plugin System Cloud request failed", code: "NETWORK_ERROR" },
    });
    const result = await loadPluginList(fake.api, request);
    assert.equal(result.phase, "failed");
    assert.equal(result.code, "NETWORK_ERROR");
    assert.equal(result.errorMessage, "Plugin System Cloud request failed");
  });

  test("a thrown request (400 cursor, 403 read-only) surfaces the server's text", async () => {
    const fake = fakeApi({ throws: new Error("cursor is not valid for this query") });
    const result = await loadPluginList(fake.api, request);
    assert.equal(result.phase, "failed");
    assert.equal(result.errorMessage, "cursor is not valid for this query");
  });

  test("the installed view calls the installed endpoint, not the market one", async () => {
    const fake = fakeApi({ installed: { ok: true, plugins: [installed()] } });
    const result = await loadPluginList(fake.api, { ...request, view: "personal" });
    assert.deepEqual(fake.calls, ["listInstalledPlugins"]);
    assert.equal(result.cards[0]?.canUninstall, true);
    assert.equal(result.localSkills.length, 0, "standalone skills are a market-page projection only");
  });

  test("the keyword reaches the request and an empty one is dropped", async () => {
    const fake = fakeApi({ marketplace: { ok: true, plugins: [] } });
    await loadPluginList(fake.api, { ...request, keyword: "  " });
    assert.equal(fake.lastQuery.keyword, undefined, "a blank keyword is not sent");
    await loadPluginList(fake.api, { ...request, keyword: "csv" });
    assert.equal(fake.lastQuery.keyword, "csv");
  });

  test("the category is sent only when one is chosen", async () => {
    const fake = fakeApi({ marketplace: { ok: true, plugins: [] } });
    await loadPluginList(fake.api, { ...request, category: 4 });
    assert.equal(fake.lastQuery.category, 4);
    await loadPluginList(fake.api, request);
    assert.equal(fake.lastQuery.category, undefined, "no category means no parameter");
  });
});

describe("plugins surface — GitHub import", () => {
  const previewOk: PluginImportPreviewPayload = {
    ok: true,
    canImport: true,
    source: { repositoryUrl: "https://github.com/o/r", commitSha: "abc" },
    packageSizeBytes: 2048,
    plugin: {
      summary: { name: "o-r", capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1 } } as never,
      skillCount: 1,
      mcpServerCount: 0,
      hasStdioMcp: false,
    },
  };

  test("a preview that can import is committable", async () => {
    const fake = fakeApi({
      preview: previewOk,
      importAnswer: { ok: true, plugin: { name: "o-r" } },
    });
    const state = await runPluginImportPreview(fake.api, "https://github.com/o/r");
    assert.equal(state.canImport, true);
    assert.equal(state.errorMessage, "");
    const committed = await runPluginImport(fake.api, previewOk);
    assert.equal(committed.ok, true);
    assert.deepEqual(fake.calls, ["previewGithubPlugin", "importGithubPlugin"]);
  });

  test("a package with nothing usable previews but is not committable", async () => {
    const fake = fakeApi({ preview: { ...previewOk, canImport: false } });
    const state = await runPluginImportPreview(fake.api, "https://github.com/o/r");
    assert.equal(state.canImport, false);
    assert.equal(state.preview?.plugin?.summary.name, "o-r", "the summary still renders");
  });

  test("a refused preview is an error with the server's text", async () => {
    const fake = fakeApi({ preview: { ok: false, error: "PLUGIN_MANIFEST_MISSING" } });
    const state = await runPluginImportPreview(fake.api, "https://github.com/o/r");
    assert.equal(state.errorMessage, "PLUGIN_MANIFEST_MISSING");
    assert.equal(state.canImport, false);
  });

  test("an existing plugin refuses the import without a crash", async () => {
    const fake = fakeApi({ importAnswer: { ok: false, error: "PLUGIN_ALREADY_EXISTS" } });
    const committed = await runPluginImport(fake.api, previewOk);
    assert.equal(committed.ok, false);
    assert.equal(committed.errorMessage, "PLUGIN_ALREADY_EXISTS");
  });

  test("a preview without coordinates cannot be committed, and says so", async () => {
    const fake = fakeApi({ importAnswer: { ok: true } });
    const committed = await runPluginImport(fake.api, { ok: true, canImport: true });
    assert.equal(committed.ok, false);
    assert.deepEqual(fake.calls, [], "no source, no request");
  });
});

// --- 3. the render -----------------------------------------------------------

describe("plugins surface — five tabs render", () => {
  test("every area is a tab, one is selected, and the strip is labelled", () => {
    const markup = renderToStaticMarkup(
      createElement(PluginAreaTabBar, { area: "skills", t: enT }),
    );
    for (const area of PLUGIN_AREAS) {
      assert.ok(markup.includes(`plugins-surface-area-${area}`), `tab ${area} renders`);
    }
    assert.ok(markup.includes(`aria-label="${enT("plugins.area.aria")}"`));
    assert.ok(markup.includes('aria-selected="true"'));
    assert.equal(
      (markup.match(/aria-selected="true"/g) ?? []).length,
      1,
      "exactly one tab is selected",
    );
    for (const area of PLUGIN_AREAS) {
      if (area === "skills") continue;
      assert.ok(
        markup.includes(`data-active="false"`) || markup.includes("data-active=false"),
        "the inactive tabs say so",
      );
      break;
    }
  });

  test("the five tab labels are the bilingual area names", () => {
    const markup = renderToStaticMarkup(createElement(PluginAreaTabBar, { area: "plugins", t: zhT }));
    assert.ok(markup.includes("插件"));
    assert.ok(markup.includes("技能"));
    assert.ok(markup.includes("应用"));
    assert.ok(markup.includes("MCP"));
    assert.ok(markup.includes("Agents"));
  });
});

describe("plugins surface — the four areas without an endpoint", () => {
  test("each renders its own explanation, in both locales", () => {
    for (const domain of ["skills", "apps", "mcp", "agents"] as const) {
      for (const t of [enT, zhT]) {
        const markup = renderToStaticMarkup(createElement(PluginAreaPendingBody, { domain, t }));
        assert.ok(markup.includes(`data-pending-area="${domain}"`));
        assert.ok(markup.includes(t(`plugins.area.${domain}.pending.title` as MessageKey)));
        assert.ok(
          markup.includes(t(`plugins.area.${domain}.pending.body` as MessageKey)),
          `${domain} states what is missing`,
        );
      }
    }
  });

  test("the placeholder is not a blank page: it carries the surface chrome", () => {
    const markup = renderToStaticMarkup(
      createElement(PluginAreaTabBar, { area: "mcp", t: enT }),
    ) + renderToStaticMarkup(createElement(PluginAreaPendingBody, { domain: "mcp", t: enT }));
    assert.ok(markup.includes("plugins-surface-areas"), "the area strip is still there");
    assert.ok(markup.includes("plugins-surface-pending-card"));
  });

  test("a pending area shows no rows, no skeleton and no error", () => {
    for (const domain of ["skills", "apps", "mcp", "agents"] as const) {
      const markup = body({
        status: "pending",
        domain,
        cards: [card()],
        errorMessage: "boom",
      });
      assert.ok(markup.includes("plugins-surface-pending"), domain);
      assert.equal(markup.includes("plugins-surface-card-"), false, `${domain} fabricates no rows`);
      assert.equal(markup.includes("plugins-surface-skeleton-row"), false, `${domain} fakes no loading`);
      assert.equal(markup.includes("plugins-surface-error"), false, `${domain} shows no error`);
    }
  });

  test("the pending copy does not borrow the cloud or the engine-contract wording", () => {
    // `common.notLocal` means "needs a cloud account", `common.unsupported`
    // means "the engine contract has not landed". Neither is true here.
    for (const domain of ["skills", "apps", "mcp", "agents"] as const) {
      const body_ = translate("en", `plugins.area.${domain}.pending.body` as MessageKey);
      assert.notEqual(body_, translate("en", "common.notLocal"));
      assert.notEqual(body_, translate("en", "common.unsupported"));
    }
  });
});

describe("plugins surface — the four contract states render", () => {
  test("loading shows skeleton rows and announces itself", () => {
    const markup = body({ status: "loading" });
    assert.ok(markup.includes('role="status"'));
    assert.ok(markup.includes(`aria-label="${enT("plugins.state.loading")}"`));
    assert.equal((markup.match(/plugins-surface-skeleton-row/g) ?? []).length, 3);
    assert.equal(markup.includes("plugins-surface-cards"), false);
  });

  test("empty says which of the two lists is empty", () => {
    assert.ok(
      body({ status: "empty", view: "market" }).includes(enT("plugins.state.empty.market")),
    );
    assert.ok(
      body({ status: "empty", view: "personal" }).includes(enT("plugins.state.empty.installed")),
    );
  });

  test("error shows the server's own text and a retry affordance", () => {
    const markup = body({ status: "error", errorMessage: "local Plugin is not installed" });
    assert.ok(markup.includes('role="alert"'));
    assert.ok(markup.includes(enT("plugins.state.error.title")));
    assert.ok(markup.includes("local Plugin is not installed"));
    assert.ok(markup.includes("plugins-surface-retry"));
  });

  test("an error with no message still says what happened", () => {
    const markup = body({ status: "error", errorMessage: "" });
    assert.ok(markup.includes(enT("plugins.state.error.body")));
  });

  test("success renders one card per row, marked with its sourceKind", () => {
    const markup = body({
      status: "success",
      view: "market",
      cards: projectPluginCards([marketplaceRow()], { view: "market", source: "local" }),
    });
    assert.ok(markup.includes('data-testid="plugins-surface-card-local-pack"'));
    assert.ok(markup.includes('data-source-kind="local"'));
    assert.ok(markup.includes("Local pack"));
    assert.ok(markup.includes(enT("plugins.source.local")));
  });

  test("the official market renders the notLocal copy, not a card and not an error", () => {
    for (const t of [enT, zhT]) {
      const markup = body({ status: "notLocal", view: "market", t });
      assert.ok(markup.includes("plugins-surface-notlocal"));
      assert.ok(markup.includes(t("plugins.market.official.notLocal.title")));
      assert.ok(markup.includes(t("plugins.market.official.notLocal.body")));
      assert.equal(markup.includes("plugins-surface-error"), false, "a designed state is not an incident");
      assert.equal(markup.includes("plugins-surface-cards"), false);
    }
  });
});

describe("plugins surface — card affordances", () => {
  test("a local market card offers no install button", () => {
    const markup = body({
      status: "success",
      view: "market",
      cards: [card({ canInstall: false, canToggle: false, canUninstall: false, installed: false })],
    });
    assert.equal(markup.includes("plugins-surface-install-"), false);
    assert.equal(markup.includes("plugins-surface-toggle-"), false);
    assert.equal(markup.includes("plugins-surface-uninstall-"), false);
  });

  test("an official market card that is not installed offers install", () => {
    const markup = body({
      status: "success",
      view: "market",
      cards: [card({ name: "cloud-pack", sourceKind: "official", installed: false, canInstall: true, canToggle: false, canUninstall: false })],
    });
    assert.ok(markup.includes("plugins-surface-install-cloud-pack"));
    assert.ok(markup.includes(enT("plugins.action.install")));
  });

  test("an installed card offers the toggle and the uninstall, and says it is installed", () => {
    const markup = body({
      status: "success",
      view: "personal",
      cards: [card({ name: "mcode-webui", enabled: true })],
    });
    assert.ok(markup.includes("plugins-surface-toggle-mcode-webui"));
    assert.ok(markup.includes("plugins-surface-uninstall-mcode-webui"));
    assert.ok(markup.includes("plugins-surface-card-installed"));
    assert.ok(markup.includes(`aria-label="${enT("plugins.action.disable")}"`), "an enabled card offers to disable");
  });

  test("a disabled card offers the other direction", () => {
    const markup = body({ status: "success", cards: [card({ enabled: false })] });
    assert.ok(markup.includes(`aria-label="${enT("plugins.action.enable")}"`));
  });

  test("only the capabilities that exist get a chip", () => {
    const markup = body({
      status: "success",
      cards: [card({ skillCount: 2, mcpServerCount: 0, appCount: 0, hookCount: 1 })],
    });
    assert.ok(markup.includes(`${enT("plugins.card.capability.skill")} 2`));
    assert.ok(markup.includes(`${enT("plugins.card.capability.hook")} 1`));
    assert.equal(markup.includes(enT("plugins.card.capability.mcp")), false);
    assert.equal(markup.includes(enT("plugins.card.capability.app")), false);
  });

  test("the standalone skills ride along with the local market page", () => {
    const markup = body({
      status: "success",
      view: "market",
      localSkills: [{ id: -42, name: "marginal-tracker", displayName: "Marginal tracker", added: true }],
    });
    assert.ok(markup.includes("plugins-surface-local-skills"));
    assert.ok(markup.includes("plugins-surface-skill-marginal-tracker"));
    assert.ok(markup.includes("Marginal tracker"));
  });

  test("a busy row is disabled while its mutation runs", () => {
    const markup = body({ status: "success", cards: [card()], busyName: "mcode-webui" });
    assert.ok(markup.includes("disabled"));
  });
});

describe("plugins surface — the container", () => {
  test("the plugins area opens in its loading state, on the local market", () => {
    const markup = renderToStaticMarkup(createElement(PluginsSurface, { t: enT }));
    assert.ok(markup.includes('data-area="plugins"'));
    assert.ok(markup.includes('data-status="loading"'));
    assert.ok(markup.includes("plugins-surface-skeleton-row"));
    assert.ok(markup.includes("plugins-surface-source-local"), "the source switch is present");
    assert.ok(markup.includes("plugins-surface-search"), "the filter bar is present");
    assert.ok(markup.includes("plugins-surface-import-open"), "the import entry is present");
  });

  test("opening a pending area shows its placeholder without the filter bar", () => {
    for (const initialArea of ["skills", "apps", "mcp", "agents"] as const) {
      const markup = renderToStaticMarkup(createElement(PluginsSurface, { t: enT, initialArea }));
      assert.ok(markup.includes(`data-area="${initialArea}"`));
      assert.ok(markup.includes('data-status="pending"'));
      assert.ok(markup.includes("plugins-surface-pending"));
      assert.equal(
        markup.includes("plugins-surface-search"),
        false,
        `${initialArea} has no list, so it offers no filter`,
      );
    }
  });

  test("the injected client is used, not the network layer", () => {
    // The container never fetches under SSR; this pins the seam itself —
    // the api prop is what a fixture replaces.
    const fake = fakeApi({ marketplace: { ok: true, plugins: [marketplaceRow()] } });
    const markup = renderToStaticMarkup(
      createElement(PluginsSurface, { t: enT, api: fake.api }),
    );
    assert.ok(markup.includes("plugins-surface"));
    assert.deepEqual(fake.calls, [], "no request escapes a static render");
  });

  test("the five areas are reachable from every one of them", () => {
    for (const initialArea of PLUGIN_AREAS) {
      const markup = renderToStaticMarkup(createElement(PluginsSurface, { t: enT, initialArea }));
      for (const area of PLUGIN_AREAS) {
        assert.ok(markup.includes(`plugins-surface-area-${area}`), `${initialArea} → ${area}`);
      }
    }
  });
});

// --- 4. the bilingual dictionary ---------------------------------------------

const NEW_KEYS = [
  "plugins.area.aria",
  "plugins.area.plugins",
  "plugins.area.skills",
  "plugins.area.apps",
  "plugins.area.mcp",
  "plugins.area.agents",
  ...PLUGIN_AREAS.filter(isPendingArea).flatMap((domain) => [
    `plugins.area.${domain}.pending.title`,
    `plugins.area.${domain}.pending.body`,
  ]),
  "plugins.view.aria",
  "plugins.view.market",
  "plugins.view.personal",
  "plugins.source.aria",
  "plugins.source.local",
  "plugins.source.official",
  "plugins.source.unknown",
  "plugins.search.aria",
  "plugins.search.placeholder",
  "plugins.category.aria",
  ...PLUGIN_CATEGORY_FILTERS.map((filter) => filter.labelKey),
  "plugins.action.install",
  "plugins.action.uninstall",
  "plugins.action.enable",
  "plugins.action.disable",
  "plugins.action.refresh",
  "plugins.action.retry",
  "plugins.action.import",
  "plugins.action.notLocal.notice",
  "plugins.card.installed",
  "plugins.card.capability.skill",
  "plugins.card.capability.mcp",
  "plugins.card.capability.app",
  "plugins.card.capability.hook",
  "plugins.state.loading",
  "plugins.state.empty.market",
  "plugins.state.empty.installed",
  "plugins.state.error.title",
  "plugins.state.error.body",
  "plugins.market.official.notLocal.title",
  "plugins.market.official.notLocal.body",
  "plugins.market.localSkills.title",
  "plugins.confirm.uninstall.title",
  "plugins.confirm.uninstall.body",
  "plugins.import.title",
  "plugins.import.url.aria",
  "plugins.import.url.placeholder",
  "plugins.import.preview",
  "plugins.import.submit",
  "plugins.import.empty",
  "plugins.import.canImport",
  "plugins.import.cannotImport",
  "plugins.import.size",
  "plugins.import.failed",
] as const;

describe("plugins surface — bilingual keys", () => {
  test("every key the surface uses is registered in both locales", () => {
    for (const key of NEW_KEYS) {
      for (const locale of ["en", "zh"] as const) {
        const value = translate(locale, key as MessageKey);
        assert.equal(typeof value, "string", `${locale}/${key}`);
        assert.ok(value.length > 0, `${locale}/${key} is empty`);
        assert.notEqual(value, key, `${locale}/${key} fell back to its own name`);
      }
    }
  });

  test("the English values contain no CJK", () => {
    // The 58-line regression: an en value that is really the zh text ships
    // a Chinese interface to an English user and no type error notices.
    for (const key of NEW_KEYS) {
      const value = translate("en", key as MessageKey);
      assert.equal(
        /[一-鿿]/.test(value),
        false,
        `${key} is Chinese on the English side: ${JSON.stringify(value)}`,
      );
    }
  });

  test("the Chinese values are not copies of the English ones", () => {
    for (const key of NEW_KEYS) {
      const zh = translate("zh", key as MessageKey);
      const en = translate("en", key as MessageKey);
      const same = zh === en;
      const legitimatelyShared = ["MCP", "Agents", "https://github.com/<owner>/<repo>"];
      assert.ok(
        !same || legitimatelyShared.includes(zh),
        `${key} has the same value in both locales`,
      );
    }
  });

  test("the two retired placeholders now describe a surface that exists", () => {
    for (const key of ["panel.plugins.placeholder", "workspaceTabs.plugins.placeholder"] as const) {
      const en = translate("en", key);
      assert.equal(/in progress/i.test(en), false, `${key} still says it is being built`);
      assert.equal(/[一-鿿]/.test(en), false);
    }
  });

  test("the component does not hard-code a user-visible Chinese string", () => {
    const source = readFileSync(
      resolve(here, "../components/plugins-surface.tsx"),
      "utf8",
    );
    // Strip the comment blocks, whose Chinese is documentation, and the
    // type literals, then look for a CJK run in code position.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const offenders = (code.match(/[一-鿿]+/g) ?? []);
    assert.deepEqual(offenders, [], `hard-coded Chinese in code: ${offenders.join(" | ")}`);
  });
});

// --- 5. the cross-slice contract, as a source-level tripwire ------------------

describe("plugins surface — slice discipline", () => {
  test("the row projection reads sourceKind and never the numeric source", () => {
    const source = readFileSync(
      resolve(here, "../components/plugins-surface.tsx"),
      "utf8",
    );
    const cardFn = source.slice(
      source.indexOf("export function toPluginCard"),
      source.indexOf("export function projectPluginCards"),
    );
    assert.ok(cardFn.length > 0, "toPluginCard is where a row becomes a card");
    assert.ok(/sourceKind/.test(cardFn), "sourceKind is what the card projects");
    assert.equal(
      /\.source\b(?!\w)/.test(cardFn),
      false,
      "the card was projected from a row's numeric `source`; use `sourceKind`",
    );
    // The projection must not fall back to the requested source, which
    // would relabel an unknown row as the side the tab happens to show.
    // The behavioural half of this rule is the "degrades to unknown" case
    // above; this pins that the fallback is not reintroduced here.
    assert.equal(
      /context\.source/.test(cardFn),
      false,
      "the card must not be relabelled with the side the tab is showing",
    );
  });

  test("the surface does not import the protocol package", () => {
    const source = readFileSync(
      resolve(here, "../components/plugins-surface.tsx"),
      "utf8",
    );
    // Comments legitimately name the package (to explain why it is absent);
    // only an import statement would be the violation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.equal(/from\s+"[^"]*@mavis\/protocol/.test(code), false);
    assert.equal(/import\s+"@mavis\/protocol/.test(code), false);
  });

  test("the two call sites forward the component instead of a stub", () => {
    for (const relative of ["../components/panels.tsx", "../components/workspace-tree-column.tsx"]) {
      const source = readFileSync(resolve(here, relative), "utf8");
      assert.ok(
        source.includes('from "./plugins-surface"'),
        `${relative} does not import the surface`,
      );
    }
    // The tree column keeps the attribute the column body is selected by.
    const column = readFileSync(resolve(here, "../components/workspace-tree-column.tsx"), "utf8");
    assert.ok(column.includes('data-testid="tree-surface-body-plugins"'));
    assert.ok(column.includes('data-active-surface="plugins"'));
  });
});
