import type { ReactNode } from "react";
import { BankOutcomeProvider } from "./feedback";

/** Keeps the outcome of the last operation while the page refreshes (feedback.tsx). */
export default function BankLinkLayout({ children }: { children: ReactNode }) {
  return <BankOutcomeProvider>{children}</BankOutcomeProvider>;
}
