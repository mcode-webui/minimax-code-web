// webapp/test/i18n-settings-parity.test.ts
//
// Bilingual-coverage pins for the settings-page parity rework (ticket 37).
//
// The i18n dictionary is typed (MessageKey = keyof typeof en), so a key
// referenced by a component but missing from the dictionary is a
// compile error — but nothing forces a NEW key to exist in the first
// place, and nothing at all notices a key whose zh entry was never
// added (translate falls back to en, so an English string ships to a
// Chinese-locale user). Same pattern as i18n-appearance.test.ts: pin
// both locales' values through translate().
//
// What this file pins beyond mere presence:
//   - settings.tab.usageModels is exactly 「用量与模型」 in zh — that
//     name is the desktop reference's, and the nav is the user-visible
//     contract of decision #3 (usage lives in the settings page).
//   - the usagePopover.* keys are GONE from both dictionaries. The
//     hover flyout was deleted along with its surface; leaving the
//     strings behind would be a ghost vocabulary for a widget that no
//     longer exists. translate() returns undefined for a key missing
//     from en, which is the observable form of "deleted".
//   - settings.appearance and toolbar.usage survive — the appearance
//     row label inside 通用 and the user-menu row label both still
//     read them.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { translate, type MessageKey } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));

const NEW_KEYS = [
  "settings.appearanceHint",
  "settings.languageHint",
  "settings.tab.usageModels",
  "usage.title",
  "usage.fiveHour",
  "usage.weekly",
  "usage.refresh",
  "usage.unavailable",
  "usage.errorTitle",
  "usage.errorBody",
  // Ticket 48 — General-page section titles, localStorage-backed row
  // labels/hints, the back label, and the search-clear aria label.
  "settings.clearSearch",
  "settings.section.application",
  "settings.section.file",
  "settings.section.sessionManagement",
  "settings.section.preference",
  "settings.file.openInNewTab",
  "settings.file.openInNewTabHint",
  "settings.file.lineWrap",
  "settings.file.lineWrapHint",
  "settings.session.contextWindowUsage",
  "settings.followUp.title",
  "settings.followUp.hint",
  "settings.followUp.queue",
  "settings.followUp.steer",
  // Ticket 53 — the usage-models segmented tabs, the Token Plan panel's
  // cards, and the placeholder policy strings.
  "usage.tab.tokenPlan",
  "usage.tab.inUse",
  "usage.tab.customModels",
  "usage.notLocal",
  "usage.plan.title",
  "usage.plan.upgrade",
  "usage.plan.manage",
  "usage.credits",
  "usage.plan.topUp",
  "usage.video",
  "usage.credits.hint",
  "usage.invoice.title",
  "usage.invoice.apply",
  "usage.invoice.hint",
  "usage.resetsIn",
  "usage.duration.minute",
  "usage.duration.hourMinute",
  // Ticket 55a — the four pure-frontend sub-pages: the honesty notice,
  // every row title / hint, the memory-summary dialog, the code-review
  // card, and the shared save / cancel actions.
  "common.save",
  "common.cancel",
  "settings.shortcuts.notice",
  "settings.shortcuts.group.miniChat",
  "settings.shortcuts.group.common",
  "settings.shortcuts.item.miniChat",
  "settings.shortcuts.item.miniChatHint",
  "settings.shortcuts.item.globalSearch",
  "settings.shortcuts.item.globalSearchHint",
  "settings.shortcuts.item.searchTasks",
  "settings.shortcuts.item.searchTasksHint",
  "settings.shortcuts.item.newTask",
  "settings.shortcuts.item.newTaskHint",
  "settings.shortcuts.item.newTaskNoProject",
  "settings.shortcuts.item.newTaskNoProjectHint",
  "settings.shortcuts.item.openFolder",
  "settings.shortcuts.item.openFolderHint",
  "settings.shortcuts.item.openSettings",
  "settings.shortcuts.item.openSettingsHint",
  "settings.shortcuts.item.holdDictation",
  "settings.shortcuts.item.holdDictationHint",
  "settings.shortcuts.item.toggleDictation",
  "settings.shortcuts.item.toggleDictationHint",
  "settings.shortcuts.item.invertFollowUp",
  "settings.shortcuts.item.invertFollowUpHint",
  "settings.shortcuts.unset",
  "settings.shortcuts.clear",
  "settings.shortcuts.reset",
  "settings.voice.group.regular",
  "settings.voice.group.dictation",
  "settings.voice.microphone",
  "settings.voice.microphoneHint",
  "settings.voice.holdKey",
  "settings.voice.holdKeyHint",
  "settings.voice.toggleKey",
  "settings.voice.toggleKeyHint",
  "settings.voice.unset",
  "settings.personal.instructions",
  "settings.personal.instructionsPlaceholder",
  "settings.personal.aboutYou",
  "settings.personal.aboutYouPlaceholder",
  "settings.personal.memory",
  "settings.personal.memoryHint",
  "settings.personal.proactiveMemory",
  "settings.personal.proactiveMemoryHint",
  "settings.personal.memorySummary",
  "settings.personal.memorySummaryHint",
  "settings.personal.manage",
  "settings.memory.title",
  "settings.memory.placeholder",
  "settings.memory.empty",
  "settings.memory.more",
  "settings.memory.close",
  "settings.codeReview.hint",
  "settings.codeReview.method",
  "settings.codeReview.methodSubsession",
  "settings.codeReview.guidelines",
  "settings.codeReview.guidelinesPlaceholder",
  // SB-1 — the 「用量与模型」 model-source row: the in-use badge, the
  // key-status badges, the three busy labels, and the two refusals the
  // engine can answer (no key stored yet / save before probing). The old
  // `usageModels.minimax.unavailable` claimed the local edition had no
  // MiniMax API key service at all; SB-1 gives it the only meaning that
  // is still true — the server did not report the key status.
  "usageModels.source.inUse",
  "usageModels.source.switchFailed",
  "usageModels.minimax.configured",
  "usageModels.minimax.storedPlaceholder",
  "usageModels.minimax.noKeyToTest",
  "usageModels.minimax.saveFirst",
  "usageModels.minimax.keyRequired",
  "usageModels.minimax.saved",
  "usageModels.minimax.testOk",
  "usageModels.minimax.testFailed",
  "usageModels.minimax.saving",
  "usageModels.minimax.testing",
  "usageModels.minimax.switching",
  "usageModels.minimax.loading",
] as const;

