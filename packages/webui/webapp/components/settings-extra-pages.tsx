"use client";

// components/settings-extra-pages.tsx
//
// The settings modal's four pure-frontend sub-pages (webui-parity 55a):
// 快捷键 (Shortcuts), 语音 (Voice), 个性化 (Personalization) and 代码审查
// (Code review). "Pure" means no `/api` dependency — the pages render from
// literals plus (for the three long-text blocks) `localStorage` through
// `lib/settings-local.ts`, so unlike the server-backed sections they are
// reachable even before a settings snapshot loads.
//
// Split out of panels.tsx for the same reason `usage-models-cards.tsx`
// was (ticket 53): panels.tsx pulls the session store and the api graph
// and is unimportable in a test process, while these bodies take nothing
// but a `t` function and their own browser-local state — so
// `test/settings-extra-pages.test.ts` renders them through
// react-dom/server and pins the rendered markup.
//
// Data policy (ticket 55a, decision A1): the desktop forms are reproduced
// structure-for-structure, and every control with no browser-side
// capability behind it renders disabled with the standing honesty markers
// rather than fabricating behaviour:
//
//   - Shortcuts: a browser page cannot register global shortcuts. The
//     rows render the desktop's default bindings verbatim, the ✕ / ↺
//     affordances render but are disabled, and the page opens with the
//     「浏览器环境不适用」notice explaining what the user is looking at.
//   - Voice: no microphone enumeration and no dictation input. The mic
//     dropdown shows the standing 「本地版不适用」 placeholder as its only
//     option; the two dictation rows show 「未设置」 like the desktop's
//     unset state.
//   - Personalization: 自定义指令 / 关于你 persist to `localStorage` and
//     survive refresh. They are NOT read by anything: SB-8 (D-2) closed
//     with a grep that found no engine channel able to consume them
//     (`setConfigOption` does not exist in the runtime source at all), so
//     each field carries the standing note 「已保存于本浏览器，不会注入引擎会话」
//     rather than letting a saved instruction read as one that takes
//     effect. The memory card has no local memory system behind it: both
//     switches render off and greyed (the desktop's 记忆 row shows a live
//     blue ON — a capability claim this client cannot make), and the 管理
//     button opens the desktop's 记忆摘要 dialog in its permanent empty
//     state.
//   - Code review: 审查方式 renders 子会话 (the one locally meaningful
//     value — the engine runs reviews in a sub-session) as a disabled
//     dropdown; 自定义审查准则 persists like the two Personalization
//     texts, and carries the same non-injection note for the same reason.
//
// This module imports React explicitly: the render test loads it under
// the tsx loader with `jsx: "preserve"`, which falls back to the classic
// runtime (same reason usage-models-cards.tsx does).

// NOTE on import style: the two lib imports below are RELATIVE, not the
// `@/` alias panels.tsx uses. The test loader (tsx) resolved the alias
// for this module only intermittently — the same imports resolved in a
// truncated copy of the file and failed in the full one — while relative
// specifiers resolve unconditionally in both the Next build and the
// test process. Same call as usage-models-cards.tsx importing React
// explicitly: pick the form the harness can actually load.
import * as React from "react";
import { useEffect, useState } from "react";
import { Select as AntSelect, Switch } from "antd";

import type { MessageKey } from "../lib/i18n";
import {
  commitAboutUser,
  commitCodeReviewGuidelines,
  commitCustomInstructions,
  readAboutUser,
  readCodeReviewGuidelines,
  readCustomInstructions,
} from "../lib/settings-local";
import {
  applyBinding,
  chordFromStroke,
  clearBinding,
  formatChord,
  readCustomBindings,
  resolveBindings,
  shortcutSpec,
  writeCustomBindings,
  type BlockedReason,
  type ShortcutId,
  type ShortcutStatus,
} from "../lib/shortcuts";
import { Icon } from "./icons";

