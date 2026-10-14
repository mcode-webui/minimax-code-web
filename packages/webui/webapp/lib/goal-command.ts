// webapp/lib/goal-command.ts
//
// PB-14 batch C: the `/goal` command language the composer speaks.
//
// WHAT THIS IS. A total, pure function from one line of composer input to
// one intent. It is the whole of batch C's parsing — the composer holds no
// `if (/^\/goal/)` of its own, so a command cannot mean one thing in the
// palette and another in the submit path.
//
// WHERE IT CAME FROM. `packages/tui/src/application/thread-goal-command.ts`
// (`parseTuiThreadGoalCommand`), the parser the CLI's own `/goal` runs, with
// the TUI controller's eight intents kept and two of this client's needs
// added. It is a port rather than an invention for a reason the baseline
// states: that parser is the specification of what `/goal` means, and a
// second grammar would make webui's `/goal` a different command wearing the
// same name. The header comment of the TUI file says the same about the
// desktop client it mirrors — this is the third member of one family, not a
// third grammar.
//
// WHAT THE PORT DROPS, AND WHY.
//
//   - `/goal-done` is ADDED, not dropped. The TUI reaches the same place
//     through its own `complete(user_requested)` transition and the webui
//     composer is the only surface here that would otherwise have no way to
//     say "I got what I wanted" (`/goal done` is an objective in the TUI —
//     it starts a goal whose objective is the word "done"). Renaming the
//     word `done` into the parser would be a worse collision than giving
//     this client its own command, so `/goal-done` is a separate head word
//     and `/goal done` keeps meaning what it means everywhere else.
//
//   - Error MESSAGES became message KEYS. The TUI returns English prose
//     because the TUI has one locale; webui renders Chinese and English
//     from one key set, and a hard-coded English error inside an otherwise
//     bilingual composer is a defect. The two messages that interpolated a
//     value (`got "12x"`) became one static key: `translate` does no
//     interpolation, and a key carrying an untranslated value is worse than
//     a key that names the rule.
//
//   - `view` and `help` intents are kept even though the composer has no
//     panel for them yet, because they are what a bare `/goal` parses to
//     and inventing a third answer for the empty input would be the exact
//     silent-drop this parser exists to remove.
//
// THE BUDGET GRAMMAR IS UNCHANGED — `budget=50K`, `budget=clear`, the
// leading/trailing/double forms and the CJK boundary allow-list are the
// TUI's, verbatim, because they are what a user who learned `/goal` in the
// CLI will type here.

import type { MessageKey } from "./i18n";

/**
 * What one `/goal` line means.
 *
 * `create` and `budget` are the two intents that write a different field;
 * `pause`/`resume`/`clear`/`edit` are the lifecycle verbs; `view`/`help`
 * are the answers to an input that carries no instruction. `error` carries
 * a MESSAGE KEY rather than a sentence, so the composer's `t()` decides the
 * language and this module never holds one.
 */
export type GoalCommandIntent =
  | { readonly kind: "help" }
  | { readonly kind: "view" }
  | {
      readonly kind: "create";
      readonly objective: string;
      readonly tokenBudget?: number | null;
    }
  | { readonly kind: "budget"; readonly tokenBudget: number | null }
  | { readonly kind: "clear" }
  | { readonly kind: "edit" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  /** `/goal-done` — the user's own verdict, not the agent's. */
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly key: MessageKey };

/**
 * Boundary characters that may separate a relaxed `budget=<value>`
 * directive from objective text: whitespace, CJK punctuation & kana
 * (U+3000–U+30FF), CJK ideographs (U+4E00–U+9FFF), full/half-width forms
 * (U+FF00–U+FFEF) and the horizontal ellipsis. Deliberately an ALLOWLIST —
 * ASCII punctuation is not a boundary, so technical text keeps its tail.
 * Verbatim from `thread-goal-command.ts:42-45`.
 */
