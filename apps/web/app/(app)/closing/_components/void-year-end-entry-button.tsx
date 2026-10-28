"use client";

import { entryNo } from "@/lib/format";
import { voidYearEndEntryAction } from "../actions";
import { ReasonAction } from "./reason-action";

/**
 * 取り消す of an adjusting entry on /closing (16 §1.2, §3): a danger confirmation with the reason
 * (required). An accrual's reversal in the next year is voided with it.
 */
export function VoidYearEndEntryButton({
  entryId,
  no,
  accrualReversalNo = null,
}: {
  entryId: string;
  no: number;
  /** The next year's reversal of an accrual, voided together. */
  accrualReversalNo?: number | null;
}) {
  return (
    <ReasonAction
      label="取り消す"
      ariaLabel={`${entryNo(no)} を取り消す`}
      triggerVariant="ghost"
      triggerClassName="text-danger! hover:text-danger!"
      title={`${entryNo(no)} を取り消します`}
      confirmLabel="取り消す"
      variant="danger"
      reasonRequired
      run={(reason) => voidYearEndEntryAction(entryId, { reason })}
      doneMessage={(data) =>
        `${entryNo(data.no)} を取り消しました（反対仕訳 ${entryNo(data.reversalNo)}${
          data.accrualReversalNo !== null
            ? `・振り戻し ${entryNo(data.accrualReversalNo)} も取り消し`
            : ""
        }）`
      }
    >
      <p>
        借方と貸方を入れ替えた反対仕訳を登録し、{entryNo(no)}{" "}
        を取消済みにします。どちらも台帳に残ります。
      </p>
      {accrualReversalNo !== null ? (
        <p className="mt-2">翌期首の振り戻し {entryNo(accrualReversalNo)} も一緒に取り消します。</p>
      ) : null}
    </ReasonAction>
  );
}