// --- structural copies of the panels.tsx primitives -------------------------
//
// The General page's titled-card row primitives (SettingsSection /
// SettingRow / RowDivider in panels.tsx) are reproduced here rather than
// imported: importing panels.tsx would drag its store/api graph into this
// module and break the render-test isolation. Keep the class lists in
// sync with panels.tsx when either side changes (same discipline as
// usage-models-cards.tsx's inlined divider).

/** `<h3>` above a 16px-radius card — panels.tsx's SettingsSection shape. */
function GroupCard({
  title,
  info,
  testId,
  children,
}: {
  title: string;
  /** The reference's ⓘ glyph next to section titles that carry one. */
  info?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-1.5 px-4">
        <h3 className="m-0 text-sm font-medium leading-5 text-text_default_primary">
          {title}
        </h3>
        {info ? <Icon name="info" size={14} className="text-text_default_tertiary" aria-label="" /> : null}
      </div>
      <div className="flex w-full flex-col rounded-[16px] bg-bg_grouped_tertiary p-1">
        {children}
      </div>
    </section>
  );
}

/** One horizontal settings row — panels.tsx's SettingRow shape. */
function Row({
  title,
  hint,
  caption,
  testId,
  children,
}: {
  title: string;
  hint?: string;
  /** A tertiary third line (the standing 本地版不适用 marker). */
  caption?: string;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-[56px] w-full items-center justify-between gap-6 overflow-hidden rounded-[12px] py-2 pl-3 pr-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-normal leading-5 text-text_default_primary">
          {title}
        </span>
        {hint ? (
          <span className="text-xs leading-4 text-text_default_secondary">{hint}</span>
        ) : null}
        {caption ? (
          <span className="text-caption-small-strong text-text_default_tertiary">{caption}</span>
        ) : null}
      </div>
      <div className="flex flex-shrink-0 items-center">{children}</div>
    </div>
  );
}

/** The hairline between adjacent rows — panels.tsx's RowDivider shape. */
function HairDivider() {
  return (
    <div className="flex items-center justify-center px-3 py-1.5" aria-hidden>
      <span className="block h-px w-full bg-border_light" />
    </div>
  );
}

// --- shared controls ---------------------------------------------------------

/** The 保存 action shared by every persisted long-text block. The desktop's
 * grey-on-white medium button maps to this client's primary token (the same
 * mapping the plan card's 升级 uses); it stays disabled until the draft
 * diverges from the persisted value, so an unchanged (or empty) block can
 * never fire a no-op write. */
function SaveButton({
  disabled,
  onClick,
  testId,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  testId: string;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="h-8 flex-shrink-0 rounded-[8px] bg-bg_interaction_primary_default px-3 text-caption-small-strong text-icon_interaction_primary_default transition-colors hover:bg-bg_interaction_primary_hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg_interaction_primary_default"
    >
      {label}
    </button>
  );
}

/**
 * One persisted long-text block: a textarea whose value round-trips through
 * `localStorage`, with its own 保存 action.
 *
 * The block tracks two strings — `draft` (the textarea) and `saved` (what
 * storage holds) — and derives dirty from their inequality. The save click
 * routes through the exported `commit*` helper so the persist happens
 * before the state forward (the ordering the settings-local tests pin).
 *
 * `layout` picks where 保存 sits, following the two reference forms:
 * `titleRow` is the Personalization page (`ref-10`) — a titled row with
 * the ⓘ glyph and the save action at its right, the field below; and
 * `labelAbove` is the code-review card's interior (`ref-22`) — a bare bold
 * label, the field, and the save action under its bottom-right corner.
 * `tone` picks the field surface: `quiet` is the borderless grey field on
 * the page background, `boxed` the white bordered field inside the card.
 */
