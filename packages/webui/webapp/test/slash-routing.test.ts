// webapp/test/slash-routing.test.ts
//
// The composer used to route on the leading slash alone:
// `content.startsWith("/")` sent every `/`-prefixed input to
// POST /api/cmd, an endpoint that claims exactly eight button
// commands. `/goal <text>` — implemented on the /api/send path, in
// handleLocalSlash — came back `200 {ok:true}`, cleared the composer
// and did nothing (webui-parity 62 D4).
//
// This file pins the three things that have to hold for the fix to
// survive the next command that gets added:
//
//   1. THE DECISION (pure, no React): /api/cmd commands go to
//      sendCommand; typed webui commands (/goal, /goal-done,
//      /goal-blocked), engine commands (/compact) and plain messages
//      all go to sendMessage — the endpoint whose default branch
//      forwards unknown input to the engine.
//   2. THE SET CANNOT DRIFT: the browser mirror, the server registry,
//      and the two dispatchers' `case` labels in
//      interaction/commands.js are compared against each other. A
//      command added to one side and not the others fails here.
//   3. THE WIRING: composer.tsx must call routeSlashInput at the
//      dispatch site and must no longer branch on `startsWith("/")`.
//      The reducers are pure, so a revert to the old branch would keep
//      every other webapp test green — only this tripwire goes red.
//
// The server module is imported through a file:// URL, the same way
// credential-file.test.ts reaches the server side.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import { CMD_BUTTON_COMMANDS, routeSlashInput } from "../lib/slash-routing";
import {
  getComposerDraft,
  mergeRestoredDraft,
  resetComposerDraftForTests,
  setComposerDraft,
} from "../lib/composer-draft";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const serverAbsPath = (rel: string) =>
  pathToFileURL(join(packageRoot, "server", rel)).href;

const registry = await import(
  serverAbsPath("lib/interaction/command-registry.js")
);

const commandsSource = readFileSync(
  join(packageRoot, "server/lib/interaction/commands.js"),
  "utf8",
);
const composerSource = readFileSync(
  resolve(here, "../components/composer.tsx"),
  "utf8",
);

describe("routeSlashInput — where a composer submission goes", () => {
  test("a /api/cmd command goes to sendCommand", () => {
    for (const name of CMD_BUTTON_COMMANDS) {
      assert.deepEqual(
        routeSlashInput(`/${name}`),
        { kind: "command", cmd: `/${name}` },
        `/${name} is an /api/cmd command`,
      );
    }
    // Walk the SERVER's registry too, not only the browser mirror: a
    // mirror that forgot a command would otherwise satisfy a test
    // written against the mirror. Every name the server claims must
    // reach sendCommand, or the button command quietly degrades into a
    // message.
    for (const name of registry.CMD_BUTTON_COMMAND_NAMES) {
      assert.deepEqual(
        routeSlashInput(`/${name}`),
        { kind: "command", cmd: `/${name}` },
        `the server claims /${name}, so the composer must route it to /api/cmd`,
      );
    }
  });

  test("a typed webui command goes to sendMessage, NOT sendCommand", () => {
    // The D4 repro, verbatim. handleLocalSlash implements these; the
    // /api/cmd dispatcher does not, so sending them there was the
    // silent drop.
    for (const input of [
      "/goal 绘制绘.html讲述一个成语故事",
      "/goal",
      "/goal-done",
      "/goal-blocked",
    ]) {
      assert.deepEqual(
        routeSlashInput(input),
        { kind: "message" },
        `${input} must be a message`,
      );
    }
  });

  test("an engine command goes to sendMessage (its default branch forwards it)", () => {
    for (const input of ["/compact", "/model", "/init", "/agent"]) {
      assert.deepEqual(routeSlashInput(input), { kind: "message" }, input);
    }
  });

  test("a plain message goes to sendMessage", () => {
    for (const input of [
      "hello",
      "",
      "  ",
      "路径/中间有斜杠",
      "2026/09/30 复盘",
    ]) {
      assert.deepEqual(routeSlashInput(input), { kind: "message" }, input);
    }
  });

  test("a button command with a trailing argument is a message, not a 400", () => {
    // handleCmdCommand matches the WHOLE remainder after the slash, so
    // `/clear now` is a different string to it than `/clear`. Sending
    // it there would earn a 4xx; /api/send parses the name and runs
    // the same gated handler.
    assert.deepEqual(routeSlashInput("/clear now"), { kind: "message" });
    assert.deepEqual(routeSlashInput("/new session"), { kind: "message" });
    assert.deepEqual(routeSlashInput("/status "), {
      kind: "command",
      cmd: "/status",
    });
  });

  test("near-miss spellings are not button commands", () => {
    for (const input of ["/Clears", "/clea", "/clearx", "//clear", "/ clear"]) {
      assert.deepEqual(routeSlashInput(input), { kind: "message" }, input);
    }
  });
});

