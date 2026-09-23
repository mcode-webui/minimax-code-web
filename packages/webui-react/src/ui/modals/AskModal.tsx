/**
 * ui/modals/AskModal.tsx —— ask_user 提问弹窗（哑组件，受控 open）
 * ============================================================================
 * 视觉职责：居中卡片弹窗 —— 图标 ❓ + 标题「需要你回答」+ 右上关闭 X +
 * 步骤计数（第 i / N 题）+ 问题 + 选项按钮列表（带 1/2/3 序号圆标，可多选）+
 * 底部「其他」输入框 + 跳过 + 发送。
 *
 * 行为（对齐 vanilla #ask-modal）：
 *   - 多题问卷逐题展示，「发送」在非末题时前进一题、末题时一次性提交全部答案；
 *   - 单题且单选时，点选项立即提交（原 UI 的一击即答）；多选题需点「发送」；
 *   - X / Esc / 点遮罩 = 彻底放弃（onClose，不发任何回答）；
 *   - 「跳过」= 整个问卷按未回答提交（onSkip）。
 * ============================================================================
 */
import './ask.css';

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { AskUserOption } from '../../contracts/domain';

/** 一道待回答的问题。 */
export interface AskModalQuestion {
  id: string;
  question: string;
  options: AskUserOption[];
  /** true → 选项可多选。 */
  multiSelect: boolean;
}

/** 单题答案。 */
export interface AskModalAnswer {
  questionId: string;
  /** 选中的选项 id 列表。 */
  optionIds: string[];
  /** 「其他」文本（可与选项同时给）。 */
  text?: string;
}

export interface AskModalProps {
  open: boolean;
  questions: AskModalQuestion[];
  /** 提交全部答案（点「发送」到最后一题时触发）。 */
  onSubmit: (answers: AskModalAnswer[]) => void;
  /** 跳过整个问卷。 */
  onSkip: () => void;
  /** X / Esc / 遮罩：彻底放弃当前提问。 */
  onClose: () => void;
}

interface Draft {
  optionIds: string[];
  text: string;
}

const EMPTY_DRAFT: Draft = { optionIds: [], text: '' };

/** 数字序号圆标（1/2/3…）。 */
function numBadge(n: number, selected: boolean): ReactElement {
  return (
    <span className={selected ? 'ask-modal-opt-num selected' : 'ask-modal-opt-num'} aria-hidden="true">
      {n}
    </span>
  );
}

export function AskModal(props: AskModalProps) {
  const { open, questions, onSubmit, onSkip, onClose } = props;

  const [stepIdx, setStepIdx] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const otherRef = useRef<HTMLInputElement | null>(null);

  // 每次打开重置问卷进度。
  useEffect(() => {
    if (!open) return;
    setStepIdx(0);
    setDrafts({});
  }, [open]);

  const total = questions.length;
  const idx = Math.min(stepIdx, Math.max(total - 1, 0));
  const question: AskModalQuestion | undefined = questions[idx];
  const draft: Draft = useMemo(
    () => (question ? drafts[question.id] ?? EMPTY_DRAFT : EMPTY_DRAFT),
    [drafts, question],
  );

  if (!open || !question) return null;

  const setDraft = (next: Draft) => {
    setDrafts((prev) => ({ ...prev, [question.id]: next }));
  };

  const toggleOption = (optionId: string) => {
    if (question.multiSelect) {
      const picked = draft.optionIds.includes(optionId);
      const optionIds = picked
        ? draft.optionIds.filter((id) => id !== optionId)
        : [...draft.optionIds, optionId];
      setDraft({ ...draft, optionIds });
    } else {
      const next: Draft = { ...draft, optionIds: [optionId] };
      setDraft(next);
      // 单题 + 单选：一击即答（对齐 vanilla）。
      if (total === 1) {
        onSubmit([
          {
            questionId: question.id,
            optionIds: next.optionIds,
            text: next.text.trim() || undefined,
          },
        ]);
      }
    }
  };

  const collectAll = (): AskModalAnswer[] =>
    questions.map((q) => {
      const d = drafts[q.id] ?? EMPTY_DRAFT;
      return {
        questionId: q.id,
        optionIds: d.optionIds,
        text: d.text.trim() || undefined,
      };
    });

  const nextOrSubmit = () => {
    if (idx < total - 1) {
      setStepIdx(idx + 1);
      return;
    }
    onSubmit(collectAll());
  };

  const handleOtherKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nextOrSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let optNode: ReactElement;
  if (question.options.length === 0) {
    optNode = (
      <div className="ask-modal-no-options">无预设选项 — 在下方“其他”输入回答后按回车或点“发送”</div>
    );
  } else {
    optNode = (
      <div className="ask-modal-options">
        {question.options.map((o, oi) => {
          const selected = draft.optionIds.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              className={selected ? 'ask-modal-opt selected' : 'ask-modal-opt'}
              aria-pressed={selected}
              onClick={() => toggleOption(o.id)}
            >
              {numBadge(oi + 1, selected)}
              <span className="ask-modal-opt-text">
                <span className="ask-modal-opt-label">{o.label}</span>
                {o.desc ? <span className="ask-modal-opt-desc">{o.desc}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="ask-modal">
      <div className="ask-modal-backdrop" onClick={onClose} />
      <div className="ask-modal-content" role="dialog" aria-modal="true" aria-labelledby="ask-modal-title">
        <div className="ask-modal-header">
          <div className="ask-modal-icon" aria-hidden="true">❓</div>
          <div className="ask-modal-title" id="ask-modal-title">需要你回答</div>
          <button
            type="button"
            className="ask-modal-close"
            title="全部跳过 (Esc 同效)"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="ask-modal-body">
          <div className="ask-modal-step-counter">
            {total > 1 ? `第 ${idx + 1} / ${total} 题` : ''}
          </div>
          <div className="ask-modal-question">{question.question}</div>
          {optNode}
        </div>

        <div className="ask-modal-footer">
          <input
            ref={otherRef}
            type="text"
            className="ask-modal-other"
            placeholder="其他 (回车发送)..."
            value={draft.text}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={handleOtherKeyDown}
          />
          <button type="button" className="ask-modal-btn-secondary" onClick={onSkip}>
            跳过
          </button>
          <button type="button" className="ask-modal-btn-primary" onClick={nextOrSubmit}>
            {total > 1 && idx < total - 1 ? `发送 (${total} 题)` : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
