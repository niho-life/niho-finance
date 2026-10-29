import type { ReactNode } from "react";
import { gridStyle } from "./table";

/*
 * Loading (05-ui-ux §3.1): the shape of the screen in still bands of the border colour (no pulse:
 * nothing decorative moves, §3) and outlines where controls, buttons and cards will be. A page's
 * `loading.tsx` and a part streamed later (`Suspense`'s fallback) are drawn with the same pieces.
 * Screen readers hear 「読み込み中」 once (`role="status"` around the whole skeleton); the bands are
 * hidden from them.
 */

/** A still band; `frame`: an outline (controls, buttons, chips). Size and radius by class. */
export function Skeleton({
  className = "",
  frame = false,
}: {
  className?: string;
  frame?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`block max-w-full ${frame ? "border border-border" : "bg-border"} ${className}`}
    />
  );
}

/** Band heights by the size of the text a line stands for (12px, 14px, 17–20px, 32px). */
const BAND = { s: "h-2", m: "h-2.5", l: "h-3.5", xl: "h-6" } as const;

/**
 * One line of text: a band (`band`: its width) in the box of the line (`box`: the line's height),
 * so that the skeleton is as tall as the text it stands for.
 */
function Line({
  band,
  size = "m",
  box = "h-[22px]",
  className = "",
}: {
  band: string;
  size?: keyof typeof BAND;
  box?: string;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`flex min-w-0 items-center ${box} ${className}`}>
      <Skeleton className={`rounded ${BAND[size]} ${band}`} />
    </span>
  );
}

/** The one announcement of a skeleton. */
function Loading({ children }: { children: ReactNode }) {
  return (
    <div role="status">
      <span className="sr-only">読み込み中</span>
      {children}
    </div>
  );
}

/** The outlines of `count` small buttons (a header's actions, 「CSV」「PDF」). */
export function ButtonsSkeleton({ count, width = "w-16" }: { count: number; width?: string }) {
  return (
    <span aria-hidden="true" className="flex items-center gap-2">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} frame className={`h-8 rounded-lg ${width}`} />
      ))}
    </span>
  );
}

const TABLE = gridStyle({
  columns: "minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)",
  mobileColumns: "minmax(0,1fr) auto",
});

const ROW_BANDS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3"] as const;

/**
 * A table in Table's box and rows (05-ui-ux §3): the head and `rows` rows of 40px on PC, 2 lines
 * on phones, so that the table does not move when it comes. Never wider than the screen.
 */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-card border border-border bg-surface"
    >
      <div className="data-row data-head" style={TABLE}>
        <Line band="w-10" size="s" box="h-4" />
        <Line band="w-8" size="s" box="h-4" />
        <Line band="w-8" size="s" box="h-4" />
        <Line band="ml-auto w-10" size="s" box="h-4" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="data-row" style={TABLE}>
          <Line band={ROW_BANDS[i % ROW_BANDS.length] ?? "w-1/2"} />
          {/* Plain cells carry `data-sm`: the rules of .data-row hide or widen them on phones. */}
          <span data-sm="hide" className="min-w-0">
            <Line band="w-3/5" />
          </span>
          <span data-sm="hide" className="min-w-0">
            <Line band="w-1/2" />
          </span>
          <Line band="ml-auto w-16" />
          <span data-sm="full" className="min-w-0 md:hidden">
            <Line band="w-2/5" size="s" box="h-[19px]" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** A heading (or a note) over a table: the content of a tab or a section. */
function ContentBody({ rows }: { rows: number }) {
  return (
    <>
      <Line band="w-28" box="h-[23px]" className="mb-2" />
      <TableSkeleton rows={rows} />
    </>
  );
}

/**
 * The part of a page that comes later (`Suspense`'s fallback, 05-ui-ux §3.1): a heading and the
 * rows of a table, the same as the bottom of `PageSkeleton`'s `report`.
 */
export function ContentSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <Loading>
      <ContentBody rows={rows} />
    </Loading>
  );
}

