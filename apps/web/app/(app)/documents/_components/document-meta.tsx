"use client";

import { DOCUMENT_KIND_LABELS, DOCUMENT_KINDS, type DocumentKind } from "@niho-finance/ledger";
import type { ReactNode } from "react";
import {
  SaveStatus,
  SelectCell,
  TextCell,
  useRowSave,
  type Option,
} from "@/components/settings/inline";
import { SheetField } from "@/components/settings/row-parts";
import { formatDate } from "@/lib/format";
import { updateDocumentAction } from "../actions";
import { AmountCell, DateCell } from "./cells";

/** The items of a document as the cells show them ("" when empty; the amount with grouping). */
export interface DocumentItems {
  kind: DocumentKind;
  txnDate: string;
  amount: string;
  partnerId: string;
  partnerName: string;
  /** What 取引先 shows: the master's name, else the free-text name. */
  partnerLabel: string;
  invoiceRegistrationNumber: string;
  note: string;
}

const KIND_OPTIONS: readonly Option[] = DOCUMENT_KINDS.map((kind) => ({
  value: kind,
  label: DOCUMENT_KIND_LABELS[kind],
}));

/** 「その他」: the partner is not in the master; its name is typed in 取引先名. */
const OTHER_PARTNER: Option = { value: "", label: "その他（名前を入力）" };

function Header({ children }: { children?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-3">
      <h2 className="text-[15px] font-extrabold">項目</h2>
      {children}
    </div>
  );
}

/**
 * 項目 of a document (13 §4), edited in place like the settings' lists: each cell saves on blur,
 * Enter or change, and the top right shows 保存中 / 保存済み / エラー（理由）. A voided document only
 * shows its items.
 */
export function DocumentMeta({
  id,
  items,
  partners,
  voided,
  unsorted,
}: {
  id: string;
  items: DocumentItems;
  /** Active partners, plus the chosen one when it is inactive. */
  partners: readonly Option[];
  voided: boolean;
  unsorted: boolean;
}) {
  const row = useRowSave((patch) => updateDocumentAction(id, patch));

  if (voided) {
    const text = (value: string) => value || <span className="text-muted">—</span>;
    return (
      <section aria-label="項目">
        <Header />
        <SheetField label="種別">{DOCUMENT_KIND_LABELS[items.kind]}</SheetField>
        <SheetField label="取引年月日">
          <span className="num">{items.txnDate ? formatDate(items.txnDate) : text("")}</span>
        </SheetField>
        <SheetField label="金額（円）">
          <span className="num">{text(items.amount)}</span>
        </SheetField>
        <SheetField label="取引先">{text(items.partnerLabel)}</SheetField>
        <SheetField label="登録番号">{text(items.invoiceRegistrationNumber)}</SheetField>
        <SheetField label="メモ">
          <span className="break-words">{text(items.note)}</span>
        </SheetField>
      </section>
    );
  }

  return (
    <section aria-label="項目">
      <Header>
        <span className="ml-auto max-w-[70%]">
          <SaveStatus asCell={false} status={row.status} />
        </span>
      </Header>
      {unsorted ? (
        <p className="mb-1 text-[12px] text-muted">
          取引年月日・金額・取引先のどれかが空です（未整理）
        </p>
      ) : null}
      <SheetField label="種別">
        <SelectCell
          label="種別"
          value={items.kind}
          options={KIND_OPTIONS}
          onCommit={(value) => row.commit("kind", value)}
        />
      </SheetField>
      <SheetField label="取引年月日">
        <DateCell
          label="取引年月日"
          value={items.txnDate}
          onCommit={(value) => row.commit("txnDate", value)}
        />
      </SheetField>
      <SheetField label="金額（円）">
        <AmountCell
          label="金額（円）"
          value={items.amount}
          onCommit={(value) => row.commit("amount", value)}
        />
      </SheetField>
      <SheetField label="取引先">
        <SelectCell
          label="取引先"
          value={items.partnerId}
          options={[OTHER_PARTNER, ...partners]}
          onCommit={(value) => row.commit("partnerId", value)}
        />
      </SheetField>
      {items.partnerId === "" ? (
        <SheetField label="取引先名">
          <TextCell
            label="取引先名"
            value={items.partnerName}
            placeholder="取引先マスタにない名前"
            maxLength={200}
            onCommit={(value) => row.commit("partnerName", value)}
          />
        </SheetField>
      ) : null}
      <SheetField label="登録番号">
        <TextCell
          label="登録番号"
          value={items.invoiceRegistrationNumber}
          placeholder="T と 13 桁"
          maxLength={20}
          onCommit={(value) => row.commit("invoiceRegistrationNumber", value)}
        />
      </SheetField>
      <SheetField label="メモ">
        <TextCell
          label="メモ"
          value={items.note}
          maxLength={1000}
          onCommit={(value) => row.commit("note", value)}
        />
      </SheetField>
    </section>
  );
}
