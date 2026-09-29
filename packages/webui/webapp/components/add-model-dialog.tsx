"use client";

/**
 * The add-model dialog and its auto-fetch checkbox dialog (ticket 54,
 * the 53b half of the usage-and-models parity report).
 *
 * LIFTED OUT of `provider-management.tsx` (acceptance round 2) so the
 * suite can render-test the behaviour: this file is import-clean
 * apart from antd, the icon set, and the pure contract layer — the
 * panel's store/api graph never enters a test process. The render
 * harness is the same one `usage-models-cards.test.ts` established
 * for 53a (renderToStaticMarkup over exported, controlled pieces).
 *
 * Split inside this file:
 *
 *   - `AddModelDialogForm` / `FetchedModelsDialogBody` — CONTROLLED,
 *     stateless surfaces. Every interaction is a callback prop and
 *     every piece of state is a value prop, so a static render with
 *     chosen props IS the behaviour under test (the eye toggle is a
 *     `revealed` prop driving the input's `type`, the checkbox
 *     dialog's 全选 state is a `checked` set prop).
 *   - `AddModelDialog` / `FetchedModelsDialog` — the antd Modal
 *     shells that own the state, the presets fetch, validation, and
 *     the commit path. Rendered only by the provider panel.
 *   - `collectDialogErrors` / `defaultChecked` / `blankDialogCustom`
 *     — pure helpers the shells call and the tests drive directly.
 *
 * Data honesty (ticket 54): 「自动获取」 lists the SELECTED PRESET's
 * built-in catalogue with an explicit note that it is not a live
 * per-key query; a custom provider keeps the link clickable but the
 * dialog states the missing capability and disables 添加 — no rows
 * are invented. Max-output-tokens renders disabled with the standing
 * 「本地版不适用」 marker (the providers PUT contract has no field to
 * persist it).
 */

// This file imports React explicitly: webapp/test/add-model-dialog.test.ts
// render-tests the exported components, and the tsx loader's classic
// JSX runtime needs the symbol (same reason usage-models-cards.tsx and
// loading-states.tsx import React). The api import is type-only so the
// panel's runtime api graph stays out of a test process.
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Input as AntInput, Modal as AntModal, Select as AntSelect } from "antd";

import type { ProviderAuthType, ProviderProtocol } from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import { Icon } from "./icons";
import {
  ATTACHMENT_MODALITIES,
  blankModel,
  newDraftProvider,
  validateModelRow,
  validateProviderId,
  THINKING_LEVELS,
  type DraftModel,
  type DraftProvider,
} from "../lib/provider-management";

/** The wire shape of one `/api/providers/presets` entry, restricted to
 *  the fields the dialog consumes. The route's `publicPresetView`
 *  also returns `models[]` — the panel's preset section ignores it,
 *  the dialog's auto-fetch list is exactly it. */
export interface PresetCatalogueEntry {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  auth: { type: ProviderAuthType; baseURL: string };
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
export const PRESET_CHOICE_CUSTOM = "__custom__";

/** Desktop-style display names, applied only to the presets the
 *  reference's dropdown actually names (DeepSeek / Zhipu AI（智谱）/
 *  Moonshot AI (China)). Every other local preset keeps its catalogue
 *  label: inventing reference spellings for providers the reference
 *  never shows would be fabrication, not parity. */
export const PRESET_DISPLAY_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  zhipu: "Zhipu AI（智谱）",
  kimi: "Moonshot AI (China)",
};

/** The attachment-checkbox quartet → i18n key. `file` is the PDF
 *  checkbox (B5 mapping: 图片→image, PDF→file, 视频→video, 音频→audio). */
export const ATTACHMENT_LABEL_KEYS: Record<
  (typeof ATTACHMENT_MODALITIES)[number],
  MessageKey
> = {
  image: "providers.dialog.attachments.image",
  file: "providers.dialog.attachments.pdf",
  video: "providers.dialog.attachments.video",
  audio: "providers.dialog.attachments.audio",
};

/** The custom-provider branch's editable fields. */
export interface DialogCustomFields {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  authType: ProviderAuthType;
  baseURL: string;
}

