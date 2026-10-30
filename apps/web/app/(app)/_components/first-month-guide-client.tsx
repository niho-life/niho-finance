"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useSyncExternalStore, useTransition } from "react";
import { Button, ButtonLink, type ButtonVariant } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-types";
import {
  checkFirstMonthStepAction,
  closeFirstMonthGuideAction,
  showFirstMonthGuideAction,
  uncheckFirstMonthStepAction,
} from "./first-month-guide-actions";

/** A step as the card shows it (`first-month-guide.tsx` turns the guide into plain values). */
export interface GuideStepView {
  key: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  done: boolean;
  doneBy: "auto" | "manual" | null;
  deadlines: {
    id: string;
    title: string;
    dateText: string;
    statusText: string;
    status: "overdue" | "today" | "soon" | "open";
  }[];
  moreDeadlines: number;
  noDeadlinesYet: boolean;
}

export interface GuideView {
  steps: GuideStepView[];
  doneCount: number;
  total: number;
  allDone: boolean;
  shownAgain: boolean;
}

// ---------------------------------------------------------------------------
// 畳む: remembered per device (10 §3.1). Open on the server and on the first render (no hydration
// mismatch); where storage cannot be used the choice lasts until the page is reloaded.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "niho-finance:first-month-guide";
const listeners = new Set<() => void>();
/** The choice made on this page, when storage could not keep it. */
let collapsedInMemory: boolean | null = null;

function readCollapsed(): boolean {
  if (collapsedInMemory !== null) return collapsedInMemory;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  collapsedInMemory = collapsed;
  try {
    if (collapsed) window.localStorage.setItem(STORAGE_KEY, "collapsed");
    else window.localStorage.removeItem(STORAGE_KEY);
    collapsedInMemory = null;
  } catch {
    // Not remembered: opens again on the next visit.
  }
  for (const listener of listeners) listener();
}

