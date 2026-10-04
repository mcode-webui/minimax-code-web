// webapp/lib/model-groups.ts
//
// Provider grouping + thinking-level derivations behind the composer's
// model selector, extracted as pure functions so the test suite exercises
// the PRODUCT code.
//
// Why this file exists: the grouping loop used to live inline inside
// `components/composer.tsx#ModelSelect` while `webapp/test/composer-models.test.ts`
// kept its own copy of the same loop. A test that re-implements the code
// it claims to pin cannot fail when the product code breaks — the suite
// stayed green through a regression in exactly the places red line ⑤
// (provider grouping + thinking levels) is meant to defend. Same motive
// and same precedent as `lib/effort-control.ts`.
//
// The code below is the composer logic verbatim with its inputs named;
// behaviour is unchanged by the move.

import type { MessageKey } from "./i18n";

/** The bucket provider-less catalogue entries land in. */
export const OTHER_PROVIDER_ID = "__other";

/**
 * A catalogue entry as `/api/models` sends it.
 *
 * Only the fields the grouping and the thinking derivations read are
 * required; the selector's wider shape (context window options, …)
 * satisfies this structural type unchanged.
 */
export interface SelectableModel {
  id: string;
  label: string;
  provider?: string;
  modalities?: string[];
  thinkingLevels?: string[];
}

/** The per-provider metadata `GET /api/models#groups` carries. */
export interface ProviderGroupMeta {
  id: string;
  label: string;
  auth?: { hasKey: boolean; type: "byok" | "coding-plan" };
}

/** One provider section of the model selector. */
export interface ModelProviderGroup<M extends SelectableModel = SelectableModel> {
  id: string;
  label: string;
  models: M[];
  auth?: { hasKey: boolean; type: "byok" | "coding-plan" };
  /**
   * Per-row no-key verdict, for a section that mixes providers — today only
   * the favourites section, which pulls starred models out of groups with
   * different `auth` verdicts and therefore cannot carry one of its own.
   * Absent on every real provider group, where `auth` is the whole answer.
   */
  disabledModelIds?: ReadonlySet<string>;
}

/**
 * Bucket the flat catalogue by provider, preserving catalogue order.
 *
 * Providers appear in the order their first model shows up; catalogue
 * order is preserved inside each bucket. A provider-less entry (an
 * engine-encoded id whose prefix wasn't coerced) lands in the
 * `__other` bucket so it is still reachable from the menu.
 *
 * `groups` is the server-resolved metadata: its `label` wins over the
 * `labelFor` heuristic, and its `auth` view rides along so the caller
 * can grey a no-key provider.
 */
export function groupModelsByProvider<M extends SelectableModel>(
  models: readonly M[],
  groups: readonly ProviderGroupMeta[],
  otherLabel: string,
  labelFor: (id: string) => string = providerLabel,
): Array<ModelProviderGroup<M>> {
  const order: string[] = [];
  const buckets = new Map<string, ModelProviderGroup<M>>();
  for (const model of models) {
    const key = model.provider ?? OTHER_PROVIDER_ID;
    if (!buckets.has(key)) {
      const meta = groups.find((g) => g.id === key);
      buckets.set(key, {
        id: key,
        label: key === OTHER_PROVIDER_ID ? otherLabel : (meta?.label ?? labelFor(key)),
        models: [],
        auth: meta?.auth,
      });
      order.push(key);
    }
    buckets.get(key)!.models.push(model);
  }
  return order.map((key) => buckets.get(key)!);
}

/**
 * The provider id a model belongs to — `__other` for provider-less
 * entries, and `__other` when the id is not in the catalogue at all.
 *
 * Drives the ✓ marker on the provider row and the scroll-into-view
 * target, so it must agree with `groupModelsByProvider`'s key.
 */
export function providerIdOfModel<M extends Pick<SelectableModel, "id" | "provider">>(
  models: readonly M[],
  activeId: string | null | undefined,
): string {
  const value = activeId ?? "";
  const model = value ? models.find((m) => m.id === value) : undefined;
  return model?.provider ?? OTHER_PROVIDER_ID;
}

/**
 * True when a provider group should render greyed.
 *
 * Groups with `auth.hasKey === false` cannot reach their models — every
 * pick would 401/403. The engine session group (`__engine`) does not
 * carry `auth` at all; it is always usable because the engine has
 * already authenticated against its own credentials.
 */
