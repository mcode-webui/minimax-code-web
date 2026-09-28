# Agent guide

This repository is the reviewed public projection of an internal monorepo, not an ordinary workspace. Every published file is listed in `release/public-source.json`, and upstream changes arrive through a three-way merge described in `docs/source-sync.md`. Moving or renaming files therefore has a cost that a normal repository does not have: it shows up as a conflict or an unreviewed new file at the next synchronization. Prefer changing content over changing layout.

## Layout

- `packages/` — first-party workspace packages. `packages/agent-modules/*` is a second level of packages, not a package itself.
- `third_party/` — vendored upstream packages (`pi-mono`, `sandbox-runtime`) with their own licenses. Their test suites are not part of this distribution's verification.
- `release/` — machine-read release contracts. `extraction.json` pins the source baseline and package scope, `public-source.json` is the file inventory, `dependency-licenses.json` records declared dependency licenses. Build, type-check, test resolution, and source checks all read from here.
- `docs/` — human-readable documentation and supporting media.
- `scripts/` — build and verification tooling. Shared constants live in `scripts/lib/`; import them instead of repeating literal paths or lists.
- `test/` — repository-level tests and `vitest-suites.json`, the declaration of every Vitest file this distribution runs.

## Generated files

Do not edit these by hand; regenerate them and commit the result.

| File | Regenerate with | Checked by |
| --- | --- | --- |
| `release/public-source.json` | `node scripts/source-inventory.mjs --write` | `pnpm check:source` |
| `tsconfig.standalone.json` (the `paths` block) | `pnpm gen:tsconfig` | `pnpm check:tsconfig` |

Review added, removed, and renamed files before regenerating the inventory: recording a file does not make it suitable for publication. Content-only edits to existing files do not require inventory regeneration. Keep private review material, verification reports, and temporary artifacts outside the repository; the inventory scans the working tree, including untracked files outside its explicit exclusions.

## Branches and source synchronization

Use a feature branch and submit a pull request; do not push directly to the default branch. See `CONTRIBUTING.md` for contribution and review requirements.

Name new branches by the purpose of the change: `feat/<short-description>` for features, `fix/<short-description>` for bug fixes, and corresponding prefixes such as `docs/`, `refactor/`, `test/`, or `chore/` for other work. Use concise English descriptions in lowercase kebab-case, for example `feat/provider-limits` or `fix/session-restore`. Do not use agent or tool names as branch prefixes, including `codex/`. Follow an explicitly requested branch name when one is provided.

Never merge internal Git history or cherry-pick internal commits into this repository. Follow `docs/source-sync.md`, keep unreviewed candidates outside the repository, and apply reviewed files individually. Advance `release/extraction.json`'s `sourceRevision` only after reviewing all differences for the selected source revision.

## Single sources of truth

| Concern | Declared in | Consumed by |
| --- | --- | --- |
| Package scope | `release/extraction.json` (`packageRoots`) | build, type-check paths, Vitest aliases, source check, source sync |
| Package export → source file | each package's `exports` via `scripts/lib/package-exports.mjs` | `tsconfig.standalone.json`, `vitest.oss.config.mjs` |
| Vitest files per gate | `test/vitest-suites.json` | `vitest.oss.config.mjs`, `scripts/run-vitest-suite.mjs` |
| Retired source paths | `scripts/lib/retired-sources.mjs` | `check:source` (must not exist), `check:standalone` (must not be bundled) |
| Verification pipeline | `scripts/verify.mjs` | GitHub CI, `pnpm verify` |
| Documentation-only classification | `scripts/ci-changes.mjs` | source verification, release audit |
| Source archive validation/extraction | `scripts/lib/source-archive.mjs` | source export, candidate validation |

## Common changes

Adding a workspace package: add it to `pnpm-workspace.yaml` and to `packageRoots` in `release/extraction.json`, then run `pnpm gen:tsconfig` and `node scripts/source-inventory.mjs --write`.

Changing package exports: run `pnpm gen:tsconfig` after adding or changing an export subpath.

Adding a Vitest file: add its path to the appropriate group in `test/vitest-suites.json`. Do not hard-code Vitest file paths in `package.json` scripts or the Vitest config. Repository-level `node:test` suites remain in their existing gates; add workflow safety and release-tool regressions to `test/source-sync.test.mjs`.

Adding a verification gate: add a step to `scripts/verify.mjs`, with `platforms` when it cannot run everywhere. Do not add steps to the workflow file.

## Verification

`pnpm verify` runs the same gates as CI in the same order; `pnpm verify --list` shows which apply on the current platform. Run it before opening a pull request. Individual gates such as `pnpm typecheck`, `pnpm build`, and `pnpm test:byok` remain available for iteration.