export function blankDialogCustom(): DialogCustomFields {
  return {
    id: "",
    label: "",
    protocol: "openai",
    authType: "byok",
    baseURL: "",
  };
}

/** Entry-card header — the reference's 「模型 01」 zero-padded form. */
export function dialogEntryTitle(
  t: (key: MessageKey) => string,
  index: number,
): string {
  return t("providers.dialog.entryTitle").replace(
    "{{n}}",
    String(index + 1).padStart(2, "0"),
  );
}

/**
 * The dialog's save-time validation, as a pure function so the test
 * suite drives the rules themselves (the shell's job is only to call
 * this and refuse to PUT when it returns anything).
 *
 * Rules, in order: a provider must be chosen; a custom choice needs a
 * well-formed, unused id (a preset choice only needs the id to be
 * unused — the id IS the preset id); every model entry must pass the
 * shared row validator, reported under its 「模型 NN」 title.
 */
export function collectDialogErrors(input: {
  t: (key: MessageKey) => string;
  presetChoice: string | null;
  custom: DialogCustomFields;
  existingIds: string[];
  entries: DraftModel[];
}): string[] {
  const { t, presetChoice, custom, existingIds, entries } = input;
  const errors: string[] = [];
  if (presetChoice === null) errors.push(t("providers.dialog.errorProvider"));
  let providerId = "";
  if (presetChoice === PRESET_CHOICE_CUSTOM) {
    providerId = custom.id.trim();
    const idErr = validateProviderId(providerId);
    if (idErr) errors.push(idErr);
  } else if (presetChoice) {
    providerId = presetChoice;
  }
  if (providerId && existingIds.includes(providerId)) {
    errors.push(t("providers.dialog.errorDuplicate").replace("{{id}}", providerId));
  }
  entries.forEach((m, i) => {
    const mErr = validateModelRow(m);
    if (mErr) errors.push(`${dialogEntryTitle(t, i)}: ${mErr}`);
  });
  return errors;
}

/** The fetched-models dialog's landing state: every catalogue row
 *  checked, matching the reference's 全选 (11/11) first paint. */
export function defaultChecked(
  models: PresetCatalogueEntry["models"],
): Set<string> {
  return new Set(models.map((m) => m.id));
}

// ---------------------------------------------------------------------
// Controlled form surface — rendered by the shell, rendered by tests.
// ---------------------------------------------------------------------

