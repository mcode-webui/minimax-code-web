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
 *   - `blankDialogSeed` / `editSeedFromDraft` — the two OPENING
 *     states of this one dialog. 「+ 新增」 seeds blank; a click on an
 *     existing provider row seeds from that provider. Keeping both
 *     entry points in one component is what makes the retired flat
 *     editor unnecessary rather than merely replaced.
 *   - `API_FORMAT_SPECS` — what the 「API 格式」 selection actually
 *     changes, transcribed from the server's probe.
 *
 * Two entry points, one form: the panel passes `editTarget` and the
 * dialog seeds from it. `enabled`, `preset` and `draftId` are
 * properties of the RECORD, so the commit starts from the stored
 * draft rather than rebuilding one — rebuilding would re-enable a
 * disabled provider or detach it from its preset.
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
  headerPairsToRecord,
  newDraftProvider,
  validateModelRow,
  validateProviderId,
  THINKING_LEVELS,
  type DraftHeaderRow,
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

/** The custom-provider branch's editable fields.
 *
 *  `protocol` used to live here. It moved OUT to the dialog's top-level
 *  「API 格式」 dropdown (ticket 85) because the desktop shows that
 *  control for EVERY provider, not only for custom ones — keeping it
 *  here would have meant two controls bound to one value, with the
 *  preset branch's copy invisible.
 *
 *  `baseURL` moved OUT for the same reason (this slice): the desktop
 *  renders 「接口地址」 for EVERY provider, seeded from the chosen
 *  provider and editable afterwards. Leaving it inside the
 *  「其他（自定义）」 branch made the field — the very one the
 *  「API 格式」 selection changes — invisible for every preset. */
export interface DialogCustomFields {
  id: string;
  label: string;
  authType: ProviderAuthType;
}

export function blankDialogCustom(): DialogCustomFields {
  return {
    id: "",
    label: "",
    authType: "byok",
  };
}

/** The protocols this build supports, in the desktop's dropdown order,
 *  each paired with the label the desktop shows. The VALUES are the
 *  wire `protocol` enum — this is a relabelling of an existing field,
 *  not a new format the backend has to learn. */
export const API_FORMAT_OPTIONS: ReadonlyArray<{
  value: ProviderProtocol;
  labelKey: MessageKey;
}> = [
  { value: "openai", labelKey: "providers.dialog.apiFormat.openai" },
  { value: "anthropic", labelKey: "providers.dialog.apiFormat.anthropic" },
  { value: "gemini", labelKey: "providers.dialog.apiFormat.gemini" },
];

/** One row of the 自定义 Headers list. Both halves are raw user input;
 *  the wire object is produced by `headerPairsToRecord`. */
export type DialogHeaderRow = DraftHeaderRow;

/**
 * What the 「API 格式」 selection actually CHANGES, per protocol.
 *
 * Every value here is transcribed from the server's probe
 * (`server/lib/providers-config.js`): `probe()` sends a different
 * request per protocol, and `DEFAULT_BASE_URL` holds the fallback
 * host each one resolves against when the field is left blank. The
 * dialog surfaces that difference instead of letting the operator
 * discover it by a failed 连通检测.
 *
 * Field-presence note (honesty, not an omission): the three protocols
 * share ONE wire shape — the providers PUT contract carries the same
 * fields for all of them — so there is no field this build can
 * legitimately hide per format. The linkage is therefore the endpoint
 * placeholder, the exact request the probe will make, and the
 * credential's transport (a query parameter for Gemini, a header for
 * the other two). Inventing a hidden field would be a form the
 * backend cannot save.
 */
export const API_FORMAT_SPECS: Record<
  ProviderProtocol,
  {
    /** The server's `DEFAULT_BASE_URL[protocol]` — shown as the
     *  接口地址 placeholder so the default is visible before typing. */
    defaultBaseURL: string;
    /** The request `probe()` builds, with `{baseURL}` for the field. */
    probeRequest: string;
    /** How the API key travels on that request. */
    credentialKey: MessageKey;
  }
