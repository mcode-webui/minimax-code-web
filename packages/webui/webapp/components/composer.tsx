"use client";

import { Dropdown } from "antd";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import * as api from "@/lib/api";
import {
  getComposerDraft,
  setComposerDraft,
  subscribeComposerDraft,
} from "@/lib/composer-draft";
import { useSessionContext } from "@/lib/store";
import { decodeTranscript } from "@/lib/transcript";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";
import { ContextMeter } from "./context-meter";
import { Icon, type IconName } from "./icons";

/**
 * Message composer.
 *
 * Markup mirrors the upstream composer as captured from the running client:
 * an editor area (`rich-text-editor`, 16px/26px) over a footer row holding the
 * attach control, the permission-mode dropdown on the left, and the model chip
 * plus send button on the right. The card uses upstream's asymmetric radius
 * (tl/tr 20px, bl/br 24px) on `bg-default-scrim`.
 *
 * One deliberate substitution, forced by the dependency boundary: upstream edits
 * with Tiptap/ProseMirror; this is a `textarea` styled with the same
 * `rich-text-editor` class, so the typography and caret colour match.
 */

/**
 * True when the drag/drop event carries file items.
 *
 * `dataTransfer.types` lists the MIME flavours an item conforms to; only a
 * file drag carries the `"Files"` token. Text drags inside the textarea, or
 * drag-from-tab gestures, advertise other types and must not raise the
 * drop overlay.
 *
 * The browser exposes `types` either as a frozen string array (modern
 * Chromium / Firefox / Safari) or as a `DOMStringList` (legacy). Both
 * support indexed access, so a single length/index loop covers both
 * without needing `Array.from` or `Symbol.iterator`.
 */
export function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

/**
 * Permission modes.
 *
 * `selectable` marks the ones the menu offers. The desktop client's own permission
 * dropdown offers exactly three of its five-mode enum — upstream module 86707 has
 * `["default", "auto", "bypassPermissions"]` — so the menu mirrors that, with the
 * desktop's dictionary wording (主动询问 / 智能授权 / 始终授权).
 *
 * The other two are still listed because the *server* can report them: its preset
 * list is ask / auto / read / full / off (see
 * `server/lib/interaction/permission-presets.js`), reachable by launching mcode with
 * `--permission`. The chip has to be able to name them — displaying 始终授权 for a
 * session that is really read-only, or for one that has permission checks switched
 * off, would misstate what the agent is allowed to do. English values must stay
 * byte-identical to `webuiModeToLabel`, because that label is what the server
 * reports and what `resolvePermissionMode` matches on.
 */
/**
 * The selectable permission modes, in the desktop's order, with the glyph the
 * desktop draws for each. `read` and `off` are not offered — the desktop's menu
 * has exactly these three — so they carry no icon rather than an invented one.
 *
 * The ids are this server's wire ids (`PERMISSION_PRESETS` in
 * `server/lib/interaction/permission-presets.js`), not the engine's values the
 * desktop's option testids encode: `ask`/`full` here are `default`/
 * `bypassPermissions` on the wire.
 */
const PERMISSION_MODES: { id: string; key: MessageKey; icon?: IconName; selectable: boolean }[] = [
  { id: "ask", key: "permission.ask", icon: "permissionAsk", selectable: true },
  { id: "auto", key: "permission.auto", icon: "permissionAuto", selectable: true },
  { id: "full", key: "permission.full", icon: "reply", selectable: true },
  { id: "read", key: "permission.read", selectable: false },
  { id: "off", key: "permission.off", selectable: false },
];