export function AddModelDialogForm({
  t,
  presets,
  presetChoice,
  custom,
  apiKey,
  revealed,
  entries,
  errors,
  busy,
  onPresetChoice,
  onCustomField,
  onApiKey,
  onRevealToggle,
  onAddEntry,
  onAutoFetch,
  onEntryChange,
  onEntryRemove,
  onEntryReset,
  onCancel,
  onCommit,
}: {
  t: (key: MessageKey) => string;
  presets: PresetCatalogueEntry[] | null;
  presetChoice: string | null;
  custom: DialogCustomFields;
  apiKey: string;
  /** Drives the key input's `type` — the eye toggle is a prop, not
   *  buried widget state, so a static render per state IS the
   *  round-trip proof. */
  revealed: boolean;
  entries: DraftModel[];
  errors: string[];
  busy: boolean;
  onPresetChoice: (value: string) => void;
  onCustomField: (patch: Partial<DialogCustomFields>) => void;
  onApiKey: (value: string) => void;
  onRevealToggle: () => void;
  onAddEntry: () => void;
  onAutoFetch: () => void;
  onEntryChange: (index: number, next: DraftModel) => void;
  onEntryRemove: (index: number) => void;
  onEntryReset: (index: number) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="provider-dialog">
      {/* 提供商 —— desktop placeholder 「请选择提供商」; options are
       * the local preset catalogue plus the 「+ 其他」 escape hatch
       * that keeps the custom-provider capability (B4). */}
      <Field label={t("providers.dialog.provider")}>
        <AntSelect
          value={presetChoice ?? undefined}
          data-testid="provider-dialog-provider-select"
          placeholder={t("providers.dialog.providerPlaceholder")}
          onChange={(value) => onPresetChoice(value as string)}
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
                onChange={(e) => onCustomField({ id: e.target.value })}
                className="mavis-input"
              />
            </Field>
            <Field label={t("providers.field.label")}>
              <AntInput
                value={custom.label}
                data-testid="provider-dialog-custom-label"
                onChange={(e) => onCustomField({ label: e.target.value })}
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
                  onCustomField({ protocol: value as ProviderProtocol })
                }
                className="mavis-input"
                options={(["openai", "anthropic", "gemini"] as const).map(
                  (proto) => ({ label: proto, value: proto }),
                )}
              />
            </Field>
            <Field label={t("providers.field.authType")}>
              <AntSelect
                value={custom.authType}
                data-testid="provider-dialog-custom-authType"
                onChange={(value) =>
                  onCustomField({ authType: value as ProviderAuthType })
                }
                className="mavis-input"
                options={(["byok", "coding-plan"] as const).map((type) => ({
                  label: type,
                  value: type,
                }))}
              />
            </Field>
          </div>
          <Field label={t("providers.field.baseURL")}>
            <AntInput
              value={custom.baseURL}
              data-testid="provider-dialog-custom-baseURL"
              onChange={(e) => onCustomField({ baseURL: e.target.value })}
              className="mavis-input"
              placeholder={t("providers.field.baseURLHint")}
            />
          </Field>
        </div>
      ) : null}

      {/* API Key —— password input with the desktop's eye toggle. The
       * reveal is safe here (unlike the editor's field): the value is
       * what the user just typed, there is no stored key to unmask.
       * The `type` is driven by the `revealed` prop on the plain
       * AntInput — antd's Password widget owns its own eye state and
       * would put the toggle out of the form contract's reach. */}
      <Field label={t("providers.field.apiKey")}>
        <AntInput
          type={revealed ? "text" : "password"}
          value={apiKey}
          data-testid="provider-dialog-api-key"
          onChange={(e) => onApiKey(e.target.value)}
          className="mavis-input"
          placeholder={t("providers.dialog.apiKeyPlaceholder")}
          suffix={
            <button
              type="button"
              data-testid="provider-dialog-api-key-reveal"
              aria-label={t("providers.dialog.apiKeyPlaceholder")}
              title={revealed ? "hide" : "show"}
              onClick={onRevealToggle}
              className="flex items-center border-0 bg-transparent p-0 text-text_default_tertiary transition-colors hover:text-text_default_primary"
            >
              <Icon name={revealed ? "eye" : "eyeOff"} size={14} />
            </button>
          }
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
              onClick={onAddEntry}
              className="h-7 rounded-lg bg-bg_interaction_tertiary_hover px-2.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_selected"
            >
              {t("providers.dialog.addEntry")}
            </button>
            <button
              type="button"
              data-testid="provider-dialog-autofetch"
              onClick={onAutoFetch}
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
            onChange={(next) => onEntryChange(idx, next)}
            onRemove={() => onEntryRemove(idx)}
            onReset={() => onEntryReset(idx)}
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
          onClick={onCancel}
          className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
        >
          {t("providers.dialog.cancel")}
        </button>
        <button
          type="button"
          data-testid="provider-dialog-save"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={onCommit}
          className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? t("providers.saving") : t("providers.dialog.save")}
        </button>
      </div>
    </div>
  );
}

/** One model entry card — the reference's five-field form under a
 *  「模型 01」 header with the ↻ reset and 🗑 delete affordances. */
