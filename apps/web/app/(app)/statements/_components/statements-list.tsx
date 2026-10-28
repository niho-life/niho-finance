"use client";

import type { StatementStatusFilter } from "@niho-finance/db";
import { displayDate, formatYen } from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import type { ActionError, ActionResult } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { RuleSheet } from "../../settings/rules/rule-sheet";
import { emptyRuleValues, type RuleFormValues } from "../../settings/rules/rule-values";
import {
  ignoreStatementAction,
  registerStatementAction,
  reopenStatementAction,
  transferStatementAction,
  type SettledStatement,
} from "../actions";
import { SEARCH_INPUT_ID } from "./filter-bar";
import {
  amountOf,
  buildLookups,
  initialDraft,
  primaryPlan,
  registerInput,
  reversalDateOf,
  ruleKeyText,
  type ChipField,
  type ClientStatementRow,
  type RowDraft,
  type StatementOptions,
} from "./model";
import { EditDialog, IgnoreDialog, NoteDialog, TransferDialog } from "./row-dialogs";
import type { MenuItem } from "./row-menu";
import { SplitDialog } from "./split-dialog";
import { StatementDocumentsSheet } from "./statement-documents";
import { StatementRowView, type RowHandlers } from "./statement-row";
import { UndoBar, type UndoState } from "./undo-bar";

type DialogState =
  | { kind: "edit"; rowId: string; focus: ChipField }
  | { kind: "transfer"; rowId: string }
  | { kind: "split"; rowId: string; draft: RowDraft }
  | { kind: "note"; rowId: string }
  | { kind: "documents"; rowId: string }
  | { kind: "ignore"; rowId: string }
  | { kind: "reopen"; rowId: string }
  | { kind: "bulkRegister" }
  | { kind: "bulkIgnore" };

const UNDO_REASON = "登録直後の取消";