function PersistedTextBlock({
  title,
  placeholder,
  tone,
  layout,
  testId,
  read,
  commit,
  note: noteText,
  t,
}: {
  title: string;
  placeholder: string;
  tone: "quiet" | "boxed";
  layout: "titleRow" | "labelAbove";
  testId: string;
  read: () => string;
  commit: (setState: (value: string) => void, value: string) => void;
  /** Optional standing caption under the field (SB-8 / D-2). */
  note?: string;
  t: (key: MessageKey) => string;
}) {
  const [draft, setDraft] = useState(read);
  const [saved, setSaved] = useState(read);
  const dirty = draft !== saved;

  const textarea = (
    <textarea
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      aria-label={title}
      data-testid={`${testId}-textarea`}
      className={
        tone === "quiet"
          ? "min-h-[110px] w-full resize-none rounded-[12px] border-0 bg-bg_grouped_tertiary px-3 py-2.5 text-sm leading-5 text-text_default_primary outline-none placeholder:text-text_default_tertiary"
          : "min-h-[150px] w-full resize-y rounded-[8px] border border-border_default bg-bg_default_primary px-3 py-2 text-sm leading-5 text-text_default_primary outline-none placeholder:text-text_default_tertiary"
      }
    />
  );
  const save = (
    <SaveButton
      disabled={!dirty}
      onClick={() => commit(setSaved, draft)}
      testId={`${testId}-save`}
      label={t("common.save")}
    />
  );

  // SB-8 (D-2): the standing honesty line under a stored-but-unread text.
  // The engine has no channel that would consume these values, so the field
  // says so next to the input rather than letting a saved instruction read
  // as an instruction that takes effect.
  const note = noteText ? (
    <p
      data-testid={`${testId}-note`}
      className="m-0 text-caption-small-strong text-text_default_tertiary"
    >
      {noteText}
    </p>
  ) : null;

  if (layout === "labelAbove") {
    return (
      <div data-testid={testId} className="flex w-full flex-col gap-2.5">
        <span className="text-sm font-medium leading-5 text-text_default_primary">{title}</span>
        {textarea}
        {note}
        <div className="flex justify-end">{save}</div>
      </div>
    );
  }
  return (
    <section data-testid={testId} className="flex w-full flex-col gap-3">
      <div className="flex items-center justify-between px-4">
        <div className="flex items-center gap-1.5">
          <h3 className="m-0 text-sm font-medium leading-5 text-text_default_primary">
            {title}
          </h3>
          <Icon name="info" size={14} className="text-text_default_tertiary" aria-label="" />
        </div>
        {save}
      </div>
      {textarea}
      {note}
    </section>
  );
}

// --- 快捷键 (Shortcuts) -------------------------------------------------------
//
// The Shortcuts page is the one settings page whose honesty problem was
// not "no capability" but "a capability hidden behind a false notice":
// `app/page.tsx` dispatched Ctrl+N and Ctrl+, while this page printed all
// ten desktop rows disabled behind 「浏览器环境不适用」. Both halves now
// read `lib/shortcuts.ts` — the registry that says which combinations a
// browser hands to a page at all, and what each dispatched row is bound
// to — so a row cannot be shown dead while the handler fires it.
//
// Three states render differently:
//
//   - `live`    the handler dispatches it on every platform, and the box
//               records a new combination. ✕ drops the customisation and
//               restores the desktop default.
//   - `partial` the handler dispatches it where the browser leaves the
//               combination free (Ctrl+N is a new window in Chromium and
//               Firefox on Windows and Linux, so only macOS delivers it).
//               Live, therefore shown as such, but not editable: a
//               rebinding would not make it work everywhere.
//   - `blocked` no honest binding exists, and the row says WHICH of the
//               three reasons applies — a combination the browser owns
//               (Ctrl+T-style interception is impossible from a page), a
//               surface the WebUI does not have, dictation with no speech
//               recognition behind it, or an action whose semantics are
//               still undecided. The row keeps the desktop's printed
//               combination for reference; the box stays disabled.
//
// Overrides persist under `webui-shortcut-bindings` (see the lib) and a
// combination already dispatched by another row is refused with the
// conflicting action named, rather than stored into an order-dependent
// tie.