/** A card of the home: the outline and the heading (HomeCard's box, lines only). */
function CardSkeleton({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className={`min-w-0 rounded-card border border-border px-5 py-[18px] ${className}`}
    >
      <Line band="w-16" size="s" box="h-5" className="mb-2.5" />
      {children}
    </div>
  );
}

function ProfitCardSkeleton() {
  return (
    <CardSkeleton>
      <div className="mb-4 grid gap-1 sm:grid-cols-3 sm:gap-2.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex min-w-0 items-center justify-between gap-3 sm:block">
            <Line band="w-8" size="s" box="h-[19px]" />
            <Line band="w-28" size="l" box="h-7 sm:h-[34px]" />
          </div>
        ))}
      </div>
      <Line band="w-3/4" />
      <Line band="w-1/2" />
    </CardSkeleton>
  );
}

/** ホーム (14-reports §9): 現預金 ・ 口座, the two 損益 and やること, 資金繰り. */
function HomeBody() {
  return (
    <>
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <CardSkeleton>
          <Line band="w-44" size="xl" box="h-10" />
          <Line band="w-32" size="s" box="h-[19px]" className="mt-1.5" />
        </CardSkeleton>
        <CardSkeleton>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
            >
              <Line band="w-24" />
              <Line band="w-20" className="ml-auto" />
            </div>
          ))}
        </CardSkeleton>
      </div>
      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <ProfitCardSkeleton />
          <ProfitCardSkeleton />
        </div>
        <CardSkeleton className="lg:self-start">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex min-h-11 items-center gap-2.5 border-b border-border px-1 py-2 last:border-b-0"
            >
              <Skeleton frame className="h-6 w-9 shrink-0 rounded-lg" />
              <Line band="w-3/5" className="flex-1" />
            </div>
          ))}
        </CardSkeleton>
      </div>
      <CardSkeleton className="mt-3.5">
        <Line band="w-56" size="l" box="h-[34px]" className="mb-3" />
        <div className="h-28 border-b border-border" />
      </CardSkeleton>
    </>
  );
}

/** A filter bar's controls over a table (明細・取引・証憑・請求 …). */
function ListBody() {
  return (
    <>
      <div aria-hidden="true" className="mb-4 flex flex-wrap gap-2">
        <Skeleton frame className="h-10 w-32 rounded-control" />
        <Skeleton frame className="h-10 w-32 rounded-control" />
        <Skeleton frame className="h-10 w-28 rounded-control" />
        <Skeleton frame className="h-10 min-w-40 flex-1 rounded-control" />
      </div>
      <TableSkeleton rows={10} />
    </>
  );
}

/** A table alone (the lists of 設定, 従業員, 固定資産台帳). */
function TableBody() {
  return <TableSkeleton rows={10} />;
}

/** Sections with a heading and a table each (給与・立替精算・期限・明細の取込). */
function SectionsBody() {
  return (
    <div className="flex flex-col gap-8">
      {[3, 6].map((rows) => (
        <div key={rows} className="flex flex-col gap-3">
          <Line band="w-24" box="h-[23px]" />
          <TableSkeleton rows={rows} />
        </div>
      ))}
    </div>
  );
}

/** Rows that open the sections (設定・その他). */
function IndexBody() {
  return (
    <div aria-hidden="true" className="grid gap-x-7 md:grid-cols-2">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex min-h-12 items-center gap-3 border-b border-border px-1 py-3">
          <Line band={i % 2 === 0 ? "w-24" : "w-32"} />
          <Line band="w-14" size="s" box="h-[19px]" className="ml-auto" />
        </div>
      ))}
    </div>
  );
}