function without<T>(record: Record<string, T>, ids: Iterable<string>): Record<string, T> {
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/**
 * The rows of /statements and everything done to them in the browser (15 §5–§7): the drafts of the
 * chips, the selection, the dialogs, the keyboard, the optimistic hiding of settled rows and the
 * 5-second undo. Reads come from the server (`router.refresh()` after each write); writes are
 * Server Actions run one at a time, in order.
 */
export function StatementsList({
  rows,
  status,
  options,
  thisYear,
  empty,
}: {
  rows: ClientStatementRow[];
  status: StatementStatusFilter;
  options: StatementOptions;
  thisYear: number;
  /** Shown when no row is left. */
  empty: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const lookups = useMemo(() => buildLookups(options), [options]);
  const pendingTab = status === "pending";

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const hiddenRef = useRef<Set<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, ActionError>>({});
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [ruleFor, setRuleFor] = useState<{ rowId: string; initial: RuleFormValues } | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogPending, startDialog] = useTransition();
  const [bulkPending, setBulkPending] = useState(false);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /** The row to focus after the next render (it may only appear after a refresh). */
  const focusTarget = useRef<string | null>(pendingTab ? (rows[0]?.id ?? null) : null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const undoKey = useRef(0);

  const visible = rows.filter((row) => !hidden.has(row.id));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const current = visible.some((row) => row.id === currentId)
    ? currentId
    : (visible[0]?.id ?? null);
  const draftOf = (row: ClientStatementRow): RowDraft => drafts[row.id] ?? initialDraft(row);

  // Focus follows the work: the next row after a settle, the row a dialog was opened from.
  useEffect(() => {
    const id = focusTarget.current;
    if (!id) return;
    const element = rowRefs.current.get(id);
    if (!element || document.querySelector("dialog[open]")) return;
    focusTarget.current = null;
    element.focus();
  });

  function focusRow(id: string | null) {
    focusTarget.current = id;
    if (id) setCurrentId(id);
    const element = id ? rowRefs.current.get(id) : undefined;
    if (element && !document.querySelector("dialog[open]")) {
      focusTarget.current = null;
      element.focus();
    }
  }

  function enqueue(task: () => Promise<void>) {
    queue.current = queue.current.then(task, task);
  }

  function hide(ids: readonly string[]) {
    for (const id of ids) hiddenRef.current.add(id);
    setHidden(new Set(hiddenRef.current));
  }

  function unhide(ids: readonly string[]) {
    for (const id of ids) hiddenRef.current.delete(id);
    setHidden(new Set(hiddenRef.current));
  }

  /** The row that takes the focus when `removing` leave: the next one, else the previous one. */
  function nextAfter(anchorId: string, removing: ReadonlySet<string>): string | null {
    const list = rows.filter((row) => !hiddenRef.current.has(row.id));
    const at = list.findIndex((row) => row.id === anchorId);
    for (let index = at + 1; index < list.length; index += 1) {
      const row = list[index];
      if (row && !removing.has(row.id)) return row.id;
    }
    for (let index = at - 1; index >= 0; index -= 1) {
      const row = list[index];
      if (row && !removing.has(row.id)) return row.id;
    }
    return null;
  }

  function showUndo(message: string, groups: UndoState["groups"]) {
    undoKey.current += 1;
    setUndo({ key: undoKey.current, message, groups });
  }

  function closeDialog(rowId?: string) {
    setDialog(null);
    setReason("");
    setDialogError(null);
    focusRow(rowId ?? current);
  }

  // -------------------------------------------------------------------------
  // Settling a row: hidden at once, the focus on the next row, the server after the earlier ones.
  // -------------------------------------------------------------------------

  function settle(
    row: ClientStatementRow,
    run: () => Promise<ActionResult<SettledStatement>>,
    message: (data: SettledStatement) => string,
    alsoHide: readonly string[] = [],
  ) {
    const ids = [row.id, ...alsoHide].filter((id) => rowById.has(id) && !hiddenRef.current.has(id));
    if (!ids.includes(row.id)) return;
    const removing = new Set(ids);
    const next = nextAfter(row.id, removing);
    setErrors((current) => without(current, [row.id]));
    setSelected((current) => new Set([...current].filter((id) => !removing.has(id))));
    hide(ids);
    focusRow(next);
    enqueue(async () => {
      const result = await run();
      if (!result.ok) {
        unhide(ids);
        setErrors((current) => ({ ...current, [row.id]: result }));
        focusRow(row.id);
        return;
      }
      hide(result.data.transactionIds);
      const [first] = result.data.transactionIds;
      if (first) {
        showUndo(message(result.data), [{ id: first, ids: result.data.transactionIds }]);
      }
      router.refresh();
    });
  }

  const registered = (data: SettledStatement) =>
    data.entry ? `${entryNo(data.entry.no)} を登録しました` : "登録しました";
  const transferred = (data: SettledStatement) => {
    const no = data.entry ? `（${entryNo(data.entry.no)}）` : "";
    return data.transactionIds.length > 1
      ? `${data.transactionIds.length} 件を振替にしました${no}`
      : `振替にしました${no}`;
  };

  function register(row: ClientStatementRow, draft: RowDraft) {
    settle(row, () => registerStatementAction(row.id, registerInput(row, draft)), registered);
  }

  function transfer(
    row: ClientStatementRow,
    draft: RowDraft,
    input: { counterpart: string; fee: string },
  ) {
    const fromRule =
      !draft.edited &&
      row.suggestion?.source === "rule" &&
      row.suggestion.mode === "transfer" &&
      (input.counterpart === draft.counterpart ||
        input.counterpart === `wallet:${draft.transferToWalletId}`);
    const alsoHide = input.counterpart.startsWith("txn:")
      ? [input.counterpart.slice("txn:".length)]
      : [];
    settle(
      row,
      () =>
        transferStatementAction(row.id, {
          counterpart: input.counterpart,
          fee: input.fee,
          ruleId: fromRule ? (row.suggestion?.ruleId ?? "") : "",
        }),
      transferred,
      alsoHide,
    );
  }

  function ignore(row: ClientStatementRow, reasonText: string, ruleId = "") {
    settle(
      row,
      () => ignoreStatementAction(row.id, { reason: reasonText, ruleId }),
      () => "無視しました",
    );
  }

  /** Enter / the primary button (15 §5). */
  function primary(row: ClientStatementRow) {
    const draft = draftOf(row);
    const plan = primaryPlan(row, draft);
    switch (plan.kind) {
      case "register":
        register(row, draft);
        return;
      case "edit":
        setDialog({ kind: "edit", rowId: row.id, focus: "account" });
        return;
      case "transfer":
        transfer(row, draft, { counterpart: plan.counterpart, fee: "" });
        return;
      case "transferDialog":
        setDialog({ kind: "transfer", rowId: row.id });
        return;
      case "ignore": {
        const byRule = !draft.edited && row.suggestion?.mode === "ignore";
        ignore(row, draft.ignoredReason, byRule ? (row.suggestion?.ruleId ?? "") : "");
        return;
      }
    }
  }

  /** The ghost button: 無視, or 登録 when the primary is 無視. */
  function secondary(row: ClientStatementRow) {
    const draft = draftOf(row);
    if (draft.mode !== "ignore" && amountOf(row) !== 0n) {
      ignore(row, "");
      return;
    }
    if (draft.accountId) register(row, { ...draft, mode: "register" });
    else setDialog({ kind: "edit", rowId: row.id, focus: "account" });
  }

  function openRule(row: ClientStatementRow, draft: RowDraft) {
    const candidate = row.candidates.find(
      (item) => `${item.kind}:${item.id}` === draft.counterpart,
    );
    setDialog(null);
    setRuleFor({
      rowId: row.id,
      initial: {
        ...emptyRuleValues(),
        walletId: row.walletId,
        descriptionContains: ruleKeyText(row.descriptionRaw),
        sign: amountOf(row) < 0n ? "out" : "in",
        mode: draft.mode,
        accountId: draft.mode === "register" ? draft.accountId : "",
        taxCategoryCode: draft.mode === "register" ? draft.taxCategoryCode : "",
        partnerId: draft.mode === "register" ? draft.partnerId : "",
        segmentId: draft.mode === "register" ? draft.segmentId : "",
        transferToWalletId:
          draft.mode === "transfer" ? (candidate?.walletId ?? draft.transferToWalletId) : "",
        ignoredReason: draft.mode === "ignore" ? draft.ignoredReason : "",
        autoPost: false,
      },
    });
  }

  function toggle(row: ClientStatementRow) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // The keyboard (15 §6)
  // -------------------------------------------------------------------------

  function onRowKey(event: KeyboardEvent<HTMLDivElement>, row: ClientStatementRow) {
    if (event.target !== event.currentTarget) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const at = visible.findIndex((item) => item.id === row.id);
      const target = visible[key === "ArrowDown" ? at + 1 : at - 1];
      if (target) focusRow(target.id);
      return;
    }
    if (row.status !== "pending") return;
    const draft = draftOf(row);
    switch (key.toLowerCase()) {
      case "enter":
        event.preventDefault();
        primary(row);
        return;
      case "i":
        event.preventDefault();
        ignore(row, "");
        return;
      case "t":
        event.preventDefault();
        setDialog({ kind: "transfer", rowId: row.id });
        return;
      case "e":
        event.preventDefault();
        setDialog({ kind: "edit", rowId: row.id, focus: "account" });
        return;
      case "r":
        event.preventDefault();
        openRule(row, draft);
        return;
      case " ":
        event.preventDefault();
        toggle(row);
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // 5 秒の取消 (15 §7)
  // -------------------------------------------------------------------------

  function performUndo(state: UndoState) {
    setUndo(null);
    enqueue(async () => {
      const reversals: number[] = [];
      const reopened: string[] = [];
      let failure: string | null = null;
      for (const group of state.groups) {
        const result = await reopenStatementAction(group.id, { reason: UNDO_REASON });
        if (result.ok) {
          reopened.push(...result.data.reopenedIds);
          if (result.data.reversal) reversals.push(result.data.reversal.no);
        } else {
          failure = result.error;
        }
      }
      unhide(state.groups.flatMap((group) => group.ids));
      if (failure) toast(failure, { tone: "error" });
      else if (reversals.length > 0) {
        toast(`取り消しました（反対仕訳 ${reversals.map(entryNo).join("・")}）`);
      } else toast("取り消しました");
      const [first] = reopened;
      if (first) focusRow(first);
      router.refresh();
    });
  }

  // `/` focuses the search and Z undoes, anywhere outside the fields and the dialogs.
  const onGlobalKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (isTyping(event.target) || document.querySelector("dialog[open]")) return;
    if (event.key === "/") {
      event.preventDefault();
      document.getElementById(SEARCH_INPUT_ID)?.focus();
    } else if ((event.key === "z" || event.key === "Z") && undo) {
      event.preventDefault();
      performUndo(undo);
    }
  });

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onGlobalKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // -------------------------------------------------------------------------
  // 複数選択 (15 §5)
  // -------------------------------------------------------------------------

  const chosen = visible.filter((row) => selected.has(row.id));
  const bulk = chosen.map((row) => ({ row, plan: primaryPlan(row, draftOf(row)) }));
  const runnable = bulk.filter(
    (item) =>
      item.plan.kind === "register" || item.plan.kind === "transfer" || item.plan.kind === "ignore",
  );
  const skipped = bulk.length - runnable.length;
  const totalOf = (items: readonly { row: ClientStatementRow }[], sign: 1 | -1) =>
    items.reduce((sum, { row }) => {
      const amount = amountOf(row);
      return sign > 0 ? (amount > 0n ? sum + amount : sum) : amount < 0n ? sum - amount : sum;
    }, 0n);

  function runBulk(kind: "register" | "ignore") {
    const items = kind === "register" ? runnable : bulk;
    const skippedCount = kind === "register" ? skipped : 0;
    setBulkPending(true);
    enqueue(async () => {
      const done = new Set<string>();
      const groups: UndoState["groups"] = [];
      for (const { row, plan } of items) {
        if (done.has(row.id)) continue;
        const draft = draftOf(row);
        let result: ActionResult<SettledStatement>;
        if (kind === "ignore" || plan.kind === "ignore") {
          result = await ignoreStatementAction(row.id, {
            reason: kind === "ignore" ? "" : draft.ignoredReason,
          });
        } else if (plan.kind === "transfer") {
          result = await transferStatementAction(row.id, { counterpart: plan.counterpart });
        } else {
          result = await registerStatementAction(row.id, registerInput(row, draft));
        }
        if (result.ok) {
          for (const id of result.data.transactionIds) done.add(id);
          const [first] = result.data.transactionIds;
          if (first) groups.push({ id: first, ids: result.data.transactionIds });
          hide(result.data.transactionIds);
          setErrors((current) => without(current, [row.id]));
        } else {
          setErrors((current) => ({ ...current, [row.id]: result }));
        }
      }
      setSelected((current) => new Set([...current].filter((id) => !done.has(id))));
      setBulkPending(false);
      setDialog(null);
      const verb = kind === "register" ? "登録" : "無視";
      const note = skippedCount > 0 ? `。科目のない ${skippedCount} 件は登録しませんでした` : "";
      if (groups.length > 0) showUndo(`${done.size} 件を${verb}しました${note}`, groups);
      else if (note) toast(`科目のない ${skippedCount} 件は登録しませんでした`);
      const remaining = rows.find((row) => !hiddenRef.current.has(row.id));
      focusRow(remaining?.id ?? null);
      router.refresh();
    });
  }

  // -------------------------------------------------------------------------
  // 未処理に戻す (15 §5)
  // -------------------------------------------------------------------------

  const dialogRow = dialog && "rowId" in dialog ? (rowById.get(dialog.rowId) ?? null) : null;
  const reopenRow = dialog?.kind === "reopen" ? dialogRow : null;
  const voids = Boolean(
    reopenRow &&
    reopenRow.status !== "ignored" &&
    reopenRow.entry?.ownsEntry &&
    reopenRow.entry.status === "posted",
  );

  function confirmReopen() {
    const row = reopenRow;
    if (!row) return;
    if (voids && reason.trim() === "") {
      setDialogError("理由を入力してください");
      return;
    }
    startDialog(async () => {
      const result = await reopenStatementAction(row.id, { reason });
      if (!result.ok) {
        setDialogError(result.fieldErrors.reason ?? result.error);
        return;
      }
      const ids = result.data.reopenedIds.filter((id) => rowById.has(id));
      const next = nextAfter(row.id, new Set([row.id, ...ids]));
      setDialog(null);
      setReason("");
      setDialogError(null);
      hide([row.id, ...ids]);
      focusRow(next);
      const reversal = result.data.reversal;
      toast(
        reversal
          ? `未処理に戻しました（反対仕訳 ${entryNo(reversal.no)}・${displayDate(reversal.entryDate)} 付）`
          : "未処理に戻しました",
      );
      router.refresh();
    });
  }

  // -------------------------------------------------------------------------
  // The rows
  // -------------------------------------------------------------------------

  function menuItems(row: ClientStatementRow): MenuItem[] {
    if (row.status === "pending") {
      return [
        // 請求 (#16, 18 §9.4): a deposit can pay an issued invoice (売掛金の消込).
        ...(BigInt(row.amount) > 0n
          ? [{ label: "この請求に充てる", href: `/invoices/apply?statement=${row.id}` }]
          : []),
        {
          label: "証憑を紐づける",
          onSelect: () => setDialog({ kind: "documents", rowId: row.id }),
        },
        { label: "メモ", onSelect: () => setDialog({ kind: "note", rowId: row.id }) },
        {
          label: "分割",
          onSelect: () => setDialog({ kind: "split", rowId: row.id, draft: draftOf(row) }),
        },
        { label: "理由をつけて無視", onSelect: () => setDialog({ kind: "ignore", rowId: row.id }) },
        { label: "ルールにする", onSelect: () => openRule(row, draftOf(row)) },
      ];
    }
    // A payment of an invoice is cancelled on the invoice (請求, decision 2026-10-29), and one of
    // 立替精算 on 立替精算 (23-users-and-expenses §5.2).
    const invoiceId = row.entry?.invoiceId ?? null;
    return [
      ...(row.entry ? [{ label: "取引を開く", href: `/entries/${row.entry.id}` }] : []),
      ...(invoiceId
        ? [
            { label: "請求書を開く", href: `/invoices/${invoiceId}` },
            { label: "未処理に戻す", disabled: true as const, note: "請求で入金を取消" },
          ]
        : row.entry?.expensePayment
          ? [
              { label: "立替精算を開く", href: "/expenses" },
              { label: "未処理に戻す", disabled: true as const, note: "立替精算で支払を取消" },
            ]
          : [
              {
                label: "未処理に戻す",
                onSelect: () => setDialog({ kind: "reopen", rowId: row.id }),
              },
            ]),
      { label: "証憑を紐づける", onSelect: () => setDialog({ kind: "documents", rowId: row.id }) },
      { label: "メモ", onSelect: () => setDialog({ kind: "note", rowId: row.id }) },
    ];
  }

  const handlers: RowHandlers = {
    onKeyDown: onRowKey,
    onFocusRow: (row) => setCurrentId(row.id),
    onPrimary: primary,
    onSecondary: secondary,
    onChip: (row, field) => setDialog({ kind: "edit", rowId: row.id, focus: field }),
    onTransferChip: (row) => setDialog({ kind: "transfer", rowId: row.id }),
    onDocuments: (row) => setDialog({ kind: "documents", rowId: row.id }),
    onToggle: toggle,
    menuItems,
  };

  const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.id));

  return (
    <>
      {pendingTab && selected.size > 0 ? (
        <div
          role="region"
          aria-label="選択した明細"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-card border border-border px-3 py-2"
        >
          <span className="text-[13px] font-bold">
            選択 <span className="num">{selected.size}</span> 件
          </span>
          <Button size="sm" variant="primary" onClick={() => setDialog({ kind: "bulkRegister" })}>
            登録
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "bulkIgnore" })}>
            無視
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            解除
          </Button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        empty
      ) : (
        <>
          {pendingTab ? (
            <p className="mb-2 hidden text-[12px] text-muted-2 lg:block">
              ↑↓ 移動 · Enter 登録 · I 無視 · T 振替 · E 編集 · R ルールにする · Space 選択 · / 検索
              · Z 取消
            </p>
          ) : null}
          <div
            role="table"
            aria-label={pendingTab ? "未処理の明細" : "明細"}
            className="rounded-card border border-border bg-surface"
          >
            <div role="row" className={`statement-head ${pendingTab ? "" : "is-settled"}`}>
              {pendingTab ? (
                <span role="columnheader" data-area="sel" className="flex items-center">
                  <input
                    type="checkbox"
                    aria-label="このページの明細をすべて選択"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(visible.map((row) => row.id)))
                    }
                    className="size-4 cursor-pointer accent-[var(--primary)]"
                  />
                </span>
              ) : null}
              <span role="columnheader" data-area="date">
                日付
              </span>
              <span role="columnheader" data-area="desc">
                摘要
              </span>
              <span role="columnheader" data-area="amount" className="text-right">
                金額（円）
              </span>
              <span role="columnheader" data-area="chips">
                {pendingTab ? "科目 · 税区分 · 取引先 · セグメント" : "結果"}
              </span>
              <span role="columnheader" data-area="actions" className="text-right">
                <span className="sr-only">操作</span>
              </span>
            </div>
            {visible.map((row) => (
              <StatementRowView
                key={row.id}
                row={row}
                draft={row.status === "pending" ? draftOf(row) : null}
                lookups={lookups}
                thisYear={thisYear}
                current={row.id === current}
                selected={selected.has(row.id)}
                error={errors[row.id] ?? null}
                rowRef={(element) => {
                  if (element) rowRefs.current.set(row.id, element);
                  else rowRefs.current.delete(row.id);
                }}
                handlers={handlers}
              />
            ))}
          </div>
        </>
      )}

      {dialog?.kind === "edit" && dialogRow ? (
        <EditDialog
          row={dialogRow}
          draft={draftOf(dialogRow)}
          focus={dialog.focus}
          errors={errors[dialogRow.id]?.fieldErrors ?? null}
          options={options}
          lookups={lookups}
          thisYear={thisYear}
          onCancel={() => closeDialog(dialogRow.id)}
          onApply={(draft) => {
            setDrafts({ ...drafts, [dialogRow.id]: draft });
            closeDialog(dialogRow.id);
          }}
          onRegister={(draft) => {
            setDrafts({ ...drafts, [dialogRow.id]: draft });
            setDialog(null);
            register(dialogRow, draft);
          }}
          onSplit={(draft) => setDialog({ kind: "split", rowId: dialogRow.id, draft })}
          onRule={(draft) => {
            setDrafts({ ...drafts, [dialogRow.id]: draft });
            openRule(dialogRow, draft);
          }}
        />
      ) : null}

      {dialog?.kind === "transfer" && dialogRow ? (
        <TransferDialog
          row={dialogRow}
          draft={draftOf(dialogRow)}
          options={options}
          lookups={lookups}
          thisYear={thisYear}
          onCancel={() => closeDialog(dialogRow.id)}
          onTransfer={(input) => {
            const draft = draftOf(dialogRow);
            const candidate = dialogRow.candidates.find(
              (item) => `${item.kind}:${item.id}` === input.counterpart,
            );
            const next: RowDraft = {
              ...draft,
              mode: "transfer",
              counterpart: candidate ? input.counterpart : "",
              transferToWalletId: candidate?.walletId ?? input.walletId,
            };
            setDrafts({ ...drafts, [dialogRow.id]: next });
            setDialog(null);
            transfer(dialogRow, draft, { counterpart: input.counterpart, fee: input.fee });
          }}
        />
      ) : null}

      {dialog?.kind === "split" && dialogRow ? (
        <SplitDialog
          row={dialogRow}
          draft={dialog.draft}
          options={options}
          lookups={lookups}
          thisYear={thisYear}
          onCancel={() => closeDialog(dialogRow.id)}
          onSubmit={async (input) => {
            const result = await registerStatementAction(dialogRow.id, input);
            if (result.ok) {
              const ids = result.data.transactionIds;
              const next = nextAfter(dialogRow.id, new Set(ids));
              setDialog(null);
              setErrors((current) => without(current, [dialogRow.id]));
              hide(ids);
              focusRow(next);
              const [first] = ids;
              if (first) showUndo(registered(result.data), [{ id: first, ids }]);
              router.refresh();
            }
            return result;
          }}
        />
      ) : null}

      {dialog?.kind === "ignore" && dialogRow ? (
        <IgnoreDialog
          row={dialogRow}
          initialReason={draftOf(dialogRow).ignoredReason}
          thisYear={thisYear}
          onCancel={() => closeDialog(dialogRow.id)}
          onIgnore={(text) => {
            setDialog(null);
            ignore(dialogRow, text);
          }}
        />
      ) : null}

      {dialog?.kind === "documents" && dialogRow ? (
        <StatementDocumentsSheet
          row={dialogRow}
          thisYear={thisYear}
          onClose={() => closeDialog(dialogRow.id)}
        />
      ) : null}

      {dialog?.kind === "note" && dialogRow ? (
        <NoteDialog
          row={dialogRow}
          thisYear={thisYear}
          onCancel={() => closeDialog(dialogRow.id)}
          onSaved={(note) => {
            toast(note ? "メモを保存しました" : "メモを消しました");
            closeDialog(dialogRow.id);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={dialog?.kind === "reopen" && reopenRow !== null}
        title="未処理に戻します"
        confirmLabel="未処理に戻す"
        pending={dialogPending}
        error={voids ? null : dialogError}
        onCancel={() => closeDialog(reopenRow?.id)}
        onConfirm={confirmReopen}
      >
        {reopenRow ? (
          <>
            {reopenRow.status === "ignored" ? (
              <p>この明細を無視から未処理に戻します。</p>
            ) : voids && reopenRow.entry ? (
              <p>
                {entryNo(reopenRow.entry.no)} の反対仕訳を{" "}
                <span className="num font-bold">
                  {displayDate(reversalDateOf(reopenRow.txnDate, options.fiscalYears))}
                </span>{" "}
                付で登録し、この明細を未処理に戻します。同じ仕訳に結んだ明細もすべて未処理に戻ります。
              </p>
            ) : reopenRow.entry && reopenRow.entry.status !== "posted" ? (
              <p>
                {entryNo(reopenRow.entry.no)}{" "}
                は取引の画面で取り消されています。明細だけを未処理に戻します。
              </p>
            ) : reopenRow.entry ? (
              <p>
                この明細を {entryNo(reopenRow.entry.no)}{" "}
                から外して未処理に戻します。仕訳はそのまま残ります。
              </p>
            ) : (
              <p>この明細を未処理に戻します。</p>
            )}
            {reopenRow.status !== "ignored" ? (
              <div className="mt-3">
                <FormField
                  label="理由"
                  htmlFor="statement-reopen-reason"
                  required={voids}
                  error={voids ? (dialogError ?? undefined) : undefined}
                >
                  <Textarea
                    id="statement-reopen-reason"
                    value={reason}
                    maxLength={500}
                    onChange={(event) => {
                      setReason(event.currentTarget.value);
                      setDialogError(null);
                    }}
                  />
                </FormField>
              </div>
            ) : null}
          </>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === "bulkRegister"}
        title={`${runnable.length} 件を登録します`}
        confirmLabel="登録"
        pending={bulkPending}
        onCancel={() => {
          if (!bulkPending) closeDialog();
        }}
        onConfirm={() => runBulk("register")}
      >
        <p className="num">
          入金 {formatYen(totalOf(runnable, 1))} 円 / 出金 {formatYen(totalOf(runnable, -1))} 円
        </p>
        <p className="mt-2 text-[13px] text-muted">
          それぞれの行のチップの内容で、1 件ずつ順に登録します（振替・無視の推定の行はその操作）。
        </p>
        {skipped > 0 ? (
          <p className="mt-2 text-[13px] text-muted">
            科目のない {skipped} 件は登録しません。行のチップで科目を選んでから登録します。
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === "bulkIgnore"}
        title={`${bulk.length} 件を無視します`}
        confirmLabel="無視"
        pending={bulkPending}
        onCancel={() => {
          if (!bulkPending) closeDialog();
        }}
        onConfirm={() => runBulk("ignore")}
      >
        <p className="num">
          入金 {formatYen(totalOf(bulk, 1))} 円 / 出金 {formatYen(totalOf(bulk, -1))} 円
        </p>
        <p className="mt-2 text-[13px] text-muted">
          帳簿には載せません。あとから未処理に戻せます。
        </p>
      </ConfirmDialog>

      {ruleFor ? (
        <RuleSheet
          rule={null}
          initial={ruleFor.initial}
          options={options}
          onClose={() => {
            const rowId = ruleFor.rowId;
            setRuleFor(null);
            focusRow(rowId);
          }}
          onSaved={() => {
            // The chips of the row follow the new rule (solid) after the refresh.
            setDrafts((current) => without(current, [ruleFor.rowId]));
            router.refresh();
          }}
        />
      ) : null}

      <UndoBar undo={undo} onUndo={performUndo} onExpire={() => setUndo(null)} />
    </>
  );
}