/** The Shortcuts page's group layout. Group membership is the desktop's
 *  (ref-09): Mini Chat on its own, everything else under 常用. Which rows
 *  exist, what they are bound to and whether they are live comes from
 *  `SHORTCUT_SPECS` — this table only says which card a row sits in. */
const SHORTCUT_GROUPS: {
  titleKey: MessageKey;
  testId: string;
  ids: readonly ShortcutId[];
}[] = [
  {
    titleKey: "settings.shortcuts.group.miniChat",
    testId: "settings-shortcuts-group-minichat",
    ids: ["mini-chat"],
  },
  {
    titleKey: "settings.shortcuts.group.common",
    testId: "settings-shortcuts-group-common",
    ids: [
      "global-search",
      "search-tasks",
      "new-task",
      "new-task-no-project",
      "open-folder",
      "open-settings",
      "hold-dictation",
      "toggle-dictation",
      "invert-follow-up",
    ],
  },
];

/** The row id → i18n key suffix mapping, derived rather than hand-listed:
 *  the Shortcuts page's item keys are `settings.shortcuts.item.` plus the
 *  id in camelCase (`new-task-no-project` → `newTaskNoProject`). A hand
 *  table would drift from the registry the moment a row is added. */
function itemKey(id: ShortcutId): MessageKey {
  const camel = id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return `settings.shortcuts.item.${camel}` as MessageKey;
}

/** The i18n key for a blocked row's reason. */
const REASON_KEYS: Readonly<Record<BlockedReason, MessageKey>> = {
  browserReserved: "settings.shortcuts.reason.browserReserved",
  noSurface: "settings.shortcuts.reason.noSurface",
  noDictation: "settings.shortcuts.reason.noDictation",
  pending: "settings.shortcuts.reason.pending",
};

/** The i18n key for a dispatched row's status badge. */
const STATUS_KEYS: Readonly<Record<"live" | "partial", MessageKey>> = {
  live: "settings.shortcuts.status.live",
  partial: "settings.shortcuts.status.partial",
};

/** The binding cell. Two forms, one component: the desktop's keycapture
 *  input.
 *
 *  - `status` set (the Shortcuts page): a `live` box records the next
 *    combination the user presses and reports it upward; a `partial` box
 *    shows the same text but takes no input, because rebinding it would
 *    not make it fire on the platforms where the browser owns the
 *    combination; a `blocked` box is the disabled reference form the
 *    desktop shows, and the reason is rendered by the caller as the
 *    row's caption.
 *  - `status` omitted (the Voice page's dictation rows): the old
 *    readOnly+disabled unset placeholder, unchanged.
 */
