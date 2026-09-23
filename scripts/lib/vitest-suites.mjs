import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const suitesPath = "test/vitest-suites.json";

export function readSuites(root) {
  return JSON.parse(readFileSync(path.join(root, suitesPath), "utf8")).suites;
}

export function suiteFiles(root, name) {
  const suites = readSuites(root);
  const files = suites[name];
  if (!files)
    throw new Error(
      `Unknown Vitest suite "${name}"; ${suitesPath} declares ${Object.keys(suites).join(", ")}`,
    );
  return files;
}

export function allSuiteFiles(root) {
  return Object.values(readSuites(root)).flat();
}

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Use the source inventory rather than Git so exported source archives enforce
// the same coverage contract. Vendored suites and repository node:test gates
// are deliberately outside the first-party Vitest discovery boundary.
export function suiteInventoryViolations(files, suites) {
  const actual = new Set(files);
  const declared = Object.values(suites).flat();
  const registered = new Set();
  const violations = [];
  for (const file of declared) {
    if (registered.has(file))
      violations.push(`${file}: duplicate Vitest registration`);
    registered.add(file);
    if (!actual.has(file))
      violations.push(`${file}: registered Vitest file is missing`);
  }
  for (const file of files) {
    if (
      file.startsWith("packages/") &&
      // packages/webui is a plain node:test package: its suite runs under its
      // own gate (pnpm test:webui), not under Vitest — same policy as the
      // repository-level node:test gates.
      !file.startsWith("packages/webui/") &&
      // packages/webui-react follows the same policy for a different reason: it
      // ships its own vitest.config.ts (jsdom + testing-library setup) and runs
      // under pnpm test:webui-react, so its DOM tests cannot run in this
      // node-environment runner.
      !file.startsWith("packages/webui-react/") &&
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
      !registered.has(file)
    )
      violations.push(
        `${file}: first-party test is absent from test/vitest-suites.json`,
      );
  }
  return violations;
}
