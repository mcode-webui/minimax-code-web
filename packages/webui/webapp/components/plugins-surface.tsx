"use client";

/**
 * The plugin surface — five capability areas in one column (ticket 60,
 * dispatch 68 phase 1, slice B).
 *
 * `plugins` is real: the installed list, the local market and the GitHub
 * import have endpoints. The other four have none until phases 2-4, so they
 * render the desktop's page SHAPE (tab bar, centred card) and name what is
 * missing — not `common.notLocal` ("needs a cloud account") and not
 * `common.unsupported` ("the engine contract has not landed").
 *
 * The official market is a placeholder BY DECISION: the local edition cannot
 * resolve the cloud registry base URL, so the panel renders the notLocal copy
 * WITHOUT issuing a request — writing the call and catching the failure would
 * cost a 30 s timeout per visit and make a designed state look like an
 * incident. Official refusals (`PLUGIN_AUTH_REQUIRED`) are silent for the
 * same reason.
 *
 * `PluginsSurface` owns selection and effects; every decision about what a
 * state looks like is a pure function or a controlled component, which is
 * what the suite renders through `renderToStaticMarkup`. The `api` prop is
 * the test seam — the two call sites pass nothing and get the real client.
 */

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input as AntInput, Modal as AntModal, Select as AntSelect, Switch } from "antd";

import * as webuiApi from "../lib/api";
import type {
  InstalledPlugin,
  MarketplacePlugin,
  MarketplaceSkill,
  PluginCategory,
  PluginImportPreviewPayload,
  PluginMutationPayload,
  PluginSource,
  PluginSourceKind,
} from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import { Icon } from "./icons";

export type Translate = (key: MessageKey) => string;

/** The five capability areas, in the desktop reference's tab order. */
export type PluginArea = "plugins" | "skills" | "apps" | "mcp" | "agents";
/** The four areas that have no management endpoint yet (ticket 60 phases 2-4). */
export type PluginPendingArea = Exclude<PluginArea, "plugins">;
export type PluginView = "market" | "personal";

/**
 * The six states the surface can be in: the four the contract table asks
 * for, plus `pending` (reachable only by the four areas without an
 * endpoint) and `notLocal` (only by the official market).
 */
export type PluginSurfaceStatus =
  | "empty"
  | "loading"
  | "error"
  | "success"
  | "pending"
  | "notLocal";

/** Load phase behind the surface; the status is derived from it. */
export type PluginLoadPhase = "loading" | "idle" | "failed" | "notLocal";

/** The client seam. Defaults to the real module; tests pass a fixture. */
export type PluginSurfaceApi = Pick<
  typeof webuiApi,
  | "listInstalledPlugins"
  | "listMarketplacePlugins"
  | "refreshPlugins"
  | "enablePlugin"
  | "disablePlugin"
  | "installPlugin"
  | "uninstallPlugin"
  | "previewGithubPlugin"
  | "importGithubPlugin"
>;

export const PLUGIN_AREAS = ["plugins", "skills", "apps", "mcp", "agents"] as const;

const AREA_LABEL_KEYS: Record<PluginArea, MessageKey> = {
  plugins: "plugins.area.plugins",
  skills: "plugins.area.skills",
  apps: "plugins.area.apps",
  mcp: "plugins.area.mcp",
  agents: "plugins.area.agents",
};

/** One entry per area without an endpoint: what it will say once it lands. */
const PENDING_KEYS: Record<PluginPendingArea, { title: MessageKey; body: MessageKey }> = {
  skills: { title: "plugins.area.skills.pending.title", body: "plugins.area.skills.pending.body" },
  apps: { title: "plugins.area.apps.pending.title", body: "plugins.area.apps.pending.body" },
  mcp: { title: "plugins.area.mcp.pending.title", body: "plugins.area.mcp.pending.body" },
  agents: { title: "plugins.area.agents.pending.title", body: "plugins.area.agents.pending.body" },
};

export function areaLabelKey(area: PluginArea): MessageKey {
  return AREA_LABEL_KEYS[area];
}

/** The four areas whose management screen has not been built yet. */
export function isPendingArea(area: PluginArea): area is PluginPendingArea {
  return area !== "plugins";
}

export interface PluginCategoryFilter {
  readonly labelKey: MessageKey;
  /** Absent for the "all" option, which sends no `category` at all. */
  readonly value?: PluginCategory;
}

