// webapp/test/settings-account-readout.test.ts
//
// SB-5 — the settings account section reads `GET /api/account`.
//
// Why pure-function tests plus a static tripwire, and not a render test: the
// webapp suite has no render harness (see settings-parity-nav.test.ts's header
// for the standing rule), but the account section is deliberately
// import-clean — React, `lib/api`, `lib/i18n` and the Token Plan card's
// `planNameOf` — so the pure resolvers CAN be driven directly. That covers
// the part that decides what the user reads; the tripwire below covers the
// wiring the resolvers cannot see (which endpoint, which plan resolver, and
// what the section must NOT grow into).
//
// What is pinned, and the defect each guard exists for:
//
//   - `quotaWindowReading`: an unmetered window must NOT become 剩余 0%, and
//     a window with no percentage must NOT become 0% either. Both are the
//     same fabricated reading from two different engine payloads.
//   - `accountNameOf` / `accountQuotaOf`: `ok: false` is an unreachable
//     surface, not an empty account — it must yield no readings rather than
//     zeroed ones.
//   - `accountStatusOf`: a status token the dictionary has no sentence for
//     must resolve to null instead of leaking a raw enum into the UI.
//   - The wiring: one read of `GET /api/account`, the plan name through
//     SB-7's `planNameOf` (two definitions of "is there a name to show?" is
//     the drift this guards), no limit bars (the Token Plan card's job), and
//     a sign-out button that stays disabled.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  accountNameOf,
  accountQuotaOf,
  accountReasonOf,
  accountStatusOf,
  quotaWindowReading,
} from "../components/settings-account-section";

const here = dirname(fileURLToPath(import.meta.url));
const sectionSource = readFileSync(
  resolve(here, "../components/settings-account-section.tsx"),
  "utf8",
);
const portSource = readFileSync(
  resolve(here, "../components/settings-modal-port.tsx"),
  "utf8",
);
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");

const READY = {
  ok: true,
  status: "ready" as const,
  identity: { name: "Ada" },
  tokenPlanQuotaState: "available" as const,
  tokenPlan: { tier: "Max" },
  quota: {
    fiveHour: { remainingPercent: 62, resetAtMs: 1, unlimited: false },
    weekly: { remainingPercent: 41, resetAtMs: 2, unlimited: false },
  },
};

describe("quotaWindowReading: an unmetered window is a reading, not a zero", () => {
  test("an unlimited window carries no percentage at all", () => {
    assert.deepEqual(quotaWindowReading({ unlimited: true }), {
      remainingPercent: null,
      unlimited: true,
    });
  });

  test("a metered window with no figure is null, not 0", () => {
    assert.deepEqual(quotaWindowReading({ unlimited: false }), {
      remainingPercent: null,
      unlimited: false,
    });
  });

  test("an absent window is null — the engine said nothing about it", () => {
    assert.equal(quotaWindowReading(undefined), null);
    assert.equal(quotaWindowReading(null), null);
  });

  test("a percentage is carried through, clamped to 0..100", () => {
    assert.equal(quotaWindowReading({ remainingPercent: 62 })?.remainingPercent, 62);
    assert.equal(quotaWindowReading({ remainingPercent: -5 })?.remainingPercent, 0);
    assert.equal(quotaWindowReading({ remainingPercent: 140 })?.remainingPercent, 100);
  });

  test("a non-numeric figure is treated as absent, never as 0", () => {
    assert.equal(
      quotaWindowReading({ remainingPercent: "62" as unknown as number })?.remainingPercent,
      null,
    );
    assert.equal(
      quotaWindowReading({ remainingPercent: Number.NaN })?.remainingPercent,
      null,
    );
  });
});

describe("accountNameOf: no name is a fact, not an excuse to invent one", () => {
  test("the reported name comes back trimmed", () => {
    assert.equal(accountNameOf(READY), "Ada");
    assert.equal(accountNameOf({ ok: true, identity: { name: "  Ada  " } }), "Ada");
  });

  test("an answer with no identity yields no name", () => {
    assert.equal(accountNameOf({ ok: true }), null);
    assert.equal(accountNameOf({ ok: true, identity: { name: "   " } }), null);
  });

  test("a failed surface yields no name — unreachable is not empty", () => {
    assert.equal(accountNameOf({ ok: false, reason: "no_client" }), null);
    assert.equal(accountNameOf(null), null);
    assert.equal(accountNameOf(undefined), null);
  });
});

