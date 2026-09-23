// webui/server/lib/workspace-sources.js
// Single entry point for the source-mode workspace resolver.
//
// Why a single function:
//   The webui server (source layout) and its unit tests both need:
//     1. tsx — transpiles the resolved .ts source on load
//     2. workspace-source-hooks — resolves `@mavis/*` specifiers to
//        the workspace src/ directory (because no built dist/ exists)
//   Registering both in the same order everywhere keeps "source mode"
//   and "tests" working from the same import graph.
//
// tsx caveat (deviation from the task spec's literal `register("tsx/esm", ...)`):
//   tsx's `initialize` hook throws if it is invoked without a `data`
//   argument. In Node >= 22 that means `register("tsx/esm", parentURL)`
//   fails with "tsx must be loaded with --import instead of --loader"
//   because the new `register()` API does not pass `data` unless the
//   caller does so explicitly. The task spec validated empirically
//   against an older tsx where this was not enforced, or where the
//   caller is the launcher which always passes data. We pass the
//   minimum data tsx needs (an empty tsconfig option) so that
//   `node packages/webui/server.js` works on its own. If a future tsx
//   version makes the data requirement stricter, the only alternative
//   is to launch with `node --import tsx packages/webui/server.js`.
//
// Caveat: node:module's `register()` is the modern (Node >= 22)
// equivalent of `--loader`. It registers the resolver hook for ALL
// subsequent `import()` calls in this process. Tests that need a
// different module set up their own `--import` chain in
// `packages/webui/package.json`'s test scripts.
//
// Idempotent: calling `registerWorkspaceSources()` twice is a no-op
// after the first call. Tests that load server/lib/*.js directly
// (and therefore never go through server.js) can import this module
// and call it themselves.

import { register } from "node:module";
import { fileURLToPath } from "node:url";

let _registered = false;

export function registerWorkspaceSources() {
  if (_registered) return;
  _registered = true;
  // tsx first: it needs to be active to transpile any .ts source the
  // resolver hook returns. register() accepts the loader specifier
  // exactly like --import / --loader do. We pass an empty options
  // object so tsx's `initialize` data check passes.
  try {
    register("tsx/esm", import.meta.url, { data: { tsconfig: false } });
  } catch {
    // If tsx is already loaded via `--import tsx`, its register call
    // throws a duplicate-loader error. That's fine; the existing
    // instance will handle transpilation.
  }
  // Then our resolve hook. Pass the file URL of the hooks file as
  // the parentURL so node:module can locate it relative to this
  // module — the hook uses fileURLToPath(import.meta.url) to discover
  // the repo root, which still works inside the hook whether it's
  // loaded via register() or directly.
  register(
    new URL("./workspace-source-hooks.mjs", import.meta.url),
    fileURLToPath(import.meta.url),
  );
}
