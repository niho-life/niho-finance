import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-primary text-white hover:bg-primary-ink",
  secondary: "border-border-2 bg-surface text-text hover:bg-surface-2",
  ghost: "border-transparent bg-transparent text-muted hover:bg-black/5 hover:text-text",
  danger: "border-transparent bg-danger text-white hover:brightness-95",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-8 rounded-lg px-3 text-[13px]",
  md: "min-h-10 rounded-[10px] px-4 text-[14px]",
};

export function buttonClass(
  options: { variant?: ButtonVariant; size?: ButtonSize; className?: string | undefined } = {},
): string {
  const { variant = "secondary", size = "md", className = "" } = options;
  return [
    "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap border font-bold",
    "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
    className,
  ].join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Labels are result verbs: 保存 / 追加 / 登録 / 次へ / 無効にする (05-ui-ux §4). */
export function Button({ variant, size, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}

export interface ButtonLinkProps extends ComponentProps<typeof Link> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function ButtonLink({ variant, size, className, ...props }: ButtonLinkProps) {
  return <Link className={buttonClass({ variant, size, className })} {...props} />;
}
