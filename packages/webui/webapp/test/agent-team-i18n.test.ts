// webapp/test/agent-team-i18n.test.ts
// Unit tests for lib/i18n-agent-team.ts — the bilingual strings the
// Agent Team panel relies on.
//
// Coverage contract (every line is a documented acceptance fix):
//
//   1. The slice-06 i18n file MUST NOT be orphaned — every key added
//      to en MUST also exist in zh, and vice versa. The acceptance
//      pass returned "PASS-WITH-CONCERNS" specifically because the
//      previous slice shipped this file with hardcoded English
//      strings in chat.tsx and zero consumers. These tests lock the
//      keys, the resolution, and the locale symmetry so the next
//      contributor cannot silently regress.
//
//   2. `tAgentTeam(locale, key)` returns the locale-specific string,
//      falls back to en for unknown locales, and never throws on
//      missing keys.
//
//   3. `badgeLabelAndGlyph` projects the UI status to a {label, glyph}
//      pair; statuses outside the UI vocabulary return null (the
//      badge does not render, the ToolCard hides itself).
//
//   4. `agentLabel` maps the runtime-stored English token to the
//      locale-resolved label; unknown tokens fall through to the
//      fallback, never throw.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  tAgentTeam,
  badgeLabelAndGlyph,
  agentLabel,
  AGENT_TEAM_STRINGS,
} from "../lib/i18n-agent-team";

describe("i18n-agent-team — bilingual symmetry (no orphan keys)", () => {
  test("every key in en is also in zh", () => {
    const enKeys = Object.keys(AGENT_TEAM_STRINGS.en);
    const zhKeys = new Set(Object.keys(AGENT_TEAM_STRINGS.zh));
    for (const key of enKeys) {
      assert.ok(zhKeys.has(key), `${key} missing in zh bucket`);
    }
  });

  test("every key in zh is also in en (reverse direction)", () => {
    const zhKeys = Object.keys(AGENT_TEAM_STRINGS.zh);
    const enKeys = new Set(Object.keys(AGENT_TEAM_STRINGS.en));
    for (const key of zhKeys) {
      assert.ok(enKeys.has(key), `${key} missing in en bucket`);
    }
  });

  test("every localised string is non-empty", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const [key, value] of Object.entries(AGENT_TEAM_STRINGS[locale])) {
        assert.ok(typeof value === "string" && value.length > 0, `${locale}.${key} must be non-empty`);
      }
    }
  });

  test("the status labels are actually localised (en !== zh for status keys)", () => {
    // A regression where someone adds a key in only one locale would
    // ship English text to a Chinese-locale user. The exact text will
    // drift, but the two locales MUST NOT agree on every status label.
    const statusKeys = [
      "agentTeam.statusLabel.running",
      "agentTeam.statusLabel.done",
      "agentTeam.statusLabel.failed",
      "agentTeam.statusLabel.stopped",
      "agentTeam.statusLabel.queued",
    ];
    for (const key of statusKeys) {
      assert.notEqual(
        AGENT_TEAM_STRINGS.en[key as keyof typeof AGENT_TEAM_STRINGS.en],
        AGENT_TEAM_STRINGS.zh[key as keyof typeof AGENT_TEAM_STRINGS.zh],
        `${key} must differ between en and zh`,
      );
    }
  });

  test("the known agent labels are actually localised", () => {
    const agentKeys = [
      "agentTeam.agent.explore",
      "agentTeam.agent.worker",
      "agentTeam.agent.verifier",
      "agentTeam.agent.coder",
    ];
    for (const key of agentKeys) {
      assert.notEqual(
        AGENT_TEAM_STRINGS.en[key as keyof typeof AGENT_TEAM_STRINGS.en],
        AGENT_TEAM_STRINGS.zh[key as keyof typeof AGENT_TEAM_STRINGS.zh],
        `${key} must differ between en and zh`,
      );
    }
  });
});

describe("tAgentTeam — locale resolution", () => {
  test("resolves to the requested locale", () => {
    assert.equal(tAgentTeam("zh", "agentTeam.statusLabel.running"), "\u8FD0\u884C\u4E2D");
    assert.equal(tAgentTeam("en", "agentTeam.statusLabel.running"), "Running");
  });

  test("falls back to en for unknown locales (defensive)", () => {
    // The webui only ships zh / en today, but a future locale switcher
    // could pass through an unknown value. Resolve defensively.
    assert.equal(
      tAgentTeam("fr" as unknown as "zh" | "en", "agentTeam.statusLabel.running"),
      "Running",
    );
  });

  test("falls back to the raw key when the bucket is missing the entry (debug visibility)", () => {
    // A new key added to en but missed in zh would otherwise render an
    // empty badge in Chinese — show the key name instead, so a
    // regression is loud in the UI rather than silently empty.
    assert.equal(
      tAgentTeam("zh", "agentTeam.not.a.real.key" as unknown as never),
      "agentTeam.not.a.real.key",
    );
  });
});

describe("badgeLabelAndGlyph — projects UI status to {label, glyph}", () => {
  test("returns a {label, glyph} pair for every UI status the badge renders", () => {
    for (const status of ["running", "done", "failed", "stopped", "idle", "queued"]) {
      const en = badgeLabelAndGlyph("en", status);
      const zh = badgeLabelAndGlyph("zh", status);
      assert.ok(en, `en missing for status=${status}`);
      assert.ok(zh, `zh missing for status=${status}`);
      assert.ok(en.label.length > 0);
      assert.ok(en.glyph.length > 0);
      assert.notEqual(en.label, zh.label, `en/zh labels must differ for ${status}`);
    }
  });

  test("returns null for null / undefined / unknown status (no badge rendered)", () => {
    assert.equal(badgeLabelAndGlyph("en", null), null);
    assert.equal(badgeLabelAndGlyph("en", undefined), null);
    assert.equal(badgeLabelAndGlyph("en", "queued-but-not-in-vocab"), null);
    // Raw db strings must NEVER leak through — the badge contract is
    // UI vocabulary only.
    assert.equal(badgeLabelAndGlyph("en", "succeeded"), null);
    assert.equal(badgeLabelAndGlyph("en", "canceled"), null);
  });

  test("en and zh return DIFFERENT labels (locale actually does something)", () => {
    const en = badgeLabelAndGlyph("en", "running");
    const zh = badgeLabelAndGlyph("zh", "running");
    assert.ok(en && zh);
    assert.notEqual(en.label, zh.label);
  });
});

describe("agentLabel — runtime-stored agent token → locale label", () => {
  test("known tokens resolve to the locale-specific label", () => {
    assert.equal(agentLabel("en", "explore"), "Explore");
    assert.equal(agentLabel("zh", "explore"), "\u63A2\u67E5\u8005");
    assert.equal(agentLabel("en", "verifier"), "Verifier");
    assert.equal(agentLabel("zh", "verifier"), "\u9A8C\u8BC1\u8005");
  });

  test("unknown tokens fall back to the English token verbatim (forward-compat)", () => {
    // A future custom agent the frontend has not been told about
    // must still render a readable label rather than fall through to
    // the subagent fallback (which would be misleading).
    assert.equal(agentLabel("en", "future_agent"), "future_agent");
    assert.equal(agentLabel("zh", "future_agent"), "future_agent");
  });

  test("null / empty input returns the subagent fallback label (locale-specific)", () => {
    assert.equal(agentLabel("en", null), "subagent");
    assert.equal(agentLabel("zh", null), "\u5B50 agent");
    assert.equal(agentLabel("en", ""), "subagent");
    assert.equal(agentLabel("zh", undefined), "\u5B50 agent");
  });
});
