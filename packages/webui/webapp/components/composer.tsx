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
      .then((payload) =>
        setModels(
          (payload.models ?? []).map((m) => ({
            id: m.id,
            label: m.label ?? m.name ?? m.id,
            provider: m.provider,
            contextLimit: m.contextLimit,
            source: m.source,
          })),
        ),
      )
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
   */
  const currentModelLabel = useMemo(() => {
    const value = state?.model?.name ?? "";
    // No catalogue means the engine has not named a session model yet, so there
    // is nothing to claim. Rendering the state's default here is how the chip
    // came to say `MiniMax-M3` while the session ran something else — the
    // default is webui's own constant, in an encoding the engine does not use.
    if (models.length === 0) return t("composer.model");
    const known = models.find((model) => model.id === value);
    if (known) return modelDisplayName(known.label);
    // A catalogue without this value: show the engine's own string rather than
    // inventing a label for it.
    return value || t("composer.model");
  }, [models, state?.model?.name, t]);

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
                value={state?.model.name}
                label={currentModelLabel}
                onPick={(id) => void api.setModel(id)}
              />

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
 * A plain button, not an antd `Menu` item: the desktop renders these popups as
 * custom content, and its rows are buttons. The tick sits in a fixed 14px
 * trailing slot so a selected row's label starts on the same x as its
 * neighbours' — the same reason the desktop reserves the slot.
 */
function SelectRow({
  testId,
  icon,
  label,
  selected,
  onClick,
}: {
  testId: string;
  icon?: IconName;
  label: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
    >
      {icon ? <Icon name={icon} size={16} className="text-icon_default_secondary" /> : null}
      <span className="min-w-0 flex-1 truncate text-sm font-normal leading-5 text-text_default_primary">
        {label}
      </span>
      <span className="w-3.5 flex-shrink-0">
        {selected ? <Icon name="checkSmall" size={14} className="text-text_default_primary" /> : null}
      </span>
    </button>
  );
}

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
 * The label is the caller's: resolving a model id to a display name is this
 * frontend's own mapping, and antd has nothing to say about it.
 */
function ModelSelect({
  t,
  models,
  value,
  label,
  onPick,
}: {
  t: (key: MessageKey) => string;
  models: { id: string; label: string; provider?: string }[];
  value?: string;
  label: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // Group by provider, preserving the catalogue order. A provider-less entry
  // (engine-encoded ids whose prefix wasn't coerced) falls into "Other" so it
  // is still reachable from the menu.
  const grouped = useMemo(() => {
    const order = [];
    const buckets = new Map<string, typeof models>();
    for (const model of models) {
      const key = model.provider ?? "__other";
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(model);
    }
    return order.map((key) => ({
      key,
      label:
        key === "__other"
          ? t("modelSelector.other")
          : providerLabel(key),
      models: buckets.get(key)!,
    }));
  }, [models, t]);

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
              {grouped.map((group, groupIndex) => (
                <div
                  key={group.key}
                  data-testid={`model-select-group-${group.key}`}
                  className={groupIndex === 0 ? "" : "mt-1 border-t border-border_default pt-1"}
                >
                  <div
                    data-testid={`model-select-group-label-${group.key}`}
                    className="px-2 pb-0.5 pt-1 text-caption-small-strong uppercase tracking-wide text-text_default_tertiary"
                  >
                    {group.label}
                  </div>
                  {group.models.map((model) => (
                    <SelectRow
                      key={model.id}
                      testId={`model-select-option-${modelSlug(model.id)}`}
                      label={modelDisplayName(model.label)}
                      selected={model.id === value}
                      onClick={() => {
                        setOpen(false);
                        onPick(model.id);
                      }}
                    />
                  ))}
                </div>
              ))}
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
