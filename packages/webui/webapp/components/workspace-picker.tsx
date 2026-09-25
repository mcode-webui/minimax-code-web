"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dropdown } from "antd";

import * as api from "@/lib/api";
import { useSessionContext } from "@/lib/store";
import { runAction } from "@/lib/action-errors";
import { Icon, type IconName } from "./icons";
import { WorkspacePickerModal } from "./panels";
import type { MessageKey } from "@/lib/i18n";

/**
 * Workspace chip + Level-1 dropdown (the conversation-view entry point
 * is a button in WorkspacePanel; this is the home-screen counterpart).
 *
 * The chip displays the active workspace (last path segment, matching
 * the conversation-viewer's display). Clicking it opens a dropdown
 * anchored to the chip with three affordances, ordered exactly as the
 * pr-22 reference suggests:
 *
 *   1. 最近       — recent workspaces from /api/workspace/recent; the
 *                   active one carries a ✓ check, others click-to-switch.
 *   2. 选择新项目 — opens the full WorkspacePickerModal (Level 2).
 *   3. 不需要项目 — switches to the no-workspace state (uses tmpdir,
 *                   same as the existing Recents tab's no-workspace
 *                   button).
 *
 * The dropdown closes on selection and the SSE state update carries the
 * new directory through to every subscriber (the chip re-reads
 * `state?.workspace.dir` on the next render). Single-click selection
 * matches the reference; there is no Level-1 confirm.
 *
 * Visual chrome matches the composer dropdowns (`mavis-dropdown` /
 * `mavis-dropdown-compact` classes): same surface, hairline, radius
 * and shadow as `composer.tsx#SelectPanel` so a designer walking through
 * the home screen does not see two picker skins.
 */