export function AddModelEntry({
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
  return (
    <div
      data-testid={`provider-dialog-entry-${index}`}
      className="flex flex-col gap-2 rounded-[8px] bg-bg_grouped_tertiary p-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-weight_medium text-text_default_primary">
          {dialogEntryTitle(t, index)}
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

// ---------------------------------------------------------------------
// Modal shells — state, fetch, validation, commit. Panel-rendered.
// ---------------------------------------------------------------------

export function AddModelDialog({
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
  const [custom, setCustom] = useState<DialogCustomFields>(blankDialogCustom);
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
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

  /** Wipe every form field back to the blank landing state. Called on
   *  cancel AND on a successful save, so a reopened dialog never
   *  shows the previous attempt's provider choice, key, entries, or
   *  validation errors. */
  const resetForm = useCallback(() => {
    setPresetChoice(null);
    setCustom(blankDialogCustom());
    setApiKey("");
    setRevealed(false);
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

  const commit = useCallback(async () => {
    const errs = collectDialogErrors({
      t,
      presetChoice,
      custom,
      existingIds,
      entries,
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
            id: custom.id.trim(),
            label: custom.label.trim() || custom.id.trim(),
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
  }, [t, presetChoice, custom, existingIds, entries, selectedPreset, apiKey, onSave, close]);

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
      <AddModelDialogForm
        t={t}
        presets={presets}
        presetChoice={presetChoice}
        custom={custom}
        apiKey={apiKey}
        revealed={revealed}
        entries={entries}
        errors={errors}
        busy={busy}
        onPresetChoice={setPresetChoice}
        onCustomField={(patch) => setCustom((c) => ({ ...c, ...patch }))}
        onApiKey={setApiKey}
        onRevealToggle={() => setRevealed((r) => !r)}
        onAddEntry={() => setEntries((cur) => [...cur, blankModel()])}
        onAutoFetch={() => setFetchedOpen(true)}
        onEntryChange={(index, next) =>
          setEntries((cur) => cur.map((x, i) => (i === index ? next : x)))
        }
        onEntryRemove={(index) =>
          setEntries((cur) => cur.filter((_, i) => i !== index))
        }
        onEntryReset={(index) =>
          setEntries((cur) =>
            cur.map((x, i) => (i === index ? blankModel() : x)),
          )
        }
        onCancel={close}
        onCommit={() => void commit()}
      />

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

/**
 * 「已获取模型」 — the auto-fetch checkbox dialog (ticket 54).
 *
 * Desktop form: a scrollable checkbox list, a bottom-left 「全选
 * (n/N)」 toggle, and 取消 / 添加 buttons. Local data policy: the list
 * is the selected preset's built-in catalogue and the note says so;
 * with no preset selected (custom provider / nothing chosen) the list
 * is empty and an explicit note states the local backend cannot query
 * a provider's live model list — the link stays clickable, the dialog
 * explains, and 添加 is disabled. No rows are invented.
 */
export function FetchedModelsDialog({
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
    if (open) setChecked(defaultChecked(models));
    // models identity changes only when the preset selection does;
    // re-seeding on every render would fight the user's clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id: string, next: boolean) =>
    setChecked((cur) => {
      const copy = new Set(cur);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  const allChecked = models.length > 0 && checked.size === models.length;
  const toggleAll = () =>
    setChecked(allChecked ? new Set() : defaultChecked(models));

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
      <FetchedModelsDialogBody
        t={t}
        presetMode={presetMode}
        models={models}
        checked={checked}
        onToggle={toggle}
        onToggleAll={toggleAll}
        allChecked={allChecked}
        onCancel={onCancel}
        onAdd={() => onAdd(models.filter((m) => checked.has(m.id)))}
      />
    </AntModal>
  );
}

/** The checkbox dialog's controlled body — what the render tests
 *  drive. `allChecked` is passed in (not recomputed) so the shell and
 *  the body cannot disagree about the 全选 box's checked state. */
export function FetchedModelsDialogBody({
  t,
  presetMode,
  models,
  checked,
  allChecked,
  onToggle,
  onToggleAll,
  onCancel,
  onAdd,
}: {
  t: (key: MessageKey) => string;
  presetMode: boolean;
  models: PresetCatalogueEntry["models"];
  checked: Set<string>;
  allChecked: boolean;
  onToggle: (id: string, next: boolean) => void;
  onToggleAll: () => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  return (
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
                onChange={(e) => onToggle(m.id, e.target.checked)}
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
              onChange={onToggleAll}
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
            onClick={onAdd}
            className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("providers.fetched.add")}
          </button>
        </div>
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
