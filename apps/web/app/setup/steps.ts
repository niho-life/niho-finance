import type { SetupProgress, SetupStep } from "@niho-finance/db";

/** Wizard steps as they appear in the URL (`/setup?step=…`) and in the progress bar. */
export type WizardStep = SetupStep | "complete";

export const WIZARD_STEPS: readonly { step: WizardStep; slug: string; label: string }[] = [
  { step: "company", slug: "company", label: "事業所" },
  { step: "fiscal_year", slug: "fiscal-year", label: "会計期間" },
  { step: "accounts", slug: "accounts", label: "勘定科目" },
  { step: "wallets", slug: "wallets", label: "口座" },
  { step: "opening", slug: "opening", label: "開始仕訳" },
  { step: "complete", slug: "done", label: "完了" },
];

export function stepFromSlug(slug: string | string[] | undefined): WizardStep | null {
  if (typeof slug !== "string") return null;
  return WIZARD_STEPS.find((item) => item.slug === slug)?.step ?? null;
}

export function stepHref(step: WizardStep): `/setup?step=${string}` {
  const slug = WIZARD_STEPS.find((item) => item.step === step)?.slug ?? "company";
  return `/setup?step=${slug}`;
}

/** A step can be opened once the steps it builds on are done (4 and 5 need 1–3). */
export function isReachable(step: WizardStep, progress: SetupProgress): boolean {
  switch (step) {
    case "company":
      return true;
    case "fiscal_year":
      return progress.done.company;
    case "accounts":
      return progress.done.company && progress.done.fiscal_year;
    case "wallets":
    case "opening":
      return progress.ready;
    case "complete":
      return progress.current === "complete";
  }
}