/**
 * The category dropdown of the market view. The ids are the runtime's
 * `MarketplaceCategory` numbers (protocol/src/local.ts:137-149) restated
 * here — the webapp has no `@mavis/protocol` dependency (dispatch 68 §3
 * pitfall 3) and `api.ts` already carries the numeric type.
 */
export const PLUGIN_CATEGORY_FILTERS: readonly PluginCategoryFilter[] = [
  { labelKey: "plugins.category.all" },
  { labelKey: "plugins.category.other", value: 0 },
  { labelKey: "plugins.category.office", value: 1 },
  { labelKey: "plugins.category.studio", value: 2 },
  { labelKey: "plugins.category.design", value: 3 },
  { labelKey: "plugins.category.code", value: 4 },
  { labelKey: "plugins.category.business", value: 5 },
  { labelKey: "plugins.category.sales", value: 6 },
  { labelKey: "plugins.category.productivity", value: 7 },
  { labelKey: "plugins.category.tools", value: 8 },
  { labelKey: "plugins.category.science", value: 9 },
  { labelKey: "plugins.category.education", value: 10 },
];

/** The id the dropdown reports for "all categories"; sent as no parameter. */
export const PLUGIN_CATEGORY_ALL = "all";

export function isOfficialFailureCode(code: string | null | undefined): boolean {
  return (
    code === "PLUGIN_AUTH_REQUIRED" ||
    code === "PLUGIN_AUTH_SYNC_TIMEOUT" ||
    code === "SCOPE_CHANGED"
  );
}

/**
 * Whether the market view may issue a request for this source. The
 * official market is the ONE honest placeholder: the cloud registry base
 * URL does not resolve locally. A function so the suite pins the decision
 * rather than discovering it at runtime, and so a later stage flips one
 * line.
 */
export function mayRequestMarketplace(source: PluginSource): boolean {
  return source !== "official";
}

export interface PluginCard {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /**
   * Read from the route's `sourceKind` string, never from the numeric
   * `source` (contract with slices A and C): the number is the runtime
   * enum and may be absent, the string is what the panel branches on.
   */
  readonly sourceKind: PluginSourceKind;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly skillCount: number;
  readonly mcpServerCount: number;
  readonly appCount: number;
  readonly hookCount: number;
  readonly canInstall: boolean;
  readonly canToggle: boolean;
  readonly canUninstall: boolean;
}

const zeroCounts = { skillCount: 0, mcpServerCount: 0, appCount: 0, hookCount: 0 };

/**
 * Project one wire row into the card the surface renders. Two product
 * rules live here rather than in JSX: a LOCAL row never offers "install"
 * (the runtime answers `LOCAL_PLUGIN_INSTALL_UNSUPPORTED`, which is
 * product semantics, not a fault), and an `unknown` side offers no
 * mutation at all — the runtime reads a missing source as "official" one
 * layer down.
 */
export function toPluginCard(
  raw: InstalledPlugin | MarketplacePlugin,
  context: { readonly view: PluginView; readonly source: PluginSource },
): PluginCard {
  const sourceKind: PluginSourceKind = raw.sourceKind ?? "unknown";
  const installed = "installExists" in raw ? raw.installExists : true;
  const counts = raw.capabilities ?? zeroCounts;
  const isPersonal = context.view === "personal";
  const actsOnOneSide = sourceKind !== "unknown";
  return {
    name: raw.name,
    title: raw.displayName || raw.name,
    description: raw.description ?? "",
    sourceKind,
    enabled: raw.enabled === true,
    installed,
    skillCount: counts.skillCount ?? 0,
    mcpServerCount: counts.mcpServerCount ?? 0,
    appCount: counts.appCount ?? 0,
    hookCount: counts.hookCount ?? 0,
    canInstall:
      context.view === "market" && !installed && sourceKind === "official",
    canToggle: isPersonal && actsOnOneSide,
    canUninstall: isPersonal && actsOnOneSide && installed,
  };
}

export function projectPluginCards(
  rows: readonly (InstalledPlugin | MarketplacePlugin)[],
  context: { readonly view: PluginView; readonly source: PluginSource },
): readonly PluginCard[] {
  return rows.map((row) => toPluginCard(row, context));
}

/** The `{pluginName, source}` pair a mutation needs; null when unknowable. */
export function toMutationTarget(
  card: PluginCard,
): { pluginName: string; source: PluginSource } | null {
  if (card.sourceKind === "unknown") return null;
  return { pluginName: card.name, source: card.sourceKind };
}

