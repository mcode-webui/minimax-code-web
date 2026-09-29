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

/**
 * One model entry's connectivity-test state (ticket 56, I3). A value
 * prop on the entry card, not widget state — the shell owns the probe
 * and the tests drive the three render branches through this type.
 *
 * Honesty note: the local probe contract (`POST /api/providers/test`)
 * is ENDPOINT-level — it exercises the provider's baseURL + key, not
 * the specific model id in the entry. The button's tooltip states
 * this granularity; the docs (webui.md / webui.zh-CN.md) pin it.
 */
export type EntryTestState =
  | { status: "testing" }
  | { status: "ok"; latencyMs?: number }
  | { status: "fail"; error: string };

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
  entryTests,
  canTest,
  onPresetChoice,
  onCustomField,
  onApiKey,
  onRevealToggle,
  onAddEntry,
  onAutoFetch,
  onEntryChange,
  onEntryRemove,
  onEntryReset,
  onEntryTest,
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
  /** Per-entry probe results keyed by entry index (I3). Passing the
   *  whole map keeps the form a pure function of props — the shell
   *  invalidates entries as the user edits them. */
  entryTests: Record<number, EntryTestState>;
  /** false until a provider is chosen AND a key is typed — the
   *  per-entry 检测 buttons render disabled (with the reason in
   *  their tooltip) instead of firing a probe the server would
   *  reject locally. */
  canTest: boolean;
  onPresetChoice: (value: string) => void;
  onCustomField: (patch: Partial<DialogCustomFields>) => void;
  onApiKey: (value: string) => void;
  onRevealToggle: () => void;
  onAddEntry: () => void;
  onAutoFetch: () => void;
  onEntryChange: (index: number, next: DraftModel) => void;
  onEntryRemove: (index: number) => void;
  onEntryReset: (index: number) => void;
  /** Fires the endpoint probe with the CURRENT form values for the
   *  entry at `index` (official semantics: 检测 uses what is filled
   *  in, not what is saved). */
  onEntryTest: (index: number) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  return (
    <div
      className="flex max-h-[calc(90vh-64px)] flex-col"
      data-testid="provider-dialog"
    >
      {/* Scrollable body region — every field section; the commit
       * pair lives in its own separated footer region below. The
       * 90vh clamp keeps the footer reachable on short viewports:
       * the filled custom branch (5 provider fields + entry cards)
       * otherwise grows past the overlay, which antd does not make
       * scrollable, and 取消/保存 end up below the fold with no
       * way to reach them (found live in the ticket-56 verify
       * round: 884px of content in a 633px viewport). */}
      <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-2">
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

      {/* 模型 —— the header row keeps the label and its actions
       *  ADJACENT (ticket 56 V5: the old justify-between layout left
       *  a wide dead gap between 「模型」 and the buttons, which read
       *  as a broken row). The two actions carry tooltips spelling
       *  out their division of labour (I2): manual entry vs
       *  catalogue pick, and the fetch-only semantics of 自动获取. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="desktop-text-ui-small-strong text-text_default_tertiary">
            {t("providers.dialog.models")}
          </span>
          <button
            type="button"
            data-testid="provider-dialog-model-add"
            title={t("providers.dialog.addEntryHint")}
            onClick={onAddEntry}
            className="h-7 rounded-lg bg-bg_interaction_tertiary_hover px-2.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_selected"
          >
            {t("providers.dialog.addEntry")}
          </button>
          <button
            type="button"
            data-testid="provider-dialog-autofetch"
            title={t("providers.dialog.autoFetchHint")}
            onClick={onAutoFetch}
            className="border-0 bg-transparent p-0 text-sm text-icon_default_accent transition-colors hover:opacity-80"
          >
            {t("providers.dialog.autoFetch")}
          </button>
        </div>

        {/* Empty state (I1): with no entries the section renders an
         *  explicit placeholder instead of collapsing to nothing —
         *  the 「not loaded yet」 ambiguity the user reported. */}
        {entries.length === 0 ? (
          <div
            data-testid="provider-dialog-models-empty"
            className="rounded-[8px] border border-dashed border-border_default px-3 py-4 text-center text-caption-small-strong text-text_default_tertiary"
          >
            {t("providers.dialog.modelsEmpty")}
          </div>
        ) : (
          entries.map((m, idx) => (
            <AddModelEntry
              key={idx}
              t={t}
              index={idx}
              model={m}
              canTest={canTest}
              testState={entryTests[idx] ?? null}
              onChange={(next) => onEntryChange(idx, next)}
              onRemove={() => onEntryRemove(idx)}
              onReset={() => onEntryReset(idx)}
              onTest={() => onEntryTest(idx)}
            />
          ))
        )}
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
      </div>

      {/* 取消 / 保存 —— a DEDICATED footer (ticket 56 V3): its own
       *  region behind a hairline separator with ≥16px of breathing
       *  room, so the commit pair no longer sits flush under the
       *  「＋ 添加 / 自动获取」 row. Buttons run at the h-9 (36px)
       *  control height with the radius-8 the mavis-input standard
       *  pins, and the black primary carries the token shadow so it
       *  reads as THE anchor action (V4). */}
      <div
        data-testid="provider-dialog-footer"
        className="mt-5 flex shrink-0 items-center justify-end gap-3 border-t border-border_default pt-4"
      >
        <button
          type="button"
          data-testid="provider-dialog-cancel"
          disabled={busy}
          onClick={onCancel}
          className="h-9 rounded-lg border border-border_default px-4 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
        >
          {t("providers.dialog.cancel")}
        </button>
        <button
          type="button"
          data-testid="provider-dialog-save"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={onCommit}
          className="h-9 min-w-20 rounded-lg bg-bg_interaction_primary_default px-5 text-sm font-weight_medium text-text_default_inverted_static shadow-[var(--shadow_default)] transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? t("providers.saving") : t("providers.dialog.save")}
        </button>
      </div>
    </div>
  );
}

