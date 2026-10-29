"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { entryNo, formatDate } from "@/lib/format";
import { postRecurringOccurrenceAction } from "./actions";
import { DUE_COLUMNS } from "./due-columns";

/** An occurrence to register here (money as text: bigint stays on the server). */
export interface DueRow {
  key: string;
  recurringItemId: string;
  name: string;
  date: string;
  month: string;
  walletName: string;
  /** 科目, or 相手の口座 of a 振替. */
  counterpartName: string;
  /** |金額| with 3-digit grouping. */
  amount: string;
}

function DueRowView({ row, onPosted }: { row: DueRow; onPosted: (key: string) => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(row.amount);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const where = `${formatDate(row.date)} ${row.name}`;

  function register() {
    startTransition(async () => {
      const result = await postRecurringOccurrenceAction({
        recurringItemId: row.recurringItemId,
        month: row.month,
        amount,
      });
      if (!result.ok) {
        // Refusals (締め済み・税区分なし・登録済み …) stay under the row (§10.4).
        setError(result.error);
        return;
      }
      setError(null);
      onPosted(row.key);
      toast(`${entryNo(result.data.no)} を登録しました`, {
        link: { href: `/entries/${result.data.id}`, label: "取引を開く" },
      });
    });
  }

  return (
    <TableRow {...DUE_COLUMNS}>
      <Td className="num text-[13px] text-muted">{formatDate(row.date)}</Td>
      <Td>
        <span className="block break-words">{row.name}</span>
        <span className="block text-[12px] text-muted-2 md:hidden">
          {row.walletName} → {row.counterpartName}
        </span>
      </Td>
      <Td sm="hide" className="text-[13px] break-words">
        {row.walletName} → {row.counterpartName}
      </Td>
      <Td>
        <MoneyInput
          value={amount}
          onValueChange={setAmount}
          aria-label={`${where} の金額（円）`}
          aria-invalid={error ? true : undefined}
          maxLength={17}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              register();
            }
          }}
        />
      </Td>
      <Td className="text-right">
        <Button
          size="sm"
          variant="primary"
          disabled={pending}
          onClick={register}
          aria-label={`${where} を登録`}
        >
          {pending ? "登録中…" : "登録"}
        </Button>
      </Td>
      {error ? (
        <Td sm="full" className="col-span-full">
          <span role="alert" className="block text-[12px] leading-snug font-bold text-danger">
            {error}
          </span>
        </Td>
      ) : null}
    </TableRow>
  );
}

/** 節「登録する」: each row posts its entry; a posted row leaves the list. */
export function DueRows({ rows }: { rows: DueRow[] }) {
  const [posted, setPosted] = useState<ReadonlySet<string>>(new Set());
  const shown = rows.filter((row) => !posted.has(row.key));
  if (shown.length === 0) {
    return <p className="text-[13px] text-muted">登録する定期取引はありません</p>;
  }
  return (
    <Table label="登録する定期取引">
      <TableHead {...DUE_COLUMNS}>
        <Th>日付</Th>
        <Th>名前</Th>
        <Th>口座 → 科目</Th>
        <Th align="right">金額（円）</Th>
        <Th />
      </TableHead>
      {shown.map((row) => (
        <DueRowView
          key={row.key}
          row={row}
          onPosted={(key) => setPosted((current) => new Set([...current, key]))}
        />
      ))}
    </Table>
  );
}
