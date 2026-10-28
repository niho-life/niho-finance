"use client";

import type { SelectOption } from "@niho-finance/db";
import { useRef, useState } from "react";
import {
  activeToggledMessage,
  InactiveToggle,
  SaveStatus,
  SelectCell,
  TextCell,
  useFormSubmit,
  useRowSave,
  type CommitOutcome,
  type Option,
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
import {
  createRecurringItemAction,
  setRecurringItemActiveAction,
  updateRecurringItemAction,
} from "./actions";

/** A recurring item as the list shows it (amounts as the cells' text). */
export interface RecurringRow {
  id: string;
  name: string;
  direction: "deposit" | "withdrawal";
  /** Positive, 3-digit grouping. */
  amount: string;
  frequency: "monthly" | "yearly";
  monthOfYear: number | null;
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
  walletId: string | null;
  walletName: string | null;
  accountId: string;
  accountLabel: string;
  partnerId: string | null;
  segmentId: string | null;
  taxCategoryCode: string | null;
  note: string | null;
  isActive: boolean;
  /** The end date has passed (「終了」 next to the state). */
  ended: boolean;
}

/** An option that may have been deactivated since the item chose it. */
export interface MaybeInactiveOption extends SelectOption {
  isActive: boolean;
}

interface Options {
  wallets: readonly SelectOption[];
  accounts: readonly SelectOption[];
  partners: readonly MaybeInactiveOption[];
  segments: readonly MaybeInactiveOption[];
  taxOptions: readonly SelectOption[];
}

const COLUMNS = {
  columns:
    "minmax(140px,1.2fr) 200px 220px minmax(120px,0.9fr) minmax(140px,1fr) 270px 150px 64px minmax(64px,110px)",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

const DIRECTION_OPTIONS: Option[] = [
  { value: "deposit", label: "入金" },
  { value: "withdrawal", label: "出金" },
];

const FREQUENCY_OPTIONS: Option[] = [
  { value: "monthly", label: "毎月" },
  { value: "yearly", label: "毎年" },
];

const MONTH_OPTIONS: Option[] = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: `${i + 1} 月`,
}));

/** 1〜30 日 and 末日 (31: the last day of every month, 21 §2). */
const DAY_OPTIONS: Option[] = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: i + 1 === 31 ? "末日" : `${i + 1} 日`,
}));

const none = (options: readonly Option[]) => [{ value: "", label: "なし" }, ...options];

/** The options plus the row's own value when it is no longer among them (shown as 無効). */
function withCurrent(
  options: readonly Option[],
  value: string | null,
  label: string | null,
): Option[] {
  if (!value || options.some((option) => option.value === value)) return [...options];
  return [...options, { value, label: `${label ?? "選択中"}（無効）` }];
}

function activeOrCurrent(options: readonly MaybeInactiveOption[], value: string | null): Option[] {
  const current = options.find((option) => option.value === value);
  return withCurrent(
    options.filter((option) => option.isActive),
    value,
    current?.label ?? null,
  );
}

/** 開始日 / 終了日 edited in place: saves on blur or Enter, Escape puts the saved date back. */
function DateCell({
  label,
  value,
  onCommit,
  className = "",
}: {
  label: string;
  value: string;
  onCommit: (value: string) => Promise<CommitOutcome>;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef(value);
  const [invalid, setInvalid] = useState(false);

  async function commit() {
    const input = ref.current;
    if (!input || input.value === saved.current) return;
    const outcome = await onCommit(input.value);
    if (outcome.ok) {
      saved.current = input.value;
      setInvalid(false);
    } else {
      setInvalid(true);
    }
  }

  return (
    <input
      ref={ref}
      type="date"
      defaultValue={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={`cell-input num ${className}`}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        }
        if (event.key === "Escape") {
          event.currentTarget.value = saved.current;
          setInvalid(false);
        }
      }}
    />
  );
}

type Save = ReturnType<typeof useRowSave>;

