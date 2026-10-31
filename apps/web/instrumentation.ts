/** Called once when a server process starts (Next.js): the warm-up of `lib/startup.ts` (#82). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmUpOnStart } = await import("./lib/startup");
  warmUpOnStart();
}
