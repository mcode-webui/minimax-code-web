// webapp/test/settings-extra-pages.test.ts
//
// Render tests for the four pure-frontend settings sub-pages (ticket 55a):
// 快捷键 / 语音 / 个性化 / 代码审查, plus the 记忆摘要 dialog.
//
// Same discipline as usage-models-cards.test.ts: the pages live in
// components/settings-extra-pages.tsx (import-clean apart from antd's
// Select / Switch) so panels.tsx's store/api graph never enters the test
// process, and every assertion runs against RENDERED markup — a token
// that is "valid but invisible here" (the light-theme track defect that
// shipped in ticket 53's first round) or a placeholder that silently
// became a fabricated value fails here, not in a source grep.
//
// The localStorage-backed text blocks hydrate from `window.localStorage`;
// the window stub is installed through Object.defineProperty BEFORE the
// module import (the same pattern settings-general-sections.test.ts
// established — settings-local reads lazily inside each function).
//
// What is pinned, and the decision each guard exists for:
//
//   - SB-2 shortcut truth: the Shortcuts page renders BOTH desktop groups
//     and, per row, the state lib/shortcuts.ts actually permits — the
//     dispatched rows (Ctrl+K, Ctrl+N, Ctrl+Alt+O, Ctrl+,) render
//     enabled with a status badge and a live ✕, the six blocked rows
//     render disabled and print the specific reason (browser-reserved
//     combination / no surface / no dictation / undecided semantics),
//     and a stored customisation renders into its box. Every printed
//     combination is cross-checked against `resolveBindings`, the same
//     function app/page.tsx dispatches through, so the page and the
//     keydown handler cannot drift apart.
//   - A1 voice placeholders: the mic dropdown's only option is the
//     standing 本地版不适用 marker (disabled); the two dictation rows
//     render 未设置.
//   - The REAL persistence: the three long-text blocks hydrate from and
//     commit through lib/settings-local.ts — a stored value renders into
//     the textarea, the save action stays disabled until the draft
//     diverges from what storage holds, and the commit helpers persist
//     before the setState forward.
//   - The 记忆摘要 dialog's permanent empty state: disabled textarea,
//     honest 0 count, 尚未生成 line, 取消 enabled / 保存 disabled.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// --- window stub (before the module import) ---------------------------------

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  },
});

import {
  CodeReviewSection,
  MemorySummaryModal,
  PersonalizationSection,
  ShortcutsSection,
  VoiceSection,
} from "../components/settings-extra-pages";
import { translate, type MessageKey } from "../lib/i18n";
import {
  ABOUT_USER_KEY,
  CODE_REVIEW_GUIDELINES_KEY,
  CUSTOM_INSTRUCTIONS_KEY,
  commitAboutUser,
  commitCodeReviewGuidelines,
  commitCustomInstructions,
  readAboutUser,
  readCodeReviewGuidelines,
  readCustomInstructions,
} from "../lib/settings-local";
import {
  SHORTCUT_BINDINGS_KEY,
  SHORTCUT_SPECS,
  resolveBindings,
} from "../lib/shortcuts";

// createElement, not JSX: this suite is a `.test.ts` file and the tsx
// loader only transpiles JSX in `.tsx`.
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
const tZh = (key: MessageKey) => translate("zh", key);

/** The OPENING TAG of the element carrying `testId`: from the `<` that
 * starts it to the `>` that closes it. Precise enough to assert that
 * control's own markup (disabled, class) regardless of attribute order,
 * and without bleeding into the neighbouring element. */
/** The value of one attribute inside the opening tag returned by
 *  `controlMarkup`. The rendered `value` is HTML-escaped (React escapes
 *  `Ctrl+,` unchanged, but a captured `Ctrl+&` would not be), so it is
 *  compared after unescaping. */
function attributeValue(tag: string, attribute: string): string | null {
  const at = tag.indexOf(`${attribute}="`);
  if (at < 0) return null;
  const end = tag.indexOf('"', at + attribute.length + 2);
  const raw = tag.slice(at + attribute.length + 2, end < 0 ? tag.length : end);
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Is the element's opening tag DISABLED? A substring check is wrong: the
 *  control classes always carry `disabled:cursor-not-allowed`, so only the
 *  attribute itself counts. */
function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=|\s|>)/.test(tag);
}

