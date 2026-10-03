// webui/test/helpers/pin-transport.mjs
//
// Pins `MCODE_WEBUI_TRANSPORT` for ONE test file, at MODULE SCOPE,
// before any webui server module is evaluated.
//
// Why module scope and not a `before()` hook: `server/lib/config.js`
// resolves the transport into a frozen `export const` when it is first
// evaluated (the B0 lesson — the value must not be re-read per call).
// A `before()` that assigned `process.env` would run long after that
// module is in the registry, so the route would still see the ambient
// value. Mutating the environment from a module that is itself imported
// FIRST is the only injection point that is guaranteed to run before
// the first `import "../lib/config.js"` in the graph — ES module
// evaluation follows import order.
//
// Why a file would need it: a test that installs a FAKE ACP transport
// (a `t.mock.module` of `../acp.mjs` with a scripted client) is testing
// the ACP path, and saying so is more honest than letting it follow
// whatever transport the suite happens to run under. Before M3-B8 the
// send endpoint had no other transport to follow, so no test had to say
// so; B8 gave it a sibling and the declaration became necessary.
//
// The default is `acp`, which is also the server's own default, so
// pinning is a no-op under the acp gate and only does work under
// `MCODE_WEBUI_TRANSPORT=runtime`.
//
// Usage — as the FIRST import in the file:
//
//   import "../helpers/pin-transport.mjs";
//   import { test } from "node:test";
//
// The side effect is the whole API; there is nothing to import.

const PINNED = "acp";

// Only write when it differs, so a suite that already runs under the
// pinned value leaves the environment exactly as it found it.
if ((process.env.MCODE_WEBUI_TRANSPORT || "") !== PINNED) {
  process.env.MCODE_WEBUI_TRANSPORT = PINNED;
}
