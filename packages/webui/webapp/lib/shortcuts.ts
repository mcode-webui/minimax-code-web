// webapp/lib/shortcuts.ts
//
// The single source of truth for which desktop shortcut rows the browser
// edition can actually honour, and for what combination each live row is
// currently bound to.
//
// Why this module exists: `app/page.tsx` used to hard-code two literal
// key comparisons (`event.key === "n"` / `","`), while the settings page
// (`components/settings-extra-pages.tsx`) printed the desktop's nine
// default combinations behind a 「浏览器环境不适用」notice claiming none of
// them was live. Both statements could not be true. The registry below
// holds the verdict per row, and both the global keydown handler and the
// settings page read it — a row cannot be displayed as dead while the
// handler dispatches it, and cannot be displayed as live without the
// handler being driven by the same entry.
//
// Three verdicts, one per row:
//
//   - `live`   — the page registers the combination and a browser hands
//                the keydown to us. Editable: the user may rebind it.
//   - `partial`— the handler is registered, but the combination is taken
//                by the browser on some platforms, so it fires only
//                where it is free (Ctrl+N: a new window in Chromium and
//                Firefox on Windows and Linux, which is why it only
//                arrives on macOS). Not editable: rebinding would not
//                buy a binding that works everywhere.
//   - `blocked`— no honest binding exists. Two distinct reasons, kept
//                apart because the user can act on neither but reads
//                them differently: `browserReserved` (the browser owns
//                the combination and a page cannot intercept it) and
//                `noSurface` (nothing in the WebUI performs the action).
//
// Chord format is the desktop's display form ("Ctrl+Alt+O", "Ctrl+,"),
// locale-independent by construction — it never passes through i18n.
// Parsing is total: anything unparseable reads as "no binding" rather
// than throwing, and stored overrides are re-validated on read, so a
// hand-edited localStorage entry cannot inject a broken chord into the
// keydown matcher.

/** The verdict for one desktop shortcut row. */
export type ShortcutStatus = "live" | "partial" | "blocked";

/** Why a row cannot be bound. `pending` is a real project reason (the
 *  action's semantics are not decided yet), kept separate from the two
 *  environmental ones so the settings page can say which is which. */
export type BlockedReason = "browserReserved" | "noSurface" | "noDictation" | "pending";

/** Every row the Shortcuts page renders, in display order. The id is the
 *  stable contract: it is the localStorage override key and the testid
 *  suffix (`settings-shortcuts-row-<id>`). */
export type ShortcutId =
  | "mini-chat"
  | "global-search"
  | "search-tasks"
  | "new-task"
  | "new-task-no-project"
  | "open-folder"
  | "open-settings"
  | "hold-dictation"
  | "toggle-dictation"
  | "invert-follow-up";

/** What a live row does when its combination fires. The settings page
 *  never needs it; `app/page.tsx` switches on it. */
export type ShortcutAction = "globalSearch" | "newTask" | "newTaskNoProject" | "openSettings";

export interface ShortcutSpec {
  id: ShortcutId;
  /** The desktop's printed default, or `null` for the desktop's unset
   *  state. Defaults are what a cleared row falls back to. */
  defaultBinding: string | null;
  status: ShortcutStatus;
  /** Present iff `status !== "blocked"`. */
  action?: ShortcutAction;
  /** Present iff `status === "blocked"` — the page's per-row reason. */
  reason?: BlockedReason;
  /** The desktop gives the Mini Chat row an external ↺ affordance. */
  reset?: boolean;
}

/** The registry. `defaultBinding` values are the desktop's, verbatim.
 *
 *  Verdict evidence, per row:
 *
 *  | row                  | combination | verdict  | why |
 *  |----------------------|-------------|----------|-----|
 *  | mini-chat            | Alt+M       | blocked  | the WebUI has no Mini Chat surface to show |
 *  | global-search        | Ctrl+K      | live     | free in Chromium/Firefox once the page calls preventDefault; the search surface exists (sidebar 搜索) |
 *  | search-tasks         | Ctrl+G      | blocked  | the browser's find-next |
 *  | new-task             | Ctrl+N      | partial  | a new window in Chromium/Firefox on Windows and Linux; only macOS delivers it to the page |
 *  | new-task-no-project  | Ctrl+Alt+O  | live     | unclaimed in every browser the WebUI targets |
 *  | open-folder          | Ctrl+O      | blocked  | the browser's Open File dialog |
 *  | open-settings        | Ctrl+,      | live     | unclaimed |
 *  | hold-dictation       | —           | blocked  | no speech recognition behind the row |
 *  | toggle-dictation     | —           | blocked  | same |
 *  | invert-follow-up     | Ctrl+Enter  | blocked  | the key is free, but the action's semantics are not decided; binding it now would promise behaviour that does not exist |
 */