function controlMarkup(markup: string, testId: string): string {
  const at = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(at >= 0, `${testId} must render`);
  const tagStart = markup.lastIndexOf("<", at);
  const tagEnd = markup.indexOf(">", at);
  return markup.slice(tagStart, tagEnd < 0 ? markup.length : tagEnd + 1);
}

describe("ShortcutsSection states, per row, what the browser can actually do (SB-2)", () => {
  const markup = render(createElement(ShortcutsSection, { t: tZh }));

  test("the notice explains the three states and no longer claims none of it is live", () => {
    assert.ok(markup.includes('data-testid="settings-shortcuts-notice"'));
    assert.ok(!markup.includes("浏览器环境不适用"), "the A1 blanket denial is the claim being retired");
    // The honest limit is named: combinations the browser owns cannot be
    // intercepted by a page, so those rows are reference-only.
    assert.ok(markup.includes("浏览器保留"), "the notice must name the browser-reserved limit");
    assert.ok(markup.includes("已生效"), "the notice must define the live badge");
  });

  test("both reference groups render: Mini Chat (1 row) and 常用 (9 rows)", () => {
    assert.ok(markup.includes('data-testid="settings-shortcuts-group-minichat"'));
    assert.ok(markup.includes('data-testid="settings-shortcuts-group-common"'));
    assert.ok(markup.includes("Mini Chat"));
    assert.ok(markup.includes("常用"));
    const rows = markup.match(/data-testid="settings-shortcuts-row-([a-z-]+)"/g) ?? [];
    assert.equal(rows.length, 10, "ref-09 shows exactly ten rows across the two groups");
  });

  test("every row renders the combination the registry resolves, not a literal", () => {
    // Cross-checked against the resolver rather than a hand-copied table:
    // if the page and the keydown handler ever disagree, this fails.
    const resolved = resolveBindings({});
    for (const spec of SHORTCUT_SPECS) {
      const binding = resolved[spec.id];
      if (binding === null) continue;
      const value = attributeValue(controlMarkup(markup, `settings-shortcuts-binding-${spec.id}`), "value");
      assert.equal(value, binding, `${spec.id} must render its resolved combination`);
    }
  });

  test("the four dispatched rows are live, and only those carry a status badge", () => {
    const live = ["global-search", "new-task-no-project", "open-settings"];
    for (const id of live) {
      assert.ok(
        !isDisabled(controlMarkup(markup, `settings-shortcuts-binding-${id}`)),
        `${id} is dispatched by app/page.tsx — a disabled box would be a lie`,
      );
      assert.ok(
        markup.includes(`data-testid="settings-shortcuts-status-${id}"`),
        `${id} must carry a status badge`,
      );
    }
    // new-task is dispatched too, but the browser owns Ctrl+N on Windows
    // and Linux, so its box is read-only and the row prints why: a bare
    // disabled box next to a live badge would read as "not applicable".
    assert.ok(
      isDisabled(controlMarkup(markup, "settings-shortcuts-binding-new-task")),
      "new-task is not rebindable, so its box must not accept input",
    );
    assert.ok(
      markup.includes("仅 macOS 上生效"),
      "the partial row must print why the combination is platform-limited",
    );
    assert.ok(
      markup.includes('data-testid="settings-shortcuts-status-new-task"'),
      "new-task must carry a status badge",
    );
    // new-task is the one dispatched row the browser owns on Windows and
    // Linux (a new window), so it is labelled partial, not live.
    assert.ok(markup.includes("部分系统生效"), "the partial verdict must be spelled out");
    const badges = markup.match(/data-testid="settings-shortcuts-status-[a-z-]+"/g) ?? [];
    assert.equal(badges.length, 4, "only the four dispatched rows carry a badge");
  });

  test("every blocked row is disabled and names its own reason", () => {
    const reasons: [string, string][] = [
      ["mini-chat", "WebUI 没有对应功能面"],
      ["search-tasks", "浏览器保留该组合，网页无法拦截"],
      ["open-folder", "浏览器保留该组合，网页无法拦截"],
      ["hold-dictation", "WebUI 没有语音识别，不提供听写"],
      ["toggle-dictation", "WebUI 没有语音识别，不提供听写"],
      ["invert-follow-up", "操作语义尚未确定，暂不启用"],
    ];
    for (const [id] of reasons) {
      assert.ok(
        isDisabled(controlMarkup(markup, `settings-shortcuts-binding-${id}`)),
        `${id} has no honest binding and must be disabled`,
      );
      assert.ok(
        !markup.includes(`data-testid="settings-shortcuts-status-${id}"`),
        `${id} must not claim to be live`,
      );
    }
    for (const [, reason] of reasons) {
      assert.ok(markup.includes(reason), `the page must print the reason: ${reason}`);
    }
  });

  test("the two dictation rows render 未设置 with no ✕ affordance", () => {
    const unsetBindings = markup.match(/placeholder="未设置"/g) ?? [];
    assert.equal(unsetBindings.length, 2, "hold-dictation and toggle-dictation are unset");
    for (const id of ["hold-dictation", "toggle-dictation"]) {
      assert.ok(
        !markup.includes(`data-testid="settings-shortcuts-binding-${id}-clear"`),
        `an unset row must not render the clear button (${id})`,
      );
    }
  });

  test("✕ is live only where a binding can be changed", () => {
    const clears = markup.match(/data-testid="(settings-shortcuts-binding-[a-z-]+-clear)"/g) ?? [];
    assert.equal(clears.length, 8, "one clear per set row");
    for (const id of ["global-search", "new-task-no-project", "open-settings"]) {
      assert.ok(
        !isDisabled(controlMarkup(markup, `settings-shortcuts-binding-${id}-clear`)),
        `${id} is rebindable, so its ✕ must be live`,
      );
    }
    for (const id of ["search-tasks", "open-folder", "mini-chat", "invert-follow-up"]) {
      assert.ok(
        isDisabled(controlMarkup(markup, `settings-shortcuts-binding-${id}-clear`)),
        `${id} is blocked, so its ✕ must stay dead`,
      );
    }
    assert.ok(
      isDisabled(controlMarkup(markup, "settings-shortcuts-binding-new-task-clear")),
      "new-task is dispatched but not rebindable, so its ✕ must stay dead",
    );
    // The ↺ reset renders only on the Mini Chat row, which is blocked.
    assert.ok(!markup.includes('data-testid="settings-shortcuts-reset-global-search"'));
    assert.ok(
      isDisabled(controlMarkup(markup, "settings-shortcuts-reset-mini-chat")),
      "the reset affordance must be dead on a blocked row",
    );
  });
});