export function Composer({ t, inline = false }: { t: (key: MessageKey) => string; inline?: boolean }) {
  const { state, providersRevision } = useSessionContext();
  // Text, attachments, and the error banner live in the module-scope draft
  // store (lib/composer-draft.ts) rather than useState: page.tsx swaps this
  // component between two tree positions when the first conversation line
  // lands in a state push, and a `useState`-held draft died with the
  // unmounted instance. The store survives the swap, so whatever the user
  // typed — and the failure banner they need to read — outlives any
  // remount. `sending` stays local: it is per-submit bookkeeping, not user
  // input worth preserving.
  const draft = useSyncExternalStore(subscribeComposerDraft, getComposerDraft, getComposerDraft);
  const value = draft.value;
  const attachments = draft.attachments;
  const error = draft.error;
  const setValue = useCallback((next: string) => setComposerDraft({ value: next }), []);
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState<
    {
      id: string;
      label: string;
      provider?: string;
      contextLimit?: number;
      source?: "engine" | "config" | "builtin";
      protocol?: "openai" | "anthropic" | "gemini";
      thinkingLevels?: string[];
      modalities?: string[];
    }[]
  >([]);
  const [groups, setGroups] = useState<
    {
      id: string;
      label: string;
      auth?: { hasKey: boolean; type: "byok" | "coding-plan" };
      protocol?: "openai" | "anthropic" | "gemini";
    }[]
  >([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Drag-and-drop overlay state. The counter lives in a ref so that the
  // dragenter/dragleave sequence can update it without scheduling a
  // re-render on every event — only the visible overlay (driven by
  // `dragCount`) crosses into state.
  //
  // Why a counter: each child element the drag enters fires its own
  // dragenter/dragleave pair. A naive `isDragging = event.type ===
  // "dragenter"` boolean flips off the moment the cursor crosses a
  // child boundary, which the browser reports as a leave from the
  // parent and an enter into the child. Tracking depth via a counter
  // keeps the overlay stable for the duration of the drag.
  const dragCounterRef = useRef(0);
  const [dragCount, setDragCount] = useState(0);
  const isDragging = dragCount > 0;

  const readOnly = state?.readOnly ?? false;
  const running = state?.running.active ?? false;
  // The server stores the permission mode as its *label* (`webuiModeToLabel(id)`
  // in routes/model.js) while this selector is keyed by id, so comparing the two
  // directly never matched and the chip always fell back to 完全访问 — you could
  // pick another mode and see nothing change (reported as "完全不能做出选择"
  // together with the occluded popup). Resolve either form.
  const permission = resolvePermissionMode(state?.permissions);
  const hasConversation = decodeTranscript(state?.chat ?? []).length > 0;
  /** Nothing to send yet — the send button is rendered but inert. */
  const empty = value.trim().length === 0 && attachments.length === 0;

  // The model catalogue comes from the server; the chip shows the active model
  // from the state snapshot so it tracks changes made elsewhere.
  //
  // The server merges three sources (engine session config option,
  // MCODE_WEBUI_MODELS_CONFIG providers file, and the mcode cli-bundle
  // builtin catalogue) and returns `groups[]` for provider-grouped rendering.
  // The catalogue is refreshable: the server re-reads both providers config
  // and the cli bundle per request, so a hot-edit in the bundled mcode
  // binary or a saved models.json takes effect on the next chip open. We
  // re-fetch when the session or the active model changes rather than only
  // on mount.
  const modelKey = state?.model?.name ?? "";
  const sessionKey = state?.sessionId ?? "";
  useEffect(() => {
    void api
      .listModels()
      .then((payload) => {
        setModels(
          (payload.models ?? []).map((m) => ({
            id: m.id,
            label: m.label ?? m.name ?? m.id,
            provider: m.provider,
            contextLimit: m.contextLimit,
            source: m.source,
            protocol: m.protocol,
            thinkingLevels: m.thinkingLevels,
            modalities: m.modalities,
          })),
        );
        setGroups(
          (payload.groups ?? []).map((g) => ({
            id: g.id,
            label: g.label,
            auth: g.auth,
            protocol: g.protocol,
          })),
        );
      })
      .catch(() => {});
  }, [modelKey, sessionKey, providersRevision]);

  /**
   * Slash-command completion.
   *
   * The command list is the server's own (`state.availableCommands`), reported
   * by mcode over ACP. The server's shape is `{ <group>: [{name, description}, ...] }`
   * — a dict of command groups, not a flat array — so we flatten to a list of
   * `name` strings before filtering. The palette stays open while the input is
   * a bare command word — once a space is typed the argument is being entered
   * and the list becomes noise.
   */
  const slashWord = value.startsWith("/") && !/\s/.test(value) ? value.slice(1).toLowerCase() : null;
  const slashCommands: string[] = useMemo(() => {
    const raw = state?.availableCommands;
    if (!raw || typeof raw !== "object") return [];
    const out: string[] = [];
    for (const group of Object.values(raw as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue;
      for (const entry of group) {
        if (entry && typeof entry === "object" && "name" in entry && typeof (entry as { name: unknown }).name === "string") {
          out.push((entry as { name: string }).name);
        }
      }
    }
    return out;
  }, [state?.availableCommands]);
  const slashMatches = slashWord === null
    ? []
    : slashCommands
        .filter((command) => command.toLowerCase().includes(slashWord.toLowerCase()))
        .slice(0, 8);
  const slashOpen = slashWord !== null && slashMatches.length > 0;

  /**
   * The chip's text.
   *
   * `state.model.name` is the engine's encoded selection (the `value` of its
   * `select` config option), while a catalogue entry carries a separate display
   * `name`. Reading the value straight into the chip made it read
   * `deepseek-v4.1-flash` while the menu listed `DeepSeek V4.1 Flash` — two
   * names for one model. Resolve through the catalogue so both surfaces name
   * the same thing, and fall back to the value only when the engine lists no
   * entry for it.
   *
   * When a thinking-effort level is recorded (`state.model.thinking`),
   * append a short tag like "· High" so the user can see what they're
   * about to send without opening the picker.
   */
  const currentModelLabel = useMemo(() => {
    const value = state?.model?.name ?? "";
    // No catalogue means the engine has not named a session model yet, so there
    // is nothing to claim. Rendering the state's default here is how the chip
    // came to say `MiniMax-M3` while the session ran something else — the
    // default is webui's own constant, in an encoding the engine does not use.
    let baseLabel: string;
    if (models.length === 0) baseLabel = t("composer.model");
    else {
      const known = models.find((model) => model.id === value);
      if (known) baseLabel = modelDisplayName(known.label);
      // A catalogue without this value: show the engine's own string rather
      // than inventing a label for it.
      else baseLabel = value || t("composer.model");
    }
    const thinking = state?.model?.thinking;
    if (!thinking) return baseLabel;
    const level = thinkingLevelKey(thinking);
    if (!level) return baseLabel;
    return `${baseLabel} · ${t(level)}`;
  }, [models, state?.model?.name, state?.model?.thinking, t]);

  /**
   * The thinking-effort levels the active model supports.
   *
   * The picker is mounted only when this list is non-empty; a model
   * that does not advertise reasoning controls never shows a no-op
   * control. The active model's id is matched against the catalogue
   * the same way `currentModelLabel` does; missing match → empty
   * picker (e.g. mid-fetch, or the engine encoded an id the
   * catalogue doesn't carry).
   */
  const thinkingLevelsForActive = useMemo(() => {
    const value = state?.model?.name ?? "";
    if (!value) return [];
    const known = models.find((model) => model.id === value);
    return known?.thinkingLevels ?? [];
  }, [models, state?.model?.name]);

  const submit = useCallback(async () => {
    const content = value.trim();
    if ((!content && attachments.length === 0) || readOnly || sending) return;
    setSending(true);
    setComposerDraft({ error: null });
    try {
      // A leading slash is a command, not a message: mcode parses those, and the
      // webui's own slash commands are handled server-side too.
      if (content.startsWith("/")) await api.sendCommand(content);
      else await api.sendMessage({ content, attachments });
      setComposerDraft({ value: "", attachments: [] });
    } catch (cause) {
      setComposerDraft({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSending(false);
    }
  }, [value, attachments, readOnly, sending]);

  const onPickFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const picked: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const result = await api.uploadFile(file);
        if (result?.path) picked.push(`@${result.path}`);
      } catch (cause) {
        setComposerDraft({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    if (picked.length) {
      setComposerDraft((current) => ({ attachments: [...current.attachments, ...picked] }));
    }
  }, []);

  // Drag-and-drop file upload. `preventDefault` on `dragover` is required:
  // without it the browser opens the file in the tab. Text drags (selecting
  // inside the textarea) are filtered out by `isFileDrag`, so the overlay only
  // appears for actual file drags.
  const onDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (readOnly) return;
      if (!isFileDrag(event.dataTransfer?.types)) return;
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setDragCount(1);
    },
    [readOnly],
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isFileDrag(event.dataTransfer?.types)) return;
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isFileDrag(event.dataTransfer?.types)) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragCount(0);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // A drop always ends the drag, regardless of readOnly or file type.
      dragCounterRef.current = 0;
      setDragCount(0);
      if (readOnly) return;
      if (!event.dataTransfer.files?.length) return;
      // Forward to the SAME upload path the click-attach input uses —
      // `onPickFiles` calls `api.uploadFile` for each file and collects
      // the resulting `@path` references into the attachment list.
      void onPickFiles(event.dataTransfer.files);
    },
    [readOnly, onPickFiles],
  );

  // Grow with the content, capped so the footer stays reachable.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  return (
    // `inline` is the home screen, where the composer sits inside the scrolling
    // greeting column instead of being pinned to the bottom. It drops the bottom
    // padding there so the project/mode row below can sit flush against the card.
    //
    // The four drag handlers live on the outer container. `onDragOver` must
    // `preventDefault()` or the browser navigates away to open the file.
    <div
      className={[
        "message-input-container relative",
        inline ? "px-4 pb-0" : "flex-none px-4 pb-4",
      ].join(" ")}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mx-auto w-full max-w-[743px]">
        {/* Upstream's message-input card. Its class string is
            `mavis-message-input-card w-full border border-border_default
             bg-bg_grouped_secondary_elevated px-2.5 pt-2.5 pb-2 rounded-[20px]
             shadow-[0_0_20px_rgba(10,10,10,0.08)]` (zh; en swaps in
            `rounded-[14px]`), so everything above is copied from it. That combination
            is how the desktop makes the card read as a raised surface — in the light
            theme `bg_grouped_secondary_elevated` and the page's `bg_grouped_secondary`
            are the *same* white, so the border and shadow are the only separation.

            `mavis-message-input-card` itself is deliberately NOT applied. That class
            comes with `padding/border-radius/box-shadow: var(--mavis-composer-*)!important`,
            and those custom properties are injected at runtime from a shape recipe this
            port does not carry — an undefined var in a shorthand like that is invalid at
            computed-value time, so adding the class here would silently zero the radius
            and padding. Same reason the shadow is a literal rgba: Tailwind v3 emits only
            `--tw-shadow-colored` for an arbitrary shadow containing `var()`, which
            produced no shadow at all (verified in the browser). */}
        <div className="flex w-full flex-col gap-1.5 overflow-hidden rounded-[20px] border border-border_default bg-bg_grouped_secondary_elevated px-2.5 pt-2.5 pb-2 shadow-[0_0_20px_rgba(10,10,10,0.08)]">

          {attachments.length ? (
            <div className="flex flex-wrap gap-1 px-2 pt-2">
              {attachments.map((path) => (
                <span
                  key={path}
                  className="rich-text-file-reference-chip flex items-center gap-1 rounded-md bg-bg_grouped_tertiary_elevated px-2 py-0.5 text-caption-small-strong text-text_default_secondary"
                >
                  <span className="max-w-[220px] truncate">{path.replace(/^@/, "")}</span>
                </span>
              ))}
            </div>
          ) : null}

          <div className="relative flex items-start px-1 pb-1 pt-1" data-testid="message-textarea">
            <textarea
              ref={editorRef}
              rows={1}
              value={value}
              disabled={readOnly}
              placeholder={readOnly ? t("composer.readOnly") : hasConversation ? t("composer.placeholderChat") : t("composer.placeholderHome")}
              className="rich-text-editor thin-scrollbar max-h-[220px] min-h-[26px] flex-1 resize-none"
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (slashOpen) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashIndex((index) => (index + 1) % slashMatches.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length);
                    return;
                  }
                  if (event.key === "Tab" || (event.key === "Enter" && slashMatches.length > 1)) {
                    // Tab always completes; Enter completes only while the list is
                    // ambiguous, so a fully-typed command still sends on Enter.
                    event.preventDefault();
                    const picked = slashMatches[slashIndex];
                    if (picked) setValue(`${picked} `);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setValue("");
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  // An IME confirms its candidate window with Enter. Submitting
                  // here would send a half-composed 继续 and cancel the
                  // composition the user was still choosing from.
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  event.preventDefault();
                  void submit();
                }
              }}
              onPaste={(event) => {
                const files = event.clipboardData?.files;
                if (files?.length) {
                  event.preventDefault();
                  void onPickFiles(files);
                }
              }}
            />
          </div>

          {slashOpen ? (
            <div className="mx-2 mb-1 overflow-hidden rounded-xl border border-border_default bg-bg_grouped_secondary_elevated">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-caption-small-strong text-text_default_tertiary">
                  {t("slash.title")}
                </span>
                <span className="text-caption-small-strong text-text_default_tertiary">
                  {t("slash.hint")}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 p-1 pt-0">
                {slashMatches.map((command, index) => (
                  <button
                    key={command}
                    type="button"
                    onMouseEnter={() => setSlashIndex(index)}
                    onClick={() => setValue(`${command} `)}
                    className={[
                      "flex items-center rounded-lg px-2 py-1 text-left font-family-code text-sm transition-colors",
                      index === slashIndex
                        ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
                        : "text-text_default_secondary",
                    ].join(" ")}
                  >
                    {command}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex min-w-0 items-center justify-between" data-message-input-toolbar>
            <div className="flex min-w-max shrink-0 items-center gap-1" data-message-input-toolbar-left>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => void onPickFiles(event.target.files)}
              />
              <RoundButton
                label={t("composer.attach")}
                testId="attach-button"
                onClick={() => fileRef.current?.click()}
              >
                <Icon name="attach" size={18} />
              </RoundButton>

              <PermissionSelect
                t={t}
                value={permission}
                onPick={(id) => void api.setPermissions(id)}
              />
            </div>

            <div className="flex min-w-0 shrink items-center gap-3" data-message-input-toolbar-right>
              {/* Context-window readout, immediately left of the model selector. */}
              <ContextMeter t={t} />
              <ModelSelect
                t={t}
                models={models}
                groups={groups}
                value={state?.model.name}
                label={currentModelLabel}
                onPick={(id) => {
                  // The composer hands the picker an id; we send the
                  // same `thinking` we already recorded so the engine's
                  // model+effort pair stays consistent across the
                  // mid-session model change. The server enforces
                  // "model first, then effort" and re-applies the
                  // effort in lockstep.
                  void api.setModel({
                    model: id,
                    ...(state?.model?.thinking
                      ? { thinking: state.model.thinking }
                      : {}),
                  });
                }}
              />
              {/* Thinking-effort picker (ticket 04). Only rendered when
                  the active model carries a `thinkingLevels` list; the
                  picker is gated so models without reasoning controls
                  never expose a no-op control. */}
              {thinkingLevelsForActive.length > 0 ? (
                <ThinkingEffortSelect
                  t={t}
                  levels={thinkingLevelsForActive}
                  value={state?.model?.thinking ?? ""}
                  disabled={running}
                  onPick={(level) => {
                    // Empty string clears the override (engine default
                    // stands). The server interprets `""` exactly that way
                    // — see routes/model.js#handleSetModel.
                    void api.setModel({ thinking: level });
                  }}
                />
              ) : null}

              {running ? (
                /* Upstream's stop control is a 30px circle in the quaternary icon
                   colour with a 12px square inside, not a rounded square in the
                   danger colour. Classes are the upstream ones verbatim. */
                <button
                  type="button"
                  aria-label={t("topbar.stop")}
                  data-testid="stop-button"
                  onClick={() => void api.stopRun()}
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-icon_default_quaternary text-icon_default_primary transition-colors hover:bg-opacity-90"
                >
                  <span aria-hidden="true" className="size-3 rounded-[3px] bg-icon_default_primary" />
                </button>
              ) : (
                /* Voice input is not implemented in this frontend (the server
                   has no ASR contract), so the mic is present but permanently
                   disabled rather than hidden. The send button is the up arrow
                   and is always rendered, disabled until there is something to
                   send. */
                <>
                  <button
                    type="button"
                    aria-label={t("composer.mic")}
                    title={`${t("composer.mic")} — ${t("common.unsupported")}`}
                    data-testid="composer-mic-button"
                    disabled
                    className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center rounded-[10px] text-icon_default_secondary opacity-40"
                  >
                    <Icon name="mic" size={18} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("composer.send")}
                    title={t("composer.send")}
                    data-testid="composer-send-button"
                    disabled={readOnly || sending || empty}
                    onClick={() => void submit()}
                    className="flex size-8 shrink-0 select-none items-center justify-center rounded-[10px] bg-bg_interaction_primary_default text-icon_interaction_primary_default transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:bg-bg_interaction_primary_inactive"
                  >
                    <Icon name="send" size={18} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mt-1 flex items-center justify-between gap-2 px-1">
          <span className="text-caption-small-strong text-text_default_secondary">
            {sending ? t("composer.sending") : t("composer.hint")}
          </span>

          {error ? (
            <span className="text-caption-small-strong text-text_status_error">
              {t("error.send")}: {error}
            </span>
          ) : null}
        </div>
      </div>

      {/* Drop overlay. Portalled to `document.body` so it covers the whole
          page (a drop can land on any pixel of the window), and layered
          above the modals (z-[1000]) but below the menu popovers (which
          already sit at z-[200]). `pointer-events-none` keeps the overlay
          from swallowing the `drop` event that closes the drag. */}
      {isDragging && typeof document !== "undefined"
        ? createPortal(
            <div
              role="status"
              aria-live="polite"
              data-testid="composer-drop-overlay"
              className="pointer-events-none fixed inset-0 z-[1500] flex items-center justify-center bg-utility_blanket"
            >
              <div className="rounded-2xl border border-border_default bg-bg_grouped_secondary_elevated px-6 py-4 shadow-shadow_default">
                <p className="text-text_default_primary text-base font-weight_medium">
                  {t("composer.dropHint")}
                </p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * A 32px square icon button in the toolbar's left group.
 *
 * The class list is the desktop's attach control, measured on the running
 * client: `w-8 h-8` (32px, not the 30px the send button used to be) with a 10px
 * radius, the secondary icon colour and the tertiary hover wash. The desktop
 * makes this a `div role="button" tabindex="0"`; a real `<button>` is the same
 * shape and is focusable and operable by keyboard without the extra wiring.
 */
function RoundButton({
  label,
  onClick,
  children,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 cursor-pointer select-none items-center justify-center rounded-[10px] text-icon_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover"
    >
      {children}
    </button>
  );
}

/**
 * The panel both composer selectors open into.
 *
 * antd's `Dropdown` is the shell — portal, placement, dismissal, and the
 * `ant-dropdown-trigger` wiring on the child — and this is the content, which is
 * how the desktop builds these too: its composer popups are
 * `mavis-dropdown-custom-content`, i.e. a transparent wrapper (ported in
 * `styles/mavis-dropdown.css`) around a panel that draws its own chrome. The
 * class list here is the desktop's, measured on the running client:
 * `min-w-[160px]`, a 12px radius, a hairline in `--border_default`, the elevated
 * background, 4px padding, and a 20px offset-less shadow.
 */
function SelectPanel({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="min-w-[160px] rounded-[12px] border border-border_default bg-bg_grouped_secondary_elevated p-1 shadow-[0_0_20px_rgba(10,10,10,0.08)]"
    >
      {children}
    </div>
  );
}

/**
 * One row of a `SelectPanel`.
 *
 * Defined further down (after ModelSelect) to keep the chip-related
 * primitives co-located with the model selector — see the second
 * `function SelectRow` below for the load-bearing shape.
 */

/**
 * Permission-mode selector.
 *
 * The trigger is the desktop's, measured on the running client: a 32px pill in
 * the secondary text colour whose leading glyph is the *selected* mode's, with a
 * chevron that flips to point up while the menu is showing. The rows are the
 * three selectable modes; `read` and `off` are not offered because the desktop's
 * menu has exactly three, and the ids here are this server's wire ids rather
 * than the engine values the desktop's option testids encode (see
 * `PERMISSION_MODES`).
 */
function PermissionSelect({
  t,
  value,
  onPick,
}: {
  t: (key: MessageKey) => string;
  value: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const modes = PERMISSION_MODES.filter((mode) => mode.selectable);
  // Unknown value → the `full` entry, which is what the server defaults to as
  // well. Optional throughout rather than asserted: the lookup cannot miss, but
  // an assertion would be a claim the compiler cannot check either.
  const current =
    PERMISSION_MODES.find((mode) => mode.id === value && mode.selectable) ??
    PERMISSION_MODES.find((mode) => mode.id === "full");

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={["click"]}
      placement="bottomLeft"
      overlayClassName="mavis-dropdown mavis-dropdown-compact mavis-dropdown-custom-content"
      popupRender={() => (
        <SelectPanel testId="permission-mode-dropdown">
          {modes.map((mode) => (
            <SelectRow
              key={mode.id}
              testId={`permission-mode-option-${mode.id}`}
              icon={mode.icon}
              label={t(mode.key)}
              selected={mode.id === current?.id}
              onClick={() => {
                setOpen(false);
                onPick(mode.id);
              }}
            />
          ))}
        </SelectPanel>
      )}
    >
      <button
        type="button"
        data-testid="permission-mode-trigger"
        aria-label={t(current?.key ?? "permission.full")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 items-center gap-1 rounded-[10px] px-2 text-sm text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
        {current?.icon ? (
          <Icon name={current.icon} size={18} className="text-icon_default_secondary" />
        ) : null}
        <span
          data-testid="permission-mode-label"
          className="permission-mode-trigger-label whitespace-nowrap"
        >
          {t(current?.key ?? "permission.full")}
        </span>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={16}
          className="text-icon_default_tertiary"
        />
      </button>
    </Dropdown>
  );
}

/**
 * Model selector.
 *
 * Same shell and panel as `PermissionSelect`. The desktop's own model popover is
 * hand-rolled rather than an antd dropdown, and it does not open under synthetic
 * input, so its panel could not be captured — the chrome here follows the
 * composer's other popups instead of inventing a third look. `bottomRight` keeps
 * a long model name from opening past the right edge, which is where this
 * control sits.
 *
 * Provider grouping: when models carry a `provider`, the panel renders a
 * labelled section per provider with a thin rule between them. The grouping is
 * visual only — the flat `models[]` is the source of truth for keyboard /
 * aria semantics, so single-select wiring stays identical. Ungrouped entries
 * (engine-encoded ids before a session exists) fall through to the flat list
 * under an "Other" heading.
 *
 * Ticket 04 wiring:
 *   - Per-row modality badges render next to the label when the model
 *     declares `modalities` (`text` / `image` / `audio` / `video` /
 *     `file`).
 *   - Provider groups whose `auth.hasKey === false` render greyed with
 *     a "configure in Settings" hint and disable their rows. The engine
 *     session group is always usable (it has no `auth`).
 *   - The flat `models[]` is still the source of truth for keyboard /
 *     aria semantics; the group disable is purely visual + click-guard.
 *
 * The label is the caller's: resolving a model id to a display name is this
 * frontend's own mapping, and antd has nothing to say about it.
 */
function ModelSelect({
  t,
  models,
  groups,
  value,
  label,
  onPick,
}: {
  t: (key: MessageKey) => string;
  models: {
    id: string;
    label: string;
    provider?: string;
    modalities?: string[];
  }[];
  /** Per-provider groups from `/api/models`. Used to disable no-key
   *  providers and to look up the display label the server resolved
   *  (`label` wins over the heuristic `providerLabel(providerId)`). */
  groups: {
    id: string;
    label: string;
    auth?: { hasKey: boolean; type: "byok" | "coding-plan" };
  }[];
  value?: string;
  label: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // Group by provider, preserving the catalogue order. A provider-less entry
  // (engine-encoded ids whose prefix wasn't coerced) falls into "Other" so it
  // is still reachable from the menu. The /api/models groups[] carries the
  // server-resolved label + auth view; merge it into the in-component shape.
  const grouped = useMemo(() => {
    const order: string[] = [];
    const buckets = new Map<
      string,
      { id: string; label: string; models: typeof models; auth?: { hasKey: boolean; type: "byok" | "coding-plan" } }
    >();
    for (const model of models) {
      const key = model.provider ?? "__other";
      if (!buckets.has(key)) {
        const meta = groups.find((g) => g.id === key);
        buckets.set(key, {
          id: key,
          label:
            key === "__other"
              ? t("modelSelector.other")
              : meta?.label ?? providerLabel(key),
          models: [],
          auth: meta?.auth,
        });
        order.push(key);
      }
      buckets.get(key)!.models.push(model);
    }
    return order.map((key) => buckets.get(key)!);
  }, [models, groups, t]);

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={["click"]}
      placement="bottomRight"
      overlayClassName="mavis-dropdown mavis-dropdown-compact mavis-dropdown-custom-content"
      popupRender={() => (
        <SelectPanel testId="model-select-panel">
          {models.length === 0 ? (
            <SelectRow testId="model-select-empty" label={t("composer.noModels")} />
          ) : (
            <div className="flex flex-col">
              {grouped.map((group, groupIndex) => {
                const disabled = isGroupDisabled(group);
                return (
                  <div
                    key={group.id}
                    data-testid={`model-select-group-${group.id}`}
                    data-disabled={disabled ? "true" : "false"}
                    className={groupIndex === 0 ? "" : "mt-1 border-t border-border_default pt-1"}
                  >
                    <div
                      data-testid={`model-select-group-label-${group.id}`}
                      className="flex items-center justify-between px-2 pb-0.5 pt-1 text-caption-small-strong uppercase tracking-wide text-text_default_tertiary"
                    >
                      <span>{group.label}</span>
                      {disabled ? (
                        <span
                          data-testid={`model-select-group-nokey-${group.id}`}
                          className="normal-case tracking-normal text-text_default_tertiary"
                          title={t("modelSelector.noKeyHint")}
                        >
                          {t("modelSelector.noKeyHint")}
                        </span>
                      ) : null}
                    </div>
                    {group.models.map((model) => (
                      <SelectRow
                        key={model.id}
                        testId={`model-select-option-${modelSlug(model.id)}`}
                        label={modelDisplayName(model.label)}
                        rightAdornment={
                          model.modalities && model.modalities.length > 0 ? (
                            <ModalityBadges
                              t={t}
                              modalities={model.modalities}
                            />
                          ) : null
                        }
                        selected={model.id === value}
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          setOpen(false);
                          onPick(model.id);
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </SelectPanel>
      )}
    >
      <button
        type="button"
        data-testid="model-selector-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 min-w-0 items-center gap-1 rounded-[10px] pl-2.5 pr-2 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
        {/* `truncate` where the desktop relies on `whitespace-nowrap`: model ids
            come from arbitrary providers, and an unbounded chip would squeeze
            the toolbar's left group instead of clipping itself. */}
        <span className="max-w-[180px] truncate whitespace-nowrap">{label}</span>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={16}
          className="text-icon_default_tertiary"
        />
      </button>
    </Dropdown>
  );
}

/**
 * True when a provider group should render greyed.
 *
 * Groups with `auth.hasKey === false` cannot reach their models — every
 * pick would 401/403. The engine session group (`__engine`) does not
 * carry `auth` at all; it is always usable because the engine has
 * already authenticated against its own credentials.
 */
function isGroupDisabled(group: {
  id: string;
  auth?: { hasKey: boolean; type: "byok" | "coding-plan" };
}): boolean {
  if (!group.auth) return false;
  return group.auth.hasKey === false;
}

/**
 * One row of a `SelectPanel`.
 *
 * A plain button, not an antd `Menu` item: the desktop renders these popups as
 * custom content, and its rows are buttons. The tick sits in a fixed 14px
 * trailing slot so a selected row's label starts on the same x as its
 * neighbours' — the same reason the desktop reserves the slot.
 *
 * `rightAdornment` is the optional trailing content slot the chip's
 * row uses for modality badges. `disabled` greys the row and ignores
 * clicks (used by the no-key provider groups).
 */
function SelectRow({
  testId,
  icon,
  label,
  selected,
  disabled,
  rightAdornment,
  onClick,
}: {
  testId: string;
  icon?: IconName;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  rightAdornment?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left transition-colors",
        disabled
          ? "cursor-not-allowed text-text_default_tertiary"
          : "hover:bg-bg_interaction_tertiary_hover",
      ].join(" ")}
    >
      {icon ? <Icon name={icon} size={16} className="text-icon_default_secondary" /> : null}
      <span className="min-w-0 flex-1 truncate text-sm font-normal leading-5 text-text_default_primary">
        {label}
      </span>
      {rightAdornment ? (
        <span className="flex shrink-0 items-center gap-1">{rightAdornment}</span>
      ) : null}
      <span className="w-3.5 flex-shrink-0">
        {selected ? <Icon name="checkSmall" size={14} className="text-text_default_primary" /> : null}
      </span>
    </button>
  );
}

/**
 * Modality chips rendered on the right of a model row.
 *
 * Each `modalities[]` value maps to a short localised chip via
 * `modelSelector.modalityBadge.<value>`. The chips are intentionally
 * mono-line — the model's display name owns the row's main text slot,
 * so a multi-line badge stack would compete with the truncate there.
 */
function ModalityBadges({
  t,
  modalities,
}: {
  t: (key: MessageKey) => string;
  modalities: string[];
}) {
  return (
    <>
      {modalities.map((m) => {
        const key = modalityBadgeKey(m);
        return (
          <span
            key={m}
            data-testid={`model-modality-badge-${m}`}
            className="rounded-md border border-border_default px-1 py-0.5 text-[10px] uppercase tracking-wide text-text_default_tertiary"
          >
            {t(key)}
          </span>
        );
      })}
    </>
  );
}

/**
 * Map a server-supplied modality string to its i18n key.
 *
 * Falls back to `file` for any value the catalogue carries but the
 * dictionary doesn't know — `file` is the closest neutral word and
 * keeps the badge readable rather than dropping a glyph on the row.
 */
function modalityBadgeKey(modality: string): MessageKey {
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
 * Map a server-supplied thinking level to its i18n key.
 *
 * The engine's `thinkingEffort` config option accepts `off` / `low` /
 * `medium` / `high` (see packages/tui/src/acp/control-state.ts). Unknown
 * levels fall through to no tag — the picker still shows them but the
 * chip label stays clean.
 */
function thinkingLevelKey(level: string): MessageKey | null {
  switch (level) {
    case "off":
      return "thinkingPicker.off";
    case "low":
      return "thinkingPicker.low";
    case "medium":
      return "thinkingPicker.medium";
    case "high":
      return "thinkingPicker.high";
    default:
      return null;
  }
}

/**
 * Thinking-effort picker.
 *
 * Same shell and panel as the other selectors. The trigger is the
 * active level ("High" / "Medium" / …) or "Use engine default" when
 * the user has not picked one (the recorded value is empty).
 *
 * The levels array comes from the active model's catalogue entry; the
 * selector is only mounted when that list is non-empty, so the picker
 * never advertises a level the model cannot accept. The "off" entry
 * is omitted from the menu when the model's `thinkingLevels` does not
 * include it — a model that only supports low/medium/high never shows
 * an "Off" option that the engine would reject.
 *
 * `disabled` greys the trigger during an active run; mid-session
 * changes are still recorded for the next turn (the documented
 * "running → next turn" semantic).
 */
function ThinkingEffortSelect({
  t,
  levels,
  value,
  disabled,
  onPick,
}: {
  t: (key: MessageKey) => string;
  levels: string[];
  value: string;
  disabled?: boolean;
  onPick: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentKey = value ? thinkingLevelKey(value) : null;
  const currentLabel = currentKey
    ? t(currentKey)
    : t("thinkingPicker.none");
  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={["click"]}
      placement="bottomRight"
      overlayClassName="mavis-dropdown mavis-dropdown-compact mavis-dropdown-custom-content"
      popupRender={() => (
        <SelectPanel testId="thinking-effort-panel">
          {levels.map((level) => {
            const key = thinkingLevelKey(level);
            return (
              <SelectRow
                key={level}
                testId={`thinking-effort-option-${level}`}
                label={key ? t(key) : level}
                selected={value === level}
                onClick={() => {
                  setOpen(false);
                  onPick(level);
                }}
              />
            );
          })}
          <div className="mt-1 border-t border-border_default pt-1">
            <SelectRow
              testId="thinking-effort-option-none"
              label={t("thinkingPicker.none")}
              selected={!value}
              onClick={() => {
                setOpen(false);
                onPick("");
              }}
            />
          </div>
        </SelectPanel>
      )}
    >
      <button
        type="button"
        data-testid="thinking-effort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={[
          "flex h-8 min-w-0 items-center gap-1 rounded-[10px] px-2 text-sm transition-colors",
          disabled
            ? "cursor-not-allowed text-text_default_tertiary"
            : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover",
        ].join(" ")}
      >
        <span className="max-w-[80px] truncate whitespace-nowrap">{currentLabel}</span>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={16}
          className="text-icon_default_tertiary"
        />
      </button>
    </Dropdown>
  );
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
function providerLabel(id: string): string {
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

/**
 * Model name without its provider prefix (`minimax_api/MiniMax-M3` → `MiniMax-M3`).
 *
 * The id is what the API speaks; the prefix is routing information, not part
 * of the model's name. Anything after the last separator is what the chip and
 * the menu render.
 */
function modelDisplayName(name?: string | null): string {
  const value = (name ?? "").trim();
  if (!value) return "";
  const parts = value.split("/");
  return (parts[parts.length - 1] ?? "").trim() || value;
}

/**
 * A model id as a `data-testid` suffix.
 *
 * Engine model ids are `m:<provider>:<model>:v:<variant>`, with `:` and `/` in
 * them, so they cannot be used raw. Collapsing the runs of punctuation keeps the
 * id recognisable in a selector while staying a valid attribute value.
 */
function modelSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve the active permission mode from the value the server reports.
 *
 * Accepts the mode id (`ask` / `auto` / `full`), or the label the server derives
 * from it in either locale (see `webuiModeToLabel`), and falls back to `full` —
 * which is what the server defaults to as well.
 */
function resolvePermissionMode(value: string | undefined): string {
  if (!value) return "full";
  const needle = value.trim().toLowerCase();
  const byLabelOrId = PERMISSION_MODES.find(
    (mode) =>
      mode.id === needle ||
      mode.key.toLowerCase() === needle ||
      (["zh", "en"] as Locale[]).some((locale) => translate(locale, mode.key).trim().toLowerCase() === needle),
  );
  return byLabelOrId?.id ?? "full";
}
