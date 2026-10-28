import { randomInt } from "node:crypto";
import {
  createFixtureNtaLookup,
  type NtaLookup,
  type NtaRegistration,
} from "@niho-finance/importers";
import { isValidInvoiceRegistrationNumber, type CalendarDate } from "@niho-finance/ledger";
import type { InvoiceRegistrationStatus, Partner, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkPartnerRegistrations,
  countCheckablePartners,
  listPartnerRegistrations,
  newId,
  partnerRegistrationAt,
  registrationStatusLabel,
  toDbDate,
  updatePartner,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber } from "./support/fictional";
import { testPrisma } from "./support/prisma";

const actor = "tester@example.com";
const NOW = new Date("2026-10-28T01:00:00.000Z");
const HTTP_503 = "国税庁の公表サイトに接続できませんでした（HTTP 503）";

/** `T` + a fictional corporate number (a base of 9s with its check digit). */
function fictionalRegistrationNumber(): string {
  return `T${fictionalCorporateNumber(`9999${String(randomInt(0, 100_000_000)).padStart(8, "0")}`)}`;
}

function registration(
  number: string,
  name: string,
  fields: Partial<NtaRegistration> = {},
): NtaRegistration {
  return {
    number,
    name,
    kind: "corporation",
    registeredOn: "2023-10-01",
    endedOn: null,
    endReason: null,
    lastUpdateDate: "2026-10-27",
    ...fields,
  };
}

/** Records the numbers asked for; the numbers in `failing` fail like an HTTP 503. */
function spyLookup(
  registrations: readonly NtaRegistration[],
  failing: readonly string[] = [],
): NtaLookup & { calls: string[][] } {
  const fixture = createFixtureNtaLookup(registrations);
  const calls: string[][] = [];
  return {
    calls,
    async lookup(numbers) {
      calls.push([...numbers]);
      const failed = numbers.filter((number) => failing.includes(number));
      const result = await fixture.lookup(numbers.filter((number) => !failing.includes(number)));
      if (failed.length > 0) result.failures.push({ numbers: failed, message: HTTP_503 });
      return result;
    },
  };
}

function day(date: CalendarDate | null): Date | null {
  return date === null ? null : toDbDate(date);
}

describe("partnerRegistrationAt", () => {
  const partner = (
    status: InvoiceRegistrationStatus,
    registeredOn: CalendarDate | null,
    endedOn: CalendarDate | null = null,
  ) => ({
    invoiceRegistrationStatus: status,
    invoiceRegisteredOn: day(registeredOn),
    invoiceRegistrationEndedOn: day(endedOn),
  });

  it("is unknown until looked up, and not registered when not published", () => {
    // A changed number resets the status; the old dates are not read.
    expect(partnerRegistrationAt(partner("unknown", "2023-10-01"), "2026-10-05")).toBe("unknown");
    expect(partnerRegistrationAt(partner("not_found", null), "2026-10-05")).toBe("not_registered");
  });

  it("is registered from the registration day and until the day before the end", () => {
    const verified = partner("verified", "2023-10-01");
    expect(partnerRegistrationAt(verified, "2023-09-30")).toBe("not_registered");
    expect(partnerRegistrationAt(verified, "2023-10-01")).toBe("registered");
    const ended = partner("revoked", "2023-10-01", "2025-03-31");
    expect(partnerRegistrationAt(ended, "2025-03-30")).toBe("registered");
    expect(partnerRegistrationAt(ended, "2025-03-31")).toBe("not_registered");
  });

  it("labels the status for the partner list", () => {
    expect(registrationStatusLabel({ status: "unknown", registeredOn: null, endedOn: null })).toBe(
      "未照合",
    );
    expect(
      registrationStatusLabel({ status: "not_found", registeredOn: null, endedOn: null }),
    ).toBe("未登録");
    expect(
      registrationStatusLabel({ status: "verified", registeredOn: "2023-10-01", endedOn: null }),
    ).toBe("登録あり（2023/10/01〜）");
    expect(
      registrationStatusLabel({
        status: "verified",
        registeredOn: "2023-10-01",
        endedOn: "2027-01-01",
      }),
    ).toBe("登録あり（2023/10/01〜2026/12/31）");
    expect(
      registrationStatusLabel({
        status: "revoked",
        registeredOn: "2023-10-01",
        endedOn: "2025-03-31",
      }),
    ).toBe("登録終了（2025/03/31）");
  });
});

