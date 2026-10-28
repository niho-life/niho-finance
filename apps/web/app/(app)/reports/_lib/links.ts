/**
 * The entry detail `/entries/[id]` is S3's (#4). Until it is merged, numbers in the journal and
 * the general ledger are plain text; the lead flips this flag when the route exists.
 */
export const ENTRY_DETAIL_READY = false;

export function entryHref(entryId: string): string | null {
  return ENTRY_DETAIL_READY ? `/entries/${entryId}` : null;
}
