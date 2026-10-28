"use client";

import type { PartnerSettings, SelectOption } from "@niho-finance/db";
import { PARTNER_KIND_LABELS, PARTNER_KINDS } from "@niho-finance/ledger";
import { useState } from "react";
import {
  activeToggledMessage,
  InactiveToggle,
  SaveStatus,
  SelectCell,
  TextCell,
  useFormSubmit,
  useRowSave,
} from "@/components/settings/inline";
import {
  ActiveToggleButton,
  FormError,
  OpenButton,
  SheetField,
} from "@/components/settings/row-parts";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { gridStyle, Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createPartnerAction, setPartnerActiveAction, updatePartnerAction } from "../actions";

const COLUMNS = {
  columns:
    "minmax(140px,1.3fr) minmax(110px,1fr) 92px 150px 160px 150px 110px 150px 96px minmax(64px,120px)",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

const KIND_OPTIONS = PARTNER_KINDS.map((kind) => ({
  value: kind,
  label: PARTNER_KIND_LABELS[kind],
}));

/** 照合 of a partner (20-reader §10.3), worded on the server. */
export interface RegistrationCell {
  /** 「登録あり（2023/10/01〜）」「未登録」「登録終了（2025/03/31）」「未照合」 */
  label: string;
  /** The day of the last lookup, `2026/11/01`. */
  checkedOn: string | null;
}

/** 照合: the label and the day it was looked up; 「—」 without a registration number. */
function RegistrationStatus({
  partner,
  registration,
}: {
  partner: PartnerSettings;
  registration: RegistrationCell | undefined;
}) {
  if (!partner.invoiceRegistrationNumber) return <span className="text-muted">—</span>;
  return (
    <span className="flex min-w-0 flex-col leading-snug">
      <span className="text-[13px] break-words">{registration?.label ?? "未照合"}</span>
      {registration?.checkedOn ? (
        <span className="num text-[11px] text-muted">{registration.checkedOn}</span>
      ) : null}
    </span>
  );
}

interface Options {
  accounts: readonly SelectOption[];
  segments: readonly SelectOption[];
  taxOptions: readonly SelectOption[];
}

const none = (options: readonly SelectOption[]) => [{ value: "", label: "なし" }, ...options];

type Save = ReturnType<typeof useRowSave>;

/** The cells of a partner, shared by the row (PC) and the sheet (phones). */
function cells(partner: PartnerSettings, options: Options, row: Save) {
  return {
    name: (
      <TextCell
        label={`${partner.name} の名前`}
        value={partner.name}
        maxLength={200}
        onCommit={(value) => row.commit("name", value)}
      />
    ),
    nameKana: (
      <TextCell
        label={`${partner.name} のカナ`}
        value={partner.nameKana ?? ""}
        maxLength={200}
        onCommit={(value) => row.commit("nameKana", value)}
      />
    ),
    kind: (
      <SelectCell
        label={`${partner.name} の区分`}
        value={partner.kind}
        options={KIND_OPTIONS}
        onCommit={(value) => row.commit("kind", value)}
      />
    ),
    invoiceRegistrationNumber: (
      <TextCell
        label={`${partner.name} の登録番号`}
        value={partner.invoiceRegistrationNumber ?? ""}
        placeholder="T と 13 桁"
        maxLength={20}
        onCommit={(value) => row.commit("invoiceRegistrationNumber", value)}
      />
    ),
    defaultAccountId: (
      <SelectCell
        label={`${partner.name} の既定の科目`}
        value={partner.defaultAccountId ?? ""}
        options={none(options.accounts)}
        onCommit={(value) => row.commit("defaultAccountId", value)}
      />
    ),
    defaultSegmentId: (
      <SelectCell
        label={`${partner.name} の既定のセグメント`}
        value={partner.defaultSegmentId ?? ""}
        options={none(options.segments)}
        onCommit={(value) => row.commit("defaultSegmentId", value)}
      />
    ),
    defaultTaxCategoryCode: (
      <SelectCell
        label={`${partner.name} の既定の税区分`}
        value={partner.defaultTaxCategoryCode ?? ""}
        options={none(options.taxOptions)}
        onCommit={(value) => row.commit("defaultTaxCategoryCode", value)}
      />
    ),
    active: (
      <ActiveToggleButton
        isActive={partner.isActive}
        disabled={row.pending}
        onToggle={() =>
          row.run(
            () => setPartnerActiveAction(partner.id, !partner.isActive),
            activeToggledMessage(partner.name, partner.isActive),
          )
        }
      />
    ),
  };
}

function PartnerRow({
  partner,
  options,
  registration,
  onOpen,
}: {
  partner: PartnerSettings;
  options: Options;
  registration: RegistrationCell | undefined;
  onOpen: () => void;
}) {
  const row = useRowSave((patch) => updatePartnerAction(partner.id, patch));
  const cell = cells(partner, options, row);
  return (
    <TableRow {...COLUMNS} muted={!partner.isActive}>
      <Td>{cell.name}</Td>
      <Td sm="hide">{cell.nameKana}</Td>
      <Td>{cell.kind}</Td>
      <Td>{cell.invoiceRegistrationNumber}</Td>
      <Td sm="hide">
        <RegistrationStatus partner={partner} registration={registration} />
      </Td>
      <Td sm="hide">{cell.defaultAccountId}</Td>
      <Td sm="hide">{cell.defaultSegmentId}</Td>
      <Td sm="hide">{cell.defaultTaxCategoryCode}</Td>
      <Td sm="hide">{cell.active}</Td>
      <Td className="md:hidden">
        <OpenButton label={`${partner.name} のすべての項目`} onClick={onOpen}>
          開く
        </OpenButton>
      </Td>
      <SaveStatus status={row.status} />
    </TableRow>
  );
}

/** Phones show 名前・区分・登録番号; the sheet has every column. */
function PartnerSheet({
  partner,
  options,
  registration,
  onClose,
}: {
  partner: PartnerSettings;
  options: Options;
  registration: RegistrationCell | undefined;
  onClose: () => void;
}) {
  const row = useRowSave((patch) => updatePartnerAction(partner.id, patch));
  const cell = cells(partner, options, row);
  return (
    <Sheet
      open
      onClose={onClose}
      title={partner.name}
      description={PARTNER_KIND_LABELS[partner.kind]}
    >
      <div className="mb-2 flex justify-end">
        <span className="max-w-[70%]">
          <SaveStatus asCell={false} status={row.status} />
        </span>
      </div>
      <SheetField label="名前">{cell.name}</SheetField>
      <SheetField label="カナ">{cell.nameKana}</SheetField>
      <SheetField label="区分">{cell.kind}</SheetField>
      <SheetField label="登録番号">{cell.invoiceRegistrationNumber}</SheetField>
      <SheetField label="照合">
        <RegistrationStatus partner={partner} registration={registration} />
      </SheetField>
      <SheetField label="既定の科目">{cell.defaultAccountId}</SheetField>
      <SheetField label="既定のセグメント">{cell.defaultSegmentId}</SheetField>
      <SheetField label="既定の税区分">{cell.defaultTaxCategoryCode}</SheetField>
      <SheetField label="状態">
        <span className="flex items-center gap-2">
          {partner.isActive ? "有効" : "無効"}
          {cell.active}
        </span>
      </SheetField>
    </Sheet>
  );
}

function AddPartnerRow() {
  const toast = useToast();
  const { onSubmit, pending, error } = useFormSubmit(createPartnerAction, {
    onSuccess: () => toast("取引先を追加しました"),
  });
  return (
    <form
      onSubmit={onSubmit}
      role="row"
      aria-label="取引先の追加"
      className="data-row bg-surface-2"
      style={gridStyle({
        columns: "minmax(0,1.3fr) 120px 180px auto",
        mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
      })}
    >
      <input
        name="name"
        aria-label="名前"
        placeholder="名前"
        maxLength={200}
        autoComplete="off"
        className="cell-input"
      />
      <select name="kind" aria-label="区分" className="cell-input" defaultValue="vendor">
        {KIND_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        name="invoiceRegistrationNumber"
        aria-label="登録番号"
        placeholder="登録番号（任意）"
        maxLength={20}
        autoComplete="off"
        className="cell-input"
      />
      <Button type="submit" size="sm" variant="primary" disabled={pending}>
        追加
      </Button>
      <FormError error={error} className="col-span-full" />
    </form>
  );
}

export function PartnersTable({
  partners,
  accounts,
  segments,
  taxOptions,
  registrations,
  ntaEnabled = false,
}: {
  partners: PartnerSettings[];
  /** 照合 by partner ID. */
  registrations?: ReadonlyMap<string, RegistrationCell>;
  /** The application ID is set: the numbers are looked up at the publication. */
  ntaEnabled?: boolean;
} & Options) {
  const [showInactive, setShowInactive] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const options: Options = { accounts, segments, taxOptions };
  const shown = partners.filter((partner) => partner.isActive || showInactive);
  const inactiveCount = partners.filter((partner) => !partner.isActive).length;
  const opened = partners.find((partner) => partner.id === openId);

  return (
    <>
      <Table label="取引先" minWidth={1300}>
        <TableHead {...COLUMNS}>
          <Th>名前</Th>
          <Th sm="hide">カナ</Th>
          <Th>区分</Th>
          <Th>登録番号</Th>
          <Th sm="hide">照合</Th>
          <Th sm="hide">既定の科目</Th>
          <Th sm="hide">既定のセグメント</Th>
          <Th sm="hide">既定の税区分</Th>
          <Th sm="hide">状態</Th>
          <Th />
        </TableHead>
        {shown.length === 0 ? (
          <p className="px-4 py-5 text-[14px] text-muted">
            取引先はまだありません。下の行から名前と区分を入れて追加します。
          </p>
        ) : null}
        {shown.map((partner) => (
          <PartnerRow
            key={partner.id}
            partner={partner}
            options={options}
            registration={registrations?.get(partner.id)}
            onOpen={() => setOpenId(partner.id)}
          />
        ))}
        <AddPartnerRow />
      </Table>
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
      <p className="mt-2 text-[12px] text-muted">
        {ntaEnabled
          ? "登録番号は形式と検査用数字を確かめ、国税庁の公表サイトで照合します（毎月 1 日に再照合）"
          : "登録番号は形式と検査用数字を確かめます。国税庁の公表サイトとの照合は、アプリケーション ID を設定すると使えます"}
      </p>
      {opened ? (
        <PartnerSheet
          key={opened.id}
          partner={opened}
          options={options}
          registration={registrations?.get(opened.id)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}
