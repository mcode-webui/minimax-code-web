// webapp/test/markdown-code-wrap.test.ts
//
// Static-source tripwires for webui-parity 52: markdown codeblocks
// (chat messages, activity groups, markdown file previews) follow the
// `file_line_wrap` switch, and their idle-state scrollbar is visible.
//
// Why a static tripwire: the webapp suite has no DOM render harness
// (see markdown-html-render.test.ts's header for the history), and the
// wiring under test IS static — a modifier class on the MarkdownHtml
// host plus a cascade override sheet. What a regression can silently
// break, these tests pin:
//
//   1. MarkdownHtml reads `readFileLineWrap()` (ticket 48's key, no
//      new key) and mounts `markdown-code-wrap` on its host when the
//      switch is on. Every markdown surface renders through this one
//      host, so the class here covers chat, activity groups and file
//      previews alike.
//
//   2. The override sheet exists, loads after official-utilities.css
//      (same-specificity rules win by source order), and carries the
//      load-bearing declarations: idle thumb colours, the dark-mode
//      hover re-asserts, the chat-content scrollbar-height restore,
//      and the wrap modifier's `pre-wrap` pair.
//
//   3. official-utilities.css stays untouched: the vendored upstream
//      sheet must keep its transparent-scrollbar rules, because the
//      fix is an override layer, not an edit. If the vendored rule
//      ever disappears upstream, this pin tells the next sync the
//      override sheet needs re-checking.
//
// The live render-path check (screenshots of both switch states,
// chat + preview, against an isolated dev instance) is the
// development self-check recorded in the ticket, not this file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const hostSource = readFileSync(resolve(here, "../components/markdown-html.tsx"), "utf8");
const layoutSource = readFileSync(resolve(here, "../app/layout.tsx"), "utf8");
const overridesCss = readFileSync(resolve(here, "../styles/markdown-overrides.css"), "utf8");
const utilitiesCss = readFileSync(
  resolve(here, "../styles/official-utilities.css"),
  "utf8",
);

describe("markdown code wrap — host wiring (ticket 52)", () => {
  test("MarkdownHtml reads the ticket-48 key, not a new one", () => {
    assert.match(hostSource, /readFileLineWrap/);
    assert.doesNotMatch(hostSource, /localStorage\.getItem/);
  });

  test("the host mounts the modifier class only when the switch is on", () => {
    // The template literal must produce exactly the two classNames the
    // CSS keys on: bare host, or host + modifier.
    assert.match(
      hostSource,
      /className=\{`markdown-html-host\$\{lineWrap \? " markdown-code-wrap" : ""\}`\}/,
    );
  });
});

