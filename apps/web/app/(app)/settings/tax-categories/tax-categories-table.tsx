"use client";

import type { TaxCategorySettings, TaxRateRuleSettings } from "@niho-finance/db";
import { TAX_DIRECTION_LABELS } from "@niho-finance/ledger";
import { useId, useState } from "react";
import {
  InactiveToggle,
  SaveStatus,
  useFormSubmit,
  useRowStatus,
} from "@/components/settings/inline";
import { FormError, OpenButton } from "@/components/settings/row-parts";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatDate } from "@/lib/format";
import { createTaxRateRuleAction, setTaxRateRuleEnabledAction } from "../actions";

const COLUMNS = {
  columns: "minmax(0,1.6fr) 72px 88px 88px 64px 80px",
  mobileColumns: "minmax(0,1fr) auto",
};

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value}%`;
}

function isTaxablePurchase(category: TaxCategorySettings): boolean {
  return category.direction === "purchase" && category.kind === "taxable";
}

const RULE_COLUMNS = {
  columns: "minmax(0,1.4fr) 56px 64px 56px",
  mobileColumns: "minmax(0,1fr) auto",
};

function RuleRow({ rule }: { rule: TaxRateRuleSettings }) {
  const { status, run, pending } = useRowStatus();
  return (
    <TableRow {...RULE_COLUMNS} muted={!rule.enabled}>
      <Td>
        <span className="num">
          {formatDate(rule.effectiveFrom)} – {rule.effectiveTo ? formatDate(rule.effectiveTo) : ""}
        </span>
        {rule.note ? <span className="block text-[11px] text-muted">{rule.note}</span> : null}
        {status.state === "error" || status.state === "saving" ? (
          <span className="block">
            <SaveStatus asCell={false} status={status} />
          </span>
        ) : null}
      </Td>
      <Td align="right" sm="hide">
        {percent(rule.ratePercent)}
      </Td>
      <Td align="right" sm="hide">
        {percent(rule.deductiblePercent)}
      </Td>
      <Td>
        <Switch
          checked={rule.enabled}
          label={`${formatDate(rule.effectiveFrom)} からの規則を${rule.enabled ? "無効" : "有効"}にする`}
          disabled={pending}
          onCheckedChange={(enabled) => run(() => setTaxRateRuleEnabledAction(rule.id, enabled))}
        />
      </Td>
      <Td sm="full" className="text-[12px] text-muted md:hidden">
        税率 {percent(rule.ratePercent)} · 控除割合 {percent(rule.deductiblePercent)}
      </Td>
    </TableRow>
  );
}

function RulesSheet({ category, onClose }: { category: TaxCategorySettings; onClose: () => void }) {
  const id = useId();
  const toast = useToast();
  const [showDisabled, setShowDisabled] = useState(true);
  const purchase = isTaxablePurchase(category);
  const add = useFormSubmit((formData) => createTaxRateRuleAction(category.code, formData), {
    onSuccess: () => toast("税率規則を追加しました"),
  });
  const fieldError = (name: string) => add.error?.fieldErrors[name];
  const disabledCount = category.rules.filter((rule) => !rule.enabled).length;
  const rules = category.rules.filter((rule) => rule.enabled || showDisabled);

  return (
    <Sheet
      open
      onClose={onClose}
      title={category.name}
      description="税率規則（適用期間・税率・控除割合）"
    >
      <Table label={`${category.name} の税率規則`}>
        <TableHead {...RULE_COLUMNS}>
          <Th>適用期間</Th>
          <Th align="right">税率</Th>
          <Th align="right">控除割合</Th>
          <Th>有効</Th>
        </TableHead>
        {rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} />
        ))}
      </Table>
      <InactiveToggle
        count={disabledCount}
        open={showDisabled}
        onToggle={() => setShowDisabled(!showDisabled)}
      />
      <p className="mt-2 text-[12px] text-muted">
        期間が重なるときは開始が遅い規則が使われます。既存の規則の数値は変えられません。誤りは新しい規則を追加し、古い規則を無効にして直します。
      </p>

      <form
        onSubmit={add.onSubmit}
        className="mt-5 flex flex-col gap-3 border-t border-border pt-4"
      >
        <h3 className="text-[13px] font-bold text-muted">規則を追加</h3>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="適用の開始日"
            htmlFor={`${id}-from`}
            required
            error={fieldError("effectiveFrom")}
          >
            <Input id={`${id}-from`} name="effectiveFrom" type="date" required />
          </FormField>
          <FormField
            label="適用の終了日"
            htmlFor={`${id}-to`}
            help="空欄は期限なし"
            error={fieldError("effectiveTo")}
          >
            <Input id={`${id}-to`} name="effectiveTo" type="date" />
          </FormField>
          <FormField
            label="税率（%）"
            htmlFor={`${id}-rate`}
            required
            error={fieldError("ratePercent")}
          >
            <Input
              id={`${id}-rate`}
              name="ratePercent"
              inputMode="numeric"
              defaultValue={category.kind === "taxable" ? "" : "0"}
              autoComplete="off"
            />
          </FormField>
          {purchase ? (
            <FormField
              label="控除割合（%）"
              htmlFor={`${id}-deductible`}
              required
              help="インボイスなしは経過措置の割合"
              error={fieldError("deductiblePercent")}
            >
              <Input
                id={`${id}-deductible`}
                name="deductiblePercent"
                inputMode="numeric"
                defaultValue="100"
                autoComplete="off"
              />
            </FormField>
          ) : null}
        </div>
        <FormField label="メモ" htmlFor={`${id}-note`} error={fieldError("note")}>
          <Input id={`${id}-note`} name="note" maxLength={200} placeholder="根拠や法令名など" />
        </FormField>
        {add.error && Object.keys(add.error.fieldErrors).length === 0 ? (
          <FormError error={add.error} />
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={add.pending}>
            {add.pending ? "追加中…" : "追加"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export function TaxCategoriesTable({ categories }: { categories: TaxCategorySettings[] }) {
  const [openCode, setOpenCode] = useState<string | null>(null);
  const opened = categories.find((category) => category.code === openCode);
  return (
    <>
      <Table label="税区分">
        <TableHead {...COLUMNS}>
          <Th>表示名</Th>
          <Th sm="hide">方向</Th>
          <Th align="right">税率</Th>
          <Th align="right">控除割合</Th>
          <Th sm="hide">状態</Th>
          <Th />
        </TableHead>
        {categories.map((category) => (
          <TableRow key={category.id} {...COLUMNS} muted={!category.isActive}>
            <Td className="font-bold">{category.name}</Td>
            <Td sm="hide" className="text-muted">
              {TAX_DIRECTION_LABELS[category.direction]}
            </Td>
            <Td align="right" sm="hide">
              {percent(category.current?.ratePercent)}
            </Td>
            <Td align="right" sm="hide">
              {percent(category.current?.deductiblePercent)}
            </Td>
            <Td sm="hide" className="text-muted">
              {category.isActive ? "有効" : "無効"}
            </Td>
            <Td>
              <OpenButton
                label={`${category.name} の税率規則`}
                onClick={() => setOpenCode(category.code)}
              >
                規則 <span className="num">{category.rules.length}</span>
              </OpenButton>
            </Td>
            <Td sm="full" className="text-[12px] text-muted md:hidden">
              {TAX_DIRECTION_LABELS[category.direction]} · 税率{" "}
              {percent(category.current?.ratePercent)}
              {isTaxablePurchase(category)
                ? ` · 控除割合 ${percent(category.current?.deductiblePercent)}`
                : ""}
            </Td>
          </TableRow>
        ))}
      </Table>
      <p className="mt-2 text-[12px] text-muted">
        税区分は申告書の集計区分なので追加・名前の変更はできません。税率と控除割合は期間つきの規則で持ちます。
      </p>
      {opened ? (
        <RulesSheet key={opened.code} category={opened} onClose={() => setOpenCode(null)} />
      ) : null}
    </>
  );
}