> = {
  openai: {
    defaultBaseURL: "https://api.openai.com",
    probeRequest: "GET {baseURL}/v1/models",
    credentialKey: "providers.dialog.credential.openai",
  },
  anthropic: {
    defaultBaseURL: "https://api.anthropic.com",
    probeRequest: "POST {baseURL}/v1/messages",
    credentialKey: "providers.dialog.credential.anthropic",
  },
  gemini: {
    defaultBaseURL: "https://generativelanguage.googleapis.com",
    probeRequest: "GET {baseURL}/v1beta/models?key=…",
    credentialKey: "providers.dialog.credential.gemini",
  },
};

/** The seeded values a dialog opens with — one shape for 「+ 新增」
 *  (blank) and 「编辑」 (pre-filled from an existing provider), so the
 *  two entry points cannot drift into two different forms. */
export interface DialogSeed {
  presetChoice: string | null;
  custom: DialogCustomFields;
  apiFormat: ProviderProtocol;
  baseURL: string;
  apiKey: string;
  headers: DialogHeaderRow[];
  entries: DraftModel[];
}

/**
 * The 「+ 新增」 seed — every field blank, the format on the first
 * supported protocol.
 */
export function blankDialogSeed(): DialogSeed {
  return {
    presetChoice: null,
    custom: blankDialogCustom(),
    apiFormat: "openai",
    baseURL: "",
    apiKey: "",
    headers: [],
    entries: [],
  };
}

/**
 * The 「编辑」 seed — an existing provider projected onto the same form.
 *
 * Three decisions worth stating:
 *
 *   - `presetChoice` is the provider's `preset` when it was
 *     materialised from the catalogue, and 「+ 其他（自定义）」
 *     otherwise — so reopening an edit lands the operator on the
 *     branch the provider actually lives on.
 *   - `apiKey` is ALWAYS empty. The providers GET returns only a
 *     masked key, and an empty apiKey on the PUT is the server's
 *     keep-the-existing-key sentinel, so an untouched edit preserves
 *     the stored credential; a typed one replaces it.
 *   - `baseURL` and `headers` are carried verbatim — they are the
 *     values the provider is already using, and blanking them would
 *     silently reset a working configuration.
 */
