"use client";

import { Dropdown } from "antd";
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import * as api from "@/lib/api";
import { clientId } from "@/lib/cid";
import { bridgedControlAvailability, readEngineCapabilities } from "@/lib/engine-capabilities";
import type { ControlAvailability, EngineCapabilities } from "@/lib/engine-capabilities";
import {
  effortControlShape,
  effortOptionsWithDefault,
  isThinkingOn,
  resolveEffortCurrent,
} from "@/lib/effort-control";
import {
  chipLevelSuffix,
  groupModelsByProvider,
  isGroupDisabled,
  modalityBadgeKey,
  providerIdOfModel,
  providerLabel,
  thinkingLevelKey,
  thinkingLevelLabel,
  thinkingLevelsForModel,
} from "@/lib/model-groups";
import {
  getComposerDraft,
  mergeRestoredDraft,
  setComposerDraft,
  subscribeComposerDraft,
  unconfirmedPatchOnTurnEnd,
} from "@/lib/composer-draft";
import {
  completeComposerSent,
  failComposerSent,
  startComposerSent,
} from "@/lib/composer-sent";
import { getActiveSessionId, useSessionContext } from "@/lib/store";
import {
  completeSlashWord,
  flattenAvailableCommands,
  routeSlashInput,
  shouldCompleteSlashWord,
} from "@/lib/slash-routing";
import { decodeTranscript } from "@/lib/transcript";
import { isSendUnconfirmed } from "@/lib/api";
import {
  probeSend,
  shouldRestoreDraft,
  type SendProbeOutcome,
} from "@/lib/send-confirmation";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";

/**
 * Which unconfirmed banner to render.
 *
 * `null` (no probe recorded — a path that set the kind without an outcome)
 * maps to the "unreachable" wording on purpose: it is the only one of the
 * three that does not claim to know whether the turn started, so it is the
 * honest answer when the outcome is missing. It must never fall back to
 * `error.send`, which reads as a refusal.
 */
function unconfirmedBannerKey(outcome: SendProbeOutcome | null): MessageKey {
  if (outcome === "accepted") return "error.unconfirmed.accepted";
  if (outcome === "rejected") return "error.unconfirmed.rejected";
  return "error.unconfirmed.unreachable";
}
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

