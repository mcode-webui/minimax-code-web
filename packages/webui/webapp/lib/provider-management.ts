/**
 * Pure helpers for the provider management UI.
 *
 * Lifted out of `components/provider-management.tsx` so they can be
 * unit-tested without a DOM or a render harness. The component file
 * re-imports these — there is no React in this module.
 *
 * Functions:
 *   - `validateProviderId` — id format (server enforces the same regex).
 *   - `validateModelRow`   — per-model-row check (id + contextLimit + enums).
 *   - `describeTestOutcome`— map a /api/providers/test wire shape onto a
 *                            UI string + tone (ok / warn / error).
 *   - `draftToWire`        — convert a UI draft into the PUT body shape,
 *                            dropping empty fields the wire contract
 *                            expects to be absent.
 *   - `THINKING_LEVELS` / `MODALITIES` — the enum values the form sends.
 */

import type { MessageKey } from "./i18n";
import type {
  ProviderAuthType,
  ProviderProtocol,
  ProviderView,
} from "./api";

export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export const MODALITIES = ["text", "image", "audio", "video"] as const;

export interface DraftAuth {
  type: ProviderAuthType;
  /** "" is the keep-existing-key sentinel. */
  apiKey: string;
  baseURL: string;
}

export interface DraftModel {
  id: string;
  label: string;
  contextLimit: string;
  thinkingLevels: string[];
  modalities: string[];
}

export interface DraftProvider {
  /** Internal identity — never shown to the user, never sent over
   *  the wire. Set once when the draft is created and stable for the
   *  lifetime of the panel, even when the user later edits the
   *  user-facing `id`. The selection / update / delete paths are
   *  keyed off this field so editing the user-facing id does not
   *  lose the row. */
  draftId: string;
  /** User-facing provider id — the wire value, mutable. Empty for a
   *  brand-new draft until the user types something. */
  id: string;
  label: string;
  enabled: boolean;
  protocol: ProviderProtocol;
  auth: DraftAuth;
  models: DraftModel[];
  preset: string | null;
  hasKey: boolean;
  apiKeyMasked: string;
  isNew: boolean;
  markedForDeletion: boolean;
}

export interface ProviderTestOutcome {
  ok: boolean;
  latencyMs?: number;
  code: string;
  error?: string;
  detail?: string;
}

export function blankAuth(): DraftAuth {
  return { type: "byok", apiKey: "", baseURL: "" };
}

export function blankModel(): DraftModel {
  return { id: "", label: "", contextLimit: "", thinkingLevels: [], modalities: [] };
}

export function draftFromView(view: ProviderView): DraftProvider {
  return {
    draftId: view.id,
    id: view.id,
    label: view.label,
    enabled: view.enabled !== false,
    protocol: view.protocol,
    auth: {
      type: view.auth.type,
      apiKey: "",
      baseURL: view.auth.baseURL ?? "",
    },
    models: view.models.map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      contextLimit: m.contextLimit ? String(m.contextLimit) : "",
      thinkingLevels: Array.isArray(m.thinkingLevels) ? [...m.thinkingLevels] : [],
      modalities: Array.isArray(m.modalities) ? [...m.modalities] : [],
    })),
    preset: typeof view.preset === "string" ? view.preset : null,
    hasKey: !!view.auth.hasKey,
    apiKeyMasked: view.auth.apiKeyMasked || "",
    isNew: false,
    markedForDeletion: false,
  };
}

/** A unique draft id — opaque to the user, stable for the lifetime of
 *  the panel. Used as the React `key`, the selection key, and the
 *  delete key, but NEVER written to disk. */
export function newDraftId(): string {
  return `__new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newDraftProvider(): DraftProvider {
  return {
    draftId: newDraftId(),
    id: "",
    label: "",
    enabled: true,
    protocol: "openai",
    auth: blankAuth(),
    models: [],
    preset: null,
    hasKey: false,
    apiKeyMasked: "",
    isNew: true,
    markedForDeletion: false,
  };
}

/**
 * Provider id validation — server enforces the same regex
 * (see `server/lib/providers-config.js#normaliseProvider`). Surface the
 * error inline so the user doesn't hit Save and see a 400.
 */
export function validateProviderId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed) return "id required";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-]*$/.test(trimmed)) return "invalid id";
  return null;
}

