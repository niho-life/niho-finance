export type LogSeverity = "INFO" | "WARNING" | "ERROR";

/**
 * One structured log line on stdout. Cloud Logging takes `severity` and `message` from it and keeps
 * the rest as `jsonPayload` (alerts filter on `jsonPayload.event`). bigint becomes a decimal string.
 */
export function logEvent(
  severity: LogSeverity,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const entry = { severity, message: event, event, ...fields, time: new Date().toISOString() };
  console.log(
    JSON.stringify(entry, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}
