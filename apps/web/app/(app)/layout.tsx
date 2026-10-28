import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { ActorError } from "@/lib/actor";
import { currentUser } from "@/lib/authz";
import { loadShell, requireSetupReady } from "@/lib/data";

/** 閲覧 (or anyone not a known user) sees the navigation of 閲覧 (23 §3.4). */
async function viewerNavigation(): Promise<boolean> {
  try {
    const user = await currentUser();
    return user.state === "unregistered" || user.role === "viewer";
  } catch (error) {
    if (error instanceof ActorError) return true;
    throw error;
  }
}

/** Pages inside the app frame. Without a company (setup steps 1–3) the wizard opens instead. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSetupReady();
  const shell = await loadShell();
  const viewer = await viewerNavigation();
  return (
    <AppShell companyName={shell.companyName} fiscalYearNo={shell.fiscalYearNo} viewer={viewer}>
      {children}
    </AppShell>
  );
}