describe("ShortcutsSection shows the stored customisation", () => {
  test("a stored override renders into the box and is marked custom", () => {
    storage.clear();
    storage.set(SHORTCUT_BINDINGS_KEY, JSON.stringify({ "global-search": "Ctrl+Shift+P" }));
    const markup = render(createElement(ShortcutsSection, { t: tZh }));
    const box = controlMarkup(markup, "settings-shortcuts-binding-global-search");
    assert.equal(attributeValue(box, "value"), "Ctrl+Shift+P", "the stored chord must render");
    assert.ok(box.includes('data-customized="true"'), "a customised row must be marked as such");
    assert.ok(markup.includes("已生效 · 自定义"), "the badge must say the binding is custom");
  });

  test("an override stored for a blocked row does not reach the page", () => {
    storage.clear();
    storage.set(SHORTCUT_BINDINGS_KEY, JSON.stringify({ "invert-follow-up": "Ctrl+Shift+Enter" }));
    const markup = render(createElement(ShortcutsSection, { t: tZh }));
    const box = controlMarkup(markup, "settings-shortcuts-binding-invert-follow-up");
    assert.equal(
      attributeValue(box, "value"),
      "Ctrl+Enter",
      "a blocked row keeps the desktop's printed combination",
    );
    assert.ok(!markup.includes("已生效 · 自定义"), "a dropped override must not read as applied");
  });
});

