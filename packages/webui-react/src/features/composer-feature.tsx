/** composer-feature —— 输入区容器：草稿/发送/附件/模型与工作区浮层/斜杠命令/权限弹窗的接线（接缝：AppSnapshot.draft+actions → Composer props）。 */
import { useEffect, useRef, useState } from 'react';

import type { WorkspaceEntry } from '../contracts/domain';
import { Composer, type PermissionMode } from '../ui/composer/Composer';
import { ModelPicker } from '../ui/composer/ModelPicker';
import { SlashOverlay, type SlashEntry } from '../ui/composer/SlashOverlay';
import { WorkspaceChip, type WorkspaceQuickItem } from '../ui/composer/WorkspaceChip';
import { WorkspacePicker } from '../ui/composer/WorkspacePicker';
import { PermissionModal } from '../ui/modals';
import type { AppController } from './app-controller';
import { useRegistry } from './registry-context';
import { useAppActions, useAppSnapshot } from './use-app';

export interface ComposerFeatureProps {
  controller: AppController;
}

/**
 * 斜杠命令表 —— 对齐 webui/server/lib/interaction/commands.js 的本地命令
 * （/new /clear /status /sessions /help /usage /stop /goal*）+ 常用 mcode 命令。
 */
const SLASH_ENTRIES: SlashEntry[] = [
  { id: 'clear', cmd: '/clear', desc: '清空当前对话', kind: 'cmd' },
  { id: 'compact', cmd: '/compact', desc: '压缩上下文以释放窗口', kind: 'cmd' },
  { id: 'new', cmd: '/new', desc: '新建会话', kind: 'cmd' },
  { id: 'plan', cmd: '/plan', desc: '进入 Plan 模式，先出方案', kind: 'cmd' },
  { id: 'status', cmd: '/status', desc: '查看当前状态', kind: 'cmd' },
  { id: 'sessions', cmd: '/sessions', desc: '查看最近会话', kind: 'cmd' },
  { id: 'usage', cmd: '/usage', desc: '查询用量', kind: 'cmd' },
  { id: 'goal', cmd: '/goal', desc: '设定目标（配 /goal-done、/goal-blocked 收尾）', kind: 'cmd' },
  { id: 'goal-done', cmd: '/goal-done', desc: '标记目标完成', kind: 'cmd' },
  { id: 'goal-blocked', cmd: '/goal-blocked', desc: '标记目标受阻', kind: 'cmd' },
  { id: 'stop', cmd: '/stop', desc: '停止当前任务', kind: 'cmd' },
  { id: 'help', cmd: '/help', desc: '可用命令', kind: 'cmd' },
];

/** 全限定模型 id → 短名（只留 '/' 后最后一段）。 */
function shortModelName(full: string | undefined): string {
  if (!full) return '—';
  return full.includes('/') ? (full.split('/').pop() ?? full) : full;
}