export type PluginActionOutcome =
  | { readonly kind: "applied"; readonly enabled: boolean; readonly installExists: boolean }
  | { readonly kind: "notLocal" }
  | { readonly kind: "failed"; readonly message: string; readonly code: string | null };

/**
 * How a mutation answer reaches the user. Official refusals are SILENT
 * (decision (c)) — they are the designed answer for a local edition, so
 * they render the notLocal notice rather than a red banner. Every other
 * code is a real failure and says so.
 */
export function pluginActionOutcome(
  payload: PluginMutationPayload,
  source: PluginSource,
): PluginActionOutcome {
  if (payload.ok) {
    return {
      kind: "applied",
      enabled: payload.enabled === true,
      installExists: payload.installExists === true,
    };
  }
  const code = payload.code ?? null;
  if (source === "official" || isOfficialFailureCode(code)) return { kind: "notLocal" };
  return { kind: "failed", message: payload.error ?? "", code };
}

/** The filter a cursor is bound to; a cursor is only reusable within one. */
export interface PluginFilter {
  readonly keyword: string;
  readonly category: PluginCategory | null;
  readonly source: PluginSource | null;
  readonly view: PluginView;
}

/**
 * Whether the cursor must be dropped. `PLUGIN_CURSOR_INVALID` answers 400
 * and `api.ts` cannot read the code back off a non-2xx, so the panel
 * cannot recover by parsing the failure — resetting the cursor on every
 * filter change is the only defence the contract allows (slice C §1).
 */
export function shouldResetCursor(
  previous: PluginFilter,
  next: PluginFilter,
): boolean {
  return (
    previous.keyword !== next.keyword ||
    previous.category !== next.category ||
    previous.source !== next.source ||
    previous.view !== next.view
  );
}

