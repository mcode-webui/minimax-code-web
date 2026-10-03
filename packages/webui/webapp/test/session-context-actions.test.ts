// webapp/test/session-context-actions.test.ts
//
// PB-1 — the session right-click menu's three unlocked items, and the
// two that are still honest placeholders.
//
// The same two layers, and for the same reasons, as
// `shell-elements-parity.test.ts`:
//
//   1. Bilingual coverage. The dictionary is typed against `en`, so a
//      missing-en key is a compile error — but a missing-zh entry
//      silently falls back to English. PB-1 added ten `sessionMenu.*`
//      keys plus one `projectMenu.*` key, and every one is pinned in
//      BOTH locales here. The fork dialog's strings are the user-visible
//      half of a WRITE, so a dialog that fell back to English would ship
//      a Chinese UI asking an English question about a fork.
//
//   2. Static-source tripwires. The render harness cannot mount antd
//      popups, so the menu wiring is pinned on the source. This is not a
//      shortcut: a revert of any of these keeps every other test green —
//      typecheck included, because the strings would still exist. A menu
//      that silently went back to grey is exactly the state PB-1 was
//      written to end, and a test that cannot see it is a test that
//      would have let it return.
//
// The ENGINE side of the same batch — the gate, the three-state host
// handling, the fork request's forced fields — is in
// `test/lib/engine/session-context-actions.test.js` and
// `test/server/session-context-actions-host.test.js`. This file owns
// only what the browser can see.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { translate, type MessageKey } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");
const treeSrc = read("../components/session-tree.tsx");
const apiSrc = read("../lib/api.ts");

// ---------------------------------------------------------------------------
// 1. Bilingual coverage — every key PB-1 introduced
// ---------------------------------------------------------------------------

const PB1_KEYS: MessageKey[] = [
  "sessionMenu.pin",
  "sessionMenu.unpin",
  "sessionMenu.archive",
  "sessionMenu.forkCurrent",
  "sessionMenu.forkLoading",
  "sessionMenu.forkUnavailable",
  "sessionMenu.forkFrom",
  "sessionMenu.forkSuggested",
  "sessionMenu.forkNoTitle",
  "sessionMenu.forkBlocked",
  "sessionMenu.forkBlockedUnknown",
  "sessionMenu.forkCancel",
  "sessionMenu.forkConfirm",
  "projectMenu.archiveUnavailable",
];

describe("PB-1 bilingual coverage", () => {
  test("every PB-1 key resolves in both locales", () => {
    for (const key of PB1_KEYS) {
      const en = translate("en", key);
      const zh = translate("zh", key);
      assert.ok(en && en !== key, `en is missing ${key}`);
      assert.ok(zh && zh !== key, `zh is missing ${key}`);
      // A zh value identical to the en one is a missing translation that
      // happens to have been seeded with the English string. Not a
      // failure for a brand-neutral word, but for a sentence it means
      // the dialog would ask an English question in a Chinese UI.
      if (key !== "sessionMenu.forkCancel" && key !== "sessionMenu.forkConfirm") {
        assert.notEqual(en, zh, `${key} fell back to the English value in zh-CN`);
      }
    }
  });

  test("the placeholder placeholders carry no pin/archive wording", () => {
    // `sessionMenu.forkUnavailable` and `projectMenu.archiveUnavailable`
    // are the two strings that now CARRY a reason instead of shrugging
    // with `common.notLocal`. They must keep naming the specific missing
    // capability; a future edit that shortens them back to "not supported"
    // re-creates the vagueness PB-1 removed.
    assert.match(
      translate("en", "projectMenu.archiveUnavailable"),
      /project-wide/i,
    );
    assert.match(
      translate("zh", "projectMenu.archiveUnavailable"),
      /项目级/,
    );
  });

  test("the fork dialog's placeholders are the ones the dialog substitutes", () => {
    // `{title}` and `{reason}` are `.replace()`d by the component. A key
    // that lost its placeholder would render the literal braces, and a
    // key that GAINED one the component does not replace would render the
    // literal `{…}` — neither is a compile error, so both are pinned here.
    assert.ok(translate("en", "sessionMenu.forkFrom").includes("{title}"));
    assert.ok(translate("en", "sessionMenu.forkSuggested").includes("{title}"));
    assert.ok(translate("en", "sessionMenu.forkBlocked").includes("{reason}"));
  });
});