describe("command set — browser mirror, server registry, dispatchers", () => {
  test("the webapp mirror equals the server registry", () => {
    assert.deepEqual(
      [...CMD_BUTTON_COMMANDS].sort(),
      [...registry.CMD_BUTTON_COMMAND_NAMES].sort(),
      "webapp/lib/slash-routing.ts drifted from the server command registry",
    );
  });

  test("the registry's /help fallback is the same set", () => {
    // commands.js derives LOCAL_HELP_FALLBACK from the registry, so
    // /help and the 400 body can never describe different sets.
    assert.ok(
      commandsSource.includes("CMD_BUTTON_COMMANDS"),
      "commands.js must build its /help fallback from the registry",
    );
    assert.deepEqual(
      registry.CMD_BUTTON_COMMANDS.map((c: { name: string }) => c.name),
      [...registry.CMD_BUTTON_COMMAND_NAMES],
    );
  });

  test("every registered name is a case label in handleCmdCommand", () => {
    const body = commandsSource.slice(
      commandsSource.indexOf("export async function handleCmdCommand"),
    );
    const cases = new Set(
      [...body.matchAll(/case "([\w-]+)":/g)].map((m) => m[1]),
    );
    // `new` is handled by an explicit `if (name === "new")` before the
    // switch (it carries guards the switch form cannot express).
    for (const m of body.matchAll(/name === "([\w-]+)"/g)) cases.add(m[1]);
    for (const name of registry.CMD_BUTTON_COMMAND_NAMES) {
      assert.ok(cases.has(name), `handleCmdCommand has no case for /${name}`);
    }
  });

  test("the cmd dispatcher claims exactly the registered names", () => {
    const body = commandsSource.slice(
      commandsSource.indexOf("export async function handleCmdCommand"),
    );
    const cases = new Set(
      [...body.matchAll(/case "([\w-]+)":/g)].map((m) => m[1]),
    );
    for (const m of body.matchAll(/name === "([\w-]+)"/g)) cases.add(m[1]);
    assert.deepEqual(
      [...cases].sort(),
      [...registry.CMD_BUTTON_COMMAND_NAMES].sort(),
      "handleCmdCommand implements a command the registry does not declare " +
        "(or the registry declares one it does not implement)",
    );
  });

  test("the send-path declaration matches handleLocalSlash's cases", () => {
    const body = commandsSource.slice(
      commandsSource.indexOf("export async function handleLocalSlash"),
      commandsSource.indexOf("export async function handleCmdCommand"),
    );
    const cases = [...body.matchAll(/case "([\w-]+)":/g)].map((m) => m[1]);
    assert.deepEqual(
      cases.sort(),
      [...registry.SEND_SLASH_COMMANDS].sort(),
      "SEND_SLASH_COMMANDS drifted from handleLocalSlash — the 400 hint " +
        "would point a user at a command that does not exist",
    );
  });

  test("the registry's own predicates agree with the arrays", () => {
    for (const name of registry.CMD_BUTTON_COMMAND_NAMES) {
      assert.equal(registry.isCmdButtonCommand(name), true, name);
      assert.equal(routeSlashInput(`/${name}`).kind, "command", name);
    }
    for (const name of registry.SEND_SLASH_COMMANDS) {
      assert.equal(registry.isSendSlashCommand(name), true, name);
    }
    assert.equal(registry.isCmdButtonCommand("goal"), false);
    assert.equal(registry.isSendSlashCommand("compact"), false);
    assert.equal(registry.isCmdButtonCommand(""), false);
  });
});

