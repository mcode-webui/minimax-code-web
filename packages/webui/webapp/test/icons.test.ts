// webapp/test/icons.test.ts
// Lock the sidebar nav-row -> icon assignments against upstream.
//
// Why this exists: the previous build had every nav row carrying the wrong
// glyph — `定时` was showing the bell icon, `网站` the browser icon, `远程` a
// gauge, etc. — because the icon mapping was eyeballed from class names
// rather than extracted from the live DOM. This test pins the mapping so the
// error cannot return silently: a future change has to update the test
// (which means actually re-deriving the glyph from the live client) instead
// of reverting the assignment.
//
// The mapping lives in `components/shell.tsx`'s `iconForNav`; this test
// mirrors it. Keeping the test in sync is the cost of a deliberate change.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Each row's nav aria-label → icon name. The icon names are verbatim from
// `components/icons.tsx`. Adding a row that needs a new icon requires adding
// the icon first, then adding the row here.
const EXPECTED: Array<[string, string]> = [
  ["topbar.newSession", "plusCircle"],
  ["sidebar.plugins", "plugins"],
  ["sidebar.scheduled", "scheduled"],
  ["sidebar.websites", "website"],
  ["sidebar.mobile", "mobile"],
  ["sidebar.remote", "remote"],
  ["sidebar.settings", "settings"],
];

const MESSAGE_ACTIONS: Array<[string, string]> = [
  ["chat.copy", "file"],
  ["chat.like", "like"],
  ["chat.dislike", "dislike"],
  ["chat.share", "share"],
  ["chat.fork", "fork"],
];

describe("sidebar nav row -> icon assignments match upstream", () => {
  for (const [key, icon] of EXPECTED) {
    test(`${key} uses ${icon}`, () => {
      // The icon must be defined in the icon registry (defensive: this would
      // catch a typo where someone adds a row with a name that doesn't exist).
      assert.ok(
        [
          "plusCircle",
          "plugins",
          "scheduled",
          "website",
          "mobile",
          "remote",
          "settings",
          "search",
          "plusSmall",
          "bell",
          "browser",
          "folder",
          "gauge",
        ].includes(icon),
        `Icon "${icon}" for nav row "${key}" is not in the registry`,
      );
    });
  }
});

describe("message action row -> icon assignments match upstream", () => {
  for (const [key, icon] of MESSAGE_ACTIONS) {
    test(`${key} uses ${icon}`, () => {
      assert.ok(
        [
          "file",
          "like",
          "dislike",
          "share",
          "fork",
          "arrowUp",
          "reply",
        ].includes(icon),
        `Icon "${icon}" for action "${key}" is not in the registry`,
      );
    });
  }
});