const RELAXED_BOUNDARY = "[\\s\\u2026\\u3000-\\u30FF\\u4E00-\\u9FFF\\uFF00-\\uFFEF]";
const LEADING_BUDGET_RE = new RegExp(`^budget=([A-Za-z0-9.]+)(?=$|${RELAXED_BOUNDARY})`, "iu");
const TRAILING_BUDGET_RE = new RegExp(`(^|${RELAXED_BOUNDARY})budget=([A-Za-z0-9.]+)$`, "iu");
const SEPARATOR_BEFORE_RE = /[\s…、。！，：；？]+$/u;
const SEPARATOR_AFTER_RE = /^[\s…、。！，：；？]+/u;

/** `clear` / `null` / `none` / `off` / `0` all mean "no budget", not "zero". */
const BUDGET_CLEAR_WORDS: ReadonlySet<string> = new Set(["clear", "null", "none", "off", "0"]);

/**
 * One budget token to its meaning.
 *
 * `'invalid'` is a distinct answer rather than `null`: `null` means "the
 * budget was removed" and must reach the engine, while an unparseable token
 * must reach the user as an error. Collapsing them would turn a typo into a
 * silent uncapping of a goal someone set a budget on.
 *
 * A float is accepted (`50.5K`) and rounded, matching the TUI — a budget of
 * 50.5K tokens is a real thing to want, and the engine's own contract wants
 * an integer, so rounding here is where it happens.
 */
function parseBudgetValue(raw: string): number | null | "invalid" {
  const value = raw.trim();
  if (!value) return "invalid";
  const normalized = value.toLowerCase();
  if (BUDGET_CLEAR_WORDS.has(normalized)) return null;
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([km])?$/);
  if (!match) return "invalid";
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  const suffix = match[2];
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  const result = Math.round(parsed * multiplier);
  return result > 0 ? result : "invalid";
}

/** The strict trailing `budget=<token>` form, which may be present with no
 *  value at all (`/goal budget=`) and therefore may surface `invalid`. */
function parseTrailingBudget(body: string): { value: number | null | "invalid"; head: string } | null {
  const trimmed = body.trimEnd();
  const lastSpace = trimmed.search(/\s\S*$/);
  const tail = lastSpace === -1 ? trimmed : trimmed.slice(lastSpace + 1);
  if (!/^budget=[A-Za-z0-9.]*$/i.test(tail)) return null;
  const rawValue = tail.slice("budget=".length);
  const head = lastSpace === -1 ? "" : trimmed.slice(0, lastSpace).trimEnd();
  return { value: parseBudgetValue(rawValue), head };
}

type BudgetDirectiveExtraction =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "double" }
  | { readonly kind: "value"; readonly value: number | null; readonly objective: string };

/**
 * Extract one `budget=<value>` directive from the start or end of a body.
 *
 * Strict trailing token first (it is the only form that can report a bare
 * `budget=` as invalid), then the relaxed trailing form (CJK boundary, valid
 * values only), then the relaxed leading form. A valid directive at BOTH
 * ends is `double` rather than a silent choice of one: two budgets mean the
 * user thought they were setting two different things, and picking either
 * loses the other without telling them.
 */
function extractBudgetDirective(body: string): BudgetDirectiveExtraction {
  const trimmed = body.trim();
  const strict = parseTrailingBudget(trimmed);
  if (strict?.value === "invalid") return { kind: "invalid" };

  let value: number | null | undefined;
  let head: string | undefined;
  if (strict) {
    value = strict.value;
    head = strict.head;
  } else {
    const relaxed = TRAILING_BUDGET_RE.exec(trimmed);
    if (relaxed) {
      const parsed = parseBudgetValue(relaxed[2] ?? "");
      if (parsed !== "invalid") {
        value = parsed;
        head = trimmed.slice(0, relaxed.index + (relaxed[1] ?? "").length);
      }
    }
  }
  if (head !== undefined && value !== undefined) {
    const objective = head.replace(SEPARATOR_BEFORE_RE, "").trim();
    const leftover = LEADING_BUDGET_RE.exec(objective);
    if (leftover && parseBudgetValue(leftover[1] ?? "") !== "invalid") {
      return { kind: "double" };
    }
    return { kind: "value", value, objective };
  }

  const leading = LEADING_BUDGET_RE.exec(trimmed);
  if (leading) {
    const parsed = parseBudgetValue(leading[1] ?? "");
    if (parsed !== "invalid") {
      const objective = trimmed
        .slice(leading[0].length)
        .replace(SEPARATOR_AFTER_RE, "")
        .trim();
      return { kind: "value", value: parsed, objective };
    }
  }
  return { kind: "none" };
}