describe("VoiceSection renders the A1 placeholders", () => {
  const markup = render(createElement(VoiceSection, { t: tZh }));

  test("the mic dropdown's only option is the standing marker, and it is disabled", () => {
    const mic = controlMarkup(markup, "settings-voice-mic-select");
    assert.ok(mic.includes("ant-select-disabled"), "the select must render disabled");
    assert.ok(markup.includes("本地版不适用"), "no fabricated device list may ship");
    assert.ok(!markup.includes("系统默认"), "the reference's 系统默认 entry implies a device source");
  });

  test("the two dictation rows render the desktop's unset state", () => {
    assert.ok(markup.includes('data-testid="settings-voice-hold-row"'));
    assert.ok(markup.includes('data-testid="settings-voice-toggle-row"'));
    const unset = markup.match(/placeholder="未设置"/g) ?? [];
    assert.equal(unset.length, 2);
    assert.ok(!markup.includes("-clear"), "unset rows carry no clear affordance");
  });
});

describe("PersonalizationSection: two real persisted blocks, honest memory card", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("the two text blocks render the reference titles, placeholders, ⓘ and save actions", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    for (const title of ["自定义指令", "关于你", "记忆", "主动记忆", "记忆摘要"]) {
      assert.ok(markup.includes(title), `${title} must render`);
    }
    assert.ok(markup.includes("定义 Agent 应该如何工作、回答和执行任务"));
    assert.ok(markup.includes("告诉 Agent 你的背景和长期偏好"));
    // The three ⓘ glyphs of this page (two text blocks + the memory
    // card) — the Icon renders as a bare svg, so count glyphs.
    assert.equal(
      (markup.match(/<svg/g) ?? []).length,
      3,
      "two block ⓘ glyphs plus the memory card's ⓘ",
    );
  });

  test("the save actions stay disabled while the draft equals the stored value", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    for (const testId of [
      "settings-personalization-instructions-save",
      "settings-personalization-about-save",
    ]) {
      assert.ok(
        controlMarkup(markup, testId).includes("disabled"),
        `${testId} must be disabled on an unchanged (empty) block`,
      );
    }
  });

  test("a stored value hydrates into its textarea (refresh-restore contract)", () => {
    storage.set(CUSTOM_INSTRUCTIONS_KEY, "总是用中文回复");
    storage.set(ABOUT_USER_KEY, "我是前端工程师");
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    assert.ok(markup.includes("总是用中文回复"), "custom instructions hydrate from storage");
    assert.ok(markup.includes("我是前端工程师"), "about-you hydrates from storage");
  });

  test("the memory card: both switches off and greyed with the marker, 管理 enabled", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    assert.equal(
      (markup.match(/ant-switch-disabled/g) ?? []).length,
      2,
      "记忆 and 主动记忆 both render disabled switches",
    );
    // Both render OFF: the desktop's 记忆 row shows its live blue ON
    // state, which is a capability claim this client cannot make — an
    // on-looking switch next to 本地版不适用 would be the dishonest
    // form. antd's disabled state alone also keeps a checked track at
    // full blue, so the off-state carries an opacity coat.
    assert.equal((markup.match(/ant-switch-checked/g) ?? []).length, 0);
    assert.equal((markup.match(/opacity-40/g) ?? []).length, 2);
    // Each switch row carries the standing marker line (credits-card
    // precedent) — the visible honesty signal, not a tooltip.
    assert.equal((markup.match(/本地版不适用/g) ?? []).length, 2);
    const manage = controlMarkup(markup, "settings-memory-summary-manage");
    assert.ok(!manage.includes("disabled"), "管理 opens the placeholder dialog — it must be live");
    assert.ok(markup.includes("管理"));
  });

  test("the 记忆摘要 dialog is not mounted until 管理 opens it", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    assert.ok(!markup.includes('data-testid="settings-memory-summary-modal"'));
  });
});

