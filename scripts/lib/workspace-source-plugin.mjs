import { existsSync } from "node:fs";
import path from "node:path";

// Resolve `@mavis/*` (and other workspace package) specifiers to their checked-in
// TypeScript sources during the standalone esbuild step. Each workspace package
// is `private: true` and does not produce its own `dist/`, so the bundle cannot
// follow the `exports` map verbatim — `./dist/x.js` is rewritten to `./src/x.ts`
// (with `.d.ts` and bare `.js` -> `.ts`) so the esbuild plugin emits the actual
// source instead of a phantom import. The factory takes the same `root` and
// `packages` map that `scripts/build.mjs` builds from `release/extraction.json`,
// so the resolver sees the same package layout as the rest of the build.
export function createWorkspaceSourcePlugin({ root, packages }) {
  return {
    name: "standalone-workspace-sources",
    setup(bundler) {
      bundler.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => {
        const parts = specifier.split("/");
        const name = specifier.startsWith("@")
          ? parts.slice(0, 2).join("/")
          : parts[0];
        const pkg = packages.get(name);
        if (!pkg) return undefined;
        const subpath =
          specifier === name ? "." : `.${specifier.slice(name.length)}`;
        const exports = pkg.manifest.exports;
        const exported =
          exports?.[subpath] ?? (subpath === "." ? exports : undefined);
        const target =
          (typeof exported === "string"
            ? exported
            : (exported?.types ?? exported?.import ?? exported?.default)) ??
          (subpath === "." ? pkg.manifest.types : undefined);
        if (typeof target !== "string" || !target.startsWith("./"))
          throw new Error(`Unmapped workspace export: ${specifier}`);
        const source = target
          .replace(/^\.\/dist\//, "./src/")
          .replace(/\.d\.ts$/, ".ts")
          .replace(/\.js$/, ".ts");
        const directory = path.join(root, pkg.directory);
        const resolved = path.resolve(directory, source);
        if (
          path.relative(directory, resolved).startsWith("..") ||
          !existsSync(resolved)
        )
          throw new Error(`Missing workspace source: ${specifier}`);
        return { path: resolved };
      });
    },
  };
}