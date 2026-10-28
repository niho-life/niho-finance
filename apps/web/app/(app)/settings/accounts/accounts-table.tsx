"use client";

import type { AccountSettings, SelectOption, SubAccountSettings } from "@niho-finance/db";
import {
  ACCOUNT_GROUP_LABELS,
  ACCOUNT_GROUPS_BY_KIND,
  ACCOUNT_KIND_LABELS,
  ACCOUNT_KINDS,
  accountKindForCode,
  type AccountGroup,
  type AccountKind,
} from "@niho-finance/ledger";
import { useState } from "react";
import {
  activeToggledMessage,
  CheckboxCell,
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
import { gridStyle, Table, TableGroup, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  createAccountAction,
  createSubAccountAction,
  setAccountActiveAction,
  setSubAccountActiveAction,
  updateAccountAction,
  updateSubAccountAction,
} from "../actions";

const COLUMNS = {
  columns: "52px minmax(0,1.4fr) 150px 180px 60px 96px 104px minmax(72px,130px)",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

function groupOptions(kind: AccountKind) {
  return ACCOUNT_GROUPS_BY_KIND[kind].map((group) => ({
    value: group,
    label: ACCOUNT_GROUP_LABELS[group],
  }));
}

function taxSelectOptions(taxOptions: readonly SelectOption[]) {
  return [{ value: "", label: "なし" }, ...taxOptions];
}

function AccountRow({
  account,
  taxOptions,
  onOpen,
}: {
  account: AccountSettings;
  taxOptions: readonly SelectOption[];
  onOpen: () => void;
}) {
  const { status, commit, run, pending } = useRowSave((patch) =>
    updateAccountAction(account.id, patch),
  );
  return (
    <TableRow {...COLUMNS} muted={!account.isActive}>
      <Td sm="hide" className="num text-muted">
        {account.code}
      </Td>
      <Td>
        <span className="num block px-[7px] text-[11px] text-muted-2 md:hidden">
          {account.code}
        </span>
        <TextCell
          label={`${account.code} の名前`}
          value={account.name}
          maxLength={100}
          onCommit={(value) => commit("name", value)}
        />
      </Td>
      <Td sm="hide">
        <SelectCell
          label={`${account.code} の決算書の区分`}
          value={account.group}
          options={groupOptions(account.kind)}
          onCommit={(value) => commit("group", value)}
        />
      </Td>
      <Td>
        <SelectCell
          label={`${account.code} の既定の税区分`}
          value={account.defaultTaxCategoryCode ?? ""}
          options={taxSelectOptions(taxOptions)}
          onCommit={(value) => commit("defaultTaxCategoryCode", value)}
        />
      </Td>
      <Td sm="hide" className="text-center">
        {account.kind === "asset" ? (
          <CheckboxCell
            label={`${account.code} を現預金にする`}
            checked={account.isCashLike}
            onCommit={(value) => commit("isCashLike", value)}
          />
        ) : (
          <span className="text-muted-2">—</span>
        )}
      </Td>
      <Td>
        <OpenButton label={`${account.code} ${account.name} の補助科目と詳細`} onClick={onOpen}>
          <span className="md:hidden">補助科目</span>
          <span className="num">{account.subAccountCount}</span>
        </OpenButton>
      </Td>
      <Td sm="hide">
        <ActiveToggleButton
          isActive={account.isActive}
          disabled={pending}
          onToggle={() =>
            run(
              () => setAccountActiveAction(account.id, !account.isActive),
              activeToggledMessage(account.name, account.isActive),
            )
          }
        />
      </Td>
      <SaveStatus status={status} />
    </TableRow>
  );
}

const SUB_COLUMNS = {
  columns: "minmax(0,1fr) auto minmax(64px,110px)",
  mobileColumns: "minmax(0,1fr) auto",
};

function SubAccountRow({ subAccount }: { subAccount: SubAccountSettings }) {
  const { status, commit, run, pending } = useRowSave((patch) =>
    updateSubAccountAction(subAccount.id, patch),
  );
  return (
    <TableRow {...SUB_COLUMNS} muted={!subAccount.isActive}>
      <Td>
        {subAccount.walletName ? (
          <span className="block px-[7px]">
            {subAccount.name}
            <span className="block text-[11px] text-muted-2">
              口座「{subAccount.walletName}」の補助科目（名前と状態は口座で変えます）
            </span>
          </span>
        ) : (
          <TextCell
            label="補助科目の名前"
            value={subAccount.name}
            maxLength={100}
            onCommit={(value) => commit("name", value)}
          />
        )}
      </Td>
      <Td>
        {subAccount.walletName ? null : (
          <ActiveToggleButton
            isActive={subAccount.isActive}
            disabled={pending}
            onToggle={() =>
              run(
                () => setSubAccountActiveAction(subAccount.id, !subAccount.isActive),
                activeToggledMessage(subAccount.name, subAccount.isActive),
              )
            }
          />
        )}
      </Td>
      <SaveStatus status={status} />
    </TableRow>
  );
}

/** The row opened: every column of the account (phones show only 3) and its sub-accounts. */
function AccountSheet({
  account,
  subAccounts,
  taxOptions,
  onClose,
}: {
  account: AccountSettings;
  subAccounts: SubAccountSettings[];
  taxOptions: readonly SelectOption[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [showInactive, setShowInactive] = useState(false);
  const { status, commit, run, pending } = useRowSave((patch) =>
    updateAccountAction(account.id, patch),
  );
  const add = useFormSubmit((formData) => createSubAccountAction(account.id, formData), {
    onSuccess: () => toast("補助科目を追加しました"),
  });
  const inactive = subAccounts.filter((sub) => !sub.isActive);
  const shown = subAccounts.filter((sub) => sub.isActive || showInactive);

  return (
    <Sheet
      open
      onClose={onClose}
      title={`${account.code} ${account.name}`}
      description={`${ACCOUNT_KIND_LABELS[account.kind]} · ${ACCOUNT_GROUP_LABELS[account.group]}${
        account.walletNames.length > 0 ? ` · 口座: ${account.walletNames.join("、")}` : ""
      }`}
    >
      <section className="mb-6">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[13px] font-bold text-muted">科目</h3>
          <span className="max-w-[60%]">
            <SaveStatus asCell={false} status={status} />
          </span>
        </div>
        <SheetField label="名前">
          <TextCell
            label="名前"
            value={account.name}
            maxLength={100}
            onCommit={(value) => commit("name", value)}
          />
        </SheetField>
        <SheetField label="決算書の区分">
          <SelectCell
            label="決算書の区分"
            value={account.group}
            options={groupOptions(account.kind)}
            onCommit={(value) => commit("group", value)}
          />
        </SheetField>
        <SheetField label="既定の税区分">
          <SelectCell
            label="既定の税区分"
            value={account.defaultTaxCategoryCode ?? ""}
            options={taxSelectOptions(taxOptions)}
            onCommit={(value) => commit("defaultTaxCategoryCode", value)}
          />
        </SheetField>
        {account.kind === "asset" ? (
          <SheetField label="現預金">
            <CheckboxCell
              label="現預金"
              checked={account.isCashLike}
              onCommit={(value) => commit("isCashLike", value)}
            />
          </SheetField>
        ) : null}
        <SheetField label="状態">
          <span className="flex items-center gap-2">
            <span>{account.isActive ? "有効" : "無効"}</span>
            <ActiveToggleButton
              isActive={account.isActive}
              disabled={pending}
              onToggle={() =>
                run(
                  () => setAccountActiveAction(account.id, !account.isActive),
                  activeToggledMessage(account.name, account.isActive),
                )
              }
            />
          </span>
        </SheetField>
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-bold text-muted">補助科目</h3>
        {shown.length > 0 ? (
          <Table label="補助科目">
            {shown.map((sub) => (
              <SubAccountRow key={sub.id} subAccount={sub} />
            ))}
          </Table>
        ) : (
          <p className="text-[13px] text-muted">
            補助科目はありません。口座や取引先ごとに分けたいときに追加します。
          </p>
        )}
        <InactiveToggle
          count={inactive.length}
          open={showInactive}
          onToggle={() => setShowInactive(!showInactive)}
        />
        <form onSubmit={add.onSubmit} className="mt-3 flex flex-wrap items-start gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">追加する補助科目の名前</span>
            <input
              name="name"
              className="control"
              placeholder="補助科目の名前"
              maxLength={100}
              autoComplete="off"
            />
          </label>
          <Button type="submit" disabled={add.pending}>
            追加
          </Button>
          <FormError error={add.error} className="w-full" />
        </form>
      </section>
    </Sheet>
  );
}

function AddAccountRow() {
  const toast = useToast();
  const [kind, setKind] = useState<AccountKind>("expense");
  const [group, setGroup] = useState<AccountGroup>("sga");
  const { onSubmit, pending, error } = useFormSubmit(createAccountAction, {
    onSuccess: () => toast("勘定科目を追加しました"),
  });

  function chooseKind(next: AccountKind) {
    setKind(next);
    setGroup(ACCOUNT_GROUPS_BY_KIND[next][0] ?? group);
  }

  return (
    <form
      onSubmit={onSubmit}
      role="row"
      aria-label="勘定科目の追加"
      className="data-row bg-surface-2"
      style={gridStyle({
        columns: "80px minmax(0,1.4fr) 110px 170px auto",
        mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
      })}
    >
      <input
        name="code"
        aria-label="コード（4 桁）"
        placeholder="コード"
        inputMode="numeric"
        maxLength={4}
        autoComplete="off"
        className="cell-input num"
        onChange={(event) => {
          const next = accountKindForCode(event.currentTarget.value);
          if (next && next !== kind) chooseKind(next);
        }}
      />
      <input
        name="name"
        aria-label="名前"
        placeholder="名前"
        maxLength={100}
        autoComplete="off"
        className="cell-input"
      />
      <select
        name="kind"
        aria-label="種類"
        className="cell-input"
        value={kind}
        onChange={(event) => chooseKind(event.currentTarget.value as AccountKind)}
      >
        {ACCOUNT_KINDS.map((value) => (
          <option key={value} value={value}>
            {ACCOUNT_KIND_LABELS[value]}
          </option>
        ))}
      </select>
      <select
        name="group"
        aria-label="決算書の区分"
        className="cell-input"
        value={group}
        onChange={(event) => setGroup(event.currentTarget.value as AccountGroup)}
      >
        {groupOptions(kind).map((option) => (
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

export function AccountsTable({
  accounts,
  subAccounts,
  taxOptions,
}: {
  accounts: AccountSettings[];
  subAccounts: SubAccountSettings[];
  taxOptions: SelectOption[];
}) {
  const [showInactive, setShowInactive] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = accounts.find((account) => account.id === openId);
  const inactiveCount = accounts.filter((account) => !account.isActive).length;

  return (
    <>
      <Table label="勘定科目">
        <TableHead {...COLUMNS}>
          <Th>コード</Th>
          <Th>名前</Th>
          <Th sm="hide">決算書の区分</Th>
          <Th>既定の税区分</Th>
          <Th sm="hide">現預金</Th>
          <Th>補助科目</Th>
          <Th sm="hide">状態</Th>
          <Th />
        </TableHead>
        {ACCOUNT_KINDS.map((kind) => {
          const rows = accounts.filter(
            (account) => account.kind === kind && (account.isActive || showInactive),
          );
          if (rows.length === 0) return null;
          return (
            <div key={kind} role="rowgroup">
              <TableGroup>{ACCOUNT_KIND_LABELS[kind]}</TableGroup>
              {rows.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  taxOptions={taxOptions}
                  onOpen={() => setOpenId(account.id)}
                />
              ))}
            </div>
          );
        })}
        <AddAccountRow />
      </Table>
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
      <p className="mt-2 text-[12px] text-muted">
        コードは 4 桁（1 資産・2 負債・3 純資産・4 収益・5〜8 費用・9
        内部）。削除はできず、使わない科目は無効にします。
      </p>
      {opened ? (
        <AccountSheet
          key={opened.id}
          account={opened}
          subAccounts={subAccounts.filter((sub) => sub.accountId === opened.id)}
          taxOptions={taxOptions}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}
