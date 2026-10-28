import { calendarItemStatus, type CalendarGroup, type CalendarListItem } from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import { ButtonLink } from "@/components/ui/button";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatDate, formatPeriod } from "@/lib/format";
import { CompletionButton } from "./completion-button";
import { StatusText } from "./status-text";

/** 期限 ・ 内容 ・ 注記 ・ 状態 ・ 操作; on phones 内容 (with the date, the state and the note) ・ 操作. */
const COLUMNS = {
  columns: "104px minmax(0,1.6fr) minmax(0,1fr) 128px 120px",
  mobileColumns: "minmax(0,1fr) auto",
};

function ItemRow({ item, today }: { item: CalendarListItem; today: CalendarDate }) {
  const status = calendarItemStatus(item, today);
  const completed = item.completedAt !== null;
  const payroll = item.managedBy === "payroll";
  const note = payroll ? (item.note ?? "給与の画面で納付を登録すると完了になります") : item.note;
  return (
    <TableRow {...COLUMNS} muted={completed}>
      <Td sm="hide" className="num">
        {formatDate(item.dueDate)}
      </Td>
      <Td>
        <span className="flex flex-wrap items-baseline gap-x-2 text-[12px] md:hidden">
          <span className="num text-muted">期限 {formatDate(item.dueDate)}</span>
          <StatusText status={status} />
        </span>
        <span className="block">{item.title}</span>
        {note ? <span className="block text-[12px] text-muted md:hidden">{note}</span> : null}
      </Td>
      <Td sm="hide" className="text-[13px] text-muted">
        {note}
      </Td>
      <Td sm="hide">
        <StatusText status={status} />
      </Td>
      <Td align="right">
        {payroll ? (
          // 納付を登録 posts the entry and completes the deadline there (22 §7).
          <ButtonLink
            href="/payroll"
            size="sm"
            variant={completed ? "ghost" : "secondary"}
            aria-label={`${item.title} を給与の画面で開く`}
          >
            給与を開く
          </ButtonLink>
        ) : (
          <CompletionButton id={item.id} title={item.title} completed={completed} />
        )}
      </Td>
    </TableRow>
  );
}

function ItemsTable({
  label,
  items,
  today,
}: {
  label: string;
  items: readonly CalendarListItem[];
  today: CalendarDate;
}) {
  return (
    <Table label={label}>
      <TableHead {...COLUMNS}>
        <Th>期限</Th>
        <Th>内容</Th>
        <Th>注記</Th>
        <Th>状態</Th>
        <Th>
          <span className="sr-only">操作</span>
        </Th>
      </TableHead>
      {items.map((item) => (
        <ItemRow key={item.id} item={item} today={today} />
      ))}
    </Table>
  );
}

/**
 * One fiscal year of the calendar (24 §3), or その他 for the deadlines outside every year: the open
 * deadlines by due date, then the completed ones folded under 「完了 n 件を表示」 (the fold of
 * inactive rows, 10 §2; a native `<details>`).
 */
export function CalendarSection({ group, today }: { group: CalendarGroup; today: CalendarDate }) {
  const { fiscalYear, open, completed } = group;
  const title = fiscalYear ? `第${fiscalYear.no}期` : "その他";
  const headingId = `calendar-${fiscalYear?.id ?? "none"}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={headingId} className="text-[15px] font-extrabold">
          {title}
        </h2>
        <span className="num text-[13px] text-muted">
          {fiscalYear ? formatPeriod(fiscalYear.startDate, fiscalYear.endDate) : "会計期間の外"}
        </span>
        <span className="text-[13px] text-muted">未完了 {open.length} 件</span>
      </div>
      {open.length > 0 ? (
        <ItemsTable label={`${title}の未完了の期限`} items={open} today={today} />
      ) : (
        <p className="text-[14px] text-muted">
          {completed.length > 0
            ? "未完了の期限はありません"
            : "この期の期限はまだありません。会計期間から毎日の同期で作られます"}
        </p>
      )}
      {completed.length > 0 ? (
        <details className="group">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="group-open:hidden">
              ▸
            </span>
            <span aria-hidden="true" className="hidden group-open:inline">
              ▾
            </span>
            <span className="group-open:hidden">完了 {completed.length} 件を表示</span>
            <span className="hidden group-open:inline">完了 {completed.length} 件を畳む</span>
          </summary>
          <div className="mt-2">
            <ItemsTable label={`${title}の完了した期限`} items={completed} today={today} />
          </div>
        </details>
      ) : null}
    </section>
  );
}