describe("MemorySummaryModal: the permanent empty state", () => {
  const markup = render(
    createElement(MemorySummaryModal, { t: tZh, onClose: () => {} }),
  );

  test("title, placeholder and the empty-state line all render", () => {
    assert.ok(markup.includes('data-testid="settings-memory-summary-modal"'));
    assert.ok(markup.includes("记忆摘要"));
    assert.ok(markup.includes("MiniMax 整理的长期记忆会显示在这里。"));
    assert.ok(markup.includes("尚未生成记忆摘要"));
  });

  test("the honest 0 count renders in its own slot", () => {
    const at = markup.indexOf('data-testid="settings-memory-summary-count"');
    assert.ok(at >= 0, "the count slot must render");
    const close = markup.indexOf("</span>", at);
    const count = markup.slice(at, close);
    assert.ok(count.endsWith(">0"), "the count is the summary's real length (0)");
  });

  test("textarea dead, 取消 live, 保存 disabled", () => {
    assert.ok(
      controlMarkup(markup, "settings-memory-summary-textarea").includes("disabled"),
      "no local memory source — the field cannot be editable",
    );
    assert.ok(
      !controlMarkup(markup, "settings-memory-summary-cancel").includes("disabled"),
      "取消 closes the dialog",
    );
    assert.ok(
      controlMarkup(markup, "settings-memory-summary-save").includes("disabled"),
      "保存 stays disabled: there is nothing to write",
    );
  });

  test("the dialog card paints the real surface token (light-theme visibility)", () => {
    // Regression pin (the ticket-53 lesson): an earlier revision styled the
    // card `bg-bg_default`, which is NOT a token class — tokens.css has no
    // `--bg_default` — so Tailwind silently dropped it and the dialog
    // rendered transparent over the blanket in BOTH themes. Assert the
    // class that actually resolves, and that the invalid one is gone.
    assert.ok(markup.includes("bg-bg_default_primary"), "the card carries bg_default_primary");
    assert.ok(!markup.includes("bg-bg_default "), "the non-token bg-bg_default class must not ship");
  });

  test("the blanket is fixed to the viewport — it must dim the settings sidebar too", () => {
    // Acceptance mutant M6: swapping `fixed` for `absolute` made the
    // blanket cover only the scrollable content column, and the settings
    // sidebar escaped the dim. `fixed` only spans the viewport when no
    // ancestor retains a transform — the ancestor side of that contract
    // is the fill-mode pin in settings-parity-nav.test.ts (M4).
    const root = controlMarkup(markup, "settings-memory-summary-modal");
    assert.ok(
      root.includes('class="fixed inset-0'),
      "the overlay root must be fixed to the full viewport (fixed inset-0)",
    );
    assert.ok(root.includes("z-[1010]"), "the overlay must stack above the settings modal's z-1000");
  });
});

describe("CodeReviewSection: disabled method dropdown, real guideline persistence", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("the card renders the reference's head, method row and guideline block", () => {
    const markup = render(createElement(CodeReviewSection, { t: tZh }));
    assert.ok(markup.includes('data-testid="settings-code-review-card"'));
    assert.ok(markup.includes("自定义内置代码审查指令的执行方式与审查准则"));
    assert.ok(markup.includes("审查方式"));
    assert.ok(markup.includes("子会话"));
    assert.ok(markup.includes("输入需要长期应用的代码审查规则"));
  });

  test("the method dropdown shows 子会话 as its only — disabled — option", () => {
    const markup = render(createElement(CodeReviewSection, { t: tZh }));
    const select = controlMarkup(markup, "settings-code-review-method-select");
    assert.ok(select.includes("ant-select-disabled"), "no second review mode exists locally");
  });

  test("a stored guideline hydrates; an unchanged block keeps save disabled", () => {
    storage.set(CODE_REVIEW_GUIDELINES_KEY, "不要吞异常");
    const markup = render(createElement(CodeReviewSection, { t: tZh }));
    assert.ok(markup.includes("不要吞异常"), "the guideline hydrates from storage");
    assert.ok(
      controlMarkup(markup, "settings-code-review-guidelines-save").includes("disabled"),
      "hydrated-but-unchanged is not dirty — save stays disabled",
    );
  });
});

