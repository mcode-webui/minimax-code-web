// webapp/test/shell-elements-parity.test.ts
//
// Parity pins for the main-surface elements rework (ticket 55c):
// the sidebar user menu (ref-01), the project context menu (ref-26),
// and the home quick-capability capsules (ref-28).
//
// Two layers, same reasons as i18n-settings-parity.test.ts and
// composer-submit-tripwire.test.ts:
//
//   1. Bilingual coverage — the dictionary is typed against `en`, so a
//      missing-en key is a compile error, but a missing-zh entry silently
//      falls back to English. Every 55c key is pinned in BOTH locales,
//      with the zh values asserted verbatim against the desktop
//      reference screenshots (the row/chip labels are the user-visible
//      contract of this ticket).
//   2. Static-source tripwires — the render harness cannot mount antd
//      Dropdown popups, so the menu wiring is pinned on the source: the
//      user menu's row set with its enabled/disabled split, the project
//      menu's five entries with the danger tone on 移除, the A1
//      `common.notLocal` markers on the cloud-only entries, and the
//      capsules' click → toast wiring. A revert of any of these keeps
//      every other test green (typecheck included — the strings would
//      still exist); only these assertions notice.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { translate, type MessageKey } from "../lib/i18n";
import { capToastReducer } from "../lib/cap-toast";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) =>
  readFileSync(resolve(here, relative), "utf8");

// ---------------------------------------------------------------------------
// 1. Bilingual coverage + verbatim zh labels (ref-01 / ref-26 / ref-28)
// ---------------------------------------------------------------------------

const KEYS_55C: MessageKey[] = [
  "common.notLocal",
  "userMenu.upgrade",
  "userMenu.feedback",
  "userMenu.localUser",
  "projectMenu.rename",
  "projectMenu.pin",
  "projectMenu.unpin",
  "projectMenu.revealInFolder",
  "projectMenu.archive",
  "projectMenu.remove",
  "projectMenu.removeConfirmTitle",
  "projectMenu.removeConfirmBody",
  "projectMenu.removeConfirmAuthNote",
  "projectMenu.removeProgress",
  "projectMenu.removeConfirm",
  "projectMenu.cancel",
  "home.cap.video",
  "home.cap.vibe",
  "home.cap.design",
  "home.cap.product",
  "home.cap.askMcode",
];

// The zh strings the desktop screenshots print. If one of these changes,
// the change must be a deliberate re-alignment, not a drift.
const ZH_VERBATIM: Array<[MessageKey, string]> = [
  ["common.notLocal", "本地版不适用"],
  ["userMenu.upgrade", "升级"],
  ["userMenu.feedback", "反馈与帮助"],
  ["userMenu.localUser", "本地用户"],
  ["projectMenu.rename", "重命名项目"],
  ["projectMenu.pin", "置顶项目"],
  ["projectMenu.unpin", "取消置顶"],
  ["projectMenu.revealInFolder", "在文件夹中显示"],
  ["projectMenu.archive", "归档对话"],
  ["projectMenu.remove", "移除"],
  ["home.cap.video", "视频生成"],
  ["home.cap.design", "设计视觉"],
  ["home.cap.product", "产品运营"],
  // 「询问 MCode」 with 问, the reference's wording — the pre-55c chip
  // draft said 问问 MCode.
  ["home.cap.askMcode", "询问 MCode"],
];

