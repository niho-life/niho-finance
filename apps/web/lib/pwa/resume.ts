/** A page hidden at least this long is read again when it comes back to the front (10 §1.1). */
export const RESUME_REFRESH_AFTER_MS = 60_000;

/**
 * Whether a page that was hidden at `hiddenAt` (epoch ms; `null`: it was not hidden) is read again
 * when it is shown at `now`. A clock that went backwards reads nothing.
 */
export function shouldRefreshOnResume(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt >= RESUME_REFRESH_AFTER_MS;
}
