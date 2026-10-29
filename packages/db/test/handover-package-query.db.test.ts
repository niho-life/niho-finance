import { randomBytes } from "node:crypto";
import { documentIndexCells } from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  findHandoverRequest,
  HANDOVER_EXPORT_KIND,
  HANDOVER_PACKAGE_AUDIT_ACTION,
  listHandoverRequests,
  listRecentExportsWithPackages,
  loadDocumentsForArchive,
  loadHandoverDocuments,
  newId,
  recordExport,
  recordHandoverDirectDownload,
  recordHandoverFailed,
  recordHandoverReady,
  recordHandoverRequest,
  recordHandoverStoredDownload,
  registerDocument,
  voidDocument,
  type DocumentRegisterInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";

/*
 * 受け渡しパッケージ (14-reports §16.5–§16.6): the documents of the year with their index rows, and
 * the phases of `export.package` resolved into requests (requested → ready / failed → downloaded).
 * A period of its own (2052) keeps the shared test database's other documents out.
 */

const actor = "tester@example.com";
const RANGE = { from: "2052-04-01", to: "2053-03-31" } as const;

function fileInput(overrides: Partial<DocumentRegisterInput> = {}): DocumentRegisterInput {
  return {
    storageKey: `documents/2052/05/${newId()}.pdf`,
    sha256: randomBytes(32).toString("hex"),
    mime: "application/pdf",
    byteSize: 12_345,
    originalName: "receipt.pdf",
    source: "upload",
    ...overrides,
  };
}