const RETIRED_USAGE_KEYS = [
  // Ticket 53's progress-bar rework replaced the label-style figures
  // ("已用 0%", "重置时间 …") with the desktop's "0% / 100%" and relative
  // "resets in" forms, so the old strings lost their last consumer.
  "usage.used",
  "usage.reset",
] as const;

const RETIRED_POPOVER_KEYS = [
  "usagePopover.title",
  "usagePopover.fiveHour",
  "usagePopover.weekly",
  "usagePopover.refresh",
  "usagePopover.unavailable",
  "usagePopover.errorTitle",
  "usagePopover.errorBody",
] as const;

describe("i18n settings parity (ticket 37)", () => {
  test("every new settings key resolves in BOTH locales", () => {
    for (const key of NEW_KEYS) {
      const messageKey = key as MessageKey;
      const en = translate("en", messageKey);
      const zh = translate("zh", messageKey);
      assert.notEqual(en, "", `en value for ${key} is empty`);
      assert.notEqual(zh, "", `zh value for ${key} is empty`);
      assert.notEqual(
        en,
        key,
        `en value for ${key} is the raw key — fallback fired`,
      );
      assert.notEqual(
        zh,
        key,
        `zh value for ${key} is the raw key — fallback fired`,
      );
      assert.notEqual(zh, undefined, `zh value for ${key} is missing entirely`);
    }
  });

  test("SB-1: the in-use badge reads the reference's 「使用中」 in Chinese", () => {
    assert.equal(translate("zh", "usageModels.source.inUse" as MessageKey), "使用中");
    assert.equal(translate("en", "usageModels.source.inUse" as MessageKey), "In use");
  });

  test("SB-1: no locale still claims the local edition lacks a MiniMax key service", () => {
    // The pre-SB-1 string was a false capability claim on a tab whose
    // backend now exists. It survives as the ONE degradation it can still
    // honestly describe, and this pins that nobody restores the claim.
    for (const locale of ["en", "zh"] as const) {
      const value = translate(locale, "usageModels.minimax.unavailable" as MessageKey);
      assert.ok(
        !/no MiniMax API key service|未接入 MiniMax API Key/.test(value),
        `${locale} still claims the key service does not exist: ${value}`,
      );
    }
  });

  test("the usage-and-models tab keeps the desktop reference's Chinese name", () => {
    assert.equal(
      translate("zh", "settings.tab.usageModels" as MessageKey),
      "用量与模型",
    );
  });

  test("ticket 48: the back label is the reference's Back to app, in both locales", () => {
    assert.equal(translate("zh", "settings.back" as MessageKey), "返回应用");
    assert.equal(translate("en", "settings.back" as MessageKey), "Back to app");
  });

  test("the retired usagePopover.* vocabulary is gone from the dictionary", () => {
    for (const key of RETIRED_POPOVER_KEYS) {
      const en = translate("en", key as unknown as MessageKey);
      const zh = translate("zh", key as unknown as MessageKey);
      assert.equal(
        en,
        undefined,
        `${key} must be removed from the en dictionary`,
      );
      assert.equal(
        zh,
        undefined,
        `${key} must be removed from the zh dictionary`,
      );
    }
  });

  test("ticket 53: the retired usage.used / usage.reset labels are gone, both locales", () => {
    for (const key of RETIRED_USAGE_KEYS) {
      const en = translate("en", key as unknown as MessageKey);
      const zh = translate("zh", key as unknown as MessageKey);
      assert.equal(
        en,
        undefined,
        `${key} must be removed from the en dictionary`,
      );
      assert.equal(
        zh,
        undefined,
        `${key} must be removed from the zh dictionary`,
      );
    }
  });

  test("ticket 53: the zh strings are the desktop reference's verbatim wording", () => {
    assert.equal(
      translate("zh", "settings.tab.usageModels" as MessageKey),
      "用量与模型",
    );
    assert.equal(
      translate("zh", "usage.tab.tokenPlan" as MessageKey),
      "Token Plan",
    );
    assert.equal(translate("zh", "usage.tab.inUse" as MessageKey), "使用中");
    assert.equal(
      translate("zh", "usage.tab.customModels" as MessageKey),
      "自定义模型",
    );
    assert.equal(
      translate("zh", "usage.notLocal" as MessageKey),
      "本地版不适用",
    );
    assert.equal(translate("zh", "usage.plan.title" as MessageKey), "当前套餐");
    assert.equal(translate("zh", "usage.plan.upgrade" as MessageKey), "升级");
    assert.equal(translate("zh", "usage.plan.manage" as MessageKey), "管理");
    assert.equal(translate("zh", "usage.credits" as MessageKey), "积分");
    assert.equal(translate("zh", "usage.plan.topUp" as MessageKey), "去充值");
    assert.equal(translate("zh", "usage.weekly" as MessageKey), "周限额");
    assert.equal(translate("zh", "usage.video" as MessageKey), "视频限额");
    assert.equal(
      translate("zh", "usage.credits.hint" as MessageKey),
      "开启后，可以在对话中消耗你的积分（含赠予积分）。",
    );
    assert.equal(translate("zh", "usage.invoice.title" as MessageKey), "发票");
    assert.equal(translate("zh", "usage.invoice.apply" as MessageKey), "申请");
    assert.equal(
      translate("zh", "usage.invoice.hint" as MessageKey),
      "请前往 MiniMax 开放平台申请发票",
    );
    assert.equal(translate("zh", "usage.resetsIn" as MessageKey), "{t}后重置");
  });

  test("ticket 55a: the zh strings are the desktop reference's verbatim wording", () => {
    // The visible furniture of the four pure sub-pages — the reference's
    // own labels (ref-08/09/10/11/22), not paraphrases.
    assert.equal(
      translate("zh", "settings.shortcuts.group.common" as MessageKey),
      "常用",
    );
    assert.equal(
      translate("zh", "settings.shortcuts.item.miniChat" as MessageKey),
      "显示或隐藏 Mini Chat",
    );
    assert.equal(
      translate("zh", "settings.shortcuts.unset" as MessageKey),
      "未设置",
    );
    assert.equal(
      translate("zh", "settings.voice.group.regular" as MessageKey),
      "常规",
    );
    assert.equal(
      translate("zh", "settings.personal.instructions" as MessageKey),
      "自定义指令",
    );
    assert.equal(
      translate("zh", "settings.personal.aboutYou" as MessageKey),
      "关于你",
    );
    assert.equal(
      translate("zh", "settings.personal.memory" as MessageKey),
      "记忆",
    );
    assert.equal(
      translate("zh", "settings.personal.proactiveMemory" as MessageKey),
      "主动记忆",
    );
    assert.equal(
      translate("zh", "settings.personal.memorySummary" as MessageKey),
      "记忆摘要",
    );
    assert.equal(
      translate("zh", "settings.personal.manage" as MessageKey),
      "管理",
    );
    assert.equal(
      translate("zh", "settings.memory.placeholder" as MessageKey),
      "MiniMax 整理的长期记忆会显示在这里。",
    );
    assert.equal(
      translate("zh", "settings.memory.empty" as MessageKey),
      "尚未生成记忆摘要",
    );
    assert.equal(
      translate("zh", "settings.codeReview.method" as MessageKey),
      "审查方式",
    );
    assert.equal(
      translate("zh", "settings.codeReview.methodSubsession" as MessageKey),
      "子会话",
    );
    assert.equal(
      translate("zh", "settings.codeReview.guidelines" as MessageKey),
      "自定义审查准则",
    );
    assert.equal(translate("zh", "common.save" as MessageKey), "保存");
    assert.equal(translate("zh", "common.cancel" as MessageKey), "取消");
  });

  test("surviving keys: the appearance row label and the menu usage label", () => {
    for (const key of ["settings.appearance", "toolbar.usage"] as const) {
      const messageKey = key as MessageKey;
      assert.notEqual(
        translate("en", messageKey),
        undefined,
        `${key} missing from en`,
      );
      assert.notEqual(
        translate("zh", messageKey),
        undefined,
        `${key} missing from zh`,
      );
      assert.notEqual(translate("zh", messageKey), "", `${key} empty in zh`);
    }
  });
});

