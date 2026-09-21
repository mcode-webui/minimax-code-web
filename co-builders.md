# Co-Builders — the people and history behind the Web UI

> This file records who built the Web UI, where each piece came from, and how
> the code traveled from a community plugin into this repository. It exists so
> that credit survives refactors: every line in `packages/webui` has a name
> attached to it here. When you contribute to the Web UI, add yourself to it.
>
> 人员与历史脉络记录（本仓库文档以英文为主，保留原始中文提交主题与 PR 标题以存真）。

## 1. Why this file exists

The Web UI began as **mcode-webui**, a community plugin for MiniMax Code,
submitted to the [MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)
registry. In September 2026, following direction from the MiniMax Code team
(relayed by **Ronny** in the community sync): *the Web UI should be part of
mcode as a whole — coexisting with the official desktop app and community
desktop clients — because the official team does not have the capacity to
maintain three separate surfaces, and hopes the community will build it
together* — the plugin was migrated out of the plugin system into this fork
as a first-class package (`packages/webui`), with the TUI/CLI acting as the
engine and the Web UI as a frontend. An Electron-based desktop could later be
built on the same package.

This file is the memory of that journey.

## 2. People

| Handle | Role |
|---|---|
| **Wzdhehe** | Original author and lead of mcode-webui. Designed and built the entire v0.5 → v1.1.1 line (~100+ commits): the zero-dependency HTTP/SSE server, the ACP-over-stdio engine wiring, the SPA frontend, the token/LAN security surface, and the bilingual UI. Submitted [PR #16]. |
| **modacker** (commits as **moc**, `moc@sgmov.com`) | External reviewer turned co-author. Tested PR #16 on macOS and fixed the db-path blocker (round 5, [PR #23]); authored the round-8 CORS tightening and cross-origin token-leak fix ([PR #31]); authored **v2.0.0 — 工业化** ([PR #55]), the industrial rewrite that closed the v1 line; synced v2.0.0 back to the standalone mirror. |
| **Hahaha** (`Mjc39672@gmail.com`) | Maintainer of the standalone mirror Wzdhehe/Mcode-webui with merge rights; merged the round-8 security fix (mirror PR #6). |
| **weekbin** | Author of **mcode-trajectory-studio** ([PR #56]): the read-only session-trajectory inspector (7 MCP tools + studio panel) over the runtime SQLite projection, including its redaction and containment design. |
| **hetaoBackend** | Author of the earlier `minimax-code-trajectory` plugin (v0.2.0) in the same registry — the lineage PR #56's design document starts from, and a reviewer cc'd through the webui PR rounds. |
| **Ronny** (MiniMax Code official team) | Relayed the official direction that moved the Web UI from plugin to product surface (see §1). |
| **liuhailong** (GitHub: **fengzhi09**) | Founder of the mcode-webui community org and initiator of this migration. Replicated the official repository into [mcode-webui/minimax-code-web](https://github.com/mcode-webui/minimax-code-web), carried the official direction into an actionable architecture (tui/mcode as engine, webui as frontend, not a plugin), and directed and authored the in-product migration commits on `feat/webui-integration` — working with an AI coding agent (DeepSeek Harness) executing under their direction and review. |
| **MiniMax-AI / MiniMax Code team** | Upstream authors of the engine this repository forks: the TUI, headless CLI, ACP server, and the plugin registry the webui grew up in. |
| **mcode-webui org** ([team](https://github.com/orgs/mcode-webui/teams/mcode-webui)) | The community organization under which this fork lives and the Web UI is co-developed. |

Credit is also due to the **DeepSeek Harness (dsh)** project: the v1 plugin
documentation (`docs/BORROW-dsh-deepseek-harness-*.md`, preserved in the
standalone mirror's history) records the UI patterns borrowed from its web
frontend, and PR #56's design doc explicitly set out to "把 dsh Web 端
Trajectory 视图的能力，落到一个 MCode Agent Plugin 上".

## 3. Timeline

### Plugin era — v1 line (author: Wzdhehe)

- **2026-08-17 → 08-20** — modularization period (`v0.5.bx-NN` scheme): the
  monolithic server was split into `server/lib/*` modules with per-round tests.
- **2026-08-22** — **v1.0.0** (“Ink & Paper” 单色主题 + 删除链路三连修 + 302 tests)
  published; [PR #16] *“Add plugin: mcode-webui (Wzdhehe)”* submitted to
  MiniMax-Code-Plugins (89 files). The initial packaging batch physically
  lived under `plugins/Ponkan/` before settling at `plugins/Wzdhehe/`.
- **2026-08-25** — **v1.0.1**: LAN sub-card, and token auth *actually
  implemented* in response to review (the docs had described `?token=` /
  `Bearer` before the code enforced it); CORS hardening round 2.
- **2026-08-26** — **v1.0.2** (mcode 0.2.4 control-surface adaptation) and
  **v1.0.3** (audit rounds 5–6: goal endpoints, ask countdown, XSS fixes).
  modacker's macOS test round exposed the db-path resolver blocker.
- **2026-08-27** — **[PR #23]** (modacker) *“Add plugin: mcode-webui (round 5
  — supersedes #16)”*: reused Wzdhehe's nine commits plus one fix commit;
  “本地测试 391/393 pass · 0 fail”. Closed unmerged on 2026-09-17 once the
  v2 line superseded the round-based flow; #16 itself remains open as the
  historical anchor of the v1 submission.
- **2026-09-04** — **[PR #31]** (modacker) *“round 8 — CORS tightening +
  cross-origin token-leak fix”* (closed unmerged 2026-09-17); the fix itself
  was merged into the standalone mirror as PR #6 (merged by Hahaha).
- **2026-09-12** — **v1.1.0**: mcode 0.3 / 0.4 / 0.4.2 ACP compat layer, live
  queue panel, ACP model picker, cross-workspace session search; four ACP
  surface probe rounds documented; layout consolidated to a single root tree.
- **2026-09-19** — **v1.1.1**: live-test fixes (activity-aware prompt idle
  timeout, throttled per-chunk SSE push).

### Plugin era — v2 line

- **2026-09-20** — **v2.0.0 “工业化”** ([PR #55], author modacker, closes #16):
  append-only event stream with SHA-256 hash chain, per-request `authorize()`
  gate (fail-closed audit), independent anomaly SSE channel, write-ahead
  intent/outcome events, interaction/feedback subsystem split, rate limiting,
  virtual chat list, session export (Markdown/JSON), quota forecast, token
  onboarding modal, local SBOM + CVE gates, loopback-default bind with
  explicit LAN opt-in; 1034 tests across unit/mocked/integration/matrix
  suites; 173 files, +58,318 lines.
- **2026-09-20** — **[PR #56]** (weekbin) *“Add mcode-trajectory-studio:
  read-only session trajectory inspection via the runtime SQLite projection”*
  (62 files, +10,706 lines), with a follow-up commit addressing all five
  review findings.

### In-product migration (this repository)

- **2026-09-21** — Following the official direction, **liuhailong**
  (fengzhi09) established the community fork
  [mcode-webui/minimax-code-web](https://github.com/mcode-webui/minimax-code-web)
  and drove the plugin's migration into the product on branch
  `feat/webui-integration` (migration authored under their direction and
  review, with an AI coding agent executing):

  - `plugins/Wzdhehe/mcode-webui` → **`packages/webui`** (`@mavis/webui`), with
    `plugin.json`'s manifest folded into `package.json` under
    `mcodeWebui.capabilities`.
  - `plugins/weekbin/mcode-trajectory-studio` →
    **`packages/webui/server/trajectory`** + `public/trajectory`, mounted at
    `/trajectory/` behind the webui's gate chain; the standalone `--serve`
    panel and MCP-over-stdio modes are preserved.
  - New `mcode webui` CLI subcommand (`packages/tui/src/cli/run-webui-command.ts`)
    spawns the webui server and points it back at the running CLI
    (`MCODE_WEBUI_SELF_ENTRY`), so the engine is always the CLI itself.
  - Runtime data moved from the plugin install dir to `~/.mcode-webui`;
    engine detection prefers the repo-built `dist/cli.js` and injected self
    entry; the ACP client's POSIX spawn no longer ignores the resolved engine
    path.
- **2026-09-21 (later)** — Wzdhehe's workspace-picker wave on the standalone
  mirror (26 commits on `feat-workspace-lhl` branches: modal directory picker
  `fs-picker`, workspace tree / recent / resolve endpoints, model-selector
  button showing the current model) was synced into `packages/webui`. The
  standalone tree descends from the v1 line, so the sync was a **merge, not a
  copy**: the v2 workspace containment (allowed roots) was preserved and
  extended onto the new surface — `/api/fs/read` and `/api/fs/mkdir` sit
  behind the same allowed-roots boundary as `browseWorkspace` (the
  standalone's `safePath` only blocked `..`), and `mkdir` validates its
  parent directory because the target does not exist yet. The abandoned
  Electron-dialog and browser-fs-access experiments from the wave were not
  carried over. The Docker dev environment was also redesigned to a clean
  container: no host home mounts, with the MiniMax API key provided per
  collaborator via `MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY` and seeded into a
  fresh in-container config by `docker/entrypoint.sh`.

## 4. Artifact map

| Artifact | Where |
|---|---|
| Standalone mirror (v1 line + v2 sync, 107 commits) | [Wzdhehe/Mcode-webui](https://github.com/Wzdhehe/Mcode-webui) |
| Plugin PRs | [#16](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/16) · [#23](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/23) · [#31](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/31) · [#55](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/55) · [#56](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/56) |
| Migrated package | [`packages/webui`](packages/webui/README.md) — server, SPA, trajectory studio, tests |
| Package docs | `packages/webui/docs/` — ARCHITECTURE, API, CAPABILITIES, DEVELOPMENT, TROUBLESHOOTING, HTTPS-REVERSE-PROXY, CHANGELOG (plugin-era history) |
| Canonical security disclosure | `packages/webui/references/SECURITY-NOTES.md` |
| Product doc | [`docs/webui.md`](docs/webui.md) |
| Migration source of record | `feat/webui-integration` branch in this repository |

Process documents from the plugin era (VERIFICATION-REPORT, BORROW-*, MATH-*,
REVIEW-*, PROJECT-CHARTER, ANTI-PATTERNS-FIX-PLAN, COVERAGE-REPORT) were
deliberately not carried into this repository's tree; they remain readable in
the [PR #55] tree and the standalone mirror's history.

## 5. Extending this record

If you contribute to the Web UI, add a row to §2 and a dated entry to §3 in
your pull request. Keep entries factual (what shipped, where it lives, who
did it); quote original Chinese titles verbatim rather than translating them.