export function WorkspaceChipDropdown({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Last-write-wins for the recents list — the chip's open state is
  // synchronous, but if the user re-opens the dropdown mid-fetch the
  // older response must not replace the newer one.
  const loadGen = useRef(0);

  const [items, setItems] = useState<api.RecentWorkspace[]>([]);
  const [tmpDir, setTmpDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    try {
      const result = await api.recentWorkspaces("", 20);
      if (gen !== loadGen.current) return;
      setItems(result.items ?? []);
      if (result.tmpDir) setTmpDir(result.tmpDir);
    } catch {
      // Soft failure — keep whatever the previous load returned.
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  // Lazy load on first open; refetch after a switch closes the dropdown
  // so the next open reflects the new active row.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const closeAndRefresh = () => {
    setOpen(false);
    // Refresh on the next tick so a follow-up open shows the new active
    // row without an extra round-trip.
    setTimeout(refresh, 0);
  };

  const switchTo = async (dir: string | null) => {
    if (dir === null && !tmpDir) return;
    try {
      await runAction(t("workspace.switch"), api.setWorkspace(dir ?? tmpDir ?? ""));
    } catch {
      // runAction already surfaces the error.
    }
    closeAndRefresh();
  };

  const currentDir = state?.workspace.dir ?? null;
  const activeLabel = currentDir
    ? lastSegment(currentDir)
    : tmpDir
      ? t("workspace.picker.noWorkspace")
      : t("home.chooseFolder");

  const dropdownContent = (
    <div
      data-testid="workspace-chip-dropdown"
      className="flex w-[280px] flex-col gap-1 p-1"
    >
      <DropdownSection
        title={t("workspace.chipDropdown.recent")}
        testId="workspace-chip-dropdown-recent"
      >
        {loading && items.length === 0 ? (
          <span className="px-2 py-1 text-caption-small-strong text-text_default_tertiary">
            {t("workspace.picker.loading")}
          </span>
        ) : items.length === 0 ? (
          <span
            data-testid="workspace-chip-dropdown-empty"
            className="px-2 py-1 text-caption-small-strong text-text_default_tertiary"
          >
            {t("workspace.picker.recents.empty")}
          </span>
        ) : (
          items.map((item) => {
            const isCurrent = item.dir === currentDir;
            return (
              <DropdownRow
                key={item.dir}
                testId={`workspace-chip-dropdown-recent-${item.dir}`}
                icon="folder"
                label={item.name}
                sublabel={item.dir}
                trailing={isCurrent ? "check" : null}
                onClick={() => void switchTo(item.dir)}
              />
            );
          })
        )}
      </DropdownSection>

      <div className="my-1 border-t border-border_default" />

      <DropdownRow
        testId="workspace-chip-dropdown-choose-new"
        icon="folderEmpty"
        label={t("workspace.chipDropdown.chooseNew")}
        onClick={() => {
          setOpen(false);
          setPickerOpen(true);
        }}
      />
      <DropdownRow
        testId="workspace-chip-dropdown-no-project"
        icon="close"
        label={t("workspace.chipDropdown.noProject")}
        onClick={() => void switchTo(null)}
      />
    </div>
  );

  return (
    <>
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={["click"]}
        placement="bottomLeft"
        overlayClassName="mavis-dropdown mavis-dropdown-compact mavis-dropdown-custom-content"
        // antd's Dropdown needs an explicit overlay via `menu` or
        // `popupRender`; otherwise rc-dropdown throws on overlay mount
        // with "React.Children.only expected to receive a single React
        // element child" and unmounts the whole app. composer.tsx#PermissionSelect
        // uses exactly this `popupRender` pattern with a custom panel —
        // match it here so the chip dropdown renders the same chrome.
        popupRender={() => dropdownContent}
      >
        <button
          type="button"
          data-testid="workspace-chip"
          className="flex h-8 items-center gap-1 rounded-full border border-border_default bg-bg_default_primary px-3 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          <Icon name="folder" size={13} />
          <span className="truncate whitespace-nowrap">{activeLabel}</span>
        </button>
      </Dropdown>
      <WorkspacePickerModal
        t={t}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentDir={currentDir}
      />
    </>
  );
}

/**
 * Project-row switch action — used by the sidebar's `ProjectNode` row.
 *
 * Small icon button that hovers in next to the existing
 * "new task in this project" plus action. Click switches the active
 * workspace to the project's first repo path. Single-click expand/
 * collapse on the project row is unchanged — the button calls
 * `event.stopPropagation()` so its click does not bubble to the row.
 *
 * `repoPaths` is the project's list of repository roots; falling back
 * to the first is fine because every project with > 1 directory would
 * surface them through `DirectoryNode` rows below — the project-level
 * switch is the broad-stroke shortcut.
 */
export function ProjectRowSwitchAction({
  t,
  repoPath,
  onChanged,
}: {
  t: (key: MessageKey) => string;
  repoPath: string;
  onChanged?: () => void;
}) {
  const handle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    void runAction(t("workspace.projectRow.switch"), api.setWorkspace(repoPath)).then(() =>
      onChanged?.(),
    );
  };
  return (
    <button
      type="button"
      data-testid="sidebar-project-switch-workspace"
      aria-label={t("workspace.projectRow.switch")}
      title={t("workspace.projectRow.switch")}
      onClick={handle}
      onMouseDown={(event) => event.stopPropagation()}
      className="flex size-[22px] flex-none items-center justify-center rounded-md text-icon_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
    >
      <Icon name="folder" size={14} />
    </button>
  );
}

// --- Level-1 dropdown chrome ---------------------------------------------

function DropdownSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-col gap-0.5">
      <div className="px-2 pb-0.5 pt-1 text-caption-small-strong uppercase tracking-wide text-text_default_tertiary">
        {title}
      </div>
      {children}
    </div>
  );
}

function DropdownRow({
  testId,
  icon,
  label,
  sublabel,
  trailing,
  onClick,
}: {
  testId: string;
  icon: IconName;
  label: string;
  sublabel?: string;
  /** `check` renders a small ✓ glyph; `null` renders nothing. */
  trailing?: "check" | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
    >
      <span className="flex size-[18px] flex-none items-center justify-center text-icon_default_secondary">
        <Icon name={icon} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-5 text-text_default_primary">
          {label}
        </span>
        {sublabel ? (
          <span
            title={sublabel}
            className="block truncate font-family-code text-caption-small-strong text-text_default_tertiary"
          >
            {sublabel}
          </span>
        ) : null}
      </span>
      {trailing === "check" ? (
        <span className="flex-none text-text_default_primary" aria-hidden>
          <Icon name="checkSmall" size={14} />
        </span>
      ) : null}
    </button>
  );
}

/** Last path segment, mirroring `shell.tsx#workspaceLeaf`'s style. */
function lastSegment(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}