describe("accountQuotaOf: the quota overview of one account answer", () => {
  test("both windows and the state come from the same projection", () => {
    const readout = accountQuotaOf(READY);
    assert.equal(readout.state, "available");
    assert.equal(readout.fiveHour?.remainingPercent, 62);
    assert.equal(readout.weekly?.remainingPercent, 41);
  });

  test("a not-subscribed plan reports the state and no readings", () => {
    const readout = accountQuotaOf({ ok: true, tokenPlanQuotaState: "not-subscribed" });
    assert.equal(readout.state, "not-subscribed");
    assert.equal(readout.fiveHour, null);
    assert.equal(readout.weekly, null);
  });

  test("a failed surface reports nothing at all — never a zero quota", () => {
    const readout = accountQuotaOf({ ok: false, reason: "unauthorized" });
    assert.deepEqual(readout, { state: null, fiveHour: null, weekly: null });
  });

  test("an absent state is null, distinct from a reported one", () => {
    assert.equal(accountQuotaOf({ ok: true }).state, null);
  });
});

describe("accountReasonOf and accountStatusOf", () => {
  test("the engine's machine-readable reason survives to the UI", () => {
    assert.equal(accountReasonOf({ ok: false, reason: "no_client" }), "no_client");
  });

  test("a failure with no reason falls back to the endpoint's own string", () => {
    assert.equal(accountReasonOf({ ok: false }), "account_unavailable");
    assert.equal(accountReasonOf({ ok: false, reason: "  " }), "account_unavailable");
    assert.equal(accountReasonOf(READY), null, "a success has no failure reason");
  });

  test("every projected status maps to a sentence", () => {
    for (const status of ["ready", "needs-login", "warning", "unknown"] as const) {
      assert.equal(accountStatusOf({ ok: true, status }), status);
    }
  });

  test("a status the dictionary has no sentence for resolves to null", () => {
    assert.equal(
      accountStatusOf({ ok: true, status: "migrating" as "ready" }),
      null,
      "a raw enum must not leak into the UI",
    );
    assert.equal(accountStatusOf({ ok: false }), null);
    assert.equal(accountStatusOf(null), null);
  });
});

describe("SB-5 wiring: the section reads the engine, and only the engine", () => {
  test("the account tab mounts the reading section, not the old empty row", () => {
    assert.match(portSource, /<AccountSection t=\{t\} \/>/);
    assert.doesNotMatch(
      portSource,
      /settings\.account\.localLoggedOut/,
      "the hardcoded 「本地模式，未登录」 claim is what SB-5 removes",
    );
  });

  test("exactly one read of GET /api/account, on mount", () => {
    assert.match(sectionSource, /api\s*\n?\s*\.getAccount\(\)/);
    assert.equal(
      (sectionSource.match(/api\s*\n?\s*\.getAccount\(\)/g) ?? []).length,
      1,
      "a second read would be a second source of truth for the same row",
    );
  });

  test("the plan name goes through SB-7's resolver, not a second copy", () => {
    assert.match(
      sectionSource,
      /import \{ planNameOf \} from "\.\/usage-models-cards";/,
    );
    assert.match(sectionSource, /planNameOf\(account\)/);
  });

  test("no limit bars and no fabricated defaults in this section", () => {
    // The Token Plan card owns the 限额条; a bar here would be the same gauge
    // in two places, and its readings come from a different endpoint.
    assert.doesNotMatch(sectionSource, /<UsageBar|UsageBar\(/);
    assert.doesNotMatch(sectionSource, /Progress|role="progressbar"/);
    assert.doesNotMatch(
      sectionSource,
      /\?\?\s*"|\|\|\s*"(Max|Pro|Ada|Local user)/,
      "no default name, tier or figure may be hardcoded next to the read",
    );
  });

  test("sign-out stays disabled, with the honest tooltip", () => {
    const button = sectionSource.slice(
      sectionSource.indexOf('title={t("settings.account.signOutUnavailable")}') - 200,
      sectionSource.indexOf('title={t("settings.account.signOutUnavailable")}') + 120,
    );
    assert.match(button, /disabled/, "the engine has no sign-out method to call");
  });

  test("every placeholder sentence names the endpoint it could not read", () => {
    for (const key of ["unavailable", "unavailableReason", "nameMissing"]) {
      assert.match(
        i18nSource,
        new RegExp(`"settings\\.account\\.${key}"[\\s\\S]{0,160}?GET /api/account`),
        `settings.account.${key} must point the reader at the source`,
      );
    }
  });

  test("the retired hardcoded claims have no dictionary entry left", () => {
    for (const key of ["settings.account.info", "settings.account.localLoggedOut"]) {
      assert.doesNotMatch(
        i18nSource,
        new RegExp(`"${key.replace(/\./g, "\\.")}"`),
        `${key} described a state the read now answers`,
      );
    }
  });
});
