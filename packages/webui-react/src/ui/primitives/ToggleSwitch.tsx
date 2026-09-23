import './toggle.css';

export interface ToggleSwitchProps {
  /** 当前开关状态（受控）。 */
  checked: boolean;
  /** 状态变化回调，传出新的 checked。 */
  onChange: (checked: boolean) => void;
  /** 原生 input 的 id（配合外部 label 关联）。 */
  id?: string;
  /** 无障碍名称。 */
  label?: string;
}

/**
 * ToggleSwitch —— 滑动开关（原 UI 的 .lan-card-toggle）。
 * 哑组件：受控输入，状态由 props 进，变化由 onChange 出。
 */
export function ToggleSwitch({ checked, onChange, id, label }: ToggleSwitchProps) {
  return (
    <span className="toggle" title={label}>
      <input
        id={id}
        className="toggle-input"
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-slider" aria-hidden="true" />
    </span>
  );
}