describe("markdown code wrap — override sheet cascade", () => {
  test("markdown-overrides.css loads after official-utilities.css", () => {
    const utilitiesAt = layoutSource.indexOf('"../styles/official-utilities.css"');
    const overridesAt = layoutSource.indexOf('"../styles/markdown-overrides.css"');
    assert.ok(utilitiesAt >= 0, "official-utilities.css import present");
    assert.ok(overridesAt >= 0, "markdown-overrides.css import present");
    assert.ok(
      utilitiesAt < overridesAt,
      "markdown-overrides.css must load after official-utilities.css",
    );
  });

  test("the scroll container is real: the code element is blockified", () => {
    // The parser emits a bare <code> with plain text (no .shiki
    // wrapper), so it stays inline and upstream's `overflow:auto`
    // on it is ignored — long lines spilled with nothing to scroll.
    // Without this declaration every scrollbar rule is dead styling.
    const blockify = overridesCss.match(
      /\.codeblock-shell \.codeblock-code \{[^}]*\}/,
    );
    assert.ok(blockify, "codeblock-code blockify rule exists");
    assert.match(blockify[0], /display:\s*block/);
  });

  test("idle scrollbar thumb is faintly visible in both themes", () => {
    assert.match(overridesCss, /\.codeblock-shell \.codeblock-code \{\s*scrollbar-color: var\(--opacity_black_1_8\) #0000;/);
    assert.match(overridesCss, /\.dark \.codeblock-shell \.codeblock-code \{\s*scrollbar-color: var\(--opacity_white_0_8\) #0000;/);
    assert.match(overridesCss, /\.codeblock-shell \.codeblock-code::-webkit-scrollbar-thumb \{\s*background: var\(--opacity_black_1_8\);/);
    assert.match(overridesCss, /\.dark \.codeblock-shell \.codeblock-code::-webkit-scrollbar-thumb \{\s*background: var\(--opacity_white_0_8\);/);
  });

  test("dark-mode hover re-asserts upstream's deepened thumb", () => {
    // Our dark idle rules tie upstream's `.codeblock-shell:hover`
    // selectors on specificity and load later; without these
    // re-asserts a hovered dark-mode block stays at the idle grey.
    assert.match(overridesCss, /\.dark \.codeblock-shell:hover \.codeblock-code \{\s*scrollbar-color: var\(--utility_scrollbar\) #0000;/);
    assert.match(overridesCss, /\.dark \.codeblock-shell:hover \.codeblock-code::-webkit-scrollbar-thumb \{\s*background: var\(--utility_scrollbar\);/);
  });

  test("chat content's collapsed webkit scrollbar is restored", () => {
    // official-utilities.css forces `height:0!important` under
    // `.message-container-chat-content`; chat.tsx mounts that class.
    // Same selector + !important loaded later wins.
    const restore = overridesCss.match(
      /\.message-container-chat-content \.codeblock-shell \.codeblock-code::-webkit-scrollbar \{[^}]*\}/,
    );
    assert.ok(restore, "chat-content scrollbar restore rule exists");
    assert.match(restore[0], /height:\s*6px\s*!important/);
  });

  test("wrap modifier wraps code lines and suppresses the ghost rail", () => {
    const wrapRule = overridesCss.match(
      /\.markdown-code-wrap \.codeblock-shell \.codeblock-code \{[^}]*\}/,
    );
    assert.ok(wrapRule, "wrap modifier rule exists");
    assert.match(wrapRule[0], /white-space:\s*pre-wrap/);
    assert.match(wrapRule[0], /overflow-wrap:\s*anywhere/);
    assert.match(wrapRule[0], /overflow-x:\s*hidden/);
    assert.match(
      overridesCss,
      /\.markdown-code-wrap \.codeblock-shell \.codeblock-code::-webkit-scrollbar \{\s*display: none !important;/,
    );
  });
});

describe("markdown code wrap — selector hygiene", () => {
  // Every rule in the override sheet must scope its code/pre targeting
  // through a class (.codeblock-shell / .markdown-code-wrap / …). A
  // bare `code`/`pre` element selector anywhere in the sheet would
  // also match code.inline-code — inline code in prose — and restyle
  // it (the acceptance review's P3: the display:block rule extended
  // to a bare `code{}` would silently break inline code while every
  // other assertion in this file stays green).
  //
  // A "bare" segment is a tag token with no class constraint of its
  // own: `code`, `code:hover`, or `pre` appearing as one of the
  // space/>/+/~-separated segments of a selector part. `pre.codeblock-pre`
  // is fine — the tag is constrained by a class in the same compound.
  function bareTagSelectors(css: string): string[] {
    const offenders: string[] = [];
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of noComments.matchAll(/([^{}]+)\{/g)) {
      const selectorList = rule[1];
      if (!selectorList) continue;
      for (const part of selectorList.split(",")) {
        const selector = part.trim();
        if (selector === "" || selector.startsWith("@")) continue;
        const segments = selector.split(/[\s>+~]+/).filter(Boolean);
        if (segments.some((seg) => /^(code|pre)(:|$)/i.test(seg))) {
          offenders.push(selector);
        }
      }
    }
    return offenders;
  }

  test("the override sheet never targets bare code/pre element selectors", () => {
    assert.deepEqual(bareTagSelectors(overridesCss), []);
  });

  test("the bare-selector detector itself catches the regression shapes", () => {
    // Self-proof of the sentinel above: the exact shapes a future
    // edit might introduce, none of which any other assertion in
    // this file notices.
    const hostile = [
      "/* prose mentioning code { is ignored */",
      ".codeblock-shell .codeblock-code { display: block; }",
      "code { display: block; }",
      ".dark pre { overflow-x: hidden; }",
      "pre:hover, .codeblock-shell .codeblock-code { color: red; }",
      "span > code:first-child { color: red; }",
      "pre.codeblock-pre { margin: 0; }",
    ].join("\n");
    assert.deepEqual(bareTagSelectors(hostile), [
      "code",
      ".dark pre",
      "pre:hover", // from the comma list — only the bare part offends
      "span > code:first-child",
    ]);
  });
});

describe("markdown code wrap — upstream sheet stays untouched", () => {
  test("official-utilities.css keeps its transparent idle scrollbar", () => {
    // The override layer only works because the vendored sheet below
    // it still declares the transparent idle state. If an upstream
    // sync removes or changes these declarations, re-check the
    // override sheet's specificity assumptions.
    assert.match(
      utilitiesCss,
      /\.codeblock-shell \.codeblock-code \{[^}]*scrollbar-color:#0000 #0000/,
    );
    assert.match(
      utilitiesCss,
      /\.message-container-chat-content \.codeblock-shell \.codeblock-code::-webkit-scrollbar \{[^}]*height:0!important/,
    );
  });
});
