// webapp/lib/settings-local.ts
//
// Browser-local settings values for the settings page's General section
// (webui-parity 48).
//
// The desktop reference stores its general-page preferences as bare
// `localStorage` string entries (`SettingsModal.tsx` reads them through a
// tiny `stored(key, fallback)` helper). This module keeps the same key
// names and the same "plain string, not JSON" wire format so a browser
// profile carries the same preferences in both clients, and so the
// persistence-keys table in `docs/webui.md` can list one key per row
// without a webui-specific alias.
//
// Defaults:
//
//   - `file_line_wrap` defaults to `"true"` — the reference's default.
//   - `webui-context-window-usage` defaults to `"false"` — same.
//   - `webui-follow-up-behavior` defaults to `"queue"` — same.
//   - `file_open_in_new_tab` defaults to `"true"`, NOT the reference's
//     `"false"`. The webui's workspace tab strip has no "pinned" concept
//     (see `lib/workspace-tabs-state.ts`), and its standing behaviour has
//     been "one tab per file" since slice 15. Shipping the reference's
//     default would flip that behaviour for every existing user on
//     upgrade, so the switch describes the webui's current behaviour
//     (`true`) and opting into reuse is a deliberate act. The reuse
//     semantics also differ — documented in `docs/webui.md`.
//
// Every reader is total: missing key, corrupted value, or no `window`
// (SSR pass) all fall back to the default rather than throwing, matching
// `lib/persist.ts`'s best-effort contract.

/**
 * The follow-up message behaviour stored under `webui-follow-up-behavior`.
 *
 * SB-4 adds a third member the desktop reference does not have. The
 * reference's radio is two-valued (`queue` / `steer`) because the desktop
 * can always do both — its composer owns the running turn, so neither
 * option can fail. webui can: the running turn may belong to an engine
 * process that has no queue (see `server/engine/follow-up.js`), and until
 * this batch the composer refused every send while a turn ran. A switch
 * with no OFF is not a switch, it is a behaviour change, so `"off"` is
 * the value that keeps webui's standing behaviour: the send control stays
 * replaced by Stop until the turn ends.
 *
 * The stored format is unchanged — still the bare string the reference
 * reads, still written by the same `commitFollowUpBehavior`.
 */
export type FollowUpBehavior = "off" | "queue" | "steer";

export const FILE_OPEN_IN_NEW_TAB_KEY = "file_open_in_new_tab";
export const FILE_LINE_WRAP_KEY = "file_line_wrap";
export const CONTEXT_WINDOW_USAGE_KEY = "webui-context-window-usage";
export const FOLLOW_UP_BEHAVIOR_KEY = "webui-follow-up-behavior";
// Ticket 55a — the three long-text preferences the desktop stores on its
// Personalization / Code review pages. Unlike the four keys above, the
// desktop's own storage key names for these are NOT part of the observed
// reference (settings-local's desktop-shared keys came from the reference's
// `SettingsModal.tsx`), so these live in the `webui-` namespace rather than
// pretending to a sharing contract nobody verified. Same bare-string wire
// format: the value is stored verbatim, empty string included.
export const CUSTOM_INSTRUCTIONS_KEY = "webui-custom-instructions";
export const ABOUT_USER_KEY = "webui-about-user";
export const CODE_REVIEW_GUIDELINES_KEY = "webui-code-review-guidelines";

/** Read a bare-string flag. Anything other than the exact string
 *  `"true"` reads as `false`, mirroring the reference's
 *  `stored(key, "false") === "true"` comparison. */
function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Quota / private mode: the in-memory state stays correct and the
    // write is silently skipped — same contract as lib/persist.ts.
  }
}

/** Whether opening a file should take a new preview tab (true, the
 *  webui default) or replace the active file tab (false). */
export function readFileOpenInNewTab(): boolean {
  return readFlag(FILE_OPEN_IN_NEW_TAB_KEY, true);
}

export function writeFileOpenInNewTab(value: boolean): void {
  writeFlag(FILE_OPEN_IN_NEW_TAB_KEY, value);
}

/** Whether file previews wrap long lines instead of scrolling. */
export function readFileLineWrap(): boolean {
  return readFlag(FILE_LINE_WRAP_KEY, true);
}

export function writeFileLineWrap(value: boolean): void {
  writeFlag(FILE_LINE_WRAP_KEY, value);
}

/** Whether the UI should surface context-window usage. Read by
 *  `components/context-meter.tsx`, which renders the composer-side
 *  readout only while this is on. */
export function readContextWindowUsage(): boolean {
  return readFlag(CONTEXT_WINDOW_USAGE_KEY, false);
}

export function writeContextWindowUsage(value: boolean): void {
  writeFlag(CONTEXT_WINDOW_USAGE_KEY, value);
  notifyContextWindowUsage(value);
}

// --- live update channel ----------------------------------------------------
//
// A surface that reads this key once per mount would not react to the
// switch, and the settings page and the composer are usually both on
// screen at once, so the toggle has to take effect without a reload.
// The channel is the same shape as `lib/theme.ts#subscribeSystemTheme`:
// a `subscribe*` returning an unsubscribe function. The stored format
// stays the bare string the desktop reference reads, so the channel is
// the only new thing — moving the key onto the `webui:ui:v1` envelope
// would break the reference-shared contract documented above.

type ContextWindowUsageListener = (value: boolean) => void;

const contextWindowUsageListeners = new Set<ContextWindowUsageListener>();

