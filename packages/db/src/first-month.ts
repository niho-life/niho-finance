/**
 * 初月のガイド「はじめの手順」(10-settings-and-setup §3.1): the steps of 07-operations §1 that are
 * left after the setup wizard, on the top of the home until all are done. Whether a step is done is
 * derived on every render from the lanes' own reads (nothing derived is stored); only the steps
 * checked by hand and 「ホームに表示する」 are stored, on `Company.setupGuide`.
 */
import type { CalendarDate } from "@niho-finance/ledger";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { appendAuditLog, type Db } from "./audit";
import { calendarItemStatus, listCalendarItems } from "./calendar";
import { getRecordsPolicy } from "./documents";
import { SettingsError } from "./errors";
import { listImportableWallets } from "./imports";
import { countActiveRecurringItems } from "./recurring";
import { listPartners, requireCompanyRow, type WriteOptions } from "./settings";
import { lockSettings, runInTransaction } from "./transaction";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** In the order of the card: the filings with legal deadlines first, then 07 §1's order. */
export const FIRST_MONTH_STEP_KEYS = [
  "filings",
  "import",
  "stripe",
  "recurring",
  "records-policy",
  "partners",
] as const;
export type FirstMonthStepKey = (typeof FIRST_MONTH_STEP_KEYS)[number];

export function isFirstMonthStepKey(value: unknown): value is FirstMonthStepKey {
  return (FIRST_MONTH_STEP_KEYS as readonly unknown[]).includes(value);
}

/** 第 1 期's 「設立から」 deadlines (24-calendar): their rule keys start with this. */
const FOUNDING_RULE_KEY_PREFIX = "founding.";

/** The filings step lists this many open deadlines; the rest are 「ほか n 件」. */
const FILINGS_DEADLINE_LIMIT = 3;

// ---------------------------------------------------------------------------
// Stored state (Company.setupGuide)
// ---------------------------------------------------------------------------

/** A step checked by hand: when (ISO timestamp) and by whom (the actor). */
export interface FirstMonthCheck {
  at: string;
  by: string;
}

export interface SetupGuideState {
  checked: Partial<Record<FirstMonthStepKey, FirstMonthCheck>>;
  /** 「ホームに表示する」 (10 §4.1): set = the card shows even when every step is done. */
  shownAt: string | null;
}

const checkSchema = z.object({ at: z.string().min(1), by: z.string().min(1) });

const storedStateSchema = z.object({
  checked: z.record(z.string(), z.unknown()).optional().catch(undefined),
  shownAt: z.string().min(1).nullable().optional().catch(null),
});

function emptyState(): SetupGuideState {
  return { checked: {}, shownAt: null };
}

/**
 * `Company.setupGuide` read back defensively: `null`, a broken value or an unknown key reads as
 * nothing checked (never throws: the home must render whatever is stored).
 */
export function readSetupGuideState(value: unknown): SetupGuideState {
  const parsed = storedStateSchema.safeParse(value);
  if (!parsed.success) return emptyState();
  const checked: SetupGuideState["checked"] = {};
  for (const key of FIRST_MONTH_STEP_KEYS) {
    const entry = checkSchema.safeParse(parsed.data.checked?.[key]);
    if (entry.success) checked[key] = { at: entry.data.at, by: entry.data.by };
  }
  return { checked, shownAt: parsed.data.shownAt ?? null };
}

function toStoredState(state: SetupGuideState): Prisma.InputJsonObject {
  const checked: Record<string, Prisma.InputJsonObject> = {};
  for (const key of FIRST_MONTH_STEP_KEYS) {
    const entry = state.checked[key];
    if (entry) checked[key] = { at: entry.at, by: entry.by };
  }
  return { checked, shownAt: state.shownAt };
}

// ---------------------------------------------------------------------------
// The guide (pure)
// ---------------------------------------------------------------------------

