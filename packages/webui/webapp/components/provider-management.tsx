"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert as AntAlert,
  Input as AntInput,
  Modal as AntModal,
  Select as AntSelect,
  Switch as AntSwitch,
  Tag as AntTag,
  Empty as AntEmpty,
  Popconfirm as AntPopconfirm,
} from "antd";

import * as api from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useSessionContext } from "@/lib/store";
import { Icon } from "./icons";
import {
  ATTACHMENT_MODALITIES,
  blankAuth,
  blankModel,
  describeTestOutcome,
  draftFromView,
  draftToWire,
  newDraftProvider,
  validateModelRow as validateModelRowLib,
  validateProviderId,
  THINKING_LEVELS,
  MODALITIES,
  type DraftProvider,
  type DraftModel,
  type ProviderTestOutcome,
} from "@/lib/provider-management";

/**
 * Provider management panel (ticket 03).
 *
 * Lives inside the settings modal as a fourth section ("Model providers"),
 * alongside general / appearance / connection. Renders the v2 catalogue
 * fetched from `/api/providers`, lets the operator edit / add / delete /
 * test-connection per-provider, and PUTs the result through
 * `/api/providers`. PUT triggers a `providers.updated` SSE frame that
 * the store's `providersRevision` counter carries back to the composer
 * — so saving without a page reload causes the model selector to show
 * the new group.
 *
 * Key handling:
 *   - GET returns `apiKeyMasked` (e.g. "sk-a***b"). The form's key input
 *     renders the masked value as its placeholder, NOT its value — so an
 *     "untouched" field carries an empty string when the form PUTs.
 *   - The PUT route applies `applyKeepKeyConvention`: an empty apiKey
 *     on an incoming provider is the sentinel "keep the existing key
 *     for this id". A non-empty value (including the masked placeholder)
 *     replaces. The form therefore:
 *       * never writes the masked placeholder to disk, by virtue of
 *         leaving the field empty when the user did not touch it;
 *       * writes the user's typed value verbatim when they did.
 *
 * Test connection:
 *   - Per-protocol minimal probe via `/api/providers/test`. The form
 *     sends the LIVE form values (so the user can test before saving),
 *     and renders a structured result inline: success latency on
 *     `OK`, otherwise a translated message keyed by `code` (`INVALID_KEY`,
 *     `BAD_PROTOCOL`, `PROBE_FAILED`) with the upstream HTTP status /
 *     network error in the detail line.
 *
 * Preset one-click enable (degrades gracefully):
 *   - The contract for `GET /api/providers/presets` + `POST
 *     /api/providers/preset/:id/enable` is being built in parallel on
 *     `feat/provider-presets`. This panel fetches the catalogue on
 *     mount and hides the section on 404 — the rest of the panel
 *     stays usable without it.
 *
 * Add-model dialog (ticket 54, desktop parity):
 *   - The add flow renders as the desktop's modal: provider select
 *     (placeholder 「请选择提供商」) over the preset catalogue + a
 *     "+ Other (custom)" escape hatch, a password API-key input with
 *     the eye reveal, a model area with the 「＋ 添加」 button, the
 *     「自动获取」 link, per-entry cards (模型 01 … 05 fields), and a
 *     取消 / 保存 footer. Saving goes through the same PUT as the
 *     panel's Save button — the wire body is unchanged.
 *   - 「自动获取」 opens the 「已获取模型」 checkbox dialog. The local
 *     backend has no per-key model-listing capability, so the list
 *     is the selected preset's built-in catalogue (public-doc
 *     metadata, not a live query), and the dialog says so. Custom
 *     providers get an honest empty note instead of fabricated rows.
 *   - Max-output-tokens renders in the desktop's form but disabled
 *     with the standing 「本地版不适用」 marker: the providers PUT
 *     contract has no field to persist it, and a writable input
 *     would silently drop the value on save.
 */

const PROTOCOLS: api.ProviderProtocol[] = ["openai", "anthropic", "gemini"];
const AUTH_TYPES: api.ProviderAuthType[] = ["byok", "coding-plan"];

/** Re-exported for tests. */
export type { DraftProvider, DraftModel, ProviderTestOutcome };