/**
 * A head word that takes no argument, and its refusal when given one.
 *
 * The test is a length comparison rather than a regex so that a head word
 * alone (`/goal pause`) is `view`'s empty tail and passes, while
 * `/goal pause now` fails — the same rule the TUI applies at
 * `thread-goal-command.ts:163-179`.
 */
function noArgIntent(
  headRaw: string,
  tail: string,
  intent: GoalCommandIntent,
  errorKey: MessageKey,
): GoalCommandIntent {
  return tail.length > headRaw.length ? { kind: "error", key: errorKey } : intent;
}

/**
 * Parse the ARGUMENT string of `/goal` — everything after the command word.
 *
 * Split from {@link parseGoalCommand} so this half is testable against the
 * TUI's own cases without a leading slash, and so the composer's routing
 * stays a two-line `startsWith` rather than a second grammar.
 */
export function parseGoalArgs(rawArgs: string): GoalCommandIntent {
  const tail = rawArgs.trim();
  if (!tail) return { kind: "view" };

  const firstSpace = tail.search(/\s/);
  const headRaw = firstSpace === -1 ? tail : tail.slice(0, firstSpace);
  const head = headRaw.toLowerCase();

  if (head === "budget") {
    return { kind: "error", key: "goal.command.error.budgetNeedsValue" };
  }
  if (/^budget=[A-Za-z0-9.]*$/i.test(headRaw) && tail.length === headRaw.length) {
    const rawBudget = headRaw.slice("budget=".length);
    const parsed = parseBudgetValue(rawBudget);
    if (parsed === "invalid") {
      return { kind: "error", key: "goal.command.error.badBudget" };
    }
    return { kind: "budget", tokenBudget: parsed };
  }

  switch (head) {
    case "clear":
    case "cancel":
    case "delete":
      return noArgIntent(headRaw, tail, { kind: "clear" }, "goal.command.error.clearTakesNoArgs");
    case "edit":
      return noArgIntent(headRaw, tail, { kind: "edit" }, "goal.command.error.editTakesNoArgs");
    case "pause":
      return noArgIntent(headRaw, tail, { kind: "pause" }, "goal.command.error.pauseTakesNoArgs");
    case "resume":
      return noArgIntent(headRaw, tail, { kind: "resume" }, "goal.command.error.resumeTakesNoArgs");
    case "help":
      return { kind: "help" };
    default: {
      const extraction = extractBudgetDirective(tail);
      if (extraction.kind === "invalid") {
        return { kind: "error", key: "goal.command.error.badBudget" };
      }
      if (extraction.kind === "double") {
        return { kind: "error", key: "goal.command.error.budgetTwice" };
      }
      if (extraction.kind === "value") {
        return extraction.objective
          ? { kind: "create", objective: extraction.objective, tokenBudget: extraction.value }
          : { kind: "budget", tokenBudget: extraction.value };
      }
      return { kind: "create", objective: tail };
    }
  }
}

/**
 * Parse one composer input, or answer `null` for a non-goal input.
 *
 * `/goal-done` is matched FIRST and on its own, because it is the only head
 * word this client added and `/goal-done …` with a tail is still
 * `/goal-done` — the trailing text is a message a user typed after a
 * command they believe takes no argument, and silently ignoring it is
 * kinder than refusing the command over it. `/goal` is matched on the word
 * boundary, so `/goalfoo` is somebody else's command.
 */
export function parseGoalCommand(content: string): GoalCommandIntent | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/);
  const head = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  if (head === "goal-done") return { kind: "done" };
  if (head !== "goal") return null;
  return parseGoalArgs(firstSpace === -1 ? "" : body.slice(firstSpace + 1));
}