/** What the lanes' reads say about the book (10 §3.1's 「済み（自動の判定）」). */
export interface FirstMonthFacts {
  /** A CSV import or a bank API sync went through once (a Stripe sync is the next step; a sync
   *  that failed as a whole, `ImportBatch.error`, does not count). */
  hasImportBatch: boolean;
  /** Active Stripe wallets: any at all, and any connected. */
  stripe: { hasWallet: boolean; connected: boolean };
  activeRecurringCount: number;
  /** 証憑の規程's 施行日 (13 §5); `null` while not in force. */
  policyEffectiveOn: CalendarDate | null;
  activePartnerCount: number;
  /** 第 1 期's deadlines of the rules `founding.*` (24-calendar). */
  foundingDeadlines: readonly {
    id: string;
    title: string;
    dueDate: CalendarDate;
    completed: boolean;
  }[];
}

/** An open founding deadline under the filings step, with its state text (24 §1). */
export interface FirstMonthDeadline {
  id: string;
  title: string;
  dueDate: CalendarDate;
  /** 期限切れ / 今日まで / あと n 日 / 未完了. */
  statusText: string;
  /** How the text is shown: 期限切れ in the warn colour, 今日まで and あと n 日 bold, 未完了 muted. */
  status: "overdue" | "today" | "soon" | "open";
}

export interface FirstMonthStep {
  key: FirstMonthStepKey;
  /** 項目 (a noun phrase, 05 §4). */
  title: string;
  /** One sentence: what to do and where. */
  description: string;
  href: string;
  /** The entry's label: a result verb. */
  cta: string;
  done: boolean;
  /** `auto`: the book shows it is done (cannot be turned back); `manual`: 「済みにする」. */
  doneBy: "auto" | "manual" | null;
  /** When it was checked by hand (ISO), whether or not the book shows it done since. */
  checkedAt: string | null;
  /** Filings only: the open founding deadlines, nearest first (at most 3). Empty for the others. */
  deadlines: FirstMonthDeadline[];
  /** Filings only: open founding deadlines beyond `deadlines` (「ほか n 件」). */
  moreDeadlines: number;
  /** Filings only: no founding deadline yet (made by the morning sync after the company). */
  noDeadlinesYet: boolean;
}

export interface FirstMonthGuide {
  steps: FirstMonthStep[];
  doneCount: number;
  total: number;
  allDone: boolean;
  /** 「ホームに表示する」 is on (the card shows after everything is done, until 「閉じる」). */
  shownAgain: boolean;
  /** The home shows the card: something is left, or it was shown again. */
  visible: boolean;
}

interface StepText {
  title: string;
  description: string;
  href: string;
  cta: string;
}

function stepText(key: FirstMonthStepKey, facts: FirstMonthFacts): StepText {
  switch (key) {
    case "filings":
      return {
        title: "税務の届出",
        description: "設立から期限のある届出を出し、期限の一覧で完了にします",
        href: "/calendar",
        cta: "期限を見る",
      };
    case "import":
      return {
        title: "明細の取込",
        description: "銀行・カードの明細を CSV で取り込むか、銀行の API を接続します",
        href: "/imports",
        cta: "取り込む",
      };
    case "stripe":
      return facts.stripe.hasWallet
        ? {
            title: "Stripe の接続",
            description: "Stripe の口座に読み取り専用のキーを登録して同期します",
            href: "/imports",
            cta: "接続する",
          }
        : {
            title: "Stripe の接続",
            description: "Stripe を使うなら、設定 › 口座 で Stripe の口座を作ります",
            href: "/settings/wallets",
            cta: "口座を作る",
          };
    case "recurring":
      return {
        title: "定期取引の登録（家賃・役員報酬）",
        description: "家賃や役員報酬など毎月の支払いを登録すると、予定日に「やること」に出ます",
        href: "/settings/recurring",
        cta: "登録する",
      };
    case "records-policy":
      return {
        title: "証憑の規程",
        description: "電子取引データの保存の規程に施行日と責任者を入れて定めます",
        href: "/settings/documents-policy",
        cta: "定める",
      };
    case "partners":
      return {
        title: "取引先の登録",
        description: "よく使う取引先を登録すると、取引と証憑で選べます",
        href: "/settings/partners",
        cta: "登録する",
      };
  }
}