/** One model entry card — the reference's five-field form under a
 *  「模型 01」 header with the 连通检测 (I3), ↻ reset, and 🗑 delete
 *  affordances. The probe is a labelled text button rather than the
 *  reference's refresh-shaped glyph because the card ALREADY has a
 *  refresh-shaped 重置 icon — two identical glyphs with different
 *  semantics was the ambiguity to avoid. */
export function AddModelEntry({
  t,
  index,
  model,
  canTest,
  testState,
  onChange,
  onRemove,
  onReset,
  onTest,
}: {
  t: (key: MessageKey) => string;
  index: number;
  model: DraftModel;
  /** Drives the 检测 button's disabled state — see
   *  `AddModelDialogForm.canTest`. */
  canTest: boolean;
  /** The probe outcome for THIS entry, a value prop (see
   *  `EntryTestState`); `null` renders no result line. */
  testState: EntryTestState | null;
  onChange: (next: DraftModel) => void;
  onRemove: () => void;
  onReset: () => void;
  onTest: () => void;
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
          {/* 连通检测 (I3) — official semantics: probe with the
           *  CURRENTLY FILLED provider info, before saving. The
           *  tooltip states the local probe's endpoint-level
           *  granularity (it does not exercise this entry's model
           *  id specifically). */}
          <button
            type="button"
            data-testid={`provider-dialog-entry-${index}-test`}
            title={
              canTest
                ? t("providers.dialog.entryTestHint")
                : t("providers.dialog.testNeedProvider")
            }
            disabled={testState?.status === "testing"}
            onClick={onTest}
            className="h-7 rounded-md border border-border_default bg-transparent px-2 text-caption-small-strong text-text_default_secondary transition-colors hover:border-icon_default_accent hover:text-icon_default_accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testState?.status === "testing"
              ? t("providers.dialog.testTesting")
              : t("providers.dialog.entryTest")}
          </button>
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

      {/* Probe result line — one of three controlled branches; the
       *  ok/fail colours are the status tokens, the latency/error
       *  text is the server's structured answer, not a guess. */}
      {testState ? (
        <div
          data-testid={`provider-dialog-entry-${index}-test-result`}
          className={
            "text-caption-small-strong " +
            (testState.status === "ok"
              ? "text-text_status_success"
              : testState.status === "fail"
                ? "text-text_status_error"
                : "text-text_default_tertiary")
          }
        >
          {testState.status === "ok"
            ? t("providers.dialog.testOk").replace(
                "{{ms}}",
                testState.latencyMs != null ? String(testState.latencyMs) : "—",
              )
            : testState.status === "fail"
              ? t("providers.dialog.testFail").replace(
                  "{{error}}",
                  testState.error,
                )
              : t("providers.dialog.testTesting")}
        </div>
      ) : null}

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
  // Per-entry probe outcomes (I3), keyed by entry index. Invalidated
  // entry-by-entry: editing/resetting an entry drops its stale
  // result, removing one shifts the tail down, and any change to the
  // SHARED provider fields (choice / key) drops every result — the
  // probe answered a question the form no longer asks.
  const [entryTests, setEntryTests] = useState<Record<number, EntryTestState>>(
    {},
  );

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
    setEntryTests({});
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

  // -------------------------------------------------------------------
  // 连通检测 (I3) — official semantics: the button next to a model
  // entry probes with what the form has NOW, before any save. The
  // local implementation reuses the server's existing
  // `POST /api/providers/test` contract verbatim (no new route):
  // protocol whitelist → local key-format check → endpoint fetch.
  // Raw fetch for the same reason the presets fetch above uses one —
  // importing the panel's api graph here would drag it into the
  // render-test process this file was split out to protect.
  //
  // Granularity honesty: the probe is endpoint-level (baseURL +
  // key); it does NOT exercise this entry's model id. The tooltip
  // and both docs say so — mirroring the reference's wording while
  // claiming model-level coverage the backend does not have would
  // be fabrication.
  // -------------------------------------------------------------------
  const testEntry = useCallback(
    async (index: number) => {
      const protocol =
        presetChoice === PRESET_CHOICE_CUSTOM
          ? custom.protocol
          : (selectedPreset?.protocol ?? "");
      const authType =
        presetChoice === PRESET_CHOICE_CUSTOM
          ? custom.authType
          : (selectedPreset?.auth.type ?? "byok");
      const baseURL =
        presetChoice === PRESET_CHOICE_CUSTOM
          ? custom.baseURL
          : (selectedPreset?.auth.baseURL ?? "");
      if (!presetChoice || !protocol) {
        // Unreachable through the disabled button — kept as the
        // defensive floor: the probe must never fire without a
        // resolvable endpoint.
        setEntryTests((cur) => ({
          ...cur,
          [index]: { status: "fail", error: t("providers.dialog.testNeedProvider") },
        }));
        return;
      }
      setEntryTests((cur) => ({ ...cur, [index]: { status: "testing" } }));
      try {
        const res = await fetch("/api/providers/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol,
            auth: { type: authType, apiKey, baseURL },
            // 4s — the user is waiting at an open dialog; the wire
            // default is 8 (same cut the panel's test button makes).
            timeoutMs: 4000,
          }),
        });
        const body = (await res.json()) as {
          ok?: boolean;
          code?: string;
          error?: string;
          latencyMs?: number;
        };
        setEntryTests((cur) => ({
          ...cur,
          [index]: body.ok
            ? { status: "ok", latencyMs: body.latencyMs }
            : {
                status: "fail",
                error: body.error || body.code || `HTTP ${res.status}`,
              },
        }));
      } catch (cause) {
        setEntryTests((cur) => ({
          ...cur,
          [index]: {
            status: "fail",
            error: cause instanceof Error ? cause.message : String(cause),
          },
        }));
      }
    },
    [presetChoice, custom, apiKey, selectedPreset, t],
  );

  /** Drop one entry's probe result (its inputs just changed) and
   *  shift the tail down on remove, so results stay indexed to the
   *  entries they answered for. */
  const dropEntryTest = useCallback((index: number) => {
    setEntryTests((cur) => {
      const { [index]: _stale, ...rest } = cur;
      return rest;
    });
  }, []);
  const shiftEntryTestsAfter = useCallback((removedIndex: number) => {
    setEntryTests((cur) => {
      const next: Record<number, EntryTestState> = {};
      for (const [key, value] of Object.entries(cur)) {
        const i = Number(key);
        if (i < removedIndex) next[i] = value;
        else if (i > removedIndex) next[i - 1] = value;
      }
      return next;
    });
  }, []);

  /** Mirrors the server's LOCAL validation gate (`validateKeyFormat`):
   *  a byok probe needs a typed key; a coding-plan probe fires with
   *  the endpoint alone (the catalogue's claude-code / codex /
   *  opencode-go presets are coding-plan — their key is optional
   *  server-side, so the button must not demand one). */
  const probeAuthType =
    presetChoice === PRESET_CHOICE_CUSTOM
      ? custom.authType
      : (selectedPreset?.auth.type ?? "byok");
  const canTest =
    presetChoice !== null &&
    (probeAuthType === "coding-plan" || apiKey.trim().length > 0);

  return (
    <AntModal
      open={open}
      onCancel={close}
      footer={null}
      width={640}
      centered
      styles={{
        // Ticket 56 V1/V2: vertically centred card, radius + elevation
        // from the token ramp (the same --radius_12 the official
        // mavis-modal standard pins) instead of antd's flat default.
        content: {
          borderRadius: "var(--radius_12)",
          boxShadow:
            "0 4px 16px var(--opacity_black_1_8), 0 12px 40px var(--opacity_black_1_15)",
        },
      }}
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
        entryTests={entryTests}
        canTest={canTest}
        onPresetChoice={(value) => {
          setPresetChoice(value);
          // Shared probe inputs changed — every outstanding result is
          // now an answer to a different question.
          setEntryTests({});
        }}
        onCustomField={(patch) => {
          setCustom((c) => ({ ...c, ...patch }));
          // protocol / baseURL / authType all land in the probe body —
          // a stale verdict must not survive any of them changing.
          if (
            patch.protocol !== undefined ||
            patch.baseURL !== undefined ||
            patch.authType !== undefined
          ) {
            setEntryTests({});
          }
        }}
        onApiKey={(value) => {
          setApiKey(value);
          // The key is THE probe credential — an outstanding verdict
          // answered for a different key is stale (the comment on
          // entryTests promises this; keep the wiring honest). The
          // identity-preserving no-op keeps keystrokes cheap when
          // there is nothing to drop.
          setEntryTests((cur) =>
            Object.keys(cur).length === 0 ? cur : {},
          );
        }}
        onRevealToggle={() => setRevealed((r) => !r)}
        onAddEntry={() => setEntries((cur) => [...cur, blankModel()])}
        onAutoFetch={() => setFetchedOpen(true)}
        onEntryChange={(index, next) => {
          setEntries((cur) => cur.map((x, i) => (i === index ? next : x)));
          dropEntryTest(index);
        }}
        onEntryRemove={(index) => {
          setEntries((cur) => cur.filter((_, i) => i !== index));
          shiftEntryTestsAfter(index);
        }}
        onEntryReset={(index) => {
          setEntries((cur) =>
            cur.map((x, i) => (i === index ? blankModel() : x)),
          );
          dropEntryTest(index);
        }}
        onEntryTest={(index) => void testEntry(index)}
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
      centered
      styles={{
        // Same token-pinned card treatment as the parent dialog
        // (ticket 56 V1/V2) — one visual language across both
        // modals, not two.
        content: {
          borderRadius: "var(--radius_12)",
          boxShadow:
            "0 4px 16px var(--opacity_black_1_8), 0 12px 40px var(--opacity_black_1_15)",
        },
      }}
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
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="fetched-models-cancel"
            onClick={onCancel}
            className="h-9 rounded-lg border border-border_default px-4 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {t("providers.dialog.cancel")}
          </button>
          <button
            type="button"
            data-testid="fetched-models-add"
            disabled={!presetMode || checked.size === 0}
            onClick={onAdd}
            className="h-9 min-w-20 rounded-lg bg-bg_interaction_primary_default px-5 text-sm font-weight_medium text-text_default_inverted_static shadow-[var(--shadow_default)] transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
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
