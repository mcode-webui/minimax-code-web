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
//   - Personalization: 自定义指令 / 关于你 are REAL — both persist to
//     `localStorage` and survive refresh. The memory card has no local
//     memory system behind it: both switches render off and greyed (the
//     desktop's 记忆 row shows a live blue ON — a capability claim this
//     client cannot make), and the 管理 button opens the desktop's
//     记忆摘要 dialog in its permanent empty state.
//   - Code review: 审查方式 renders 子会话 (the one locally meaningful
//     value — the engine runs reviews in a sub-session) as a disabled
//     dropdown; 自定义审查准则 is REAL and persists like the two
//     Personalization texts.
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
  t,
}: {
  title: string;
  placeholder: string;
  tone: "quiet" | "boxed";
  layout: "titleRow" | "labelAbove";
  testId: string;
  read: () => string;
  commit: (setState: (value: string) => void, value: string) => void;
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

  if (layout === "labelAbove") {
    return (
      <div data-testid={testId} className="flex w-full flex-col gap-2.5">
        <span className="text-sm font-medium leading-5 text-text_default_primary">{title}</span>
        {textarea}
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
    </section>
  );
}

// --- 快捷键 (Shortcuts) -------------------------------------------------------

/** One shortcut row's static description. `binding` is the desktop default
 * verbatim (key combos are locale-independent, hence not in i18n); `null`
 * is the desktop's unset state (未设置), which renders no ✕ — matching
 * `ref-09`. `reset` marks the one row the reference gives an external ↺
 * affordance (Mini Chat). */
interface ShortcutRowDef {
  id: string;
  titleKey: MessageKey;
  hintKey: MessageKey;
  binding: string | null;
  reset?: boolean;
}

const SHORTCUT_GROUPS: { titleKey: MessageKey; testId: string; rows: ShortcutRowDef[] }[] = [
  {
    titleKey: "settings.shortcuts.group.miniChat",
    testId: "settings-shortcuts-group-minichat",
    rows: [
      {
        id: "mini-chat",
        titleKey: "settings.shortcuts.item.miniChat",
        hintKey: "settings.shortcuts.item.miniChatHint",
        binding: "Alt+M",
        reset: true,
      },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.common",
    testId: "settings-shortcuts-group-common",
    rows: [
      {
        id: "global-search",
        titleKey: "settings.shortcuts.item.globalSearch",
        hintKey: "settings.shortcuts.item.globalSearchHint",
        binding: "Ctrl+K",
      },
      {
        id: "search-tasks",
        titleKey: "settings.shortcuts.item.searchTasks",
        hintKey: "settings.shortcuts.item.searchTasksHint",
        binding: "Ctrl+G",
      },
      {
        id: "new-task",
        titleKey: "settings.shortcuts.item.newTask",
        hintKey: "settings.shortcuts.item.newTaskHint",
        binding: "Ctrl+N",
      },
      {
        id: "new-task-no-project",
        titleKey: "settings.shortcuts.item.newTaskNoProject",
        hintKey: "settings.shortcuts.item.newTaskNoProjectHint",
        binding: "Ctrl+Alt+O",
      },
      {
        id: "open-folder",
        titleKey: "settings.shortcuts.item.openFolder",
        hintKey: "settings.shortcuts.item.openFolderHint",
        binding: "Ctrl+O",
      },
      {
        id: "open-settings",
        titleKey: "settings.shortcuts.item.openSettings",
        hintKey: "settings.shortcuts.item.openSettingsHint",
        binding: "Ctrl+,",
      },
      {
        id: "hold-dictation",
        titleKey: "settings.shortcuts.item.holdDictation",
        hintKey: "settings.shortcuts.item.holdDictationHint",
        binding: null,
      },
      {
        id: "toggle-dictation",
        titleKey: "settings.shortcuts.item.toggleDictation",
        hintKey: "settings.shortcuts.item.toggleDictationHint",
        binding: null,
      },
      {
        id: "invert-follow-up",
        titleKey: "settings.shortcuts.item.invertFollowUp",
        hintKey: "settings.shortcuts.item.invertFollowUpHint",
        binding: "Ctrl+Enter",
      },
    ],
  },
];

/** The shortcut binding cell — the desktop's keycapture input in its
 * disabled form: a 150px bordered box holding the binding text (or the
 * unset placeholder), with the ✕ clear affordance inside-right for set
 * rows. Nothing is editable: a browser page cannot rebind global
 * shortcuts, so the input is readOnly + disabled and the ✕ is disabled. */
function BindingBox({
  binding,
  unsetLabel,
  testId,
  t,
}: {
  binding: string | null;
  unsetLabel: string;
  testId: string;
  t: (key: MessageKey) => string;
}) {
  const unset = binding === null;
  return (
    <div className="relative flex-shrink-0">
      <input
        disabled
        readOnly
        value={unset ? "" : binding}
        placeholder={unset ? unsetLabel : undefined}
        data-testid={testId}
        aria-label={unset ? unsetLabel : (binding as string)}
        className="h-8 w-[150px] rounded-[8px] border border-border_default bg-bg_default_primary pl-2.5 pr-7 text-sm text-text_default_primary placeholder:text-text_default_tertiary disabled:cursor-not-allowed"
      />
      {unset ? null : (
        <button
          type="button"
          disabled
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
  return (
    <div data-testid="settings-shortcuts-page" className="flex w-full flex-col gap-8">
      {/* The honesty notice (A1): the bindings below are the desktop's
       * defaults rendered for reference — a browser page cannot register
       * global shortcuts, so nothing here is live. */}
      <div
        data-testid="settings-shortcuts-notice"
        className="flex items-start gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-2 text-caption-small-strong leading-4 text-text_default_secondary"
      >
        <Icon name="info" size={14} className="mt-0.5 flex-none text-text_default_tertiary" aria-label="" />
        <span className="min-w-0 flex-1">{t("settings.shortcuts.notice")}</span>
      </div>
      {SHORTCUT_GROUPS.map((group) => (
        <GroupCard key={group.testId} title={t(group.titleKey)} testId={group.testId}>
          {group.rows.map((row, index) => (
            <React.Fragment key={row.id}>
              {index > 0 ? <HairDivider /> : null}
              <Row title={t(row.titleKey)} hint={t(row.hintKey)} testId={`settings-shortcuts-row-${row.id}`}>
                {row.reset ? (
                  /* The reference's external ↺ reset affordance — present
                   * on the Mini Chat row only, disabled like the ✕. */
                  <button
                    type="button"
                    disabled
                    aria-label={t("settings.shortcuts.reset")}
                    data-testid={`settings-shortcuts-reset-${row.id}`}
                    className="mr-1.5 flex size-6 items-center justify-center rounded text-text_default_tertiary disabled:cursor-not-allowed"
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                ) : null}
                <BindingBox
                  binding={row.binding}
                  unsetLabel={t("settings.shortcuts.unset")}
                  testId={`settings-shortcuts-binding-${row.id}`}
                  t={t}
                />
              </Row>
            </React.Fragment>
          ))}
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
            t={t}
          />
        </div>
      </div>
    </div>
  );
}