The full profile is the local default. `platform` omits only duplicate type checking. Use `pnpm verify --profile docs` only when every changed path qualifies under `scripts/ci-changes.mjs`; it runs source inventory, generated-path, source-export, and release-tool checks. `AGENTS.md`, bundled runtime prompts, and `release/` changes do not qualify for that profile. `archive` skips Git export for source archives; the candidate workflow authenticates the archive before invoking it. Keep profile selection in the shared verifier.

Source export reads committed `HEAD` and rejects uncommitted tracked changes. During editing, run the relevant individual gates; run the complete applicable profile on the reviewed commit with a clean tracked working tree before opening a PR. Report the checks actually run and any blocked or untested boundaries. Offline tests do not establish live-service or cross-platform acceptance.

## Feedback-driven agent workflow

User feedback on the running app is handled by an orchestrating agent that delegates to subagents; the orchestrator does not edit product code directly. The fixed pipeline is: clarify → record → implement → accept → ship.

- **Clarify (grill-me).** For under-specified feedback, interview the reporter one question at a time until every load-bearing decision has an answer; each question ships with a recommendation. Skip this for unambiguous bug reports.
- **Record (to-tickets).** Break approved work into tracer-bullet tickets: `.tickets/<feature-slug>/<NN>-<slug>.md`, numbered from `01` in dependency order, each declaring its blocking tickets and its acceptance criteria. `.tickets/` is private working material — git-ignored and excluded from the source inventory — and is never committed or published.
- **Implement.** One development subagent (model route `minimax-cn/MiniMax-M3`) per ticket, on its own branch named per the convention above. Tickets whose blockers are all merged may be developed in parallel.
- **Accept.** An independent acceptance subagent (model route `zai-coding-cn/GLM-5.3-Flash`; never the instance that wrote the code) reviews the diff against the ticket's acceptance criteria, runs the targeted gates (`pnpm typecheck`, `pnpm build`, and the test suites touching the change), and for UI-visible changes verifies the behavior in a browser with screenshots against the dev server (`pnpm webui:dev`, frontend at `http://127.0.0.1:18091/`). The full `pnpm verify` profile is left to CI. **Documentation is part of what acceptance checks: a change that alters user-visible behaviour, a contract, an endpoint, a configuration key, or a limitation ships the matching documentation in the same pull request.** An acceptance verdict of "verified" is only possible when the documentation matches the code; "the code works but the docs still describe the old behaviour" is a failure, not a follow-up.
- **Ship.** Open a pull request that references the ticket and attaches the acceptance report (diff verdict, gates run, evidence screenshots). Enable auto-merge (squash); the PR merges once CI is green, and the branch is deleted. Direct pushes to the default branch remain forbidden.

### Documentation

User-visible behaviour ships in both languages, at equal weight, in the same pull request:

| Reader | File | Content |
| --- | --- | --- |
| Product, operations | `docs/webui.zh-CN.md` | What the feature does, why it was built this way, what a user sees, what it costs, what it does not do |
| Contributors, later agent runs | `docs/webui.md` and code comments | The contract: endpoints, payloads, configuration keys, invariants, failure modes |

Both are edited by hand; neither is generated from the other. When the two would say different things, that is a defect in one of them, not a translation choice — resolve it before merging.

Write both as an ordinary technical proposal a colleague would read: state the decision, the reason, the alternatives that were rejected, and how you would tell it works. Prefer a table to a paragraph when comparing options, and a stated constraint to an adjective. Do not narrate the implementation step by step, do not restate the pull request title in prose, do not add a summary that repeats what the reader just finished reading, and do not explain what the code plainly says. If a paragraph would survive being copied from another project's document, it does not belong here.


Discipline learned the hard way — apply in every round:

