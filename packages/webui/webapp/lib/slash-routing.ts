/**
 * Which endpoint a typed slash input belongs to.
 *
 * Why this module exists: the composer used to route on the leading
 * slash alone — `content.startsWith("/")` sent EVERY `/`-prefixed
 * input to `POST /api/cmd`, an endpoint that claims exactly eight
 * button commands. Everything else (`/goal <text>`, `/compact`, …)
 * came back `200 {ok:true}`, cleared the composer, and did nothing
 * (webui-parity 62 D4). The routing therefore has to ask "is this a
 * command /api/cmd actually implements?" — and the answer must not be
 * a second, drifting copy of that set.
 *
 * Single source of truth: `server/lib/interaction/command-registry.js`
 * owns the set; the 400 branch of /api/cmd reads it to name the
 * accepted commands. The array below is the browser's MIRROR of it, and
 * `webapp/test/slash-routing.test.ts` drives both sides in one test —
 * it compares this array against the server registry AND against the
 * `case` labels parsed out of the two dispatchers in
 * `interaction/commands.js`, so a command added on either side without
 * the other fails the gate. The mirror exists because the browser
 * bundle cannot import a server module; nothing else reads this array,
 * and no other place in the webapp decides where a slash input goes.
 *
 * Everything outside the set goes to `/api/send`, which is the correct
 * destination and not merely a fallback: `handleLocalSlash` consumes
 * the webui-local typed commands (`/goal`, `/goal-done`,
 * `/goal-blocked`, …) and its `default` branch hands the input to the
 * engine unchanged, so `/compact` and every other engine command
 * reaches mcode instead of dying in a webui endpoint that never
 * implemented it.
 *
 * The second responsibility of this module is the AUTHORING side of the
 * same concern: what the composer's slash palette may do to the input
 * box, and what it must never do to it. The two decisions live here
 * because they are one contract — a completed command must still be the
 * string `routeSlashInput` would route, so the completion text and the
 * routing rule are pinned by the same test file.
 */

/**
 * The commands `POST /api/cmd` claims, without the leading slash.
 * Mirror of `CMD_BUTTON_COMMAND_NAMES` in
 * `server/lib/interaction/command-registry.js`.
 */
export const CMD_BUTTON_COMMANDS = [
  "new",
  "clear",
  "status",
  "sessions",
  "review",
  "help",
  "usage",
  "stop",
] as const;

export type CmdButtonCommand = (typeof CMD_BUTTON_COMMANDS)[number];

/**
 * Where a composer submission must go.
 *
 * `command` — POST /api/cmd, carrying the bare `/name` form.
 * `message` — POST /api/send, carrying the user's text unchanged.
 */
export type SlashRoute =
  | { readonly kind: "command"; readonly cmd: `/${CmdButtonCommand}` }
  | { readonly kind: "message" };

/**
 * The name an /api/cmd command would be matched under, or `null` when
 * the input is not the bare `/name` form that endpoint implements.
 *
 * `handleCmdCommand` strips one leading slash and matches the WHOLE
 * remainder, so `/clear now` is not a member of the set — the trailing
 * argument makes it a different string. Mirroring that rule here keeps
 * the browser from sending a form the server will reject: `/clear now`
 * goes to /api/send, where `handleLocalSlash` parses the command name
 * and applies the same destructive gate.
 */
function cmdButtonName(content: string): CmdButtonCommand | null {
  if (!content.startsWith("/")) return null;
  const name = content.slice(1);
  return (CMD_BUTTON_COMMANDS as readonly string[]).includes(name)
    ? (name as CmdButtonCommand)
    : null;
}

/**
 * Route one composer submission. Anything that is not an exact
 * `/api/cmd` command — a plain message, a typed command with
 * arguments, an engine command, or a command nobody implements — is a
 * message.
 *
 * The input is trimmed first, matching the server (`handleCmd` does the
 * same before dispatching), so a stray trailing space cannot push a
 * real command onto the message path.
 */
export function routeSlashInput(content: string): SlashRoute {
  const name = cmdButtonName(content.trim());
  return name === null
    ? { kind: "message" }
    : { kind: "command", cmd: `/${name}` };
}

/**
 * Keys the slash palette may consume while it is open.
 *
 * `Tab` accepts the highlighted candidate. `Enter` is deliberately NOT
 * in this set, and the candidate count is deliberately NOT an input:
 *
 * The engine reports every command in two groups (its own `mcode` list
 * and the webui button list), and the composer flattens both, so a
 * fully-typed `/status` has TWO identical candidates. A rule of the
 * form "Enter completes while the list is ambiguous" therefore fired on
 * a completely unambiguous command and swallowed the keystroke that
 * was supposed to run it — the reported defect was "Enter does not
 * send".
 *
 * The rejected alternative was to let Enter accept the candidate after
 * the user had moved the highlight with an arrow key, and send
 * otherwise. It keeps a muscle memory, but it makes one key mean two
 * things depending on state the user did not necessarily set (hover
 * moves the highlight too), and the failure mode is silent: a command
 * the user did not type is what runs. Enter means "run what I typed" in
 * every editor, and `routeSlashInput` already knows what that is. Tab
 * and the palette rows cover the "I meant the other one" case.
 */
export function shouldCompleteSlashWord(key: string): boolean {
  return key === "Tab";
}

/**
 * The text a completed candidate puts in the input box.
 *
 * `availableCommands` carries BARE names — the engine advertises
 * `name: "status"`, and the webui group is the same shape — while the
 * input box holds the `/status` form `routeSlashInput` parses. Writing
 * the name back verbatim produced `status `, and the next Enter then
 * sent a plain chat message to the engine instead of running the
 * command, because a string without the leading slash is not a command
 * to anything downstream.
 *
 * The trailing space is what closes the palette: the composer keeps it
 * open only while the whole value is one slash-word.
 *
 * Leading slashes on the incoming name are stripped first, so the
 * function is total: whatever shape a command group ever reports, the
 * box ends up with exactly one.
 */
export function completeSlashWord(name: string): string {
  return `/${name.replace(/^\/+/, "")} `;
}
