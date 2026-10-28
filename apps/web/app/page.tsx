import { connection } from "next/server";
import { appEnvironment } from "@/lib/env";

export default async function HomePage() {
  // Rendered per request: the environment name comes from the runtime environment.
  await connection();
  const environment = appEnvironment();
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-2 px-6">
      <h1 className="text-2xl font-semibold">NIHO finance</h1>
      <p className="text-sm text-[var(--muted)]">環境: {environment}</p>
    </main>
  );
}