/** 10 §3.1's table: when the book itself shows the step is done. */
function doneAutomatically(key: FirstMonthStepKey, facts: FirstMonthFacts): boolean {
  switch (key) {
    case "filings":
      return (
        facts.foundingDeadlines.length > 0 &&
        facts.foundingDeadlines.every((item) => item.completed)
      );
    case "import":
      return facts.hasImportBatch;
    case "stripe":
      return facts.stripe.connected;
    case "recurring":
      return facts.activeRecurringCount > 0;
    case "records-policy":
      return facts.policyEffectiveOn !== null;
    case "partners":
      return facts.activePartnerCount > 0;
  }
}

/** The state text of an open deadline on `today` (24 §1). */
function deadlineOf(
  item: FirstMonthFacts["foundingDeadlines"][number],
  today: CalendarDate,
): FirstMonthDeadline {
  const status = calendarItemStatus({ dueDate: item.dueDate, completedAt: null }, today);
  const base = { id: item.id, title: item.title, dueDate: item.dueDate };
  switch (status.kind) {
    case "overdue":
      return { ...base, status: "overdue", statusText: "期限切れ" };
    case "today":
      return { ...base, status: "today", statusText: "今日まで" };
    case "soon":
      return { ...base, status: "soon", statusText: `あと ${status.days} 日` };
    case "open":
    case "completed":
      return { ...base, status: "open", statusText: "未完了" };
  }
}