export function editSeedFromDraft(draft: DraftProvider): DialogSeed {
  return {
    presetChoice: draft.preset ?? PRESET_CHOICE_CUSTOM,
    custom: {
      id: draft.id,
      label: draft.label,
      authType: draft.auth.type,
    },
    apiFormat: draft.protocol,
    baseURL: draft.auth.baseURL,
    apiKey: "",
    headers: draft.auth.headers.map((row) => ({ ...row })),
    entries: draft.models.map((m) => ({ ...m })),
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
  apiFormat,
  custom,
  baseURL,
  apiKey,
  apiKeyPlaceholder,
  revealed,
  headers,
  entries,
  errors,
  busy,
  entryTests,
  canTest,
  formTest,
  skipTest,
  onPresetChoice,
  onApiFormat,
  onCustomField,
  onBaseURL,
  onApiKey,
  onRevealToggle,
  onHeaderChange,
  onHeaderAdd,
  onHeaderRemove,
  onAddEntry,
  onAutoFetch,
  onEntryChange,
  onEntryRemove,
  onEntryReset,
  onEntryTest,
  onFormTest,
  onSkipTestToggle,
  onCancel,
  onCommit,
}: {
  t: (key: MessageKey) => string;
  presets: PresetCatalogueEntry[] | null;
  presetChoice: string | null;
  /** The 「API 格式」 selection — the wire `protocol`, for presets and
   *  custom providers alike. */
  apiFormat: ProviderProtocol;
  /** The custom-provider branch's editable fields. */
  custom: DialogCustomFields;
  /** The 接口地址 value — top level, because the desktop shows the
   *  field for EVERY provider and it is the field the 「API 格式」
   *  selection changes. */
  baseURL: string;
  apiKey: string;
  /** The key input's placeholder. In 「编辑」 mode the shell passes the
   *  server's MASKED value, so the operator can see what is stored
   *  without the form ever round-tripping the mask as a real key. */
  apiKeyPlaceholder: string;
  /** Drives the key input's `type` — the eye toggle is a prop, not
   *  buried widget state, so a static render per state IS the
   *  round-trip proof. */
  revealed: boolean;
  /** The 自定义 Headers rows. */
  headers: DialogHeaderRow[];
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
  /** The FORM-level connectivity verdict (ticket 85) — the desktop's
   *  footer 连通检测. `null` means "not run yet", which is what keeps
   *  保存 disabled until it passes or the operator skips it. */
  formTest: EntryTestState | null;
  skipTest: boolean;
  onPresetChoice: (value: string) => void;
  onApiFormat: (value: ProviderProtocol) => void;
  onCustomField: (patch: Partial<DialogCustomFields>) => void;
  onBaseURL: (value: string) => void;
  onApiKey: (value: string) => void;
  onRevealToggle: () => void;
  onHeaderChange: (index: number, patch: Partial<DialogHeaderRow>) => void;
  onHeaderAdd: () => void;
  onHeaderRemove: (index: number) => void;
  onAddEntry: () => void;
  onAutoFetch: () => void;
  onEntryChange: (index: number, next: DraftModel) => void;
  onEntryRemove: (index: number) => void;
  onEntryReset: (index: number) => void;
  /** Fires the endpoint probe with the CURRENT form values for the
   *  entry at `index` (official semantics: 检测 uses what is filled
   *  in, not what is saved). */
  onEntryTest: (index: number) => void;
  onFormTest: () => void;
  onSkipTestToggle: (next: boolean) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  // The 「API 格式」 selection's whole visible consequence, resolved
  // once so every dependent surface below reads the same spec (see
  // API_FORMAT_SPECS). An unknown protocol cannot reach here — the
  // dropdown only offers the three the server whitelists — but the
  // lookup is total anyway, so a future protocol added to one side
  // and not the other renders the openai spec instead of crashing.
  const formatSpec = API_FORMAT_SPECS[apiFormat] ?? API_FORMAT_SPECS.openai;
  // The endpoint the probe will ACTUALLY hit: the typed base URL, or
  // the protocol default the server falls back to when the field is
  // blank. Showing the resolved target (not the raw template) is what
  // makes an empty field understandable.
  const probeTarget = formatSpec.probeRequest.replace(
    "{baseURL}",
    baseURL.trim() || formatSpec.defaultBaseURL,
  );

  return (
    <div
      className="flex max-h-[calc(90vh-64px)] flex-col"
      data-testid="provider-dialog"
    >
      <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-2">
      {/* Scrollable body region — every field section; the commit
       * pair lives in its own separated footer region below. The
       * 90vh clamp keeps the footer reachable on short viewports:
       * the filled custom branch (5 provider fields + entry cards)
       * otherwise grows past the overlay, which antd does not make
       * scrollable, and 取消/保存 end up below the fold with no
       * way to reach them (found live in the ticket-56 verify
       * round: 884px of content in a 633px viewport). */}
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

      {/* API 格式 — the desktop's second field, shown for EVERY
       *  provider (not just 「其他（自定义）」). It is the existing
       *  wire `protocol` under the desktop's labels, so nothing new
       *  reaches the backend: the value a preset arrives with is
       *  pre-filled by the shell and stays editable. */}
      <Field label={t("providers.dialog.apiFormat")}>
        <AntSelect
          value={apiFormat}
          data-testid="provider-dialog-api-format"
          onChange={(value) => onApiFormat(value as ProviderProtocol)}
          className="mavis-input"
          options={API_FORMAT_OPTIONS.map((opt) => ({
            value: opt.value,
            label: t(opt.labelKey),
          }))}
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
        </div>
      ) : null}

      {/* 接口地址 — top level, for EVERY provider (desktop order: it
       *  sits directly under 「API 格式」 and is never inside the
       *  「其他（自定义）」 branch). A preset seeds it with the
       *  catalogue's endpoint; the operator may override it, and an
       *  empty field defers to the protocol default the server also
       *  uses — the same value the placeholder names.
       *
       *  The two lines under the input are the format's spec, not
       *  decoration: they state the request 连通检测 will send and
       *  where the key travels on it, so a mismatched endpoint fails
       *  with an explanation on screen instead of a bare HTTP 404. */}
      <Field label={t("providers.field.baseURL")}>
        <AntInput
          value={baseURL}
          data-testid="provider-dialog-base-url"
          onChange={(e) => onBaseURL(e.target.value)}
          className="mavis-input"
          placeholder={formatSpec.defaultBaseURL}
          data-protocol={apiFormat}
        />
        <p
          data-testid="provider-dialog-base-url-hint"
          className="text-caption-small-strong text-text_default_tertiary"
        >
          {t("providers.dialog.probeHint").replace("{{request}}", probeTarget)}
        </p>
        <p
          data-testid="provider-dialog-credential-hint"
          className="text-caption-small-strong text-text_default_tertiary"
        >
          {t(formatSpec.credentialKey)}
        </p>
      </Field>

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
          placeholder={apiKeyPlaceholder}
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

      {/* 自定义 Headers — the desktop's fifth field, and the one the
       *  local dialog was missing entirely. These are EXTRA outbound
       *  headers, merged into every request this provider makes
       *  (the runtime merges `options.headers`); they are not a
       *  replacement for the API Key, which has its own field above.
       *
       *  Rows are a list, not an object, so a half-typed row
       *  survives; `headerPairsToRecord` is the single place that
       *  decides what is sendable (blank names dropped, later
       *  duplicates winning). */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="desktop-text-ui-small-strong text-text_default_tertiary">
            {t("providers.dialog.headers")}
          </span>
          <button
            type="button"
            data-testid="provider-dialog-headers-add"
            onClick={onHeaderAdd}
            className="h-7 rounded-lg border border-border_default px-2.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {t("providers.dialog.headersAdd")}
          </button>
        </div>
        {headers.length === 0 ? (
          <p
            data-testid="provider-dialog-headers-empty"
            className="text-caption-small-strong text-text_default_tertiary"
          >
            {t("providers.dialog.headersAdd")}
          </p>
        ) : (
          headers.map((row, idx) => (
            <div
              key={idx}
              data-testid={`provider-dialog-header-${idx}`}
              className="flex items-center gap-2"
            >
              <AntInput
                value={row.name}
                data-testid={`provider-dialog-header-${idx}-name`}
                aria-label={t("providers.dialog.headerName")}
                placeholder={t("providers.dialog.headerName")}
                onChange={(e) => onHeaderChange(idx, { name: e.target.value })}
                className="mavis-input"
              />
              <AntInput
                value={row.value}
                data-testid={`provider-dialog-header-${idx}-value`}
                aria-label={t("providers.dialog.headerValue")}
                placeholder={t("providers.dialog.headerValue")}
                onChange={(e) => onHeaderChange(idx, { value: e.target.value })}
                className="mavis-input"
              />
              <button
                type="button"
                data-testid={`provider-dialog-header-${idx}-remove`}
                title={t("providers.dialog.headerRemove").replace(
                  "{{name}}",
                  row.name.trim() || `#${idx + 1}`,
                )}
                aria-label={t("providers.dialog.headerRemove").replace(
                  "{{name}}",
                  row.name.trim() || `#${idx + 1}`,
                )}
                onClick={() => onHeaderRemove(idx)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary"
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))
        )}
      </div>

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
       *  reads as THE anchor action (V4).
       *
       *  Ticket 85 — the desktop's form-level 连通检测 + 跳过连通检测
       *  land on the LEFT of this bar, mirroring the reference footer
       *  (`other-minimax-code/.../UsageModelSettings.tsx:318`). The
       *  per-entry 检测 on each model card is a DIFFERENT scope and
       *  stays: it answers "does this model id respond", this one
       *  answers "can this provider be reached at all".
       *
       *  保存 gating: the desktop disables it until the form-level
       *  probe passes, and the reference screenshot shows exactly
       *  that greyed state. A disabled control is not a dead one —
       *  the reason is spelled out next to it and two controls
       *  (连通检测 / 跳过连通检测) lift it. */}
      <div
        data-testid="provider-dialog-footer"
        className="mt-5 flex shrink-0 items-center justify-between gap-3 border-t border-border_default pt-4"
      >
        <div className="flex min-w-0 flex-col items-start gap-1">
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-caption-small-strong text-text_default_secondary">
              <input
                type="checkbox"
                checked={skipTest}
                data-testid="provider-dialog-skip-test"
                onChange={(e) => onSkipTestToggle(e.target.checked)}
                className="size-3.5 accent-[var(--border_accent)]"
              />
              {t("providers.dialog.formTestSkip")}
            </label>
            <button
              type="button"
              data-testid="provider-dialog-form-test"
              title={canTest ? t("providers.dialog.formTestHint") : t("providers.dialog.formTestNeedProvider")}
              disabled={!canTest || formTest?.status === "testing"}
              onClick={onFormTest}
              className="h-7 rounded-lg border border-border_default px-2.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {formTest?.status === "testing"
                ? t("providers.dialog.testTesting")
                : t("providers.dialog.formTest")}
            </button>
          </div>
          {/* Two mutually exclusive reasons to be disabled, and the one
            *  line that says which. Without it a greyed 保存 is a
            *  mystery; with it the operator knows which of the two
            *  controls to use. */}
          {!skipTest && formTest?.status !== "ok" ? (
            <p
              data-testid="provider-dialog-save-blocked"
              className="text-caption-small-strong text-text_default_tertiary"
            >
              {canTest
                ? t("providers.dialog.formTestHint")
                : t("providers.dialog.formTestNeedProvider")}
            </p>
          ) : null}
          {formTest && formTest.status !== "testing" ? (
            <p
              data-testid="provider-dialog-form-test-result"
              className={
                "text-caption-small-strong " +
                (formTest.status === "ok"
                  ? "text-text_status_success"
                  : "text-text_status_error")
              }
            >
              {formTest.status === "ok"
                ? t("providers.dialog.testOk").replace(
                    "{{ms}}",
                    formTest.latencyMs != null ? String(formTest.latencyMs) : "—",
                  )
                : t("providers.dialog.testFail").replace(
                    "{{error}}",
                    formTest.error,
                  )}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
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
          disabled={busy || (!skipTest && formTest?.status !== "ok")}
          aria-busy={busy || undefined}
          onClick={onCommit}
          className="h-9 min-w-20 rounded-lg bg-bg_interaction_primary_default px-5 text-sm font-weight_medium text-text_label_primary_default shadow-[var(--shadow_default)] transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? t("providers.saving") : t("providers.dialog.save")}
        </button>
        </div>
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
  editTarget = null,
  onCancel,
  onSave,
}: {
  t: (key: MessageKey) => string;
  open: boolean;
  /** ids already configured — the dialog refuses to create a
   *  duplicate (the server would reject the whole PUT). The panel
   *  excludes the provider being EDITED, whose own id is not a
   *  duplicate of itself. */
  existingIds: string[];
  /** The provider being edited, or null for 「+ 新增」. One component,
   *  two entry points: the panel opens the same dialog pre-filled
   *  from `editSeedFromDraft` instead of a second editor surface. */
  editTarget?: DraftProvider | null;
  onCancel: () => void;
  /** Panel-owned commit: merge + PUT. Resolves false on failure so
   *  the dialog stays open with the user's input intact. */
  onSave: (draft: DraftProvider) => Promise<boolean>;
}) {
  const [presets, setPresets] = useState<PresetCatalogueEntry[] | null>(null);
  const [presetChoice, setPresetChoice] = useState<string | null>(null);
  // The 「API 格式」 selection, for presets and custom alike (ticket 85).
  // Re-seeded from the preset whenever the choice changes, so picking a
  // preset lands on the format that preset actually speaks while the
  // operator can still override it.
  const [apiFormat, setApiFormat] = useState<ProviderProtocol>("openai");
  const [custom, setCustom] = useState<DialogCustomFields>(blankDialogCustom);
  // 接口地址 — top level since it moved out of the custom branch; the
  // chosen provider seeds it, the operator may override it.
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  // 自定义 Headers rows (ticket 85) — a list, so a half-typed row is not
  // lost; `headerPairsToRecord` collapses it at commit time.
  const [headers, setHeaders] = useState<DialogHeaderRow[]>([]);
  const [entries, setEntries] = useState<DraftModel[]>([]);
  const [fetchedOpen, setFetchedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // Form-level connectivity verdict (ticket 85) — the desktop's footer
  // 连通检测. Kept separate from `entryTests` because the two answer
  // different questions and must invalidate independently.
  const [formTest, setFormTest] = useState<EntryTestState | null>(null);
  const [skipTest, setSkipTest] = useState(false);
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
    setApiFormat("openai");
    setCustom(blankDialogCustom());
    setBaseURL("");
    setApiKey("");
    setRevealed(false);
    setHeaders([]);
    setEntries([]);
    setErrors([]);
    setEntryTests({});
    setFormTest(null);
    setSkipTest(false);
  }, []);

  // Seed the form from the entry point. The `seededFor` ref keys the
  // effect to ONE (target, open-epoch) pair: without it, a re-render
  // caused by the presets fetch landing would wipe the operator's
  // typing by re-seeding, and an effect keyed only to `open` would
  // miss the edit target changing while the dialog stays open.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seedKey = open ? (editTarget ? `edit:${editTarget.draftId}` : "add") : null;
  useEffect(() => {
    if (seedKey === null || seededFor === seedKey) return;
    const seed = editTarget ? editSeedFromDraft(editTarget) : blankDialogSeed();
    setPresetChoice(seed.presetChoice);
    setApiFormat(seed.apiFormat);
    setCustom(seed.custom);
    setBaseURL(seed.baseURL);
    setApiKey(seed.apiKey);
    setRevealed(false);
    setHeaders(seed.headers);
    setEntries(seed.entries);
    setErrors([]);
    setEntryTests({});
    // An edit opens with no verdict: 保存 stays gated until the
    // operator runs 连通检测 (or ticks 跳过) against the edited
    // values, exactly as on 「+ 新增」. Silently inheriting a pass
    // would let an unverified change through.
    setFormTest(null);
    setSkipTest(false);
    setSeededFor(seedKey);
  }, [seedKey, seededFor, editTarget]);

  const close = useCallback(() => {
    resetForm();
    setSeededFor(null);
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
    // One place decides which headers are sendable, so the dialog, the
    // wire body and the server can never disagree about what the
    // operator typed.
    const headerRecord = headerPairsToRecord(headers);
    // An EDIT reuses the stored provider as its base: `draftId`,
    // `enabled`, `preset` and the keep-key `apiKey` sentinel are
    // properties of the record, not of the form, and rebuilding them
    // from scratch would silently re-enable a disabled provider or
    // detach it from its preset. Only the fields the operator can
    // reach in the dialog are taken from the form state.
    const base: DraftProvider = editTarget ?? { ...newDraftProvider() };
    const sharedAuth = {
      // Edit: an untouched field is "" — the server's
      // keep-the-existing-key sentinel, which is why the seed leaves
      // `apiKey` empty and the mask rides in the placeholder only.
      apiKey,
      baseURL,
      headers: Object.keys(headerRecord).length
        ? Object.entries(headerRecord).map(([name, value]) => ({ name, value }))
        : [],
    };
    const draft: DraftProvider =
      presetChoice === PRESET_CHOICE_CUSTOM
        ? {
            ...base,
            isNew: false,
            id: custom.id.trim(),
            label: custom.label.trim() || custom.id.trim(),
            protocol: apiFormat,
            auth: { type: custom.authType, ...sharedAuth },
            models: entries,
          }
        : {
            ...base,
            isNew: false,
            id: selectedPreset?.id ?? base.id,
            label: selectedPreset
              ? PRESET_DISPLAY_LABELS[selectedPreset.id] ?? selectedPreset.label
              : base.label,
            protocol: apiFormat,
            auth: { type: selectedPreset?.auth.type ?? "byok", ...sharedAuth },
            preset: selectedPreset?.id ?? base.preset,
            models: entries,
          };
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) close();
  }, [t, presetChoice, custom, existingIds, entries, selectedPreset, apiKey, baseURL, headers, apiFormat, editTarget, onSave, close]);

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
  /** The single probe both buttons fire. Raw `fetch` to the existing
   *  `POST /api/providers/test` contract — no new route — for the same
   *  reason the presets fetch above uses one: importing the panel's
   *  api graph here would drag it into the render-test process this
   *  file was split out to protect.
   *
   *  `auth` is assembled from the LIVE form values so 检测 means
   *  "can I reach this as currently filled", not "was this reachable
   *  when I saved it". The custom headers ride along: the probe must
   *  exercise the request that will actually be sent (see the same
   *  reasoning on the server's `probe()`).
   *
   *  Granularity honesty: the probe is endpoint-level (baseURL + key +
   *  headers); it does NOT exercise a specific model id. The tooltips
   *  and both docs say so — mirroring the reference's wording while
   *  claiming model-level coverage the backend does not have would
   *  be fabrication. */
  const runProbe = useCallback(async (): Promise<EntryTestState> => {
    const protocol = apiFormat;
    const authType =
      presetChoice === PRESET_CHOICE_CUSTOM
        ? custom.authType
        : (selectedPreset?.auth.type ?? "byok");
    const headerRecord = headerPairsToRecord(headers);
    if (!presetChoice || !protocol) {
      // Unreachable through the disabled button — kept as the
      // defensive floor: the probe must never fire without a
      // resolvable endpoint.
      return { status: "fail", error: t("providers.dialog.testNeedProvider") };
    }
    try {
      const res = await fetch("/api/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol,
          auth: {
            type: authType,
            apiKey,
            baseURL,
            ...(Object.keys(headerRecord).length > 0 ? { headers: headerRecord } : {}),
          },
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
      return body.ok
        ? { status: "ok", latencyMs: body.latencyMs }
        : {
            status: "fail",
            error: body.error || body.code || `HTTP ${res.status}`,
          };
    } catch (cause) {
      return {
        status: "fail",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [apiFormat, presetChoice, custom.authType, apiKey, baseURL, headers, selectedPreset, t]);

  const testEntry = useCallback(
    async (index: number) => {
      setEntryTests((cur) => ({ ...cur, [index]: { status: "testing" } }));
      const outcome = await runProbe();
      setEntryTests((cur) => ({ ...cur, [index]: outcome }));
    },
    [runProbe],
  );

  /** The footer 连通检测 (ticket 85). Same probe, provider-level scope:
   *  it records one verdict, and 保存 waits on it. */
  const testForm = useCallback(async () => {
    setFormTest({ status: "testing" });
    setFormTest(await runProbe());
  }, [runProbe]);

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
      // Localized accessible name for the header close button.
      // `rc-dialog` hardcodes `aria-label: "Close"` and spreads the
      // caller's picked aria attributes AFTER it
      // (node_modules/rc-dialog/es/Dialog/Content/Panel.js:109-113),
      // so the OBJECT form is the only way to override it — a boolean
      // `closable` leaves an English label on the Chinese interface.
      closable={{ "aria-label": t("common.close") }}
      title={
        <span
          data-testid="provider-dialog-title"
          className="text-base font-medium text-text_default_primary"
        >
          {t(
            editTarget ? "providers.dialog.editTitle" : "providers.dialog.title",
          )}
        </span>
      }
    >
      <AddModelDialogForm
        t={t}
        presets={presets}
        presetChoice={presetChoice}
        apiFormat={apiFormat}
        custom={custom}
        baseURL={baseURL}
        apiKey={apiKey}
        apiKeyPlaceholder={
          // The mask is a PLACEHOLDER, never a value: writing it back
          // would replace the stored key with its own abbreviation. An
          // empty controlled value is the keep-the-key sentinel, so an
          // untouched edit preserves the credential on disk.
          editTarget?.apiKeyMasked || t("providers.dialog.apiKeyPlaceholder")
        }
        revealed={revealed}
        headers={headers}
        entries={entries}
        errors={errors}
        busy={busy}
        entryTests={entryTests}
        canTest={canTest}
        formTest={formTest}
        skipTest={skipTest}
        onPresetChoice={(value) => {
          setPresetChoice(value);
          // Shared probe inputs changed — every outstanding result is
          // now an answer to a different question.
          setEntryTests({});
          setFormTest(null);
          // Seed 「API 格式」 and 「接口地址」 from the newly chosen
          // preset so both land on what that preset actually speaks and
          // dials; 「其他（自定义）」 has none to seed from and keeps the
          // previous values, which is what the operator last saw.
          if (value !== PRESET_CHOICE_CUSTOM) {
            const next = presets?.find((p) => p.id === value);
            if (next) {
              setApiFormat(next.protocol);
              setBaseURL(next.auth.baseURL ?? "");
            }
          }
        }}
        onApiFormat={(value) => {
          setApiFormat(value);
          // The format selects the probe endpoint shape — a verdict
          // from the previous one no longer answers this question.
          setEntryTests({});
          setFormTest(null);
        }}
        onBaseURL={(value) => {
          setBaseURL(value);
          // The endpoint IS the probe target; a verdict for the old
          // one says nothing about the new one.
          setEntryTests({});
          setFormTest(null);
        }}
        onCustomField={(patch) => {
          setCustom((c) => ({ ...c, ...patch }));
          // authType lands in the probe body — a stale verdict must
          // not survive it changing. (baseURL has its own handler now
          // that the field is top level.)
          if (patch.authType !== undefined) {
            setEntryTests({});
            setFormTest(null);
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
          setFormTest(null);
        }}
        onRevealToggle={() => setRevealed((r) => !r)}
        onHeaderChange={(index, patch) => {
          setHeaders((rows) =>
            rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
          );
          // Headers ride in the probe request, so editing one makes
          // every outstanding verdict an answer to a different
          // question. Dropping the verdict is what re-enables 保存
          // honestly rather than letting a stale pass through.
          setEntryTests({});
          setFormTest(null);
        }}
        onHeaderAdd={() => setHeaders((rows) => [...rows, { name: "", value: "" }])}
        onHeaderRemove={(index) => {
          setHeaders((rows) => rows.filter((_, i) => i !== index));
          setEntryTests({});
          setFormTest(null);
        }}
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
        onFormTest={() => void testForm()}
        onSkipTestToggle={setSkipTest}
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
      closable={{ "aria-label": t("common.close") }}
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
            className="h-9 min-w-20 rounded-lg bg-bg_interaction_primary_default px-5 text-sm font-weight_medium text-text_label_primary_default shadow-[var(--shadow_default)] transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50"
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