// ---------------------------------------------------------------------------
// 2. The three unlocked menu items
// ---------------------------------------------------------------------------

describe("PB-1 — the three live menu items", () => {
  /** The source slice of one context-menu row, from its key to the next. */
  /**
   * The SESSION menu's source, isolated from the PROJECT menu.
   *
   * The isolation is not tidiness. Both menus define rows keyed `"pin"`
   * and `"archive"`, and the project menu comes FIRST in the file, so a
   * plain `indexOf('key: "archive"')` reads the project item and every
   * assertion about the session item silently passes against the wrong
   * code. A test that pins the wrong rows is worse than no test, because
   * it reads as coverage.
   */
  const sessionMenuSrc = treeSrc.slice(
    treeSrc.indexOf("function buildSessionContextMenu"),
    treeSrc.indexOf("/** Clipboard write that degrades"),
  );

  /** One row of the SESSION menu, from its key to `span` chars later. */
  const rowSource = (key: string, span = 700): string => {
    const at = sessionMenuSrc.indexOf(`key: "${key}"`);
    assert.notEqual(at, -1, `session menu row ${key} is missing from session-tree.tsx`);
    return sessionMenuSrc.slice(at, at + span);
  };

  test("置顶 is live and toggles on the engine's own pin state", () => {
    const row = rowSource("pin");
    // The state must come from the TREE, which carries the engine's
    // `PinService` answer — not from a local guess. A pin that flipped a
    // local boolean would look correct until the next tree read.
    assert.ok(row.includes("session.pinned"), "the pin row reads the tree's pinned field");
    assert.ok(
      row.includes('t(session.pinned ? "sessionMenu.unpin" : "sessionMenu.pin")'),
      "the label must say which direction the click goes",
    );
    assert.ok(row.includes("disabled: !onPin"), "disabled only when no handler was supplied");
    assert.ok(row.includes("onSelect: onPin"), "the row is wired to its handler");
  });

  test("归档 is live", () => {
    const row = rowSource("archive");
    assert.ok(row.includes("disabled: !onArchive"), "disabled only when no handler was supplied");
    assert.ok(row.includes("onSelect: onArchive"), "the row is wired to its handler");
  });

  test("复制为新会话 is live and opens the preview dialog", () => {
    const row = rowSource("fork-current");
    assert.ok(row.includes("disabled: !onFork"), "disabled only when no handler was supplied");
    assert.ok(row.includes("onSelect: onFork"), "the row is wired to its handler");
  });

  test("all three handlers are supplied by BOTH the parent and the child row", () => {
    // The child (subagent) row builds the same menu. Leaving the three
    // off it would produce two menus with identical items that behave
    // differently depending on which row was clicked — a difference the
    // user discovers by accident, not by reading.
    const supply = treeSrc.match(/onPin: \(\) =>/g) ?? [];
    assert.equal(
      supply.length,
      2,
      `both SessionNode and SubagentRow must supply onPin, found ${supply.length}`,
    );
    // The window is bounded because `api.pinSession` appears TWICE per
    // supply site (once in the call, once in no other row) — an unbounded
    // lazy match would happily pair the first `onPin:` with the SECOND
    // row's `api.pinSession` and report two supplies when the child row
    // supplies none. 400 chars is the whole handler body.
    for (const [handler, call] of [
      ["onPin", "api.pinSession"],
      ["onArchive", "api.archiveSession"],
      ["onFork", "setForkOpen(true)"],
    ] as const) {
      const uses = treeSrc.split(`${handler}: () =>`).length - 1;
      assert.equal(uses, 2, `${handler} must be supplied twice, found ${uses}`);
      // And each supply must actually reach the engine call, not merely
      // exist: a handler that was written and never wired to anything
      // would pass the count above.
      const bodies = treeSrc.split(`${handler}: () =>`).slice(1);
      for (const body of bodies) {
        assert.ok(
          body.slice(0, 400).includes(call),
          `${handler} must reach ${call} within its own handler body`,
        );
      }
    }
  });

  test("the pin direction is negated, so the same handler serves both", () => {
    // `api.pinSession(session.id, !session.pinned)` — the negation is the
    // toggle. A handler that always sent `true` would pin an already
    // pinned row, and the menu would look like it worked.
    assert.ok(
      treeSrc.includes("api.pinSession(session.id, !session.pinned)"),
      "the pin call must negate the current state",
    );
  });

  test("every action refreshes the tree through the shared onChanged", () => {
    // A pin or an archive that did not re-read the tree would leave the
    // sidebar showing the old state until some unrelated refresh fired —
    // the user clicks 归档 and the row is still there.
    for (const call of ["api.pinSession", "api.archiveSession"]) {
      const at = treeSrc.indexOf(call);
      const slice = treeSrc.slice(at, at + 200);
      assert.ok(slice.includes("onChanged"), `${call} must refresh the tree`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The two honest placeholders
// ---------------------------------------------------------------------------

describe("PB-1 — the two placeholders that stay", () => {
  test("复制到新工作树 stays disabled, and the reason names the missing REFERENCE", () => {
    const at = treeSrc.indexOf('key: "fork-worktree"');
    assert.notEqual(at, -1, "the worktree fork row must still exist — removing it is not the same as honest-placeholdering it");
    const row = treeSrc.slice(at, at + 700);
    assert.ok(row.includes("disabled: true"), "the worktree fork stays disabled");
    // The distinguishing assertion. The old comment said "no worktree-fork
    // contract yet", which was FALSE — the engine has the method and the
    // eligibility fields. The reason is the absent desktop reference, and
    // a comment that says so is what stops the next reader from
    // re-deriving the wrong conclusion and "fixing" it by wiring a flag.
    assert.match(row, /reference/i);
    assert.ok(
      !row.includes("no worktree-fork contract yet"),
      "the stale 'no contract' reason must be gone",
    );
  });

  test("the worktree eligibility fields are carried, not dropped", () => {
    // The narrowing that discarded them would force the batch that
    // unblocks the worktree item to re-derive three fields the engine
    // already sends. They are typed on the client and present in the
    // server's projection.
    assert.ok(apiSrc.includes("worktree: { visible: boolean; eligible: boolean"), "client type carries the triple");
    assert.ok(
      apiSrc.includes("carried through untouched") || apiSrc.includes("The engine's worktree eligibility"),
      "the client type documents why the fields are unread",
    );
  });

  test("the project-level 归档对话 stays disabled with an accurate reason", () => {
    // Scoped to the PROJECT menu, which is the one that carries a
    // `MenuRow` label. A session-menu slice would be a different item
    // entirely and the assertion would be about the wrong code.
    // Anchored on the row's OWN `key:` token, reached by scanning
    // backwards from its label. Anchoring 400 chars before the label
    // would reach into the 在文件夹中显示 row above it, whose
    // `common.notLocal` is correct and must not be confused with this
    // one's — which is the same trap as the session/project `key: "pin"`
    // collision above, in the other direction.
    const label = treeSrc.indexOf('t("projectMenu.archive")');
    assert.notEqual(label, -1, "the project archive row must still exist");
    const at = treeSrc.lastIndexOf('key: "archive"', label);
    assert.notEqual(at, -1, "the project archive row key must still exist");
    const row = treeSrc.slice(at, label + 1200);
    assert.ok(row.includes("disabled: true"), "project bulk archive stays disabled");
    assert.ok(row.includes('t("projectMenu.archiveUnavailable")'));
    assert.ok(
      !row.includes('t("common.notLocal")'),
      "the wrong `common.notLocal` reason must be gone from the project archive item",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The fork dialog
// ---------------------------------------------------------------------------

describe("PB-1 — the 复制为新会话 dialog", () => {
  const dialog = treeSrc.slice(
    treeSrc.indexOf("function SessionForkDialog"),
    treeSrc.indexOf("const SESSION_STATE_MARK"),
  );

  test("the confirm button is gated on the ENGINE's canFork, not on having loaded", () => {
    // A dialog whose confirm is live as soon as the fetch resolves — or
    // before it does — forks on a guess. The three-way condition is the
    // whole point: the user may only fork what the engine said it could
    // fork, and may not fork while the answer is still in flight.
    assert.ok(dialog.includes("disabled={forking || loading || !canFork}"), "confirm gated on fork/load/canFork");
    assert.ok(dialog.includes("options?.ok === true && options.canFork === true"), "canFork is a strict read");
  });

  test("a failed options READ is not rendered as canFork:false", () => {
    // The distinction the dialog exists to preserve: "the engine refused"
    // and "we could not ask" are different sentences. A catch that set
    // `canFork: false` would put the second on screen as the first.
    assert.ok(dialog.includes('data-testid="session-fork-unavailable"'), "an unreadable answer has its own state");
    assert.ok(dialog.includes("reportActionError"), "a failed read reports rather than renders a refusal");
  });

  test("the suggested title is SHOWN before the fork, because the server forces it", () => {
    // `useSuggestedTitle: true` is forced server-side, so the dialog
    // showing it is not a courtesy — it is the only way the user learns
    // what the new session will be called before it exists.
    assert.ok(dialog.includes("answer.suggestedTitle"), "the suggestion is rendered");
    assert.ok(dialog.includes("sessionMenu.forkSuggested"), "with the key that names it");
  });

  test("the dialog does not render a worktree row", () => {
    // A greyed worktree row in the dialog would be a SECOND
    // reference-free form. The discipline this batch follows is that an
    // item with no reference stays a single greyed menu row.
    assert.ok(!dialog.includes("worktree.eligible"), "the dialog must not read the worktree fields");
    assert.ok(!dialog.includes("forkWorktree"), "the dialog must not mention the worktree item");
  });

  test("a stale answer from a previously opened row is not shown", () => {
    // The dialog is mounted per row, but React can re-render it against a
    // changed prop between open and the fetch resolving. `loadedFor` is
    // what stops row B from displaying row A's answer for those frames.
    assert.ok(dialog.includes("loadedFor"), "the answer is keyed by the id it describes");
    assert.ok(dialog.includes("loadedFor === sessionId"), "and the render checks that key");
  });

  test("a successful fork switches to the new session", () => {
    // A duplicate the user cannot navigate to is a duplicate they have to
    // go find afterwards.
    assert.ok(dialog.includes("onForked(forked.id)"), "the new id is handed back");
    assert.ok(
      treeSrc.includes("void openSessionAndReportLanding(newSessionId, onChanged, t)"),
      "and the tree switches to it",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The API client
// ---------------------------------------------------------------------------

describe("PB-1 — the API client", () => {
  test("the four calls hit the four routes, verb-first and id-encoded", () => {
    for (const [fn, method, verb] of [
      ["archiveSession", "POST", "archive"],
      ["pinSession", "POST", "pin"],
      ["forkSession", "POST", "fork"],
    ] as const) {
      const at = apiSrc.indexOf(`export const ${fn} = `);
      assert.notEqual(at, -1, `${fn} is missing from api.ts`);
      const slice = apiSrc.slice(at, at + 400);
      assert.ok(
        slice.includes(`/api/sessions/\${encodeURIComponent(id)}/${verb}`),
        `${fn} must target /${verb}`,
      );
      assert.ok(slice.includes(`method: "${method}"`), `${fn} must be a ${method}`);
    }
    const at = apiSrc.indexOf("export const getSessionForkOptions");
    assert.notEqual(at, -1, "getSessionForkOptions is missing");
    assert.ok(apiSrc.slice(at, at + 400).includes("fork-options"));
  });

  test("archive defaults to archiving, and pin has no default", () => {
    // The asymmetry is deliberate and is the engine's own: `archiveSession`
    // reads `req.archived !== false` so a missing flag archives, while
    // `pinSession` takes the flag positionally and branches on it, so a
    // defaulted one would move the row in a direction the user did not
    // pick.
    assert.ok(apiSrc.includes("archiveSession = (id: string, archived = true)"));
    assert.ok(apiSrc.includes("pinSession = (id: string, pinned: boolean)"));
  });

  test("TreeSession.pinned is declared as a required boolean", () => {
    // Required, not optional: the server writes it on every session, and
    // a `pinned?: boolean` client type is an invitation to write
    // `if (session.pinned)` where `undefined` silently means false.
    const at = apiSrc.indexOf("export interface TreeSession");
    const slice = apiSrc.slice(at, at + 900);
    assert.ok(slice.includes("pinned: boolean;"), "pinned is a required boolean");
    assert.ok(!slice.includes("pinned?:"), "pinned must not be optional");
  });

  test("the tree payload declares how the pin overlay resolved", () => {
    // `pins.degraded` is what tells "nothing is pinned" from "we could
    // not ask". Without the field the sidebar cannot tell, and an outage
    // renders as an empty pin section that reads as a fact about the user.
    assert.ok(apiSrc.includes("pins?: { pinnedIds: string[]; degraded: boolean; reason: string | null }"));
  });
});
