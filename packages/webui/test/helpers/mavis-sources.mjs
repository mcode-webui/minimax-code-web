// webui/test/helpers/mavis-sources.mjs
// Side-effect module for `node --import` (see packages/webui/package.json's
// test scripts). Registers tsx + the @mavis/* resolver so any test that
// imports a workspace source via `@mavis/<pkg>/...` resolves to the
// TypeScript source under <repo>/packages/<pkg>/src/.
//
// Usage:
//   node --import tsx --import ./test/mavis-sources.mjs --test ...
// (order matters: tsx transpiles the .ts source the resolver returns,
// so the tsx loader must be installed BEFORE our resolve hook is
// registered.)

import { registerWorkspaceSources } from "../../server/lib/workspace-sources.js";

registerWorkspaceSources();