function openFoundingDeadlines(facts: FirstMonthFacts): FirstMonthFacts["foundingDeadlines"] {
  return facts.foundingDeadlines
    .filter((item) => !item.completed)
    .sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * The guide on `today` (pure): each step done automatically (the book shows it) or by hand
 * (「済みにする」), the filings step with the nearest open founding deadlines, and whether the home
 * shows the card (something left, or 「ホームに表示する」).
 */
export function buildFirstMonthGuide(
  facts: FirstMonthFacts,
  state: SetupGuideState,
  today: CalendarDate,
): FirstMonthGuide {
  const steps = FIRST_MONTH_STEP_KEYS.map((key): FirstMonthStep => {
    const auto = doneAutomatically(key, facts);
    const check = state.checked[key] ?? null;
    const doneBy = auto ? "auto" : check ? "manual" : null;
    const step: FirstMonthStep = {
      key,
      ...stepText(key, facts),
      done: doneBy !== null,
      doneBy,
      checkedAt: check?.at ?? null,
      deadlines: [],
      moreDeadlines: 0,
      noDeadlinesYet: false,
    };
    if (key !== "filings") return step;
    const open = openFoundingDeadlines(facts);
    return {
      ...step,
      deadlines: open.slice(0, FILINGS_DEADLINE_LIMIT).map((item) => deadlineOf(item, today)),
      moreDeadlines: Math.max(open.length - FILINGS_DEADLINE_LIMIT, 0),
      noDeadlinesYet: facts.foundingDeadlines.length === 0,
    };
  });
  const doneCount = steps.filter((step) => step.done).length;
  const allDone = doneCount === steps.length;
  const shownAgain = state.shownAt !== null;
  return {
    steps,
    doneCount,
    total: steps.length,
    allDone,
    shownAgain,
    visible: !allDone || shownAgain,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The facts from each lane's own reads (10 §3.1). The company must exist. */
export async function loadFirstMonthFacts(db: Db): Promise<FirstMonthFacts> {
  const [importedBatches, wallets, activeRecurringCount, policy, partners, calendar, foundingRows] =
    await Promise.all([
      // The import history (`listImportBatches`) has every source and failed syncs: count the
      // bank and card statements that came in.
      db.importBatch.count({ where: { source: { in: ["csv", "api"] }, error: null } }),
      listImportableWallets(db),
      countActiveRecurringItems(db),
      getRecordsPolicy(db),
      listPartners(db),
      listCalendarItems(db),
      // The calendar's list has no rule keys: which of its items are founding filings.
      db.calendarItem.findMany({
        where: { ruleKey: { startsWith: FOUNDING_RULE_KEY_PREFIX } },
        select: { id: true },
      }),
    ]);
  const stripeWallets = wallets.filter((wallet) => wallet.kind === "stripe");
  const foundingIds = new Set(foundingRows.map((row) => row.id));
  const firstYear = calendar.find((group) => group.fiscalYear?.no === 1);
  const firstYearItems = firstYear ? [...firstYear.open, ...firstYear.completed] : [];
  return {
    hasImportBatch: importedBatches > 0,
    stripe: {
      hasWallet: stripeWallets.length > 0,
      connected: stripeWallets.some((wallet) => wallet.stripe?.connected === true),
    },
    activeRecurringCount,
    policyEffectiveOn: policy.effectiveOn,
    activePartnerCount: partners.filter((partner) => partner.isActive).length,
    foundingDeadlines: firstYearItems
      .filter((item) => foundingIds.has(item.id))
      .map((item) => ({
        id: item.id,
        title: item.title,
        dueDate: item.dueDate,
        completed: item.completedAt !== null,
      })),
  };
}

/** The guide on `today`, or `null` before the company is registered. */
export async function loadFirstMonthGuide(
  db: Db,
  today: CalendarDate,
): Promise<FirstMonthGuide | null> {
  const company = await db.company.findFirst({
    orderBy: { createdAt: "asc" },
    select: { setupGuide: true },
  });
  if (!company) return null;
  return buildFirstMonthGuide(
    await loadFirstMonthFacts(db),
    readSetupGuideState(company.setupGuide),
    today,
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const UNKNOWN_STEP = "この手順は見つかりません。画面を読み込み直してから、もう一度試してください";

function requireStepKey(key: unknown): FirstMonthStepKey {
  if (!isFirstMonthStepKey(key)) throw new SettingsError(UNKNOWN_STEP);
  return key;
}

/**
 * One change of the stored state in one transaction (10 §3.1): the company's lock → read → change
 * → audit log. `change` returns `null` when the state already is so: nothing is written or logged.
 */
async function changeSetupGuide(
  db: Db,
  action: string,
  change: (state: SetupGuideState) => SetupGuideState | null,
  options: WriteOptions,
): Promise<SetupGuideState> {
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "company");
    const company = await requireCompanyRow(tx);
    const current = readSetupGuideState(company.setupGuide);
    const next = change(current);
    if (next === null) return current;
    const stored = toStoredState(next);
    await tx.company.update({ where: { id: company.id }, data: { setupGuide: stored } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action,
      entity: "company",
      entityId: company.id,
      before: { setupGuide: company.setupGuide },
      after: { setupGuide: stored },
    });
    return next;
  });
}

/** 「済みにする」: records when and by whom (audit `setup.guide_check`). */
export async function checkFirstMonthStep(
  db: Db,
  input: { key: string },
  options: WriteOptions,
): Promise<SetupGuideState> {
  const key = requireStepKey(input.key);
  return changeSetupGuide(
    db,
    "setup.guide_check",
    (state) =>
      state.checked[key]
        ? null
        : {
            ...state,
            checked: {
              ...state.checked,
              [key]: { at: new Date().toISOString(), by: options.actor },
            },
          },
    options,
  );
}

/** 「未了に戻す」: removes the check (audit `setup.guide_uncheck`). */
export async function uncheckFirstMonthStep(
  db: Db,
  input: { key: string },
  options: WriteOptions,
): Promise<SetupGuideState> {
  const key = requireStepKey(input.key);
  return changeSetupGuide(
    db,
    "setup.guide_uncheck",
    (state) => {
      if (!state.checked[key]) return null;
      const { [key]: _removed, ...checked } = state.checked;
      return { ...state, checked };
    },
    options,
  );
}

/** 設定 › 事業所 「ホームに表示する」 (10 §4.1): audit `setup.guide_show`. */
export async function showFirstMonthGuide(db: Db, options: WriteOptions): Promise<SetupGuideState> {
  return changeSetupGuide(
    db,
    "setup.guide_show",
    (state) => (state.shownAt !== null ? null : { ...state, shownAt: new Date().toISOString() }),
    options,
  );
}

/** 「閉じる」 on the card shown again: audit `setup.guide_close`. */
export async function closeFirstMonthGuide(
  db: Db,
  options: WriteOptions,
): Promise<SetupGuideState> {
  return changeSetupGuide(
    db,
    "setup.guide_close",
    (state) => (state.shownAt === null ? null : { ...state, shownAt: null }),
    options,
  );
}