describe.skipIf(!hasTestDatabase)("handover package queries", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
  });

  it("loads the archive's documents with their 13 §7 index rows and sizes", async () => {
    const a = await registerDocument(
      prisma,
      fileInput({ txnDate: "2052-05-01", amount: "11000", partnerName: "架空商店" }),
      { actor },
    );
    const b = await registerDocument(
      prisma,
      fileInput({
        txnDate: "2052-06-01",
        mime: "image/png",
        originalName: "scan.png",
        byteSize: 2_000,
      }),
      { actor },
    );
    await voidDocument(prisma, { id: b.document.id, reason: "重複して保存した" }, { actor });
    await registerDocument(prisma, fileInput({ txnDate: "2053-04-01" }), { actor });

    const documents = await loadHandoverDocuments(prisma, RANGE);
    const archive = await loadDocumentsForArchive(prisma, RANGE);
    expect(documents.map((document) => document.archive.id)).toEqual(
      archive.map((document) => document.id),
    );
    const ids = documents.map((document) => document.index.id);
    expect(ids).toEqual([a.document.id, b.document.id]);
    const [first, second] = documents;
    expect(first?.byteSize).toBe(12_345);
    expect(second?.byteSize).toBe(2_000);
    expect(first?.index.storageKey).toBe(first?.archive.storageKey);
    const cells = documentIndexCells(first!.index);
    expect(cells.slice(0, 4)).toEqual([a.document.id, "2052/05/01", "11000", "架空商店"]);
    expect(second?.index.status).toBe("voided");
    expect(second?.index.voidReason).toBe("重複して保存した");
    expect(await loadHandoverDocuments(prisma, { from: "2060-04-01", to: "2061-03-31" })).toEqual(
      [],
    );
  });

  it("resolves a request through ready and the signed-URL download", async () => {
    const period = {
      fiscalYearId: newId(),
      fiscalYearNo: 52,
      from: RANGE.from,
      to: RANGE.to,
      includeDocuments: true,
    };
    const requestId = await recordHandoverRequest(
      prisma,
      { ...period, estimateBytes: 30_000_000 },
      { actor },
    );
    const requestedAt = (await findHandoverRequest(prisma, requestId))!.requestedAt;
    expect(await findHandoverRequest(prisma, requestId, { now: requestedAt })).toMatchObject({
      requestId,
      requestedBy: actor,
      fiscalYearNo: 52,
      includeDocuments: true,
      estimateBytes: 30_000_000,
      state: "pending",
      key: null,
    });
    // A request still pending after 30 minutes has probably failed.
    const later = new Date(requestedAt.getTime() + 31 * 60_000);
    expect((await findHandoverRequest(prisma, requestId, { now: later }))?.state).toBe("stale");

    const key = `packages/20520510-1403_fy52_${requestId}.zip`;
    await recordHandoverReady(
      prisma,
      { requestId, key, fileCount: 20, bytes: 25_000_000 },
      { actor: "system" },
    );
    expect(await findHandoverRequest(prisma, requestId, { now: later })).toMatchObject({
      state: "ready",
      key,
      bytes: 25_000_000,
      fileCount: 20,
      reason: null,
    });
    await recordHandoverStoredDownload(prisma, { requestId }, { actor });

    const rows = await prisma.auditLog.findMany({
      where: { action: HANDOVER_PACKAGE_AUDIT_ACTION, entityId: requestId },
      orderBy: { at: "asc" },
    });
    expect(rows.map((row) => (row.after as { phase: string }).phase)).toEqual([
      "requested",
      "ready",
      "downloaded",
    ]);
    expect(rows.map((row) => row.actor)).toEqual([actor, "system", actor]);
    expect(rows[2]?.after).toEqual({ phase: "downloaded", delivery: "signed-url", requestId });
    expect(rows.every((row) => row.entity === "export")).toBe(true);

    const failedId = await recordHandoverRequest(
      prisma,
      { ...period, includeDocuments: false, estimateBytes: 2_097_152 },
      { actor },
    );
    await recordHandoverFailed(
      prisma,
      { requestId: failedId, reason: "証憑のファイルを読めませんでした" },
      { actor: "system" },
    );
    const listed = await listHandoverRequests(prisma, { limit: 10, now: later });
    expect(listed.slice(0, 2).map((request) => [request.requestId, request.state])).toEqual([
      [failedId, "failed"],
      [requestId, "ready"],
    ]);
    expect(listed[0]?.reason).toBe("証憑のファイルを読めませんでした");
    expect(await findHandoverRequest(prisma, newId())).toBeNull();
  });

  it("puts the package downloads in 最近の書き出し, with the period of the request", async () => {
    await recordHandoverDirectDownload(
      prisma,
      {
        fiscalYearNo: 53,
        from: "2053-04-01",
        to: "2054-03-31",
        includeDocuments: false,
        fileCount: 14,
        documentCount: 3,
        missingDocumentCount: 0,
        bytes: 123_456,
      },
      { actor },
    );
    const direct = await prisma.auditLog.findFirstOrThrow({
      where: { action: HANDOVER_PACKAGE_AUDIT_ACTION, entityId: null },
      orderBy: { at: "desc" },
    });
    expect(direct.after).toMatchObject({
      phase: "downloaded",
      delivery: "direct",
      fiscalYearNo: 53,
      includeDocuments: false,
      fileCount: 14,
      documentCount: 3,
      missingDocumentCount: 0,
      bytes: 123_456,
    });
    await recordExport(prisma, { kind: "freee", format: "csv" }, { actor });

    const recent = await listRecentExportsWithPackages(prisma, 50);
    expect(recent.map((row) => row.at.getTime())).toEqual(
      [...recent].map((row) => row.at.getTime()).sort((a, b) => b - a),
    );
    expect(recent[0]?.kind).toBe("freee");
    const packages = recent.filter((row) => row.kind === HANDOVER_EXPORT_KIND);
    expect(packages[0]).toMatchObject({ format: "zip", fiscalYearNo: 53, from: "2053-04-01" });
    // The signed-URL download takes the period of its request.
    expect(packages.some((row) => row.fiscalYearNo === 52 && row.from === RANGE.from)).toBe(true);
    // Requests, ready and failed rows are not downloads.
    expect(packages.every((row) => row.fiscalYearNo === 52 || row.fiscalYearNo === 53)).toBe(true);
    expect((await listRecentExportsWithPackages(prisma, 2)).length).toBe(2);
  });
});