describe("composer wiring — the router decides, not the leading slash", () => {
  test("submit routes through routeSlashInput at the dispatch site", () => {
    assert.ok(
      /import\s+\{[^}]*\brouteSlashInput\b[^}]*\}\s+from\s+["']@\/lib\/slash-routing["']/.test(
        composerSource,
      ),
      "routeSlashInput must be imported from @/lib/slash-routing",
    );
    const routeIdx = composerSource.indexOf("routeSlashInput(content)");
    const sendIdx = composerSource.indexOf("await api.send");
    assert.ok(routeIdx > 0, "submit must call routeSlashInput(content)");
    assert.ok(sendIdx > routeIdx, "the route must be decided before dispatch");
  });

  test("the leading-slash branch is gone (this is the D4 revert)", () => {
    assert.ok(
      !/content\.startsWith\("\/"\)/.test(composerSource),
      'composer.tsx must not branch on content.startsWith("/") — that is ' +
        "the routing that sent /goal and /compact to an endpoint which " +
        "never implemented them",
    );
  });

  test("the command branch sends the ROUTED command, not the raw content", () => {
    assert.ok(
      /if\s*\(route\.kind === "command"\)\s*await api\.sendCommand\(route\.cmd\)/.test(
        composerSource,
      ),
      "the command branch must send route.cmd",
    );
  });
});

describe("rejected submissions come back into the composer", () => {
  test("a rejected command with an empty box restores exactly the command", () => {
    const draft = mergeRestoredDraft(
      { value: "", error: null, attachments: [] },
      { content: "/goal 绘制绘.html讲述一个成语故事", attachments: [] },
    );
    assert.equal(draft.value, "/goal 绘制绘.html讲述一个成语故事");
    assert.deepEqual(draft.attachments, []);
  });

  test("interim text is kept, with the rejected command after it", () => {
    const draft = mergeRestoredDraft(
      { value: "我还想问", error: null, attachments: [] },
      { content: "/clear", attachments: [] },
    );
    assert.equal(draft.value, "我还想问\n\n/clear");
  });

  test("a whitespace-only draft is treated as empty", () => {
    const draft = mergeRestoredDraft(
      { value: "   ", error: null, attachments: [] },
      { content: "/compact", attachments: [] },
    );
    assert.equal(draft.value, "/compact");
  });

  test("restored attachments come first, interim ones after", () => {
    const draft = mergeRestoredDraft(
      { value: "", error: null, attachments: ["/b.png"] },
      { content: "/goal", attachments: ["/a.png"] },
    );
    assert.deepEqual(draft.attachments, ["/a.png", "/b.png"]);
  });

  test("the restore lands in the module-scope draft store", () => {
    // The store is what survives the composer remount; writing the
    // merged patch into it is the difference between "the text came
    // back" and "the text came back until the next re-render".
    resetComposerDraftForTests();
    setComposerDraft({ value: "", attachments: [] });
    setComposerDraft(
      mergeRestoredDraft(getComposerDraft(), {
        content: "/stop",
        attachments: [],
      }),
    );
    assert.equal(getComposerDraft().value, "/stop");
    resetComposerDraftForTests();
  });

  test("the catch branch restores through mergeRestoredDraft", () => {
    // The restore is the last line of defence for a rejected command
    // (a 4xx from /api/cmd, a network failure): the composer was
    // optimistically cleared at dispatch, so the payload is the only
    // copy of the user's text. It has to be written back UNCONDITION-
    // ALLY on a matching context — a guard that reads right but never
    // fires (`if (false && restored)`, a negated condition, a restore
    // computed and thrown away) is the exact shape of the bug this
    // test exists to catch, so the assertion pins the guard itself,
    // not merely the presence of the helper call.
    const catchIdx = composerSource.indexOf("} catch (cause) {");
    const failIdx = composerSource.indexOf("failComposerSent({");
    assert.ok(
      failIdx > catchIdx,
      "failComposerSent must run in the catch branch",
    );

    // The statement that closes the failComposerSent call …
    const guardStart = composerSource.indexOf("});", failIdx) + 3;
    // … may be followed by comments only …
    const guardIdx = composerSource.indexOf("if (", guardStart);
    const between = composerSource
      .slice(guardStart, guardIdx)
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(
      between.trim(),
      "",
      "only comments may sit between the fail call and its restore guard",
    );
    // … and that guard must be the plain matching-context check.
    assert.equal(
      composerSource.slice(guardIdx, guardIdx + "if (restored) {".length),
      "if (restored) {",
      "the restore must be guarded by exactly `if (restored)`",
    );

    // The guarded body must actually write the merged patch.
    const guardEnd = composerSource.indexOf(
      "}",
      guardIdx + "if (restored) {".length,
    );
    const body = composerSource.slice(guardIdx, guardEnd);
    assert.ok(
      /setComposerDraft\(\s*mergeRestoredDraft\(getComposerDraft\(\),\s*restored\)\s*\)/.test(
        body,
      ),
      `the guarded body must write mergeRestoredDraft(…) back through ` +
        `setComposerDraft — a computed-but-unwritten restore silently ` +
        `drops the user's text; body: ${JSON.stringify(body)}`,
    );
  });
});
