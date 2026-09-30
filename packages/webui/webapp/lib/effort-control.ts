// webapp/lib/effort-control.ts
//
// Ticket 49 batch 2 (A3) — the shape decisions for the model picker's
// adaptive thinking-effort control, extracted as pure functions so the
// test suite exercises the PRODUCT functions (an earlier revision kept
// mirrors in the test file, and probes showed a broken product function
// still passed green — the decision table had drifted off the code it
// claimed to pin).
//
// Form only, by ticket scope: the wire semantics stay the LOCAL
// contract (`thinkingLevels` catalogue + `""` = engine default). The
// reference picker's effortOptions/variant derivation (A9) is
// deliberately NOT reimplemented here.

/**
 * Which control shape a model's thinking levels render as.
 *
 *   - exactly `["off","on"]` (either order) → a toggle switch, the
 *     two-state shape switchable builtins project (`MiniMax-M3`);
 *   - anything else (a depth scale) → a radio group;
 *   - an empty list → no control at all (the composer's "a no-op
 *     control is worse than none" rule).
 */
export function effortControlShape(levels: string[]): "switch" | "radiogroup" | null {
  if (levels.length === 0) return null;
  if (levels.length === 2 && levels.includes("off") && levels.includes("on")) {
    return "switch";
  }
  return "radiogroup";
}

/**
 * The radio group's option list.
 *
 * `default` (UI label "Default", submitted as the empty
 * string) is always a legal choice — the reference prepends it the
 * same way, and the local wire treats `""` as "no override; the engine
 * picks". A defensive filter keeps a catalogue that ever ships a
 * literal `"default"` level from producing a duplicate radio.
 */
export function effortOptionsWithDefault(levels: string[]): string[] {
  return ["default", ...levels.filter((level) => level !== "default")];
}

/**
 * The option the control highlights as current, or null.
 *
 *   - a preview (focused row ≠ active model) never highlights — the
 *     record belongs to the active model;
 *   - `""` (engine default) maps to "default";
 *   - a recorded level the target RAW levels contain highlights
 *     itself — the stale check must read `levels`, not the radio
 *     group's option list (the switch form never builds that list, and
 *     gating the switch's checked state on it made every recorded "on"
 *     read as off);
 *   - a stale recorded level (unsupported by the target) highlights
 *     NOTHING — the same anti-stale rule the row badge applies (B11) —
 *     rather than silently pretending the engine default is picked.
 */
export function resolveEffortCurrent(
  levels: string[],
  thinking: string,
  preview: boolean,
): string | null {
  if (preview) return null;
  if (thinking === "") return "default";
  return levels.includes(thinking) ? thinking : null;
}
