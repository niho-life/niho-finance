/**
 * A failed request to the National Tax Agency's publication API. The message is owner-facing and
 * never contains the URL: the URL carries the application ID (20-reader §8.1).
 */
export class NtaApiError extends Error {
  override readonly name = "NtaApiError";
  /** The HTTP status when the server answered, `null` otherwise. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}
