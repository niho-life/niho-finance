import { getInvoiceSettings } from "@niho-finance/db";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { BankAccountForm } from "../_components/bank-account-form";

export const metadata: Metadata = { title: "請求の設定" };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[12px] font-bold text-muted">{label}</dt>
      <dd className="num min-w-0 break-words">{children}</dd>
    </>
  );
}

/**
 * 請求の設定 (18 §10): the issuer as the documents print it (read here; changed in 設定 › 事業所)
 * and the 振込先.
 */
export default async function InvoiceSettingsPage() {
  const settings = await getInvoiceSettings(await db());
  const issuer = settings.issuer;
  return (
    <>
      <PageHeader title="請求の設定" back={{ href: "/invoices", label: "請求" }} />
      <section aria-labelledby="issuer" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
          <h2 id="issuer" className="text-[15px] font-extrabold">
            発行者
          </h2>
          <Link
            href="/settings/company"
            className="text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
          >
            設定 › 事業所 で変更
          </Link>
        </div>
        {issuer ? (
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border pt-3 text-[14px] md:grid-cols-[120px_minmax(0,1fr)]">
            <Item label="商号">{issuer.name}</Item>
            <Item label="住所">{issuer.address ?? "—"}</Item>
            <Item label="代表者">{issuer.representative ?? "—"}</Item>
            <Item label="登録番号">
              {issuer.invoiceRegistrationNumber ?? "なし（区分記載請求書として発行します）"}
            </Item>
            <Item label="登録日">{formatDate(issuer.invoiceRegisteredOn)}</Item>
          </dl>
        ) : (
          <p className="text-[13px] text-muted">
            事業所がまだ登録されていません。設定 › 事業所 で登録してください
          </p>
        )}
      </section>
      <section aria-labelledby="bank-account">
        <h2 id="bank-account" className="mb-3 text-[15px] font-extrabold">
          振込先
        </h2>
        <BankAccountForm
          key={JSON.stringify(settings.bankAccount)}
          initial={settings.bankAccount}
        />
      </section>
    </>
  );
}
