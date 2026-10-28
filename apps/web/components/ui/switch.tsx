"use client";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Read by screen readers (the switch has no visible text). */
  label: string;
  disabled?: boolean;
  id?: string;
}

/** On / off toggle (`role="switch"`), e.g. a tax rate rule's 有効. */
export function Switch({ checked, onCheckedChange, label, disabled, id }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-primary bg-primary" : "border-border-2 bg-track"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute size-[18px] rounded-full bg-white shadow-raised transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