export interface PluginListResult {
  readonly phase: PluginLoadPhase;
  readonly cards: readonly PluginCard[];
  readonly localSkills: readonly MarketplaceSkill[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly errorMessage: string;
  readonly code: string | null;
}

const emptyResult = (
  phase: PluginLoadPhase,
  extra: Partial<PluginListResult> = {},
): PluginListResult => ({
  phase,
  cards: [],
  localSkills: [],
  nextCursor: null,
  total: null,
  errorMessage: "",
  code: null,
  ...extra,
});

export interface PluginListRequest {
  readonly view: PluginView;
  readonly source: PluginSource;
  readonly keyword: string;
  readonly category: PluginCategory | null;
  readonly cursor?: string;
}

/** One list load, with every branch the contract table names. */
export async function loadPluginList(
  client: PluginSurfaceApi,
  request: PluginListRequest,
): Promise<PluginListResult> {
  if (request.view === "market" && !mayRequestMarketplace(request.source)) {
    return emptyResult("notLocal");
  }
  // A whitespace-only box is an empty box: sending it would ask the
  // runtime to filter on a keyword nobody can see.
  const keyword = request.keyword.trim() || undefined;
  const isMarket = request.view === "market";
  const failed = (error?: string, code?: string) =>
    emptyResult("failed", { errorMessage: error ?? "", code: code ?? null });
  try {
    if (isMarket) {
      const payload = await client.listMarketplacePlugins({
        source: request.source,
        keyword,
        cursor: request.cursor,
        category: request.category ?? undefined,
      });
      if (!payload.ok) return failed(payload.error, payload.code);
      return {
        phase: "idle",
        cards: projectPluginCards(payload.plugins ?? [], {
          view: "market",
          source: request.source,
        }),
        localSkills: payload.marketplaceSkills ?? [],
        nextCursor: payload.nextCursor ?? null,
        total: payload.pluginTotal ?? null,
        errorMessage: "",
        code: null,
      };
    }
    const payload = await client.listInstalledPlugins({ keyword, cursor: request.cursor });
    if (!payload.ok) return failed(payload.error, payload.code);
    return {
      phase: "idle",
      cards: projectPluginCards(payload.plugins ?? [], {
        view: "personal",
        source: request.source,
      }),
      localSkills: [],
      nextCursor: payload.nextCursor ?? null,
      total: null,
      errorMessage: "",
      code: null,
    };
  } catch (cause) {
    // A rejected request (400 cursor, 403 read-only, 413) arrives as a
    // thrown Error whose message is the server's own text.
    return emptyResult("failed", {
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** The single place the visible state is decided; no component decides it. */
export function derivePluginStatus(input: {
  readonly domain: PluginArea;
  readonly view: PluginView;
  readonly source: PluginSource;
  readonly phase: PluginLoadPhase;
  readonly cardCount: number;
}): PluginSurfaceStatus {
  if (isPendingArea(input.domain)) return "pending";
  if (input.view === "market" && !mayRequestMarketplace(input.source)) return "notLocal";
  if (input.phase === "loading") return "loading";
  if (input.phase === "failed") return "error";
  return input.cardCount === 0 ? "empty" : "success";
}

export interface PluginImportPreviewState {
  readonly preview: PluginImportPreviewPayload | null;
  readonly canImport: boolean;
  readonly errorMessage: string;
}

/** The dry run behind the import dialog. Reads the public repository. */
export async function runPluginImportPreview(
  client: PluginSurfaceApi,
  url: string,
): Promise<PluginImportPreviewState> {
  const refused = (errorMessage: string) => ({
    preview: null,
    canImport: false,
    errorMessage,
  });
  try {
    const preview = await client.previewGithubPlugin(url);
    if (!preview.ok) return refused(preview.error ?? "");
    return { preview, canImport: preview.canImport === true, errorMessage: "" };
  } catch (cause) {
    return refused(cause instanceof Error ? cause.message : String(cause));
  }
}

export interface PluginImportState {
  readonly ok: boolean;
  readonly errorMessage: string;
}

/** Commit the previewed package. The answer carries the plugin, enabled. */
export async function runPluginImport(
  client: PluginSurfaceApi,
  preview: PluginImportPreviewPayload,
): Promise<PluginImportState> {
  if (!preview.source) return { ok: false, errorMessage: "" };
  try {
    const payload = await client.importGithubPlugin(preview.source);
    if (!payload.ok) return { ok: false, errorMessage: payload.error ?? "" };
    return { ok: true, errorMessage: "" };
  } catch (cause) {
    return {
      ok: false,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

const chipClass =
  "inline-flex items-center gap-1 rounded-[6px] bg-bg_interaction_tertiary_hover px-1.5 py-0.5 text-caption-small-strong text-text_default_secondary";
const secondaryButtonClass =
  "rounded-[8px] border border-border_default px-2 py-1 text-caption-small-strong text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary disabled:opacity-50";
const cardClass =
  "flex flex-col gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated p-3";

function NoticeCard({
  testId,
  title,
  body,
  icon,
  role,
  action,
}: {
  testId: string;
  title: string;
  body: string;
  icon?: React.ReactNode;
  /** `alert` only where a failure must be announced rather than shown. */
  role?: "status" | "alert";
  /** The branch's own affordance — the retry button is the only one. */
  action?: React.ReactNode;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      className="flex flex-col items-center gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-4 py-6 text-center"
    >
      {icon ? (
        <span
          className="flex size-8 items-center justify-center rounded-full bg-bg_interaction_tertiary_hover text-icon_default_tertiary"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <h3 className="desktop-text-dialog-medium text-base font-medium leading-6 text-text_default_primary">
        {title}
      </h3>
      <p className="max-w-[420px] break-words text-caption-small-strong text-text_default_tertiary">
        {body}
      </p>
      {action}
    </div>
  );
}

/** The five capability areas. Controlled: the container owns `area`. */
export function PluginAreaTabBar({
  area,
  onPickArea,
  t,
}: {
  area: PluginArea;
  onPickArea?: (area: PluginArea) => void;
  t: Translate;
}) {
  return (
    <div
      role="tablist"
      aria-label={t("plugins.area.aria")}
      data-testid="plugins-surface-areas"
      className="flex flex-wrap gap-1"
    >
      {PLUGIN_AREAS.map((item) => {
        const active = item === area;
        return (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={active}
            data-active={active}
            data-testid={`plugins-surface-area-${item}`}
            onClick={() => onPickArea?.(item)}
            className={[
              "rounded-[8px] px-2.5 py-1 text-caption-small-strong transition-colors",
              active
                ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
                : "text-text_default_tertiary hover:text-text_default_secondary",
            ].join(" ")}
          >
            {t(areaLabelKey(item))}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What a domain without an endpoint shows: the desktop's centred
 * explanation card, stating the real reason. Deliberately NOT
 * `common.notLocal` (cloud account) and NOT `common.unsupported` (engine
 * contract) — neither describes "a later phase has not built this screen".
 */
export function PluginAreaPendingBody({
  domain,
  t,
}: {
  domain: PluginPendingArea;
  t: Translate;
}) {
  const copy = PENDING_KEYS[domain];
  return (
    <div data-testid="plugins-surface-pending" data-pending-area={domain}>
      <NoticeCard
        testId="plugins-surface-pending-card"
        title={t(copy.title)}
        body={t(copy.body)}
        icon={<Icon name="plugins" size={16} />}
      />
    </div>
  );
}

const CAPABILITY_CHIPS: readonly { key: MessageKey; read: (card: PluginCard) => number }[] = [
  { key: "plugins.card.capability.skill", read: (card) => card.skillCount },
  { key: "plugins.card.capability.mcp", read: (card) => card.mcpServerCount },
  { key: "plugins.card.capability.app", read: (card) => card.appCount },
  { key: "plugins.card.capability.hook", read: (card) => card.hookCount },
];

/** Only non-zero counts render — a zero chip is noise, not information. */
function CapabilityChips({ card, t }: { card: PluginCard; t: Translate }) {
  const visible = CAPABILITY_CHIPS.filter((chip) => chip.read(card) > 0);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="plugins-surface-card-capabilities">
      {visible.map((chip) => (
        <span key={chip.key} data-capability={chip.key} className={chipClass}>
          {t(chip.key)} {chip.read(card)}
        </span>
      ))}
    </div>
  );
}

/** Controlled body: a chosen state rendered IS the behaviour under test. */
export function PluginSurfaceBody({
  status,
  domain,
  view,
  t,
  cards,
  localSkills,
  errorMessage,
  busyName,
  onToggle,
  onUninstall,
  onInstall,
  onRetry,
}: {
  status: PluginSurfaceStatus;
  domain: PluginArea;
  view: PluginView;
  t: Translate;
  cards: readonly PluginCard[];
  localSkills: readonly MarketplaceSkill[];
  errorMessage: string;
  busyName: string | null;
  onToggle?: (card: PluginCard) => void;
  onUninstall?: (card: PluginCard) => void;
  onInstall?: (card: PluginCard) => void;
  onRetry?: () => void;
}) {
  if (isPendingArea(domain)) {
    return <PluginAreaPendingBody domain={domain} t={t} />;
  }
  if (status === "notLocal") {
    return (
      <NoticeCard
        testId="plugins-surface-notlocal"
        title={t("plugins.market.official.notLocal.title")}
        body={t("plugins.market.official.notLocal.body")}
        icon={<Icon name="info" size={16} />}
      />
    );
  }
  if (status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t("plugins.state.loading")}
        data-testid="plugins-surface-loading"
        className="flex flex-col gap-2"
      >
        {[0, 1, 2].map((row) => (
          <div key={row} className={cardClass} data-testid="plugins-surface-skeleton-row">
            <div className="h-3 w-2/5 rounded-[4px] bg-bg_interaction_tertiary_hover" />
            <div className="h-2.5 w-4/5 rounded-[4px] bg-bg_interaction_tertiary_hover" />
          </div>
        ))}
      </div>
    );
  }
  if (status === "error") {
    return (
      <NoticeCard
        testId="plugins-surface-error"
        role="alert"
        title={t("plugins.state.error.title")}
        body={errorMessage || t("plugins.state.error.body")}
        action={
          <button
            type="button"
            data-testid="plugins-surface-retry"
            onClick={() => onRetry?.()}
            className={secondaryButtonClass}
          >
            {t("plugins.action.retry")}
          </button>
        }
      />
    );
  }
  if (status === "empty") {
    return (
      <div
        data-testid="plugins-surface-empty"
        data-empty-view={view}
        className="rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-4 py-6 text-center"
      >
        <p className="text-caption-small-strong text-text_default_tertiary">
          {view === "market" ? t("plugins.state.empty.market") : t("plugins.state.empty.installed")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="plugins-surface-success">
      <ul
        data-testid="plugins-surface-cards"
        className="grid grid-cols-1 gap-2 xl:grid-cols-2"
      >
        {cards.map((card) => (
          <li
            key={card.name}
            data-testid={`plugins-surface-card-${card.name}`}
            data-source-kind={card.sourceKind}
            data-enabled={card.enabled}
            data-installed={card.installed}
            className={cardClass}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium leading-5 text-text_default_primary">
                {card.title}
              </p>
              <p className="truncate text-caption-small-strong text-text_default_tertiary">
                {card.name}
              </p>
            </div>
            {card.description ? (
              <p className="line-clamp-2 text-caption-small-strong text-text_default_secondary">
                {card.description}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              <span className={chipClass} data-testid="plugins-surface-card-source">
                {card.sourceKind === "local"
                  ? t("plugins.source.local")
                  : card.sourceKind === "official"
                    ? t("plugins.source.official")
                    : t("plugins.source.unknown")}
              </span>
              {card.installed ? (
                <span className={chipClass} data-testid="plugins-surface-card-installed">
                  {t("plugins.card.installed")}
                </span>
              ) : null}
              <CapabilityChips card={card} t={t} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {card.canInstall ? (
                <button
                  type="button"
                  data-testid={`plugins-surface-install-${card.name}`}
                  disabled={busyName === card.name}
                  onClick={() => onInstall?.(card)}
                  className={secondaryButtonClass}
                >
                  {t("plugins.action.install")}
                </button>
              ) : null}
              {card.canToggle ? (
                <Switch
                  size="small"
                  checked={card.enabled}
                  disabled={busyName === card.name}
                  data-testid={`plugins-surface-toggle-${card.name}`}
                  aria-label={card.enabled ? t("plugins.action.disable") : t("plugins.action.enable")}
                  onChange={() => onToggle?.(card)}
                />
              ) : null}
              {card.canUninstall ? (
                <button
                  type="button"
                  data-testid={`plugins-surface-uninstall-${card.name}`}
                  disabled={busyName === card.name}
                  onClick={() => onUninstall?.(card)}
                  className={secondaryButtonClass}
                >
                  {t("plugins.action.uninstall")}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {localSkills.length > 0 ? (
        <section data-testid="plugins-surface-local-skills" className="flex flex-col gap-2">
          <h4 className="desktop-text-ui-body text-sm font-medium leading-5 text-text_default_primary">
            {t("plugins.market.localSkills.title")}
          </h4>
          <ul className="flex flex-col gap-1">
            {localSkills.map((skill) => (
              <li
                key={skill.id}
                data-testid={`plugins-surface-skill-${skill.name}`}
                className="flex items-center justify-between gap-2 rounded-[8px] border border-border_default px-2.5 py-1.5"
              >
                <span className="min-w-0 truncate text-caption-small-strong text-text_default_primary">
                  {skill.displayName || skill.name}
                </span>
                {skill.added ? <span className={chipClass}>{t("plugins.card.installed")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export interface PluginsSurfaceProps {
  t: Translate;
  /** Fixture seam. Omitted in the app, which then talks to the real client. */
  api?: PluginSurfaceApi;
  initialArea?: PluginArea;
}

/**
 * The stateful shell: selection, effects, mutations and the two dialogs.
 * Everything it decides about *appearance* is delegated to the pure
 * functions above, so the suite covers the states without React effects.
 */
export function PluginsSurface({
  t,
  api,
  initialArea = "plugins",
}: PluginsSurfaceProps) {
  const client = api ?? webuiApi;
  const [area, setArea] = useState<PluginArea>(initialArea);
  const [view, setView] = useState<PluginView>("market");
  // The local market is the default: the runtime reads a missing `source`
  // as "official" (desktop-facade.ts:763), which is a cloud call this
  // edition cannot make (dispatch 68 §3 pitfall 6).
  const [source, setSource] = useState<PluginSource>("local");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<PluginCategory | null>(null);
  // The one result shape the container and the pure layer both speak, so
  // there is a single empty state rather than two that can disagree.
  const [list, setList] = useState<PluginListResult>(emptyResult("loading"));
  const [busyName, setBusyName] = useState<string | null>(null);
  const [notice, setNotice] = useState<"notLocal" | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingUninstall, setPendingUninstall] = useState<PluginCard | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importPreview, setImportPreview] = useState<PluginImportPreviewState>({
    preview: null,
    canImport: false,
    errorMessage: "",
  });
  const [importBusy, setImportBusy] = useState(false);

  const generationRef = useRef(0);
  const cursorRef = useRef<string | undefined>(undefined);
  const filterRef = useRef<PluginFilter>({
    keyword: "",
    category: null,
    source: "local",
    view: "market",
  });

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    // A pending area has no endpoint: the placeholder IS its whole state.
    if (isPendingArea(area)) return;
    const filter: PluginFilter = {
      keyword,
      category,
      source: view === "market" ? source : null,
      view,
    };
    if (shouldResetCursor(filterRef.current, filter)) cursorRef.current = undefined;
    filterRef.current = filter;
    if (view === "market" && !mayRequestMarketplace(source)) {
      setList(emptyResult("notLocal"));
      return;
    }
    setList((previous) => ({ ...previous, phase: "loading", errorMessage: "" }));
    const result = await loadPluginList(client, {
      view,
      source,
      keyword,
      category,
      cursor: cursorRef.current,
    });
    // A superseded load must not paint over the one that replaced it.
    if (generation !== generationRef.current) return;
    cursorRef.current = result.nextCursor ?? undefined;
    setList(result);
  }, [area, view, source, keyword, category, client]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load, reloadToken]);

  const status = derivePluginStatus({
    domain: area,
    view,
    source,
    phase: list.phase,
    cardCount: list.cards.length,
  });

  const runMutation = useCallback(
    async (
      card: PluginCard,
      action: (target: { pluginName: string; source: PluginSource }) => Promise<PluginMutationPayload>,
    ) => {
      const target = toMutationTarget(card);
      if (!target) return;
      setBusyName(card.name);
      setNotice(null);
      try {
        const outcome = pluginActionOutcome(await action(target), target.source);
        if (outcome.kind === "notLocal") {
          setNotice("notLocal");
        } else if (outcome.kind === "failed") {
          setList((previous) => ({
            ...previous,
            errorMessage: outcome.message,
            phase: "failed",
          }));
        }
        setReloadToken((token) => token + 1);
      } catch (cause) {
        setList((previous) => ({
          ...previous,
          errorMessage: cause instanceof Error ? cause.message : String(cause),
          phase: "failed",
        }));
      } finally {
        setBusyName(null);
      }
    },
    [],
  );

  const previewImport = async () => {
    setImportBusy(true);
    setImportPreview(await runPluginImportPreview(client, importUrl.trim()));
    setImportBusy(false);
  };

  const commitImport = async () => {
    if (!importPreview.preview) return;
    setImportBusy(true);
    const result = await runPluginImport(client, importPreview.preview);
    setImportBusy(false);
    if (!result.ok) {
      setImportPreview({ preview: null, canImport: false, errorMessage: result.errorMessage });
      return;
    }
    setImportOpen(false);
    setImportUrl("");
    setImportPreview({ preview: null, canImport: false, errorMessage: "" });
    setReloadToken((token) => token + 1);
  };

  const categoryOptions = useMemo(
    () =>
      PLUGIN_CATEGORY_FILTERS.map((filter) => ({
        value: filter.value === undefined ? PLUGIN_CATEGORY_ALL : String(filter.value),
        label: t(filter.labelKey),
      })),
    [t],
  );

  return (
    <section
      data-testid="plugins-surface"
      data-area={area}
      data-status={status}
      className="flex min-h-0 flex-col gap-3"
    >
      <PluginAreaTabBar area={area} onPickArea={setArea} t={t} />
      {isPendingArea(area) ? (
        <PluginAreaPendingBody domain={area} t={t} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1" role="group" aria-label={t("plugins.view.aria")}>
              {(["market", "personal"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={view === item}
                  data-testid={`plugins-surface-view-${item}`}
                  onClick={() => setView(item)}
                  className={[
                    "rounded-[8px] px-2.5 py-1 text-caption-small-strong transition-colors",
                    view === item
                      ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
                      : "text-text_default_tertiary hover:text-text_default_secondary",
                  ].join(" ")}
                >
                  {t(item === "market" ? "plugins.view.market" : "plugins.view.personal")}
                </button>
              ))}
            </div>
            {view === "market" ? (
              <div className="flex gap-1" role="group" aria-label={t("plugins.source.aria")}>
                {(["local", "official"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={source === item}
                    data-testid={`plugins-surface-source-${item}`}
                    onClick={() => setSource(item)}
                    className={[
                      "rounded-[8px] px-2.5 py-1 text-caption-small-strong transition-colors",
                      source === item
                        ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
                        : "text-text_default_tertiary hover:text-text_default_secondary",
                    ].join(" ")}
                  >
                    {t(item === "local" ? "plugins.source.local" : "plugins.source.official")}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="min-w-[120px] flex-1">
              <AntInput
                size="small"
                allowClear
                value={keyword}
                data-testid="plugins-surface-search"
                aria-label={t("plugins.search.aria")}
                placeholder={t("plugins.search.placeholder")}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </div>
            {view === "market" ? (
              <AntSelect
                size="small"
                className="min-w-[110px]"
                data-testid="plugins-surface-category"
                aria-label={t("plugins.category.aria")}
                value={category === null ? PLUGIN_CATEGORY_ALL : String(category)}
                options={categoryOptions}
                onChange={(value) =>
                  setCategory(
                    value === PLUGIN_CATEGORY_ALL
                      ? null
                      : (Number(value) as PluginCategory),
                  )
                }
              />
            ) : null}
            <button
              type="button"
              aria-label={t("plugins.action.refresh")}
              title={t("plugins.action.refresh")}
              data-testid="plugins-surface-refresh"
              onClick={() => setReloadToken((token) => token + 1)}
              className="flex size-7 flex-none items-center justify-center rounded-[8px] text-icon_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              type="button"
              data-testid="plugins-surface-import-open"
              onClick={() => setImportOpen(true)}
              className={secondaryButtonClass}
            >
              {t("plugins.action.import")}
            </button>
          </div>
          {notice === "notLocal" ? (
            <p
              role="status"
              data-testid="plugins-surface-notlocal-notice"
              className="rounded-[8px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-2 text-caption-small-strong text-text_default_secondary"
            >
              {t("plugins.action.notLocal.notice")}
            </p>
          ) : null}
          <PluginSurfaceBody
            status={status}
            domain={area}
            view={view}
            t={t}
            cards={list.cards}
            localSkills={list.localSkills}
            errorMessage={list.errorMessage}
            busyName={busyName}
            onToggle={(card) =>
              void runMutation(card, (target) =>
                card.enabled ? client.disablePlugin(target.pluginName, target.source) : client.enablePlugin(target.pluginName, target.source),
              )
            }
            onUninstall={(card) => setPendingUninstall(card)}
            onInstall={(card) =>
              void runMutation(card, (target) =>
                client.installPlugin(target.pluginName, target.source),
              )
            }
            onRetry={() => setReloadToken((token) => token + 1)}
          />
        </>
      )}
      <AntModal
        open={pendingUninstall !== null}
        title={t("plugins.confirm.uninstall.title")}
        okText={t("plugins.action.uninstall")}
        cancelText={t("common.cancel")}
        onCancel={() => setPendingUninstall(null)}
        onOk={() => {
          const card = pendingUninstall;
          setPendingUninstall(null);
          if (card) {
            void runMutation(card, (target) =>
              client.uninstallPlugin(target.pluginName, target.source),
            );
          }
        }}
      >
        <p className="text-caption-small-strong text-text_default_secondary">
          {t("plugins.confirm.uninstall.body")}
        </p>
      </AntModal>
      <AntModal
        open={importOpen}
        title={t("plugins.import.title")}
        okText={t("plugins.import.submit")}
        cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !importPreview.canImport || importBusy }}
        onCancel={() => setImportOpen(false)}
        onOk={() => void commitImport()}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <AntInput
              size="small"
              value={importUrl}
              data-testid="plugins-surface-import-url"
              aria-label={t("plugins.import.url.aria")}
              placeholder={t("plugins.import.url.placeholder")}
              onChange={(event) => setImportUrl(event.target.value)}
            />
            <button
              type="button"
              disabled={importBusy || importUrl.trim() === ""}
              data-testid="plugins-surface-import-preview"
              onClick={() => void previewImport()}
              className={secondaryButtonClass}
            >
              {t("plugins.import.preview")}
            </button>
          </div>
          {importPreview.preview ? (
            <div
              data-testid="plugins-surface-import-result"
              data-can-import={importPreview.canImport}
              className="flex flex-col gap-1"
            >
              <p className="text-sm text-text_default_primary">
                {importPreview.preview.plugin?.summary.displayName ||
                  importPreview.preview.plugin?.summary.name ||
                  ""}
              </p>
              <p className="text-caption-small-strong text-text_default_tertiary">
                {importPreview.canImport
                  ? t("plugins.import.canImport")
                  : t("plugins.import.cannotImport")}
              </p>
              {importPreview.preview.packageSizeBytes ? (
                <p className="text-caption-small-strong text-text_default_tertiary">
                  {t("plugins.import.size")} {Math.round(importPreview.preview.packageSizeBytes / 1024)} KB
                </p>
              ) : null}
            </div>
          ) : (
            <p
              data-testid="plugins-surface-import-empty"
              className="text-caption-small-strong text-text_default_tertiary"
            >
              {t("plugins.import.empty")}
            </p>
          )}
          {importPreview.errorMessage ? (
            <p
              role="alert"
              data-testid="plugins-surface-import-error"
              className="break-words text-caption-small-strong text-text_default_secondary"
            >
              {t("plugins.import.failed")} {importPreview.errorMessage}
            </p>
          ) : null}
        </div>
      </AntModal>
    </section>
  );
}