// ---------------------------------------------------------------------------
// SB-8 (D-2) — the three stored long-text blocks say they are not injected.
//
// The texts persist and stay editable; that part was never the problem. The
// problem was that nothing reads them: a grep over the engine source found
// no `setConfigOption` (or any other channel) able to carry a custom
// instruction, a user profile, or a review guideline into a session. A field
// that saves an instruction and prints nothing about its fate reads as an
// instruction that takes effect, which is the exact claim D-2 closed.
//
// These are RENDER assertions on all three surfaces, because the note is
// prose a user reads: a key that exists in the dictionary but is not mounted
// under the field leaves the lie standing.
// ---------------------------------------------------------------------------
describe("SB-8 (D-2): every stored text block declares that it is not injected", () => {
  beforeEach(() => {
    storage.clear();
  });

  const STORED_ONLY = "已保存于本浏览器，不会注入引擎会话。";
  const SURFACES = [
    { name: "自定义指令", markup: () => render(createElement(PersonalizationSection, { t: tZh })), testId: "settings-personalization-instructions-note" },
    { name: "关于你", markup: () => render(createElement(PersonalizationSection, { t: tZh })), testId: "settings-personalization-about-note" },
    { name: "自定义审查准则", markup: () => render(createElement(CodeReviewSection, { t: tZh })), testId: "settings-code-review-guidelines-note" },
  ];

  for (const surface of SURFACES) {
    test(`${surface.name} renders the note under its field`, () => {
      const markup = surface.markup();
      const note = controlMarkup(markup, surface.testId);
      assert.ok(markup.includes(STORED_ONLY), `${surface.name} must print the honest note`);
      // The note sits BELOW the textarea, not above it: it describes what
      // saving the field does, so it reads after the field it is about.
      assert.ok(
        markup.indexOf(surface.testId) > markup.indexOf(`${surface.testId.replace("-note", "")}-textarea`),
        `${surface.name}: the note must follow the textarea`,
      );
      assert.ok(note.includes("text-text_default_tertiary"), "rendered as a caption, not as body text");
    });
  }

  test("a SAVED value still renders, and still carries the note", () => {
    // Storing stays supported — the value is the user's own text and stays
    // readable. D-2 changed the promise printed under it, nothing else.
    storage.set(CUSTOM_INSTRUCTIONS_KEY, "永远不要吞异常");
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    assert.ok(markup.includes("永远不要吞异常"), "the text still round-trips through storage");
    assert.ok(markup.includes(STORED_ONLY));
  });

  test("neither locale claims the text reaches the engine", () => {
    // The pre-D-2 surfaces carried no such claim in prose, but the
    // dictionary is where a future edit would add one back.
    for (const locale of ["en", "zh"] as const) {
      const note = translate(locale, "settings.storedOnly" as MessageKey);
      assert.match(note, /not injected|不会注入/, `${locale} note must deny injection: ${note}`);
    }
  });
});

describe("the three long-text keys (settings-local, ticket 55a)", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("the keys live in the webui- namespace (desktop key names unverified)", () => {
    assert.equal(CUSTOM_INSTRUCTIONS_KEY, "webui-custom-instructions");
    assert.equal(ABOUT_USER_KEY, "webui-about-user");
    assert.equal(CODE_REVIEW_GUIDELINES_KEY, "webui-code-review-guidelines");
  });

  test("missing / corrupted storage reads as the empty string, never throws", () => {
    storage.set(CUSTOM_INSTRUCTIONS_KEY, "\u0000corrupt");
    assert.equal(readCustomInstructions(), "\u0000corrupt", "verbatim read — no validation");
    assert.equal(readAboutUser(), "");
    assert.equal(readCodeReviewGuidelines(), "");
  });

  test("commit helpers persist BEFORE the setState forward, verbatim", () => {
    for (const [commit, key, read] of [
      [commitCustomInstructions, CUSTOM_INSTRUCTIONS_KEY, readCustomInstructions],
      [commitAboutUser, ABOUT_USER_KEY, readAboutUser],
      [commitCodeReviewGuidelines, CODE_REVIEW_GUIDELINES_KEY, readCodeReviewGuidelines],
    ] as const) {
      storage.clear();
      let observed: string | undefined;
      commit((value: string) => {
        observed = storage.get(key);
      }, "保存我");
      assert.equal(observed, "保存我", `${key}: the write must land before the forward`);
      assert.equal(read(), "保存我");
    }
  });
});
