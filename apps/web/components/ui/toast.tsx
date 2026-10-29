"use client";

import Link from "next/link";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";

/** A link after the message (「No. 12 を登録しました」 → the entry). */
interface ToastLink {
  href: string;
  label: string;
}

interface ToastState {
  id: number;
  message: string;
  tone: "default" | "error";
  link: ToastLink | null;
}

type ShowToast = (
  message: string,
  options?: { tone?: "default" | "error"; link?: ToastLink },
) => void;

const ToastContext = createContext<ShowToast>(() => {});

/** `useToast()("保存しました")`: a message at the bottom centre for 5 seconds (10 §1). */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

const DURATION_MS = 5_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(0);

  const show: ShowToast = (message, options = {}) => {
    if (timer.current) clearTimeout(timer.current);
    nextId.current += 1;
    setToast({
      id: nextId.current,
      message,
      tone: options.tone ?? "default",
      link: options.link ?? null,
    });
    timer.current = setTimeout(() => setToast(null), DURATION_MS);
  };

  return (
    <ToastContext value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 md:bottom-7"
      >
        {toast ? (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto flex max-w-[min(480px,100%)] items-center gap-3 rounded-xl px-4 py-2.5 text-[13px] text-white shadow-float ${
              toast.tone === "error" ? "bg-danger" : "bg-text"
            }`}
          >
            <span>{toast.message}</span>
            {toast.link ? (
              <Link
                href={toast.link.href}
                onClick={() => setToast(null)}
                className="font-bold whitespace-nowrap text-accent underline underline-offset-4"
              >
                {toast.link.label}
              </Link>
            ) : null}
            <button
              type="button"
              onClick={() => setToast(null)}
              className="font-bold text-accent"
              aria-label="通知を閉じる"
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext>
  );
}