export function isGroupDisabled(group: Pick<ModelProviderGroup, "auth">): boolean {
  if (!group.auth) return false;
  return group.auth.hasKey === false;
}

/** The provider id of the built-in MiniMax catalogue. */
export const MINIMAX_PROVIDER_ID = "minimax_api";

/**
 * True when a model id names a built-in MiniMax model.
 *
 * The wire id's provider PREFIX decides it, not the account and not the
 * model name. An account may be subscribed and still be driving a foreign
 * model; only the id says whose usage a MiniMax-metered figure is about.
 *
 * An unreadable shape HIDES rather than guesses, and the failure directions
 * are not symmetric: treating an unknown id as MiniMax would meter the
 * wrong account's plan. So a missing separator (`glm-5.3`, no provider), a
 * trailing separator (`minimax_api/`, which names no model) and an empty id
 * are all false. `__engine/m:minimax_api:…` is false as well: the engine's
 * own encoded id is not the built-in catalogue, and the plan figures do not
 * describe it.
 *
 * One definition of the fact, shared by the two surfaces that need it: the
 * favourites ordering in this file and the plan section's gate
 * (`context-breakdown.ts#showPlanSection`).
 */
export function isBuiltinMiniMaxModel(modelId: string | null | undefined): boolean {
  const value = (modelId ?? "").trim();
  if (!value) return false;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  return value.slice(0, slash) === MINIMAX_PROVIDER_ID;
}

/** The section id the favourites list renders under. */
export const FAVORITES_SECTION_ID = "__favorites";

/**
 * The order the favourites section lists its models in: built-in MiniMax
 * first, then everything else by display name.
 *
 * MiniMax leads because it is the provider whose models the account's own
 * plan meters — the one a starred list is most likely being read to reach.
 * The rest sort by the name the user sees (`label`), not by the id they
 * never see, and the id breaks a tie so two models with the same label
 * cannot swap places between renders.
 *
 * `localeCompare` rather than `<`: the comparison has to survive a label
 * that is not ASCII, and it has to be stable, or the list reshuffles on
 * every open.
 */
