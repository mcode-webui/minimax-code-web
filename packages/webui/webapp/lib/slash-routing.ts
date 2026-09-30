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
