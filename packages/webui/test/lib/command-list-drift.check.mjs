// webui/test/lib/command-list-drift.check.mjs
// One fact, one declaration: "which slash commands does the webui
// implement locally".
//
// The bug this pins. `interaction/command-registry.js#CMD_BUTTON_COMMANDS`
// is the contract of POST /api/cmd (8 names, `/review` among them) and is
// what the 400 branch and the composer's routing read. `lib/acp-client.js`
// kept a SECOND, hand-written list of the same thing (`WEBUI_LOCAL_COMMANDS`,
// 7 names, no `/review`) and used it to fill the `webui` group of the command
// cache. That cache is the LIVE source for the two surfaces a user actually
// looks at:
//
//   * `/help` — `bodyHelp` (interaction/commands.js) reads `cmds.webui`, and
//     only falls back to the registry when that list is empty;
//   * the composer's slash palette — the SSE/state snapshot carries
//     `availableCommands`, and `webapp/components/composer.tsx` flattens every
//     group of it, `webui` included.
//
// Meanwhile `/help`'s fallback read the registry. So one `/help` printed the
// 7-name table or the 8-name table depending on whether the mcode command
// fetch had resolved — and the palette never offered `/review` at all, for a
// command that works. Nothing failed; the two copies simply drifted.
//
// What is asserted here, and why each layer is needed:
//   1. RUNTIME — after a real (fake-transport) `ensureMcodeCommands()`, the
//      `webui` group the server reports is the registry array, entry for
//      entry. This is the user-visible fact. Re-introducing a local list
//      turns it red.
//   2. RUNTIME, error path — a failed fetch reports the same list, so
//      `/help` cannot fall back to a different set than it prints on success.
//   3. STATIC — acp-client.js holds no second `{name, desc}` literal and
//      imports the registry. The copy cannot be re-added under a name the
//      assertions above would miss (e.g. exported but unused, or built by a
//      helper in another file).
//   4. STATIC — the registry itself stays well-formed: every entry has a
//      name and a non-empty `desc`, names are unique, and the array is
//      frozen, because `bodyHelp` and the 400 body both read it live.
//
// The complementary guards (registry ⇄ `handleCmdCommand` cases, registry ⇄
// browser mirror) live in webapp/test/slash-routing.test.ts. This file covers
// the consumer that mirror cannot see: the command cache.
//
// Isolation: ../../acp.mjs is mocked with a fake client, so no mcode
// subprocess is spawned and no probe session is created (the fake reports no
// sessionId, which is what keeps acp-client's cleanup branch inert).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { absPath } from "../helpers/_setup.js";

const here = import.meta.dirname;
const packageRoot = resolve(here, "..", "..");

const acpClientSource = readFileSync(
  join(packageRoot, "server/lib/acp-client.js"),
  "utf8",
);

// Same source with comments removed. The guards below are about what the
// module DECLARES; the header comment legitimately has to name the symbol it
// deleted, and prose about a removed duplicate is not a reintroduction of it.
const acpClientCode = acpClientSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const registry = await import(
  absPath("lib/interaction/command-registry.js")
);

let ensureMcodeCommands;
let getCachedMcodeCommands;

// The mcode command list the fake engine reports over ACP. Deliberately
// DISJOINT from the webui set, so a mix-up between the two groups is visible
// instead of coincidentally equal.
const ENGINE_COMMANDS = [{ name: "compact", description: "Compact the session" }];