/**
 * Per-model-row validation. Returns the first error found or `null`
 * when the row is well-formed. Empty model id is the "row was added
 * but the user hasn't typed yet" state — it is treated as an error so
 * the Save button stays disabled until the row is filled in or
 * removed.
 */
export function validateModelRow(model: DraftModel): string | null {
  const id = model.id.trim();
  if (!id) return "model id required";
  const ctx = model.contextLimit.trim();
  if (ctx && !/^\d+$/.test(ctx)) return "context limit must be a non-negative integer";
  for (const lvl of model.thinkingLevels) {
    if (!THINKING_LEVELS.includes(lvl as typeof THINKING_LEVELS[number])) {
      return `unknown thinking level: ${lvl}`;
    }
  }
  for (const mod of model.modalities) {
    if (!MODALITIES.includes(mod as typeof MODALITIES[number])) {
      return `unknown modality: ${mod}`;
    }
  }
  return null;
}

export interface WireProvider {
  id: string;
  label?: string;
  preset?: string;
  enabled?: boolean;
  protocol: ProviderProtocol;
  auth: { type: ProviderAuthType; apiKey: string; baseURL?: string };
  models: Array<{
    id: string;
    label?: string;
    contextLimit?: number;
    thinkingLevels?: string[];
    modalities?: string[];
  }>;
}

/**
 * Convert a draft into the wire shape the PUT route expects.
 *
 *   - rows with an empty id are dropped (they are UI placeholders).
 *   - empty fields are dropped (the server's normaliser emits `null`
 *     or `undefined` for those, and dropping keeps the on-disk shape
 *     minimal).
 *   - apiKey is forwarded verbatim — including the empty sentinel
 *     that the server's `applyKeepKeyConvention` interprets.
 */
export function draftToWire(draft: DraftProvider): WireProvider {
  const models = draft.models
    .map((m): WireProvider["models"][number] | null => {
      const trimmed = m.id.trim();
      if (!trimmed) return null;
      const ctxRaw = m.contextLimit.trim();
      const ctx = ctxRaw ? Number(ctxRaw) : undefined;
      return {
        id: trimmed,
        label: m.label.trim() || undefined,
        ...(ctx && Number.isFinite(ctx) && ctx > 0 ? { contextLimit: ctx } : {}),
        ...(m.thinkingLevels.length > 0 ? { thinkingLevels: [...m.thinkingLevels] } : {}),
        ...(m.modalities.length > 0 ? { modalities: [...m.modalities] } : {}),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  return {
    id: draft.id.trim(),
    label: draft.label.trim() || undefined,
    ...(draft.preset ? { preset: draft.preset } : {}),
    enabled: draft.enabled,
    protocol: draft.protocol,
    auth: {
      type: draft.auth.type,
      apiKey: draft.auth.apiKey,
      ...(draft.auth.baseURL.trim() ? { baseURL: draft.auth.baseURL.trim() } : {}),
    },
    models,
  };
}

/**
 * Map a `/api/providers/test` response onto a UI string + tone.
 *
 * The mapping is kept here (not in i18n) because the codes are wire
 * constants, not user-visible strings — a translator picking one of
 * them up by accident would render English to a Chinese user. The
 *   `t` argument is supplied by the caller so a rebrand is a one-line
 *   change in the component.
 */
export function describeTestOutcome(
  t: (key: MessageKey) => string,
  result: ProviderTestOutcome,
): { tone: "ok" | "warn" | "error"; text: string } {
  if (result.ok) {
    return {
      tone: "ok",
      text: t("providers.testOk").replace("{{ms}}", String(result.latencyMs ?? 0)),
    };
  }
  switch (result.code) {
    case "INVALID_KEY":
      return { tone: "error", text: t("providers.testInvalidKey") };
    case "BAD_PROTOCOL":
      return { tone: "error", text: t("providers.testBadProtocol") };
    case "PROBE_FAILED":
      if (result.error === "timeout") {
        return { tone: "error", text: t("providers.testTimeout") };
      }
      if (result.error && /^HTTP \d+/.test(result.error)) {
        return {
          tone: "error",
          text: t("providers.testHttp").replace("{{status}}", result.error.replace(/^HTTP /, "")),
        };
      }
      return {
        tone: "error",
        text: result.error
          ? `${t("providers.testProbeFailed")} — ${result.error}`
          : t("providers.testProbeFailed"),
      };
    default:
      return { tone: "error", text: result.error || t("providers.testProbeFailed") };
  }
}