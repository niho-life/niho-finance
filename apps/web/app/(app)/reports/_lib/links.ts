/**
 * The entry detail `/entries/[id]` (S3 #4): numbers in the journal and the general ledger lead to
 * it, the last step of 試算表 → 総勘定元帳 → 仕訳 (14-reports §3, §8).
 */
export function entryHref(entryId: string): string {
  return `/entries/${entryId}`;
}
