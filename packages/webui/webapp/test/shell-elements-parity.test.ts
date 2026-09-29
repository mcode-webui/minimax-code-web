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
    assert.ok(
      page.includes('event.key === ","') && page.includes("openSettings();"),
      "page.tsx binds Ctrl+, to openSettings — the badge must be a real binding",
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

  test("reveal / archive are disabled with the notLocal marker", () => {
    for (const key of ["reveal", "archive"]) {
      const at = src.indexOf(`key: "${key}"`);
      const slice = src.slice(at, at + 700);
      assert.ok(slice.includes("disabled: true"), `${key} disabled`);
      assert.ok(slice.includes('t("common.notLocal")'), `${key} notLocal marker`);
    }
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

  test("rename / pin ride the browser-local overlay module", () => {
    assert.ok(src.includes("setProjectTitle"), "rename commits through the overlay");
    assert.ok(src.includes("toggleProjectPinned"), "pin toggles through the overlay");
    assert.ok(
      src.includes("clearProjectCustomizations(project.key)"),
      "removing a project drops its customizations",
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
});