export function Composer({
  t,
  inline = false,
  onAddProvider,
}: {
  t: (key: MessageKey) => string;
  inline?: boolean;
  /** Open the provider management flow with a fresh draft already
   *  created. The model selector's top "Add provider" row triggers
   *  this; it lands the user in the settings modal on the providers
   *  section, with the id input focused so they can start typing. */
  onAddProvider?: () => void;
}) {
  const { state, providersRevision } = useSessionContext();
  // The session this composer is standing in. Derived before the draft
  // subscription because the draft store is keyed BY SESSION (webui-parity
  // 106, smoke-report P5): the getter below reads this session's box, so a
  // session switch swaps text, attachments and the banner synchronously in
  // the same render instead of bleeding the previous session's state in.
  // `""` is the no-session bucket (home screen, before the first snapshot).
  const modelKey = state?.model?.name ?? "";
  const sessionKey = state?.sessionId ?? "";
  // Text, attachments, and the error banner live in the module-scope draft
  // store (lib/composer-draft.ts) rather than useState: page.tsx swaps this
  // component between two tree positions when the first conversation line
  // lands in a state push, and a `useState`-held draft died with the
  // unmounted instance. The store survives the swap, so whatever the user
  // typed — and the failure banner they need to read — outlives any
  // remount. Since 106 the store is per-session: the keyed getter keeps
  // session A's draft out of session B's composer, and both drafts survive
  // the round trip. `sending` stays local: it is per-submit bookkeeping, not
  // user input worth preserving.
  const draft = useSyncExternalStore(
    subscribeComposerDraft,
    () => getComposerDraft(sessionKey),
    () => getComposerDraft(""),
  );
  const value = draft.value;
  const attachments = draft.attachments;
  const error = draft.error;
  const errorKind = draft.errorKind;
  const unconfirmedOutcome = draft.unconfirmed;
  const setValue = useCallback(
    (next: string) => setComposerDraft(sessionKey, { value: next }),
    [sessionKey],
  );
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
      contextWindowOptions?: number[];
      contextWindowOptionHints?: Record<string, string>;
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
  // The live session id used to live on a per-instance ref here.
  // That was correct for chat→chat switching (the instance survives)
  // but wrong for the home↔chat boundary: page.tsx swaps the
  // composer between two tree positions when `hasConversation`
  // flips, and creating a fresh session clears `chat`, which can
  // unmount the composer mid-flight. The in-flight closure keeps a
  // ref frozen at the dispatch-time session id and never sees the
  // rotation. Reading from `getActiveSessionId()` at catch time
  // resolves the live session id from the module-scope snapshot
  // the SSE handler writes — the same store `composer-draft.ts`
  // and `composer-sent.ts` already use to survive remounts.
  // See lib/store.tsx#getActiveSessionId and the tripwire test
  // `composer-submit-tripwire.test.ts` for the wiring pin.
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
  // M3-B9: the two engine-backed controls below are hidden outright when
  // the connected provider declares the matching write absent. Not
  // disabled, not a toast — the engine has never been able to perform the
  // write, so a visible control would be advertising an action that
  // cannot happen. See `lib/engine-capabilities.ts` for the fail-open
  // rule and `webapp/test/engine-capabilities-degradation.test.ts` for
  // the coverage of both halves.
  const permissionControl = useEngineControlAvailability("permissionMode");
  const modelControl = useEngineControlAvailability("model");
  const hasConversation = decodeTranscript(state?.chat ?? []).length > 0;
  /** Nothing to send yet — the send button is rendered but inert. */
  const empty = value.trim().length === 0 && attachments.length === 0;

  // Smoke-report P4 (webui-parity 106): the grey unconfirmed banner must not
  // outlive the turn it warned about. When the acknowledgement timed out, the
  // probe answered "the engine is running this message — do not resend"; once
  // `running.active` falls, that warning describes a turn that is over, and
  // after `sleep 35` it used to sit under the input until the next send or a
  // reload. The decision lives in `unconfirmedPatchOnTurnEnd` (unit-tested);
  // the wiring here only feeds it the running-flag fall. #126's three-value
  // display semantics are untouched — this owns dismissal, not display, and
  // a real `rejected` refusal keeps its dismiss paths.
  const prevRunningRef = useRef(running);
  useEffect(() => {
    const patch = unconfirmedPatchOnTurnEnd(
      prevRunningRef.current,
      running,
      errorKind,
    );
    prevRunningRef.current = running;
    if (patch) setComposerDraft(sessionKey, patch);
  }, [running, errorKind, sessionKey]);

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
  // The banner no longer needs a sessionKey-keyed clear effect: since 106 the
  // draft store itself is keyed by session, so a banner recorded in session A
  // simply lives in A's box and session B reads its own (empty) one. The
  // typed draft stays with its session for the same reason.
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
            contextWindowOptions: m.contextWindowOptions,
            contextWindowOptionHints: m.contextWindowOptionHints,
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
  // flattenAvailableCommands dedupes names across groups — the mcode and webui
  // groups both report a `help`, and the palette keys rows by name, so the
  // duplicates would collide (React same-key warning) and draw twice.
  const slashCommands: string[] = useMemo(
    () => flattenAvailableCommands(state?.availableCommands),
    [state?.availableCommands],
  );
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
    // Ticket 11 stale-suffix guard: the chip only shows "· level"
    // when the active model actually supports the recorded level.
    // Switching from M3 (thinkingLevels=["off","on"], ticket 36)
    // with a recorded "高" to M2 Lite (no thinkingLevels) used to
    // render "MiniMax-M2 Lite · 高" — the engine rejects 高 for
    // M2 Lite, and the stale suffix misled the user about what the
    // next turn would do. Hiding the suffix when the level is
    // unsupported is the display half of the fix; the wire half
    // (clearing the level when the new model doesn't support it)
    // lives in the `onPick` callback below.
    const activeModel = models.find((m) => m.id === value);
    const suffix = chipLevelSuffix(t, thinking, activeModel);
    return suffix ? `${baseLabel}${suffix}` : baseLabel;
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
  const thinkingLevelsForActive = useMemo(
    () => thinkingLevelsForModel(models, state?.model?.name),
    [models, state?.model?.name],
  );

  /**
   * U6 — the context-window radio's current value and the pick handler
   * target. The display value is the server-resolved
   * `currentContextWindow` semantics inlined: the recorded pick wins,
   * the active model's catalogue `contextLimit` (the engine's current
   * effective window) is the fallback, `null` when neither exists (no
   * radio is highlighted — never claim a window nothing confirmed).
   */
  const currentContextWindow = useMemo<number | null>(() => {
    const recorded = state?.model?.contextWindow;
    if (typeof recorded === "number" && recorded > 0) return recorded;
    const value = state?.model?.name ?? "";
    const known = value ? models.find((model) => model.id === value) : undefined;
    const limit = known?.contextLimit;
    return typeof limit === "number" && limit > 0 ? limit : null;
  }, [models, state?.model?.name, state?.model?.contextWindow]);

  const submit = useCallback(async () => {
    const content = value.trim();
    if ((!content && attachments.length === 0) || readOnly || sending) return;
    // Capture the dispatch context — what session this send was FOR.
    // The outbox record stores these, so a later failure can identify
    // its owner. They are NOT the values the catch branch compares
    // against; the catch branch reads the LIVE context (see below).
    // `dispatchDraftKey` is the same identity in the per-session draft
    // store: the banner a failed send leaves behind must land in the
    // session that attempted it, so the user finds it when they come
    // back — never pasted into whichever session they are looking at
    // by then (smoke-report P5, the s28 capture).
    const dispatchCid = clientId();
    const dispatchSessionId = state?.sessionId ?? null;
    const dispatchDraftKey = dispatchSessionId ?? "";
    setSending(true);
    setComposerDraft(dispatchDraftKey, {
      error: null,
      errorKind: null,
      unconfirmed: null,
    });
    // Ticket 13 — optimistic clear. The backend does session
    // switching and transcript backfill before its ack, so waiting
    // for the await leaves the text sitting in the box for the whole
    // in-flight window. Park the message in the outbox (a sibling
    // module-scope store to `composer-draft.ts`, see `lib/composer-
    // sent.ts`) and clear the composer immediately. On success the
    // outbox flips to `delivered` and the SSE stream renders the user
    // bubble; on failure the catch branch reads the stashed text back
    // into the composer — see the design note at the top of
    // `lib/composer-sent.ts`.
    startComposerSent({
      cid: dispatchCid,
      sessionId: dispatchSessionId,
      content,
      attachments,
    });
    setComposerDraft(dispatchDraftKey, { value: "", attachments: [] });
    try {
      // A slash input is a message OR a command, and only the eight
      // webui button commands belong to /api/cmd — routing on the
      // leading slash alone sent `/goal <text>` and `/compact` to an
      // endpoint that never implemented them, which answered ok and
      // dropped the input (webui-parity 62 D4). Everything else goes to
      // /api/send, where handleLocalSlash consumes the typed webui
      // commands and its default branch forwards the rest to the
      // engine. The same record/clear/restore semantics apply to both
      // branches; a 4xx from either one lands in the catch below, so
      // the text comes back into the box instead of vanishing.
      const route = routeSlashInput(content);
      if (route.kind === "command") await api.sendCommand(route.cmd);
      else await api.sendMessage({ content, attachments });
      completeComposerSent();
    } catch (cause) {
      // An expired deadline is NOT a failure. Both send endpoints can already
      // hold the request — `handleSend` writes its 200 before the turn runs —
      // so the engine can be executing the prompt while the browser is still
      // waiting. The old "failed" banner plus a refilled box is what made the
      // user press Enter again and run `sleep 35` twice (webui-parity 81 D-2).
      // Ask the server instead of guessing, over a bounded budget
      // (`lib/send-confirmation.ts`), and let that answer decide both the
      // words and whether the text comes back.
      const unconfirmed = isSendUnconfirmed(cause);
      const outcome: SendProbeOutcome | null = unconfirmed
        ? await probeSend(content)
        : null;
      const errorMessage = unconfirmed
        ? ""
        : cause instanceof Error
          ? cause.message
          : String(cause);
      // Read the LIVE context at catch time. The dispatch-side
      // closure has the session id from when the user pressed
      // Enter; if the user has since switched sessions (e.g. via the
      // sidebar), the active session id is now different and the
      // failure belongs to the old session, not the one currently
      // rendered. Comparing against the captured `dispatchSessionId`
      // would always succeed (dispatch vs dispatch) — that was the
      // first wiring bug acceptance caught. The live context is
      // resolved from the MODULE-scope store snapshot (lib/store.tsx
      // #getActiveSessionId), not from a per-instance ref. The
      // composer's `submit` can outlive its own React tree —
      // page.tsx swaps the composer between two positions when
      // `hasConversation` flips, and creating a fresh session
      // clears it. An instance-scoped ref frozen at dispatch time
      // never sees the rotation; the module snapshot is the same
      // store the SSE handler writes, so it always reflects the
      // current session. `clientId()` is module-scope too
      // (lib/cid.ts), so the cid side has always been correct.
      const liveCid = clientId();
      const liveSessionId = getActiveSessionId();
      // failComposerSent returns the restore payload only when the
      // LIVE context still matches the dispatch context — a session
      // switch mid-flight must never paste the old session's text
      // into the new session's composer. When it does match, the live
      // session IS the dispatch session, so keying the merge by the
      // live draft key writes the same box the user is looking at.
      const restored = failComposerSent({
        cid: liveCid,
        sessionId: liveSessionId,
        error: errorMessage,
      });
      // Always set the error banner — but in the DISPATCH session's
      // draft box, not the live one. The failure is real even when the
      // active session no longer matches the record; with the per-
      // session store, writing it into the owning session means the
      // user finds the banner when they return to that session, and
      // the session they switched TO never paints red for a send it
      // never made (the s28 bleed in the smoke report). The submit-
      // path clear above already keyed the same box.
      if (restored && (outcome === null || shouldRestoreDraft(outcome))) {
        // A send the server may already be running must NOT come back as text
        // sitting in the box: one Enter would run it a second time. The
        // user may have typed INTERIM text during the in-flight
        // window, and the command path now has failures worth
        // restoring from too (a 4xx from /api/cmd, a network failure):
        // "Nothing may vanish" applies to the rejected input and to
        // whatever was typed since. The merge rule lives in
        // lib/composer-draft#mergeRestoredDraft so it is unit-tested
        // instead of being re-derived from a React callback.
        setComposerDraft(
          dispatchDraftKey,
          mergeRestoredDraft(getComposerDraft(dispatchDraftKey), restored),
        );
      }
      setComposerDraft(dispatchDraftKey, {
        error: errorMessage,
        errorKind: unconfirmed ? "unconfirmed" : "rejected",
        unconfirmed: outcome,
      });
    } finally {
      setSending(false);
    }
  }, [value, attachments, readOnly, sending, state?.sessionId]);

  const onPickFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const picked: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const result = await api.uploadFile(file);
        if (result?.path) picked.push(`@${result.path}`);
      } catch (cause) {
        setComposerDraft(sessionKey, {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (picked.length) {
      setComposerDraft(sessionKey, (current) => ({
        attachments: [...current.attachments, ...picked],
      }));
    }
  }, [sessionKey]);

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
      {/* Slice 25 — measure cap lives on the CONTENT, not the
          column. The column absorbs all leftover (no ceiling);
          the composer is capped at 960px (matching the chat
          stream's measure cap) and centred with `mx-auto`. At
          viewports where the column is narrower than 960 the
          cap doesn't bite; at wider viewports the slack above
          960 splits evenly left and right inside the column —
          the reporter's "comfortable measure, centred slack"
          choice. */}
      <div className="mx-auto w-full max-w-[960px]">
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
                  if (shouldCompleteSlashWord(event.key)) {
                    // Tab only. Enter falls through to submit below — see
                    // shouldCompleteSlashWord for why the candidate count
                    // does not get a say, and completeSlashWord for why the
                    // leading slash is re-attached.
                    event.preventDefault();
                    const picked = slashMatches[slashIndex];
                    if (picked) setValue(completeSlashWord(picked));
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
                    onClick={() => setValue(completeSlashWord(command))}
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

              {/* M3-B9: hidden outright when the provider declares no
                  permission-mode write — see the declaration comment on
                  `permissionControl` above. */}
              {permissionControl.available ? (
                <PermissionSelect
                  t={t}
                  value={permission}
                  onPick={(id) => void api.setPermissions(id)}
                />
              ) : null}
            </div>

            <div className="flex min-w-0 shrink items-center gap-3" data-message-input-toolbar-right>
              {/* Context-window readout, immediately left of the model selector. */}
              <ContextMeter t={t} />
              {/* M3-B9: same rule, same reason, for the model chip. The
                  context-window readout next to it stays — it READS state
                  webui already has and does not ask the engine to change
                  anything, so it is not part of this capability. */}
              {modelControl.available ? (
                <ModelSelect
                  t={t}
                  models={models}
                groups={groups}
                value={state?.model.name}
                label={currentModelLabel}
                sessionKey={sessionKey}
                thinking={state?.model?.thinking ?? ""}
                contextWindow={currentContextWindow}
                onAddProvider={onAddProvider}
                onPick={(id) => {
                  // Ticket 11: cascade click sends the MODEL only.
                  // The recorded thinking effort is preserved when
                  // the new model still offers it (server contract
                  // from ticket 08 — model first, then effort), else
                  // cleared via the documented `thinking: ""` payload
                  // (server treats "" as "no override; engine picks").
                  // One atomic wire call covers both cases.
                  const newModel = models.find((m) => m.id === id);
                  const supported = newModel?.thinkingLevels ?? [];
                  const recorded = state?.model?.thinking ?? "";
                  // U6: the same follow-the-model rule for the
                  // recorded context window — a pick the new model
                  // doesn't advertise is cleared (null = the
                  // documented "engine default stands" sentinel) in
                  // the same request, so the picker never carries a
                  // stale window across a model switch.
                  const recordedWindow = state?.model?.contextWindow;
                  const windowStale =
                    typeof recordedWindow === "number" &&
                    !normalizeContextWindowOptions(
                      newModel?.contextWindowOptions,
                    ).includes(recordedWindow);
                  if (recorded && !supported.includes(recorded)) {
                    void api.setModel({
                      model: id,
                      thinking: "",
                      ...(windowStale ? { contextWindow: null } : {}),
                    });
                  } else if (windowStale) {
                    void api.setModel({ model: id, contextWindow: null });
                  } else {
                    void api.setModel({ model: id });
                  }
                }}
                onContextPick={(windowValue) => {
                  // U6: the radio rides the same atomic endpoint — the
                  // active model id is sent along so the recorded pick
                  // and the model stay one transaction.
                  const id = state?.model?.name ?? "";
                  void api.setModel(
                    id
                      ? { model: id, contextWindow: windowValue }
                      : { contextWindow: windowValue },
                  );
                }}
                onThinkingPick={(level) => {
                  // Ticket 49 batch 2 (A3): the side column's level
                  // pick travels the SAME payload the composer-level
                  // control sends — `{thinking}` with `""` clearing the
                  // override (engine default stands). No request-body
                  // change.
                  void api.setModel({ thinking: level });
                }}
                thinkingDisabled={running}
                />
              ) : null}
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

          {error || errorKind ? (
            // Three different facts need three different sentences. An expired
            // deadline is not a refusal, so it never wears the "could not
            // send" headline nor the error colour — saying either would be a
            // claim about a side effect that may already have happened, and it
            // is what pushed the user into resending (webui-parity 81 D-2).
            <span
              className={
                errorKind === "unconfirmed"
                  ? "text-caption-small-strong text-text_default_secondary"
                  : "text-caption-small-strong text-text_status_error"
              }
            >
              {errorKind === "unconfirmed"
                ? t(unconfirmedBannerKey(unconfirmedOutcome))
                : `${t("error.send")}: ${error}`}
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
const SelectPanel = forwardRef<
  HTMLDivElement,
  { testId: string; children: React.ReactNode }
>(function SelectPanel({ testId, children }, ref) {
  return (
    <div
      ref={ref}
      data-testid={testId}
      className="min-w-[160px] rounded-[12px] border border-border_default bg-bg_grouped_secondary_elevated p-1 shadow-[0_0_20px_rgba(10,10,10,0.08)]"
    >
      {children}
    </div>
  );
});

/**
 * M3-B9 — the two engine-backed controls' availability, from the
 * server's capability declaration.
 *
 * Starts as `null` and stays `null` until the probe answers or fails,
 * which is what makes the degradation fail-open: a control is shown until
 * something positively says the engine cannot do it. The probe is a
 * single request shared by both controls (see `readEngineCapabilities`'s
 * module-level cache), and it is never re-run — a provider's declaration
 * does not change while the page is open.
 *
 * `null` and `{available:true}` are deliberately the same rendering
 * decision. There is no intermediate "disabled while loading" state: a
 * control that appears a moment later is worse than one that was always
 * there, because the user can click it in between.
 */
function useEngineControlAvailability(
  configId: "model" | "permissionMode",
): ControlAvailability {
  const [declaration, setDeclaration] = useState<EngineCapabilities>(null);
  useEffect(() => {
    let live = true;
    void readEngineCapabilities().then((caps) => {
      if (live) setDeclaration(caps);
    });
    return () => {
      live = false;
    };
  }, []);
  return useMemo(
    () => bridgedControlAvailability(declaration, configId),
    [declaration, configId],
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

/**
 * Fixed-viewport placement for a fly-out anchored to one row — the surface
 * one tier deeper than the row that opens it.
 *
 * `position: fixed` so the fly-out escapes the model list's
 * `overflow-y: auto`; a descendant would be clipped by it. Anchors to the
 * RIGHT of the row, flips to the left when the right edge would spill past
 * the viewport, and clamps vertically so a fly-out near the bottom edge
 * stays on screen.
 *
 * ONE engine for the picker's cascade — the model→settings fly-out — so
 * that reopening it can never disagree with the previous placement.
 *
 * `deps` is the caller's re-measure trigger (what about the content changed
 * its size). The position is deliberately NOT recomputed on every render:
 * a hover-driven cascade re-renders constantly, and re-measuring then would
 * make the fly-out jitter under a stationary cursor.
 */
function useFlyoutPosition(
  anchorRef: React.RefObject<HTMLElement>,
  menuRef: React.RefObject<HTMLElement>,
  deps: React.DependencyList,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const update = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const gap = 6;
      let left = anchorRect.right + gap;
      if (left + menuRect.width > window.innerWidth - 8) {
        left = anchorRect.left - menuRect.width - gap;
        if (left < 8) left = Math.max(8, window.innerWidth - menuRect.width - 8);
      }
      let top = anchorRect.top;
      if (top + menuRect.height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - menuRect.height - 8);
      }
      if (top < 8) top = 8;
      setPos({ top, left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => update());
      ro.observe(menu);
    }
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (ro) ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return pos;
}

/**
 * One tier of the picker's cascading fly-out.
 *
 * The reference picker is NOT a two-column panel: hovering a model flies
 * out a settings surface one tier deeper than that row. This is that
 * tier's shell — `position: fixed` placement via
 * `useFlyoutPosition`, a `role="menu"`, Escape / ArrowLeft handing focus
 * back to the row that opened it, and the hover grace the parent owns
 * (`onMouseEnter` cancels the close timer so the cursor can cross the gap
 * between a row and its fly-out; `onMouseLeave` restarts it).
 */
function SettingsFlyout({
  testId,
  ariaLabel,
  anchorRef,
  onMouseEnter,
  onMouseLeave,
  onFocusEnter,
  onBack,
  children,
}: {
  testId: string;
  ariaLabel: string;
  anchorRef: React.RefObject<HTMLElement>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Cancel the close grace when focus enters, not just when the cursor
   *  does. The owning row's `onBlur` starts that grace, so without this
   *  a keyboard user tabbing from the row into the fly-out would watch it
   *  retract 120ms after they arrived — the surface would be unreachable
   *  by keyboard while looking perfectly reachable by mouse. */
  onFocusEnter: () => void;
  onBack: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pos = useFlyoutPosition(anchorRef, menuRef, [anchorRef, children]);
  return (
    <div
      ref={menuRef}
      data-testid={testId}
      role="menu"
      aria-label={ariaLabel}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocusEnter}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "ArrowLeft") {
          event.preventDefault();
          onBack();
        }
      }}
      style={
        pos
          ? {
              position: "fixed",
              top: `${pos.top}px`,
              left: `${pos.left}px`,
              zIndex: 1100,
              maxHeight: "calc(100vh - 16px)",
            }
          : {
              // Measured-but-unplaced: mounted (so the rects exist) but
              // not visible, so the first paint is never at 0,0.
              position: "fixed",
              top: 0,
              left: 0,
              opacity: 0,
              pointerEvents: "none",
              zIndex: 1100,
            }
      }
      className="thin-scrollbar min-w-[200px] overflow-y-auto rounded-[12px] border border-border_default bg-bg_grouped_secondary_elevated p-1 shadow-[0_0_20px_rgba(10,10,10,0.08)]"
    >
      {children}
    </div>
  );
}

function ModelSelect({
  t,
  models,
  groups,
  value,
  label,
  sessionKey,
  thinking,
  contextWindow,
  onPick,
  onContextPick,
  onThinkingPick,
  thinkingDisabled,
  onAddProvider,
}: {
  t: (key: MessageKey) => string;
  /** The active session id. The picker's local UI state (open cascade,
   *  previewed row, per-model draft mirror) is session-scoped bookkeeping:
   *  on a session switch it resets, so no session-A menu state visually
   *  persists into session B's view (webui-parity 106, smoke-report P5).
   *  The chip VALUE is not local — it reads the server's state snapshot —
   *  so per-session model truth rides the same SSE path as before. */
  sessionKey: string;
  models: {
    id: string;
    label: string;
    provider?: string;
    modalities?: string[];
    thinkingLevels?: string[];
    contextWindowOptions?: number[];
    contextWindowOptionHints?: Record<string, string>;
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
  /** Currently recorded thinking-effort level (`""` means "engine default").
   *  Used to render the trailing level badge inside the cascade for the
   *  active model — and to detect the "stale suffix" case (model switch
   *  left the level recorded but unsupported by the new model), which
   *  the chip rendering layer hides by not including the suffix at all. */
  thinking: string;
  /** U6 — the context window in tokens the detail area's radio group
   *  highlights (`null` when nothing confirmed it). Derived by the
   *  caller: recorded pick first, the active model's catalogue
   *  `contextLimit` second. */
  contextWindow?: number | null;
  /** Model pick — sends `{model}` only, with a follow-clearing clear of
   *  the recorded effort when the new model doesn't offer it. The
   *  parent decides whether to issue `{model}` or `{model, thinking: ""}`
   *  based on the new model's `thinkingLevels` vs the recorded level. */
  onPick: (id: string) => void;
  /** U6 — context-window radio pick (tokens). The parent sends it
   *  through the same atomic `/api/set-model` endpoint. */
  onContextPick?: (value: number) => void;
  /** Ticket 49 batch 2 (A3) — thinking-level pick from the
   *  cascade-side detail column. Travels the SAME wire path as the
   *  composer-level control (`{thinking: level}`, `""` = engine
   *  default); no new field, no request-body change. */
  onThinkingPick?: (level: string) => void;
  /** Ticket 49 batch 2 — grey the effort control while a turn is
   *  running, mirroring the composer-level control's `disabled`
   *  (a mid-run pick still records for the next turn). */
  thinkingDisabled?: boolean;
  /** Open the provider management flow with a fresh draft already
   *  created. Triggered by the top "Add provider" row. The page owns
   *  the route — the selector just hands the intent up. */
  onAddProvider?: () => void;
}) {
  const [open, setOpen] = useState(false);

  /**
   * The model whose settings fly-out is open.
   *
   * The reference picker does not reserve a column for settings: hovering
   * (or keyboard-focusing) a model row flies the surface out one tier
   * deeper than that row, and moving the cursor away retracts it. `null`
   * is the closed state and is NOT read as "the active model" — no
   * fly-out and the active model's fly-out are different things to render.
   *
   * This one state replaced a separate "focused model" id: the row the
   * cursor is on and the model the settings surface describes were always
   * the same model, and keeping them in two states only created a window
   * where they disagreed.
   */
  const [flyoutFor, setFlyoutFor] = useState<string | null>(null);
  /**
   * Every mounted model row's node, by model id.
   *
   * A map rather than one "current anchor" ref because of render order:
   * a ref is assigned during commit, AFTER the render that reads it, so a
   * render gated on `anchorRef.current` sees the PREVIOUS row's anchor (or
   * null on the first hover) and assigning the ref triggers no re-render —
   * the fly-out would simply never appear. The map is written by every
   * row's ref callback on every commit, so by the time a row can be
   * hovered its node is already in it.
   */
  const flyoutAnchorsRef = useRef(new Map<string, HTMLDivElement>());
  /** Pending close timer for the fly-out. Set when the cursor leaves
   *  the row, so a brief traversal from the row into its fly-out does not
   *  retract the surface. */
  const flyoutCloseTimerRef = useRef<number | null>(null);

  const cancelFlyoutClose = useCallback(() => {
    if (flyoutCloseTimerRef.current != null) {
      window.clearTimeout(flyoutCloseTimerRef.current);
      flyoutCloseTimerRef.current = null;
    }
  }, []);

  const scheduleFlyoutClose = useCallback(() => {
    cancelFlyoutClose();
    flyoutCloseTimerRef.current = window.setTimeout(() => {
      setFlyoutFor(null);
      flyoutCloseTimerRef.current = null;
    }, 120);
  }, [cancelFlyoutClose]);

  // A grace timer outliving the surface it protects is a timer that fires
  // into a closed picker, so retract it on unmount and whenever the
  // dropdown itself goes away.
  useEffect(() => {
    if (!open) cancelFlyoutClose();
  }, [open, cancelFlyoutClose]);
  useEffect(() => cancelFlyoutClose, [cancelFlyoutClose]);

  /**
   * Ticket 49 batch 2 (A7) — draft mirror, keyed by model id.
   *
   * A pick inside the picker commits immediately (the wire path is
   * unchanged) AND lands here, so the control's highlighted value
   * comes from the local mirror while the picker is open — a
   * catalogue refresh (`models` re-fetch) or the request round-trip
   * cannot make the highlight blink back to the stale prop. Closing
   * the dropdown clears the map, so reopening always starts from the
   * persisted state the server reported (same lifecycle as the
   * reference picker's `drafts`).
   */
  const [drafts, setDrafts] = useState<
    Record<string, { thinking?: string; contextWindow?: number }>
  >({});
  // webui-parity 106 — the two local states above belong to ONE session's
  // picker interaction. A session switch that arrived while a preview row
  // was focused used to carry both of them into the next session's view —
  // and the draft mirror is the one that matters: a window or level the
  // user half-adjusted in session A must not be showing as pending in
  // session B. The reset is a no-op while the session is stable; the
  // effect only fires on a real key change.
  useEffect(() => {
    setOpen(false);
    setFlyoutFor(null);
    setDrafts({});
  }, [sessionKey]);
  /** Ref to the inner scrollable list. */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  /** Ref to the ACTIVE MODEL's row, so the scroll-into-view effect has a
   *  stable target that is not re-queried on every render. */
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  /** Ref to the dropdown panel — the trigger's arrow-key handler
   *  focuses its first (or last) focusable row after opening. */
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Group by provider, preserving the catalogue order. A provider-less entry
  // (engine-encoded ids whose prefix wasn't coerced) falls into "Other" so it
  // is still reachable from the menu. The /api/models groups[] carries the
  // server-resolved label + auth view; `groupModelsByProvider` (lib/model-groups)
  // merges it into the in-component shape.
  const grouped = useMemo(
    () => groupModelsByProvider(models, groups, t("modelSelector.other")),
    [models, groups, t],
  );

  // The provider id of the active model — `__other` for ungrouped
  // entries. Drives the ✓ marker on provider rows and the scroll-
  // into-view target.
  const activeProviderId = useMemo(
    () => providerIdOfModel(models, value),
    [models, value],
  );

  /**
   * Ticket 49 — the model the settings FLY-OUT describes.
   *
   * A2: preview any model's adjustable settings without picking it — the
   * hovered row wins. There is deliberately NO fallback to the active
   * model: this is a fly-out anchored to a row, so with no row hovered
   * there is no surface at all. (The old permanent right column had to
   * fall back to the active model, because the column was always there;
   * a fly-out has no such obligation.)
   *
   * An id that fell out of the catalogue (mid-refresh) resolves to `null`
   * rather than rendering settings for a ghost row.
   */
  const detailTarget = useMemo(() => {
    if (flyoutFor == null) return null;
    return models.find((m) => m.id === flyoutFor) ?? null;
  }, [models, flyoutFor]);

  /**
   * Whether a model has anything to configure at all — the gate for
   * whether it gets a fly-out, and the whole of the reference's
   * "没有二次菜单的，则直接点击后就完成" rule.
   *
   * A model with neither a thinking level nor a real context choice has
   * no settings to fly out, so hovering it shows nothing and clicking it
   * is the whole selection. Rendering a fly-out for it would be an empty
   * panel over a row that could have been picked outright.
   *
   * `contextWindowOptions` is normalised before counting, and the
   * >= 2 threshold matches `ModelSettingsDetail`'s mount gate: a
   * single-option "choice" is a no-op, not a menu.
   */
  const modelHasSettings = useCallback(
    (model: { thinkingLevels?: string[]; contextWindowOptions?: unknown }) => {
      if ((model.thinkingLevels ?? []).length > 0) return true;
      return normalizeContextWindowOptions(model.contextWindowOptions).length >= 2;
    },
    [],
  );

  /** Ticket 49 — the fly-out describes a model the user has NOT picked
   *  yet. Its controls render as a read-only preview: no recorded pick is
   *  highlighted (the record belongs to the active model) and the groups
   *  are disabled — committing a setting for a non-active model has no
   *  wire meaning under the current `/api/set-model` contract, which this
   *  change must not touch. */
  const isDetailPreview = detailTarget != null && detailTarget.id !== value;

  /**
   * The node the open fly-out anchors to, resolved from the row map.
   *
   * Wrapped in a fresh object so `SettingsFlyout`'s layout effect sees a
   * new identity when the anchor MOVES (hovering a different row) and
   * re-measures. `null` before the row is registered — the fly-out then
   * stays in its measured-but-unplaced state instead of jumping to 0,0.
   */
  const flyoutAnchor = useMemo<React.RefObject<HTMLElement>>(
    () => ({
      current: detailTarget ? (flyoutAnchorsRef.current.get(detailTarget.id) ?? null) : null,
    }),
    [detailTarget],
  );

  /**
   * The active model — the bottom detail area's constant target
   * (U6/B9: the panel-bottom area shows the ACTIVE model's settings,
   * whether or not a cascade is open). `null` when the catalogue
   * carries no active entry.
   */
  const activeModel = useMemo(() => models.find((m) => m.id === value) ?? null, [models, value]);

  /**
   * Ticket 49 batch 2 (A7) — the values the settings controls
   * highlight. The draft mirror wins over the reported props while
   * the picker is open, so a just-made pick is what the user sees
   * even before the server round-trip (or a catalogue refresh)
   * lands. `contextWindow`'s `null` means "nothing confirmed it" —
   * the draft's `undefined` must not clobber that distinction, hence
   * the explicit key reads.
   */
  const activeDraft = value != null ? drafts[value] : undefined;
  const activeThinking = activeDraft?.thinking ?? thinking;
  const activeContextWindow =
    activeDraft?.contextWindow !== undefined ? activeDraft.contextWindow : contextWindow;

  /**
   * The fly-out's setting picks. Only the active model's controls are
   * interactive (a preview is disabled at the render layer; the guard
   * here is defence in depth), so every live pick records its draft under
   * the active id and hands the wire decision to the parent — the SAME
   * `{thinking}` / `{model, contextWindow}` payloads the composer-level
   * controls send. No request body changes.
   *
   * The two controls close differently, and that asymmetry IS the
   * reference's completion rule ("有二级菜单的，点击二级菜单后才是整个
   * 选择逻辑完成"):
   *
   *   - the thinking switch records and leaves the fly-out open — a level
   *     and a context window are meant to be adjusted in one visit;
   *   - a context window is a commitment, so that pick is where the whole
   *     selection completes and the menu closes.
   */
  const handleDetailThinkingPick = useCallback(
    (level: string) => {
      if (value == null) return;
      setDrafts((prev) => ({ ...prev, [value]: { ...prev[value], thinking: level } }));
      onThinkingPick?.(level);
    },
    [value, onThinkingPick],
  );
  const handleDetailContextPick = useCallback(
    (windowValue: number) => {
      if (value == null) return;
      setDrafts((prev) => ({
        ...prev,
        [value]: { ...prev[value], contextWindow: windowValue },
      }));
      onContextPick?.(windowValue);
      // Choosing a window is where the selection completes.
      setFlyoutFor(null);
      setOpen(false);
    },
    [value, onContextPick],
  );

  // Ticket 49 batch 2 (A7): closing the picker drops the draft
  // mirror — reopening starts from the persisted state.
  useEffect(() => {
    if (!open) setDrafts({});
  }, [open]);

  // NB: the active model changing does NOT retract the fly-out. Picking a
  // model row is the step that makes its fly-out LIVE (it leaves preview
  // and becomes the recorded model), so clearing the fly-out on `value`
  // would close the surface between the pick and the window pick
  // that completes the selection — the exact flow the reference has.

  /**
   * Move between model rows with the arrow keys.
   *
   * The cascade used to own this: the fly-out had its own engine, and
   * the trigger's ArrowDown only ever reached the first provider row.
   * Now that the list is flat, the engine belongs HERE — otherwise
   * removing the cascade would quietly remove keyboard-only reachability
   * with it, which is a red line rather than a nicety.
   *
   * `Home`/`End` jump to the ends for the same reason the cascade had
   * them: a long catalogue makes walking row by row the only way to
   * reach the far end.
   */
  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const list = listScrollRef.current;
      if (!list) return;
      // Escape on the list retracts the fly-out one tier before it lets
      // antd close the whole dropdown — inside a cascade, the first Escape
      // backs out of the current tier, the second closes.
      if (event.key === "Escape") {
        if (flyoutFor != null) {
          event.preventDefault();
          event.stopPropagation();
          cancelFlyoutClose();
          setFlyoutFor(null);
        }
        return;
      }
      const delta =
        event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      const jump = event.key === "Home" ? "first" : event.key === "End" ? "last" : null;
      if (delta === 0 && !jump) return;
      const rows = Array.from(
        list.querySelectorAll<HTMLElement>(
          '[data-testid^="model-select-model-option-"]:not([disabled])',
        ),
      );
      if (rows.length === 0) return;
      event.preventDefault();
      if (jump === "first") {
        rows[0]?.focus();
        return;
      }
      if (jump === "last") {
        rows[rows.length - 1]?.focus();
        return;
      }
      const current = rows.indexOf(document.activeElement as HTMLElement);
      const base = current >= 0 ? current : 0;
      rows[((base + delta) % rows.length + rows.length) % rows.length]?.focus();
    },
    [flyoutFor, cancelFlyoutClose],
  );

  /**
   * Scroll the active model row into view when the dropdown opens.
   *
   * The list caps at ~60vh (see `max-h-[60vh]` below), so a long
   * catalogue puts the active provider's row out of frame. A
   * `requestAnimationFrame` deferral keeps the effect from racing the
   * dropdown's portal mount — `selectedRowRef.current` is null until
   * the layout effect has run.
   *
   * `prefers-reduced-motion` skips the smooth scroll: the user opted
   * out of animation, so the scroll snaps instead.
   */
  useEffect(() => {
    if (!open) return;
    if (!listScrollRef.current || !selectedRowRef.current) return;
    const container = listScrollRef.current;
    const row = selectedRowRef.current;
    const handleId = window.requestAnimationFrame(() => {
      const rowTop = row.offsetTop;
      const rowBottom = rowTop + row.offsetHeight;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;
      if (rowTop < viewTop) {
        container.scrollTo({
          top: rowTop - 8,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      } else if (rowBottom > viewBottom) {
        container.scrollTo({
          top: rowBottom - container.clientHeight + 8,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      }
    });
    return () => window.cancelAnimationFrame(handleId);
  }, [open, activeProviderId]);

  return (
    <Dropdown
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing retracts the cascade with the panel — a fly-out anchored
        // to a row that is no longer rendered has nothing to anchor to.
        if (!next) {
          setFlyoutFor(null);
          cancelFlyoutClose();
        }
      }}
      trigger={["click"]}
      placement="bottomRight"
      overlayClassName="mavis-dropdown mavis-dropdown-compact mavis-dropdown-custom-content"
      popupRender={() => (
        <SelectPanel ref={panelRef} testId="model-select-panel">
          {/*
            The list is the whole popup. The reference picker reserves no
            width for settings — they fly out beside the hovered row — so
            a panel with a settings column in it is the shape the
            reference does NOT have. That shape was tried here and
            reverted; the tripwires in model-picker-layout.test.ts fail
            if its class name ever reappears here, comments included.
            The left column's provider GROUPING is the reference's own
            shape, not an exception to it.
          */}
          {models.length === 0 ? (
            <SelectRow testId="model-select-empty" label={t("composer.noModels")} />
          ) : (
            <div className="flex flex-col" data-webui-model-menu="true">
              {/* Top "Add provider" affordance (ticket 09). One-click
                  jump to the management panel's add flow. */}
              {onAddProvider ? (
                <button
                  type="button"
                  data-testid="model-select-add-provider"
                  onClick={() => {
                    setOpen(false);
                    onAddProvider();
                  }}
                  className="mx-1 mt-0.5 flex h-7 items-center gap-1.5 rounded-[8px] border border-dashed border-border_default px-2 text-caption-small-strong text-text_default_secondary transition-colors hover:border-border_heavy hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary"
                >
                  <Icon name="plusSmall" size={14} className="text-icon_default_secondary" />
                  <span>{t("modelSelector.addProvider")}</span>
                </button>
              ) : null}
              {/*
                The list, in the reference's own shape: a provider group
                header, and under it one row per MODEL. Every name in the
                catalogue is readable without a second click, and there is
                only one navigation model for one list.

                A model row is also the fly-out's anchor: hovering or
                keyboard-focusing it points `flyoutFor` at that model, and
                the fly-out describes it.

                `disabled` is the GROUP's no-key verdict, applied to every
                row under it: a provider without an API key cannot reach
                any of its models, and greying them one by one is the
                honest rendering of that. The header carries the reason.
              */}
              <div
                ref={listScrollRef}
                data-testid="model-select-list"
                data-webui-model-menu-list="true"
                onKeyDown={handleListKeyDown}
                className="thin-scrollbar max-h-[60vh] w-60 overflow-y-auto"
              >
                {grouped.map((group, groupIndex) => {
                const disabled = isGroupDisabled(group);
                return (
                  <div
                    key={group.id}
                    data-testid={`model-select-group-${group.id}`}
                    data-disabled={disabled ? "true" : "false"}
                    className={groupIndex === 0 ? "" : "mt-1 border-t border-border_default pt-1"}
                  >
                    {/*
                      Group header — the provider label, with the
                      "no key" hint for a provider whose models are all
                      disabled below. Sticky, so the group a model sits
                      in stays visible while the list scrolls.
                    */}
                    <div
                      data-testid={`model-select-group-label-${group.id}`}
                      className="sticky top-0 z-10 flex items-center justify-between bg-bg_grouped_secondary_elevated px-2 pb-0.5 pt-1 text-caption-small-strong uppercase tracking-wide text-text_default_tertiary"
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
                    {group.models.map((model) => {
                      const isActiveModel = model.id === value;
                      const supported = model.thinkingLevels ?? [];
                      const hasSettings = modelHasSettings(model);
                      return (
                        <div
                          key={model.id}
                          ref={(node) => {
                            if (isActiveModel) selectedRowRef.current = node;
                            if (node) flyoutAnchorsRef.current.set(model.id, node);
                            else flyoutAnchorsRef.current.delete(model.id);
                          }}
                          data-testid={`model-select-model-wrap-${modelSlug(model.id)}`}
                          data-active-model={isActiveModel ? "true" : "false"}
                          data-has-settings={hasSettings ? "true" : "false"}
                          className="rounded-[8px]"
                        >
                          <SelectRow
                            testId={`model-select-model-option-${modelSlug(model.id)}`}
                            label={modelDisplayName(model.label)}
                            selected={isActiveModel}
                            disabled={disabled}
                            rightAdornment={
                              <>
                                {model.modalities && model.modalities.length > 0 ? (
                                  <ModalityBadges t={t} modalities={model.modalities} />
                                ) : null}
                                {isActiveModel &&
                                thinking &&
                                supported.includes(thinking) ? (
                                  <span
                                    data-testid={`model-select-row-level-badge-${modelSlug(model.id)}`}
                                    className="rounded-md border border-border_default px-1 py-0.5 text-[10px] uppercase tracking-wide text-text_default_tertiary"
                                  >
                                    {thinkingLevelLabel(t, thinking)}
                                  </span>
                                ) : null}
                              </>
                            }
                            onMouseEnter={() => {
                              if (disabled) return;
                              cancelFlyoutClose();
                              // A model with nothing to configure never
                              // grows a fly-out — its click IS the whole
                              // selection.
                              if (hasSettings) setFlyoutFor(model.id);
                            }}
                            onMouseLeave={() => {
                              if (disabled) return;
                              scheduleFlyoutClose();
                            }}
                            onFocus={() => {
                              // Keyboard reaches the same surface as the
                              // cursor: the arrow engine focuses a row, and
                              // a fly-out that only answered the mouse
                              // would leave a keyboard user unable to
                              // configure anything.
                              if (disabled || !hasSettings) return;
                              cancelFlyoutClose();
                              setFlyoutFor(model.id);
                            }}
                            onBlur={scheduleFlyoutClose}
                            onClick={() => {
                              if (disabled) return;
                              // The wire path is unchanged: the model id
                              // travels alone, and the parent decides
                              // whether the recorded effort has to be
                              // cleared with it (the new model may not
                              // offer the level that was recorded).
                              onPick(model.id);
                              if (hasSettings) {
                                // Not complete yet: the pick makes this
                                // model's fly-out live instead of a preview,
                                // and the selection finishes on a window
                                // pick — or simply by leaving this row, for
                                // a model that only has the thinking switch.
                                cancelFlyoutClose();
                                setFlyoutFor(model.id);
                                return;
                              }
                              // Nothing to configure → the click is the whole
                              // selection, so the picker closes on it.
                              setFlyoutFor(null);
                              setOpen(false);
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
                })}
              </div>
                {/*
                  The cascade's FLY-OUT: the hovered (or focused)
                  model's settings, flying out one tier deeper than the
                  row that owns it. Not a column — the reference reserves
                  no width for settings, and a permanent column is what
                  turned this into "one popup showing two models' worth
                  of controls" when a row that could have been picked
                  outright was sitting next to it.

                  Rendered inside the panel so the portal-less
                  `position: fixed` still escapes the list's own
                  `overflow-y: auto`, and so it unmounts with the panel.
                */}
                {detailTarget ? (
                  <SettingsFlyout
                    testId="model-settings-flyout"
                    ariaLabel={t("modelSelector.thinkingLevels")}
                    anchorRef={flyoutAnchor}
                    onMouseEnter={cancelFlyoutClose}
                    onFocusEnter={cancelFlyoutClose}
                    onMouseLeave={scheduleFlyoutClose}
                    onBack={() => setFlyoutFor(null)}
                  >
                    <ModelSettingsDetail
                      t={t}
                      containerTestId="model-settings-detail"
                      detailPrefix="model-settings"
                      contextPrefix="model-settings-context"
                      target={detailTarget}
                      preview={isDetailPreview}
                      thinking={activeThinking}
                      contextWindow={activeContextWindow}
                      thinkingDisabled={thinkingDisabled}
                      onThinkingPick={handleDetailThinkingPick}
                      onContextPick={handleDetailContextPick}
                    />
                  </SettingsFlyout>
                ) : null}
              </div>
          )}
        </SelectPanel>
      )}
    >
      <button
        type="button"
        data-testid="model-selector-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onKeyDown={(event) => {
          // Ticket 49 batch 2 (QA item ④) — arrow keys on the CLOSED
          // picker open it and move focus into the panel, so the whole
          // cascade flow is reachable without a pointer. ArrowDown /
          // ArrowRight land on the first focusable row, ArrowUp on the
          // last. The panel's own keyboard engine takes over from
          // there (provider rows: ArrowRight opens the cascade; rows
          // inside the cascade: ArrowUp/Down cycle, Home/End jump,
          // ArrowLeft returns). antd's Dropdown handles only click /
          // Enter / Space on the trigger — the arrows are ours.
          if (
            event.key !== "ArrowDown" &&
            event.key !== "ArrowUp" &&
            event.key !== "ArrowRight"
          ) {
            return;
          }
          if (models.length === 0) return;
          event.preventDefault();
          if (!open) setOpen(true);
          requestAnimationFrame(() => {
            const rows = panelRef.current?.querySelectorAll<HTMLElement>(
              '[data-testid^="model-select-model-option-"]:not([disabled])',
            );
            if (!rows || rows.length === 0) return;
            (event.key === "ArrowUp" ? rows[rows.length - 1]! : rows[0]!).focus();
          });
        }}
        className="flex h-8 min-w-0 items-center gap-1 rounded-[10px] pl-2.5 pr-2 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
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
 * Ticket 49 batch 2 (A1) — the settings detail content shared by both
 * placements. The A3 shape decisions (`effortControlShape` /
 * `effortOptionsWithDefault` / `resolveEffortCurrent`) and the trigger's
 * on/off reading (`isThinkingOn`) live in
 * `@/lib/effort-control` so the test suite exercises the product
 * functions, not a mirror.
 *
 * Two instances render at once, each with its own aria-live region and
 * its own testid family (no duplicate ids in the DOM):
 *
 *   - the panel-bottom area (U6/B9 placement, `model-select-detail-*`
 *     + `model-context-*`): describes the ACTIVE model, level display
 *     is the read-only badges batch 1 shipped;
 *   - the cascade side column (`model-cascade-detail-*` +
 *     `model-cascade-context-*`): describes `detailTarget` (follows
 *     the focused row), and the level display is the ADAPTIVE control
 *     (A3: radio group or switch), so a pick can be made without
 *     closing the menu (A4).
 *
 * Both read the same draft mirror through their props, so a pick made
 * in either place highlights in both (A7).
 *
 * The three render branches:
 *   - no target → the "select a model" hint;
 *   - target with neither context options (>= 2) nor thinking levels
 *     → the per-model hint, WITH the model name — QA item ②: the
 *     container is an aria-live region, and announcing only "no
 *     adjustable settings" would leave a screen-reader user asking
 *     WHICH model the sentence is about;
 *   - otherwise the model name (+ "preview" marker when the target is
 *     not the active model), the level display, and the context-window
 *     radio group.
 */
function ModelSettingsDetail({
  t,
  containerTestId,
  detailPrefix,
  contextPrefix,
  className,
  target,
  preview,
  thinking,
  contextWindow,
  thinkingDisabled,
  onThinkingPick,
  onContextPick,
}: {
  t: (key: MessageKey) => string;
  /** The outer container's testid — distinct per placement. */
  containerTestId: string;
  /** `model-select-detail` (bottom) / `model-cascade-detail` (side). */
  detailPrefix: string;
  /** `model-context` (bottom) / `model-cascade-context` (side). */
  contextPrefix: string;
  /** Placement chrome (the bottom area carries its own border/padding). */
  className?: string;
  target: {
    id: string;
    label: string;
    thinkingLevels?: string[];
    contextWindowOptions?: number[];
    contextWindowOptionHints?: Record<string, string>;
  } | null;
  /** True when the target is NOT the active model: controls disable,
   *  nothing records-backed is highlighted (A2 preview semantics). */
  preview: boolean;
  /** The draft-mirror-resolved recorded level (`""` = engine default). */
  thinking: string;
  /** The draft-mirror-resolved recorded window (tokens; `null`/`undefined`
   *  = nothing confirmed). */
  contextWindow?: number | null;
  thinkingDisabled?: boolean;
  onThinkingPick?: (level: string) => void;
  onContextPick?: (value: number) => void;
}) {
  const levels = target?.thinkingLevels ?? [];
  // U6 mount gate: >= 2 normalised options (a single-option "choice"
  // is a no-op), same normalisation the engine's own picker applies.
  const contextOptions = normalizeContextWindowOptions(target?.contextWindowOptions);
  const contextReady = contextOptions.length >= 2;
  const contextHints = target?.contextWindowOptionHints;
  // Stale-pick rule (U6): the radio claims only windows the target
  // model advertises — and a previewed model highlights nothing.
  const contextCurrent =
    !preview && typeof contextWindow === "number" && contextOptions.includes(contextWindow)
      ? contextWindow
      : null;
  // A3: the shape/options/current decisions come from
  // @/lib/effort-control (product functions, test-imported).
  const effortShape = effortControlShape(levels);
  const effortOptions = effortShape === "radiogroup" ? effortOptionsWithDefault(levels) : [];
  const effortCurrent = resolveEffortCurrent(levels, thinking, preview);

  return (
    <div data-testid={containerTestId} aria-live="polite" className={className}>
      {!target ? (
        <div
          data-testid={`${detailPrefix}-empty`}
          className="px-1 py-1 text-caption-small text-text_default_tertiary"
        >
          {t("modelSelector.detailEmpty")}
        </div>
      ) : !contextReady && levels.length === 0 ? (
        <div data-testid={`${detailPrefix}-no-settings`} className="px-1 py-1">
          <div className="truncate text-caption-small-strong text-text_default_secondary">
            {modelDisplayName(target.label) || target.id}
          </div>
          <div className="text-caption-small text-text_default_tertiary">
            {t("modelSelector.detailNoSettings")}
          </div>
        </div>
      ) : (
        <>
          {/*
            The reference's fly-out body: NO model name header. The fly-out
            is anchored to the row it describes and that row already carries
            the ✓, so naming the model again is a second answer to a
            question the list just answered.

            Two rows, in the reference's order: 思考 with its control on the
            right of the label, then 上下文窗口 with its sizes listed
            straight below, marked where you are.
          */}
          {levels.length > 0 ? (
            <div data-testid={`${detailPrefix}-levels`} className="px-1 pb-1">
              <div className="flex items-center gap-2 px-0.5 py-0.5">
                <span className="min-w-0 flex-1 text-caption-small text-text_default_secondary">
                  {t("modelSelector.thinkingLevels")}
                </span>
                {effortShape === "switch" ? (
                  /* A3 binary form: the off/on pair renders as one
                   * switch. No `default` entry here — the reference
                   * treats switchable thinking as pure on/off; the
                   * engine-default reset stays reachable through the
                   * composer-level control's "Default" row
                   * and the radio group's `default` option elsewhere.
                   *
                   * The app's own `webui-toggle-switch`, not a
                   * hand-rolled pill: the reference draws this switch
                   * BLUE when on, and a hand-rolled one composed of
                   * border/background tokens can only ever reach the
                   * greys in the palette. The real class is also what
                   * the settings modal renders, so the two switches in
                   * the product cannot drift apart. */
                  <button
                    type="button"
                    role="switch"
                    aria-checked={effortCurrent === "on"}
                    aria-label={t("modelSelector.thinkingLevels")}
                    disabled={preview || thinkingDisabled}
                    title={preview ? t("modelSelector.detailPreviewHint") : undefined}
                    data-testid={`${detailPrefix}-level-switch`}
                    onClick={() => {
                      onThinkingPick?.(effortCurrent === "on" ? "off" : "on");
                    }}
                    className={`webui-toggle-switch${effortCurrent === "on" ? " is-checked" : ""}`}
                  >
                    <span aria-hidden="true" />
                  </button>
                ) : (
                  /* The reference's level scale: one pickable ROW per
                   * level, `default` first (submitted as `""`). Still a
                   * `radiogroup` of `radio`s — a single-select from a set
                   * of options is exactly that, and changing the semantics
                   * to look more like the reference would cost the
                   * screen-reader contract for nothing.
                   *
                   * A pick records immediately and does NOT close the
                   * menu: a level is a mid-visit edit, so the visit
                   * continues into the window list below. */
                  <div
                    role="radiogroup"
                    aria-label={t("modelSelector.thinkingLevels")}
                    data-testid={`${detailPrefix}-level-list`}
                    className="flex flex-col"
                  >
                    {effortOptions.map((option) => {
                      const active = effortCurrent === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={preview || thinkingDisabled}
                          title={preview ? t("modelSelector.detailPreviewHint") : undefined}
                          data-testid={`${detailPrefix}-level-option-${option}`}
                          onClick={() => {
                            onThinkingPick?.(option === "default" ? "" : option);
                          }}
                          className={[
                            "flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-left text-caption-small transition-colors",
                            active
                              ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
                              : "text-text_default_secondary",
                            preview || thinkingDisabled
                              ? "cursor-not-allowed"
                              : "hover:bg-bg_interaction_tertiary_hover",
                          ].join(" ")}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {option === "default"
                              ? t("thinkingPicker.none")
                              : thinkingLevelLabel(t, option)}
                          </span>
                          {active ? (
                            <Icon
                              name="checkSmall"
                              size={14}
                              aria-hidden="true"
                              className="text-text_default_primary"
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
          {contextReady ? (
            <div className="px-1">
              <div className="pb-0.5 text-caption-small-strong uppercase tracking-wide text-text_default_tertiary">
                {t("modelSelector.contextWindow")}
              </div>
              <ContextWindowSelect
                t={t}
                testIdPrefix={contextPrefix}
                options={contextOptions}
                hints={contextHints}
                current={contextCurrent}
                disabled={preview}
                onContextPick={onContextPick}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * True when the user has requested reduced motion in the OS settings.
 *
 * The selector uses this to swap `behavior: "smooth"` scroll calls for
 * `behavior: "auto"` — a smooth-scroll into view is a nice touch on
 * most systems, but on a long catalogue the animation is the slowest
 * part of the open transition. `prefers-reduced-motion: reduce` should
 * snap the scroll instead, matching every other animation in the app.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
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
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}: {
  testId: string;
  icon?: IconName;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  rightAdornment?: React.ReactNode;
  onClick?: () => void;
  /** Report this row as the settings fly-out's owner. Both a mouse and
   *  the keyboard count — the arrow-key engine moves focus, and a
   *  fly-out that only answered the mouse would leave a keyboard user
   *  unable to configure anything. */
  onMouseEnter?: () => void;
  /** Start the fly-out's close grace. Paired with `onMouseEnter` (and
   *  `onFocus`) so crossing the gap between a row and its fly-out does
   *  not retract the surface. */
  onMouseLeave?: () => void;
  onFocus?: () => void;
  /** The keyboard equivalent of leaving the row: focus moving on is the
   *  same event as the cursor moving away, and without it a fly-out
   *  would outlive the row it is anchored to. */
  onBlur?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
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
 * Thinking-effort picker.
 *
 * Same shell and panel as the other selectors. The trigger is the
 * active level ("High" / "Medium" / …) or "Default" when
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
  /**
   * Blue brain = thinking on, grey = off or unstated. `null` (the engine
   * owns the default and never reports the level it chose) is deliberately
   * grey: the label is what says "Default", and a blue icon beside it would
   * claim a state this process cannot see.
   */
  const thinkingOn = isThinkingOn(levels, value);
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
        data-thinking={thinkingOn === null ? "unknown" : thinkingOn ? "on" : "off"}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={[
          "flex h-8 min-w-0 items-center gap-1.5 rounded-[10px] px-2 text-sm transition-colors",
          disabled
            ? "cursor-not-allowed text-text_default_tertiary"
            : "hover:bg-bg_interaction_tertiary_hover",
        ].join(" ")}
      >
        {/* The chevron stays tertiary in every state: it is the affordance,
            not the state. Colour belongs to the brain and the level. */}
        <Icon
          name="brain"
          size={16}
          className={
            disabled
              ? "text-text_default_tertiary"
              : thinkingOn
                ? "text-icon_default_accent"
                : "text-text_default_secondary"
          }
        />
        <span
          className={[
            "max-w-[80px] truncate whitespace-nowrap",
            disabled
              ? "text-text_default_tertiary"
              : thinkingOn
                ? "text-text_default_accent"
                : "text-text_default_primary",
          ].join(" ")}
        >
          {currentLabel}
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
 * Normalise a model's `contextWindowOptions` (U6).
 *
 * Set-deduped, safe positive integers only, engine order preserved —
 * the same normalisation the engine's own pickers apply
 * (packages/tui `contextWindowOptions()`, reference webui
 * `ModelPicker.tsx`). Payload defensive read: the field is optional
 * and engine-sourced, so `undefined` / wrong shapes collapse to `[]`.
 */
function normalizeContextWindowOptions(options: unknown): number[] {
  if (!Array.isArray(options)) return [];
  return [...new Set(options.filter((v) => Number.isSafeInteger(v) && v > 0))];
}

/**
 * The context-window list, in place inside the settings fly-out.
 *
 * Its own component so the fly-out's body has a home; there is no local
 * open state to own any more, because the options are always shown (see
 * below). Before that, the collapsed row's open state was the one piece
 * of this fly-out that changed without the model changing, which is why
 * it never got hoisted into the parent.
 */
function ContextWindowSelect({
  t,
  testIdPrefix,
  options,
  hints,
  current,
  disabled,
  onContextPick,
}: {
  t: (key: MessageKey) => string;
  testIdPrefix: string;
  options: number[];
  hints?: Record<string, string>;
  /** The value that carries the ✓ — `null` in preview, by design. */
  current: number | null;
  disabled?: boolean;
  onContextPick?: (value: number) => void;
}) {
  /**
   * The context window, as a list of the sizes the model offers.
   *
   * NOT a collapsed row that opens a third tier. Every step of that
   * nesting was one affordance too many: the fly-out already says which
   * model it describes, so a row restating the current value, an arrow
   * over it, and then a separate panel carrying the same values are
   * three ways to answer one question — and the third of them was a
   * floating panel landing back over the model list it was describing.
   *
   * The list IS the answer. The current size carries the ✓, the same
   * marker every other picker in this app uses, and a previewed model
   * (not the active one) carries none — the record belongs to the active
   * model, so there is nothing to mark. `role=listbox` / `role=option` /
   * `aria-selected` is unchanged from when this list was in place.
   */
  return (
    <div data-testid={`${testIdPrefix}-select`}>
      <div
        role="listbox"
        aria-label={t("modelSelector.contextWindow")}
        data-testid={`${testIdPrefix}-select-list`}
        className="flex flex-col"
      >
        {options.map((windowValue) => {
          const active = current === windowValue;
          const higherUsage = hints?.[String(windowValue)] === "higher_usage";
          return (
            <button
              key={windowValue}
              type="button"
              role="option"
              aria-selected={active}
              disabled={disabled}
              title={disabled ? t("modelSelector.detailPreviewHint") : undefined}
              data-testid={`${testIdPrefix}-option-${windowValue}`}
              onClick={() => {
                onContextPick?.(windowValue);
              }}
              className={[
                "flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-left text-caption-small transition-colors",
                active
                  ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
                  : "text-text_default_secondary",
                disabled ? "cursor-not-allowed opacity-60" : "hover:bg-bg_interaction_tertiary_hover",
              ].join(" ")}
            >
              <span className="min-w-0 flex-1 truncate">
                {formatContextWindow(windowValue)}
              </span>
              {higherUsage ? (
                <span
                  data-testid={`${testIdPrefix}-hint-higher-usage`}
                  className="shrink-0 text-text_default_tertiary"
                >
                  {t("modelSelector.contextWindowHigherUsage")}
                </span>
              ) : null}
              {active ? (
                <Icon
                  name="checkSmall"
                  size={14}
                  aria-hidden="true"
                  className="text-text_default_primary"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Token count → compact context-window label (U6).
 *
 * Mirrors the reference implementation (`ModelPicker.tsx`
 * `formatContextWindow`): `1000000` → `1M`, `512000` → `512K`, anything
 * below a thousand verbatim. The exact powers of ten the engine's
 * catalogue uses all land on clean labels.
 */
function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
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
