/**
 * Calls of external APIs (20-reader §9): one `external_api_usage` row per reading or registry
 * lookup, with the tokens and the cost in 10⁻⁹ USD (integers). The table is append-only (DB
 * triggers reject UPDATE / DELETE / TRUNCATE). `reading.ts` re-exports these.
 */
import type { Db } from "./audit";
import { newId } from "./ids";

export const API_USAGE_SERVICES = ["reader", "registry"] as const;
export type ApiUsageService = (typeof API_USAGE_SERVICES)[number];

/** One call, without who made it and what it was about (`recordDocumentReading` adds those). */
export interface ApiUsageCall {
  service: ApiUsageService;
  /** `anthropic` / `recorded` / `nta` / `fixture`. */
  provider: string;
  model?: string | null;
  outcome: "ok" | "failed";
  error?: string | null;
  /** Requests actually sent (defaults to 1). */
  requestCount?: number;
  /** Numbers looked up (registry). */
  itemCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costNanoUsd?: bigint;
}

export interface ApiUsageRow extends ApiUsageCall {
  documentId?: string | null;
  actor: string;
}

export interface ApiUsageSummary {
  count: number;
  ok: number;
  failed: number;
  requestCount: number;
  itemCount: number;
  inputTokens: number;
  outputTokens: number;
  /** 10⁻⁹ USD. */
  costNanoUsd: bigint;
}

/** Appends one row (the readings and the registry job both use it). */
export async function recordApiUsage(db: Db, row: ApiUsageRow): Promise<void> {
  await db.externalApiUsage.create({
    data: {
      id: newId(),
      service: row.service,
      provider: row.provider,
      model: row.model ?? null,
      documentId: row.documentId ?? null,
      outcome: row.outcome,
      error: row.error ?? null,
      requestCount: row.requestCount ?? 1,
      itemCount: row.itemCount ?? 0,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      costNanoUsd: row.costNanoUsd ?? 0n,
      actor: row.actor,
    },
  });
}

/** Totals of one service's calls with `from <= at < to` (e.g. this month: 今月の読み取り). */
export async function summarizeApiUsage(
  db: Db,
  options: { service: ApiUsageService; from: Date; to: Date },
): Promise<ApiUsageSummary> {
  const groups = await db.externalApiUsage.groupBy({
    by: ["outcome"],
    where: { service: options.service, at: { gte: options.from, lt: options.to } },
    _count: { _all: true },
    _sum: {
      requestCount: true,
      itemCount: true,
      inputTokens: true,
      outputTokens: true,
      costNanoUsd: true,
    },
  });
  const summary: ApiUsageSummary = {
    count: 0,
    ok: 0,
    failed: 0,
    requestCount: 0,
    itemCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costNanoUsd: 0n,
  };
  for (const group of groups) {
    const count = group._count._all;
    summary.count += count;
    if (group.outcome === "ok") summary.ok += count;
    else summary.failed += count;
    summary.requestCount += group._sum.requestCount ?? 0;
    summary.itemCount += group._sum.itemCount ?? 0;
    summary.inputTokens += group._sum.inputTokens ?? 0;
    summary.outputTokens += group._sum.outputTokens ?? 0;
    summary.costNanoUsd += group._sum.costNanoUsd ?? 0n;
  }
  return summary;
}