export function ProviderManagementPanel({
  t,
  autoAddProvider,
  onAutoAddConsumed,
}: {
  t: (key: MessageKey) => string;
  /** One-shot flag — when true, fire `addProvider()` on the next
   *  load completion. The page sets this when the model selector's
   *  "Add provider" row is clicked; the modal lands on the providers
   *  section, the panel mounts, and once the catalogue is loaded we
   *  create a fresh draft so the user can start typing immediately.
   *  Cleared via `onAutoAddConsumed` so re-opening the modal does
   *  not re-fire. */
  autoAddProvider?: boolean;
  onAutoAddConsumed?: () => void;
}) {
  const { providersRevision } = useSessionContext();
  const [providers, setProviders] = useState<DraftProvider[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Ticket 54 — the desktop-parity add-model dialog. The only add
   *  entry point: the empty-state button, the rail's 「+ 添加模型」
   *  button, and the model-selector deep-link all open it. */
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testByProvider, setTestByProvider] = useState<Record<string, ProviderTestOutcome | undefined>>({});

  const load = useCallback(async () => {
    try {
      const snap = await api.listProviders();
      setProviders(snap.providers.map(draftFromView));
      setLoadError(null);
      setSelectedId((current) => {
        // After a save, fresh drafts have no server counterpart.
        // selection falls back to the first server-side row so the
        // editor stays meaningful.
        if (current && current.startsWith("__new_")) return snap.providers[0]?.id ?? null;
        if (current && snap.providers.some((p) => p.id === current)) return current;
        return snap.providers[0]?.id ?? null;
      });
    } catch (cause) {
      setLoadError(
        t("providers.loadError").replace(
          "{{error}}",
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load, providersRevision]);

  /**
   * Auto-add fire-once (ticket 09, reworked in 54).
   *
   * The model selector's top "Add provider" row sends the user here
   * with `autoAddProvider = true`. Once the initial `load()` has
   * populated `providers`, we open the add-model dialog — the
   * desktop-parity add surface — so the user lands mid-add.
   *
   * The flag is one-shot: the effect tracks the consumed state with
   * a ref so a later mount (re-opening the modal) without the flag
   * does not re-fire, and a later mount WITH the flag does not
   * fire on every `providersRevision` bump either.
   */
  const autoAddFiredRef = useRef(false);
  useEffect(() => {
    if (!autoAddProvider) {
      autoAddFiredRef.current = false;
      return;
    }
    if (autoAddFiredRef.current) return;
    if (!providers) return;
    autoAddFiredRef.current = true;
    setAddDialogOpen(true);
    onAutoAddConsumed?.();
  }, [autoAddProvider, providers, onAutoAddConsumed]);

  // Validation summary across the whole draft, recomputed whenever
  // the user touches a field. The editor surface is only enabled
  // when the draft is valid; the Save button follows the same rule.
  const validation = useMemo(() => {
    if (!providers) return { ok: false, errors: [] as string[] };
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const p of providers) {
      if (p.markedForDeletion) continue;
      const idErr = validateProviderId(p.id);
      if (idErr) errors.push(`[${p.id || "(new)"}] ${idErr}`);
      if (seen.has(p.id.trim())) errors.push(`duplicate id: ${p.id}`);
      seen.add(p.id.trim());
      for (const m of p.models) {
        const mErr = validateModelRowLib(m);
        if (mErr) errors.push(`[${p.id} / ${m.id || "(model)"}] ${mErr}`);
      }
    }
    return { ok: errors.length === 0, errors };
  }, [providers, t]);

  const updateSelected = useCallback(
    (mutator: (draft: DraftProvider) => DraftProvider) => {
      setProviders((current) => {
        if (!current) return current;
        return current.map((p) =>
          p.draftId === selectedId ? mutator(p) : p,
        );
      });
    },
    [selectedId],
  );

  const markDeleted = useCallback((draftId: string) => {
    setProviders((current) => {
      if (!current) return current;
      // Existing providers: soft-delete (preserve id so the row stays
      // visually in place). New drafts (id starts with `__new_`):
      // hard-remove, since they were never saved.
      const draft = current.find((p) => p.draftId === draftId);
      if (!draft) return current;
      if (draft.isNew) return current.filter((p) => p.draftId !== draftId);
      return current.map((p) =>
        p.draftId === draftId ? { ...p, markedForDeletion: true } : p,
      );
    });
  }, []);

  const testSelected = useCallback(async () => {
    if (!providers || !selectedId) return;
    const draft = providers.find((p) => p.draftId === selectedId);
    if (!draft) return;
    const key = draft.draftId;
    setTestByProvider((current) => ({ ...current, [key]: undefined }));
    try {
      const result = await api.testProviderConnection({
        protocol: draft.protocol,
        auth: {
          type: draft.auth.type,
          apiKey: draft.auth.apiKey,
          baseURL: draft.auth.baseURL || undefined,
        },
        // 4s — the user is waiting; the wire default is 8s.
        timeoutMs: 4000,
      });
      setTestByProvider((current) => ({
        ...current,
        [key]: {
          ok: result.ok,
          latencyMs: result.latencyMs,
          code: result.code,
          error: result.error,
          detail: result.detail,
        },
      }));
    } catch (cause) {
      setTestByProvider((current) => ({
        ...current,
        [key]: {
          ok: false,
          code: "PROBE_FAILED",
          error: cause instanceof Error ? cause.message : String(cause),
        },
      }));
    }
  }, [providers, selectedId]);

  /** Shared PUT path: write the given draft list through
   *  `/api/providers` and re-read the catalogue so masked key
   *  placeholders line up. Returns whether the PUT landed — the
   *  add-model dialog keeps itself open on failure so the user's
   *  typed input is not lost behind a closed modal. */
  const persist = useCallback(
    async (next: DraftProvider[]): Promise<boolean> => {
      setBusy(true);
      setSaveError(null);
      try {
        const wire = next.filter((p) => !p.markedForDeletion).map(draftToWire);
        await api.putProviders({ version: 2, providers: wire });
        setSavedAt(Date.now());
        await load();
        return true;
      } catch (cause) {
        setSaveError(
          t("providers.saveError").replace(
            "{{error}}",
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  const save = useCallback(async () => {
    if (!providers || !validation.ok) return;
    const putOk = await persist(providers);
    if (!putOk) return;
    // Auto-test after save: a user who just configured a new provider
    // expects feedback immediately, not a separate click on the
    // "Test connection" button. The test runs against the live draft
    // values the user typed; the test result lands inline next to
    // the save button (described by `testByProvider`).
    //
    // The auto-test fires on the *first* newly-added draft with a key
    // — existing providers were already tested when the user touched
    // their key field, and re-running the probe on every save would
    // hide a stale result under a fresh success message.
    const fresh = providers.find(
      (p) =>
        !p.markedForDeletion &&
        p.isNew &&
        p.auth.type === "byok" &&
        p.auth.apiKey.trim().length > 0,
    );
    if (fresh) await testSelected();
  }, [providers, validation.ok, persist, testSelected]);

  /** Add-model dialog commit (ticket 54): append the dialog's draft
   *  and PUT immediately — the desktop dialog saves on its own 保存
   *  button, not through the panel-level Save. */
  const saveFromDialog = useCallback(
    async (draft: DraftProvider): Promise<boolean> => {
      if (!providers) return false;
      return persist([...providers, draft]);
    },
    [providers, persist],
  );

  if (loadError && !providers) {
    return (
      <p className="text-caption-small-strong text-text_status_error">{loadError}</p>
    );
  }

  if (!providers) {
    return <p className="text-text_default_tertiary">{t("app.connecting")}</p>;
  }

  const selected =
    providers.find((p) => p.draftId === selectedId) ??
    providers.find((p) => !p.markedForDeletion) ??
    null;

  return (
    <div className="flex w-full flex-col gap-3" data-testid="providers-panel">
      <div className="flex flex-col gap-1">
        <span className="text-text_default_primary">{t("providers.title")}</span>
        <span className="text-caption-small-strong text-text_default_tertiary">
          {t("providers.subtitle")}
        </span>
      </div>

      {/* Preset one-click enable — degrades gracefully when the
          sibling branch's endpoints are not yet mounted (404 → null).
          On the empty state it renders BELOW the centered affordance:
          the reference's first paint is 「暂未添加自定义模型」 in the
          tab's whitespace, and an 11-row catalogue above it would push
          that out of the viewport. */}
      {providers.length > 0 ? (
        <ProviderPresetSection t={t} onAfterEnable={() => void load()} />
      ) : null}

      {/* Ticket 54 — desktop-parity empty state: the reference centers
          「暂未添加自定义模型」 with a 「+ 添加模型」 button in the
          tab's whitespace; the two-column rail only exists once
          there is something to manage. The testids stay on the same
          affordances (providers-empty text, provider-add-button). */}
      {providers.length === 0 ? (
        <>
        <div className="flex flex-col items-center gap-4 py-14">
          <p
            data-testid="providers-empty"
            className="text-sm text-text_default_tertiary"
          >
            {t("providers.empty")}
          </p>
          <button
            type="button"
            data-testid="provider-add-button"
            onClick={() => setAddDialogOpen(true)}
            className="h-8 rounded-lg bg-bg_interaction_tertiary_hover px-4 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_selected"
          >
            + {t("providers.add")}
          </button>
        </div>
        <ProviderPresetSection t={t} onAfterEnable={() => void load()} />
        </>
      ) : (
      <div className="grid grid-cols-[200px_1fr] gap-3">
        {/* Left rail — provider list. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1 rounded-[10px] bg-bg_grouped_tertiary p-1">
            {providers.map((p) => {
                const isSelected =
                  (selectedId && p.draftId === selectedId) ||
                  (!selectedId && p === selected);
                const test = testByProvider[p.draftId];
                return (
                  <button
                    key={p.draftId}
                    type="button"
                    data-testid={`provider-row-${p.draftId}`}
                    onClick={() => setSelectedId(p.draftId)}
                    className={[
                      "flex flex-col gap-0.5 rounded-[8px] px-2 py-1.5 text-left transition-colors",
                      isSelected
                        ? "bg-bg_interaction_tertiary_selected"
                        : "hover:bg-bg_interaction_tertiary_hover",
                      p.markedForDeletion ? "opacity-50 line-through" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-1">
                      <span
                        data-testid={`provider-row-label-${p.id || "new"}`}
                        className="min-w-0 flex-1 truncate text-sm text-text_default_primary"
                      >
                        {p.label || p.id || "(new)"}
                      </span>
                      {p.preset ? (
                        <AntTag
                          data-testid={`provider-preset-badge-${p.id}`}
                          color="blue"
                          className="!mr-0"
                        >
                          {t("providers.presetBadge")}
                        </AntTag>
                      ) : (
                        <AntTag
                          data-testid={`provider-custom-badge-${p.id}`}
                          className="!mr-0"
                        >
                          {t("providers.customBadge")}
                        </AntTag>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-caption-small-strong text-text_default_tertiary">
                      <span className="font-family-code">{p.protocol}</span>
                      <span>·</span>
                      <span>{p.auth.type}</span>
                      <span>·</span>
                      <span data-testid={`provider-haskey-${p.id || "new"}`}>
                        {p.isNew
                          ? "—"
                          : p.hasKey
                            ? "key set"
                            : p.auth.type === "coding-plan"
                              ? "credential optional"
                              : "no key"}
                      </span>
                    </div>
                    {/* Configured-models preview (ticket 05): chips for the
                        configured models with thinking levels / modalities so
                        the operator sees what's wired up without expanding
                        the editor. The list is read directly off the
                        server-side `ProviderView.models[]` — it is the same
                        shape the dialog surfaces, so what the user sees
                        here matches the model picker. */}
                    {p.models.length > 0 ? (
                      <div
                        data-testid={`provider-models-summary-${p.id || "new"}`}
                        className="flex flex-wrap items-center gap-1 pt-1"
                      >
                        {p.models.slice(0, 4).map((m) => (
                          <span
                            key={m.id}
                            data-testid={`provider-model-chip-${p.id || "new"}-${m.id}`}
                            className="rounded-md border border-border_default bg-bg_default_primary px-1.5 py-0.5 text-caption-small-strong text-text_default_secondary font-family-code"
                          >
                            {m.label || m.id}
                          </span>
                        ))}
                        {p.models.length > 4 ? (
                          <span
                            data-testid={`provider-model-overflow-${p.id || "new"}`}
                            className="text-caption-small-strong text-text_default_tertiary"
                          >
                            +{p.models.length - 4}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {test ? (
                      <span
                        data-testid={`provider-test-summary-${p.id || "new"}`}
                        className={
                          test.ok
                            ? "text-caption-small-strong text-text_status_success"
                            : "text-caption-small-strong text-text_status_error"
                        }
                      >
                        {test.ok
                          ? `✓ ${test.latencyMs ?? 0}ms`
                          : `✗ ${test.code}`}
                      </span>
                    ) : null}
                  </button>
                );
              })}
          </div>
          <button
            type="button"
            data-testid="provider-add-button"
            onClick={() => setAddDialogOpen(true)}
            className="h-8 self-start rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            + {t("providers.add")}
          </button>
        </div>

        {/* Right pane — editor. */}
        <div className="flex min-w-0 flex-col gap-3">
          {selected ? (
            <ProviderEditor
              t={t}
              draft={selected}
              onChange={updateSelected}
              onDelete={() => markDeleted(selected.id)}
              onTest={() => void testSelected()}
              testResult={testByProvider[selected.draftId]}
            />
          ) : (
            <AntEmpty description={t("providers.empty")} />
          )}

          {validation.errors.length > 0 ? (
            <ul
              data-testid="provider-validation-errors"
              className="rounded-[8px] border border-border_default bg-bg_grouped_tertiary px-3 py-2 text-caption-small-strong text-text_status_error"
            >
              {validation.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="providers-save"
              disabled={busy || !validation.ok}
              aria-busy={busy || undefined}
              onClick={() => void save()}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <span
                  aria-hidden="true"
                  data-testid="providers-save-spinner"
                  className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
              ) : null}
              {busy ? t("providers.saving") : t("providers.save")}
            </button>
            {savedAt ? (
              <span
                data-testid="providers-saved-notice"
                className="text-caption-small-strong text-text_status_success"
              >
                {t("providers.saved")}
              </span>
            ) : null}
            {saveError ? (
              <span
                data-testid="providers-save-error"
                className="text-caption-small-strong text-text_status_error"
              >
                {saveError}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      )}

      {/* Ticket 54 — the desktop-parity add-model dialog. Opened by
       *  the empty-state / rail button and the deep-link; saving PUTs
       *  through `saveFromDialog` and closes only on success. */}
      <AddModelDialog
        t={t}
        open={addDialogOpen}
        existingIds={providers
          .filter((p) => !p.markedForDeletion)
          .map((p) => p.id)}
        onCancel={() => setAddDialogOpen(false)}
        onSave={saveFromDialog}
      />
    </div>
  );
}

// `auth.hasKey` lives on the server's view shape; the draft's auth
// shape does NOT carry it (the form carries apiKey="" as the
// sentinel). Surface "key set" only when the form knows it.

interface ProviderEditorProps {
  t: (key: MessageKey) => string;
  draft: DraftProvider;
  onChange: (mutator: (draft: DraftProvider) => DraftProvider) => void;
  onDelete: () => void;
  onTest: () => void;
  testResult?: ProviderTestOutcome;
}

function ProviderEditor({
  t,
  draft,
  onChange,
  onDelete,
  onTest,
  testResult,
}: ProviderEditorProps) {
  const idError = validateProviderId(draft.id);
  const testDescription = testResult ? describeTestOutcome(t, testResult) : null;

  return (
    <div
      data-testid={`provider-editor-${draft.id || "new"}`}
      className="flex flex-col gap-3 rounded-[10px] bg-bg_grouped_tertiary p-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-weight_medium text-text_default_primary">
          {draft.label || draft.id || "(new provider)"}
        </span>
        <div className="flex items-center gap-2">
          <AntSwitch
            checked={draft.enabled}
            onChange={(checked) => onChange((p) => ({ ...p, enabled: checked }))}
            aria-label={draft.enabled ? t("providers.enabled") : t("providers.disabled")}
          />
          <span className="text-caption-small-strong text-text_default_tertiary">
            {draft.enabled ? t("providers.enabled") : t("providers.disabled")}
          </span>
        </div>
      </div>

      {/* Connection section */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-caption-small-strong uppercase tracking-wide text-text_default_tertiary">
          {t("providers.section.connection")}
        </legend>
        <Field label={t("providers.field.id")}>
          <AntInput
            value={draft.id}
            disabled={!draft.isNew}
            data-testid="provider-field-id"
            onChange={(e) => {
              onChange((p) => ({ ...p, id: e.target.value }));
            }}
            className="mavis-input"
            status={idError ? "error" : undefined}
          />
          {idError ? (
            <span className="text-caption-small-strong text-text_status_error">
              {t("providers.idInvalid")}
            </span>
          ) : null}
        </Field>

        <Field label={t("providers.field.label")}>
          <AntInput
            value={draft.label}
            data-testid="provider-field-label"
            onChange={(e) => onChange((p) => ({ ...p, label: e.target.value }))}
            className="mavis-input"
          />
        </Field>

        <Field label={t("providers.field.protocol")}>
          <AntSelect
            value={draft.protocol}
            data-testid="provider-field-protocol"
            onChange={(value) =>
              onChange((p) => ({ ...p, protocol: value as api.ProviderProtocol }))
            }
            className="mavis-input"
            options={PROTOCOLS.map((proto) => ({ label: proto, value: proto }))}
          />
        </Field>

        <Field label={t("providers.field.authType")}>
          <AntSelect
            value={draft.auth.type}
            data-testid="provider-field-authType"
            onChange={(value) =>
              onChange((p) => ({
                ...p,
                auth: { ...p.auth, type: value as api.ProviderAuthType },
              }))
            }
            className="mavis-input"
            options={AUTH_TYPES.map((type) => ({ label: type, value: type }))}
          />
        </Field>

        {draft.auth.type === "byok" ? (
          <Field label={t("providers.field.apiKey")}>
            <ApiKeyInput
              draft={draft}
              t={t}
              onChange={(value) =>
                onChange((p) => ({ ...p, auth: { ...p.auth, apiKey: value } }))
              }
            />
          </Field>
        ) : (
          <Field label={t("providers.field.apiKey")}>
            <AntInput
              value={draft.auth.apiKey}
              data-testid="provider-field-apiKey"
              onChange={(e) =>
                onChange((p) => ({ ...p, auth: { ...p.auth, apiKey: e.target.value } }))
              }
              className="mavis-input"
              placeholder={t("providers.field.apiKeyPlaceholder")}
            />
          </Field>
        )}

        <Field label={t("providers.field.baseURL")}>
          <AntInput
            value={draft.auth.baseURL}
            data-testid="provider-field-baseURL"
            onChange={(e) =>
              onChange((p) => ({ ...p, auth: { ...p.auth, baseURL: e.target.value } }))
            }
            className="mavis-input"
            placeholder={t("providers.field.baseURLHint")}
          />
        </Field>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="provider-test-button"
            onClick={onTest}
            className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {t("providers.test")}
          </button>
          {testDescription ? (
            <span
              data-testid="provider-test-result"
              className={
                testDescription.tone === "ok"
                  ? "text-caption-small-strong text-text_status_success"
                  : testDescription.tone === "warn"
                    ? "text-caption-small-strong text-text_status_warning"
                    : "text-caption-small-strong text-text_status_error"
              }
            >
              {testDescription.text}
            </span>
          ) : null}
        </div>
      </fieldset>

      {/* Models section */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-caption-small-strong uppercase tracking-wide text-text_default_tertiary">
          {t("providers.section.models")}
        </legend>
        <DraftModelList
          t={t}
          models={draft.models}
          onChange={(models) => onChange((p) => ({ ...p, models }))}
        />
      </fieldset>

      {/* Footer — delete. Preset rows cannot be deleted (the preset
          controls live on a different branch); we hide the button in
          that case. */}
      {draft.preset ? null : (
        <div className="flex items-center justify-end pt-1">
          <AntPopconfirm
            title={t("providers.deleteConfirm").replace(
              "{{id}}",
              draft.id || "(new)",
            )}
            description={t("providers.deleteHint")}
            okText={t("providers.delete")}
            cancelText={t("panel.close")}
            onConfirm={onDelete}
          >
            <button
              type="button"
              data-testid="provider-delete-button"
              disabled={draft.markedForDeletion}
              className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
            >
              {t("providers.delete")}
            </button>
          </AntPopconfirm>
        </div>
      )}
    </div>
  );
}

/**
 * The EDITOR's API-key field is the load-bearing piece of the
 * keep-existing-key convention: the masked placeholder goes in
 * `placeholder`, NEVER in `value`. The controlled value is `""`
 * whenever the user did not touch the field — the server interprets
 * that as "keep the existing key". A "reveal" toggle is intentionally
 * absent HERE: the only text this field could reveal is the masked
 * placeholder, and showing the plaintext of the stored key defeats
 * the masking contract; the user clears the field to overwrite (the
 * masked placeholder will reappear).
 *
 * The add-model dialog (ticket 54) is a different contract and DOES
 * ship the eye toggle (desktop parity): there is no stored key and
 * no masked placeholder — the field's value is exactly what the user
 * just typed, so revealing it leaks nothing the user cannot already
 * see on their own screen. That input lives in `AddModelDialog`, not
 * here.
 */
function ApiKeyInput({
  draft,
  t,
  onChange,
}: {
  draft: DraftProvider;
  t: (key: MessageKey) => string;
  onChange: (value: string) => void;
}) {
  // The placeholder reflects the on-disk state: an existing provider
  // shows the masked value (so the operator can see what's stored
  // without trusting it back into the controlled field), a new
  // provider shows the generic "type a key" hint.
  const placeholder = draft.isNew
    ? t("providers.field.apiKeyPlaceholder")
    : draft.apiKeyMasked || t("providers.field.apiKeyPlaceholder");
  return (
    <AntInput.Password
      value={draft.auth.apiKey}
      data-testid="provider-field-apiKey"
      onChange={(e) => onChange(e.target.value)}
      className="mavis-input"
      placeholder={placeholder}
    />
  );
}

function DraftModelList({
  t,
  models,
  onChange,
}: {
  t: (key: MessageKey) => string;
  models: DraftModel[];
  onChange: (next: DraftModel[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {models.map((m, idx) => (
        <DraftModelRow
          key={idx}
          t={t}
          model={m}
          onChange={(next) => {
            const copy = models.slice();
            copy[idx] = next;
            onChange(copy);
          }}
          onRemove={() => onChange(models.filter((_, i) => i !== idx))}
        />
      ))}
      <button
        type="button"
        data-testid="provider-model-add"
        onClick={() => onChange([...models, blankModel()])}
        className="h-7 self-start rounded-lg border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
        + {t("providers.models.add")}
      </button>
    </div>
  );
}

function DraftModelRow({
  t,
  model,
  onChange,
  onRemove,
}: {
  t: (key: MessageKey) => string;
  model: DraftModel;
  onChange: (next: DraftModel) => void;
  onRemove: () => void;
}) {
  return (
    <div
      data-testid={`provider-model-row-${model.id || "new"}`}
      className="flex flex-col gap-1 rounded-[8px] bg-bg_grouped_primary p-2"
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("providers.field.modelId")}>
          <AntInput
            value={model.id}
            data-testid="provider-model-id"
            onChange={(e) => onChange({ ...model, id: e.target.value })}
            className="mavis-input"
          />
        </Field>
        <Field label={t("providers.field.modelLabel")}>
          <AntInput
            value={model.label}
            data-testid="provider-model-label"
            onChange={(e) => onChange({ ...model, label: e.target.value })}
            className="mavis-input"
          />
        </Field>
      </div>
      <Field label={t("providers.field.contextLimit")}>
        <AntInput
          value={model.contextLimit}
          data-testid="provider-model-contextLimit"
          onChange={(e) => onChange({ ...model, contextLimit: e.target.value })}
          className="mavis-input"
          inputMode="numeric"
        />
      </Field>
      <Field label={t("providers.field.thinkingLevels")}>
        <AntSelect
          mode="multiple"
          value={model.thinkingLevels}
          data-testid="provider-model-thinkingLevels"
          onChange={(values) => onChange({ ...model, thinkingLevels: values })}
          className="mavis-input"
          options={THINKING_LEVELS.map((lvl) => ({
            label: t(`providers.models.thinkingLevels.${lvl}` as MessageKey),
            value: lvl,
          }))}
        />
      </Field>
      <Field label={t("providers.field.modalities")}>
        <AntSelect
          mode="multiple"
          value={model.modalities}
          data-testid="provider-model-modalities"
          onChange={(values) => onChange({ ...model, modalities: values })}
          className="mavis-input"
          options={MODALITIES.map((mod) => ({
            label: t(`providers.models.modalities.${mod}` as MessageKey),
            value: mod,
          }))}
        />
      </Field>
      <div className="flex justify-end">
        <button
          type="button"
          data-testid="provider-model-remove"
          onClick={onRemove}
          className="h-7 rounded-lg border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("providers.models.remove")}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="desktop-text-ui-small-strong text-text_default_tertiary">{label}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------
// Add-model dialog — desktop parity (ticket 54).
// ---------------------------------------------------------------------
// The desktop's 「添加模型」 modal: provider select + password API-key
// input with the eye reveal + a model area whose entries carry the
// five reference fields, over a 取消 / 保存 footer. The dialog is the
// ONLY add entry point; editing a saved provider stays on the rail +
// editor surfaces (red line: the local editing capability is not
// replaced by the dialog).
//
// Data honesty, per the ticket's auto-fetch clause:
//   - 「自动获取」 opens the 「已获取模型」 checkbox dialog listing the
//     SELECTED PRESET's built-in catalogue (public-doc metadata the
//     server ships in `/api/providers/presets`), with a note that it
//     is not a live per-key query — the local backend has no
//     model-listing proxy.
//   - Custom providers get an explicit 「不支持」 note instead of a
//     fabricated list.
//   - Max-output-tokens renders disabled with the standing 「本地版
//     不适用」 marker: the PUT contract has no field for it.

/** The wire shape of one `/api/providers/presets` entry, restricted to
 *  the fields the dialog consumes. The route's `publicPresetView`
 *  also returns `models[]` — the panel's preset section ignores it,
 *  the dialog's auto-fetch list is exactly it. */
interface PresetCatalogueEntry {
  id: string;
  label: string;
  protocol: api.ProviderProtocol;
  auth: { type: api.ProviderAuthType; baseURL: string };
  models: Array<{
    id: string;
    label?: string;
    contextLimit?: number;
    thinkingLevels?: string[];
    modalities?: string[];
  }>;
}

/** Sentinel provider-select value for the 「+ 其他（自定义）」 option —
 *  distinct from `null`, which means "nothing chosen yet". */
const PRESET_CHOICE_CUSTOM = "__custom__";

/** Desktop-style display names, applied only to the presets the
 *  reference's dropdown actually names (DeepSeek / Zhipu AI（智谱）/
 *  Moonshot AI (China)). Every other local preset keeps its catalogue
 *  label: inventing reference spellings for providers the reference
 *  never shows would be fabrication, not parity. */
const PRESET_DISPLAY_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  zhipu: "Zhipu AI（智谱）",
  kimi: "Moonshot AI (China)",
};

/** The attachment-checkbox quartet → i18n key. `file` is the PDF
 *  checkbox (B5 mapping: 图片→image, PDF→file, 视频→video, 音频→audio). */
const ATTACHMENT_LABEL_KEYS: Record<
  (typeof ATTACHMENT_MODALITIES)[number],
  MessageKey
> = {
  image: "providers.dialog.attachments.image",
  file: "providers.dialog.attachments.pdf",
  video: "providers.dialog.attachments.video",
  audio: "providers.dialog.attachments.audio",
};

function AddModelDialog({
  t,
  open,
  existingIds,
  onCancel,
  onSave,
}: {
  t: (key: MessageKey) => string;
  open: boolean;
  /** ids already configured — the dialog refuses to create a
   *  duplicate (the server would reject the whole PUT). */
  existingIds: string[];
  onCancel: () => void;
  /** Panel-owned commit: merge + PUT. Resolves false on failure so
   *  the dialog stays open with the user's input intact. */
  onSave: (draft: DraftProvider) => Promise<boolean>;
}) {
  const [presets, setPresets] = useState<PresetCatalogueEntry[] | null>(null);
  const [presetChoice, setPresetChoice] = useState<string | null>(null);
  const [custom, setCustom] = useState({
    id: "",
    label: "",
    protocol: "openai" as api.ProviderProtocol,
    authType: "byok" as api.ProviderAuthType,
    baseURL: "",
  });
  const [apiKey, setApiKey] = useState("");
  const [entries, setEntries] = useState<DraftModel[]>([]);
  const [fetchedOpen, setFetchedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Fetch the preset catalogue once per dialog lifetime. 404 / network
  // failure degrade to an empty catalogue — the dropdown then offers
  // only 「+ 其他（自定义）」, mirroring ProviderPresetSection's
  // graceful-degradation contract.
  useEffect(() => {
    if (!open || presets !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/providers/presets", {
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (!res.ok) {
          setPresets([]);
          return;
        }
        const body = (await res.json()) as { presets?: PresetCatalogueEntry[] };
        setPresets(Array.isArray(body.presets) ? body.presets : []);
      } catch {
        if (!cancelled) setPresets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, presets]);

  const resetForm = useCallback(() => {
    setPresetChoice(null);
    setCustom({
      id: "",
      label: "",
      protocol: "openai",
      authType: "byok",
      baseURL: "",
    });
    setApiKey("");
    setEntries([]);
    setErrors([]);
  }, []);

  const close = useCallback(() => {
    resetForm();
    setFetchedOpen(false);
    onCancel();
  }, [resetForm, onCancel]);

  const selectedPreset =
    presets?.find((p) => p.id === presetChoice) ?? null;

  const commit = async () => {
    const errs: string[] = [];
    if (presetChoice === null) errs.push(t("providers.dialog.errorProvider"));
    let providerId = "";
    if (presetChoice === PRESET_CHOICE_CUSTOM) {
      providerId = custom.id.trim();
      const idErr = validateProviderId(providerId);
      if (idErr) errs.push(idErr);
    } else if (presetChoice) {
      providerId = presetChoice;
    }
    if (providerId && existingIds.includes(providerId)) {
      errs.push(
        t("providers.dialog.errorDuplicate").replace("{{id}}", providerId),
      );
    }
    entries.forEach((m, i) => {
      const mErr = validateModelRowLib(m);
      if (mErr) {
        errs.push(
          `${t("providers.dialog.entryTitle").replace(
            "{{n}}",
            String(i + 1).padStart(2, "0"),
          )}: ${mErr}`,
        );
      }
    });
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    const draft: DraftProvider =
      presetChoice === PRESET_CHOICE_CUSTOM
        ? {
            ...newDraftProvider(),
            id: providerId,
            label: custom.label.trim() || providerId,
            protocol: custom.protocol,
            auth: {
              type: custom.authType,
              apiKey,
              baseURL: custom.baseURL,
            },
            models: entries,
          }
        : {
            ...newDraftProvider(),
            id: selectedPreset?.id ?? "",
            label: selectedPreset
              ? PRESET_DISPLAY_LABELS[selectedPreset.id] ?? selectedPreset.label
              : "",
            protocol: selectedPreset?.protocol ?? "openai",
            auth: {
              type: selectedPreset?.auth.type ?? "byok",
              apiKey,
              baseURL: selectedPreset?.auth.baseURL ?? "",
            },
            preset: selectedPreset?.id ?? null,
            models: entries,
          };
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) close();
  };

  return (
    <AntModal
      open={open}
      onCancel={close}
      footer={null}
      width={640}
      title={
        <span
          data-testid="provider-dialog-title"
          className="text-base font-medium text-text_default_primary"
        >
          {t("providers.dialog.title")}
        </span>
      }
    >
      <div className="flex flex-col gap-4" data-testid="provider-dialog">
        {/* 提供商 —— desktop placeholder 「请选择提供商」; options are
         * the local preset catalogue plus the 「+ 其他」 escape hatch
         * that keeps the custom-provider capability (B4). */}
        <Field label={t("providers.dialog.provider")}>
          <AntSelect
            value={presetChoice ?? undefined}
            data-testid="provider-dialog-provider-select"
            placeholder={t("providers.dialog.providerPlaceholder")}
            onChange={(value) => setPresetChoice(value as string)}
            className="mavis-input"
            loading={presets === null}
            options={[
              ...(presets ?? []).map((p) => ({
                value: p.id,
                label: PRESET_DISPLAY_LABELS[p.id] ?? p.label,
              })),
              { value: PRESET_CHOICE_CUSTOM, label: t("providers.dialog.other") },
            ]}
          />
        </Field>

        {presetChoice === PRESET_CHOICE_CUSTOM ? (
          <div
            data-testid="provider-dialog-custom-fields"
            className="flex flex-col gap-2 rounded-[8px] bg-bg_grouped_tertiary p-2"
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("providers.field.id")}>
                <AntInput
                  value={custom.id}
                  data-testid="provider-dialog-custom-id"
                  onChange={(e) =>
                    setCustom((c) => ({ ...c, id: e.target.value }))
                  }
                  className="mavis-input"
                />
              </Field>
              <Field label={t("providers.field.label")}>
                <AntInput
                  value={custom.label}
                  data-testid="provider-dialog-custom-label"
                  onChange={(e) =>
                    setCustom((c) => ({ ...c, label: e.target.value }))
                  }
                  className="mavis-input"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("providers.field.protocol")}>
                <AntSelect
                  value={custom.protocol}
                  data-testid="provider-dialog-custom-protocol"
                  onChange={(value) =>
                    setCustom((c) => ({
                      ...c,
                      protocol: value as api.ProviderProtocol,
                    }))
                  }
                  className="mavis-input"
                  options={PROTOCOLS.map((proto) => ({ label: proto, value: proto }))}
                />
              </Field>
              <Field label={t("providers.field.authType")}>
                <AntSelect
                  value={custom.authType}
                  data-testid="provider-dialog-custom-authType"
                  onChange={(value) =>
                    setCustom((c) => ({
                      ...c,
                      authType: value as api.ProviderAuthType,
                    }))
                  }
                  className="mavis-input"
                  options={AUTH_TYPES.map((type) => ({ label: type, value: type }))}
                />
              </Field>
            </div>
            <Field label={t("providers.field.baseURL")}>
              <AntInput
                value={custom.baseURL}
                data-testid="provider-dialog-custom-baseURL"
                onChange={(e) =>
                  setCustom((c) => ({ ...c, baseURL: e.target.value }))
                }
                className="mavis-input"
                placeholder={t("providers.field.baseURLHint")}
              />
            </Field>
          </div>
        ) : null}

        {/* API Key —— password input with the desktop's eye toggle.
         * The reveal is safe here (unlike the editor's field): the
         * value is what the user just typed, there is no stored key
         * to unmask. */}
        <Field label={t("providers.field.apiKey")}>
          <AntInput.Password
            value={apiKey}
            data-testid="provider-dialog-api-key"
            onChange={(e) => setApiKey(e.target.value)}
            className="mavis-input"
            placeholder={t("providers.dialog.apiKeyPlaceholder")}
          />
        </Field>

        {/* 模型 —— the reference's header row: 「＋ 添加」 next to the
         * 「自动获取」 link, above the entry cards. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="desktop-text-ui-small-strong text-text_default_tertiary">
              {t("providers.dialog.models")}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid="provider-dialog-model-add"
                onClick={() => setEntries((cur) => [...cur, blankModel()])}
                className="h-7 rounded-lg bg-bg_interaction_tertiary_hover px-2.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_selected"
              >
                {t("providers.dialog.addEntry")}
              </button>
              <button
                type="button"
                data-testid="provider-dialog-autofetch"
                onClick={() => setFetchedOpen(true)}
                className="border-0 bg-transparent p-0 text-sm text-icon_default_accent transition-colors hover:opacity-80"
              >
                {t("providers.dialog.autoFetch")}
              </button>
            </div>
          </div>

          {entries.map((m, idx) => (
            <AddModelEntry
              key={idx}
              t={t}
              index={idx}
              model={m}
              onChange={(next) =>
                setEntries((cur) => cur.map((x, i) => (i === idx ? next : x)))
              }
              onRemove={() =>
                setEntries((cur) => cur.filter((_, i) => i !== idx))
              }
              onReset={() =>
                setEntries((cur) => cur.map((x, i) => (i === idx ? blankModel() : x)))
              }
            />
          ))}
        </div>

        {errors.length > 0 ? (
          <ul
            data-testid="provider-dialog-errors"
            className="rounded-[8px] border border-border_default bg-bg_grouped_tertiary px-3 py-2 text-caption-small-strong text-text_status_error"
          >
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        ) : null}

        {/* 取消 / 保存 —— the reference's white secondary + black
         * primary pair. */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            data-testid="provider-dialog-cancel"
            disabled={busy}
            onClick={close}
            className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
          >
            {t("providers.dialog.cancel")}
          </button>
          <button
            type="button"
            data-testid="provider-dialog-save"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void commit()}
            className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? t("providers.saving") : t("providers.dialog.save")}
          </button>
        </div>
      </div>

      <FetchedModelsDialog
        t={t}
        open={fetchedOpen}
        presetMode={selectedPreset !== null}
        models={selectedPreset?.models ?? []}
        onCancel={() => setFetchedOpen(false)}
        onAdd={(picked) => {
          setEntries((cur) => [
            ...cur,
            ...picked.map((m) => ({
              id: m.id,
              label: m.label ?? m.id,
              contextLimit: m.contextLimit ? String(m.contextLimit) : "",
              thinkingLevels: m.thinkingLevels ? [...m.thinkingLevels] : [],
              modalities: m.modalities ? [...m.modalities] : [],
            })),
          ]);
          setFetchedOpen(false);
        }}
      />
    </AntModal>
  );
}

/** One model entry card — the reference's five-field form under a
 *  「模型 01」 header with the ↻ reset and 🗑 delete affordances. */
function AddModelEntry({
  t,
  index,
  model,
  onChange,
  onRemove,
  onReset,
}: {
  t: (key: MessageKey) => string;
  index: number;
  model: DraftModel;
  onChange: (next: DraftModel) => void;
  onRemove: () => void;
  onReset: () => void;
}) {
  const title = t("providers.dialog.entryTitle").replace(
    "{{n}}",
    String(index + 1).padStart(2, "0"),
  );
  return (
    <div
      data-testid={`provider-dialog-entry-${index}`}
      className="flex flex-col gap-2 rounded-[8px] bg-bg_grouped_tertiary p-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-weight_medium text-text_default_primary">
          {title}
        </span>
        <div className="flex items-center gap-2 text-text_default_tertiary">
          <button
            type="button"
            data-testid={`provider-dialog-entry-${index}-reset`}
            title={t("providers.dialog.entryReset")}
            aria-label={t("providers.dialog.entryReset")}
            onClick={onReset}
            className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary"
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            type="button"
            data-testid={`provider-dialog-entry-${index}-remove`}
            title={t("providers.dialog.entryRemove")}
            aria-label={t("providers.dialog.entryRemove")}
            onClick={onRemove}
            className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary"
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      </div>

      <Field label={t("providers.dialog.field.name")}>
        <AntInput
          value={model.id}
          data-testid={`provider-dialog-entry-${index}-name`}
          onChange={(e) => onChange({ ...model, id: e.target.value })}
          className="mavis-input"
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t("providers.dialog.field.context")}>
          <AntInput
            value={model.contextLimit}
            data-testid={`provider-dialog-entry-${index}-context`}
            onChange={(e) => onChange({ ...model, contextLimit: e.target.value })}
            className="mavis-input"
            inputMode="numeric"
          />
        </Field>
        {/* Max output tokens: the reference's field, rendered in the
         * desktop's form but DISABLED with the standing not-applicable
         * marker — the providers PUT contract has nowhere to persist
         * it, and a writable input would silently drop the value. */}
        <Field label={t("providers.dialog.field.maxOutput")}>
          <AntInput
            disabled
            data-testid={`provider-dialog-entry-${index}-max-output`}
            className="mavis-input"
            placeholder={t("providers.dialog.field.maxOutputNa")}
          />
        </Field>
      </div>

      <Field label={t("providers.dialog.field.thinking")}>
        <AntSelect
          mode="multiple"
          value={model.thinkingLevels}
          data-testid={`provider-dialog-entry-${index}-thinking`}
          onChange={(values) => onChange({ ...model, thinkingLevels: values })}
          className="mavis-input"
          placeholder={t("providers.dialog.field.thinkingPlaceholder")}
          options={THINKING_LEVELS.map((lvl) => ({
            label: t(`providers.models.thinkingLevels.${lvl}` as MessageKey),
            value: lvl,
          }))}
        />
      </Field>

      <Field label={t("providers.dialog.field.attachments")}>
        <div className="flex flex-wrap items-center gap-4 pt-1">
          {ATTACHMENT_MODALITIES.map((mod) => (
            <label
              key={mod}
              className="flex cursor-pointer items-center gap-1.5 text-sm text-text_default_secondary"
            >
              <input
                type="checkbox"
                checked={model.modalities.includes(mod)}
                data-testid={`provider-dialog-entry-${index}-attachment-${mod}`}
                onChange={(e) =>
                  onChange({
                    ...model,
                    modalities: e.target.checked
                      ? [...model.modalities, mod]
                      : model.modalities.filter((m) => m !== mod),
                  })
                }
                className="size-3.5 accent-[var(--border_accent)]"
              />
              {t(ATTACHMENT_LABEL_KEYS[mod])}
            </label>
          ))}
        </div>
      </Field>
    </div>
  );
}

/**
 * 「已获取模型」 — the auto-fetch checkbox dialog (ticket 54).
 *
 * Desktop form: a scrollable checkbox list, a bottom-left 「全选
 * (n/N)」 toggle, and 取消 / 添加 buttons. Local data policy: the list
 * is the selected preset's built-in catalogue and the note says so;
 * with no preset selected (custom provider / nothing chosen) the list
 * is empty and an explicit note states the local backend cannot query
 * a provider's live model list — no rows are invented.
 */
function FetchedModelsDialog({
  t,
  open,
  presetMode,
  models,
  onCancel,
  onAdd,
}: {
  t: (key: MessageKey) => string;
  open: boolean;
  /** true when a preset is selected — the list is that preset's
   *  catalogue and the preset note renders; false renders the
   *  custom-provider not-supported note. */
  presetMode: boolean;
  models: PresetCatalogueEntry["models"];
  onCancel: () => void;
  onAdd: (picked: PresetCatalogueEntry["models"]) => void;
}) {
  // Fresh open → everything checked, matching the reference's
  // 全选 (11/11) landing state.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setChecked(new Set(models.map((m) => m.id)));
    // models identity changes only when the preset selection does;
    // re-seeding on every render would fight the user's clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const allChecked =
    models.length > 0 && checked.size === models.length;
  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(models.map((m) => m.id)));
  };

  return (
    <AntModal
      open={open}
      onCancel={onCancel}
      footer={null}
      width={480}
      title={
        <span
          data-testid="fetched-models-title"
          className="text-base font-medium text-text_default_primary"
        >
          {t("providers.fetched.title")}
        </span>
      }
    >
      <div className="flex flex-col gap-3" data-testid="fetched-models-dialog">
        <p className="text-caption-small-strong text-text_default_tertiary">
          {presetMode
            ? t("providers.fetched.presetNote")
            : t("providers.fetched.customEmpty")}
        </p>

        {presetMode && models.length > 0 ? (
          <div className="thin-scrollbar flex max-h-64 flex-col overflow-y-auto rounded-[8px] border border-border_default">
            {models.map((m) => (
              <label
                key={m.id}
                data-testid={`fetched-models-item-${m.id}`}
                className="flex cursor-pointer items-center gap-2 border-b border-border_light px-3 py-2 text-sm text-text_default_primary last:border-b-0 hover:bg-bg_interaction_tertiary_hover"
              >
                <input
                  type="checkbox"
                  checked={checked.has(m.id)}
                  onChange={(e) =>
                    setChecked((cur) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      return next;
                    })
                  }
                  className="size-3.5 accent-[var(--border_accent)]"
                />
                <span className="font-family-code">{m.id}</span>
              </label>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-between pt-1">
          {presetMode && models.length > 0 ? (
            <label
              className="flex cursor-pointer items-center gap-2 text-sm text-text_default_primary"
              data-testid="fetched-models-select-all"
            >
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
                className="size-3.5 accent-[var(--border_accent)]"
              />
              {t("providers.fetched.selectAll")}
              <span className="text-text_default_tertiary">
                （{checked.size}/{models.length}）
              </span>
            </label>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="fetched-models-cancel"
              onClick={onCancel}
              className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              {t("providers.dialog.cancel")}
            </button>
            <button
              type="button"
              data-testid="fetched-models-add"
              disabled={!presetMode || checked.size === 0}
              onClick={() => onAdd(models.filter((m) => checked.has(m.id)))}
              className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("providers.fetched.add")}
            </button>
          </div>
        </div>
      </div>
    </AntModal>
  );
}

// ---------------------------------------------------------------------
// Preset one-click enable — degrades gracefully.
// ---------------------------------------------------------------------
// The presets API is being built on a sibling branch
// (`feat/provider-presets`). When that branch lands, the management
// panel will render this section as the entry point; until then, the
// fetch returns 404 and we render nothing rather than a broken
// affordance. The 404 path is exercised by the test suite.

export interface PresetView {
  id: string;
  label: string;
  protocol: api.ProviderProtocol;
  authType: api.ProviderAuthType;
  enabled: boolean;
  /** True when this preset is already enabled in the user's config. */
  active: boolean;
}

interface PresetsState {
  /** `undefined` while the fetch is in flight; `null` when the
   *  endpoint 404'd (sibling branch not merged) — that branch hides
   *  the section entirely. */
  presets: PresetView[] | null | undefined;
  /** Last error — shown when `presets === null && error !== null`. */
  error: string | null;
}

export function ProviderPresetSection({
  t,
  onAfterEnable,
}: {
  t: (key: MessageKey) => string;
  onAfterEnable: () => void;
}) {
  const [state, setState] = useState<PresetsState>({ presets: undefined, error: null });
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/providers/presets", {
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (res.status === 404) {
          setState({ presets: null, error: null });
          return;
        }
        if (!res.ok) {
          setState({
            presets: null,
            error: `HTTP ${res.status}`,
          });
          return;
        }
        const body = (await res.json()) as { presets: PresetView[] };
        setState({ presets: body.presets ?? [], error: null });
      } catch (cause) {
        if (cancelled) return;
        setState({
          presets: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await fetch(
          `/api/providers/preset/${encodeURIComponent(id)}/enable`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        onAfterEnable();
      } catch {
        // Surfacing a translated error here is overkill — the parent
        // will re-fetch on the next providersRevision bump, so the
        // error stays visible in the browser console only.
      } finally {
        setBusyId(null);
      }
    },
    [onAfterEnable],
  );

  // 404 — endpoint not built yet. Hide the section entirely; the
  // rest of the panel stays usable. This is the documented graceful
  // degradation. The `undefined` branch (fetch in flight) also returns
  // null so the section does not flash.
  if (!state.presets) return null;
  if (state.presets.length === 0) return null;

  return (
    <section
      data-testid="provider-presets"
      className="flex flex-col gap-2 rounded-[10px] bg-bg_grouped_tertiary p-3"
    >
      <span className="text-sm font-weight_medium text-text_default_primary">
        {t("providers.presets.title")}
      </span>
      <div className="flex flex-col gap-1">
        {state.presets.map((preset) => (
          <div
            key={preset.id}
            data-testid={`provider-preset-row-${preset.id}`}
            className="flex items-center gap-2 rounded-[8px] px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
              {preset.label}
            </span>
            <span className="text-caption-small-strong text-text_default_tertiary">
              {preset.protocol}
            </span>
            <button
              type="button"
              data-testid={`provider-preset-enable-${preset.id}`}
              disabled={preset.active || busyId === preset.id}
              onClick={() => void enable(preset.id)}
              className="h-7 rounded-lg border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
            >
              {busyId === preset.id
                ? t("providers.presets.enabling")
                : t("providers.presets.enable")}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}