function subscribeCollapsed(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const openOnServer = () => false;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** A button that runs a Server Action and says the outcome in a toast (no confirmation: 10 §3.1). */
function ActionButton({
  label,
  ariaLabel,
  variant,
  run,
  done,
}: {
  label: string;
  ariaLabel?: string;
  variant: ButtonVariant;
  run: () => Promise<ActionResult>;
  /** The toast after it worked. */
  done: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      const result = await run();
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      toast(done);
      router.refresh();
    });
  }

  return (
    <Button size="sm" variant={variant} disabled={pending} aria-label={ariaLabel} onClick={onClick}>
      {pending ? "処理中…" : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const STATUS_CLASS: Readonly<Record<GuideStepView["deadlines"][number]["status"], string>> = {
  overdue: "font-bold text-warn",
  today: "font-bold",
  soon: "num font-bold",
  open: "text-muted",
};

/** The open founding deadlines under 税務の届出 (each opens the calendar, 24 §1's state text). */
function Deadlines({ step }: { step: GuideStepView }) {
  if (step.noDeadlinesYet) {
    return <p className="mt-1.5 text-[12px] text-muted">期限は毎朝 9 時の同期で作られます</p>;
  }
  if (step.deadlines.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-col">
      {step.deadlines.map((deadline) => (
        <li key={deadline.id}>
          <Link
            href="/calendar"
            className="flex min-h-8 flex-wrap items-baseline gap-x-2 rounded-md px-1 py-1 text-[13px] hover:bg-black/[0.02]"
          >
            <span className="num shrink-0 text-muted">{deadline.dateText}</span>
            <span className="min-w-0 break-words">{deadline.title}</span>
            <span className={`shrink-0 ${STATUS_CLASS[deadline.status]}`}>
              {deadline.statusText}
            </span>
          </Link>
        </li>
      ))}
      {step.moreDeadlines > 0 ? (
        <li>
          <Link
            href="/calendar"
            className="inline-flex min-h-8 items-center rounded-md px-1 text-[13px] text-muted hover:bg-black/[0.02] hover:text-text"
          >
            ほか {step.moreDeadlines} 件
          </Link>
        </li>
      ) : null}
    </ul>
  );
}

function OpenStep({ step }: { step: GuideStepView }) {
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 first:pt-1 last:border-b-0 last:pb-1 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-bold break-words">{step.title}</p>
        <p className="mt-0.5 text-[13px] break-words text-muted">{step.description}</p>
        {step.key === "filings" ? <Deadlines step={step} /> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <ButtonLink href={step.href} size="sm" variant="secondary">
          {step.cta}
        </ButtonLink>
        <ActionButton
          label="済みにする"
          ariaLabel={`${step.title} を済みにする`}
          variant="ghost"
          run={() => checkFirstMonthStepAction(step.key)}
          done={`「${step.title}」を済みにしました`}
        />
      </div>
    </li>
  );
}

/** A done step, muted: checked by hand → 未了に戻す; shown done by the book → 済み (cannot go back). */
function DoneStep({ step }: { step: GuideStepView }) {
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-1.5 text-muted last:border-b-0">
      <span className="min-w-0 flex-1 text-[14px] break-words">{step.title}</span>
      {step.doneBy === "manual" ? (
        <ActionButton
          label="未了に戻す"
          ariaLabel={`${step.title} を未了に戻す`}
          variant="ghost"
          run={() => uncheckFirstMonthStepAction(step.key)}
          done={`「${step.title}」を未了に戻しました`}
        />
      ) : (
        <span className="text-[13px]">済み</span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * 「はじめの手順」 (10 §3.1): the steps not done yet, the done ones folded under 「済み n 件を表示」
 * (the fold of inactive rows, 10 §2), and 畳む / 開く. Shown again after everything is done, it lists
 * every step done with 「閉じる」.
 */
export function FirstMonthGuideCard({ guide }: { guide: GuideView }) {
  const id = useId();
  const headingId = `${id}-heading`;
  const bodyId = `${id}-body`;
  const doneListId = `${id}-done`;
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, openOnServer);
  const [showDone, setShowDone] = useState(false);
  const openSteps = guide.steps.filter((step) => !step.done);
  const doneSteps = guide.steps.filter((step) => step.done);
  const closing = guide.shownAgain && guide.allDone;

  return (
    <section
      aria-labelledby={headingId}
      className="mb-3.5 min-w-0 rounded-card border border-border bg-surface px-5 py-[18px]"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <h2 id={headingId} className="text-[13px] font-bold text-muted">
            はじめの手順
          </h2>
          <span className="num text-[12px] text-muted">
            {guide.total} 項目中 {guide.doneCount} 項目済み
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => writeCollapsed(!collapsed)}
        >
          {collapsed ? "開く" : "畳む"}
        </Button>
      </div>

      <div id={bodyId} hidden={collapsed} className="mt-2">
        {closing ? (
          <>
            <p className="text-[13px] text-muted">すべての手順が済んでいます。</p>
            <ol aria-label="済んだ手順" className="mt-1 flex flex-col">
              {doneSteps.map((step) => (
                <DoneStep key={step.key} step={step} />
              ))}
            </ol>
            <div className="mt-3">
              <ActionButton
                label="閉じる"
                ariaLabel="はじめの手順を閉じる"
                variant="secondary"
                run={closeFirstMonthGuideAction}
                done="はじめの手順を閉じました"
              />
            </div>
          </>
        ) : (
          <>
            <ol aria-label="済んでいない手順" className="flex flex-col">
              {openSteps.map((step) => (
                <OpenStep key={step.key} step={step} />
              ))}
            </ol>
            {doneSteps.length > 0 ? (
              <div className="mt-2 border-t border-border pt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={showDone}
                  aria-controls={doneListId}
                  onClick={() => setShowDone((value) => !value)}
                >
                  {showDone ? "済みを隠す" : `済み ${doneSteps.length} 件を表示`}
                </Button>
                <ol
                  id={doneListId}
                  hidden={!showDone}
                  aria-label="済んだ手順"
                  className="mt-1 flex flex-col"
                >
                  {doneSteps.map((step) => (
                    <DoneStep key={step.key} step={step} />
                  ))}
                </ol>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/** 設定 › 事業所 「ホームに表示する」 (10 §4.1). */
export function ShowFirstMonthGuideButton() {
  return (
    <ActionButton
      label="ホームに表示する"
      variant="secondary"
      run={showFirstMonthGuideAction}
      done="はじめの手順をホームに表示しました"
    />
  );
}
