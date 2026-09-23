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
  /* Account-menu usage popover (hover Tooltip on the `用量` row). Quota data
     comes from `api.getQuota()` (5h-style snapshot: remaining %, resetAt,
     weeklyResetAt). The popover renders whatever is in the snapshot. */
  "usagePopover.title": "Usage",
  "usagePopover.fiveHour": "5-hour limit",
  "usagePopover.weekly": "Weekly limit",
  "usage.used": "Used",
  "usagePopover.unavailable": "Quota data not available",
  "usagePopover.refresh": "Refresh",
  "usagePopover.errorTitle": "Failed to load usage",
  "usagePopover.errorBody": "Try again in a moment.",
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
  "usage.reset": "Resets",
  "alerts.empty": "No messages",
  "workspace.sectionEnvironment": "Environment",
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
  "settings.back": "Back",
  "settings.theme": "Theme",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.language": "Language",
  "home.suggestions": "Suggested",
  "home.chooseFolder": "Pick a folder",
  "home.local": "Local",
  "home.disclaimer": "Content generated by AI — please verify important info.",
  "composer.placeholderChat": "Type @ to reference plugins, sub-agents, files and folders",
  "composer.placeholderHome": "Type / to open search mode or a Skill",
  "composer.mic": "Voice input",
  "chat.copy": "Copy",
  "chat.copied": "Copied",
  "chat.like": "Like",
  "chat.dislike": "Dislike",
  "chat.share": "Share",
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
  "panel.plugins.placeholder": "Plugin marketplace is in progress. The engine's install contract is not exposed by this server yet, so the desktop's category tabs + grid view will land once the contract is wired through.",
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
  /* 帐号菜单的「用量」hover Tooltip popover。配额数据来自 `api.getQuota()`
     （5h 风格快照：remaining %、resetAt、weeklyResetAt）。 */
  "usagePopover.title": "用量",
  "usagePopover.fiveHour": "5 小时限额",
  "usagePopover.weekly": "每周限额",
  "usage.used": "已用",
  "usagePopover.unavailable": "暂无用量数据",
  "usagePopover.refresh": "刷新",
  "usagePopover.errorTitle": "用量加载失败",
  "usagePopover.errorBody": "请稍后再试",
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
  "usage.reset": "重置时间",
  "alerts.empty": "暂无消息",
  /* Workspace panel section labels are aligned with the desktop's
     `workspace_panel.section_*` keys (反编译 36705 chunk). */
  "workspace.sectionEnvironment": "环境信息",
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
  "settings.back": "返回",
  "settings.theme": "主题",
  "settings.themeLight": "浅色",
  "settings.themeDark": "深色",
  "settings.language": "语言",
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
  "chat.share": "分享",
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
  "panel.plugins.placeholder": "插件市场正在做。后端尚未暴露 plugin install 合约，桌面端的类别 tabs + 卡片网格会在合约打通后实装。",
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
