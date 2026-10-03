// webapp/test/engine-capabilities-degradation.test.ts
//
// M3-B9 — the frontend half of the mode-write capability gate.
//
// The server answers 501 when the connected provider declares no
// permission-mode / model write (see `server/engine/mode-writes.js`).
// Design §4.2 says what happens next: the entry point is HIDDEN. Not an
// error toast, not a disabled control, not a message in the transcript.
//
// The distinction is the whole point of this file, and it is the one a
// reviewer cannot check by reading the call site: a toast and a hidden
// control are both "the control reacted to a 501", and only one of them
// is right. A toast reports a failure for something the user was never
// able to do, offers nothing to act on, and reappears on every click.
//
// Three things are pinned, and they are three different failure modes:
//
//   1. THE RULE, over every declaration shape the network can produce —
//      including the ones that must NOT hide anything. The rule is
//      fail-open, and the cases below are what make that true rather than
//      accidental.
//   2. THE BRIDGE MIRROR. The frontend names two engine sub-items the
//      server also names. Two hand-maintained copies of a set of engine
//      identifiers drift; the tripwire reads the server module's SOURCE
//      and fails when the two disagree.
//   3. THE WIRING. `components/composer.tsx` is a client component with
//      no render harness in this suite, so its half is a static-source
//      tripwire — the form this repository allows when no harness exists
//      for the component. It is a weaker proof than (1) and says so; the
//      product logic it would otherwise duplicate lives in `lib/` and is
//      tested there against the real function, not a copy.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  BRIDGED_CONFIG_SUB_ITEMS,
  bridgedControlAvailability,
  controlAvailability,
  readEngineCapabilities,
  resetEngineCapabilitiesCache,
} from "../lib/engine-capabilities";
import type { EngineCapabilities } from "../lib/engine-capabilities";

const here = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(resolve(here, "../components/composer.tsx"), "utf8");
const serverModeWritesSource = readFileSync(
  resolve(here, "../../server/engine/mode-writes.js"),
  "utf8",
);

/** The v2 declaration's two B9 keys, as the server sends them today. */
const V2_MODE_KEYS = {
  toolSkillInvocation: {
    level: "partial" as const,
    missing: ["setMode"],
    reason: "no session-mode write on the v2 surface",
  },
  authCredentials: {
    level: "partial" as const,
    missing: ["setConfigOption"],
    reason: "no generic config-option write on the v2 surface",
  },
};

describe("controlAvailability — the fail-open rule", () => {
  test("an unread declaration shows the control: `null` is not `none`", () => {
    // The whole degradation rests on this. A probe that timed out must
    // not remove a working control — that is a self-inflicted outage
    // dressed up as a feature flag.
    assert.deepEqual(controlAvailability(null, "authCredentials", "selectModel"), {
      available: true,
      reason: null,
    });
  });

  test("a declaration missing the key shows the control", () => {
    // The server validates all 14 keys, so an absent one is a malformed
    // declaration or a version skew — neither is evidence of absence.
    const caps = { authCredentials: { level: "full" } } as unknown as EngineCapabilities;
    assert.equal(controlAvailability(caps, "authCredentials", "selectModel").available, true);
  });

  test("`full` shows the control", () => {
    const caps = { authCredentials: { level: "full" } } as EngineCapabilities;
    assert.equal(controlAvailability(caps, "authCredentials", "selectModel").available, true);
    assert.equal(controlAvailability(caps, "authCredentials", "anything").available, true);
  });

  test("`none` hides the control and carries the declaration's reason", () => {
    const caps = {
      authCredentials: { level: "none", reason: "interface-absent: no such method" },
    } as EngineCapabilities;
    assert.deepEqual(controlAvailability(caps, "authCredentials", "selectModel"), {
      available: false,
      reason: "interface-absent: no such method",
    });
  });

  test("`partial` hides ONLY the sub-item it lists, and shows every other one", () => {
    const caps = { authCredentials: V2_MODE_KEYS.authCredentials } as EngineCapabilities;
    // The generic write is gone…
    assert.equal(controlAvailability(caps, "authCredentials", "setConfigOption").available, false);
    // …and the two dedicated writers are not what it denied.
    assert.equal(controlAvailability(caps, "authCredentials", "selectModel").available, true);
    assert.equal(controlAvailability(caps, "authCredentials", "setPermissionMode").available, true);
  });

  test("a `partial` with no `missing` array shows the control", () => {
    // Shape robustness: the array is typed optional, so a declaration
    // that omits it must not be read as "everything is missing".
    const caps = { authCredentials: { level: "partial" } } as unknown as EngineCapabilities;
    assert.equal(controlAvailability(caps, "authCredentials", "setConfigOption").available, true);
  });

  test("an unrecognised level shows the control — version skew is not absence", () => {
    const caps = {
      authCredentials: { level: "experimental", missing: ["selectModel"] },
    } as unknown as EngineCapabilities;
    assert.equal(controlAvailability(caps, "authCredentials", "selectModel").available, true);
  });

  test("a `none` with no reason hides but does not invent one", () => {
    const caps = { authCredentials: { level: "none" } } as unknown as EngineCapabilities;
    assert.deepEqual(controlAvailability(caps, "authCredentials", "selectModel"), {
      available: false,
      reason: null,
    });
  });
});

