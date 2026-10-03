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

/** Lowercase + trim, the normalisation every comparison below shares.
 *  A user pastes `" GLM "` and has to get the same rows as `"glm"`. */
function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

/** True when `needle` occurs anywhere in `haystack`, case-insensitively.
 *  Both sides are already normalised by the caller. */
function containsLoose(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * Narrow provider groups to the models a search query matches.
 *
 * The model selector's search box (roadmap module H, 「模型搜索」) filters
 * the provider-grouped list; this is the arithmetic behind it. It is a
 * pure function so the suite drives the PRODUCT code — the same reason
 * the grouping loop itself lives here rather than inline in
 * `components/composer.tsx#ModelSelect`.
 *
 * The rules, each of which a test pins:
 *
 *   - An empty (or whitespace-only) query returns the INPUT array by
 *     reference. A fresh array here would re-render the whole list on
 *     every open; the identity is what lets the caller skip the work.
 *   - A model matches on `id` OR `label`, case-insensitively. Users copy
 *     ids off logs and read labels off the screen; both have to land.
 *   - A group whose PROVIDER label or id matches keeps ALL of its
 *     models. Typing a provider name and getting one of its twenty
 *     models is the surprise this avoids — the user named the provider,
 *     so the provider's models are the answer.
 *   - A group with no matching model is dropped rather than rendered
 *     empty; an empty provider header is a dead end.
 *   - Group order and within-group model order are preserved. That order
 *     is the engine's own catalogue ordering and is meaningful; a filter
 *     that re-sorted it would silently reshuffle the list being read.
 *   - `auth` rides along on the derived group. The list greys a no-key
 *     provider from it, so a rebuild that dropped the field would paint
 *     a keyed provider as if it had no key — a row that looks usable and
 *     401s on click.
 *
 * The `__other` bucket needs no special case: a provider-less entry is
 * still a group, and matching on its model id/label keeps it reachable
 * from the selector instead of stranded behind an unfilterable header.
 */
export function filterModelGroups<M extends SelectableModel>(
  groups: readonly ModelProviderGroup<M>[],
  query: string,
): Array<ModelProviderGroup<M>> {
  const needle = normalizeForMatch(query);
  if (!needle) return groups as Array<ModelProviderGroup<M>>;
  const out: Array<ModelProviderGroup<M>> = [];
  for (const group of groups) {
    // The provider named the group, so the whole group is the answer.
    if (containsLoose(group.label, needle) || containsLoose(group.id, needle)) {
      out.push(group);
      continue;
    }
    const models = group.models.filter(
      (m) => containsLoose(m.label, needle) || containsLoose(m.id, needle),
    );
    if (models.length > 0) out.push({ ...group, models });
  }
  return out;
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
