import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

/** ids of the help and error texts of a field, for `aria-describedby`. */
export function describedBy(id: string, options: { help?: ReactNode; error?: string | undefined }) {
  const ids = [options.help ? `${id}-help` : null, options.error ? `${id}-error` : null].filter(
    Boolean,
  );
  return {
    "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
    "aria-invalid": options.error ? true : undefined,
  } as const;
}

export interface FormFieldProps {
  label: ReactNode;
  /** The id of the control inside (label `for`, help and error ids). */
  htmlFor: string;
  help?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label, control, help and error kept together (10 §1). */
export function FormField({
  label,
  htmlFor,
  help,
  error,
  required,
  className = "",
  children,
}: FormFieldProps) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={htmlFor} className="text-[12px] font-bold text-muted">
        {label}
        {required ? <span className="ml-1 font-normal text-muted">必須</span> : null}
      </label>
      {children}
      {help ? (
        <p id={`${htmlFor}-help`} className="text-[12px] text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-[12px] font-bold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`control ${className}`} {...props} />;
}

/** Native `<select>` (no UI library). */
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`control ${className}`} {...props} />;
}

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`control min-h-20 ${className}`} rows={3} {...props} />;
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
}

export function Checkbox({ label, className = "", id, ...props }: CheckboxProps) {
  return (
    <label
      htmlFor={id}
      className={`inline-flex min-h-8 cursor-pointer items-center gap-2 text-[14px] ${className}`}
    >
      <input
        id={id}
        type="checkbox"
        className="size-4 shrink-0 cursor-pointer accent-[var(--primary)]"
        {...props}
      />
      <span>{label}</span>
    </label>
  );
}
