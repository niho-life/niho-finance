"use client";

import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { InboxPicker, type InboxDocument } from "./inbox-picker";
import { Uploader, type UploadOutcome } from "./uploader";

function savedMessage({ saved, duplicates }: UploadOutcome): string | null {
  if (saved.length > 0) {
    return saved.length === 1
      ? "証憑を保存し、紐づけました"
      : `${saved.length} 件の証憑を保存し、紐づけました`;
  }
  if (duplicates.length > 0) return "保存済みの証憑を紐づけました";
  return null;
}

/**
 * 「証憑を追加」 (the compact uploader, linking in the same transaction; 「撮影」 too on phones) and
 * 「受信箱から選ぶ」 of an entry's detail. The entry's page stays and shows the new links.
 */
export function EntryDocumentsActions({
  entryId,
  inbox,
}: {
  entryId: string;
  inbox: readonly InboxDocument[];
}) {
  const router = useRouter();
  const toast = useToast();
  return (
    <div className="mt-3">
      <Uploader
        compact
        link={{ kind: "journal_entry", id: entryId }}
        onSaved={(outcome) => {
          const message = savedMessage(outcome);
          if (message) toast(message);
          router.refresh();
        }}
        actions={<InboxPicker entryId={entryId} documents={inbox} />}
      />
    </div>
  );
}
