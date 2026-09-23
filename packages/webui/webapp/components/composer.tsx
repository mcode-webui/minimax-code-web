"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import * as api from "@/lib/api";
import { useSessionContext } from "@/lib/store";
import { decodeTranscript } from "@/lib/transcript";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";
import { ContextMeter } from "./context-meter";
import { Icon } from "./icons";

/**
 * Message composer.
 *
 * Markup mirrors the upstream composer as captured from the running client:
 * an editor area (`rich-text-editor`, 16px/26px) over a footer row holding the
 * attach control, the permission-mode dropdown on the left, and the model chip
 * plus send button on the right. The card uses upstream's asymmetric radius
 * (tl/tr 20px, bl/br 24px) on `bg-default-scrim`.
 *
 * Two deliberate substitutions, both forced by the dependency boundary (this
 * package ships no runtime libraries beyond React):
 *   - upstream edits with Tiptap/ProseMirror; this is a `textarea` styled with the
 *     same `rich-text-editor` class, so the typography and caret colour match.
 *   - upstream's dropdowns are antd; `Menu` below reproduces the container styling
 *     from the token layer.
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
const PERMISSION_MODES: { id: string; key: MessageKey; selectable: boolean }[] = [
  { id: "ask", key: "permission.ask", selectable: true },
  { id: "auto", key: "permission.auto", selectable: true },
  { id: "full", key: "permission.full", selectable: true },
  { id: "read", key: "permission.read", selectable: false },
  { id: "off", key: "permission.off", selectable: false },
];

export function Composer({ t, inline = false }: { t: (key: MessageKey) => string; inline?: boolean }) {
  const { state } = useSessionContext();
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
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
  // The server reads it from the engine's session config options, which do not
  // exist until a session does — so re-fetch when the session or the active
  // model changes rather than only on mount.
  const modelKey = state?.model?.name ?? "";
  const sessionKey = state?.sessionId ?? "";
  useEffect(() => {
    void api
      .listModels()
      .then((payload) =>
        setModels((payload.models ?? []).map((m) => ({ id: m.id, label: m.name || m.id }))),
      )
      .catch(() => {});
  }, [modelKey, sessionKey]);

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
    setError(null);
    try {
      // A leading slash is a command, not a message: mcode parses those, and the
      // webui's own slash commands are handled server-side too.
      if (content.startsWith("/")) await api.sendCommand(content);
      else await api.sendMessage({ content, attachments });
      setValue("");
      setAttachments([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    if (picked.length) setAttachments((current) => [...current, ...picked]);
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

              <Menu
                label={t("permission.label")}
                trigger={
                  <button
                    type="button"
                    data-testid="permission-mode-trigger"
                    className="desktop-text-ui-body flex h-[30px] items-center gap-1 rounded-[10px] px-2 text-sm text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover"
                  >
                    <Icon name="reply" size={15} />
                    <span className="permission-mode-trigger-label whitespace-nowrap">
                      {t(PERMISSION_MODES.find((m) => m.id === permission)?.key ?? "permission.full")}
                    </span>
                    <Icon name="chevronDown" size={14} />
                  </button>
                }
              >
                {PERMISSION_MODES.filter((mode) => mode.selectable).map((mode) => (
                  <MenuItem
                    key={mode.id}
                    selected={mode.id === permission}
                    onClick={() => void api.setPermissions(mode.id)}
                  >
                    {t(mode.key)}
                  </MenuItem>
                ))}
              </Menu>
            </div>

            <div className="flex min-w-0 shrink items-center gap-2">
              {/* Context-window readout, immediately left of the model selector. */}
              <ContextMeter t={t} />
              <Menu
                label={t("composer.model")}
                align="right"
                trigger={
                  <button
                    type="button"
                    className="flex h-8 min-w-0 items-center gap-1 rounded-[10px] pl-2.5 pr-2 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
                  >
                    <span className="max-w-[180px] truncate whitespace-nowrap">
                      {currentModelLabel}
                    </span>
                    <Icon name="chevronDown" size={14} />
                  </button>
                }
              >
                {models.length === 0 ? (
                  <MenuItem onClick={() => {}}>{t("composer.noModels")}</MenuItem>
                ) : null}
                {models.map((model) => (
                  <MenuItem
                    key={model.id}
                    selected={model.id === state?.model.name}
                    onClick={() => void api.setModel(model.id)}
                  >
                    {modelDisplayName(model.label)}
                  </MenuItem>
                ))}
              </Menu>

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
                    className="flex size-[30px] shrink-0 cursor-not-allowed items-center justify-center rounded-[10px] text-icon_default_secondary opacity-40"
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
                    className="flex size-[30px] shrink-0 items-center justify-center rounded-[10px] text-icon_interaction_primary_default transition-colors bg-bg_interaction_primary_default hover:opacity-90 disabled:bg-bg_interaction_primary_inactive"
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
      className="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[10px] text-icon_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover"
    >
      {children}
    </button>
  );
}

/**
 * Popup used by the composer's permission and model controls.
 *
 * The panel is portalled to `document.body` and positioned with `fixed` from
 * the trigger's rect, instead of being an `absolute` child of the trigger.
 * Fixed positioning inside a body portal removes the whole class of failure
 * where an `absolute` child was painted/clipped by the composer's
 * `overflow-hidden` ancestors; the position is also clamped to the viewport.
 *
 * Dismissal contract is outside click / Escape; scroll and resize just
 * reposition the panel (a fixed panel must keep tracking its trigger).
 */
function Menu({
  label,
  align = "left",
  trigger,
  children,
}: {
  label: string;
  align?: "left" | "right";
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; bottom: number; minWidth: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const element = rootRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const width = Math.max(160, rect.width);
    const left =
      align === "right"
        ? Math.min(window.innerWidth - 8 - width, rect.right - width)
        : Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 8 - width));
    setPlacement({ left, bottom: window.innerHeight - rect.top + 6, minWidth: width });
  }, [align]);

  useEffect(() => {
    if (open) place();
    else setPlacement(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The panel lives outside `rootRef`, so both are checked — otherwise
      // mousedown inside the panel would close it before the click landed.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // Reposition rather than close: a fixed panel has to keep tracking its
    // trigger, and a click can scroll the page on its own.
    const onMove = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  return (
    <div ref={rootRef} className="relative">
      <div
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setOpen((current) => !current);
        }}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-expanded={open}
      >
        {trigger}
      </div>
      {open && placement && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label={label}
              style={{ left: placement.left, bottom: placement.bottom, minWidth: placement.minWidth }}
              className="fixed z-[200] rounded-[12px] border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-1 shadow-[0_0_20px_rgba(10,10,10,0.08)]"
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-bg_interaction_tertiary_hover",
        selected ? "text-text_default_accent" : "text-text_default_primary",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <span className="text-caption-small-strong">✓</span> : null}
    </button>
  );
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