// ---------------------------------------------------------------------------
// English-dictionary hygiene (ticket 59): the 55a/56 batch shipped 66
// en values that were copies of the zh text, and the feat-0929 merge
// re-introduced 9 duplicated providers.dialog.* keys inside BOTH
// dictionary blocks (main's English block and feat's Chinese block both
// survived the auto-merge). Both failure modes are invisible to the
// parity tests above: a Chinese value in `en` still "resolves", and a
// duplicate key still typechecks as long as the values are identical.
//
// No whitelist: files.tree.truncated (the one historical offender,
// present with a Chinese value since before this line of work) was
// fixed in the same change — any CJK value in `en` is a regression.
// ---------------------------------------------------------------------------

describe("i18n en-dictionary hygiene (ticket 59)", () => {
  const source = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");

  // Keys in declaration order, per dictionary block. Matches both the
  // single-line form ("key": "value") and the wrapped form where the
  // value starts on the next line ("key":\n    "value") — the wrapped
  // form is how prettier formats long values, and missing it once made
  // an earlier audit undercount by exactly those keys.
  const extractKeys = (block: "en" | "zh"): string[] => {
    const lines = source.split("\n");
    const keys: string[] = [];
    let mode = "";
    const opener = new RegExp(`^const ${block}\\b`);
    const other = new RegExp(`^const ${block === "en" ? "zh" : "en"}\\b`);
    for (const line of lines) {
      if (opener.test(line)) mode = block;
      else if (other.test(line)) mode = "";
      const match = mode ? line.match(/^\s*"([\w.]+)":/) : null;
      const key = match?.[1];
      if (key) keys.push(key);
    }
    return keys;
  };

  test("no en value contains CJK ideographs (an English locale must read English)", () => {
    const offenders: string[] = [];
    for (const key of extractKeys("en")) {
      const value = translate("en", key as MessageKey);
      if (value !== undefined && /[\u4e00-\u9fa5]/.test(value)) {
        offenders.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `en dictionary carries Chinese values:\n${offenders.join("\n")}`,
    );
  });

  test("neither dictionary block declares a duplicate key", () => {
    // A duplicate key inside one block means a merge kept both sides
    // (or a paste landed twice); for identical values tsc stays silent
    // and the LAST entry silently wins at runtime. The providers
    // .dialog.* pair from the 59 merge was exactly this.
    for (const block of ["en", "zh"] as const) {
      const keys = extractKeys(block);
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const key of keys) {
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
      assert.deepEqual(
        duplicates,
        [],
        `${block} block declares duplicate keys: ${duplicates.join(", ")}`,
      );
    }
  });
});
