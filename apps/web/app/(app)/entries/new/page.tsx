import { loadEntryFormOptions, todayInJapan, VOUCHER_KINDS } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { EntryTypeSwitch, isEntryType } from "../_components/entry-type-switch";
import { SimpleEntryForm } from "../_components/simple-entry-form";
import { TransferForm } from "../_components/transfer-form";
import { VoucherForm } from "../_components/voucher-form";

export const metadata: Metadata = { title: "取引の登録" };

/** 取引の登録 (11 §4): 収入 / 支出 / 振替 / 伝票, 支出 by default. */
export default async function NewEntryPage({ searchParams }: PageProps<"/entries/new">) {
  const { type } = await searchParams;
  const entryType = isEntryType(type) ? type : "expense";
  const options = await loadEntryFormOptions(await db());
  const today = todayInJapan();
  return (
    <>
      <PageHeader title="取引の登録" back={{ href: "/entries", label: "取引" }} />
      <EntryTypeSwitch current={entryType} />
      {entryType === "voucher" ? (
        <VoucherForm options={options} today={today} kinds={VOUCHER_KINDS} mode={{ kind: "new" }} />
      ) : entryType === "transfer" ? (
        <TransferForm options={options} today={today} />
      ) : (
        <SimpleEntryForm key={entryType} type={entryType} options={options} today={today} />
      )}
    </>
  );
}