/** The cells of an item, shared by the row (PC) and the sheet (詳細, phones). */
function cells(item: RecurringRow, options: Options, row: Save) {
  const name = item.name;
  // 毎年 needs its month: switching to it takes the month of the start date until changed.
  const commitFrequency = async (value: string): Promise<CommitOutcome> => {
    const patch: Record<string, string> = { frequency: value };
    if (value === "yearly" && item.monthOfYear === null) {
      patch.monthOfYear = String(Number(item.startDate.slice(5, 7)));
    }
    const result = await row.track(() => updateRecurringItemAction(item.id, patch), "frequency");
    return result.ok ? { ok: true } : { ok: false };
  };
  const direction = (
    <SelectCell
      label={`${name} の入出金`}
      value={item.direction}
      options={DIRECTION_OPTIONS}
      onCommit={(value) => row.commit("direction", value)}
      className="w-[4.75rem] shrink-0"
    />
  );
  const amount = (
    <TextCell
      label={`${name} の金額（円）`}
      value={item.amount}
      inputMode="numeric"
      align="right"
      maxLength={17}
      onCommit={(value) => row.commit("amount", value)}
    />
  );
  const frequency = (
    <SelectCell
      label={`${name} の周期`}
      value={item.frequency}
      options={FREQUENCY_OPTIONS}
      onCommit={commitFrequency}
      className="w-[4.75rem] shrink-0"
    />
  );
  const month =
    item.frequency === "yearly" ? (
      <SelectCell
        key={`month:${item.monthOfYear ?? ""}`}
        label={`${name} の月`}
        value={item.monthOfYear === null ? "" : String(item.monthOfYear)}
        options={MONTH_OPTIONS}
        onCommit={(value) => row.commit("monthOfYear", value)}
        className="w-[4.5rem] shrink-0"
      />
    ) : null;
  const day = (
    <SelectCell
      label={`${name} の日`}
      value={item.dayOfMonth === null ? "" : String(item.dayOfMonth)}
      options={
        item.dayOfMonth === null ? [{ value: "", label: "日" }, ...DAY_OPTIONS] : DAY_OPTIONS
      }
      onCommit={(value) => row.commit("dayOfMonth", value)}
      className="w-[4.75rem] shrink-0"
    />
  );
  const startDate = (
    <DateCell
      label={`${name} の開始日`}
      value={item.startDate}
      onCommit={(value) => row.commit("startDate", value)}
    />
  );
  const endDate = (
    <DateCell
      label={`${name} の終了日`}
      value={item.endDate ?? ""}
      onCommit={(value) => row.commit("endDate", value)}
    />
  );
  return {
    name: (
      <TextCell
        label={`${name} の名前`}
        value={name}
        maxLength={60}
        onCommit={(value) => row.commit("name", value)}
      />
    ),
    direction,
    amount,
    amountCell: (
      <span className="flex min-w-0 items-center gap-0.5">
        {direction}
        {item.direction === "withdrawal" ? (
          <span aria-hidden="true" className="num text-[14px] text-muted">
            -
          </span>
        ) : null}
        {amount}
      </span>
    ),
    frequency,
    month,
    day,
    cadenceCell: (
      <span className="flex min-w-0 items-center gap-0.5">
        {frequency}
        {month}
        {day}
      </span>
    ),
    wallet: (
      <SelectCell
        label={`${name} の口座`}
        value={item.walletId ?? ""}
        options={withCurrent(
          item.walletId ? options.wallets : [{ value: "", label: "口座なし" }, ...options.wallets],
          item.walletId,
          item.walletName,
        )}
        onCommit={(value) => row.commit("walletId", value)}
      />
    ),
    account: (
      <SelectCell
        label={`${name} の科目`}
        value={item.accountId}
        options={withCurrent(options.accounts, item.accountId, item.accountLabel)}
        onCommit={(value) => row.commit("accountId", value)}
      />
    ),
    startDate,
    endDate,
    periodCell: (
      <span className="flex min-w-0 items-center gap-1">
        {startDate}
        <span aria-hidden="true" className="text-muted">
          –
        </span>
        {endDate}
      </span>
    ),
    partner: (
      <SelectCell
        label={`${name} の取引先`}
        value={item.partnerId ?? ""}
        options={none(activeOrCurrent(options.partners, item.partnerId))}
        onCommit={(value) => row.commit("partnerId", value)}
      />
    ),
    segment: (
      <SelectCell
        label={`${name} のセグメント`}
        value={item.segmentId ?? ""}
        options={none(activeOrCurrent(options.segments, item.segmentId))}
        onCommit={(value) => row.commit("segmentId", value)}
      />
    ),
    taxCategory: (
      <SelectCell
        label={`${name} の税区分`}
        value={item.taxCategoryCode ?? ""}
        options={none(withCurrent(options.taxOptions, item.taxCategoryCode, item.taxCategoryCode))}
        onCommit={(value) => row.commit("taxCategoryCode", value)}
      />
    ),
    note: (
      <TextCell
        label={`${name} のメモ`}
        value={item.note ?? ""}
        maxLength={500}
        onCommit={(value) => row.commit("note", value)}
      />
    ),
    active: (
      <span className="flex items-center gap-1">
        <ActiveToggleButton
          isActive={item.isActive}
          disabled={row.pending}
          onToggle={() =>
            row.run(
              () => setRecurringItemActiveAction(item.id, !item.isActive),
              activeToggledMessage(name, item.isActive),
            )
          }
        />
        {item.ended ? <span className="text-[12px] text-muted">終了</span> : null}
      </span>
    ),
  };
}