describe("55c i18n — bilingual coverage and verbatim zh labels", () => {
  for (const key of KEYS_55C) {
    test(`${key} exists in both locales`, () => {
      assert.ok(translate("en", key), "en value must be non-empty");
      assert.ok(translate("zh", key), "zh value must be non-empty (no en fallback)");
    });
  }
  for (const [key, zh] of ZH_VERBATIM) {
    test(`${key} zh is exactly「${zh}」`, () => {
      assert.equal(translate("zh", key), zh);
    });
  }
  test("removeConfirmBody carries the {count} placeholder in both locales", () => {
    assert.ok(translate("zh", "projectMenu.removeConfirmBody").includes("{count}"));
    assert.ok(translate("en", "projectMenu.removeConfirmBody").includes("{count}"));
  });
  test("removeConfirmAuthNote carries the {count} placeholder in both locales (F2)", () => {
    assert.ok(translate("zh", "projectMenu.removeConfirmAuthNote").includes("{count}"));
    assert.ok(translate("en", "projectMenu.removeConfirmAuthNote").includes("{count}"));
  });
  test("zh removeConfirmBody states the subagent sessions explicitly (F1)", () => {
    // The honest wording: the confirm must not understate the deletion set.
    assert.ok(
      translate("zh", "projectMenu.removeConfirmBody").includes("子代理会话"),
      "zh body must mention subagent sessions",
    );
    assert.ok(
      translate("en", "projectMenu.removeConfirmBody").includes("subagent sessions"),
      "en body must mention subagent sessions",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Static-source tripwires
// ---------------------------------------------------------------------------

describe("55c user menu (shell.tsx, ref-01)", () => {
  const src = read("../components/shell.tsx");

  test("renders the desktop's full row set in order", () => {
    const order = ["settings", "upgrade", "checkin", "usage", "feedback", "signOut"]
      .map((key) => src.indexOf(`key: "${key}"`))
      .filter((at) => at >= 0);
    assert.equal(order.length, 6, "all six rows present");
    const sorted = [...order].sort((a, b) => a - b);
    assert.deepEqual(order, sorted, "rows appear in the desktop's order");
  });

  test("Settings carries the Ctrl+, kbd badge and a real binding", () => {
    assert.ok(src.includes('kbd="Ctrl+,"'), "kbd badge on the settings row");
    const page = read("../app/page.tsx");
    // The keydown handler stopped hard-coding `event.key === ","` when
    // SB-2 moved the per-row verdicts into lib/shortcuts.ts, so the
    // tripwire follows the wiring: the page must dispatch through the
    // registry, and the registry must still pair Ctrl+, with
    // openSettings. `webapp/test/shortcuts.test.ts` drives that pairing.
    assert.ok(
      page.includes('from "@/lib/shortcuts"') && page.includes("matchShortcut(event, bindings)"),
      "page.tsx must dispatch through the shortcut registry",
    );
    const registry = read("../lib/shortcuts.ts");
    const spec = registry.slice(registry.indexOf('id: "open-settings"'));
    assert.ok(
      spec.includes('defaultBinding: "Ctrl+,"') && spec.includes('action: "openSettings"'),
      "the registry binds Ctrl+, to openSettings — the badge must be a real binding",
    );
  });

  test("cloud-only rows are disabled placeholders marked 本地版不适用", () => {
    for (const key of ["upgrade", "feedback"]) {
      const at = src.indexOf(`key: "${key}"`);
      assert.ok(at >= 0, `${key} row exists`);
      const slice = src.slice(at, at + 700);
      assert.ok(slice.includes("disabled: true"), `${key} item is disabled`);
      assert.ok(
        slice.includes('t("common.notLocal")'),
        `${key} row carries the notLocal marker`,
      );
    }
  });

  test("check-in and sign-out stay disabled placeholders (pre-55c contract)", () => {
    for (const key of ["checkin", "signOut"]) {
      const at = src.indexOf(`key: "${key}"`);
      const slice = src.slice(at, at + 700);
      assert.ok(slice.includes("disabled: true"), `${key} item is disabled`);
      assert.ok(
        slice.includes('t("common.unsupported")'),
        `${key} keeps the not-yet marker`,
      );
    }
  });

  test("the trailing user card renders with plan badge and bell", () => {
    assert.ok(src.includes('data-testid="user-menu-card"'));
    assert.ok(src.includes('data-testid="user-menu-card-bell"'));
    // No plan tier → no badge: the card must not fake an "Ultra".
    assert.ok(src.includes("{planTier ? ("));
  });
});

describe("55c project context menu (session-tree.tsx, ref-26)", () => {
  const src = read("../components/session-tree.tsx");

  test("context menu is a right-click Dropdown with all five entries", () => {
    assert.ok(src.includes('trigger={["contextMenu"]}'));
    for (const key of ["rename", "pin", "reveal", "archive", "remove"]) {
      assert.ok(src.includes(`key: "${key}"`), `${key} entry present`);
    }
  });

  test("reveal is live (SB-6); archive keeps its own accurate reason", () => {
    // `reveal` is CHANGED by SB-6, and the change removes a claim that
    // was never true: 在文件夹中显示 was disabled with `common.notLocal`
    // — "not applicable to the local edition" — while `POST /api/fs/reveal`
    // was implemented and registered. It is live now, disabled only when
    // the project is bound to no local directory, and the tooltip says
    // THAT. The row is sliced up to the next row with its own comment
    // stripped, so the prose quoting the retired string cannot satisfy
    // the assertion that the string is gone. This file owns the menu
    // WIRING; behaviour and bilingual coverage live in
    // `webapp/test/project-reveal.test.ts`.
    const atReveal = src.indexOf('key: "reveal"');
    const atNext = src.indexOf('key: "archive"', atReveal);
    const reveal = src
      .slice(atReveal, atNext)
      .replace(/^\s*\/\/.*$/gm, "")
      .trim();
    assert.ok(
      reveal.includes("disabled: !switchRepoPath"),
      "reveal is gated on the project having a local path, not disabled outright",
    );
    assert.ok(!reveal.includes("disabled: true"), "reveal is not a hard placeholder");
    assert.ok(
      reveal.includes('runProjectReveal(switchRepoPath, t("projectMenu.revealInFolder")'),
      "reveal posts the project's own path",
    );
    assert.ok(
      reveal.includes('t("projectMenu.revealUnavailableNoPath")'),
      "reveal's disabled reason names the real condition",
    );
    assert.ok(
      !reveal.includes('t("common.notLocal")'),
      "the retired notLocal claim must be gone from the row",
    );

    // `archive` is CHANGED by PB-1, and deliberately. The old expectation
    // asserted `common.notLocal`, which was wrong twice over: it claimed
    // the local build lacks a capability it has always had (the
    // SESSION-level 归档 in the same file is now live and calls
    // `archiveSession`), and it said nothing about what is actually
    // missing. What is missing is a project-SCOPED bulk archive — v2
    // declares `archiveSession({id, archived})` for one session and
    // nothing project-wide — so the item keeps its `disabled: true` and
    // gains a tooltip that says so. Both halves are asserted: an item
    // that silently stopped being disabled, and an item that stayed
    // disabled for a reason that is no longer true, are the two ways this
    // drifts.
    const atArchive = atNext;
    const archive = src.slice(atArchive, atArchive + 1600);
    const marker = 't("projectMenu.archiveUnavailable")';
    assert.ok(archive.includes("disabled: true"), "archive stays disabled");
    assert.ok(
      archive.includes(marker),
      "archive's disabled reason must name the missing project-scoped bulk archive",
    );
    assert.ok(
      !archive.slice(0, archive.indexOf(marker)).includes('t("common.notLocal")'),
      "archive must no longer claim the local build lacks archiving",
    );
  });

  test("remove is the danger row and batch-deletes behind a confirm", () => {
    const at = src.indexOf('key: "remove"');
    const slice = src.slice(at, at + 600);
    assert.ok(slice.includes("danger"), "remove row uses the danger tone");
    assert.ok(src.includes("setConfirmRemove(true)"), "remove opens the confirm");
    assert.ok(
      src.includes("api.deleteSession(id)"),
      "the batch walks the existing single-session delete endpoint",
    );
    assert.ok(src.includes('data-testid="project-remove-confirm"'));
  });

  test("the delete walks subagent rows too (no orphan children)", () => {
    assert.ok(
      src.includes("session.children.map((child) => child.id)"),
      "child session ids are collected into the delete set",
    );
  });

  test("the confirm quotes the TRUE deletion set, not the pill's main count (F1)", () => {
    // The body's {count} must be filled from allSessionIds.length (main +
    // subagent). The under-counting bug was exactly this replace feeding on
    // project.sessionCount, so the wrong spelling is pinned out.
    const at = src.indexOf('data-testid="project-remove-confirm"');
    const slice = src.slice(at, src.indexOf("projectMenu.removeConfirmAuthNote"));
    assert.ok(
      slice.includes("String(allSessionIds.length)"),
      "confirm body count = allSessionIds.length",
    );
    assert.ok(
      !slice.includes("project.sessionCount"),
      "confirm body must NOT quote the pill's main-session count",
    );
  });

  test("the confirm pre-announces the authorization prompts and shows progress (F2)", () => {
    assert.ok(
      src.includes('t("projectMenu.removeConfirmAuthNote")'),
      "auth-prompt count note rendered in the confirm",
    );
    assert.ok(
      src.includes('t("projectMenu.removeProgress")'),
      "live progress line rendered while removing",
    );
    assert.ok(
      src.includes('data-testid="project-remove-progress"'),
      "progress line is addressable",
    );
  });

  test("customizations are cleared only on FULL success, through the tree root (N3)", () => {
    // The clear call must be gated on !failed and routed via the
    // onProjectRemoved prop (which updates the in-memory customs state),
    // never a direct clearProjectCustomizations inside ProjectNode.
    const at = src.indexOf("if (!failed) onProjectRemoved(project.key);");
    assert.ok(at >= 0, "clear is gated on full success");
    const nodeStart = src.indexOf("function ProjectNode");
    const nodeSrc = src.slice(nodeStart, src.indexOf("function DirectoryNode"));
    assert.ok(
      !nodeSrc.includes("clearProjectCustomizations"),
      "ProjectNode does not clear the overlay directly",
    );
    assert.ok(
      nodeSrc.includes("onProjectRemoved"),
      "ProjectNode routes the clear through the prop",
    );
  });

  test("rename / pin ride the browser-local overlay module", () => {
    assert.ok(src.includes("setProjectTitle"), "rename commits through the overlay");
    assert.ok(src.includes("toggleProjectPinned"), "pin toggles through the overlay");
    assert.ok(
      src.includes("setCustoms(clearProjectCustomizations(key))"),
      "the tree root clears a removed project's customizations in state AND storage",
    );
  });
});

describe("55c home quick-capability capsules (chat.tsx, ref-28)", () => {
  const src = read("../components/chat.tsx");

  test("five capsules render in the reference's order", () => {
    const order = ["video", "vibe", "design", "product", "askMcode"]
      .map((id) => src.indexOf(`id: "${id}"`))
      .filter((at) => at >= 0);
    assert.equal(order.length, 5, "all five chips defined");
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "reference order kept");
  });

  test("the video chip carries the H3 badge", () => {
    assert.ok(src.includes('badge: "H3"'), "H3 badge on the video chip");
    assert.ok(src.includes("home-quick-capability-${chip.id}-badge"));
  });

  test("clicking a chip answers with the 本地版不适用 toast, never a launch", () => {
    assert.ok(src.includes("onCapClick(chip.id)"), "click handler wired");
    assert.ok(src.includes('data-testid="home-quick-capability-toast"'));
    assert.ok(
      src.includes('t("common.notLocal")'),
      "the toast body is the shared notLocal string",
    );
    // The placeholder chips must not send anything — no sendMessage /
    // sendCommand call may hang off the capsule strip.
    const section = src.slice(
      src.indexOf("QUICK_CAPABILITIES.map"),
      src.indexOf("home-quick-capability-toast") + 400,
    );
    assert.ok(!section.includes("api.send"), "capsules stay non-sending placeholders");
  });

  test("the old emoji-chip draft is gone (replaced by the icon pills)", () => {
    assert.ok(!src.includes("SHOW_SUGGESTIONS"), "the hold-back flag was removed");
    assert.ok(!src.includes("SUGGESTIONS:"), "the emoji chip list was removed");
  });

  test("toast wiring: the chip click dispatches into capToastReducer (M6)", () => {
    // QA M6 hollowed out the handler's body while keeping the call site —
    // every assertion above stayed green. The wiring is pinned by its two
    // dispatch spellings now: the reducer must actually receive the click,
    // and the timer must actually dismiss through the stamp it observed.
    assert.ok(
      src.includes('from "@/lib/cap-toast"'),
      "chat.tsx pulls the reducer from the import-clean module",
    );
    assert.ok(
      src.includes("useReducer(capToastReducer, null)"),
      "toast state is the reducer's, not a bare useState",
    );
    assert.ok(
      src.includes('dispatchToast({ type: "click", id, now: Date.now() })'),
      "the click handler's body dispatches the click action",
    );
    assert.ok(
      src.includes('dispatchToast({ type: "dismiss", at: toast.at })'),
      "the timer dismisses through the observed stamp",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Cap-toast state machine — BEHAVIOUR tests on the import-clean reducer
//    (QA M6: the click→toast contract had to be testable without a render
//    harness; hollowing the handler body or breaking the reducer semantics
//    now fails here, not just in a source grep)
// ---------------------------------------------------------------------------

describe("55c capToastReducer — the capsule toast state machine (M6)", () => {
  test("a click from the resting state shows the clicked chip's toast", () => {
    const next = capToastReducer(null, { type: "click", id: "video", now: 1000 });
    assert.deepEqual(next, { key: "video", at: 1000 });
  });

  test("a newer click REPLACES the showing toast (one toast, latest reason)", () => {
    const first = capToastReducer(null, { type: "click", id: "video", now: 1000 });
    const second = capToastReducer(first, { type: "click", id: "askMcode", now: 2000 });
    assert.deepEqual(second, { key: "askMcode", at: 2000 });
  });

  test("a dismiss clears the toast only when the stamp matches its own timer", () => {
    const toast = capToastReducer(null, { type: "click", id: "design", now: 1000 });
    assert.equal(
      capToastReducer(toast, { type: "dismiss", at: 1000 }),
      null,
      "matching stamp dismisses",
    );
  });

  test("a stale timer cannot dismiss a newer toast (stamp guard)", () => {
    const first = capToastReducer(null, { type: "click", id: "video", now: 1000 });
    const second = capToastReducer(first, { type: "click", id: "vibe", now: 2000 });
    // The timer scheduled for `first` fires after `second` replaced it.
    assert.deepEqual(
      capToastReducer(second, { type: "dismiss", at: 1000 }),
      second,
      "stale stamp leaves the newer toast showing",
    );
  });

  test("a dismiss against the resting state is a no-op", () => {
    assert.equal(capToastReducer(null, { type: "dismiss", at: 12345 }), null);
  });
});