/** The numbered steps of a checklist (決算). */
function ChecklistBody() {
  return (
    <div aria-hidden="true" className="mt-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex gap-3 border-b border-border py-3.5 last:border-b-0">
          <Skeleton frame className="mt-px size-6 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Line band="w-36" box="h-[23px]" />
            <Line band="w-3/5" size="s" box="h-5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One record: its heading, its lines and a note (取引・証憑・請求・取込の結果 …). */
function DetailBody() {
  return (
    <>
      <Line band="w-56" size="l" box="h-[26px]" className="mb-3" />
      <TableSkeleton rows={4} />
      <Line band="w-48" size="s" box="h-[19px]" className="mt-3" />
    </>
  );
}

/** The fields of a form in two columns on PC, and its button. */
function FormBody() {
  return (
    <div aria-hidden="true" className="flex max-w-3xl flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex min-w-0 flex-col gap-1">
            <Line band="w-16" size="s" box="h-[19px]" />
            <Skeleton frame className="h-10 w-full rounded-control" />
          </div>
        ))}
      </div>
      <Skeleton frame className="h-10 w-28 rounded-[10px]" />
    </div>
  );
}

/** 報告: the tab row, then the content (the same as `ContentSkeleton`). */
function ReportBody() {
  return (
    <>
      <div
        aria-hidden="true"
        className="mb-4 flex gap-1.5 overflow-hidden md:gap-0.5 md:border-b md:border-border"
      >
        {Array.from({ length: 8 }, (_, i) => (
          <span
            key={i}
            className="flex h-[34px] shrink-0 items-center rounded-full border border-border px-3 md:h-10 md:rounded-none md:border-0"
          >
            <Skeleton className="h-2.5 w-12 rounded" />
          </span>
        ))}
      </div>
      <ContentBody rows={10} />
    </>
  );
}

const BODIES = {
  home: HomeBody,
  list: ListBody,
  table: TableBody,
  sections: SectionsBody,
  index: IndexBody,
  checklist: ChecklistBody,
  detail: DetailBody,
  form: FormBody,
  report: ReportBody,
} as const;

export type PageSkeletonVariant = keyof typeof BODIES;

/** 期間の選択 and 「CSV」「PDF」 of 報告 (ReportsFrame's actions). */
function ReportActions() {
  return (
    <>
      <span aria-hidden="true" className="flex flex-wrap items-center gap-2">
        <Skeleton frame className="h-9 w-36 rounded-[10px]" />
        <Skeleton frame className="h-8 w-20 rounded-control" />
      </span>
      <ButtonsSkeleton count={2} width="w-[3.25rem]" />
    </>
  );
}

/**
 * PageHeader's box (page-header.tsx: keep the two in step) with what is known before the data:
 * the title and the parent's name as text, the rest as bands and outlines.
 */
function HeaderSkeleton({
  title,
  back,
  meta,
  actions,
}: {
  title: string | undefined;
  back: string | true | undefined;
  meta: boolean;
  actions: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {back === true ? (
          <Line band="w-14" size="s" box="h-[19px]" />
        ) : back ? (
          <span className="inline-flex w-fit items-center gap-1 text-[12px] font-bold text-muted">
            <span aria-hidden="true">‹</span>
            {back}
          </span>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-3">
          {title ? (
            <h1 className="text-[20px] leading-tight font-extrabold">{title}</h1>
          ) : (
            <Line band="w-40" size="l" box="h-[25px]" />
          )}
          {meta ? <Line band="w-24" size="s" box="h-5" /> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * A page while it loads (each segment's `loading.tsx`, 05-ui-ux §3.1): the page's header, then the
 * shape of the screen. The title and the parent's name are real text, so that the page that comes
 * changes only what was missing.
 */
export function PageSkeleton({
  variant,
  title,
  back,
  actions = 0,
}: {
  variant: PageSkeletonVariant;
  /** The title of the page's PageHeader; without it (a title from the data) a band. */
  title?: string;
  /** The name of the page's link to its parent; `true` when the name comes from the data. */
  back?: string | true;
  /** How many buttons the page's header has on the right. */
  actions?: number;
}) {
  const Body = BODIES[variant];
  return (
    <Loading>
      <HeaderSkeleton
        title={title}
        back={back}
        meta={variant === "home" || variant === "report" || variant === "detail"}
        actions={
          variant === "report" ? (
            <ReportActions />
          ) : actions > 0 ? (
            <ButtonsSkeleton count={actions} />
          ) : null
        }
      />
      <Body />
    </Loading>
  );
}
