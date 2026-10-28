/** `before` / `after` of an audit row side by side, as formatted JSON in small type (11 §5, §8). */
export function JsonPair({ before, after }: { before: unknown; after: unknown }) {
  const block = (label: string, value: unknown) => (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-bold text-muted">{label}</span>
      <pre className="num max-h-72 overflow-auto rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
        {value === null || value === undefined ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {block("変更前", before)}
      {block("変更後", after)}
    </div>
  );
}