- **Self-check before acceptance.** The development subagent live-verifies every render path in its own isolated instance before acceptance sees the change; acceptance is never the first pair of eyes on a render path. Pin render-critical wiring with a regression test — a static-source tripwire is acceptable only when the suite has no render harness — and drive internal code paths in tests, not just exported names (an export-alias reference bug once shipped dead code that its own unit tests passed).
- **Process safety.** Never signal processes by name or pattern (`pkill`, `killall`, process-group kills) — they hit unrelated instances, including other agents' test servers and the live dev instance. Signal only PIDs you personally spawned, verified with `ps` first. Isolated test instances run on their own ports with their own `MCODE_WEBUI_DATA_DIR`.
- **Test hygiene.** Tests that spawn `server.js` must set `MCODE_WEBUI_{SETTINGS_PATH,EVENTS_PATH,SESSIONS_DB,UPLOAD_DIR}` to per-test temporary paths — enforced by `scripts/test-isolation-lint.check.mjs` in the `test:release-tools` gate. Close every server/socket in teardown; one leaked handle hangs an entire gate (this failed CI twice). Per-test tmp directories must be created through `packages/webui/test/helpers/tmp.js` (`mkTmpDir` / `mkTmpDirAsync` / `mkSubTmpDir`) — never bare `mkdtempSync` / `await mkdtemp()` — so the helper's `process.on('exit')` and signal handlers can clean them up. The same `process.on('exit')` hook plus `SIGINT` / `SIGTERM` handlers cover normal exit, `process.exit()`, uncaught exceptions, unhandled rejections, and signal-driven termination; the handler re-raises the signal so the parent's exit code is preserved (SIGKILL is kernel-only and relies on OS-level tmp cleanup — that path is exempt). The companion gate `scripts/test-tmp-leak.check.mjs#verify-registry` (also in `test:release-tools`) re-scans the test tree and asserts every prefix the suite actually passes to the helper is registered in `KNOWN_PREFIXES` — adding a new prefix without registering it fails this gate, so a future regression cannot silently introduce a tmp-leak the lint misses.
- **Run the gates the way CI runs them.** Local green with CI red keeps happening, and it is always gate hygiene rather than a product defect: a *targeted* server-test subset that skipped an unrelated route test, and a narrower typecheck invocation than the one CI invokes. Before reporting done, run the full applicable server test suite — not only the suites you touched — and invoke typecheck through the same entry CI uses (`pnpm --filter <pkg> webapp:typecheck`, plus the repo-level `pnpm typecheck`). When a change adds a line-level marker to a stream other code parses, expect existing assertions on that stream to shift: sweep for them instead of assuming your own tests are the only consumers.
- **Do not re-declare ambient globals in tests.** Declaring `var window` (or any DOM global) with a structural type narrower than the lib's fails `tsc` with TS2403/TS2322. Stub an ambient global through a typed alias or `Object.defineProperty` on `globalThis` instead.
- **Never write to a checkout that a running instance serves from.** This is a hard constraint, not a preference. The live dev instance watches its checkout, so *any* transient state in a tracked file — a merge conflict marker, a half-applied edit, a branch switch — reaches the running server within seconds. A conflict marker in one server module crashed the backend, the launcher took the frontend down with it, and the user's instance went dark until it was restarted by hand.

  Concretely, while an instance runs from a checkout:
  - **Never** `git checkout`, `git switch`, `git merge`, `git rebase`, `git reset`, or `git cherry-pick` in it.
  - **Never** edit a tracked file in it.
  - Resolve merges, branch work, and conflict resolution in a **separate worktree**: `git worktree add <path> -b <branch> <base>`.

  The orchestrating agent is not exempt. It resolved a merge in the primary checkout and took the instance down; the branch work belonged in a worktree all along.

- **Restarting the live instance is a checklist, not a command.** A merge that adds a dependency, a generated artifact, or product code leaves the instance silently stale or broken. Before restarting:
  1. Read whether the merge added a **new dependency** (`*package.json`, `pnpm-lock.yaml`).
  2. If it did, run `pnpm install --frozen-lockfile` **while the instance is stopped**. Skipping this makes the dev server fail with `Module not found` — CI is green because CI always installs; a local checkout does not.
  3. Stop by reading the PID from the **port**, confirm it with `ps` **and** `readlink /proc/<pid>/cwd`, then `TERM` and **poll until the port is free**.
  4. Start detached so it outlives the harness: `setsid nohup pnpm webui:dev > /tmp/<service>-<HHMM>.log 2>&1 < /dev/null &`.
  5. Check **every** port the instance serves, not just one.

  A merge that touches only `.md` needs no restart — restarting interrupts an in-session for nothing. Say so in the record rather than skipping it silently.

- **Model routes.** Verify route availability in the session's model catalog before dispatching. Development: `minimax-cn/MiniMax-M3`, with `zai-pro/GLM-5.3` preferred for backend work and `zai-pro/GLM-5.3-Flash` for frontend work when those routes are allowed. Acceptance: the configured reviewer route (e.g. `mimo-pro/mimo-v2.6-pro`), falling back to `zai-coding-cn/GLM-5.3-Flash` — always an instance that did not write the code. A route that fails mid-task is swapped immediately and the work handed over with explicit context; the orchestrator recovers wedged dev-server processes by verified PID only.

## Boundaries

Do not reference internal hosts, generated IDL, or private services; `check:source` catches known patterns but does not replace publication review. Do not restore paths listed in `scripts/lib/retired-sources.mjs` or remove supported capabilities to make standalone checks pass. Do not commit account data, sessions, logs, credentials, or real user content; use temporary data directories and synthetic test inputs. Documentation and commit messages are written in English; preserve the required languages of localized product strings and bundled runtime prompts. See `CONTRIBUTING.md`.
