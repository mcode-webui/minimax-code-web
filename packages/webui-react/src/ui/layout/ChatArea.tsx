import { useCallback, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import './chatarea.css';

export interface ChatAreaProps {
  /** 会话标题栏插槽（SessionTitleBar，渲染在滚动区之上）。 */
  titlebar?: ReactNode;
  /** 欢迎空态插槽（logo + 提示语）。 */
  empty?: ReactNode;
  /** 消息流插槽。 */
  messages?: ReactNode;
  /** 是否显示"思考中"指示（品牌 logo + 三个跳动圆点 + 文案）。 */
  thinking?: boolean;
  /** 思考中文案，默认"思考中"。 */
  thinkingText?: string;
  /** 输入区插槽（输入框 + 工具条）。 */
  composer?: ReactNode;
  /** 输入框下方的工作区行插槽。 */
  workspaceRow?: ReactNode;
  /** 底部提示行（"/ 命令 · @ 文件…"）。 */
  hint?: ReactNode;
  /** 欢迎页布局（整体垂直居中、去掉输入区分隔线）。 */
  welcome?: boolean;
  /** 拖拽松开时上抛文件列表。 */
  onDropFiles?: (files: File[]) => void;
  /** 拖拽遮罩文案，默认"松开上传文件"。 */
  dropHintText?: string;
  /** 拖拽遮罩是否显示（受控覆盖；缺省内部按 dragenter/leave 自动管理）。 */
  dropActive?: boolean;
  /** 品牌 logo 图片地址（思考中头像）。 */
  logoSrc?: string;
}

/**
 * ChatArea —— 中间栏骨架：滚动容器 + 欢迎空态 + 消息流 + 思考中指示 + 输入区 + 拖拽遮罩。
 * 哑组件：内容全部走插槽，交互（拖拽文件）经 onDropFiles 上抛。
 */
export function ChatArea(props: ChatAreaProps) {
  const {
    titlebar,
    empty,
    messages,
    thinking = false,
    thinkingText = '\u601d\u8003\u4e2d',
    composer,
    workspaceRow,
    hint,
    welcome = false,
    onDropFiles,
    dropHintText = '\u677e\u5f00\u4f20\u8f93\u6587\u4ef6',
    dropActive,
    logoSrc = '/brand-logo.png',
  } = props;

  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);

  const showDrop = dropActive ?? dragging;

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!onDropFiles) return;
    e.preventDefault();
    depthRef.current += 1;
    setDragging(true);
  }, [onDropFiles]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!onDropFiles) return;
    e.preventDefault();
  }, [onDropFiles]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!onDropFiles) return;
    e.preventDefault();
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setDragging(false);
  }, [onDropFiles]);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!onDropFiles) return;
    e.preventDefault();
    depthRef.current = 0;
    setDragging(false);
    const list = e.dataTransfer?.files;
    if (list && list.length > 0) {
      const files: File[] = [];
      for (let i = 0; i < list.length; i += 1) {
        const f = list.item(i);
        if (f) files.push(f);
      }
      if (files.length > 0) onDropFiles(files);
    }
  }, [onDropFiles]);

  return (
    <main
      className={welcome ? 'chat-area chat-area--welcome' : 'chat-area'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {titlebar}
      <div className="chat-scroll">
        {empty && <div className="chat-empty">{empty}</div>}
        <div className="chat-inner">{messages}</div>
        {thinking && (
          <div className="chat-thinking">
            <img className="chat-thinking-avatar" src={logoSrc} alt="MiniMax Code" />
            <span className="chat-thinking-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="chat-thinking-text">{thinkingText}</span>
          </div>
        )}
      </div>

      <div className="input-area">
        <div className="input-inner">
          {composer}
          {workspaceRow && <div className="input-workspace-row">{workspaceRow}</div>}
          {hint && <div className="input-hint">{hint}</div>}
        </div>
      </div>

      <div className={showDrop ? 'dropzone-overlay dropzone-overlay--show' : 'dropzone-overlay'}>{dropHintText}</div>
    </main>
  );
}