export const SHORTCUT_SPECS: readonly ShortcutSpec[] = [
  {
    id: "mini-chat",
    defaultBinding: "Alt+M",
    status: "blocked",
    reason: "noSurface",
    reset: true,
  },
  { id: "global-search", defaultBinding: "Ctrl+K", status: "live", action: "globalSearch" },
  { id: "search-tasks", defaultBinding: "Ctrl+G", status: "blocked", reason: "browserReserved" },
  { id: "new-task", defaultBinding: "Ctrl+N", status: "partial", action: "newTask" },
  { id: "new-task-no-project", defaultBinding: "Ctrl+Alt+O", status: "live", action: "newTaskNoProject" },
  { id: "open-folder", defaultBinding: "Ctrl+O", status: "blocked", reason: "browserReserved" },
  { id: "open-settings", defaultBinding: "Ctrl+,", status: "live", action: "openSettings" },
  { id: "hold-dictation", defaultBinding: null, status: "blocked", reason: "noDictation" },
  { id: "toggle-dictation", defaultBinding: null, status: "blocked", reason: "noDictation" },
  { id: "invert-follow-up", defaultBinding: "Ctrl+Enter", status: "blocked", reason: "pending" },
] as const;

const SPEC_BY_ID: ReadonlyMap<ShortcutId, ShortcutSpec> = new Map(
  SHORTCUT_SPECS.map((spec) => [spec.id, spec]),
);

export function shortcutSpec(id: ShortcutId): ShortcutSpec {
  const spec = SPEC_BY_ID.get(id);
  if (!spec) throw new Error(`unknown shortcut id: ${id}`);
  return spec;
}

// --- chords -------------------------------------------------------------------

/** A parsed key combination. `key` is the lower-cased `KeyboardEvent.key`
 *  for printable keys ("k", ",", "enter") and the bare modifier keys'
 *  `code`-free form otherwise. */
export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** Modifier names in the fixed display order the desktop prints them in. */
const MODIFIER_LABELS: readonly (keyof Pick<Chord, "ctrl" | "alt" | "shift">)[] = [
  "ctrl",
  "alt",
  "shift",
];

/** Canonical display spelling per modifier. */
const MODIFIER_DISPLAY: Readonly<Record<(typeof MODIFIER_LABELS)[number], string>> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/** Every spelling of a modifier key. A chord whose key is one of these is
 *  not a combination at all. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "ctrl",
  "control",
  "cmd",
  "meta",
  "alt",
  "option",
  "shift",
  "os",
]);

/** Canonical display spelling for the word keys `parseChord` lower-cases. */
const KEY_DISPLAY: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Esc",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** Canonical spellings for keys whose `KeyboardEvent.key` is a word. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  space: "space",
  plus: "+",
};

/** Parse a display chord ("Ctrl+Alt+O"). Returns `null` for anything that
 *  is not a modifier-prefixed single key, so a corrupt value can never
 *  become a matcher that fires on every keypress. */
export function parseChord(text: string): Chord | null {
  const parts = text.split("+");
  if (parts.length < 2) return null;
  const key = (parts[parts.length - 1] ?? "").trim().toLowerCase();
  if (key === "") return null;
  const chord: Chord = { ctrl: false, alt: false, shift: false, key };
  for (const part of parts.slice(0, -1)) {
    const name = part.trim().toLowerCase();
    if (name === "ctrl" || name === "control" || name === "cmd" || name === "meta") {
      chord.ctrl = true;
    } else if (name === "alt" || name === "option") {
      chord.alt = true;
    } else if (name === "shift") {
      chord.shift = true;
    } else {
      return null;
    }
  }
  // A bare modifier cannot stand alone as a binding, and neither can a
  // modifier standing in for the key ("Ctrl+Alt" would otherwise parse as
  // Ctrl plus a key literally named Alt).
  if (MODIFIER_KEYS.has(chord.key)) return null;
  chord.key = KEY_ALIASES[key] ?? key;
  return chord;
}