function BindingBox({
  binding,
  unsetLabel,
  testId,
  t,
  status,
  customized,
  disabled = false,
  onCapture,
  onClear,
  onCancel,
}: {
  binding: string | null;
  unsetLabel: string;
  testId: string;
  t: (key: MessageKey) => string;
  status?: ShortcutStatus;
  /** The effective combination differs from the desktop default. */
  customized?: boolean;
  disabled?: boolean;
  onCapture?: (chord: string) => void;
  onClear?: () => void;
  onCancel?: () => void;
}) {
  const unset = binding === null;
  // Only a `live` row is editable. A row with no `status` (the Voice
  // page's dictation rows) is the desktop's dead reference form.
  const editable = status === "live" && onCapture !== undefined;
  const isDisabled = disabled || status !== "live";
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editable) return;
    // Escape abandons a capture in progress without touching storage.
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      onCancel?.();
      return;
    }
    const chord = chordFromStroke(event);
    if (!chord) return;
    // preventDefault first: a captured combination must not also run its
    // own action (recording Ctrl+, must not open the settings page).
    event.preventDefault();
    onCapture(formatChord(chord));
  };
  return (
    <div className="relative flex-shrink-0">
      <input
        disabled={isDisabled}
        readOnly
        onKeyDown={onKeyDown}
        value={unset ? "" : binding}
        placeholder={unset ? unsetLabel : undefined}
        data-testid={testId}
        data-status={status ?? "reference"}
        data-customized={customized ? "true" : undefined}
        aria-label={
          unset ? unsetLabel : editable ? `${binding as string} — ${t("settings.shortcuts.record")}` : (binding as string)
        }
        className={`h-8 w-[150px] rounded-[8px] border bg-bg_default_primary pl-2.5 pr-7 text-sm text-text_default_primary placeholder:text-text_default_tertiary ${
          editable
            ? "cursor-pointer border-border_strong focus:border-brand_default"
            : "border-border_default disabled:cursor-not-allowed"
        }`}
      />
      {unset ? null : (
        <button
          type="button"
          disabled={!editable}
          onClick={onClear}
          aria-label={t("settings.shortcuts.clear")}
          data-testid={`${testId}-clear`}
          className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-text_default_tertiary disabled:cursor-not-allowed"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

export function ShortcutsSection({ t }: { t: (key: MessageKey) => string }) {
  // Hydrated synchronously so the first paint — including a server render
  // in a test — shows the stored combination, same pattern as the
  // long-text blocks' `useState(() => read…)`.
  const [custom, setCustom] = useState<Record<string, string>>(() => readCustomBindings());
  // The row awaiting a verdict on its last capture, and the row it
  // collided with. Null whenever the last capture was accepted.
  const [conflict, setConflict] = useState<{ id: ShortcutId; with: ShortcutId } | null>(null);
  const bindings = resolveBindings(custom);

  // Accept/refuse lives in lib/shortcuts.ts (applyBinding); the component
  // only persists and forwards, so the decision is drivable without a DOM.
  const commit = (id: ShortcutId, chord: string) => {
    const attempt = applyBinding(custom, id, chord);
    if (!attempt.ok) {
      setConflict({ id, with: attempt.with });
      return;
    }
    setConflict(null);
    // Persist BEFORE the state forward, the same ordering
    // lib/settings-local.ts's commit helpers use: a storage failure must
    // not leave the page showing a binding nothing recorded.
    writeCustomBindings(attempt.custom);
    setCustom(attempt.custom);
  };

  const restore = (id: ShortcutId) => {
    setConflict(null);
    writeCustomBindings(clearBinding(custom, id));
    setCustom(clearBinding(custom, id));
  };

  return (
    <div data-testid="settings-shortcuts-page" className="flex w-full flex-col gap-8">
      {/* The notice states what each badge means, including the honest
       * limit: a page cannot intercept a combination the browser owns
       * (Ctrl+T, Ctrl+W, Ctrl+O, the find keys), so those rows keep their
       * printed value as reference and stay disabled. */}
      <div
        data-testid="settings-shortcuts-notice"
        className="flex items-start gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-2 text-caption-small-strong leading-4 text-text_default_secondary"
      >
        <Icon name="info" size={14} className="mt-0.5 flex-none text-text_default_tertiary" aria-label="" />
        <span className="min-w-0 flex-1">{t("settings.shortcuts.notice")}</span>
      </div>
      {SHORTCUT_GROUPS.map((group) => (
        <GroupCard key={group.testId} title={t(group.titleKey)} testId={group.testId}>
          {group.ids.map((id, index) => {
            const spec = shortcutSpec(id);
            const binding = bindings[id];
            const customized = custom[id] !== undefined;
            const blocked = spec.status === "blocked";
            const conflictLine =
              conflict && conflict.id === id
                ? `${t("settings.shortcuts.conflict")} ${t(itemKey(conflict.with))}`
                : null;
            return (
              <React.Fragment key={id}>
                {index > 0 ? <HairDivider /> : null}
                <Row
                  title={t(itemKey(id))}
                  hint={t(`${itemKey(id)}Hint` as MessageKey)}
                  caption={
                    blocked && spec.reason
                      ? t(REASON_KEYS[spec.reason])
                      : spec.status === "partial"
                        ? t("settings.shortcuts.partialNote")
                        : undefined
                  }
                  testId={`settings-shortcuts-row-${id}`}
                >
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      {spec.reset ? (
                        /* The reference's external ↺ affordance on the Mini
                         * Chat row. That row is blocked, so the control
                         * stays dead — the shape is kept for parity. */
                        <button
                          type="button"
                          disabled
                          aria-label={t("settings.shortcuts.reset")}
                          data-testid={`settings-shortcuts-reset-${id}`}
                          className="flex size-6 items-center justify-center rounded text-text_default_tertiary disabled:cursor-not-allowed"
                        >
                          <Icon name="refresh" size={14} />
                        </button>
                      ) : null}
                      <BindingBox
                        binding={binding}
                        unsetLabel={t("settings.shortcuts.unset")}
                        testId={`settings-shortcuts-binding-${id}`}
                        t={t}
                        status={spec.status}
                        customized={customized}
                        disabled={blocked}
                        onCapture={(chord) => commit(id, chord)}
                        onClear={() => restore(id)}
                        onCancel={() => setConflict(null)}
                      />
                      {blocked ? null : (
                        <span
                          data-testid={`settings-shortcuts-status-${id}`}
                          className="text-caption-small-strong text-text_default_tertiary"
                        >
                          {customized ? t("settings.shortcuts.status.customized") : t(STATUS_KEYS[spec.status as "live" | "partial"])}
                        </span>
                      )}
                    </div>
                    {conflictLine ? (
                      <span
                        data-testid={`settings-shortcuts-conflict-${id}`}
                        className="text-caption-small-strong text-text_error_primary"
                      >
                        {conflictLine}
                      </span>
                    ) : null}
                  </div>
                </Row>
              </React.Fragment>
            );
          })}
        </GroupCard>
      ))}
    </div>
  );
}

// --- 语音 (Voice) -------------------------------------------------------------

export function VoiceSection({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div data-testid="settings-voice-page" className="flex w-full flex-col gap-8">
      <GroupCard
        title={t("settings.voice.group.regular")}
        testId="settings-voice-group-regular"
      >
        <Row
          title={t("settings.voice.microphone")}
          hint={t("settings.voice.microphoneHint")}
          testId="settings-voice-microphone-row"
        >
          {/* The reference's device dropdown; the browser edition has no
           * device enumeration, so the only — disabled — option is the
           * standing placeholder rather than a fabricated device list.
           * No `mavis-input` here: that class paints its own border+bg
           * box, which stacks a second frame around antd's selector. */}
          <AntSelect
            disabled
            value="not-applicable"
            data-testid="settings-voice-mic-select"
            aria-label={t("settings.voice.microphone")}
            className="w-[220px]"
            options={[{ label: t("usage.notLocal"), value: "not-applicable" }]}
          />
        </Row>
      </GroupCard>
      <GroupCard
        title={t("settings.voice.group.dictation")}
        testId="settings-voice-group-dictation"
      >
        {/* The two dictation shortcut rows render the desktop's unset
         * state (未设置) in the same keycapture form as the Shortcuts
         * page — there is no dictation input to bind in a browser. */}
        <Row
          title={t("settings.voice.holdKey")}
          hint={t("settings.voice.holdKeyHint")}
          testId="settings-voice-hold-row"
        >
          <BindingBox
            binding={null}
            unsetLabel={t("settings.voice.unset")}
            testId="settings-voice-hold-binding"
            t={t}
          />
        </Row>
        <HairDivider />
        <Row
          title={t("settings.voice.toggleKey")}
          hint={t("settings.voice.toggleKeyHint")}
          testId="settings-voice-toggle-row"
        >
          <BindingBox
            binding={null}
            unsetLabel={t("settings.voice.unset")}
            testId="settings-voice-toggle-binding"
            t={t}
          />
        </Row>
      </GroupCard>
    </div>
  );
}

// --- 个性化 (Personalization) --------------------------------------------------

export function PersonalizationSection({ t }: { t: (key: MessageKey) => string }) {
  const [memoryOpen, setMemoryOpen] = useState(false);

  return (
    <div data-testid="settings-personalization-page" className="flex w-full flex-col gap-8">
      <PersistedTextBlock
        title={t("settings.personal.instructions")}
        placeholder={t("settings.personal.instructionsPlaceholder")}
        tone="quiet"
        layout="titleRow"
        testId="settings-personalization-instructions"
        read={readCustomInstructions}
        commit={commitCustomInstructions}
        note={t("settings.storedOnly")}
        t={t}
      />
      <PersistedTextBlock
        title={t("settings.personal.aboutYou")}
        placeholder={t("settings.personal.aboutYouPlaceholder")}
        tone="quiet"
        layout="titleRow"
        testId="settings-personalization-about"
        read={readAboutUser}
        commit={commitAboutUser}
        note={t("settings.storedOnly")}
        t={t}
      />
      <GroupCard
        title={t("settings.personal.memory")}
        info
        testId="settings-personalization-memory"
      >
        {/* No local memory system: both switches render OFF and greyed.
         * The desktop's 记忆 row shows its live blue ON state — that is a
         * capability claim this client cannot make (nothing would store
         * memories), so the honest form is the dead off-state, dimmed
         * with an opacity coat, each row carrying the standing marker
         * (the credits-card precedent for placeholder switches). */}
        <Row
          title={t("settings.personal.memory")}
          hint={t("settings.personal.memoryHint")}
          caption={t("usage.notLocal")}
          testId="settings-memory-switch-row"
        >
          <Switch
            checked={false}
            disabled
            className="opacity-40"
            aria-label={t("settings.personal.memory")}
          />
        </Row>
        <HairDivider />
        <Row
          title={t("settings.personal.proactiveMemory")}
          hint={t("settings.personal.proactiveMemoryHint")}
          caption={t("usage.notLocal")}
          testId="settings-proactive-memory-switch-row"
        >
          <Switch
            checked={false}
            disabled
            className="opacity-40"
            aria-label={t("settings.personal.proactiveMemory")}
          />
        </Row>
        <HairDivider />
        <Row
          title={t("settings.personal.memorySummary")}
          hint={t("settings.personal.memorySummaryHint")}
          testId="settings-memory-summary-row"
        >
          <button
            type="button"
            onClick={() => setMemoryOpen(true)}
            data-testid="settings-memory-summary-manage"
            className="h-7 rounded-[8px] border border-border_default px-2.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {t("settings.personal.manage")}
          </button>
        </Row>
      </GroupCard>
      {memoryOpen ? (
        <MemorySummaryModal t={t} onClose={() => setMemoryOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * The 记忆摘要 dialog (`ref-11`) in its permanent empty state: the local
 * edition has no memory store, so the summary is always the empty string —
 * the textarea is disabled, the character count is its honest length (0),
 * the 尚未生成 empty-state line sits bottom-left, and 保存 stays disabled
 * because there is nothing to write. 取消 and the ✕ close.
 *
 * Rendered as a plain fixed overlay (not antd's Modal) so it layers above
 * the settings modal's z-1000 surface and stays renderable in the
 * server-markup test. Esc closes this dialog without bubbling up to the
 * settings modal's own Esc handler — the capture-phase listener consumes
 * the event first.
 */
export function MemorySummaryModal({
  t,
  onClose,
}: {
  t: (key: MessageKey) => string;
  onClose: () => void;
}) {
  // The empty summary is the data policy, not an initialization: there is
  // no local memory source, so the length this renders is always 0.
  const summary = "";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1010] flex items-center justify-center" data-testid="settings-memory-summary-modal">
      <div className="absolute inset-0 bg-utility_blanket" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.memory.title")}
        className="relative flex w-[560px] max-w-[90vw] flex-col rounded-[16px] bg-bg_default_primary p-5 shadow-shadow_default"
      >
        <div className="flex items-center justify-between">
          <span className="text-base font-medium leading-6 text-text_default_primary">
            {t("settings.memory.title")}
          </span>
          <div className="flex items-center gap-1">
            {/* The reference's ··· affordance — no action exists locally. */}
            <button
              type="button"
              disabled
              aria-label={t("settings.memory.more")}
              data-testid="settings-memory-summary-more"
              className="flex size-6 items-center justify-center rounded text-text_default_tertiary disabled:cursor-not-allowed"
            >
              <Icon name="more" size={14} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("settings.memory.close")}
              data-testid="settings-memory-summary-close"
              className="flex size-6 items-center justify-center rounded text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
        <textarea
          disabled
          value={summary}
          placeholder={t("settings.memory.placeholder")}
          aria-label={t("settings.memory.title")}
          data-testid="settings-memory-summary-textarea"
          className="mt-4 min-h-[240px] w-full resize-none rounded-[8px] border border-border_default bg-bg_default_primary px-3 py-2 text-sm leading-5 text-text_default_primary outline-none placeholder:text-text_default_tertiary disabled:cursor-not-allowed"
        />
        <div className="mt-1 flex justify-end" aria-hidden>
          <span
            data-testid="settings-memory-summary-count"
            className="text-caption-small-strong text-text_default_tertiary"
          >
            {summary.length}
          </span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="text-caption-small-strong text-text_default_tertiary">
            {t("settings.memory.empty")}
          </span>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              data-testid="settings-memory-summary-cancel"
              className="h-8 rounded-[8px] border border-border_default px-3 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled
              data-testid="settings-memory-summary-save"
              className="h-8 cursor-not-allowed rounded-[8px] bg-bg_interaction_primary_default px-3 text-caption-small-strong text-icon_interaction_primary_default opacity-40"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- 代码审查 (Code review) ----------------------------------------------------

export function CodeReviewSection({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div data-testid="settings-code-review-page" className="flex w-full flex-col gap-8">
      {/* The reference's single card (`ref-22`): a headed card (title +
       * description), the 审查方式 row, a hairline, then the guideline
       * block with its own save action in the card's bottom-right. */}
      <div
        data-testid="settings-code-review-card"
        className="flex w-full flex-col rounded-[16px] bg-bg_grouped_tertiary p-1"
      >
        <div className="flex flex-col gap-0.5 px-3 pt-2.5 pb-1">
          <span className="desktop-text-ui-body text-text_default_primary">
            {t("settings.tab.codeReview")}
          </span>
          <span className="text-caption-small-strong text-text_default_secondary">
            {t("settings.codeReview.hint")}
          </span>
        </div>
        <Row title={t("settings.codeReview.method")} testId="settings-code-review-method-row">
          {/* 子会话 is both the reference's shown value and the one
           * locally meaningful execution mode (the engine runs reviews
           * in a sub-session). No other mode exists locally, so the
           * dropdown renders disabled rather than offering a dead
           * choice. */}
          <AntSelect
            disabled
            value="subsession"
            data-testid="settings-code-review-method-select"
            aria-label={t("settings.codeReview.method")}
            className="w-[178px]"
            options={[{ label: t("settings.codeReview.methodSubsession"), value: "subsession" }]}
          />
        </Row>
        <HairDivider />
        <div className="px-3 pt-2.5 pb-3">
          <PersistedTextBlock
            title={t("settings.codeReview.guidelines")}
            placeholder={t("settings.codeReview.guidelinesPlaceholder")}
            tone="boxed"
            layout="labelAbove"
            testId="settings-code-review-guidelines"
            read={readCodeReviewGuidelines}
            commit={commitCodeReviewGuidelines}
            note={t("settings.storedOnly")}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}
