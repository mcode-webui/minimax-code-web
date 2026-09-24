import type { TodoItem, TodoStatus } from '../../contracts/domain';
import './TodoList.css';

export interface TodoListProps {
  /** 待办条目（顺序即渲染顺序）。 */
  items: readonly TodoItem[];
  /** 列表为空时的占位文案。 */
  emptyText?: string;
}

const MARKERS: Record<TodoStatus, string> = {
  pending: '\u25cb',
  in_progress: '\u25d0',
  completed: '\u2713',
};

/**
 * TodoList —— 右栏 TODO 段的条目列表（pending / in_progress / completed 三态样式）。
 * 哑组件：只渲染，交互由上层包装。
 */
export function TodoList({ items, emptyText = '\u6682\u65e0\u5f85\u529e' }: TodoListProps) {
  if (items.length === 0) {
    return <div className="todo-empty">{emptyText}</div>;
  }
  return (
    <ul className="todo-list">
      {items.map((item) => (
        <li key={item.id} className={'todo-item todo-item--' + item.status}>
          <span className="todo-marker" aria-hidden="true">
            {MARKERS[item.status]}
          </span>
          <span className="todo-text">{item.content}</span>
        </li>
      ))}
    </ul>
  );
}