/** Render a chord back to the display form. Inverse of `parseChord` for
 *  every chord `parseChord` accepts, and the canonical form the settings
 *  page stores: a single letter prints upper-case and a word key prints
 *  in the desktop's own spelling, so the registry's defaults and a
 *  captured keydown render identically. */
export function formatChord(chord: Chord): string {
  const modifiers = MODIFIER_LABELS.filter((modifier) => chord[modifier]).map(
    (modifier) => `${MODIFIER_DISPLAY[modifier]}+`,
  );
  const key =
    KEY_DISPLAY[chord.key] ?? (/^[a-z]$/.test(chord.key) ? chord.key.toUpperCase() : chord.key);
  return `${modifiers.join("")}${key}`;
}

/** The subset of `KeyboardEvent` this module reads. Taking the shape
 *  rather than the event keeps the matcher drivable from a plain object
 *  in tests and free of DOM lib coupling. */
export interface KeyStroke {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Format a keydown as a chord, or `null` when the stroke is not a
 *  bindable combination (a bare modifier, or a press carrying no
 *  non-modifier key). */
export function chordFromStroke(stroke: KeyStroke): Chord | null {
  const key = stroke.key.toLowerCase();
  if (key === "control" || key === "alt" || key === "shift" || key === "meta" || key === "os") {
    return null;
  }
  if (key === "") return null;
  return {
    ctrl: stroke.ctrlKey,
    alt: stroke.altKey,
    shift: stroke.shiftKey,
    key: KEY_ALIASES[key] ?? key,
  };
}

/** Does this keydown satisfy the display chord?
 *
 *  The primary modifier is read as ctrl OR meta, because the printed
 *  binding says "Ctrl" on every platform while macOS delivers Cmd to the
 *  page. A stroke carrying an *extra* modifier the chord does not name
 *  (Ctrl+Shift+K against a Ctrl+K binding) does not match — otherwise
 *  every binding would swallow the shifted forms the browser and the
 *  editor need. */
export function chordMatches(stroke: KeyStroke, text: string): boolean {
  const chord = parseChord(text);
  if (!chord) return false;
  const primary = stroke.ctrlKey || stroke.metaKey;
  if (chord.ctrl !== primary) return false;
  if (chord.alt !== stroke.altKey) return false;
  if (chord.shift !== stroke.shiftKey) return false;
  return stroke.key.toLowerCase() === chord.key;
}

// --- bindings -----------------------------------------------------------------

/** The effective combination per row: the desktop default overlaid with
 *  the user's overrides. Blocked rows always resolve to their printed
 *  default (or `null`) — they are not overridable, so an override for one
 *  is dropped rather than honoured. */
export type ResolvedBindings = Readonly<Record<ShortcutId, string | null>>;

const DEFAULT_BINDINGS: ResolvedBindings = Object.freeze(
  Object.fromEntries(SHORTCUT_SPECS.map((spec) => [spec.id, spec.defaultBinding])) as Record<
    ShortcutId,
    string | null
  >,
);

export function defaultBindings(): ResolvedBindings {
  return DEFAULT_BINDINGS;
}

/** Overlays `custom` onto the defaults. Unknown ids and unparseable
 *  chords are dropped: the result is always safe to match against. */
export function resolveBindings(custom: Readonly<Record<string, string>>): ResolvedBindings {
  const resolved: Record<ShortcutId, string | null> = { ...DEFAULT_BINDINGS };
  for (const spec of SHORTCUT_SPECS) {
    if (spec.status === "blocked") continue;
    const override = custom[spec.id];
    if (typeof override !== "string") continue;
    if (!parseChord(override)) continue;
    resolved[spec.id] = override;
  }
  return resolved;
}

/** The ids sharing one combination, restricted to rows that are actually
 *  dispatched. Two rows on the same chord is a silent, order-dependent
 *  bug in the handler, so the settings page refuses to store it. */
export function findBindingConflicts(
  bindings: Readonly<Record<string, string | null>>,
): ShortcutId[] {
  const seen = new Map<string, ShortcutId>();
  const conflicts: ShortcutId[] = [];
  for (const spec of SHORTCUT_SPECS) {
    const text = bindings[spec.id];
    if (spec.status === "blocked" || typeof text !== "string") continue;
    const chord = parseChord(text);
    if (!chord) continue;
    const canonical = formatChord(chord);
    const owner = seen.get(canonical);
    if (owner === undefined) {
      seen.set(canonical, spec.id);
      continue;
    }
    conflicts.push(owner, spec.id);
  }
  return [...new Set(conflicts)];
}

/** The other dispatched row already on `text`, if any. `exclude` is the
 *  row being edited so re-saving a row with its own combination is not
 *  reported as a conflict. */
export function findConflictingId(
  bindings: Readonly<Record<string, string | null>>,
  text: string,
  exclude: ShortcutId,
): ShortcutId | null {
  const chord = parseChord(text);
  if (!chord) return null;
  const canonical = formatChord(chord);
  for (const spec of SHORTCUT_SPECS) {
    if (spec.id === exclude || spec.status === "blocked") continue;
    const other = parseChord(bindings[spec.id] ?? "");
    if (other && formatChord(other) === canonical) return spec.id;
  }
  return null;
}

/** The result of recording a new combination: either the override map to
 *  store, or the row the candidate collided with. Split out of the
 *  settings component so the accept/refuse decision is drivable without a
 *  DOM — the component only persists and forwards. */
export type BindingAttempt =
  | { ok: true; custom: Record<string, string> }
  | { ok: false; with: ShortcutId };

/** Record `chord` for `id` on top of `custom`. A candidate another
 *  dispatched row already owns is refused and the row that owns it is
 *  named: two rows sharing one combination would leave the dispatched
 *  action dependent on registry order, which is exactly the silent bug a
 *  rebind feature must not introduce. A blocked row has nothing to bind,
 *  so the attempt is refused against itself. */
export function applyBinding(
  custom: Readonly<Record<string, string>>,
  id: ShortcutId,
  chord: string,
): BindingAttempt {
  if (shortcutSpec(id).status === "blocked") return { ok: false, with: id };
  const next = { ...custom, [id]: chord };
  const with_ = findConflictingId(resolveBindings(next), chord, id);
  return with_ ? { ok: false, with: with_ } : { ok: true, custom: next };
}

/** Drop `id`'s override, leaving the desktop default in force. */
export function clearBinding(
  custom: Readonly<Record<string, string>>,
  id: ShortcutId,
): Record<string, string> {
  const next = { ...custom };
  delete next[id];
  return next;
}

/** The dispatched row a keydown belongs to, or `null` when it belongs to
 *  none. Registry order decides a tie — but a tie cannot survive
 *  `findBindingConflicts`, which the settings page enforces on every
 *  write. */
export function matchShortcut(
  stroke: KeyStroke,
  bindings: ResolvedBindings,
): ShortcutAction | null {
  for (const spec of SHORTCUT_SPECS) {
    if (spec.status === "blocked" || !spec.action) continue;
    const text = bindings[spec.id];
    if (typeof text === "string" && chordMatches(stroke, text)) return spec.action;
  }
  return null;
}

// --- persistence --------------------------------------------------------------

/** Bare JSON object of `{ shortcutId: "Ctrl+Alt+O" }` overrides, mirroring
 *  `lib/settings-local.ts`'s "one key, best effort, total on read" pattern.
 *  The `webui-` namespace matches the other WebUI-only settings keys: the
 *  desktop's own key names for shortcuts were not observed, so this one
 *  does not pretend to a sharing contract. */
export const SHORTCUT_BINDINGS_KEY = "webui-shortcut-bindings";

/** Read the stored overrides. Missing key, corrupted JSON, a non-object
 *  payload, and no `window` (SSR pass) all read as "no overrides". */
export function readCustomBindings(): Record<string, string> {
  if (typeof window === "undefined") return {};
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SHORTCUT_BINDINGS_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const clean: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const spec = SPEC_BY_ID.get(id as ShortcutId);
    // Drop overrides for blocked rows and unparseable chords: storage
    // edited by hand must not widen what the page dispatches.
    if (!spec || spec.status === "blocked") continue;
    if (typeof value !== "string" || !parseChord(value)) continue;
    clean[id] = value;
  }
  return clean;
}

export function writeCustomBindings(bindings: Readonly<Record<string, string>>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(bindings).length === 0) {
      window.localStorage.removeItem(SHORTCUT_BINDINGS_KEY);
      return;
    }
    window.localStorage.setItem(SHORTCUT_BINDINGS_KEY, JSON.stringify(bindings));
  } catch {
    // best-effort, same contract as lib/settings-local.ts
  }
}

/** The bindings the keydown handler must dispatch right now: stored
 *  overrides validated against the current registry, then resolved. */
export function effectiveBindings(): ResolvedBindings {
  return resolveBindings(readCustomBindings());
}