describe("bridgedControlAvailability — the two controls the composer renders", () => {
  test("both are available on the v2 declaration this batch ships", () => {
    const caps = { authCredentials: V2_MODE_KEYS.authCredentials } as EngineCapabilities;
    for (const id of ["model", "permissionMode"] as const) {
      assert.equal(bridgedControlAvailability(caps, id).available, true, id);
    }
  });

  test("both are hidden when the capability is `none`", () => {
    const caps = {
      authCredentials: { level: "none", reason: "test: interface-absent" },
    } as EngineCapabilities;
    for (const id of ["model", "permissionMode"] as const) {
      assert.equal(bridgedControlAvailability(caps, id).available, false, id);
    }
  });

  test("a provider that denies the DEDICATED writer hides that control and keeps the other", () => {
    // The bridge is per sub-item, so a provider can have one without the
    // other — and the composer must not hide both because one is gone.
    const caps = {
      authCredentials: { level: "partial", missing: ["selectModel"], reason: "test: no model writer" },
    } as EngineCapabilities;
    assert.equal(bridgedControlAvailability(caps, "model").available, false);
    assert.equal(bridgedControlAvailability(caps, "permissionMode").available, true);
  });

  test("an unknown config id is not a bridge — it must not inherit the exemption", () => {
    // Mirrors the server's own guard: a name nobody audited falls back
    // to the generic sub-item rather than the exemption.
    const caps = { authCredentials: V2_MODE_KEYS.authCredentials } as EngineCapabilities;
    const subItem = (BRIDGED_CONFIG_SUB_ITEMS as Record<string, string | undefined>)[
      "thinkingEffort"
    ];
    assert.equal(subItem, undefined);
    assert.equal(
      controlAvailability(caps, "authCredentials", "setConfigOption").available,
      false,
      "the generic write is what a non-bridged id asks for",
    );
  });
});

describe("the frontend and the server name the same two engine sub-items", () => {
  // The mirror is one small literal, and this is what keeps it honest.
  // A rename on either side without the other is exactly the drift the
  // server module's own header warns about.
  test("BRIDGED_CONFIG_SUB_ITEMS matches MODE_WRITE_BRIDGED_CONFIG_IDS in the server source", () => {
    const block = serverModeWritesSource.match(
      /MODE_WRITE_BRIDGED_CONFIG_IDS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/,
    );
    assert.ok(block, "the server bridge table was not found — did it move or get renamed?");
    // `assert.ok` does not narrow under this tsconfig, so the capture is
    // read through a fallback: a missing table parses to zero pairs, which
    // the assertion below reports in a readable sentence.
    const pairs = [...(block?.[1] ?? "").matchAll(/([A-Za-z0-9_]+):\s*"([^"]+)"/g)].map(
      (m) => [m[1], m[2]] as const,
    );
    assert.ok(pairs.length > 0, "the server bridge table parsed to nothing");
    assert.deepEqual(
      Object.fromEntries(pairs),
      Object.fromEntries(Object.entries(BRIDGED_CONFIG_SUB_ITEMS)),
    );
  });

  test("the server gate really does ask for the bridged sub-item, not the generic one", () => {
    // Without this, the mirror above could be faithful to a server table
    // nothing reads — a table that has drifted from the gate while both
    // copies still agree with each other.
    assert.match(
      serverModeWritesSource,
      /const bridged = MODE_WRITE_BRIDGED_CONFIG_IDS\[configId\];/,
      "the gate must resolve its sub-item through the bridge table",
    );
    assert.match(
      serverModeWritesSource,
      /typeof bridged === "string" \? bridged : need\.subItem/,
      "an unrecognised config id must fall back to the generic sub-item",
    );
  });
});

