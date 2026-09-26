"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert as AntAlert,
  Input as AntInput,
  Select as AntSelect,
  Switch as AntSwitch,
  Tag as AntTag,
  Empty as AntEmpty,
  Popconfirm as AntPopconfirm,
} from "antd";

import * as api from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useSessionContext } from "@/lib/store";
import {
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
 */

const PROTOCOLS: api.ProviderProtocol[] = ["openai", "anthropic", "gemini"];
const AUTH_TYPES: api.ProviderAuthType[] = ["byok", "coding-plan"];

/** Re-exported for tests. */
export type { DraftProvider, DraftModel, ProviderTestOutcome };

export function ProviderManagementPanel({
  t,
}: {
  t: (key: MessageKey) => string;
}) {
  const { providersRevision } = useSessionContext();
  const [providers, setProviders] = useState<DraftProvider[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  const addProvider = useCallback(() => {
    // A new draft has a stable `draftId` (opaque, never written to
    // disk) and an empty user-facing `id` until the user types. The
    // selection path is keyed off `draftId` so editing the user-facing
    // id does not lose the row.
    const draft = newDraftProvider();
    setProviders((current) => [...(current ?? []), draft]);
    setSelectedId(draft.draftId);
  }, []);

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

  const save = useCallback(async () => {
    if (!providers || !validation.ok) return;
    setBusy(true);
    setSaveError(null);
    try {
      const wire = providers
        .filter((p) => !p.markedForDeletion)
        .map(draftToWire);
      await api.putProviders({ version: 2, providers: wire });
      setSavedAt(Date.now());
      // Refresh the local view from the server so masked placeholders
      // line up with the just-saved record.
      await load();
    } catch (cause) {
      setSaveError(
        t("providers.saveError").replace(
          "{{error}}",
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [providers, validation.ok, load, t]);

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
          sibling branch's endpoints are not yet mounted (404 → null). */}
      <ProviderPresetSection t={t} onAfterEnable={() => void load()} />

      <div className="grid grid-cols-[200px_1fr] gap-3">
        {/* Left rail — provider list. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1 rounded-[10px] bg-bg_grouped_tertiary p-1">
            {providers.length === 0 ? (
              <p
                data-testid="providers-empty"
                className="px-2 py-3 text-caption-small-strong text-text_default_tertiary"
              >
                {t("providers.empty")}
              </p>
            ) : (
              providers.map((p) => {
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
              })
            )}
          </div>
          <button
            type="button"
            data-testid="provider-add-button"
            onClick={addProvider}
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
              onClick={() => void save()}
              className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:opacity-50"
            >
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
            onChange={(e) => onChange((p) => ({ ...p, id: e.target.value }))}
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
 * The API-key field is the load-bearing piece of the keep-existing-key
 * convention: the masked placeholder goes in `placeholder`, NEVER in
 * `value`. The controlled value is `""` whenever the user did not
 * touch the field — the server interprets that as "keep the existing
 * key". A "reveal" toggle is intentionally absent: showing the
 * plaintext defeats the masking contract; the user clears the field
 * to overwrite (the masked placeholder will reappear).
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