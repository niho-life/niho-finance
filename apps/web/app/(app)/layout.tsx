import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { loadShell, requireSetupReady } from "@/lib/data";

/** Pages inside the app frame. Without a company (setup steps 1–3) the wizard opens instead. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSetupReady();
  const shell = await loadShell();
  return (
    <AppShell companyName={shell.companyName} fiscalYearNo={shell.fiscalYearNo}>
      {children}
    </AppShell>
  );
}
