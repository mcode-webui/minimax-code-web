"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Tag as AntTag,
  Popconfirm as AntPopconfirm,
} from "antd";

import * as api from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useSessionContext } from "@/lib/store";
import {
  draftFromView,
  draftToWire,
  type DraftProvider,
} from "@/lib/provider-management";
import { AddModelDialog } from "./add-model-dialog";
import { Icon } from "./icons";

/**
 * Provider management panel (ticket 03).
 *
 * Lives inside the settings modal as a fourth section ("Model
 * providers"), alongside general / appearance / connection. It renders
 * the v2 catalogue fetched from `/api/providers` and is now a LIST
 * ONLY: the flat right-hand editor this panel used to carry is gone,
 * and every add and edit goes through the desktop-parity dialog in
 * `components/add-model-dialog.tsx` (ticket 54/85/this slice). One
 * form, one entry contract — the panel keeps the catalogue, the
 * preset gallery, and the PUT path; the dialog keeps the fields.
 *
 * Why the list is all that remains: a provider row opens the dialog
 * with that provider projected onto the form (`editSeedFromDraft`),
 * and 保存 PUTs the same `draftToWire` body the editor used to build.
 * The wire contract is untouched; only the surface moved.
 *
 * Key handling (unchanged by this slice, restated because the dialog
 * now owns the field):
 *   - GET returns `apiKeyMasked` (e.g. "sk-a***b"). The dialog renders
 *     the mask as the key input's PLACEHOLDER, never as its value, so
 *     an untouched field carries an empty string on PUT — which
 *     `applyKeepKeyConvention` reads as "keep the existing key for
 *     this id". A typed value replaces it.
 *
 * Test connection: the dialog's per-model 检测 and footer 连通检测 both
 * call `POST /api/providers/test` with the LIVE form values, so a
 * provider is probed before it is saved and the panel needs no second
 * copy of the probe.
 *
 * Preset one-click enable (degrades gracefully): the catalogue fetch
 * 404s until the presets route is mounted, and the section hides
 * itself — the rest of the panel stays usable without it.
 */

/** Re-exported for tests. */
export type { DraftProvider };

