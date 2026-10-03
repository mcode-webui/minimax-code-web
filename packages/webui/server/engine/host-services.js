// webui/server/engine/host-services.js
//
// The host-services window (placeholder batch PB-8): the one place webui
// code asks the live catalogue host for its `services` object.
//
// Why this file exists at all. The engine abstraction gave webui three
// ways to reach a runtime capability, and only two of them carry most of
// the catalogue:
//
//   1. `host.application` — the process-local product facade (events,
//      models, skills, plugins, permissions, miniApps …). PB-5 / PB-6 /
//      PB-9 route through this one.
//   2. `host.applications` — the generated feature applications
//      (`session.query` / `lifecycle` / `root` / `diff`, `queue`).
//      PB-1 / PB-2 route through this one.
//   3. `host.services` — the V2 owner graph itself, handed over by
//      `createCatalogueHost` (providers/local-runtime-v2.js). This is
//      where `agent`, `managedWorktrees`, `pinService`, `mcp`, `skill`,
//      `modelSystem`, `workspace`, `canvas`, `browserUse` and the rest
//      live, and for several of them it is the ONLY route: the
//      process-local facade declares no `agent` member at all, so an
//      Agent endpoint reading `host.application` finds nothing to call.
//
// PB-7 (agents) and PB-3 (worktrees) are both blocked on this window.
// Everything else in the placeholder series may use it or ignore it.
//
// What this batch deliberately does NOT do:
//
//   - It wires NO route. An endpoint is not a member of this batch; the
//     consumer batches own their own capability gate (hard 501 or soft
//     report), because only they know whether their endpoint can
//     degrade. A window that arrived with a route attached would make
//     that decision for them by accident.
//   - It does NOT touch `runtimeOwnerKind`. See F-13 below.
//   - It does NOT probe, normalise, wrap or copy the object. The
//     returned value is the runtime's own object, by reference. A
//     facade that cloned it would freeze the truth at open time and
//     hide the next `undefined`.
//
// F-13 — why `services.cron` reads `undefined` here, and why that is
// not this batch's bug to fix. `RuntimeServices.cron` is typed
// `readonly cron?: CronService` and is documented in
// `packages/local-runtime-v2/src/services.ts` as "Electron-only
// scheduled execution capability; absent on embedded CLI". webui boots
// the host with `runtimeOwnerKind: "tui"` (the embedded capability
// ceiling), so the cron owner is never composed and the member is
// absent — `services.cron === undefined`, not null and not a stub.
// Whether the embedded CLI/TUI owner SHOULD get a cron owner is an
// open decision (F-13); this window reports the composition honestly so
// the decision can be made once and read everywhere. Consumers that
// need cron must gate on its presence rather than assume it.
//
// The return contract, stated because both answers are meaningful:
//
//   - `null`      — there is no host. Same answer `getEngineCatalogueHost`
//                  gives for a runtime that failed to boot, passed
//                  through unchanged so a caller cannot mistake "no
//                  runtime" for "runtime without services".
//   - `undefined` — there IS a host, and it carries no `services` (a
//                  non-V2 host). Distinct from `null` on purpose.
//   - `object`    — the runtime's own `RuntimeServices`. Individual
//                  members may still be `undefined` (cron, above, plus
//                  the other owner-kind-gated members `channelSystem`
//                  and `llmContextInspector`); that is the truth, not a
//                  failure, and each consumer batch verifies its own
//                  members before building on them.
//
// Boot-path discipline, unchanged from engine/host.js: this module
// imports nothing heavy. The host getter is reached through the
// facade's own dynamic import, so adding the window costs a function
// definition and nothing else — `engine/index.js` can re-export it
// without pulling the `@mavis` / `@minimax` package trees into every
// server start.

import { getEngineCatalogueHost } from "./host.js";

/**
 * The catalogue host's `services` object, by reference.
 *
 * @param {object} [deps]
 * @param {() => Promise<object|null>} [deps.getHost] Host getter seam;
 *        defaults to the engine facade's `getEngineCatalogueHost`. It
 *        exists so a test can hand in a host without booting a runtime
 *        — the same injection shape `routes/plugins.js` uses for
 *        `getCliService`. Passing a getter that throws is the caller's
 *        problem: the error propagates unchanged, exactly as it does
 *        through `getEngineCatalogueHost`.
 * @returns {Promise<object|null|undefined>} The host's `services`, or
 *   `null` when there is no host, or `undefined` when the host carries
 *   none. See the module header for why all three are distinct.
 */
export async function getHostServices(deps = {}) {
  const getHost = deps.getHost ?? getEngineCatalogueHost;
  const host = await getHost();
  if (!host) {
    // No runtime at all. Forwarding the host getter's own "no host"
    // answer keeps the two failure modes apart: a caller that maps
    // `null` to RUNTIME_UNAVAILABLE must not fire for a host that
    // simply lacks the member.
    return null;
  }
  // `??` would fold a present-but-undefined member into `null` and lose
  // the distinction the header promises. Read the member as-is: an
  // absent one is the honest answer, and this window never fabricates
  // a placeholder object for a consumer to mistake for a real owner.
  return host.services;
}
