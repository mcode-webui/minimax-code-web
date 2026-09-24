import type { WorkspaceInfo } from '../../contracts/domain';
import { KeyValueRow } from '../primitives/KeyValueRow';
import './WorkspacePanel.css';

export interface WorkspacePanelLabels {
  dir: string;
  branch: string;
  tree: string;
}

export interface WorkspacePanelProps {
  /** 当前工作区。 */
  workspace: WorkspaceInfo | null;
  /** 是否显示"分支"行。默认 false —— 与原 UI 一致：保留节点但隐藏。 */
  showBranch?: boolean;
  /** 是否显示"状态"行。默认 false —— 与原 UI 一致：保留节点但隐藏。 */
  showTree?: boolean;
  /** 标签文案覆盖（i18n 接缝）。 */
  labels?: Partial<WorkspacePanelLabels>;
}

const DEFAULT_LABELS: WorkspacePanelLabels = {
  dir: '\u76ee\u5f55',
  branch: '\u5206\u652f',
  tree: '\u72b6\u6001',
};

/**
 * WorkspacePanel —— 右栏 WORKSPACE 段内容：目录一行（+ 默认隐藏的分支 / 状态两行）。
 * 哑组件：只渲染 KeyValueRow。
 */
export function WorkspacePanel({ workspace, showBranch = false, showTree = false, labels }: WorkspacePanelProps) {
  const l: WorkspacePanelLabels = { ...DEFAULT_LABELS, ...labels };
  return (
    <div className="workspace-panel">
      <KeyValueRow label={l.dir} value={workspace?.dir ?? '\u2014'} muted />
      <KeyValueRow label={l.branch} value={workspace?.branch ?? '\u2014'} muted hidden={!showBranch} />
      <KeyValueRow label={l.tree} value={workspace?.tree ?? '\u2014'} muted hidden={!showTree} />
    </div>
  );
}
