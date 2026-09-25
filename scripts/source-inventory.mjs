import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { inventoryPath, readExtraction } from "./lib/release-metadata.mjs";
import { retiredSourceRoots } from "./lib/retired-sources.mjs";
import { readSuites, suiteInventoryViolations } from "./lib/vitest-suites.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skipped = new Set([
  ".git",
  "node_modules",
  "dist",
  ".cache",
  ".pnpm-store",
  ".turbo",
  ".DS_Store",
]);
// Build outputs that are not named after an entry above. These are listed by
// repository-relative path rather than by directory name on purpose: `.next` and
// `out` are generic names, and a name-wide exclusion would silently stop
// publishing any future source directory that happens to share them. Adding an
// entry here asserts that the subtree never contains publishable source.
const skippedTrees = new Set([
  "packages/webui/webapp/.next", // Next build cache
  "packages/webui/webapp/out", // Next static export (copied into dist/webui by build.mjs)
  // Vendor desktop bundle kept for parity research. Listed by repository-
  // relative path because "desktop-unpacked" is not a generic build-output
  // name; the bundle is intentionally NOT published, and chunks inside
  // contain internal hostnames that `internalText` would otherwise flag.
  // Regained by `packages/webui/desktop-unpacked/extract-asar.sh`.
  "packages/webui/desktop-unpacked",
  // Private agent-workflow tickets (to-tickets output, see the feedback-
  // driven workflow in AGENTS.md). Git-ignored local working material that
  // never contains publishable source.
  ".tickets",
]);
function filesIn(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name) || entry.name.endsWith(".tsbuildinfo"))
      return [];
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Source symlink requires explicit review: ${relative}`);
    if (entry.isDirectory()) {
      if (skippedTrees.has(relative)) return [];
      return filesIn(path.join(directory, entry.name), relative);
    }
    return [relative];
  });
}
const files = filesIn(root).sort();
const violations = suiteInventoryViolations(files, readSuites(root));
// Standard MIT text with the reviewed first-party attribution.
// Source: https://opensource.org/license/mit
const rootLicenseSha256 =
  "28bb5c2948742f9f8d27ed84882844d09dff07cb5df64f20729875e8582a18ea";
if (
  createHash("sha256")
    .update(readFileSync(path.join(root, "LICENSE")))
    .digest("hex") !== rootLicenseSha256
)
  violations.push(
    "LICENSE: expected MIT text with the reviewed MiniMax Code attribution",
  );
const internalText =
  /(?:[\w.-]+\.xaminim\.com|weaver\/idl|@mavis\/thrift-gen|\/Users\/minimax(?:\/|\b)|\/archon\/internal\/api\/)/u;
const credential =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{100,}|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9_-]{32,}/u;
for (const file of files) {
  if (retiredSourceRoots.some((prefix) => file.startsWith(prefix)))
    violations.push(`${file}: retired source`);
  if (/^(?:.*\/)?\.env(?:\.|$)/u.test(file) && !file.endsWith(".env.example"))
    violations.push(`${file}: environment file`);
  if (file === "scripts/source-inventory.mjs") continue;
  let content = readFileSync(path.join(root, file));
  if (file.endsWith(".gz")) content = gunzipSync(content);
  const text = content.toString("utf8");
  if (internalText.test(text))
    violations.push(`${file}: internal source reference`);
  if (credential.test(text))
    violations.push(`${file}: possible embedded credential`);
}
const { packageRoots } = readExtraction(root);
const packages = packageRoots.map((directory) => ({
  directory,
  manifest: JSON.parse(
    readFileSync(path.join(root, directory, "package.json"), "utf8"),
  ),
}));
const names = new Set(packages.map(({ manifest }) => manifest.name));
for (const { directory, manifest } of packages) {
  if (!manifest.license || manifest.license === "UNLICENSED")
    violations.push(`${directory}: missing open-source license`);
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version.startsWith("workspace:") && !names.has(name))
        violations.push(`${directory}: unknown workspace ${name}`);
    }
  }
  for (const [name, entry] of Object.entries(manifest.exports ?? {})) {
    const target =
      typeof entry === "string"
        ? entry
        : (entry.types ?? entry.import ?? entry.default);
    if (!target) continue;
    const source = target
      .replace(/^\.\/dist\//u, "./src/")
      .replace(/\.d\.ts$/u, ".ts")
      .replace(/\.js$/u, ".ts");
    if (!existsSync(path.resolve(root, directory, source)))
      violations.push(`${directory}: missing export ${name}`);
  }
}
const native = JSON.parse(
  readFileSync(
    path.join(root, "third_party/sandbox-runtime/native-integrity.json"),
    "utf8",
  ),
);
for (const entry of native.files) {
  const bytes = readFileSync(
    path.join(root, "third_party/sandbox-runtime", entry.path),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    violations.push(`${entry.path}: native helper integrity mismatch`);
}
if (violations.length)
  throw new Error(`Public source check failed:\n${violations.join("\n")}`);
if (process.argv.includes("--write")) {
  const projected = [...new Set([...files, inventoryPath])].sort();
  writeFileSync(
    path.join(root, inventoryPath),
    JSON.stringify({ schemaVersion: 1, files: projected }, null, 2) + "\n",
  );
  console.log(`Recorded ${projected.length} reviewed source paths.`);
} else {
  const expected = JSON.parse(
    readFileSync(path.join(root, inventoryPath), "utf8"),
  ).files;
  const actualSet = new Set(files),
    expectedSet = new Set(expected);
  const missing = expected.filter((file) => !actualSet.has(file));
  const added = files.filter((file) => !expectedSet.has(file));
  if (missing.length || added.length)
    throw new Error(
      `Source inventory changed; review before updating.\nMissing: ${missing.join(", ")}\nAdded: ${added.join(", ")}`,
    );
  console.log(
    `Public source check passed: ${files.length} files, workspace exports and native helper integrity verified.`,
  );
}