function RecurringItemRow({
  item,
  options,
  onOpen,
}: {
  item: RecurringRow;
  options: Options;
  onOpen: () => void;
}) {
  const row = useRowSave((patch) => updateRecurringItemAction(item.id, patch));
  const cell = cells(item, options, row);
  const open = (
    <OpenButton label={`${item.name} の詳細`} onClick={onOpen}>
      詳細
    </OpenButton>
  );
  return (
    <TableRow {...COLUMNS} muted={!item.isActive}>
      <Td>
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1">{cell.name}</span>
          <span className="shrink-0 md:hidden">{open}</span>
        </span>
      </Td>
      <Td>{cell.amountCell}</Td>
      <Td>{cell.cadenceCell}</Td>
      <Td>{cell.wallet}</Td>
      <Td sm="hide">{cell.account}</Td>
      <Td sm="hide">{cell.periodCell}</Td>
      <Td sm="hide">{cell.active}</Td>
      <Td sm="hide">{open}</Td>
      <SaveStatus status={row.status} />
    </TableRow>
  );
}

/** 詳細: every field, 取引先・セグメント・税区分・メモ included (phones edit everything here). */
function RecurringSheet({
  item,
  options,
  onClose,
}: {
  item: RecurringRow;
  options: Options;
  onClose: () => void;
}) {
  const row = useRowSave((patch) => updateRecurringItemAction(item.id, patch));
  const cell = cells(item, options, row);
  return (
    <Sheet open onClose={onClose} title={item.name} description="定期取引の詳細">
      <div className="mb-2 flex justify-end">
        <span className="max-w-[70%]">
          <SaveStatus asCell={false} status={row.status} />
        </span>
      </div>
      <SheetField label="名前">{cell.name}</SheetField>
      <SheetField label="入出金と金額（円）">{cell.amountCell}</SheetField>
      <SheetField label="周期と日">{cell.cadenceCell}</SheetField>
      <SheetField label="口座">{cell.wallet}</SheetField>
      <SheetField label="科目">{cell.account}</SheetField>
      <SheetField label="開始日">{cell.startDate}</SheetField>
      <SheetField label="終了日">{cell.endDate}</SheetField>
      <SheetField label="取引先">{cell.partner}</SheetField>
      <SheetField label="セグメント">{cell.segment}</SheetField>
      <SheetField label="税区分">{cell.taxCategory}</SheetField>
      <SheetField label="メモ">{cell.note}</SheetField>
      <SheetField label="状態">
        <span className="flex items-center gap-2">
          {item.isActive ? "有効" : "無効"}
          {cell.active}
        </span>
      </SheetField>
    </Sheet>
  );
}