/** Registry checks on the seeded book. Each test adds its own partners (and names their IDs). */
describe.skipIf(!hasTestDatabase)("registry check", () => {
  let prisma: PrismaClient;
  let suffix: string;

  beforeAll(() => {
    prisma = testPrisma();
    suffix = newId().slice(-6);
  });

  async function partner(
    label: string,
    fields: { number?: string | null; isActive?: boolean } = {},
  ): Promise<Partner> {
    return prisma.partner.create({
      data: {
        id: newId(),
        name: `架空照合${label}${suffix}`,
        kind: "vendor",
        invoiceRegistrationNumber:
          fields.number === undefined ? fictionalRegistrationNumber() : fields.number,
        isActive: fields.isActive ?? true,
      },
    });
  }

  async function reload(row: Partner): Promise<Partner> {
    return prisma.partner.findUniqueOrThrow({ where: { id: row.id } });
  }

  async function checksOf(row: Partner) {
    return prisma.auditLog.findMany({
      where: { entity: "partner", entityId: row.id, action: "partner.registry_check" },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
  }

  async function registryUsage() {
    return prisma.externalApiUsage.findMany({
      where: { service: "registry", actor },
      orderBy: { id: "asc" },
    });
  }

  it("stores the five columns, audits the changed partners and records the lookup", async () => {
    const registered = await partner("登録");
    const unpublished = await partner("未登録");
    const ended = await partner("失効");
    const failing = await partner("失敗");
    const malformed = await partner("誤番号", { number: "T1234567890123" });
    const inactive = await partner("休止", { isActive: false });
    const without = await partner("番号なし", { number: null });
    expect(isValidInvoiceRegistrationNumber("T1234567890123")).toBe(false);
    const all = [registered, unpublished, ended, failing, malformed, inactive, without];
    const numberOf = (row: Partner) => row.invoiceRegistrationNumber ?? "";

    const publication = [
      registration(numberOf(registered), "架空登録株式会社"),
      registration(numberOf(ended), "架空失効株式会社", {
        endedOn: "2025-03-31",
        endReason: "expired",
      }),
      registration(numberOf(failing), "架空失敗株式会社"),
      registration(numberOf(inactive), "架空休止株式会社"),
    ];
    const lookup = spyLookup(publication, [numberOf(failing)]);
    const usageBefore = (await registryUsage()).length;

    const result = await checkPartnerRegistrations(prisma, lookup, {
      actor,
      partnerIds: all.map((row) => row.id),
      now: NOW,
    });

    expect(result).toEqual({
      checked: 3,
      registered: 1,
      notRegistered: 1,
      ended: 1,
      failed: 1,
      errors: [HTTP_503],
    });
    // Only the active partners with a valid number were sent.
    expect(lookup.calls).toHaveLength(1);
    expect([...(lookup.calls[0] ?? [])].sort()).toEqual(
      [registered, unpublished, ended, failing].map(numberOf).sort(),
    );

    expect(await reload(registered)).toMatchObject({
      invoiceRegistrationStatus: "verified",
      invoiceRegistrationName: "架空登録株式会社",
      invoiceRegisteredOn: day("2023-10-01"),
      invoiceRegistrationEndedOn: null,
      invoiceRegistrationCheckedAt: NOW,
    });
    expect(await reload(unpublished)).toMatchObject({
      invoiceRegistrationStatus: "not_found",
      invoiceRegistrationName: null,
      invoiceRegisteredOn: null,
      invoiceRegistrationCheckedAt: NOW,
    });
    expect(await reload(ended)).toMatchObject({
      invoiceRegistrationStatus: "revoked",
      invoiceRegistrationEndedOn: day("2025-03-31"),
      invoiceRegistrationCheckedAt: NOW,
    });
    for (const row of [failing, malformed, inactive, without]) {
      expect(await reload(row)).toMatchObject({
        invoiceRegistrationStatus: "unknown",
        invoiceRegistrationName: null,
        invoiceRegistrationCheckedAt: null,
      });
    }

    const [check] = await checksOf(registered);
    expect(check).toMatchObject({
      actor,
      before: {
        invoiceRegistrationStatus: "unknown",
        invoiceRegistrationName: null,
        invoiceRegisteredOn: null,
        invoiceRegistrationEndedOn: null,
        invoiceRegistrationCheckedAt: null,
      },
      after: {
        invoiceRegistrationStatus: "verified",
        invoiceRegistrationName: "架空登録株式会社",
        invoiceRegisteredOn: "2023-10-01T00:00:00.000Z",
        invoiceRegistrationEndedOn: null,
        invoiceRegistrationCheckedAt: NOW.toISOString(),
      },
    });
    for (const row of [unpublished, ended]) expect(await checksOf(row)).toHaveLength(1);
    for (const row of [failing, malformed, inactive, without]) {
      expect(await checksOf(row)).toEqual([]);
    }

    const usage = await registryUsage();
    expect(usage).toHaveLength(usageBefore + 1);
    expect(usage.at(-1)).toMatchObject({
      provider: "nta",
      model: null,
      documentId: null,
      outcome: "failed",
      error: HTTP_503,
      requestCount: 1,
      itemCount: 4,
      costNanoUsd: 0n,
    });

    const views = await listPartnerRegistrations(prisma);
    expect(views.get(registered.id)).toEqual({
      status: "verified",
      name: "架空登録株式会社",
      registeredOn: "2023-10-01",
      endedOn: null,
      checkedAt: NOW,
    });
    expect(
      registrationStatusLabel(
        views.get(ended.id) ?? { status: "unknown", registeredOn: null, endedOn: null },
      ),
    ).toBe("登録終了（2025/03/31）");

    // The next check: the failed number now answers; the others change only their check time.
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const again = await checkPartnerRegistrations(prisma, spyLookup(publication), {
      actor,
      partnerIds: all.map((row) => row.id),
      now: later,
    });
    expect(again).toEqual({
      checked: 4,
      registered: 2,
      notRegistered: 1,
      ended: 1,
      failed: 0,
      errors: [],
    });
    expect(await checksOf(failing)).toHaveLength(1);
    for (const row of [registered, unpublished, ended]) {
      expect(await checksOf(row)).toHaveLength(1);
      expect((await reload(row)).invoiceRegistrationCheckedAt).toEqual(later);
    }
    const grouped = await prisma.auditLog.findFirstOrThrow({
      where: { entity: "partner", entityId: null, action: "partner.registry_check", actor },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(grouped.after).toEqual({
      checkedAt: later.toISOString(),
      unchangedCount: 3,
      partnerIds: expect.arrayContaining([registered.id, unpublished.id, ended.id]) as unknown,
    });
    expect((grouped.after as { partnerIds: string[] }).partnerIds).toHaveLength(3);
    expect((await registryUsage()).at(-1)).toMatchObject({ outcome: "ok", error: null });
  });

  it("does not read the published values of a changed number", async () => {
    const row = await partner("変更");
    await checkPartnerRegistrations(
      prisma,
      spyLookup([registration(row.invoiceRegistrationNumber ?? "", "架空変更株式会社")]),
      { actor, partnerIds: [row.id], now: NOW },
    );
    expect((await listPartnerRegistrations(prisma)).get(row.id)?.status).toBe("verified");

    await updatePartner(
      prisma,
      { id: row.id, invoiceRegistrationNumber: fictionalRegistrationNumber() },
      { actor },
    );
    const stored = await reload(row);
    expect(stored.invoiceRegistrationStatus).toBe("unknown");
    // The old columns stay, but are not read while `unknown`.
    expect(stored.invoiceRegistrationName).toBe("架空変更株式会社");
    expect((await listPartnerRegistrations(prisma)).get(row.id)).toEqual({
      status: "unknown",
      name: null,
      registeredOn: null,
      endedOn: null,
      checkedAt: null,
    });
    expect(partnerRegistrationAt(stored, "2026-10-05")).toBe("unknown");
  });

  it("does nothing without a partner to look up", async () => {
    const without = await partner("対象なし", { number: null });
    const lookup = spyLookup([]);
    const usageBefore = (await registryUsage()).length;
    expect(
      await checkPartnerRegistrations(prisma, lookup, { actor, partnerIds: [without.id] }),
    ).toEqual({ checked: 0, registered: 0, notRegistered: 0, ended: 0, failed: 0, errors: [] });
    expect(lookup.calls).toEqual([]);
    expect(await registryUsage()).toHaveLength(usageBefore);
  });

  it("counts the active partners with a valid number", async () => {
    const before = await countCheckablePartners(prisma);
    await partner("数1");
    await partner("数2", { number: "T1234567890123" });
    await partner("数3", { isActive: false });
    await partner("数4", { number: null });
    expect(await countCheckablePartners(prisma)).toBe(before + 1);
  });
});
