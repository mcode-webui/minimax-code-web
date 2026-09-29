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

  /* Account menu rows — 1:1 with the upstream account-menu entry set. */
  "userMenu.checkin": "Daily check-in",
  "userMenu.signOut": "Sign out",
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
  "plan.agree": "Agree",
  "plan.addContext": "Add context",
  "plan.skip": "Skip",
  "ask.other": "Other…",
  "ask.submit": "Submit",
  "ask.skip": "Skip",
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
  "files.tree.truncated": "还有 {n} 项未显示",
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
  "tool.status.completed": "completed",
  "tool.status.failed": "failed",
  "tool.status.in_progress": "running",
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
  "sidebar.collapse": "Collapse sidebar",
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
  "chat.turnProcess.took": "Took {{seconds}}s",
  "chat.turnProcess.expand": "Show turn details",
  "chat.turnProcess.collapse": "Hide turn details",
  "panel.progress": "Progress",
  "panel.progress.subtitle": "Track long-running tasks",
  "panel.progress.empty": "No activity yet",
  // Plugins panel — stub until the engine exposes its install contract.
  // The shell maps `sidebar.plugins` to this surface (a sibling of tasks /
  // scheduled / websites / remote on desktop, NOT a settings tab — the
  // earlier settings-tab route was a misread of the desktop layout).
  "panel.plugins.title": "Plugins",
  "panel.plugins.placeholder":
    "Plugin marketplace is in progress. The engine's install contract is not exposed by this server yet, so the desktop's category tabs + grid view will land once the contract is wired through.",
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
  "providers.empty": "No providers configured yet",
  "providers.add": "Add provider",
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
  "providers.idInvalid":
    "Lowercase letters, digits, '.', '-', '_'; must start with one",
  "providers.section.connection": "Connection",
  "providers.section.models": "Models",
  "providers.presets.title": "One-click enable",
  "providers.presets.unavailable":
    "Preset catalogue not available in this build",
  "providers.presets.enable": "Enable",
  "providers.presets.enabling": "Enabling…",

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
  "workspaceTabs.tree.close.aria": "Close the active surface and hide the navigation column",
  "workspaceTabs.tree.close.search.aria":
    "Close the search surface and discard the current query",
  /* Slice 19b supersedes the slice-17 placeholder copy with a real
     exhaustive search above. The slice-17 keys are gone — the
     search surface is no longer a no-op placeholder. */
  /* Slice 17 — plugins surface copy. The marketplace is a
     placeholder — the engine has not yet exposed the
     plugin-install contract. The card is mounted AND labelled
     so a click on the sidebar's 插件 entry visibly produces a
     surface rather than silently no-op'ing. */
  "workspaceTabs.plugins.title": "Plugins",
  "workspaceTabs.plugins.placeholder":
    "Plugin marketplace is in progress. The engine has not yet exposed the plugin-install contract; the desktop-side category tabs and card grid will land once it does.",
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

  /* 站内信 —— 侧栏底部的告警入口。上游用未读条数做 aria-label；这里拆成两个
     键，因为翻译函数不接受插值参数。 */
  "inbox.title": "站内信",
  "inbox.entryUnread": "站内信，有未读消息",
  "inbox.entryNoUnread": "站内信，无未读消息",
  "inbox.tabAll": "全部",
  "inbox.tabProduct": "产品更新",
  "inbox.tabMine": "我的消息",
  "inbox.markAllRead": "全部已读",

  /* 帐号菜单条目 — 与上游 account-menu 1:1 对齐。 */
  "userMenu.checkin": "每日签到",
  "userMenu.signOut": "退出登录",
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
  "plan.agree": "同意",
  "plan.addContext": "补充上下文",
  "plan.skip": "跳过",
  "ask.other": "其他…",
  "ask.submit": "提交",
  "ask.skip": "跳过",
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
  "tool.status.completed": "已完成",
  "tool.status.failed": "失败",
  "tool.status.in_progress": "进行中",
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
  "sidebar.collapse": "折叠侧栏",
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
  "settings.file.openInNewTabHint": "关闭后，打开文件会替换当前预览标签页，而不是新增一个。",
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
  "chat.turnProcess.took": "本轮耗时 {{seconds}} 秒",
  "chat.turnProcess.expand": "查看本轮详情",
  "chat.turnProcess.collapse": "收起本轮详情",
  "panel.progress": "进度",
  "panel.progress.subtitle": "跟踪较长任务的进度",
  "panel.progress.empty": "暂无活动",
  // 插件面板 stub —— 等后端装好 plugin install 合约再接上。
  "panel.plugins.title": "插件",
  "panel.plugins.placeholder":
    "插件市场正在做。后端尚未暴露 plugin install 合约，桌面端的类别 tabs + 卡片网格会在合约打通后实装。",
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
  "providers.empty": "暂无供应商",
  "providers.add": "新增供应商",
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
  "providers.idInvalid": "小写字母、数字、'.', '-', '_'；必须以其中之一开头",
  "providers.section.connection": "连接",
  "providers.section.models": "模型",
  "providers.presets.title": "一键启用",
  "providers.presets.unavailable": "当前版本未提供预置目录",
  "providers.presets.enable": "启用",
  "providers.presets.enabling": "正在启用…",

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
  "workspaceTabs.tree.close.search.aria":
    "关闭搜索表面并丢弃当前查询",
  /* Slice 19b supersedes the slice-17 placeholder copy — see the
     English block for the real exhaustive search above. */
  /* Slice 17 — plugins surface copy. */
  "workspaceTabs.plugins.title": "插件",
  "workspaceTabs.plugins.placeholder":
    "插件市场正在做。后端尚未暴露 plugin install 合约，桌面端的类别 tabs + 卡片网格会在合约打通后实装。",
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
