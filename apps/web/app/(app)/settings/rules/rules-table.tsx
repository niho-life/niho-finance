"use client";

import { useState } from "react";
import { InactiveToggle } from "@/components/settings/inline";
import { OpenButton } from "@/components/settings/row-parts";
import { Button } from "@/components/ui/button";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { RuleSheet } from "./rule-sheet";
import { emptyRuleValues, type ClientRule, type RuleSheetOptions } from "./rule-values";

const COLUMNS = {
  columns: "minmax(0,1.1fr) minmax(0,0.8fr) minmax(0,1.6fr) minmax(0,1.5fr) 44px 56px 96px 64px",
  mobileColumns: "minmax(0,1fr) auto",
};

/** 「12 回 · 01/05」: how often the rule settled or filled a line, and when last (JST). */
function applied(rule: ClientRule): string {
  if (rule.hitCount === 0) return "—";
  const last = rule.lastHitAt ? ` · ${formatDateTime(rule.lastHitAt).slice(5, 10)}` : "";
  return `${rule.hitCount.toLocaleString("ja-JP")} 回${last}`;
}

/**
 * 設定 › ルール (15 §10): 名前 · 口座 · 条件 · 動作 · 自動 · 優先度 · 適用, the highest priority first.
 * Inactive rules are folded; rules are never deleted. 「ルールを追加」 and 編集 open the Sheet.
 */
export function RulesTable({ rules, options }: { rules: ClientRule[]; options: RuleSheetOptions }) {
  const [showInactive, setShowInactive] = useState(false);
  /** `"new"`, a rule id, or `null` when the Sheet is closed. */
  const [editing, setEditing] = useState<string | null>(null);
  const shown = rules.filter((rule) => rule.isActive || showInactive);
  const inactiveCount = rules.filter((rule) => !rule.isActive).length;
  const edited = rules.find((rule) => rule.id === editing) ?? null;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">
          明細の推定に使います。自動のルールは取込時に一致した明細を片付けます。
        </p>
        <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
          ルールを追加
        </Button>
      </div>
      {shown.length > 0 ? (
        <Table label="ルール">
          <TableHead {...COLUMNS}>
            <Th>名前</Th>
            <Th sm="hide">口座</Th>
            <Th>条件</Th>
            <Th sm="hide">動作</Th>
            <Th sm="hide">自動</Th>
            <Th sm="hide" align="right">
              優先度
            </Th>
            <Th sm="hide">適用</Th>
            <Th />
          </TableHead>
          {shown.map((rule) => (
            <TableRow key={rule.id} {...COLUMNS} muted={!rule.isActive}>
              <Td className="font-bold">
                <span className="break-words">{rule.displayName}</span>
                {rule.isActive ? null : (
                  <span className="ml-2 text-[11px] font-normal text-muted-2">無効</span>
                )}
                {rule.valid ? null : (
                  <span className="block text-[12px] font-bold text-danger">
                    条件か動作を読めません。編集して保存し直してください
                  </span>
                )}
              </Td>
              <Td sm="hide" className="text-muted">
                {rule.walletName ?? "すべて"}
              </Td>
              <Td sm="full" className="text-[13px] break-words text-muted">
                {rule.matchSummary}
                <span className="block text-text md:hidden">
                  {rule.actionSummary}
                  {rule.autoPost ? " · 自動" : ""}
                  {rule.walletName ? ` · ${rule.walletName}` : ""}
                </span>
              </Td>
              <Td sm="hide" className="text-[13px] break-words">
                {rule.actionSummary}
              </Td>
              <Td sm="hide" className="text-muted">
                <span aria-hidden="true">{rule.autoPost ? "○" : "—"}</span>
                <span className="sr-only">
                  {rule.autoPost ? "自動で登録する" : "自動で登録しない"}
                </span>
              </Td>
              <Td sm="hide" align="right">
                {rule.priority}
              </Td>
              <Td sm="hide" className="num text-[13px] text-muted">
                {applied(rule)}
              </Td>
              <Td>
                <OpenButton
                  label={`${rule.displayName} を編集`}
                  onClick={() => setEditing(rule.id)}
                >
                  編集
                </OpenButton>
              </Td>
            </TableRow>
          ))}
        </Table>
      ) : rules.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
          ルールがありません。明細の行で R（ルールにする）を押すか、ここから追加します。
        </p>
      ) : null}
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
      {editing ? (
        <RuleSheet
          key={editing}
          rule={edited}
          initial={emptyRuleValues()}
          options={options}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