/** 目录路径 → 短名（最后一段；根/空路径回落整串）。 */
function dirShortName(path: string | null): string {
  if (!path) return '无工作区';
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function ComposerFeature({ controller }: ComposerFeatureProps) {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);
  const { notifier } = useRegistry();

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [wsChipOpen, setWsChipOpen] = useState(false);
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  // 权限模式：以服务端标签（state.permissions，如 "Full access"）回读为准；
  // 切换经 POST /api/permissions 同步（mcode 固定于启动时，服务端仅同步 UI 标签）。
  const [permMode, setPermMode] = useState<PermissionMode>('ask');
  const [permOpen, setPermOpen] = useState(false);
  // 「选择目录」的浏览模式：null = 显示 recents；否则显示服务端目录列表逐级浏览。
  const [browse, setBrowse] = useState<{ cwd: string; entries: WorkspaceEntry[] } | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  // 斜杠命令面板：输入以 '/' 开头且尚无空格时自动打开；Esc 关闭后再次输入重开。
  useEffect(() => {
    setSlashOpen(s.draft.startsWith('/') && !s.draft.includes(' '));
  }, [s.draft]);

  // 权限标签 → 模式值（服务端标签：Ask / Auto / Read / Full access）；
  // 未知标签保守回落 'ask'，避免把 UI 徽标显示成用户没选过的档位。
  useEffect(() => {
    const label = s.permissionLabel;
    if (label === 'Ask') setPermMode('ask');
    else if (label === 'Auto') setPermMode('auto');
    else if (label === 'Read') setPermMode('read');
    else if (label === 'Full access') setPermMode('full');
  }, [s.permissionLabel]);

  const selection = s.slice?.selection;
  const wsPath = s.slice?.workspace?.dir ?? s.workspace?.dir ?? null;

  const closeWs = (): void => {
    setWsChipOpen(false);
    setWsPickerOpen(false);
    setBrowse(null);
  };

  const pickWorkspace = (dir: string): void => {
    void a.useWorkspace(dir).then(closeWs);
  };

  /** 进入目录浏览模式（浏览器无原生目录框，经 browseWorkspace 逐级浏览服务端目录）。 */
  const enterBrowse = (path: string | undefined, cwd: string): void => {
    void a
      .browseWorkspace(path)
      .then((entries) => setBrowse({ cwd, entries }))
      .catch(() => notifier.toast('浏览目录失败', 'error'));
  };

  const handleSelectWsPath = (path: string): void => {
    if (browse) {
      const entry = browse.entries.find((e) => e.path === path);
      if (entry?.isDir) enterBrowse(path, path);
      return; // 浏览模式下点文件不动作；再点「选择目录」选用当前目录
    }
    pickWorkspace(path);
  };

  const handlePickDirectory = (): void => {
    if (browse) {
      if (browse.cwd) pickWorkspace(browse.cwd);
      return;
    }
    enterBrowse(wsPath ?? undefined, wsPath ?? '');
  };

  const handleNoWorkspace = (): void => {
    void a.resetWorkspace().then(closeWs);
  };

  const chipItems: WorkspaceQuickItem[] = s.recents.map((e) => ({ path: e.path, name: e.name }));
  // 命令面板条目：优先服务端真实目录（state.availableCommands 派生），为空用内置兜底。
  const slashEntries = s.slashEntries.length > 0 ? s.slashEntries : SLASH_ENTRIES;

  return (
    <>
      {/* 缺口 #1：附件按钮驱动隐藏的文件选择框；选完即上传并清空 value（可重复选同名文件）。 */}
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void a.uploadFiles(files);
          e.target.value = '';
        }}
      />

      <Composer
        value={s.draft}
        onChange={a.setDraft}
        // 无参 send() 发送当前会话草稿；'/' 开头由控制器自动改走 sendCommand（缺口 #6）。
        onSend={() => void a.send()}
        running={s.slice?.running ?? false}
        onStop={() => void a.stop()}
        disabled={s.settings?.readOnly === true}
        attachments={s.slice?.attachments ?? []}
        onRemoveAttachment={a.removeAttachment}
        onAttachClick={() => fileRef.current?.click()}
        mode={permMode}
        onModeClick={() => setPermOpen(true)}
        modelLabel={shortModelName(selection?.model)}
        modelTitle={selection ? `${selection.provider} / ${selection.model} · ${selection.thinking}` : undefined}
        onModelClick={() => {
          setWsPickerOpen(false);
          setModelPickerOpen(true);
        }}
        popoverSlot={
          <>
            <ModelPicker
              open={modelPickerOpen}
              providers={s.providers}
              models={s.models}
              selection={selection ?? { provider: '', model: '', thinking: 'medium' }}
              onSelectProvider={(p) => void a.setProvider(p)}
              onSelectModel={(m) => void a.setModel(m)}
              onSelectThinking={(e) => void a.setThinking(e)}
              onSubmitCustom={(v) => {
                void a.submitCustomModel(v);
                setModelPickerOpen(false);
              }}
              onClose={() => setModelPickerOpen(false)}
            />
            <WorkspacePicker
              open={wsPickerOpen}
              recents={browse ? browse.entries : s.recents}
              currentPath={wsPath}
              onSelect={handleSelectWsPath}
              onPickDirectory={handlePickDirectory}
              onNoWorkspace={handleNoWorkspace}
              onClose={closeWs}
              title={browse ? `选择目录 — ${browse.cwd || '/'}` : undefined}
            />
          </>
        }
        workspaceSlot={
          <WorkspaceChip
            name={dirShortName(wsPath)}
            title={wsPath ?? '点击切换工作区'}
            currentPath={wsPath}
            open={wsChipOpen}
            onToggle={() => {
              setWsChipOpen((v) => !v);
              setWsPickerOpen(false);
            }}
            items={chipItems}
            onSelect={pickWorkspace}
            onAddWorkspace={() => {
              setWsChipOpen(false);
              setWsPickerOpen(true);
            }}
          />
        }
      />

      <SlashOverlay
        open={slashOpen}
        entries={slashEntries}
        onSelect={(entry) => {
          a.setDraft('');
          setSlashOpen(false);
          void a.sendCommand(entry.cmd);
        }}
        onClose={() => setSlashOpen(false)}
      />

      <PermissionModal
        open={permOpen}
        current={permMode}
        onSelect={(mode) => {
          setPermMode(mode);
          setPermOpen(false);
          void a.setPermissionMode(mode).catch((e: unknown) => {
            notifier.toast(`权限模式同步失败：${e instanceof Error ? e.message : String(e)}`, 'error');
          });
        }}
        onClose={() => setPermOpen(false)}
      />
    </>
  );
}
