"use client";

import { displayDate, type CalendarDate, type FiscalYearStatus } from "@niho-finance/ledger";
import { cancelYearEndAction, reopenYearAction, startYearEndAction } from "../actions";
import { ReasonAction } from "./reason-action";

export interface TransitionYear {
  id: string;
  no: number;
  status: FiscalYearStatus;
  endDate: CalendarDate;
  lockedThrough: CalendarDate | null;
}

/** What 決算整理を始める does to the monthly close (16 §1.1): moved back from the last day. */
function closeChange(year: TransitionYear, after: CalendarDate | null): string | null {
  if (after === year.lockedThrough) return null;
  if (after === null) {
    return `期末日 ${displayDate(year.endDate)} 付の決算整理仕訳を登録するため、月次の締めを外します。`;
  }
  return `期末日 ${displayDate(year.endDate)} 付の決算整理仕訳を登録するため、月次の締め日を ${displayDate(after)} に戻します。`;
}

/** 決算整理を始める (primary): the impact and an optional reason. */
export function StartYearEndButton({
  year,
  normalEntryCount,
  lockedThroughAfterStart,
}: {
  year: TransitionYear;
  normalEntryCount: number;
  lockedThroughAfterStart: CalendarDate | null;
}) {
  const change = closeChange(year, lockedThroughAfterStart);
  return (
    <ReasonAction
      label="決算整理を始める"
      triggerVariant="primary"
      title={`第 ${year.no} 期の決算整理を始めます`}
      confirmLabel="決算整理を始める"
      reasonRequired={false}
      run={(reason) => startYearEndAction(year.id, { reason })}
      doneMessage={(data) => `第 ${data.no} 期の決算整理を始めました`}
    >
      <p>
        第 {year.no} 期の通常の仕訳 <span className="num font-bold">{normalEntryCount} 件</span>
        が登録・取消できなくなり、決算整理仕訳だけを登録できます。
      </p>
      {change ? <p className="mt-2">{change}</p> : null}
      <p className="mt-2 text-[13px] text-muted">
        決算整理をやめると、通常の仕訳をまた登録できます。
      </p>
    </ReasonAction>
  );
}

/** 決算整理をやめる (ghost): the reason is required. */
export function CancelYearEndButton({ year }: { year: TransitionYear }) {
  return (
    <ReasonAction
      label="決算整理をやめる"
      triggerVariant="ghost"
      title={`第 ${year.no} 期の決算整理をやめます`}
      confirmLabel="決算整理をやめる"
      reasonRequired
      run={(reason) => cancelYearEndAction(year.id, { reason })}
      doneMessage={(data) => `第 ${data.no} 期の決算整理をやめました`}
    >
      <p>第 {year.no} 期を進行中に戻し、通常の仕訳をまた登録できるようにします。</p>
      <p className="mt-2 text-[13px] text-muted">
        登録済みの決算整理仕訳は残ります（取引の画面で取消・訂正できます）。月次の締め日は戻しません。
      </p>
    </ReasonAction>
  );
}

/** 締めを戻す (ghost, danger text): voids the closing entry; the reason is required. */
export function ReopenYearButton({ year }: { year: TransitionYear }) {
  return (
    <ReasonAction
      label="締めを戻す"
      triggerVariant="ghost"
      triggerClassName="text-danger! hover:text-danger!"
      title={`第 ${year.no} 期の締めを戻します`}
      confirmLabel="締めを戻す"
      variant="danger"
      reasonRequired
      run={(reason) => reopenYearAction(year.id, { reason })}
      doneMessage={(data) => `第 ${data.no} 期の締めを戻しました。決算整理中です`}
    >
      <p>
        決算振替を反対仕訳で取り消し、第 {year.no}{" "}
        期を決算中に戻します。決算整理仕訳を取り消し・登録できるようになります。
      </p>
    </ReasonAction>
  );
}