export function ProviderManagementPanel({
  t,
}: {
  t: (key: MessageKey) => string;
}) {
  const { providersRevision } = useSessionContext();
  const [providers, setProviders] = useState<DraftProvider[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** The desktop-parity dialog. `null` editTarget = 「+ 新增」; a
   *  draft = that provider, pre-filled. Both entry points — the
   *  empty-state button, the rail's 「+ 添加模型」, the model-selector
   *  deep-link, and a click on an existing row — open THIS dialog. */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DraftProvider | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const snap = await api.listProviders();
      setProviders(snap.providers.map(draftFromView));
      setLoadError(null);
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

  /** Open the dialog in 「+ 新增」 mode. */
  const openAddDialog = useCallback(() => {
    setEditTarget(null);
    setDialogOpen(true);
  }, []);

  /** Open the dialog on an existing row. The row's own id is excluded
   *  from the dialog's duplicate check — a provider is not a duplicate
   *  of itself. */
  const openEditDialog = useCallback((draft: DraftProvider) => {
    setEditTarget(draft);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditTarget(null);
  }, []);

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

  const deleteSelected = useCallback(
    async (draftId: string) => {
      if (!providers) return;
      // The row is dropped from the wire list outright — the PUT
      // contract is a whole-list replace, so removing the entry here
      // is the delete. The next `load()` re-read drops the row too.
      await persist(providers.filter((p) => p.draftId !== draftId));
    },
    [providers, persist],
  );

  /** Dialog commit: append a NEW provider, or replace the one the
   *  dialog was opened on. Both go through the same `draftToWire` +
   *  PUT the editor used — the wire body is byte-identical to the
   *  pre-dialog panel, so the change is surface-only.
   *
   *  The replace case keys on `draftId`, not on `id`: the dialog lets
   *  a custom provider's id be retyped, and matching on the wire id
   *  would then append a second provider instead of renaming the
   *  first. */
  const saveFromDialog = useCallback(
    async (draft: DraftProvider): Promise<boolean> => {
      if (!providers) return false;
      const next =
        editTarget === null
          ? [...providers, draft]
          : providers.map((p) =>
              p.draftId === editTarget.draftId ? draft : p,
            );
      return persist(next);
    },
    [providers, editTarget, persist],
  );

  /** ids the dialog must not collide with — every configured provider
   *  EXCEPT the one being edited. */
  const dialogExistingIds = useMemo(
    () =>
      (providers ?? [])
        .filter((p) => !p.markedForDeletion && p.draftId !== editTarget?.draftId)
        .map((p) => p.id),
    [providers, editTarget],
  );

  if (loadError && !providers) {
    return (
      <p className="text-caption-small-strong text-text_status_error">{loadError}</p>
    );
  }

  if (!providers) {
    return <p className="text-text_default_tertiary">{t("app.connecting")}</p>;
  }

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
          tab's whitespace. The testids stay on the same affordances
          (providers-empty text, provider-add-button). */}
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
            onClick={openAddDialog}
            className="h-8 rounded-lg bg-bg_interaction_tertiary_hover px-4 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_selected"
          >
            + {t("providers.add")}
          </button>
        </div>
        <ProviderPresetSection t={t} onAfterEnable={() => void load()} />
        </>
      ) : (
      <div className="flex flex-col gap-2">
        {/* The provider list. There is no second editing surface: a row
            opens the dialog pre-filled on that provider, and the
            dialog's 保存 PUTs the edited draft back. The row is a
            `<div>` wrapper, not a `<button>`, because it carries a
            SECOND control (删除) and a button inside a button is
            invalid HTML with ambiguous keyboard semantics. */}
        <div className="flex flex-col gap-1 rounded-[10px] bg-bg_grouped_tertiary p-1">
          {providers.map((p) => (
            <div
              key={p.draftId}
              data-testid={`provider-row-${p.draftId}`}
              className={[
                "flex items-center gap-1 rounded-[8px] pr-1 transition-colors",
                "hover:bg-bg_interaction_tertiary_hover",
                p.markedForDeletion ? "opacity-50 line-through" : "",
              ].join(" ")}
            >
              <button
                type="button"
                data-testid={`provider-row-edit-${p.draftId}`}
                onClick={() => openEditDialog(p)}
                className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-[8px] px-2 py-1.5 text-left"
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
                    configured models so the operator sees what is wired
                    up without opening the dialog. The list is read
                    directly off the server-side `ProviderView.models[]`
                    — it is the same shape the dialog surfaces, so what
                    the user sees here matches the model picker. */}
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
              </button>
              {/* 删除 — the retired editor's footer button, moved onto
                  the row. Preset rows keep no delete: the preset
                  controls own their lifecycle, and the retired editor
                  hid the control for exactly that reason. */}
              {p.preset ? null : (
                <AntPopconfirm
                  title={t("providers.deleteConfirm").replace(
                    "{{id}}",
                    p.id || "(new)",
                  )}
                  description={t("providers.deleteHint")}
                  okText={t("providers.delete")}
                  cancelText={t("panel.close")}
                  onConfirm={() => void deleteSelected(p.draftId)}
                >
                  <button
                    type="button"
                    data-testid={`provider-delete-${p.draftId}`}
                    disabled={busy}
                    aria-label={t("providers.deleteConfirm").replace(
                      "{{id}}",
                      p.id || "(new)",
                    )}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_status_error disabled:opacity-50"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </AntPopconfirm>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          data-testid="provider-add-button"
          onClick={openAddDialog}
          className="h-8 self-start rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          + {t("providers.add")}
        </button>
        {/* Save feedback lives here: the dialog closes only on a
            successful PUT, so a failed save is reported on the list
            the operator lands back on rather than inside a modal that
            is still open. */}
        <div className="flex items-center gap-2">
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
      )}

      {/* The desktop-parity dialog. Opened by the empty-state / rail
       *  button, the model-selector deep-link, and any existing row;
       *  saving PUTs through `saveFromDialog` and closes only on
       *  success. */}
      <AddModelDialog
        t={t}
        open={dialogOpen}
        existingIds={dialogExistingIds}
        editTarget={editTarget}
        onCancel={closeDialog}
        onSave={saveFromDialog}
      />
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