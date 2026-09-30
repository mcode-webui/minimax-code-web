/**
 * Bilingual strings.
 *
 * Hand-rolled rather than i18next: the dependency boundary for this package is
 * build-time only, so the frontend ships no runtime libraries beyond React. The
 * dictionary is typed, so a missing key is a compile error rather than a string
 * that silently renders as its own name.
 *
 * Every user-visible string must be added to both locales — the server's existing
 * UI is fully bilingual and this frontend keeps that property.
 */

export type Locale = "zh" | "en";

export const LOCALES: Locale[] = ["zh", "en"];

const en = {
  "app.name": "MiniMax Code",
  "app.connecting": "Connecting to the engine…",
  "app.disconnected": "Disconnected",

  "topbar.newSession": "New session",
  "topbar.stop": "Stop",

  "sidebar.empty": "No sessions yet",
  "sidebar.untitled": "Untitled",
  "sidebar.delete": "Delete",
  "sidebar.rename": "Rename this session",
  "sidebar.search": "Search",
  "sidebar.settings": "Settings",
  "sidebar.resize": "Resize sidebar",
  "sidebar.newInProject": "New task in this project",

  "chat.empty": "Start a conversation",
  "chat.thinking": "Thinking",
  "chat.status.running": "Running",
  "chat.tps": "tok/s",
  "session.status.error": "Ended with an error",
  "session.status.aborted": "Stopped",
  "session.status.interrupted": "Interrupted",
  // Loading-state copy for the active turn. Upstream surfaces four phase
  // labels (working / planning / wiring / checking) keyed off the engine's
  // stage; the server only ships "thinkingStatus" today, but adding the
  // strings here keeps the UI ready when the engine starts reporting them.
  "chat.thinkingStatus.working": "Working",
  "chat.thinkingStatus.planning": "Planning",
  "chat.thinkingStatus.wiring": "Wiring up",
  "chat.thinkingStatus.checking": "Checking",
  "chat.system": "System",

  "composer.send": "Send",
  "composer.hint": "Enter to send, Shift+Enter for a new line",
  "composer.sending": "Sending…",
  /* Context-window meter beside the composer. The panel only shows what the
     engine actually reports; the desktop also breaks the window down by category,
     which this server does not publish (see components/context-meter.tsx). */
  "context.show": "Show context window usage",
  "context.title": "Context window",
  "context.used": "Used",
  "context.speed": "Output speed",
  // Used when the round-to-integer percent is zero but the underlying ratio
  // is positive (e.g. 1521/512000 = 0.3%). Showing "0%" hid that any usage
  // had accumulated at all; "<1%" makes the small but real number visible.
  "context.lessThanOne": "<1%",
  // SPEC §E row 140 — per-category breakdown labels (drawn under the
  // segmented progress bar when state.context.breakdown is non-empty).
  "context.breakdown.systemPrompt": "System prompt",
  "context.breakdown.memory": "Memory",
  "context.breakdown.tools": "Tools",
  "context.breakdown.skills": "Skills",
  "context.breakdown.messages": "Messages",
  "context.breakdown.other": "Other",
  // SPEC §E row 141 — plan section title; the active tier title is
  // appended as `· <title>` server-side.
  "context.planTitle": "Plan usage",
  "context.expandAria": "Expand context categories",
  "context.collapseAria": "Collapse context categories",
  "composer.readOnly": "Read-only mode is on",
  "composer.attach": "Add attachment or skill",
  "composer.dropHint": "Drop file to upload",
  "composer.model": "Model",
  "composer.noModels": "No models available",
  /* Model selector — provider-grouped dropdown. "Other" catches
     engine-encoded ids whose provider prefix did not coerce (i.e. a
     model the catalogue could not bucket). */
  "modelSelector.other": "Other",
  // Model selector — ticket 04. Provider groups without an API key
  // render greyed with a hint that points the user at the settings
  // panel; the modalities chip maps each `modalities[]` value to a
  // short display label.
  "modelSelector.noKeyHint": "Add an API key in Settings to enable",
  /* Model selector — ticket 07. The thinking-effort heading rendered at
     the top of the model selector dropdown, alongside the inline level
     pills. Falls back to the empty string is undesirable, so the
     heading is always present when at least one level is offered. */
  "modelSelector.level": "Thinking effort",
  "modelSelector.levelHint": "Picking a level here also re-anchors the model",
  /* Model selector — ticket 09. The "Add provider" row at the top of
     the dropdown deep-links into Settings → Providers with a fresh
     draft and the id input focused. The label is bilingual-friendly:
     the dashboard already uses "供应商" for the providers section,
     so this wording lands as one phrase rather than two stacked
     words. */
  "modelSelector.addProvider": "Add model / provider",
  /* Model selector — ticket 10. The cascade submenu's accessible
     name. The fly-out inherits the parent dropdown's role, but
     `aria-label` on the menu gives screen readers a one-word handle
     instead of reading the full level list as the menu's name. */
  "modelSelector.thinkingLevels": "Thinking effort",
  /* Model selector — U6 context window. The detail-area heading and
     the per-option usage hint. `higher_usage` is the only hint value
     the engine emits today (contextWindowOptionHints in the
     materialised builtin tree). */
  "modelSelector.contextWindow": "Context window",
  "modelSelector.contextWindowHigherUsage": "higher usage",
  /* Model selector — ticket 49 (batch 1). The detail area follows the
     hovered/keyboard-focused row. `detailEmpty` is the hint when
     nothing is describable (no focused row, no active model);
     `detailNoSettings` when the target model advertises neither
     context-window options nor thinking levels; `detailPreview` marks
     a focused-but-not-picked model whose radios render disabled;
     `detailPreviewHint` is the radio title explaining why. */
  "modelSelector.detailEmpty": "Select a model to see its settings",
  "modelSelector.detailNoSettings": "This model has no adjustable settings.",
  "modelSelector.detailPreview": "preview",
  "modelSelector.detailPreviewHint": "Pick this model to adjust its settings",
  "modelSelector.modalityBadge.text": "text",
  "modelSelector.modalityBadge.image": "image",
  "modelSelector.modalityBadge.audio": "audio",
  "modelSelector.modalityBadge.video": "video",
  "modelSelector.modalityBadge.file": "file",
  // Thinking-effort picker (off / low / medium / high). The
  // `thinkingPicker.none` key is the "no level recorded" placeholder;
  // it surfaces only between picking a model and the picker closing.
  "thinkingPicker.label": "Thinking effort",
  "thinkingPicker.none": "Use engine default",
  "thinkingPicker.off": "Off",
  "thinkingPicker.on": "On",
  "thinkingPicker.low": "Low",
  "thinkingPicker.minimal": "Minimal",
  "thinkingPicker.medium": "Medium",
  "thinkingPicker.high": "High",
  "thinkingPicker.xhigh": "Extra high",
  "thinkingPicker.max": "Max",

  "permission.label": "Permission mode",
  "permission.ask": "Ask",
  "permission.auto": "Auto",
  "permission.full": "Full access",
  "permission.read": "Read",
  "permission.off": "Off",

  "plan.title": "Plan",
  "ask.title": "Question",

  "error.send": "Could not send the message",
  "error.session": "Could not load sessions",
  "toolbar.workspace": "Workspace",
  "toolbar.browser": "Browser",
  "toolbar.git": "Git",
  /* The bell opens 站内信 (the inbox), not a warning list — upstream keeps system
     messages and product notices here. The underlying feed is still this server's
     alert ring buffer; see the inbox note in components/panels.tsx. */
  "toolbar.alerts": "Inbox",
  "common.unsupported": "Not available yet",
  /* Ticket 55c — the shared "local edition cannot do this" marker. Distinct
     from `common.unsupported` ("not available YET", an engine contract that
     has not landed): notLocal says the capability depends on a cloud account
     or OS integration this self-hosted server does not have, so it is not
     coming. Wording matches the usage page's `usage.notLocal` (ticket 53). */
  "common.notLocal": "Not applicable to the local edition",

  /* Inbox (站内信) — the sidebar's alert entry. Upstream labels its bell with
     the unread count; the strings are separate keys here because the translator
     takes no interpolation parameters. */
  "inbox.title": "Inbox",
  "inbox.entryUnread": "Inbox — unread messages",
  "inbox.entryNoUnread": "Inbox — no unread messages",
  "inbox.tabAll": "All",
  "inbox.tabProduct": "Product updates",
  "inbox.tabMine": "My messages",
  "inbox.markAllRead": "Mark all as read",

  /* Account menu rows — 1:1 with the desktop user-menu entry set
     (ticket 55c, ref-01): Settings / Upgrade / Daily check-in / Usage /
     Feedback & help / Sign out, plus the user card at the bottom. */
  "userMenu.checkin": "Daily check-in",
  "userMenu.signOut": "Sign out",
  "userMenu.upgrade": "Upgrade",
  "userMenu.feedback": "Feedback & help",
  /* The user card's display name when the engine reports no signed-in
     identity — the honest stand-in for the desktop's account name. */
  "userMenu.localUser": "Local user",

  /* Project context menu (ticket 55c, ref-26). Rename / pin are backed by the
     browser-local project customizations (webapp/lib/project-custom.ts);
     reveal-in-folder and archive render disabled with `common.notLocal`;
     remove batch-deletes the project's sessions behind a confirm. */
  "projectMenu.rename": "Rename project",
  "projectMenu.pin": "Pin project",
  "projectMenu.unpin": "Unpin project",
  "projectMenu.revealInFolder": "Reveal in folder",
  "projectMenu.archive": "Archive chats",
  "projectMenu.remove": "Remove",
  "projectMenu.removeConfirmTitle": "Remove project",
  /* Both {count} keys are replaced by the component with the TRUE deletion
     set — main sessions AND subagent rows — never the sidebar pill's
     main-session count: an irreversible confirm must not understate what
     goes (QA F1). */
  "projectMenu.removeConfirmBody":
    "This deletes every conversation under this project, subagent sessions included ({count} in total), and cannot be undone.",
  /* The server authorizes each single-session delete separately (no batch
     contract), so the dialog states the number of approval prompts up
     front (QA F2). */
  "projectMenu.removeConfirmAuthNote":
    "Deletion runs one session at a time; expect {count} authorization prompts, one per session — approve each to continue.",
  /* Live progress while the batch runs: {done} of {total} (QA F2). */
  "projectMenu.removeProgress": "Deleting {done}/{total}…",
  "projectMenu.removeConfirm": "Remove",
  "projectMenu.cancel": "Cancel",

  /* Session-row context menu (webui-parity 58 line B — the reference
     SessionRail's `openSessionMenu` item set, zh labels verbatim from the
     reference). Pin / archive / fork / reveal / feedback have no contract
     here (the reference ships reveal and feedback disabled too) and render
     disabled; rename / copy / delete are real. */
  "sessionMenu.pin": "Pin",
  "sessionMenu.rename": "Rename",
  "sessionMenu.archive": "Archive",
  "sessionMenu.forkCurrent": "Duplicate as new session",
  "sessionMenu.forkWorktree": "Duplicate to new worktree",
  "sessionMenu.revealInFolder": "Reveal in folder",
  "sessionMenu.copy": "Copy",
  "sessionMenu.copyWorkspaceDir": "Copy workspace directory",
  "sessionMenu.copySessionId": "Copy session ID",
  "sessionMenu.feedback": "Feedback",
  "sessionMenu.delete": "Delete",
  "sessionMenu.copied": "Copied",

  /* Home quick-capability capsules (ticket 55c, ref-28) — the desktop's
     cloud-skill chips under the composer. Labels match the reference
     screenshots verbatim; every chip is a placeholder that toasts
     `common.notLocal` because the skills are cloud-only. */
  "home.cap.video": "Video generation",
  "home.cap.vibe": "Vibe Coding",
  "home.cap.design": "Design visuals",
  "home.cap.product": "Product ops",
  "home.cap.askMcode": "Ask MCode",
  /* Usage strings — the settings page's 用量 card (ticket 37). The user-menu
     hover flyout that used to own these was deleted; the card reads the same
     `api.getQuota()` snapshot (remaining %, resetAt, weeklyResetAt) through
     the store. `usage.used` / `usage.reset` were deleted with ticket 53's
      progress-bar rework — the desktop form prints "0% / 100%" and a relative
      "resets in" caption, so the old label-style strings had no consumer. */
  "usage.title": "Usage",
  "usage.fiveHour": "5-hour limit",
  "usage.weekly": "Weekly limit",
  "usage.unavailable": "Quota data not available",
  "usage.refresh": "Refresh",
  "usage.errorTitle": "Failed to load usage",
  "usage.errorBody": "Try again in a moment.",
  /* Ticket 53 — the desktop-parity rework of the section. The segmented
     tabs (Token Plan / custom models), the Token Plan panel's plan card,
     credits row, invoice row, the video-limit bar (no local data source),
     and the "not applicable to the local edition" placeholder that fills
     every data region the local server has no source for. The reset
     caption keys take {t} and are .replace()-ed by the component, the
     same convention as files.tree.mtime.*. */
  "usage.tab.tokenPlan": "Token Plan",
  "usage.tab.inUse": "Active",
  "usage.tab.customModels": "Custom models",
  "usage.notLocal": "Not applicable to the local edition",
  "usage.plan.title": "Current plan",
  "usage.plan.upgrade": "Upgrade",
  "usage.plan.manage": "Manage",
  "usage.credits": "Credits",
  "usage.plan.topUp": "Top up",
  "usage.video": "Video limit",
  "usage.credits.hint":
    "When on, conversations can consume your credits (including granted credits).",
  "usage.invoice.title": "Invoices",
  "usage.invoice.apply": "Apply",
  "usage.invoice.hint": "Request invoices on the MiniMax open platform.",
  "usage.resetsIn": "Resets in {t}",
  "usage.duration.minute": "{n} min",
  "usage.duration.hour": "{n} h",
  "usage.duration.hourMinute": "{h} h {n} min",
  "toolbar.files": "Files",
  "toolbar.usage": "Usage",
  "plan.readOnlyNotice":
    "The agent is waiting for you to review this plan. This web UI can show the plan but cannot answer the review — approve it where you started the session, or leave it and the turn stays paused.",
  "plan.close": "Close",
  "ask.other": "Other…",
  "ask.submit": "Submit",
  "ask.skip": "Skip",
  // The text the Skip button sends to the engine on the isAskAnswer
  // channel. It is a prompt, not a key press, so it has to read as a
  // sentence the agent can act on.
  "ask.skipReply": "Skip this question — continue without an answer from me.",
  "ask.multiSelectHint": "Select one or more",
  "auth.title": "Authorization required",
  "auth.requested": "The agent is requesting permission to continue.",
  "auth.approve": "Approve",
  "auth.deny": "Deny",
  "panel.settings": "Settings",
  "files.parent": "Up one level",
  "files.empty": "Empty folder",
  "files.showing": "Showing",
  "files.filterPlaceholder": "Filter… (globs like *.txt)",
  "files.clearFilter": "Clear filter",
  "files.noMatch": "No matching entries",
  // 01 — collapsible file tree additions
  "files.tree.empty": "Empty folder",
  "files.tree.truncated": "{n} more not shown",
  "files.tree.hidden": "Show hidden files",
  "files.tree.shown": "Show non-hidden files",
  "files.tree.refresh": "Refresh",
  "files.tree.refreshAria": "Refresh this folder",
  "files.tree.newFolder": "New folder",
  "files.tree.newFolderPrompt": "New folder name",
  "files.tree.copyPath": "Copy absolute path",
  "files.tree.copied": "Path copied",
  "files.tree.copyFailed": "Copy failed",
  "files.tree.outOfBounds":
    "This folder is outside the workspace boundary and cannot be expanded",
  "files.tree.expand": "Expand",
  "files.tree.collapse": "Collapse",
  "files.tree.dirAria": "Folder {name}",
  "files.tree.fileAria": "File {name}",
  "files.tree.loading": "Loading…",
  "files.tree.mtime.now": "just now",
  "files.tree.mtime.minutesAgo": "{n}m ago",
  "files.tree.mtime.hoursAgo": "{n}h ago",
  "files.tree.mtime.daysAgo": "{n}d ago",
  "files.tree.mtime.weeksAgo": "{n}w ago",
  "files.tree.mtime.monthsAgo": "{n}mo ago",
  "files.tree.mtime.yearsAgo": "{n}y ago",
  /* Slice 19b — bounded server search wired into the file-tree
     filter. The footer below the rows reports scanned / skipped /
     truncated / matches. `files.search.footer.skipped.huge` is
     ALWAYS surfaced when > 0 (a huge directory's tail was capped
     while the walk itself finished) — see `webapp/lib/fs-search.ts`
     and `server/lib/fs-search.js#searchWorkspace` for the
     server-side counterpart. */
  "files.search.loading": "Searching…",
  "files.search.error": "Search failed: {{error}}",
  "files.search.footer.scanned": "scanned {n}",
  "files.search.footer.matches": "{n} match",
  "files.search.footer.skipped.node_modules": "skip node_modules {n}",
  "files.search.footer.skipped.git": "skip .git {n}",
  "files.search.footer.skipped.credential": "skip credentials {n}",
  "files.search.footer.skipped.huge": "skip huge-dir tail {n}",
  "files.search.footer.skipped.optional": "skip optional {n}",
  "files.search.footer.truncated": "truncated ({budget})",
  "files.search.footer.elapsed": "{n}",
  "files.search.footer.elapsedValue": "{ms}ms",
  "files.search.footer.budget.depth": "depth",
  "files.search.footer.budget.nodes": "nodes",
  "files.search.footer.budget.wallClock": "wall-clock",
  "files.search.footer.budget.matches": "matches",
  /* Credential affordance on a server-search hit (slice 19b). The
     inline label mirrors the slice-16 preview gate wording so the
     user sees the same "this is a credential file" cue in both
     surfaces; clicking still routes through the preview, which
     triggers the second confirmation. */
  "files.search.credential": "Credential file",
  /* Slice 19b — workspace search sidebar surface (replaces the
     slice-17 placeholder). Shares the same server endpoint as the
     file-tree filter. */
  "workspaceTabs.search.placeholder":
    "Search the workspace (incl. unexpanded dirs)…",
  "workspaceTabs.search.tip":
    "Type to search the workspace. Loaded hits render instantly; an exhaustive search runs when the in-tree filter has no matches.",
  "workspaceTabs.search.tipLoaded":
    "Matches in the already-loaded tree — type more to expand the search.",
  "workspaceTabs.search.tipExhaustive":
    "Exhaustive search across the workspace. Skipped directories are listed in the footer.",
  "workspaceTabs.search.empty": "No matches.",
  "workspaceTabs.search.open": "Open",
  // 12 — open.file.in.web preview pane (right column).
  "files.preview.empty":
    "Select a file in the tree or a path in a turn summary to preview it.",
  "files.preview.close": "Close preview",
  "panel.close": "Close",
  "settings.security": "Network and access",
  "settings.lan": "Share over LAN",
  "settings.lanBind": "Bind all interfaces (restart)",
  "settings.readOnly": "Read-only mode",
  "settings.tokenEnabled": "Require token",
  "settings.localUrl": "Local URL",
  "settings.lanUrl": "LAN URL",
  "settings.engine": "Engine",
  "settings.saved": "Saved",
  "settings.resetToken": "Rotate token",
  "settings.ackToken": "I saved the token",
  "settings.tokenValue": "Token",
  "alerts.empty": "No messages",
  "workspace.sectionEnvironment": "Environment",
  /* Workspace panel — switch workspace entry. The picker modal itself
     borrows from pr-22's fs-picker.js feature checklist: a path input,
     parent navigation, directory listing, glob filter, create-new-folder,
     recents tab, and an "Open native picker" button on supported
     platforms. */
  "workspace.switch": "Switch workspace",
  "workspace.picker.title": "Switch workspace",
  "workspace.picker.pathPlaceholder": "Path…",
  "workspace.picker.up": "Up one level",
  "workspace.picker.home": "Home",
  /* v0.5.by: home-chip dropdown (Level 1). WorkspaceChipDropdown mounts
     an antd Dropdown anchored to the chip on the home screen; the three
     rows mirror the pr-22 reference. The dropdown opens the full
     WorkspacePickerModal for "选择新项目" (Level 2). */
  "workspace.chipDropdown.recent": "Recent",
  "workspace.chipDropdown.chooseNew": "Choose new project",
  "workspace.chipDropdown.noProject": "No project",
  /* Sidebar project-row switch action — hovers next to the existing
     "new task in this project" plus on each project row. */
  "workspace.projectRow.switch": "Switch to this workspace",
  "workspace.picker.root": "Allowed roots",
  "workspace.picker.newFolder": "New folder",
  "workspace.picker.newFolderPrompt": "Folder name",
  "workspace.picker.filterPlaceholder": "Filter… (globs like *.md)",
  "workspace.picker.confirm": "Select",
  "workspace.picker.cancel": "Cancel",
  "workspace.picker.pickCurrent": "Use this folder",
  "workspace.picker.noWorkspace": "No workspace (scratch)",
  "workspace.picker.loading": "Loading…",
  "workspace.picker.empty": "This folder is empty",
  "workspace.picker.error": "Could not read this folder",
  "workspace.picker.tabs.recents": "Recent",
  "workspace.picker.tabs.browse": "Browse",
  "workspace.picker.recents.empty": "No recent workspaces",
  "workspace.picker.recents.search": "Search recent workspaces",
  "workspace.picker.useWorkspace": "Use this workspace",
  "workspace.picker.mustBeUnder": "Path must be under:",
  "workspace.picker.created": "Created",
  /* Workspace panel section labels are aligned with the desktop's
     `workspace_panel.section_*` keys (反编译 36705 chunk). */
  "workspace.sectionPlan": "Plan",
  "workspace.sectionAgentTeam": "Agent team",
  "workspace.sectionWorkingFolders": "Working folders",
  "workspace.sectionSources": "Sources",
  "workspace.sectionDeliverables": "Deliverables",
  "workspace.section.development": "In development",
  "workspace.env.activeHint": "Awaiting backend git endpoint",
  "workspace.changes": "Changes",
  "workspace.commitAndPush": "Commit or push",
  "workspace.openTerminal": "Open terminal",
  "activity.activeTool": "{{count}} tool calls | {{tool}}",
  "activity.thoughtSteps": "Thought {{count}} time(s)",
  "activity.usedTools": "Used {{count}} tool(s)",
  "activity.viewedFiles": "Viewed {{count}} file(s)",
  "activity.editedFiles": "Edited {{count}} files",
  "activity.ranCommands": "Ran {{count}} command(s)",
  "activity.fetchedWebs": "Fetched {{count}} web(s)",
  "activity.readSkills": "Read {{count}} skills",
  "activity.agentActions": "Performed {{count}} session actions",
  "activity.usedPlugins": "Used plugin tools {{count}} times",
  "activity.thoughtProcess": "Thinking process",
  "activity.detail": "Details",
  // Ticket 46 (D2) — thinking-block summary copy. Upstream `WebuiThinkingBlock`
  // shows 「推理中...」 while the thought streams and 「已完成推理」+ total
  // seconds once it settles; the expand/collapse pair is the body clamp.
  "activity.thinkingLive": "Thinking...",
  "activity.thinkingDone": "Finished thinking",
  "activity.expand": "Expand",
  "activity.collapse": "Collapse",
  /* Tool-card status copy (ticket 46 D4). Five states on the reference
     desktop vocabulary; a completed call renders no chip on its summary
     row. The wire only ever writes completed/failed/in_progress —
     pending and cancelled exist so the normaliser's full five-state
     table is user-visible. */
  "tool.status.completed": "completed",
  "tool.status.failed": "failed",
  "tool.status.in_progress": "running",
  "tool.status.pending": "pending",
  "tool.status.cancelled": "cancelled",
  /* Tool-card body sections (ticket 46 D4): 输入 / 结果 / 错误. */
  "tool.section.input": "Input",
  "tool.section.result": "Result",
  "tool.section.error": "Error",
  /* Failed call with no output lines — the reference's fallback error
     body. */
  "tool.executionFailed": "Execution failed",
  /* Body of a still-running call that has produced nothing yet. */
  "tool.runningDetail": "Running…",
  /* Turn-process bar (ticket 46 D6): composite summary
     「思考 N 次，用了 M 次工具，共执行 X 分 Y 秒」, live elapsed
     「已执行 N 秒」, and the two duration formatters. The output-rate
     unit is language-neutral (`token/s`) and formatted in the
     component. */
  "turn.usedTools": "used {{count}} tools",
  "turn.elapsedActive": "Elapsed {{duration}}",
  "turn.elapsedTotal": "Completed in {{duration}}",
  "turn.duration.minutes": "{{minutes}}m {{seconds}}s",
  "turn.duration.seconds": "{{seconds}}s",
  "turn.outputRateSr": "Output rate: ",
  "search.placeholder": "Search titles or ids…",
  "search.empty": "No matches",
  "search.results": "%n result(s)",
  "slash.title": "Commands",
  "slash.hint": "Enter to insert, Esc to dismiss",
  "sidebar.export": "Export",
  "sidebar.plugins": "Plugins",
  "sidebar.scheduled": "Scheduled",
  "sidebar.websites": "Websites",
  "sidebar.mobile": "Mobile",
  "sidebar.remote": "Remote",
  "sidebar.more": "More",
  "sidebar.subagents": "Sub-agents",
  "sidebar.projects": "Projects",
  "action.failed": "failed",
  "sidebar.openSession": "Open session",
  // webui-parity 63 (defect E): a switch that lands on a session other than
  // the row the user clicked used to be silent. This is the banner's detail
  // line, so it reads as the cause under the "Open session — failed" head.
  "sidebar.switchMismatch": "the engine is still on a different session",
  // webui-parity 47 (C3): the rail toggle's label flips with its state,
  // mirroring the reference shell's 展开/收起 pair. "navigation bar", not
  // "sidebar", because that is what the reference copy names.
  "sidebar.collapse": "Collapse navigation bar",
  "sidebar.expand": "Expand navigation bar",
  // webui-parity 47 (S4): the session-tree error state names the live cause,
  // so the string ends with a colon and the error text follows it at render.
  "sidebar.loadError": "Unable to load sessions: ",
  "sidebar.menu": "Account menu",
  "settings.appearance": "Appearance",
  "settings.group.preferences": "Preferences",
  "settings.group.management": "Management",
  "settings.group.coding": "Coding",
  "settings.group.archived": "Archived",
  "settings.tab.general": "General",
  // Ticket 37 — the desktop reference's management-group name. The section
  // stacks the usage quota card above the provider management panel.
  "settings.tab.usageModels": "Usage & models",
  "settings.tab.voice": "Voice",
  "settings.tab.shortcuts": "Shortcuts",
  "settings.tab.personalization": "Personalization",
  "settings.tab.browser": "Browser",
  "settings.tab.connection": "Connection",
  "settings.tab.account": "Account",
  "settings.tab.codeReview": "Code review",
  "settings.tab.worktree": "Worktree",
  "settings.tab.archived": "Archived tasks",
  "settings.searchPlaceholder": "Search settings...",
  "settings.searchNoResults": "No matching settings",
  "settings.clearSearch": "Clear settings search",
  // Ticket 48 — the back affordance carries the reference's "Back to app"
  // label, not a bare icon.
  "settings.back": "Back to app",
  "settings.theme": "Theme",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.language": "Language",
  // Row hints in the general section's 应用 card — the desktop reference
  // shows a grey one-line description under each row title.
  "settings.appearanceHint": "Choose the display theme",
  "settings.languageHint": "Set the application language",
  // Ticket 48 — General-page section titles and the localStorage-backed
  // rows (files / session management / follow-up behaviour). Wording
  // follows the desktop reference's General page.
  "settings.section.application": "Application",
  "settings.section.file": "Files",
  "settings.section.sessionManagement": "Session management",
  "settings.section.preference": "Preference settings",
  "settings.file.openInNewTab": "Open files in a new tab",
  "settings.file.openInNewTabHint":
    "When off, opening a file replaces the active preview tab instead of adding one.",
  "settings.file.lineWrap": "Wrap long lines in file previews",
  "settings.file.lineWrapHint":
    "When on, text wider than the preview wraps; when off, it scrolls horizontally. File contents are unchanged.",
  "settings.session.contextWindowUsage": "Show context window usage",
  "settings.followUp.title": "Follow-up message behaviour",
  "settings.followUp.hint":
    "Pressing Enter while a task is running either queues the follow-up or sends it to the running task immediately.",
  "settings.followUp.queue": "Queue",
  "settings.followUp.steer": "Send now",
  "home.suggestions": "Suggested",
  "home.chooseFolder": "Pick a folder",
  "home.local": "Local",
  "home.disclaimer": "Content generated by AI — please verify important info.",
  "composer.placeholderChat":
    "Type @ to reference plugins, sub-agents, files and folders",
  "composer.placeholderHome": "Type / to open search mode or a Skill",
  "composer.mic": "Voice input",
  "chat.copy": "Copy",
  "chat.copied": "Copied",
  "chat.like": "Like",
  "chat.dislike": "Dislike",
  "chat.fork": "Fork session",
  "chat.scrollBottom": "Jump to latest",
  // chat.turnProcess.* — retired by ticket 46 D6: the turn bar now
  // renders through the turn.* keys above (composite summary).
  "panel.progress": "Progress",
  "panel.progress.subtitle": "Track long-running tasks",
  "panel.progress.empty": "No activity yet",
  /* Plugins panel — the shell maps `sidebar.plugins` to this surface (a
     sibling of tasks / scheduled / websites / remote on desktop, NOT a
     settings tab — the earlier settings-tab route was a misread of the
     desktop layout). Ticket 60 phase 1 rewrote the placeholder value to
     describe the surface that now exists; the key stayed. */
  "panel.plugins.title": "Plugins",
  "panel.plugins.placeholder":
    "Five capability areas in one surface. Plugins is live: browse the local market, manage what is installed, and import a package from GitHub. Skills, apps, MCP and agents open in a later stage.",
  /* Git panel (slice 03) — right-panel surface that mirrors the
     desktop's right-tab Git view: branch + changed-file list +
     click-to-diff + branch switch. Empty-state and destructive-
     action copy live here so the panel can stay renderer-only. */
  "git.title": "Git",
  "git.empty.notRepo": "This folder is not a git repository",
  "git.empty.clean":
    "Working tree clean — no staged, unstaged, or untracked changes",
  "git.empty.noWorkspace": "No workspace selected",
  "git.branch.label": "Branch",
  "git.branch.tracking":
    "{{branch}} tracking {{upstream}} (ahead {{ahead}}, behind {{behind}})",
  "git.branch.tracking.noUpstream": "{{branch}} (no upstream)",
  "git.files.title": "Changed files",
  "git.files.empty": "No changed files",
  "git.files.staged": "staged",
  "git.files.unstaged": "unstaged",
  "git.files.untracked": "untracked",
  "git.file.openDiff": "View diff",
  "git.file.diff.empty": "No diff for this file",
  "git.file.diff.truncated":
    "Diff truncated — full diff available on the engine",
  "git.file.diff.loading": "Loading diff…",
  "git.file.diff.failed": "Could not load diff",
  "git.refresh": "Refresh",
  "git.refreshAria": "Refresh git status",
  "git.switch.confirm.title": "Switch branch?",
  "git.switch.confirm.body":
    'Switching to "{{branch}}" will discard uncommitted changes in your working tree. Continue?',
  "git.switch.confirm.ok": "Switch",
  "git.switch.confirm.cancel": "Cancel",
  "git.switch.success": "Switched to {{branch}}",
  "git.switch.failed": "Could not switch branch: {{error}}",
  "git.switcher.title": "Switch branch",
  "git.switcher.empty": "No local branches",

  /* Re-open state parity (webui-parity 07). The "session id is gone"
     hint fires when the URL deep-links to a session id the server no
     longer recognises (a deleted conversation or a different cid).
     Shown briefly so the user knows they were just routed home
     intentionally, then auto-dismissed. */
  "session.hint.notFound":
    "That session is no longer available. Returned to the home screen.",
  "session.hint.notFound.dismiss": "Dismiss",
  "session.hint.notFound.reset": "Go home",
  /* Error boundary copy — error.tsx and global-error.tsx share the
     same labels. The page-level copy uses the regular i18n dict; the
     global boundary inlines its bilingual copy because Next refuses
     to render the shared layout around a fatal crash, so it cannot
     resolve `t(...)` from a provider. */
  "webui.errorBoundary.title": "Something went wrong",
  "webui.errorBoundary.subtitle":
    "Reload, or go back home — your sidebar state has been kept on this device.",
  "webui.errorBoundary.reload": "Reload",
  "webui.errorBoundary.home": "Go home",
  "webui.errorBoundary.copy": "Copy diagnostics",
  "webui.errorBoundary.copied": "Copied",
  "webui.errorBoundary.details": "Diagnostics",
  "webui.errorBoundary.messageFallback": "The page failed to render.",

  /* Provider management (ticket 03) — the settings section that
     lists, edits, tests and persists the v2 providers catalogue.
     Bilingual by contract: every key has both an English and a
     Chinese entry below. */
  "providers.title": "Model providers",
  "providers.subtitle": "Configure API keys, protocols, and model catalogues",
  "providers.empty": "No custom models yet",
  "providers.add": "Add model",
  "providers.test": "Test connection",
  "providers.testing": "Testing…",
  "providers.testOk": "Connected in {{ms}}ms",
  "providers.testInvalidKey": "API key is invalid or missing",
  "providers.testBadProtocol": "Unsupported protocol",
  "providers.testProbeFailed": "Could not reach the endpoint",
  "providers.testTimeout": "Timed out",
  "providers.testHttp": "Endpoint replied {{status}}",
  "providers.delete": "Delete",
  "providers.deleteConfirm": "Delete provider {{id}}?",
  "providers.deleteHint":
    "Removes the provider and every model under it. This cannot be undone.",
  "providers.enabled": "Enabled",
  "providers.disabled": "Disabled",
  "providers.presetBadge": "Preset",
  "providers.customBadge": "Custom",
  "providers.field.id": "Provider id",
  "providers.field.label": "Display name",
  "providers.field.protocol": "Protocol",
  "providers.field.authType": "Auth type",
  "providers.field.apiKey": "API key",
  "providers.field.apiKeyPlaceholder":
    "Stored as-is — leave blank (or omit the field) to keep the existing key. Clearing is not supported.",
  "providers.field.baseURL": "Endpoint (baseURL)",
  "providers.field.baseURLHint": "Leave blank to use the protocol default",
  "providers.field.models": "Models",
  "providers.field.modelId": "Model id",
  "providers.field.modelLabel": "Display name",
  "providers.field.contextLimit": "Context limit (tokens)",
  "providers.field.thinkingLevels": "Thinking levels",
  "providers.field.modalities": "Modalities",
  "providers.models.add": "Add model",
  "providers.models.remove": "Remove",
  "providers.save": "Save providers",
  "providers.saving": "Saving…",
  "providers.saved": "Saved",
  "providers.saveError": "Could not save: {{error}}",
  "providers.loadError": "Could not load providers: {{error}}",
  "providers.models.thinkingLevels.low": "low",
  "providers.models.thinkingLevels.medium": "medium",
  "providers.models.thinkingLevels.high": "high",
  "providers.models.modalities.text": "text",
  "providers.models.modalities.image": "image",
  "providers.models.modalities.audio": "audio",
  "providers.models.modalities.video": "video",
  "providers.models.modalities.file": "file",
  "providers.idInvalid":
    "Lowercase letters, digits, '.', '-', '_'; must start with one",
  "providers.section.connection": "Connection",
  "providers.section.models": "Models",
  "providers.presets.title": "One-click enable",
  "providers.presets.unavailable":
    "Preset catalogue not available in this build",
  "providers.presets.enable": "Enable",
  "providers.presets.enabling": "Enabling…",
  // Ticket 54 — the desktop-parity add-model dialog and its
  // auto-fetch checkbox dialog. Empty-state strings (providers.empty /
  // providers.add) are retargeted in place: the key names stay, the
  // copy follows the desktop's 「暂未添加自定义模型」/「+ 添加模型」.
  "providers.dialog.title": "Add model",
  "providers.dialog.provider": "Provider",
  "providers.dialog.providerPlaceholder": "Select a provider",
  "providers.dialog.other": "+ Other (custom)",
  "providers.dialog.apiKeyPlaceholder": "Enter API Key",
  "providers.dialog.models": "Models",
  "providers.dialog.addEntry": "＋ Add",
  "providers.dialog.autoFetch": "Auto-fetch",
  "providers.dialog.entryTitle": "Model {{n}}",
  "providers.dialog.entryReset": "Reset this entry",
  "providers.dialog.entryRemove": "Delete this entry",
  "providers.dialog.field.name": "Model name",
  "providers.dialog.field.context": "Context window",
  "providers.dialog.field.maxOutput": "Max output tokens",
  "providers.dialog.field.maxOutputNa":
    "Not applicable in the local edition — the field is not persisted",
  "providers.dialog.field.thinking": "Reasoning levels",
  "providers.dialog.field.thinkingPlaceholder":
    "Type a level and press Enter, e.g. low, medium, high",
  "providers.dialog.field.attachments": "Supported attachments",
  "providers.dialog.attachments.image": "Image",
  "providers.dialog.attachments.pdf": "PDF",
  "providers.dialog.attachments.video": "Video",
  "providers.dialog.attachments.audio": "Audio",
  "providers.dialog.cancel": "Cancel",
  "providers.dialog.save": "Save",
  // API 格式 — the desktop's dropdown. The three values are the
  // protocols this build already supports; the labels are the
  // desktop's spelling, not a new set of formats.
  "providers.dialog.apiFormat": "API format",
  "providers.dialog.apiFormat.openai": "OpenAI Completions",
  "providers.dialog.apiFormat.anthropic": "Anthropic Messages",
  "providers.dialog.apiFormat.gemini": "Gemini",
  // 自定义 Headers — outbound request headers merged into every call
  // to this provider.
  "providers.dialog.headers": "Custom headers",
  "providers.dialog.headersAdd": "＋ Add header",
  "providers.dialog.headerName": "Header name",
  "providers.dialog.headerValue": "Header value",
  "providers.dialog.headerRemove": "Remove header {{name}}",
  // Footer connectivity check (form-level, gates 保存).
  "providers.dialog.formTest": "Test connection",
  "providers.dialog.formTestSkip": "Skip the connection test",
  "providers.dialog.formTestHint":
    "Saving is blocked until this provider answers, unless you skip the test",
  "providers.dialog.formTestNeedProvider": "Choose a provider and enter a key first",
  "providers.dialog.errorProvider": "Select a provider first",
  "providers.dialog.errorDuplicate": "Provider id already exists: {{id}}",
  "providers.dialog.modelsEmpty":
    "No models yet — click ＋ Add to enter one manually, or Auto-fetch to pick from the selected preset's catalogue",
  "providers.dialog.addEntryHint":
    "Add one empty model entry and fill it in by hand",
  "providers.dialog.autoFetchHint":
    "Pick models from the selected preset's built-in catalogue; fetches the list only, nothing is saved until you press Save",
  "providers.dialog.entryTest": "Test",
  "providers.dialog.entryTestHint":
    "Probe the provider endpoint with the API key and base URL currently filled in (endpoint-level check; it does not exercise this entry's model id)",
  "providers.dialog.testTesting": "Testing…",
  "providers.dialog.testOk": "Reachable · {{ms}}ms",
  "providers.dialog.testFail": "Unreachable: {{error}}",
  "providers.dialog.testNeedProvider":
    "Select a provider and enter an API key to enable the connectivity test",
  "providers.fetched.title": "Fetched models",
  "providers.fetched.presetNote":
    "Listed from the built-in provider catalogue — the local edition cannot query the provider's live model list with this key.",
  "providers.fetched.customEmpty":
    "The local edition cannot auto-fetch models for a custom provider — add them manually.",
  "providers.fetched.selectAll": "Select all",
  "providers.fetched.add": "Add",

  // Slice 15 — Sidebar workspace tabs.
  // Tab strip + launcher labels. The aria variants power the close-X
  // affordance so screen readers announce "Close Files tab" rather
  // than just the kind name.
  "workspaceTabs.tab.files": "Files",
  "workspaceTabs.tab.files.aria": "Close Files tab",
  "workspaceTabs.tab.git": "Changes",
  "workspaceTabs.tab.git.aria": "Close Changes tab",
  "workspaceTabs.tab.browser": "Browser",
  "workspaceTabs.tab.browser.aria": "Close Browser tab",
  "workspaceTabs.tab.tasks": "Tasks",
  "workspaceTabs.tab.tasks.aria": "Close Tasks tab",
  /* Slice 17 — search / plugins surfaces (column 4). These
     restore the sidebar's legacy 搜索 / 插件 nav entries to
     visible landing surfaces (no more silent no-op). */
  "workspaceTabs.tab.search": "Search",
  "workspaceTabs.tab.search.aria": "Close Search tab",
  "workspaceTabs.tab.plugins": "Plugins",
  "workspaceTabs.tab.plugins.aria": "Close Plugins tab",
  "workspaceTabs.tab.filePrefix": "File",
  "workspaceTabs.launcher.files": "Files",
  "workspaceTabs.launcher.git": "Changes",
  "workspaceTabs.launcher.tasks": "Tasks",
  "workspaceTabs.launcher.btw": "Side chat (beta)",
  "workspaceTabs.launcher.btw.disabledHint":
    "Side chat is not implemented yet. The tab slot is reserved for a future slice that wires it to a /btw-style side conversation.",
  "workspaceTabs.launcher.terminal": "Terminal",
  "workspaceTabs.launcher.terminal.disabledHint":
    "Terminal is not implemented yet. The tab slot is reserved for a future slice that wires it to the engine's terminal sandbox.",
  "workspaceTabs.launcher.browser": "Browser",
  "workspaceTabs.addTab.aria": "Add a new tab",
  "workspaceTabs.tabs.aria": "Workspace tabs",
  "workspaceTabs.tabs.empty": "No tabs open",
  // File-tab close label. The file name flows in as `{name}`;
  // a per-file render of this label is what the screen reader
  // announces ("Close file README.md"). The earlier version
  // reused the surface-tab close label and leaked the wrong
  // kind.
  "workspaceTabs.tab.file.aria": "Close file {name}",
  "workspaceTabs.empty.heading": "Open a surface",
  "workspaceTabs.empty.subtitle":
    "Pick a tab from the launcher. Files, Changes, Tasks, and Browser are wired. Side chat and Terminal are reserved for future slices.",
  "workspaceTabs.fileTab.pathAria": "Open file {path}",
  "workspaceTabs.fileTab.revealInTree": "Reveal in files",
  "workspaceTabs.fileTab.copyPath": "Copy path",
  "workspaceTabs.tasks.title": "Tasks",
  "workspaceTabs.tasks.subtitle":
    "Subagents the active session has dispatched.",
  "workspaceTabs.tasks.empty":
    "No subagents yet. They will appear here as the session dispatches them.",
  "workspaceTabs.tasks.jump": "Open session",
  "workspaceTabs.tasks.toolCall": "Tool call",
  "workspaceTabs.tasks.sinceAgo": "{n}s ago",
  "workspaceTabs.tasks.minutesAgo": "{n}m ago",
  "workspaceTabs.tasks.hoursAgo": "{n}h ago",
  "workspaceTabs.tasks.jumpError": "Failed to switch to the subagent session.",
  "workspaceTabs.column.resizeAria": "Resize column",
  "workspaceTabs.column.resetAria": "Reset column width",
  "workspaceTabs.column.conversationAria": "Resize conversation column",
  "workspaceTabs.column.previewAria": "Resize preview column",
  "workspaceTabs.column.treeAria": "Resize file tree column",
  "workspaceTabs.column.sidebarAria": "Resize session sidebar",
  "workspaceTabs.column.closedAllTabs":
    "All tabs closed. The panel column has been collapsed.",
  /* Slice 17 — preview column empty hint (no file tabs and no
     browser tab). The hint mirrors the desktop reference's
     empty state ("click a file to preview it"). */
  "workspaceTabs.preview.empty":
    "Click a file or pick one in the file tree to preview it here.",
  /* Slice 17 — tree column empty hint (no surfaces open yet).
     The hint lists the five options the column can host and
     lets the user open one directly. */
  "workspaceTabs.tree.empty": "Pick a surface to navigate the workspace.",
  /* Slice 17 — tree column surface selector (segmented control). */
  "workspaceTabs.tree.selector.aria": "Workspace navigation",
  "workspaceTabs.tree.selector.files.aria": "Switch to files",
  "workspaceTabs.tree.selector.git.aria": "Switch to changes",
  "workspaceTabs.tree.selector.tasks.aria": "Switch to tasks",
  "workspaceTabs.tree.selector.search.aria": "Switch to search",
  "workspaceTabs.tree.selector.plugins.aria": "Switch to plugins",
  /* Slice 21 — close button on the active tree surface. The
     aria label is the only place that names the consequence
     ("discards the active surface") — closing the surface tab
     unmounts its body. For the search surface that means the
     current query and expanded-path hint are gone (state lives
     in `SearchSurface`'s local state, not in storage); for the
     file tree it means the FilesPanel unmounts but the
     sessionStorage-backed expanded path + filter survive for
     the next time the user opens Files. The keyboard-reachable
     control is the only affordance; the announcement lives in
     the aria-label. */
  "workspaceTabs.tree.close.aria":
    "Close the active surface and hide the navigation column",
  "workspaceTabs.tree.close.search.aria":
    "Close the search surface and discard the current query",
  /* Slice 19b supersedes the slice-17 placeholder copy with a real
     exhaustive search above. The slice-17 keys are gone — the
     search surface is no longer a no-op placeholder. */
  /* Slice 17 — plugins surface copy. The card is mounted AND
     labelled so a click on the sidebar's 插件 entry visibly
     produces a surface rather than silently no-op'ing. Ticket 60
     phase 1 replaced the placeholder value with the real surface
     (components/plugins-surface.tsx) while the key stayed. */
  "workspaceTabs.plugins.title": "Plugins",
  "workspaceTabs.plugins.placeholder":
    "Five capability areas in one surface. Plugins is live: browse the local market, manage what is installed, and import a package from GitHub. Skills, apps, MCP and agents open in a later stage.",

  /* Ticket 60 phase 1, slice B — the plugin surface (five capability
     areas). One namespace for the whole surface, so a missing string is
     obvious. Three families, three different meanings, never mixed:

       plugins.area.<domain>.pending.*  a phase that has not been built
       plugins.market.official.notLocal  a cloud account the local
                                        edition does not have
       plugins.state.*                   the four request states

     `translate()` takes no interpolation parameters, so counts are
     rendered next to their label rather than inside one string. */
  "plugins.area.aria": "Plugin capability areas",
  "plugins.area.plugins": "Plugins",
  "plugins.area.skills": "Skills",
  "plugins.area.apps": "Apps",
  "plugins.area.mcp": "MCP",
  "plugins.area.agents": "Agents",
  "plugins.area.skills.pending.title": "Skills management",
  "plugins.area.skills.pending.body":
    "The skills screen opens in a later stage. This server has no skills endpoint yet, so the list stays empty on purpose — nothing here is sample data.",
  "plugins.area.apps.pending.title": "Apps management",
  "plugins.area.apps.pending.body":
    "The apps screen opens in a later stage. The runtime declares an apps contract but this server exposes no endpoint for it, so the list stays empty on purpose.",
  "plugins.area.mcp.pending.title": "MCP server management",
  "plugins.area.mcp.pending.body":
    "The MCP screen opens in a later stage. Registering, editing and testing local stdio or HTTP servers needs endpoints this server does not have yet.",
  "plugins.area.agents.pending.title": "Agent management",
  "plugins.area.agents.pending.body":
    "The agents screen opens in a later stage. There is no agent endpoint at all yet, so this area shows no list and no sample agents.",
  "plugins.view.aria": "Plugin views",
  "plugins.view.market": "Marketplace",
  "plugins.view.personal": "Installed",
  "plugins.source.aria": "Marketplace source",
  "plugins.source.local": "Local",
  "plugins.source.official": "Official",
  "plugins.source.unknown": "Unknown source",
  "plugins.search.aria": "Search plugins",
  "plugins.search.placeholder": "Search plugins",
  "plugins.category.aria": "Plugin category",
  "plugins.category.all": "All",
  "plugins.category.other": "Other",
  "plugins.category.office": "Office",
  "plugins.category.studio": "Creative",
  "plugins.category.design": "Design and sites",
  "plugins.category.code": "Code",
  "plugins.category.business": "Business",
  "plugins.category.sales": "Sales",
  "plugins.category.productivity": "Productivity",
  "plugins.category.tools": "Tools",
  "plugins.category.science": "Science and healthcare",
  "plugins.category.education": "Education",
  "plugins.action.install": "Install",
  "plugins.action.uninstall": "Uninstall",
  "plugins.action.enable": "Enable",
  "plugins.action.disable": "Disable",
  "plugins.action.refresh": "Refresh plugins",
  "plugins.action.retry": "Try again",
  "plugins.action.import": "Import from GitHub",
  "plugins.action.notLocal.notice":
    "This action needs the official cloud account, which the local edition does not have. Nothing was changed.",
  "plugins.card.installed": "Installed",
  "plugins.card.capability.skill": "Skills",
  "plugins.card.capability.mcp": "MCP",
  "plugins.card.capability.app": "Apps",
  "plugins.card.capability.hook": "Hooks",
  "plugins.state.loading": "Loading plugins",
  "plugins.state.empty.market": "This market has no plugins yet.",
  "plugins.state.empty.installed": "No plugins are installed.",
  "plugins.state.error.title": "Plugins could not be loaded",
  "plugins.state.error.body": "The server refused the request.",
  "plugins.market.official.notLocal.title": "Official marketplace",
  "plugins.market.official.notLocal.body":
    "The official marketplace requires a cloud account and is not reachable in the local edition. Browse local plugins or import from a GitHub URL instead.",
  "plugins.market.localSkills.title": "Local skills",
  "plugins.confirm.uninstall.title": "Uninstall this plugin?",
  "plugins.confirm.uninstall.body":
    "Its skills, MCP servers and hooks stop being available right away. You can install it again from the local market.",
  "plugins.import.title": "Import a plugin from GitHub",
  "plugins.import.url.aria": "GitHub repository URL",
  "plugins.import.url.placeholder": "https://github.com/<owner>/<repo>",
  "plugins.import.preview": "Preview",
  "plugins.import.submit": "Import",
  "plugins.import.empty": "Enter a GitHub URL and preview it first.",
  "plugins.import.canImport": "This package can be imported.",
  "plugins.import.cannotImport":
    "This package exposes nothing this runtime can use, so there is nothing to import.",
  "plugins.import.size": "Package size",
  "plugins.import.failed": "Import failed:",
  /* Slice 18 — three-state appearance setting. Strings are registered here
     so the central MessageKey union covers them (the runtime translator
     goes through `translate()`); `lib/i18n-appearance.ts` is a slice-local
     helper that keeps the constants in one place. Both locales ship a
     complete set — see webapp/test/i18n-appearance.test.ts. */
  "appearance.choice.light": "Light",
  "appearance.choice.dark": "Dark",
  "appearance.choice.system": "Follow system",
  "appearance.choice.light.aria":
    "Light mode — fixed, ignores the system theme",
  "appearance.choice.dark.aria": "Dark mode — fixed, ignores the system theme",
  "appearance.choice.system.aria":
    "Follow system — switch the page theme when your operating system switches",
  "appearance.hint.fixed":
    "The page stays in this theme no matter what your operating system does.",
  "appearance.hint.system":
    "The page follows your operating system's dark / light setting. Switches live, without refreshing.",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "settings.shortcuts.notice":
    "Not applicable in the browser: the WebUI cannot register global shortcuts. The keys below are the desktop defaults, listed for reference only.",
  "settings.shortcuts.group.miniChat": "Mini Chat",
  "settings.shortcuts.group.common": "General",
  "settings.shortcuts.item.miniChat": "Show or hide Mini Chat",
  "settings.shortcuts.item.miniChatHint":
    "Summon or dismiss the quick-input mini window from any app",
  "settings.shortcuts.item.globalSearch": "Global search",
  "settings.shortcuts.item.globalSearchHint":
    "Search features, settings, and task sessions",
  "settings.shortcuts.item.searchTasks": "Search tasks and sessions",
  "settings.shortcuts.item.searchTasksHint":
    "Open search results scoped to tasks and sessions only",
  "settings.shortcuts.item.newTask": "New task",
  "settings.shortcuts.item.newTaskHint": "Open a fresh task input page",
  "settings.shortcuts.item.newTaskNoProject": "New task without a project",
  "settings.shortcuts.item.newTaskNoProjectHint":
    "Start a task right away without linking a project folder",
  "settings.shortcuts.item.openFolder": "Open project folder",
  "settings.shortcuts.item.openFolderHint":
    "Choose a local folder as the workspace",
  "settings.shortcuts.item.openSettings": "Open settings",
  "settings.shortcuts.item.openSettingsHint": "Open the client settings page",
  "settings.shortcuts.item.holdDictation": "Hold-to-dictate",
  "settings.shortcuts.item.holdDictationHint":
    "Hold the shortcut to start voice input; release to stop",
  "settings.shortcuts.item.toggleDictation": "Toggle dictation",
  "settings.shortcuts.item.toggleDictationHint":
    "Press once to start voice input, press again to stop",
  "settings.shortcuts.item.invertFollowUp": "Invert follow-up behaviour",
  "settings.shortcuts.item.invertFollowUpHint":
    "Send the drafted message the opposite of the follow-up setting (queue or send immediately), for this message only",
  "settings.shortcuts.unset": "Not set",
  "settings.shortcuts.clear": "Clear shortcut",
  "settings.shortcuts.reset": "Reset shortcut",
  "settings.voice.group.regular": "General",
  "settings.voice.group.dictation": "Dictation",
  "settings.voice.microphone": "Microphone",
  "settings.voice.microphoneHint": "Used for dictation voice input",
  "settings.voice.holdKey": "Hold-to-dictate shortcut",
  "settings.voice.holdKeyHint":
    "Hold it inside the app to dictate into the input box",
  "settings.voice.toggleKey": "Toggle-dictation shortcut",
  "settings.voice.toggleKeyHint":
    "Press once inside the app to start dictating, press again to stop",
  "settings.voice.unset": "Not set",
  "settings.personal.instructions": "Custom instructions",
  "settings.personal.instructionsPlaceholder":
    "Define how agents should work, answer, and execute tasks — extra instructions and context for every agent on this device...",
  "settings.personal.aboutYou": "About you",
  "settings.personal.aboutYouPlaceholder":
    "Tell agents about your background and long-term preferences…",
  "settings.personal.memory": "Memory",
  "settings.personal.memoryHint":
    "Use saved memories in prompts, reminders, and follow-up upkeep",
  "settings.personal.proactiveMemory": "Proactive memory",
  "settings.personal.proactiveMemoryHint":
    "Spot preferences and reusable know-how worth keeping long-term, and save them via Memory",
  "settings.personal.memorySummary": "Memory summary",
  "settings.personal.memorySummaryHint":
    "View, edit, or delete the long-term memories MiniMax has organised.",
  "settings.personal.manage": "Manage",
  "settings.memory.title": "Memory summary",
  "settings.memory.placeholder":
    "Long-term memories curated by MiniMax appear here.",
  "settings.memory.empty": "No memory summary generated yet",
  "settings.memory.more": "More",
  "settings.memory.close": "Close",
  "settings.codeReview.hint":
    "Customise how the built-in code-review instructions run, and set your review guidelines",
  "settings.codeReview.method": "Review method",
  "settings.codeReview.methodSubsession": "Sub-session",
  "settings.codeReview.guidelines": "Custom review guidelines",
  "settings.codeReview.guidelinesPlaceholder":
    "Enter code-review rules to apply on every review",
  /* Ticket 59 D3-4: the settings-modal port's hardcoded Chinese
     moved into the dictionary (en side). */
  "settings.nav.aria": "Settings sections",
  "settings.account.info": "Account",
  "settings.account.localLoggedOut": "Local mode, not signed in",
  "settings.account.signOutUnavailable": "The local edition has no account service",
  "settings.account.signOut": "Sign out",
  "settings.archived.empty": "No archived tasks yet",
  "settings.worktree.empty": "Worktree management is not available in the local edition yet",
  "settings.mode.section": "Mode",
  "settings.mode.coding": "Built for coding",
  "settings.mode.codingHint": "Keeps technical detail and developer tooling",
  "settings.mode.work": "Built for everyday work",
  "settings.mode.workHint": "Just as capable, with less technical noise",
  "settings.app.menuBar": "Show in menu bar",
  "settings.app.menuBarHint": "Show the app icon in the menu bar / system tray",
  "settings.app.autoStart": "Start at login",
  "settings.app.autoStartHint": "Launch the app automatically at login",
  "settings.app.notifications": "Desktop notifications",
  "settings.app.notificationsHint": "Notify when a task finishes, fails, or waits on a permission decision",
  "settings.app.earlyAccess": "Join early access",
  "settings.app.earlyAccessHint": "Get the newest features first",
  "settings.app.indexing": "Accelerated indexing",
  "settings.app.indexingHint":
    "MiniMax Code builds a semantic index of the workspace to speed up code search",
  "settings.links.section": "Links",
  "settings.links.web": "Where web links open",
  "settings.links.webHint": "Default destination for public web links",
  "settings.links.builtinBrowser": "Built-in browser",
  "settings.links.local": "Where local links open",
  "settings.links.localHint": "Default destination for local dev pages",
  "settings.agentControl.section": "Agent permissions",
  "settings.agentControl.browserPanel": "Open the browser panel automatically",
  "settings.agentControl.browserPanelHint": "Open the side browser panel when the agent drives a web page",
  "settings.preference.watermark": "Remove the AI watermark",
  "settings.preference.watermarkHint":
    "When off, downloads carry an explicit AI watermark; turning it on means you have read and agreed to the watermark-removal rules",
  "settings.preference.dataOptIn": "Use data to improve the experience",
  "settings.preference.dataOptInHint":
    "Allow your conversations to improve MiniMax Code; your data stays private and secure",
  "settings.about.section": "About",
  "settings.about.uploadLogs": "Upload logs",
  "settings.about.uploadLogsHint": "Upload app logs to help with troubleshooting",
  "settings.about.uploadUnavailable": "The local edition cannot upload logs",
  "settings.about.uploadAction": "Upload",
  "settings.about.version": "App version",
  "settings.about.updateUnavailable": "The local edition cannot check for updates",
  "settings.about.checkUpdate": "Check for updates",
  "settings.about.localUrl": "Local service URL",
  "settings.about.lanUrl": "LAN service URL",
  "usageModels.source.aria": "Choose the model source",
  "usageModels.minimax.notEnabled": "Not enabled",
  "usageModels.minimax.apiKeyPlaceholder": "Enter API key",
  "usageModels.minimax.testAria": "Test connectivity",
  "usageModels.minimax.unavailable": "The local edition has no MiniMax API key service",
  "usageModels.minimax.saveAndUse": "Save and use",
  "usage.banner.fiveHourLow": "5-hour quota is running low",
  "usage.banner.weeklyLow": "Weekly quota is running low",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "app.name": "MiniMax Code",
  "app.connecting": "正在连接引擎…",
  "app.disconnected": "连接已断开",

  "topbar.newSession": "新建会话",
  "topbar.stop": "停止",

  "sidebar.empty": "暂无会话",
  "sidebar.untitled": "未命名",
  "sidebar.delete": "删除",
  "sidebar.rename": "重命名此会话",
  "sidebar.search": "搜索",
  "sidebar.settings": "设置",
  "sidebar.resize": "调整侧栏宽度",
  "sidebar.newInProject": "在此项目中新建任务",

  "chat.empty": "开始一段对话",
  "chat.thinking": "思考中",
  "chat.status.running": "运行中",
  "chat.tps": "tok/s",
  "session.status.error": "以错误结束",
  "session.status.aborted": "已停止",
  "session.status.interrupted": "已中断",
  "chat.thinkingStatus.working": "正在干活",
  "chat.thinkingStatus.planning": "正在规划",
  "chat.thinkingStatus.wiring": "正在串线信息",
  "chat.thinkingStatus.checking": "正在检查",
  "chat.system": "系统",

  "composer.send": "发送",
  "composer.hint": "Enter 发送，Shift+Enter 换行",
  "composer.sending": "正在发送…",
  /* 输入框旁的上下文窗口指示器。面板只显示引擎真实上报的数据；桌面端还有按类别
     的占用明细, 本服务端没有该数据 (见 components/context-meter.tsx)。 */
  "context.show": "显示上下文窗口用量",
  "context.title": "上下文窗口",
  "context.used": "已用",
  "context.speed": "输出速度",
  // 后端 percent 用 1 位小数；整数四舍五入为 0 但实际用量 > 0 时，用 "<1%" 让小占用可见。
  "context.lessThanOne": "<1%",
  "context.breakdown.systemPrompt": "系统提示词",
  "context.breakdown.memory": "记忆",
  "context.breakdown.tools": "工具",
  "context.breakdown.skills": "技能",
  "context.breakdown.messages": "消息",
  "context.breakdown.other": "其他",
  "context.planTitle": "套餐用量",
  "context.expandAria": "展开上下文分类",
  "context.collapseAria": "收起上下文分类",
  "composer.readOnly": "只读模式已开启",
  "composer.attach": "添加附件或技能",
  "composer.dropHint": "松开上传文件",
  "composer.model": "模型",
  "composer.noModels": "暂无可用模型",
  /* Model selector — provider-grouped dropdown. */
  "modelSelector.other": "其他",
  /* 模型选择器 — ticket 04。未配置 API Key 的供应商分组置灰并提示去
     设置里填 key；模态徽标按 modalities 数组渲染。 */
  "modelSelector.noKeyHint": "请在设置中配置 API Key",
  /* 模型选择器 — ticket 07。下拉顶部新增的思考等级行标题与提示。 */
  "modelSelector.level": "思考等级",
  "modelSelector.levelHint": "点等级会同时绑定当前模型",
  /* 模型选择器 — ticket 09。下拉顶部的「添加供应商」入口直跳到设置 → 模型供应商，
     自动新建草稿并把焦点放到 id 输入框。沿用侧栏的「模型供应商」命名。 */
  "modelSelector.addProvider": "添加模型 / 供应商",
  /* 模型选择器 — ticket 10。右侧级联子菜单的 aria-label。 */
  "modelSelector.thinkingLevels": "思考等级",
  /* 模型选择器 — U6 上下文窗口。详情区标题与单个选项的用量提示。
     `higher_usage` 是引擎目前唯一的提示值（物化内置树中的
     contextWindowOptionHints）。 */
  "modelSelector.contextWindow": "上下文窗口",
  "modelSelector.contextWindowHigherUsage": "用量较高",
  /* 模型选择器 — 工单 49（第一批）。详情区跟随 hover / 键盘聚焦的行：
     `detailEmpty` 是无可描述对象时的提示（无聚焦行且无活动模型）；
     `detailNoSettings` 是目标模型既无上下文窗口档位也无思考等级时的提示；
     `detailPreview` 标记「已聚焦但未选中」的预览态（单选组禁用）；
     `detailPreviewHint` 是单选组的 title，解释为什么点不动。 */
  "modelSelector.detailEmpty": "选择一个模型查看设置",
  "modelSelector.detailNoSettings": "这个模型没有可调设置。",
  "modelSelector.detailPreview": "预览",
  "modelSelector.detailPreviewHint": "先选中该模型才能调整设置",
  "modelSelector.modalityBadge.text": "文本",
  "modelSelector.modalityBadge.image": "图像",
  "modelSelector.modalityBadge.audio": "音频",
  "modelSelector.modalityBadge.video": "视频",
  "modelSelector.modalityBadge.file": "文件",
  /* 思考等级选择器 (off / low / medium / high)。 */
  "thinkingPicker.label": "思考等级",
  "thinkingPicker.none": "沿用引擎默认",
  "thinkingPicker.off": "关闭",
  "thinkingPicker.on": "开启",
  "thinkingPicker.low": "低",
  "thinkingPicker.minimal": "极少",
  "thinkingPicker.medium": "中",
  "thinkingPicker.high": "高",
  "thinkingPicker.xhigh": "极高",
  "thinkingPicker.max": "最大",

  "permission.label": "权限模式",
  "permission.ask": "主动询问",
  "permission.auto": "智能授权",
  "permission.full": "始终授权",
  "permission.read": "只读",
  "permission.off": "关闭权限检查",

  "plan.title": "计划",
  "ask.title": "提问",

  "error.send": "消息发送失败",
  "error.session": "会话列表加载失败",
  "toolbar.workspace": "工作区",
  "toolbar.browser": "网页",
  "toolbar.git": "Git",
  /* 铃铛打开的是站内信, 不是告警列表 —— 上游把系统消息与产品通知都放这里。 */
  "toolbar.alerts": "站内信",
  "common.unsupported": "暂不支持",
  /* 工单 55c —— 共享的「本地版做不了这件事」标注。与 `common.unsupported`
     （「暂不支持」= 引擎契约尚未落地）区分：notLocal 表示该能力依赖云端账号
     或操作系统集成，自托管的本地服务端没有这条路，等不来。文案与用量页的
     `usage.notLocal`（工单 53）一致。 */
  "common.notLocal": "本地版不适用",

  /* 站内信 —— 侧栏底部的告警入口。上游用未读条数做 aria-label；这里拆成两个
     键，因为翻译函数不接受插值参数。 */
  "inbox.title": "站内信",
  "inbox.entryUnread": "站内信，有未读消息",
  "inbox.entryNoUnread": "站内信，无未读消息",
  "inbox.tabAll": "全部",
  "inbox.tabProduct": "产品更新",
  "inbox.tabMine": "我的消息",
  "inbox.markAllRead": "全部已读",

  /* 帐号菜单条目 —— 与桌面用户菜单条目集 1:1 对齐（工单 55c，ref-01）：
     设置 / 升级 / 每日签到 / 用量 / 反馈与帮助 / 退出登录，底部是用户卡。 */
  "userMenu.checkin": "每日签到",
  "userMenu.signOut": "退出登录",
  "userMenu.upgrade": "升级",
  "userMenu.feedback": "反馈与帮助",
  /* 引擎未上报登录身份时用户卡的显示名 —— 桌面账号名的诚实替身。 */
  "userMenu.localUser": "本地用户",

  /* 项目右键菜单（工单 55c，ref-26）。重命名 / 置顶由浏览器本地项目自定义
     （webapp/lib/project-custom.ts）支撑；在文件夹中显示与归档对话渲染为
     禁用并标注 `common.notLocal`；移除在确认弹窗后批量删除项目下的会话。 */
  "projectMenu.rename": "重命名项目",
  "projectMenu.pin": "置顶项目",
  "projectMenu.unpin": "取消置顶",
  "projectMenu.revealInFolder": "在文件夹中显示",
  "projectMenu.archive": "归档对话",
  "projectMenu.remove": "移除",
  "projectMenu.removeConfirmTitle": "移除项目",
  /* 两个 {count} 占位均由组件填充为真实删除集——主会话与子代理会话
     全量，绝不用侧栏角标的主会话数：不可逆确认不得少报要删的东西
     （质检 F1）。 */
  "projectMenu.removeConfirmBody":
    "将删除该项目下的全部对话与子代理会话（共 {count} 个），且不可恢复。",
  /* 服务端对每个单会话删除分别授权（无批量契约），因此弹窗预先写明
     会出现多少次授权确认（质检 F2）。 */
  "projectMenu.removeConfirmAuthNote":
    "删除将逐个进行，期间会出现 {count} 次授权确认，请逐一批准以继续。",
  /* 批量执行中的实时进度：{done}/{total}（质检 F2）。 */
  "projectMenu.removeProgress": "正在删除 {done}/{total}…",
  "projectMenu.removeConfirm": "移除",
  "projectMenu.cancel": "取消",

  /* 会话行右键菜单（webui-parity 58 线 B —— 参照 SessionRail 的
     `openSessionMenu` 菜单项，中文文案照抄参照）。置顶/归档/复制为新会话/
     复制到新工作树暂无服务端契约；在文件夹中显示与问题反馈参照本身即为
     禁用项，照搬；重命名/复制/删除为真实能力。 */
  "sessionMenu.pin": "置顶",
  "sessionMenu.rename": "重命名",
  "sessionMenu.archive": "归档",
  "sessionMenu.forkCurrent": "复制为新会话",
  "sessionMenu.forkWorktree": "复制到新工作树",
  "sessionMenu.revealInFolder": "在文件夹中显示",
  "sessionMenu.copy": "复制",
  "sessionMenu.copyWorkspaceDir": "复制工作目录",
  "sessionMenu.copySessionId": "复制会话 ID",
  "sessionMenu.feedback": "问题反馈",
  "sessionMenu.delete": "删除",
  "sessionMenu.copied": "已复制",

  /* 主页快捷能力胶囊（工单 55c，ref-28）—— 桌面版输入框下方的云端技能
     胶囊。文案逐字照参照截图；每颗都是占位，点击 toast `common.notLocal`，
     因为这些技能仅云端提供。 */
  "home.cap.video": "视频生成",
  "home.cap.vibe": "Vibe Coding",
  "home.cap.design": "设计视觉",
  "home.cap.product": "产品运营",
  "home.cap.askMcode": "询问 MCode",
  /* 用量文案 — 设置页「用量与模型」节里的用量卡片（工单 37）。原先挂这些
     文案的帐号菜单 hover 弹层已删除；卡片经由 store 读同一个
     `api.getQuota()` 快照（remaining %、resetAt、weeklyResetAt）。
     `usage.used` / `usage.reset` 已随工单 53 的进度条重构删除——桌面
     形态直接印「0% / 100%」与相对时间重置文案，旧标签式字符串不再有
     消费者。 */
  "usage.title": "用量",
  "usage.fiveHour": "5 小时限额",
  // 桌面参照截图作「周限额」（工单 53 逐字对齐），此前误作「每周限额」。
  "usage.weekly": "周限额",
  "usage.unavailable": "暂无用量数据",
  "usage.refresh": "刷新",
  "usage.errorTitle": "用量加载失败",
  "usage.errorBody": "请稍后再试",
  /* 工单 53 —— 本节的桌面对齐重构：分段页签（Token Plan / 自定义模型）、
     Token Plan 面板的套餐卡、积分行、发票行、视频限额条（本地无数据源），
     以及所有本地版没有数据源的数据区统一填充的「本地版不适用」占位文案。
     重置文案键带 {t} 占位，由组件 .replace() 填充，约定与
     files.tree.mtime.* 相同。文案逐字照桌面参照截图
     （refs/ui/03-settings-usage-models.jpg）。 */
  "usage.tab.tokenPlan": "Token Plan",
  "usage.tab.inUse": "使用中",
  "usage.tab.customModels": "自定义模型",
  "usage.notLocal": "本地版不适用",
  "usage.plan.title": "当前套餐",
  "usage.plan.upgrade": "升级",
  "usage.plan.manage": "管理",
  "usage.credits": "积分",
  "usage.plan.topUp": "去充值",
  "usage.video": "视频限额",
  "usage.credits.hint": "开启后，可以在对话中消耗你的积分（含赠予积分）。",
  "usage.invoice.title": "发票",
  "usage.invoice.apply": "申请",
  "usage.invoice.hint": "请前往 MiniMax 开放平台申请发票",
  "usage.resetsIn": "{t}后重置",
  "usage.duration.minute": "{n}分",
  "usage.duration.hour": "{n}小时",
  "usage.duration.hourMinute": "{h}小时{n}分",
  "toolbar.files": "文件",
  "toolbar.usage": "用量",
  "plan.readOnlyNotice":
    "智能体正在等你审阅这份计划。本网页端能展示计划，但无法应答这次审阅 —— 请回到你发起会话的客户端去批准；若不处理，本轮将一直暂停。",
  "plan.close": "关闭",
  "ask.other": "其他…",
  "ask.submit": "提交",
  "ask.skip": "跳过",
  // 「跳过」按钮经 isAskAnswer 通道发给引擎的正文。它是一条提示词而非按键，
  // 所以必须写成智能体能直接理解的整句。
  "ask.skipReply": "跳过这个问题 —— 不用我作答，请继续。",
  "ask.multiSelectHint": "可多选",
  "auth.title": "需要授权",
  "auth.requested": "智能体正在请求继续操作的权限。",
  "auth.approve": "批准",
  "auth.deny": "拒绝",
  "panel.settings": "设置",
  "files.parent": "返回上一级",
  "files.empty": "空文件夹",
  "files.showing": "已显示",
  "files.filterPlaceholder": "过滤…（支持 glob，如 *.txt）",
  "files.clearFilter": "清除过滤",
  "files.noMatch": "没有匹配的条目",
  // 01 — collapsible file tree additions
  "files.tree.empty": "空文件夹",
  "files.tree.truncated": "还有 {n} 项未显示",
  "files.tree.hidden": "显示隐藏文件",
  "files.tree.shown": "隐藏隐藏文件",
  "files.tree.refresh": "刷新",
  "files.tree.refreshAria": "刷新该目录",
  "files.tree.newFolder": "新建子目录",
  "files.tree.newFolderPrompt": "新目录名",
  "files.tree.copyPath": "复制绝对路径",
  "files.tree.copied": "已复制",
  "files.tree.copyFailed": "复制失败",
  "files.tree.outOfBounds": "该目录在工作区边界外，无法展开",
  "files.tree.expand": "展开",
  "files.tree.collapse": "收起",
  "files.tree.dirAria": "目录 {name}",
  "files.tree.fileAria": "文件 {name}",
  "files.tree.loading": "加载中…",
  "files.tree.mtime.now": "刚刚",
  "files.tree.mtime.minutesAgo": "{n} 分钟前",
  "files.tree.mtime.hoursAgo": "{n} 小时前",
  "files.tree.mtime.daysAgo": "{n} 天前",
  "files.tree.mtime.weeksAgo": "{n} 周前",
  "files.tree.mtime.monthsAgo": "{n} 月前",
  "files.tree.mtime.yearsAgo": "{n} 年前",
  /* Slice 19b — bounded server search wired into the file-tree
     filter. See the en block for the footer / loading / error
     strings; both locales share the same key set. */
  "files.search.loading": "搜索中…",
  "files.search.error": "搜索失败：{{error}}",
  "files.search.footer.scanned": "已搜 {n} 条",
  "files.search.footer.matches": "命中 {n}",
  "files.search.footer.skipped.node_modules": "跳过 node_modules {n}",
  "files.search.footer.skipped.git": "跳过 .git {n}",
  "files.search.footer.skipped.credential": "跳过凭据 {n}",
  "files.search.footer.skipped.huge": "跳过超大目录尾部 {n}",
  "files.search.footer.skipped.optional": "跳过分发目录 {n}",
  "files.search.footer.truncated": "已截断（{budget}）",
  "files.search.footer.elapsed": "{n}",
  "files.search.footer.elapsedValue": "{ms}ms",
  "files.search.footer.budget.depth": "深度",
  "files.search.footer.budget.nodes": "节点数",
  "files.search.footer.budget.wallClock": "时间",
  "files.search.footer.budget.matches": "命中数",
  "files.search.credential": "凭据文件",
  /* Slice 19b — workspace search sidebar surface. */
  "workspaceTabs.search.placeholder": "搜索工作区（含未展开目录）…",
  "workspaceTabs.search.tip":
    "输入关键词搜索工作区。已展开目录的命中立刻显示；过滤无结果时会全盘搜索。",
  "workspaceTabs.search.tipLoaded":
    "命中均在已加载的目录中——继续输入会扩展搜索范围。",
  "workspaceTabs.search.tipExhaustive":
    "全盘搜索工作区，跳过的目录会列在底栏。",
  "workspaceTabs.search.empty": "没有命中。",
  "workspaceTabs.search.open": "打开",
  // 12 — open.file.in.web preview pane (right column).
  "files.preview.empty": "在文件树或轮次总结中点击文件路径以预览。",
  "files.preview.close": "关闭预览",
  "panel.close": "关闭",
  "settings.security": "网络与访问",
  "settings.lan": "局域网共享",
  "settings.lanBind": "绑定所有网卡(需重启)",
  "settings.readOnly": "只读模式",
  "settings.tokenEnabled": "要求 Token",
  "settings.localUrl": "本地地址",
  "settings.lanUrl": "局域网地址",
  "settings.engine": "引擎",
  "settings.saved": "已保存",
  "settings.resetToken": "轮换 Token",
  "settings.ackToken": "我已保存 Token",
  "settings.tokenValue": "Token",
  "alerts.empty": "暂无消息",
  /* Workspace panel section labels are aligned with the desktop's
     `workspace_panel.section_*` keys (反编译 36705 chunk). */
  "workspace.sectionEnvironment": "环境信息",
  /* Workspace panel — switch workspace entry (中文). */
  "workspace.switch": "切换工作区",
  "workspace.picker.title": "切换工作区",
  "workspace.picker.pathPlaceholder": "路径…",
  "workspace.picker.up": "返回上一级",
  "workspace.picker.home": "主目录",
  /* v0.5.by: home-chip dropdown (Level 1) — 中文 */
  "workspace.chipDropdown.recent": "最近",
  "workspace.chipDropdown.chooseNew": "选择新项目",
  "workspace.chipDropdown.noProject": "不需要项目",
  /* 侧栏项目行的切换动作 */
  "workspace.projectRow.switch": "切换到此工作区",
  "workspace.picker.root": "允许根",
  "workspace.picker.newFolder": "新建文件夹",
  "workspace.picker.newFolderPrompt": "文件夹名",
  "workspace.picker.filterPlaceholder": "过滤…（支持 glob，如 *.md）",
  "workspace.picker.confirm": "选择",
  "workspace.picker.cancel": "取消",
  "workspace.picker.pickCurrent": "使用当前文件夹",
  "workspace.picker.noWorkspace": "无需工作区(临时)",
  "workspace.picker.loading": "加载中…",
  "workspace.picker.empty": "文件夹为空",
  "workspace.picker.error": "无法读取该文件夹",
  "workspace.picker.tabs.recents": "最近",
  "workspace.picker.tabs.browse": "浏览",
  "workspace.picker.recents.empty": "暂无最近工作区",
  "workspace.picker.recents.search": "搜索最近工作区",
  "workspace.picker.useWorkspace": "使用此工作区",
  "workspace.picker.mustBeUnder": "路径必须在以下位置之一：",
  "workspace.picker.created": "已创建",
  "workspace.sectionPlan": "计划",
  "workspace.sectionAgentTeam": "Agent 团队",
  "workspace.sectionWorkingFolders": "工作文件夹",
  "workspace.sectionSources": "来源",
  "workspace.sectionDeliverables": "交付物",
  "workspace.section.development": "开发中",
  "workspace.env.activeHint": "待后端补 git 端点",
  "workspace.changes": "变更",
  "workspace.commitAndPush": "提交或推送",
  "workspace.openTerminal": "打开终端",
  "activity.activeTool": "已使用 {{count}} 次工具｜{{tool}}",
  "activity.thoughtSteps": "思考 {{count}} 次",
  "activity.usedTools": "使用 {{count}} 个工具",
  "activity.viewedFiles": "查看 {{count}} 个文件",
  "activity.editedFiles": "已编辑{{count}}个文件",
  "activity.ranCommands": "执行 {{count}} 条命令",
  "activity.fetchedWebs": "抓取 {{count}} 个网页",
  "activity.readSkills": "读取 {{count}} 个技能",
  "activity.agentActions": "进行了 {{count}} 次会话操作",
  "activity.usedPlugins": "调用了 {{count}} 次插件工具",
  "activity.thoughtProcess": "思考过程",
  "activity.detail": "详情",
  "activity.thinkingLive": "推理中...",
  "activity.thinkingDone": "已完成推理",
  "activity.expand": "展开",
  "activity.collapse": "收起",
  /* 工具卡片状态文案（工单 46 D4）。五档状态取参照桌面的词表，中文与
     参照完全一致；已完成的调用在摘要行不显示状态。wire 只会写
     completed/failed/in_progress，补齐 pending 与 cancelled 是为了让
     归一化的完整五档都有用户可见文案。 */
  "tool.status.completed": "已完成",
  "tool.status.failed": "失败",
  "tool.status.in_progress": "运行中",
  "tool.status.pending": "等待中",
  "tool.status.cancelled": "已取消",
  /* 工具卡片展开体三段标题（工单 46 D4）：输入 / 结果 / 错误。 */
  "tool.section.input": "输入",
  "tool.section.result": "结果",
  "tool.section.error": "错误",
  /* 失败且无输出行的兜底错误文案，照参照。 */
  "tool.executionFailed": "执行失败",
  /* 运行中尚无任何产出的展开体文案。 */
  "tool.runningDetail": "运行中…",
  /* 轮次耗时条（工单 46 D6）：复合摘要「思考 N 次，用了 M 次工具，
     共执行 X 分 Y 秒」、运行中「已执行 N 秒」与两个时长格式器；
     输出速度单位 token/s 语言无关，在组件里拼接。 */
  "turn.usedTools": "用了 {{count}} 次工具",
  "turn.elapsedActive": "已执行 {{duration}}",
  "turn.elapsedTotal": "共执行 {{duration}}",
  "turn.duration.minutes": "{{minutes}} 分 {{seconds}} 秒",
  "turn.duration.seconds": "{{seconds}} 秒",
  "turn.outputRateSr": "输出速度：",
  "search.placeholder": "搜索标题或 ID…",
  "search.empty": "无匹配结果",
  "search.results": "%n 条结果",
  "slash.title": "命令",
  "slash.hint": "Enter 插入,Esc 关闭",
  "sidebar.export": "导出",
  "sidebar.plugins": "插件",
  "sidebar.scheduled": "定时",
  "sidebar.websites": "网站",
  "sidebar.mobile": "连接手机",
  "sidebar.remote": "远程",
  "sidebar.more": "更多",
  "sidebar.subagents": "子 Agent",
  "sidebar.projects": "项目",
  "action.failed": "失败",
  "sidebar.openSession": "打开会话",
  "sidebar.switchMismatch": "引擎仍停留在另一个会话",
  "sidebar.collapse": "收起导航栏",
  "sidebar.expand": "展开导航栏",
  "sidebar.loadError": "无法加载会话：",
  "sidebar.menu": "账户菜单",
  "settings.appearance": "外观",
  "settings.group.preferences": "偏好",
  "settings.group.management": "管理",
  "settings.group.coding": "编码",
  "settings.group.archived": "归档",
  "settings.tab.general": "通用",
  // 工单 37 — 桌面版参照图管理组的命名。该节自上而下是用量卡片与模型供应商面板。
  "settings.tab.usageModels": "用量与模型",
  "settings.tab.voice": "语音",
  "settings.tab.shortcuts": "快捷键",
  "settings.tab.personalization": "个性化",
  "settings.tab.browser": "浏览器",
  "settings.tab.connection": "连接",
  "settings.tab.account": "账户",
  "settings.tab.codeReview": "代码审查",
  "settings.tab.worktree": "工作树",
  "settings.tab.archived": "已归档任务",
  "settings.searchPlaceholder": "搜索设置...",
  "settings.searchNoResults": "没有匹配的设置",
  "settings.clearSearch": "清空设置搜索",
  // 工单 48 — 返回按钮带参照的「返回应用」文案，不再是纯图标。
  "settings.back": "返回应用",
  "settings.theme": "主题",
  "settings.themeLight": "浅色",
  "settings.themeDark": "深色",
  "settings.language": "语言",
  // 通用节「应用」卡片的行说明 — 桌面版参照图里每行标题下有一行灰色说明。
  "settings.appearanceHint": "选择应用的显示主题",
  "settings.languageHint": "设置应用语言",
  // 工单 48 — 通用页分区标题与本地存储-backed 的行（文件 / 会话管理 / 跟进消息行为）。
  // 文案跟随桌面版参照的通用页。
  "settings.section.application": "应用",
  "settings.section.file": "文件",
  "settings.section.sessionManagement": "会话管理",
  "settings.section.preference": "偏好设置",
  "settings.file.openInNewTab": "在新的标签页打开文件",
  "settings.file.openInNewTabHint":
    "关闭后，打开文件会替换当前预览标签页，而不是新增一个。",
  "settings.file.lineWrap": "文件预览自动换行",
  "settings.file.lineWrapHint":
    "开启后，超出预览区域宽度的文本和代码会自动折行；关闭后可横向滚动查看。不修改文件内容。",
  "settings.session.contextWindowUsage": "显示上下文窗口使用情况",
  "settings.followUp.title": "跟进消息行为",
  "settings.followUp.hint":
    "任务运行中按 Enter 发送跟进消息时：排队等待，或立即发送到当前任务。",
  "settings.followUp.queue": "排队",
  "settings.followUp.steer": "立即发送",
  "home.suggestions": "推荐",
  "home.chooseFolder": "选择文件夹",
  "home.local": "本地",
  "home.disclaimer": "内容由 AI 生成,重要信息请务必核查。",
  "composer.placeholderChat": "输入 @ 引用插件、子 Agent、文件和文件夹",
  "composer.placeholderHome": "输入 / 使用搜索模式或 Skill",
  "composer.mic": "语音输入",
  "chat.copy": "复制",
  "chat.copied": "已复制",
  "chat.like": "点赞",
  "chat.dislike": "点踩",
  "chat.fork": "复制为新会话",
  "chat.scrollBottom": "滚动到最新",
  "panel.progress": "进度",
  "panel.progress.subtitle": "跟踪较长任务的进度",
  "panel.progress.empty": "暂无活动",
  // 插件面板 —— 阶段①实装（components/plugins-surface.tsx），键保留、值改写。
  "panel.plugins.title": "插件",
  "panel.plugins.placeholder":
    "五个能力域在同一表面内。插件域已实装：浏览本地市场、管理已安装插件、从 GitHub 链接导入。技能、应用、MCP、Agent 四个域在后续阶段开放。",
  /* Git 面板（slice 03）— 右栏对应桌面端右栏 Git 视图：分支 + 变更文件 + 点击查看 diff + 切换分支。空态和破坏性操作文案集中在这里。 */
  "git.title": "Git",
  "git.empty.notRepo": "当前目录不是 git 仓库",
  "git.empty.clean": "工作区干净 — 无 staged / unstaged / untracked 变更",
  "git.empty.noWorkspace": "未选择工作区",
  "git.branch.label": "分支",
  "git.branch.tracking":
    "{{branch}} 跟踪 {{upstream}} (ahead {{ahead}}, behind {{behind}})",
  "git.branch.tracking.noUpstream": "{{branch}}（无 upstream）",
  "git.files.title": "变更文件",
  "git.files.empty": "无变更文件",
  "git.files.staged": "已暂存",
  "git.files.unstaged": "未暂存",
  "git.files.untracked": "未跟踪",
  "git.file.openDiff": "查看 diff",
  "git.file.diff.empty": "该文件无 diff",
  "git.file.diff.truncated": "diff 已截断 — 完整内容请在引擎中查看",
  "git.file.diff.loading": "加载 diff 中…",
  "git.file.diff.failed": "diff 加载失败",
  "git.refresh": "刷新",
  "git.refreshAria": "刷新 git 状态",
  "git.switch.confirm.title": "确认切换分支？",
  "git.switch.confirm.body":
    '切换到 "{{branch}}" 会丢弃工作区中未提交的变更，是否继续？',
  "git.switch.confirm.ok": "切换",
  "git.switch.confirm.cancel": "取消",
  "git.switch.success": "已切换到 {{branch}}",
  "git.switch.failed": "切换分支失败：{{error}}",
  "git.switcher.title": "切换分支",
  "git.switcher.empty": "无本地分支",
  /* 07 — 重开页面状态一致：URL 深链跳到的会话 ID 已不存在时的提示；
     短暂展示让用户知道是有意回到首页，不是静默丢失上下文。 */
  "session.hint.notFound": "该会话已不可用，已返回首页。",
  "session.hint.notFound.dismiss": "知道了",
  "session.hint.notFound.reset": "回到首页",
  "webui.errorBoundary.title": "页面出错",
  "webui.errorBoundary.subtitle": "刷新或回首页试试。侧栏状态已保存在本机。",
  "webui.errorBoundary.reload": "重新加载",
  "webui.errorBoundary.home": "回到首页",
  "webui.errorBoundary.copy": "复制诊断信息",
  "webui.errorBoundary.copied": "已复制",
  "webui.errorBoundary.details": "诊断信息",
  "webui.errorBoundary.messageFallback": "页面未能完成渲染。",
  /* 供应商管理（ticket 03）—— 设置里的供应商列表 / 编辑 / 连测 / 持久化面板。
     双语齐全；新增键请同步补全英文与中文。 */
  "providers.title": "模型供应商",
  "providers.subtitle": "配置 API Key、协议和模型清单",
  "providers.empty": "暂未添加自定义模型",
  "providers.add": "添加模型",
  "providers.test": "测试连接",
  "providers.testing": "正在测试…",
  "providers.testOk": "{{ms}}ms 连通",
  "providers.testInvalidKey": "API Key 无效或缺失",
  "providers.testBadProtocol": "不支持的协议",
  "providers.testProbeFailed": "无法连接到该端点",
  "providers.testTimeout": "连接超时",
  "providers.testHttp": "端点返回 {{status}}",
  "providers.delete": "删除",
  "providers.deleteConfirm": "删除供应商 {{id}}？",
  "providers.deleteHint": "将同时删除该供应商下的所有模型，操作不可撤销。",
  "providers.enabled": "已启用",
  "providers.disabled": "已停用",
  "providers.presetBadge": "预置",
  "providers.customBadge": "自定义",
  "providers.field.id": "供应商 ID",
  "providers.field.label": "显示名",
  "providers.field.protocol": "协议",
  "providers.field.authType": "认证类型",
  "providers.field.apiKey": "API Key",
  "providers.field.apiKeyPlaceholder":
    "明文保存；留空或省略该字段即保持现有 Key，不支持主动清空",
  "providers.field.baseURL": "端点（baseURL）",
  "providers.field.baseURLHint": "留空则使用该协议默认值",
  "providers.field.models": "模型清单",
  "providers.field.modelId": "模型 ID",
  "providers.field.modelLabel": "显示名",
  "providers.field.contextLimit": "上下文窗口（tokens）",
  "providers.field.thinkingLevels": "思考等级",
  "providers.field.modalities": "模态",
  "providers.models.add": "新增模型",
  "providers.models.remove": "移除",
  "providers.save": "保存",
  "providers.saving": "正在保存…",
  "providers.saved": "已保存",
  "providers.saveError": "保存失败：{{error}}",
  "providers.loadError": "加载失败：{{error}}",
  "providers.models.thinkingLevels.low": "低",
  "providers.models.thinkingLevels.medium": "中",
  "providers.models.thinkingLevels.high": "高",
  "providers.models.modalities.text": "文本",
  "providers.models.modalities.image": "图像",
  "providers.models.modalities.audio": "音频",
  "providers.models.modalities.video": "视频",
  "providers.models.modalities.file": "文件",
  "providers.idInvalid": "小写字母、数字、'.', '-', '_'；必须以其中之一开头",
  "providers.section.connection": "连接",
  "providers.section.models": "模型",
  "providers.presets.title": "一键启用",
  "providers.presets.unavailable": "当前版本未提供预置目录",
  "providers.presets.enable": "启用",
  "providers.presets.enabling": "正在启用…",
  // 工单 54 —— 桌面对齐的「添加模型」弹窗与「已获取模型」勾选弹窗。
  // 空态（providers.empty / providers.add）原 key 改文案，对齐桌面
  // 的「暂未添加自定义模型」与「+ 添加模型」。
  "providers.dialog.title": "添加模型",
  "providers.dialog.provider": "提供商",
  "providers.dialog.providerPlaceholder": "请选择提供商",
  "providers.dialog.other": "+ 其他（自定义）",
  "providers.dialog.apiKeyPlaceholder": "请输入API Key",
  "providers.dialog.models": "模型",
  "providers.dialog.addEntry": "＋ 添加",
  "providers.dialog.autoFetch": "自动获取",
  "providers.dialog.entryTitle": "模型 {{n}}",
  "providers.dialog.entryReset": "重置本条目",
  "providers.dialog.entryRemove": "删除本条目",
  "providers.dialog.field.name": "模型名称",
  "providers.dialog.field.context": "上下文窗口",
  "providers.dialog.field.maxOutput": "最大输出 Token",
  "providers.dialog.field.maxOutputNa": "本地版不适用：该字段暂不保存",
  "providers.dialog.field.thinking": "推理等级",
  "providers.dialog.field.thinkingPlaceholder":
    "输入档位后按 Enter，如 low、medium、high",
  "providers.dialog.field.attachments": "支持的附件",
  "providers.dialog.attachments.image": "图片",
  "providers.dialog.attachments.pdf": "PDF",
  "providers.dialog.attachments.video": "视频",
  "providers.dialog.attachments.audio": "音频",
  "providers.dialog.cancel": "取消",
  // API 格式 —— 桌面版的协议下拉。三个取值即本版本已支持的协议，
  // 文案照桌面版写法，不新造格式。
  "providers.dialog.apiFormat": "API 格式",
  "providers.dialog.apiFormat.openai": "OpenAI Completions",
  "providers.dialog.apiFormat.anthropic": "Anthropic Messages",
  "providers.dialog.apiFormat.gemini": "Gemini",
  // 自定义 Headers —— 随每次请求发往该供应商的附加头。
  "providers.dialog.headers": "自定义 Headers",
  "providers.dialog.headersAdd": "＋ 添加 Header",
  "providers.dialog.headerName": "Header 名称",
  "providers.dialog.headerValue": "Header 值",
  "providers.dialog.headerRemove": "移除 Header {{name}}",
  // 底部表单级连通检测（未通过则「保存」不可用）。
  "providers.dialog.formTest": "连通检测",
  "providers.dialog.formTestSkip": "跳过连通检测",
  "providers.dialog.formTestHint": "该供应商连通检测通过前不可保存，可勾选跳过检测",
  "providers.dialog.formTestNeedProvider": "请先选择提供商并填写 API Key",
  "providers.dialog.save": "保存",
  "providers.dialog.errorProvider": "请先选择提供商",
  "providers.dialog.errorDuplicate": "供应商 ID 已存在：{{id}}",
  "providers.dialog.modelsEmpty":
    "暂无模型：点击「＋ 添加」手动填写，或「自动获取」从所选预设目录中选择",
  "providers.dialog.addEntryHint": "手动添加一条空白模型条目，逐项填写",
  "providers.dialog.autoFetchHint":
    "从所选预设的内置目录中选择模型；仅读取列表，点击「保存」前不会保存任何配置",
  "providers.dialog.entryTest": "检测",
  "providers.dialog.entryTestHint":
    "用当前填写的 API Key 与接口地址探测供应商接口连通性（接口级检测，不针对本条目的模型 ID）",
  "providers.dialog.testTesting": "检测中…",
  "providers.dialog.testOk": "可达 · {{ms}}ms",
  "providers.dialog.testFail": "不可达：{{error}}",
  "providers.dialog.testNeedProvider":
    "请先选择提供商并填写 API Key，再进行连通检测",
  "providers.fetched.title": "已获取模型",
  "providers.fetched.presetNote":
    "列表来自预置模型目录；本地版暂不支持按该 API Key 拉取实时列表。",
  "providers.fetched.customEmpty":
    "本地版暂不支持按 API Key 自动获取自定义供应商的模型列表，请手动添加。",
  "providers.fetched.selectAll": "全选",
  "providers.fetched.add": "添加",

  // Slice 15 — Sidebar workspace tabs (zh mirror of the en block
  // above). Every key MUST exist in both locales — the runtime
  // fallback in `translate` ships en copy on a missing zh entry,
  // which is the regression slice 06 caught.
  "workspaceTabs.tab.files": "文件",
  "workspaceTabs.tab.files.aria": "关闭文件标签",
  "workspaceTabs.tab.git": "文件变动",
  "workspaceTabs.tab.git.aria": "关闭文件变动标签",
  "workspaceTabs.tab.browser": "浏览器",
  "workspaceTabs.tab.browser.aria": "关闭浏览器标签",
  "workspaceTabs.tab.tasks": "任务管理",
  "workspaceTabs.tab.tasks.aria": "关闭任务管理标签",
  /* Slice 17 — search / plugins surfaces (column 4). */
  "workspaceTabs.tab.search": "搜索",
  "workspaceTabs.tab.search.aria": "关闭搜索标签",
  "workspaceTabs.tab.plugins": "插件",
  "workspaceTabs.tab.plugins.aria": "关闭插件标签",
  "workspaceTabs.tab.filePrefix": "文件",
  "workspaceTabs.launcher.files": "文件",
  "workspaceTabs.launcher.git": "文件变动",
  "workspaceTabs.launcher.tasks": "任务管理",
  "workspaceTabs.launcher.btw": "侧边对话(beta)",
  "workspaceTabs.launcher.btw.disabledHint":
    "侧边对话尚未实装。标签位为后续片预留，落地后会接 TUI /btw 风格的旁路提问。",
  "workspaceTabs.launcher.terminal": "终端",
  "workspaceTabs.launcher.terminal.disabledHint":
    "终端尚未实装。标签位为后续片预留，落地后会接引擎的终端沙箱。",
  "workspaceTabs.launcher.browser": "浏览器",
  "workspaceTabs.addTab.aria": "新增标签",
  "workspaceTabs.tab.file.aria": "关闭文件 {name}",
  "workspaceTabs.tabs.aria": "工作区标签",
  "workspaceTabs.tabs.empty": "暂无打开的标签",
  "workspaceTabs.empty.heading": "打开一个表面",
  "workspaceTabs.empty.subtitle":
    "从下方启动器中选择一个标签。文件 / 文件变动 / 任务管理 / 浏览器已就绪；侧边对话与终端为后续片预留。",
  "workspaceTabs.fileTab.pathAria": "打开文件 {path}",
  "workspaceTabs.fileTab.revealInTree": "在文件树中定位",
  "workspaceTabs.fileTab.copyPath": "复制路径",
  "workspaceTabs.tasks.title": "任务管理",
  "workspaceTabs.tasks.subtitle": "当前会话已派发的子 Agent。",
  "workspaceTabs.tasks.empty": "暂无子 Agent，会话派发后会在此处显示。",
  "workspaceTabs.tasks.jump": "打开会话",
  "workspaceTabs.tasks.toolCall": "工具调用",
  "workspaceTabs.tasks.sinceAgo": "{n} 秒前",
  "workspaceTabs.tasks.minutesAgo": "{n} 分钟前",
  "workspaceTabs.tasks.hoursAgo": "{n} 小时前",
  "workspaceTabs.tasks.jumpError": "跳转到子 Agent 会话失败。",
  "workspaceTabs.column.resizeAria": "调整列宽",
  "workspaceTabs.column.resetAria": "恢复列默认宽度",
  "workspaceTabs.column.conversationAria": "调整对话区宽度",
  "workspaceTabs.column.previewAria": "调整预览栏宽度",
  "workspaceTabs.column.treeAria": "调整文件树栏宽度",
  "workspaceTabs.column.sidebarAria": "调整会话侧栏宽度",
  "workspaceTabs.column.closedAllTabs": "已关闭全部标签，面板栏已收起。",
  /* Slice 17 — preview column empty hint (no file tabs and no
     browser tab). The hint mirrors the desktop reference's
     empty state ("click a file to preview it"). */
  "workspaceTabs.preview.empty": "点文件或在文件树里点一个文件来预览。",
  /* Slice 17 — tree column empty hint (no surfaces open yet).
     The hint lists the five options the column can host and
     lets the user open one directly. */
  "workspaceTabs.tree.empty": "选一个表面来浏览工作区。",
  /* Slice 17 — tree column surface selector (segmented control). */
  "workspaceTabs.tree.selector.aria": "工作区导航",
  "workspaceTabs.tree.selector.files.aria": "切换到文件",
  "workspaceTabs.tree.selector.git.aria": "切换到文件变动",
  "workspaceTabs.tree.selector.tasks.aria": "切换到任务管理",
  "workspaceTabs.tree.selector.search.aria": "切换到搜索",
  "workspaceTabs.tree.selector.plugins.aria": "切换到插件",
  /* Slice 21 — close button on the active tree surface. The
     aria label announces the consequence so screen readers
     know what discarding a live query does. */
  "workspaceTabs.tree.close.aria": "关闭当前表面并收起导航栏",
  "workspaceTabs.tree.close.search.aria": "关闭搜索表面并丢弃当前查询",
  /* Slice 19b supersedes the slice-17 placeholder copy — see the
     English block for the real exhaustive search above. */
  /* Slice 17 — plugins surface copy. Ticket 60 阶段①把占位值改成实装描述，
     键名保留。 */
  "workspaceTabs.plugins.title": "插件",
  "workspaceTabs.plugins.placeholder":
    "五个能力域在同一表面内。插件域已实装：浏览本地市场、管理已安装插件、从 GitHub 链接导入。技能、应用、MCP、Agent 四个域在后续阶段开放。",

  /* 工单 60 阶段①子片 B —— 插件表面（五个能力域）。整块放在一个命名空间下，
     缺键一眼可见。三族含义互不混用：
       plugins.area.<domain>.pending.*  尚未开发的阶段
       plugins.market.official.notLocal  本地版没有的云端账号
       plugins.state.*                   四个请求状态
     `translate()` 不接受插值参数，所以计数与标签分开渲染，不拼进同一个串。 */
  "plugins.area.aria": "插件能力域",
  "plugins.area.plugins": "插件",
  "plugins.area.skills": "技能",
  "plugins.area.apps": "应用",
  "plugins.area.mcp": "MCP",
  "plugins.area.agents": "Agents",
  "plugins.area.skills.pending.title": "技能管理",
  "plugins.area.skills.pending.body":
    "技能管理界面在后续阶段开放。本服务端目前没有技能端点，所以列表刻意留空 —— 这里没有任何示例数据。",
  "plugins.area.apps.pending.title": "应用管理",
  "plugins.area.apps.pending.body":
    "应用管理界面在后续阶段开放。运行时已声明应用契约，但本服务端未暴露对应端点，列表刻意留空。",
  "plugins.area.mcp.pending.title": "MCP 服务器管理",
  "plugins.area.mcp.pending.body":
    "MCP 管理界面在后续阶段开放。登记、编辑与测试本地 stdio / HTTP 服务器所需的端点本服务端尚不具备。",
  "plugins.area.agents.pending.title": "Agent 管理",
  "plugins.area.agents.pending.body":
    "Agent 管理界面在后续阶段开放。目前完全没有 agent 端点，因此该域不展示列表，也不展示示例 agent。",
  "plugins.view.aria": "插件视图",
  "plugins.view.market": "市场",
  "plugins.view.personal": "已安装",
  "plugins.source.aria": "市场来源",
  "plugins.source.local": "本地",
  "plugins.source.official": "官方",
  "plugins.source.unknown": "来源未知",
  "plugins.search.aria": "搜索插件",
  "plugins.search.placeholder": "搜索插件",
  "plugins.category.aria": "插件分类",
  "plugins.category.all": "全部",
  "plugins.category.other": "其他",
  "plugins.category.office": "办公",
  "plugins.category.studio": "创作",
  "plugins.category.design": "设计与网站",
  "plugins.category.code": "代码",
  "plugins.category.business": "商业",
  "plugins.category.sales": "销售",
  "plugins.category.productivity": "效率",
  "plugins.category.tools": "工具",
  "plugins.category.science": "科学与医疗",
  "plugins.category.education": "教育",
  "plugins.action.install": "安装",
  "plugins.action.uninstall": "卸载",
  "plugins.action.enable": "启用",
  "plugins.action.disable": "停用",
  "plugins.action.refresh": "刷新插件列表",
  "plugins.action.retry": "重试",
  "plugins.action.import": "从 GitHub 导入",
  "plugins.action.notLocal.notice":
    "该操作需要官方云端账号，本地版没有，因此未做任何改动。",
  "plugins.card.installed": "已安装",
  "plugins.card.capability.skill": "技能",
  "plugins.card.capability.mcp": "MCP",
  "plugins.card.capability.app": "应用",
  "plugins.card.capability.hook": "钩子",
  "plugins.state.loading": "正在加载插件",
  "plugins.state.empty.market": "该市场暂无插件。",
  "plugins.state.empty.installed": "尚未安装任何插件。",
  "plugins.state.error.title": "插件加载失败",
  "plugins.state.error.body": "服务端拒绝了本次请求。",
  "plugins.market.official.notLocal.title": "官方市场",
  "plugins.market.official.notLocal.body":
    "官方市场需登录云端账号，本地版不可达。可浏览本地插件或从 GitHub 链接导入。",
  "plugins.market.localSkills.title": "本地技能",
  "plugins.confirm.uninstall.title": "卸载该插件？",
  "plugins.confirm.uninstall.body":
    "它的技能、MCP 服务器与钩子会立即失效。稍后可从本地市场重新安装。",
  "plugins.import.title": "从 GitHub 导入插件",
  "plugins.import.url.aria": "GitHub 仓库地址",
  "plugins.import.url.placeholder": "https://github.com/<owner>/<repo>",
  "plugins.import.preview": "预览",
  "plugins.import.submit": "导入",
  "plugins.import.empty": "填入 GitHub 地址后先预览。",
  "plugins.import.canImport": "该插件包可以导入。",
  "plugins.import.cannotImport": "该插件包没有本运行时可用的能力，无可导入内容。",
  "plugins.import.size": "包体积",
  "plugins.import.failed": "导入失败：",
  /* Slice 18 — 三态外观设置。完整中英文一一对应,见
     webapp/test/i18n-appearance.test.ts。文案集中放在
     lib/i18n-appearance.ts,这里只是注册键。 */
  "appearance.choice.light": "浅色",
  "appearance.choice.dark": "深色",
  "appearance.choice.system": "跟随系统",
  "appearance.choice.light.aria": "浅色模式 — 固定为浅色，不跟随系统",
  "appearance.choice.dark.aria": "深色模式 — 固定为深色，不跟随系统",
  "appearance.choice.system.aria":
    "跟随系统 — 操作系统切换明暗时，页面同步切换",
  "appearance.hint.fixed": "页面始终保持该主题，不随操作系统的明暗切换而改变。",
  "appearance.hint.system":
    "页面跟随操作系统的明暗设置。系统切换时，页面会实时跟随，无需刷新。",
  "common.save": "保存",
  "common.cancel": "取消",
  "common.close": "关闭",
  "settings.shortcuts.notice":
    "浏览器环境不适用：WebUI 无法注册全局快捷键。以下键位为桌面版默认值，仅供参考。",
  "settings.shortcuts.group.miniChat": "Mini Chat",
  "settings.shortcuts.group.common": "常用",
  "settings.shortcuts.item.miniChat": "显示或隐藏 Mini Chat",
  "settings.shortcuts.item.miniChatHint": "在任意应用中唤起或收起快捷输入小窗",
  "settings.shortcuts.item.globalSearch": "全局搜索",
  "settings.shortcuts.item.globalSearchHint": "搜索功能、设置和任务会话",
  "settings.shortcuts.item.searchTasks": "搜索任务和会话",
  "settings.shortcuts.item.searchTasksHint": "打开只包含任务和会话的搜索结果",
  "settings.shortcuts.item.newTask": "新建任务",
  "settings.shortcuts.item.newTaskHint": "打开一个新的任务输入页",
  "settings.shortcuts.item.newTaskNoProject": "新建无项目任务",
  "settings.shortcuts.item.newTaskNoProjectHint":
    "不关联项目文件夹，直接新建任务",
  "settings.shortcuts.item.openFolder": "打开项目文件夹",
  "settings.shortcuts.item.openFolderHint": "选择一个本地文件夹作为工作区",
  "settings.shortcuts.item.openSettings": "打开设置",
  "settings.shortcuts.item.openSettingsHint": "打开客户端设置页面",
  "settings.shortcuts.item.holdDictation": "按住听写",
  "settings.shortcuts.item.holdDictationHint":
    "按住快捷键开始语音输入，松开后停止",
  "settings.shortcuts.item.toggleDictation": "切换听写",
  "settings.shortcuts.item.toggleDictationHint":
    "按一次开始语音输入，再按一次停止",
  "settings.shortcuts.item.invertFollowUp": "反转跟进行为",
  "settings.shortcuts.item.invertFollowUpHint":
    "以与「跟进消息行为」相反的方式发送当前输入的消息（排队或立即发送），仅本次生效",
  "settings.shortcuts.unset": "未设置",
  "settings.shortcuts.clear": "清除快捷键",
  "settings.shortcuts.reset": "重置快捷键",
  "settings.voice.group.regular": "常规",
  "settings.voice.group.dictation": "听写",
  "settings.voice.microphone": "麦克风",
  "settings.voice.microphoneHint": "用于听写语音输入",
  "settings.voice.holdKey": "按住听写快捷键",
  "settings.voice.holdKeyHint": "在应用内按住，即可在输入框中听写",
  "settings.voice.toggleKey": "切换听写快捷键",
  "settings.voice.toggleKeyHint": "在应用内按一次开始听写，再按一次停止",
  "settings.voice.unset": "未设置",
  "settings.personal.instructions": "自定义指令",
  "settings.personal.instructionsPlaceholder":
    "定义 Agent 应该如何工作、回答和执行任务，为此设备上的所有 Agent 提供额外指令和上下文...",
  "settings.personal.aboutYou": "关于你",
  "settings.personal.aboutYouPlaceholder": "告诉 Agent 你的背景和长期偏好……",
  "settings.personal.memory": "记忆",
  "settings.personal.memoryHint": "在提示词、提醒和后续维护中使用已保存的记忆",
  "settings.personal.proactiveMemory": "主动记忆",
  "settings.personal.proactiveMemoryHint":
    "主动识别并通过 Memory 保存值得长期保留的偏好和可复用经验",
  "settings.personal.memorySummary": "记忆摘要",
  "settings.personal.memorySummaryHint":
    "查看、编辑或删除 MiniMax 已整理的长期记忆。",
  "settings.personal.manage": "管理",
  "settings.memory.title": "记忆摘要",
  "settings.memory.placeholder": "MiniMax 整理的长期记忆会显示在这里。",
  "settings.memory.empty": "尚未生成记忆摘要",
  "settings.memory.more": "更多",
  "settings.memory.close": "关闭",
  "settings.codeReview.hint": "自定义内置代码审查指令的执行方式与审查准则",
  "settings.codeReview.method": "审查方式",
  "settings.codeReview.methodSubsession": "子会话",
  "settings.codeReview.guidelines": "自定义审查准则",
  "settings.codeReview.guidelinesPlaceholder": "输入需要长期应用的代码审查规则",
  /* 工单 59 D3-4：设置壳的硬编码中文收进字典（zh 侧原文照搬）。 */
  "settings.nav.aria": "设置分类",
  "settings.account.info": "账户信息",
  "settings.account.localLoggedOut": "本地模式，未登录",
  "settings.account.signOutUnavailable": "本地版未接入账户服务",
  "settings.account.signOut": "退出登录",
  "settings.archived.empty": "暂无已归档任务",
  "settings.worktree.empty": "本地版暂不支持工作树管理",
  "settings.mode.section": "模式",
  "settings.mode.coding": "适用于编程开发",
  "settings.mode.codingHint": "保留技术细节与开发工具",
  "settings.mode.work": "适用于日常工作",
  "settings.mode.workHint": "同样强大，减少技术细节干扰",
  "settings.app.menuBar": "显示在菜单栏",
  "settings.app.menuBarHint": "在菜单栏/系统托盘显示应用图标",
  "settings.app.autoStart": "开机自启动",
  "settings.app.autoStartHint": "登录时自动启动应用",
  "settings.app.notifications": "桌面通知",
  "settings.app.notificationsHint": "任务完成、出错、需要权限审批等阻塞状态时，发送系统通知提醒",
  "settings.app.earlyAccess": "加入提前灰度",
  "settings.app.earlyAccessHint": "优先体验最新版本功能",
  "settings.app.indexing": "加速索引",
  "settings.app.indexingHint": "开启后，MiniMax Code 会基于工作区生成语义索引，加快代码搜索的速度",
  "settings.links.section": "链接",
  "settings.links.web": "网页链接打开位置",
  "settings.links.webHint": "公开网页链接默认打开位置",
  "settings.links.builtinBrowser": "内置浏览器",
  "settings.links.local": "本地链接打开位置",
  "settings.links.localHint": "本地开发页面默认打开位置",
  "settings.agentControl.section": "Agent 控制权限",
  "settings.agentControl.browserPanel": "自动打开浏览器面板",
  "settings.agentControl.browserPanelHint": "Agent 操作网页时，自动打开右侧浏览器面板",
  "settings.preference.watermark": "去除 AI 生成水印",
  "settings.preference.watermarkHint": "关闭时，下载内容将包含显式 AI 生成水印；开启去除水印即代表你已阅读并同意《去水印规则》",
  "settings.preference.dataOptIn": "数据用于优化体验",
  "settings.preference.dataOptInHint": "允许我们将你的对话内容用于优化 MiniMax Code 的使用体验。我们保障你的数据隐私安全。",
  "settings.about.section": "关于",
  "settings.about.uploadLogs": "上传日志",
  "settings.about.uploadLogsHint": "上传应用日志以协助排查问题",
  "settings.about.uploadUnavailable": "本地版未接入日志上传",
  "settings.about.uploadAction": "上传",
  "settings.about.version": "应用版本",
  "settings.about.updateUnavailable": "本地版未接入更新检查",
  "settings.about.checkUpdate": "检查更新",
  "settings.about.localUrl": "本地服务地址",
  "settings.about.lanUrl": "局域网服务地址",
  "usageModels.source.aria": "选择模型来源",
  "usageModels.minimax.notEnabled": "未启用",
  "usageModels.minimax.apiKeyPlaceholder": "请输入API Key",
  "usageModels.minimax.testAria": "测试连通性",
  "usageModels.minimax.unavailable": "本地版未接入 MiniMax API Key 服务",
  "usageModels.minimax.saveAndUse": "保存并使用",
  "usage.banner.fiveHourLow": "5 小时限额即将用尽",
  "usage.banner.weeklyLow": "周限额即将用尽",
};

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { zh, en };

const STORAGE_KEY = "webui-locale";

/** Resolve the active locale: stored choice, else the browser, else Chinese. */
export function resolveLocale(): Locale {
  if (typeof window === "undefined") return "zh";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    /* storage unavailable — fall through to the browser preference */
  }
  return window.navigator.language.toLowerCase().startsWith("en") ? "en" : "zh";
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* not fatal: the choice just will not survive a reload */
  }
}

/** Look up a message. Unknown locales fall back to English. */
export function translate(locale: Locale, key: MessageKey): string {
  return DICTIONARIES[locale][key] ?? en[key];
}
