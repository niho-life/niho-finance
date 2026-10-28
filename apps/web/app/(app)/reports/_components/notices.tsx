import type { ReactNode } from "react";

/** Something that should not happen (the identity of the trial balance): warn, not red. */
export function WarningBand({ messages }: { messages: readonly string[] }) {
  return (
    <div role="alert" className="mb-4 rounded-card bg-warn-soft px-4 py-3 text-[14px] text-warn">
      <ul className="flex flex-col gap-1">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-[13px] text-muted">{children}</p>;
}

export function SectionHeading({
  id,
  children,
  aside,
}: {
  id?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={id} className="text-[15px] font-extrabold">
        {children}
      </h2>
      {aside ? <span className="text-[12px] text-muted">{aside}</span> : null}
    </div>
  );
}
