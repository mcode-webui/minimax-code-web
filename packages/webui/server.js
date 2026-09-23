// mcode-webui — source-mode entry.
//
// The checked-in entry is only used in a source checkout: the built
// runtime runs dist/webui/server.js, an esbuild bundle with every
// workspace import inlined, and never touches this file.
//
// In a checkout there is no built @mavis/* dist (every workspace
// package is `private: true` and `exports` points at non-existent
// `./dist/*.js`), so this file does two things before delegating:
//
//   1. register the source-mode workspace resolver (tsx for
//      transpilation + a resolve hook that maps @mavis/* to the
//      workspace TypeScript sources under packages/<pkg>/src/);
//   2. dynamically import ./server/bootstrap.js, which contains the
//      real startup and stays unchanged between source and bundle.
//
// Run directly:
//   node packages/webui/server.js
// (No `--import tsx` needed; workspace-sources.js handles it.)

import { registerWorkspaceSources } from "./server/lib/workspace-sources.js";

await registerWorkspaceSources();
await import("./server/bootstrap.js");