const ADD_COLUMNS = {
  columns: "minmax(0,1.2fr) 200px 220px minmax(120px,0.9fr) minmax(140px,1fr) auto",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

/** 「追加」: 名前・入出金・金額・周期・日・口座・科目 (the start date is today, 21 §7). */
function AddRecurringRow({ options }: { options: Options }) {
  const toast = useToast();
  const [frequency, setFrequency] = useState("monthly");
  const { onSubmit, pending, error } = useFormSubmit(createRecurringItemAction, {
    onSuccess: () => {
      setFrequency("monthly");
      toast("定期取引を追加しました");
    },
  });
  return (
    <form
      onSubmit={onSubmit}
      role="row"
      aria-label="定期取引の追加"
      className="data-row bg-surface-2"
      style={gridStyle(ADD_COLUMNS)}
    >
      <input
        name="name"
        aria-label="名前"
        placeholder="名前（家賃など）"
        maxLength={60}
        autoComplete="off"
        className="cell-input"
      />
      <span className="flex min-w-0 items-center gap-0.5">
        <select
          name="direction"
          aria-label="入出金"
          defaultValue="withdrawal"
          className="cell-input w-[4.75rem] shrink-0"
        >
          {DIRECTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          name="amount"
          aria-label="金額（円）"
          placeholder="金額"
          inputMode="numeric"
          maxLength={17}
          autoComplete="off"
          className="cell-input num text-right"
        />
      </span>
      <span className="flex min-w-0 items-center gap-0.5">
        <select
          name="frequency"
          aria-label="周期"
          value={frequency}
          onChange={(event) => setFrequency(event.currentTarget.value)}
          className="cell-input w-[4.75rem] shrink-0"
        >
          {FREQUENCY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {frequency === "yearly" ? (
          <select
            name="monthOfYear"
            aria-label="月"
            defaultValue=""
            className="cell-input w-[4.5rem] shrink-0"
          >
            <option value="">月</option>
            {MONTH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        <select
          name="dayOfMonth"
          aria-label="日"
          defaultValue=""
          className="cell-input w-[4.75rem] shrink-0"
        >
          <option value="">日</option>
          {DAY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
      <select name="walletId" aria-label="口座" defaultValue="" className="cell-input">
        <option value="">口座</option>
        {options.wallets.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select name="accountId" aria-label="科目" defaultValue="" className="cell-input">
        <option value="">科目</option>
        {options.accounts.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="primary" disabled={pending}>
        追加
      </Button>
      <FormError error={error} className="col-span-full" />
    </form>
  );
}

export function RecurringTable({
  items,
  wallets,
  accounts,
  partners,
  segments,
  taxOptions,
}: {
  items: RecurringRow[];
} & Options) {
  const [showInactive, setShowInactive] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const options: Options = { wallets, accounts, partners, segments, taxOptions };
  const shown = items.filter((item) => item.isActive || showInactive);
  const inactiveCount = items.filter((item) => !item.isActive).length;
  const opened = items.find((item) => item.id === openId);

  return (
    <>
      <Table label="定期取引" minWidth={1320}>
        <TableHead {...COLUMNS}>
          <Th>名前</Th>
          <Th>入出金と金額（円）</Th>
          <Th>周期と日</Th>
          <Th>口座</Th>
          <Th sm="hide">科目</Th>
          <Th sm="hide">期間</Th>
          <Th sm="hide">状態</Th>
          <Th />
          <Th />
        </TableHead>
        {shown.length === 0 ? (
          <p className="px-4 py-5 text-[14px] text-muted">
            定期取引はまだありません。下の行から名前・金額・周期・日・口座・科目を入れて追加します。
          </p>
        ) : null}
        {shown.map((item) => (
          <RecurringItemRow
            key={item.id}
            item={item}
            options={options}
            onOpen={() => setOpenId(item.id)}
          />
        ))}
        <AddRecurringRow options={options} />
      </Table>
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
      {opened ? (
        <RecurringSheet
          key={opened.id}
          item={opened}
          options={options}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}