describe("the composer actually gates on it", () => {
  // Static-source tripwire: composer.tsx is a client component and this
  // suite has no render harness for it. Weak by construction, and stated
  // as such — what it catches is the realistic regression, which is a
  // later edit that drops the gate while leaving the lib alone.
  test("both controls are wrapped in their availability check", () => {
    assert.match(
      composerSource,
      /\{permissionControl\.available \? \(\s*<PermissionSelect/,
      "PermissionSelect is no longer gated on permissionControl",
    );
    assert.match(
      composerSource,
      /\{modelControl\.available \? \(\s*<ModelSelect/,
      "ModelSelect is no longer gated on modelControl",
    );
  });

  test("the availability comes from the shared rule, not from a local reading of a 501", () => {
    assert.match(composerSource, /useEngineControlAvailability\("permissionMode"\)/);
    assert.match(composerSource, /useEngineControlAvailability\("model"\)/);
    assert.match(
      composerSource,
      /bridgedControlAvailability\(declaration, configId\)/,
      "the hook must delegate to the shared rule",
    );
    // A 501 is the SERVER's answer. The composer must not be growing a
    // second interpretation of it — that is how a toast gets in.
    assert.doesNotMatch(
      composerSource,
      /engine_capability_not_supported/,
      "the composer must not branch on the 501 body; the declaration decides",
    );
  });

  test("the degradation is a hide, not a toast and not a disabled control", () => {
    // Extract the gated JSX BLOCK, not a window of characters after it.
    // A 4000-character sweep matches the next unrelated `disabled` prop
    // in the file and fails for a reason that has nothing to do with the
    // gate — which trains a reader to ignore this assertion.
    for (const [marker, control] of [
      ["{permissionControl.available ? (", "PermissionSelect"],
      ["{modelControl.available ? (", "ModelSelect"],
    ] as const) {
      const start = composerSource.indexOf(marker);
      assert.ok(start > 0, `${control}: the availability gate is gone`);
      const end = composerSource.indexOf(") : null}", start);
      assert.ok(end > start, `${control}: the gate no longer ends in \`: null\``);
      const block = composerSource.slice(start, end);
      assert.ok(block.includes(`<${control}`), `${control}: the gate does not wrap the control`);
      assert.doesNotMatch(block, /\bdisabled\b/, `${control}: hidden, not disabled`);
      assert.doesNotMatch(block, /fallback|toast/i, `${control}: hidden, with no degraded rendering`);
    }
  });

  test("there are exactly two gates, and both hide", () => {
    const gates = [...composerSource.matchAll(/(?:permission|model)Control\.available \? \(/g)];
    assert.equal(gates.length, 2, "expected exactly two availability gates");
  });
});

describe("readEngineCapabilities — never throws, and reads once", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetEngineCapabilitiesCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetEngineCapabilitiesCache();
  });

  const okResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  test("returns the declaration on a good response", async () => {
    globalThis.fetch = (async () => okResponse({ ok: true, capabilities: V2_MODE_KEYS })) as typeof fetch;
    const caps = await readEngineCapabilities();
    assert.deepEqual(caps, V2_MODE_KEYS);
  });

  test("a non-200 resolves to null rather than rejecting", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    assert.equal(await readEngineCapabilities(), null);
  });

  test("a network failure resolves to null rather than rejecting", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    assert.equal(await readEngineCapabilities(), null);
  });

  test("a 200 with the wrong shape resolves to null", async () => {
    for (const body of [{}, { capabilities: null }, { capabilities: "full" }, { capabilities: 7 }]) {
      globalThis.fetch = (async () => okResponse(body)) as typeof fetch;
      resetEngineCapabilitiesCache();
      assert.equal(await readEngineCapabilities(), null, JSON.stringify(body));
    }
  });

  test("unparseable JSON resolves to null", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>502</html>", { status: 200 })) as typeof fetch;
    assert.equal(await readEngineCapabilities(), null);
  });

  test("two controls cost one request — the declaration is shared", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return okResponse({ capabilities: V2_MODE_KEYS });
    }) as typeof fetch;
    const [a, b] = await Promise.all([readEngineCapabilities(), readEngineCapabilities()]);
    const c = await readEngineCapabilities();
    assert.equal(calls, 1, "the composer mounts two controls; it must not make two requests");
    assert.equal(a, b);
    assert.equal(b, c, "the cache must hand back the same declaration, not a fresh fetch");
  });
});