function compareFavoriteModels<M extends SelectableModel>(a: M, b: M): number {
  const aBuiltin = isBuiltinMiniMaxModel(a.id);
  const bBuiltin = isBuiltinMiniMaxModel(b.id);
  if (aBuiltin !== bBuiltin) return aBuiltin ? -1 : 1;
  const byName = (a.label || a.id).localeCompare(b.label || b.id);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

/**
 * Hoist starred models into a section of their own, above the providers.
 *
 * The starred models are REMOVED from the provider groups they came from, so
 * a starred model is listed once and once only — a model appearing both at
 * the top and in its provider would make "starred" mean nothing. A group
 * left with no models is dropped rather than rendered as an empty header.
 *
 * The favourites section spans providers, so it cannot carry a single
 * `auth` verdict: a starred model whose provider has no key still 401s on
 * pick. Those ids come back in `disabledModelIds` so the caller can grey
 * that row without greying its neighbours.
 *
 * With nothing starred the input comes back unchanged (same group objects,
 * same order) — the common case must not allocate a section nobody sees.
 *
 * Re-applying this to its own output is safe: the favourites section is
 * rebuilt from its own members rather than dropped or duplicated. The
 * composer never does that (it filters the raw grouping and orders that),
 * but a function that quietly eats its own section on a second pass is a
 * trap for the next caller.
 */
export function orderModelGroups<M extends SelectableModel>(
  groups: readonly ModelProviderGroup<M>[],
  favoriteIds: ReadonlySet<string>,
  favoritesLabel: string,
): Array<ModelProviderGroup<M>> {
  if (favoriteIds.size === 0) return groups as Array<ModelProviderGroup<M>>;

  const starred: M[] = [];
  const disabledModelIds = new Set<string>();
  const rest: Array<ModelProviderGroup<M>> = [];
  for (const group of groups) {
    // An input that is ALREADY hoisted (a re-order) must not lose its
    // favourites section: skipping the group would drop every starred model
    // on the floor, and dropping the section instead would render a starred
    // model under a provider header — both worse than recomputing. Its
    // models are starred by construction, so they go back into `starred`
    // whether or not the caller's set still says so.
    const alreadyHoisted = group.id === FAVORITES_SECTION_ID;
    const disabled = isGroupDisabled(group);
    const keep: M[] = [];
    for (const model of group.models) {
      if (!alreadyHoisted && !favoriteIds.has(model.id)) {
        keep.push(model);
        continue;
      }
      starred.push(model);
      if (disabled) disabledModelIds.add(model.id);
    }
    if (keep.length > 0) rest.push({ ...group, models: keep });
  }
  if (starred.length === 0) return rest;

  return [
    {
      id: FAVORITES_SECTION_ID,
      label: favoritesLabel,
      models: starred.sort(compareFavoriteModels),
      disabledModelIds,
    },
    ...rest,
  ];
}

/**
 * Lowercase and drop everything that is not a letter or a digit.
 *
 * Both sides of a comparison go through this, which is what makes `glm5.3`,
 * `glm-5.3` and `GLM 5.3` the same query. Separators are the difference
 * between a model id and the way a user remembers it, so they cannot be
 * allowed to decide whether a model is found.
 */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * True when every character of `needle` appears in `haystack` in order,
 * not necessarily adjacent.
 *
 * This is the "fuzzy" in 「模型搜索」. A substring test is not enough: the
 * catalogue is full of ids like `minimax_api/MiniMax-M3` and `glm-5.3`, and
 * nobody types the provider prefix or remembers the exact casing. `mm3`
 * and `glm53` are what a user actually writes, and neither is a substring
 * of anything.
 *
 * There is deliberately NO special case for a one-character query, and the
 * reason is worth recording because it looks like a gap. For a single
 * character, "appears in order" and "appears at all" are the SAME
 * predicate — there is nothing to be stricter about. An earlier draft of
 * this file added a "one character must match contiguously" branch; it was
 * a no-op, and the test written to pin it passed for an unrelated reason
 * (the fixture happened to contain no such character at all). So `a`
 * matches every model whose name contains an `a`, which is what typing one
 * character has always meant everywhere else in the product.
 */
export function fuzzyMatches(haystack: string, needle: string): boolean {
  const q = normalizeForMatch(needle);
  if (!q) return true;
  const h = normalizeForMatch(haystack);
  let at = 0;
  for (const ch of h) {
    if (ch === q[at]) at += 1;
    if (at === q.length) return true;
  }
  return false;
}

/**
 * Narrow provider groups to the models a search query matches.
 *
 * The arithmetic behind the picker's search box (roadmap module H). It is a
 * pure function so the suite drives the PRODUCT code, for the same reason
 * `groupModelsByProvider` lives here rather than inline in `composer.tsx`.
 *
 * The rules, each of which a test pins:
 *
 *   - An empty (or whitespace-only) query returns the INPUT array by
 *     reference. A fresh array re-renders the whole list on every open;
 *     the identity is what lets the caller skip the work.
 *   - A model matches on `id` OR `label`, fuzzily. Users copy ids off logs
 *     and read labels off the screen; both have to land.
 *   - A group whose PROVIDER label or id matches keeps ALL of its models.
 *     Typing a provider name and getting one of its twenty models is the
 *     surprise this avoids — the user named the provider, so the
 *     provider's models are the answer.
 *   - A group with no matching model is dropped rather than rendered as an
 *     empty header; an empty provider header is a dead end.
 *   - Group order and within-group model order survive. That order is the
 *     engine's own catalogue ordering and is meaningful; a filter that
 *     re-sorted it would silently reshuffle the list being read. Starring
 *     is the one thing that DOES reorder, and it does so afterwards, in
 *     `orderModelGroups`.
 *   - `auth` rides along, because a rebuild that dropped it would paint a
 *     keyed provider as if it had no key.
 */
export function filterModelGroups<M extends SelectableModel>(
  groups: readonly ModelProviderGroup<M>[],
  query: string,
): Array<ModelProviderGroup<M>> {
  if (!query.trim()) return groups as Array<ModelProviderGroup<M>>;
  const kept: Array<ModelProviderGroup<M>> = [];
  for (const group of groups) {
    if (fuzzyMatches(group.label, query) || fuzzyMatches(group.id, query)) {
      kept.push(group);
      continue;
    }
    const models = group.models.filter(
      (model) => fuzzyMatches(model.id, query) || fuzzyMatches(model.label, query),
    );
    if (models.length > 0) kept.push({ ...group, models });
  }
  return kept;
}

/**
 * The thinking levels the active model supports.
 *
 * The effort picker is mounted only when this list is non-empty; a model
 * that does not advertise reasoning controls never shows a no-op
 * control. A missing match (mid-fetch, or the engine encoded an id the
 * catalogue doesn't carry) yields the empty list, which hides the
 * control rather than offering a level the engine would reject.
 */
export function thinkingLevelsForModel<M extends Pick<SelectableModel, "id" | "thinkingLevels">>(
  models: readonly M[],
  activeId: string | null | undefined,
): string[] {
  const value = activeId ?? "";
  if (!value) return [];
  const known = models.find((model) => model.id === value);
  return known?.thinkingLevels ?? [];
}

/**
 * Map a server-supplied thinking level to its i18n key.
 *
 * Two level vocabularies reach this map (ticket 36):
 *   - effort levels (`off` / `low` / `medium` / `high` / `xhigh` /
 *     `max` / `minimal` / `none`) from provider catalogues and the
 *     engine's `thinkingEffort` option;
 *   - the two-state toggle (`off` / `on`) projected from switchable
 *     builtin MiniMax models (MiniMax-M3) — "on" is the pair of
 *     "off", never a depth, so it gets its own label.
 * Unknown levels fall through to no tag — the picker still shows
 * them but the chip label stays clean.
 */
export function thinkingLevelKey(level: string): MessageKey | null {
  switch (level) {
    case "off":
    case "none":
      return "thinkingPicker.off";
    case "on":
      return "thinkingPicker.on";
    case "low":
      return "thinkingPicker.low";
    case "minimal":
      return "thinkingPicker.minimal";
    case "medium":
      return "thinkingPicker.medium";
    case "high":
      return "thinkingPicker.high";
    case "xhigh":
      return "thinkingPicker.xhigh";
    case "max":
      return "thinkingPicker.max";
    default:
      return null;
  }
}

/**
 * Resolve a thinking level to its display label (the same keys
 * `thinkingLevelKey` returns, just looked up through `t`).
 *
 * Unknown levels fall through to the raw string — same fallback the
 * ThinkingEffortSelect menu uses, so a model that ships a brand-new
 * level still surfaces it instead of dropping a glyph on the chip.
 */
export function thinkingLevelLabel(t: (key: MessageKey) => string, level: string): string {
  const key = thinkingLevelKey(level);
  return key ? t(key) : level;
}

/**
 * The 「· level」 suffix the model chip appends, or `""` for no suffix.
 *
 * Ticket 11 stale-suffix guard: the suffix is shown only when the active
 * model actually supports the recorded level. Switching from M3
 * (thinkingLevels=["off","on"]) with a recorded level to M2 Lite (no
 * thinkingLevels) used to render a suffix the engine would reject; the
 * guard hides it. A level the i18n table doesn't know also yields no
 * suffix, so the chip never grows an untranslated glyph.
 */
export function chipLevelSuffix(
  t: (key: MessageKey) => string,
  level: string,
  activeModel: Pick<SelectableModel, "id" | "thinkingLevels"> | null | undefined,
): string {
  if (!level) return "";
  const supported = activeModel?.thinkingLevels ?? [];
  if (!supported.includes(level)) return "";
  const key = thinkingLevelKey(level);
  if (!key) return "";
  return ` · ${t(key)}`;
}

/**
 * Map a server-supplied modality string to its i18n key.
 *
 * Falls back to `file` for any value the catalogue carries but the
 * dictionary doesn't know — `file` is the closest neutral word and
 * keeps the badge readable rather than dropping a glyph on the row.
 */
export function modalityBadgeKey(modality: string): MessageKey {
  switch (modality) {
    case "text":
      return "modelSelector.modalityBadge.text";
    case "image":
      return "modelSelector.modalityBadge.image";
    case "audio":
      return "modelSelector.modalityBadge.audio";
    case "video":
      return "modelSelector.modalityBadge.video";
    default:
      return "modelSelector.modalityBadge.file";
  }
}

/**
 * Display label for a provider id.
 *
 * Falls back to the raw id when nothing better is known — keeping the chip
 * readable beats hiding the value. New provider ids ship without a translation
 * here on purpose: an unknown id means the catalogue has a provider the rest
 * of the UI does not yet know about, and rendering the raw id surfaces the
 * drift instead of silently mapping it to something plausible.
 */
export function providerLabel(id: string): string {
  switch (id) {
    case "minimax_api":
      return "MiniMax";
    case "openai_compat":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "__engine":
      return "Engine session";
    default:
      return id;
  }
}