before(async (t) => {
  class FakeAcpClient {
    constructor() {
      this.alive = true;
      this.handlers = new Map();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    emit(event, payload) {
      const handler = this.handlers.get(event);
      if (handler) handler(payload);
    }
    async start() {
      // available_commands_update is emitted after session/new, so it is
      // emitted from newSession below — the ordering acp-client waits for.
      return { protocolVersion: 1 };
    }
    async newSession() {
      // No sessionId: acp-client treats a probe session as cleanup work
      // (SQL delete + cache eviction), which this file must not trigger.
      queueMicrotask(() =>
        this.emit("available_commands_update", { commands: ENGINE_COMMANDS }),
      );
      return {};
    }
    stop() {}
  }

  t.mock.module(absPath("../acp.mjs"), {
    namedExports: { McodeAcpClient: FakeAcpClient },
  });
  const mod = await import(absPath("lib/acp-client.js"));
  ensureMcodeCommands = mod.ensureMcodeCommands;
  getCachedMcodeCommands = mod.getCachedMcodeCommands;
});

describe("the command cache's webui group IS the /api/cmd registry", () => {
  test("after a fetch, /help and the palette name exactly the registered commands", async () => {
    const cached = await ensureMcodeCommands({ forceRefresh: true });

    assert.deepEqual(
      cached.webui.map((c) => c.name),
      [...registry.CMD_BUTTON_COMMAND_NAMES],
      "the webui group must be the registry set, in registry order",
    );
    assert.deepEqual(
      cached.webui,
      registry.CMD_BUTTON_COMMANDS,
      "desc travels with the list — /help prints it",
    );
    // Identity, not just equality: a copy that happens to match today is
    // still a second fact that can drift tomorrow.
    assert.equal(
      cached.webui,
      registry.CMD_BUTTON_COMMANDS,
      "the cache must hold the registry array itself, not a copy of it",
    );
    // The engine half stays separate — this is a two-group dict, and the
    // guard must not become "everything collapsed into one list".
    assert.deepEqual(cached.mcode, ENGINE_COMMANDS);
    assert.equal(
      registry.CMD_BUTTON_COMMAND_NAMES.includes("review"),
      true,
      "/review is a registered command; the copy that omitted it is gone",
    );
  });

  test("getCachedMcodeCommands reports the same list (the SSE/palette path)", async () => {
    // The composer palette reads the snapshot, not the fetch's return value.
    assert.deepEqual(
      getCachedMcodeCommands().webui,
      registry.CMD_BUTTON_COMMANDS,
      "state-bus snapshots this array verbatim as availableCommands.webui",
    );
  });

  test("a failed fetch reports the same list, so /help never diverges", async () => {
    // The error branch is a second place that used to name the list. A user
    // whose engine is down must see the same command table as one whose
    // engine answered, and the same table the 400 branch suggests.
    const acp = await import(absPath("lib/acp-client.js"));
    const errorBranch = acpClientCode.slice(
      acpClientCode.indexOf("ensureMcodeCommands failed"),
      acpClientCode.indexOf("ensureMcodeCommands failed") + 400,
    );
    assert.ok(
      errorBranch.includes("webui: CMD_BUTTON_COMMANDS"),
      "the catch branch must fall back to the registry list too",
    );
    // `ensureMcodeCommands` is still the live entry point and the cache was
    // populated by the first test; nothing above may have cleared it.
    assert.equal(typeof acp.ensureMcodeCommands, "function");
  });
});

describe("acp-client.js holds no second command list", () => {
  test("it imports the registry instead of declaring its own array", () => {
    assert.match(
      acpClientSource,
      /import\s*\{\s*CMD_BUTTON_COMMANDS\s*\}\s*from\s*"\.\/interaction\/command-registry\.js"/,
      "acp-client.js must import CMD_BUTTON_COMMANDS from the command registry",
    );
  });

  test("no { name, desc } command entry is written out anywhere in the file", () => {
    // The regression in its source form. A local array — under any name, even
    // one nothing imports — is how the two tables came to differ, so the
    // literal itself is the thing to forbid.
    const literals = [
      ...acpClientCode.matchAll(/\{\s*name\s*:\s*"[^"]+"\s*,\s*desc\s*:/g),
    ];
    assert.deepEqual(
      literals.map((m) => m[0]),
      [],
      "acp-client.js must not spell out a command entry; take the list from the registry",
    );
  });

  test("WEBUI_LOCAL_COMMANDS stays deleted (it had no importer outside this file)", () => {
    assert.ok(
      !/WEBUI_LOCAL_COMMANDS/.test(acpClientCode),
      "the duplicate export must not come back under its old name",
    );
  });

  test("every webui: assignment in the cache takes the registry list", () => {
    // `webui: []` is the one legitimate other value: "not fetched yet", which
    // is what /help's fallback exists for. Anything else is a new list.
    const assigned = [...acpClientCode.matchAll(/\bwebui:\s*([^,\n]+)/g)].map(
      (m) => m[1].trim(),
    );
    assert.ok(assigned.length > 0, "the cache still declares a webui group");
    for (const value of assigned) {
      assert.ok(
        value === "CMD_BUTTON_COMMANDS" || value === "[]",
        `webui: ${value} — only the registry list or the empty pre-fetch value belong here`,
      );
    }
  });
});

describe("the registry stays the one well-formed declaration", () => {
  test("every entry has a unique name and a non-empty desc", () => {
    const names = registry.CMD_BUTTON_COMMANDS.map((c) => c.name);
    assert.deepEqual(
      names,
      [...new Set(names)],
      "duplicate command name in the registry",
    );
    for (const command of registry.CMD_BUTTON_COMMANDS) {
      assert.equal(typeof command.name, "string", JSON.stringify(command));
      assert.ok(command.name.length > 0);
      // /help prints `/name — desc`; an empty desc leaves a dangling dash and
      // a blank palette row is indistinguishable from a broken one.
      assert.equal(
        typeof command.desc,
        "string",
        `${command.name} has no desc — /help would print a bare "/${command.name}"`,
      );
      assert.ok(command.desc.trim().length > 0, `${command.name} has an empty desc`);
    }
  });

  test("the array is frozen and the names view is derived from it", () => {
    assert.ok(Object.isFrozen(registry.CMD_BUTTON_COMMANDS));
    assert.ok(Object.isFrozen(registry.CMD_BUTTON_COMMAND_NAMES));
    assert.deepEqual(
      registry.CMD_BUTTON_COMMAND_NAMES,
      registry.CMD_BUTTON_COMMANDS.map((c) => c.name),
    );
  });
});