/** Subscribe to writes of `webui-context-window-usage`. Returns the
 *  unsubscribe function; the listener is called with the value that was
 *  just written, never with a value read back from storage. */
export function subscribeContextWindowUsage(
  listener: ContextWindowUsageListener,
): () => void {
  contextWindowUsageListeners.add(listener);
  return () => {
    contextWindowUsageListeners.delete(listener);
  };
}

function notifyContextWindowUsage(value: boolean): void {
  // Iterate a copy: a listener that subscribes or unsubscribes while it
  // runs must not disturb this pass.
  for (const listener of [...contextWindowUsageListeners]) {
    try {
      listener(value);
    } catch {
      // One broken subscriber must not cost the others their update, and
      // must not turn a settings toggle into an uncaught error.
    }
  }
}

/** The follow-up message behaviour. Unknown stored values fall back
 *  to `"queue"` rather than surfacing a broken radio group. */
export function readFollowUpBehavior(): FollowUpBehavior {
  if (typeof window === "undefined") return "queue";
  try {
    const raw = window.localStorage.getItem(FOLLOW_UP_BEHAVIOR_KEY);
    return raw === "steer" || raw === "off" ? raw : "queue";
  } catch {
    return "queue";
  }
}

type FollowUpBehaviorListener = (value: FollowUpBehavior) => void;

const followUpBehaviorListeners = new Set<FollowUpBehaviorListener>();

/** Subscribe to writes of `webui-follow-up-behavior`. Same shape and
 *  same reason as `subscribeContextWindowUsage`: the settings page and
 *  the composer are on screen at once, so the composer follows the
 *  channel instead of reading the key once per mount. */
export function subscribeFollowUpBehavior(
  listener: FollowUpBehaviorListener,
): () => void {
  followUpBehaviorListeners.add(listener);
  return () => {
    followUpBehaviorListeners.delete(listener);
  };
}

function notifyFollowUpBehavior(value: FollowUpBehavior): void {
  for (const listener of [...followUpBehaviorListeners]) {
    try {
      listener(value);
    } catch {
      // One broken subscriber must not cost the others their update, and
      // must not turn a settings toggle into an uncaught error.
    }
  }
}

export function writeFollowUpBehavior(value: FollowUpBehavior): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FOLLOW_UP_BEHAVIOR_KEY, value);
  } catch {
    // best-effort, see writeFlag
  }
  // Published AFTER the write, and unconditionally: the composer must
  // follow the value the user just picked even on a storage that
  // refused it, or the control and the setting would disagree until the
  // next reload.
  notifyFollowUpBehavior(value);
}

// --- commit helpers (the settings rows' onChange bodies) -------------------

/**
 * The exact body of one General-page row's `onChange`: persist first,
 * then forward to the row's setState.
 *
 * Split out as named functions (acceptance I-3) so "setState and the
 * localStorage write land together" is a drivable code path rather
 * than a source-string pin. The write happens BEFORE the state
 * forward on purpose: a persistence failure (quota / private mode)
 * must not leave the UI showing a value the storage never received —
 * the tests pin that ordering by reading the key from inside the
 * setState callback.
 */
export function commitFileOpenInNewTab(
  setState: (value: boolean) => void,
  value: boolean,
): void {
  writeFileOpenInNewTab(value);
  setState(value);
}

export function commitFileLineWrap(
  setState: (value: boolean) => void,
  value: boolean,
): void {
  writeFileLineWrap(value);
  setState(value);
}

export function commitContextWindowUsage(
  setState: (value: boolean) => void,
  value: boolean,
): void {
  writeContextWindowUsage(value);
  setState(value);
}

export function commitFollowUpBehavior(
  setState: (value: FollowUpBehavior) => void,
  value: FollowUpBehavior,
): void {
  writeFollowUpBehavior(value);
  setState(value);
}

// --- long-text preferences (ticket 55a) --------------------------------------

/** Read one of the three long-text preferences verbatim. Missing key,
 *  corrupted storage, or no `window` (SSR pass) all read as the empty
 *  string — an unset preference and an absent one are the same state to
 *  the textarea. */
function readText(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeText(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // best-effort, see writeFlag
  }
}

/** The 自定义指令 textarea's stored value (Personalization page). */
export function readCustomInstructions(): string {
  return readText(CUSTOM_INSTRUCTIONS_KEY);
}

/** The 关于你 textarea's stored value (Personalization page). */
export function readAboutUser(): string {
  return readText(ABOUT_USER_KEY);
}

/** The 自定义审查准则 textarea's stored value (Code review page). */
export function readCodeReviewGuidelines(): string {
  return readText(CODE_REVIEW_GUIDELINES_KEY);
}

/** Persist-before-setState commit helper for the 自定义指令 save button. */
export function commitCustomInstructions(
  setState: (value: string) => void,
  value: string,
): void {
  writeText(CUSTOM_INSTRUCTIONS_KEY, value);
  setState(value);
}

/** Persist-before-setState commit helper for the 关于你 save button. */
export function commitAboutUser(
  setState: (value: string) => void,
  value: string,
): void {
  writeText(ABOUT_USER_KEY, value);
  setState(value);
}

/** Persist-before-setState commit helper for the 自定义审查准则 save button. */
export function commitCodeReviewGuidelines(
  setState: (value: string) => void,
  value: string,
): void {
  writeText(CODE_REVIEW_GUIDELINES_KEY, value);
  setState(value);
}
