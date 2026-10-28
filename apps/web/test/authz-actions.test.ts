import type * as Db from "@niho-finance/db";
import type { UserAccess } from "@niho-finance/db";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

/*
 * Acceptance 1 of #21 (23-users-and-expenses §8): real Server Actions and routes called as 閲覧,
 * 経理, an unknown account and the first user. A refusal is `{ ok: false }` with the owner-facing
 * message, and nothing is written: no repository write, no audit log, no revalidation.
 */

const db = vi.hoisted(() => ({
  resolveUserAccess: vi.fn<(db: unknown, email: string) => Promise<UserAccess>>(),
  registerFirstOwner: vi.fn(),
  appendAuditLog: vi.fn(),
  postSimpleEntry: vi.fn(),
  updateCompany: vi.fn(),
  closeFiscalYearThrough: vi.fn(),
  submitExpenseClaim: vi.fn(),
  createUser: vi.fn(),
  recordExport: vi.fn(),
}));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@niho-finance/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  getPrismaClient: () => ({}),
  ...db,
}));
// No IAP assertion: the actor is NIHO_FINANCE_ACTOR (local).
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/cache", () => ({ revalidatePath }));

const EMAIL = "someone@example.com";
const { OWNER_ONLY_MESSAGE, UNREGISTERED_USER_MESSAGE, VIEWER_CANNOT_WRITE_MESSAGE } =
  await vi.importActual<typeof Db>("@niho-finance/db");

function registered(role: "owner" | "accountant" | "viewer"): UserAccess {
  return {
    state: "registered",
    user: {
      id: "user-1",
      email: EMAIL,
      name: null,
      role,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function as(access: UserAccess) {
  db.resolveUserAccess.mockResolvedValue(access);
}

const writes = () => [
  db.postSimpleEntry,
  db.updateCompany,
  db.closeFiscalYearThrough,
  db.submitExpenseClaim,
  db.createUser,
  db.appendAuditLog,
  db.recordExport,
  revalidatePath,
];

beforeAll(async () => {
  // Read the repository .env first, so the values set below win over it.
  const { loadRootEnv } = await vi.importActual<typeof Db>("@niho-finance/db");
  loadRootEnv();
  process.env.NIHO_FINANCE_ENV = "local";
  process.env.NIHO_FINANCE_ACTOR = EMAIL;
  delete process.env.NIHO_FINANCE_IAP_AUDIENCE;
});

/** `logEvent` writes JSON lines to stdout. */
let log: MockInstance<typeof console.log>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const { postSimpleEntryAction } = await import("@/app/(app)/entries/actions");
const { saveCompanyAction, closeFiscalYearAction } = await import("@/app/(app)/settings/actions");
const { submitExpenseClaimAction } = await import("@/app/(app)/expenses/actions");
const { createUserAction } = await import("@/app/(app)/settings/users/actions");
const { GET: downloadExport } = await import("@/app/(app)/settings/export/download/route");

const expense = {
  type: "expense",
  entryDate: "2026-11-10",
  description: "タクシー代",
  counterpart: "wallet:wallet-1",
  accountId: "account-1",
  amount: "1,100",
  taxCategoryCode: "purchase_10",
  segmentId: "segment-1",
  partnerId: "",
  memoTagIds: [],
};

describe("閲覧 (viewer)", () => {
  beforeEach(() => as(registered("viewer")));

  it("is refused by the write Server Actions, and nothing is written", async () => {
    const results = [
      await postSimpleEntryAction(expense),
      await saveCompanyAction(null, new FormData()),
      await submitExpenseClaimAction({ claimantId: "user-1", amount: "1100" }),
      await createUserAction({ email: "new@example.com", role: "viewer" }),
    ];
    for (const result of results) {
      expect(result).toMatchObject({ ok: false });
      if (result.ok) continue;
      expect(result.error).toBe(VIEWER_CANNOT_WRITE_MESSAGE);
    }
    for (const spy of writes()) expect(spy).not.toHaveBeenCalled();
    expect(db.registerFirstOwner).not.toHaveBeenCalled();
  });

  it("logs authz.denied with the role, never the email", async () => {
    await postSimpleEntryAction(expense);
    const lines = log.mock.calls.map((call) => String(call[0]));
    const denied = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "authz.denied");
    expect(denied).toMatchObject({ severity: "WARNING", minimum: "accountant", role: "viewer" });
    expect(lines.join("\n")).not.toContain(EMAIL);
  });

  it("gets 403 for the backup and the documents' archive, before anything is read", async () => {
    for (const kind of ["backup", "documents"]) {
      const response = await downloadExport(
        new Request(`http://localhost/settings/export/download?kind=${kind}`),
      );
      expect(response.status, kind).toBe(403);
      expect(await response.text()).toContain("閲覧の役割ではこのファイルを開けません");
    }
    expect(db.recordExport).not.toHaveBeenCalled();
  });
});

describe("経理 (accountant)", () => {
  beforeEach(() => as(registered("accountant")));

  it("is refused the 管理者-only close with its message", async () => {
    const result = await closeFiscalYearAction("fiscal-year-1", {
      lockedThrough: "2026-12-31",
      reason: "",
    });
    expect(result).toEqual({ ok: false, error: OWNER_ONLY_MESSAGE, fieldErrors: {} });
    expect(db.closeFiscalYearThrough).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("posts a 支出 (the repository is called as the actor)", async () => {
    db.postSimpleEntry.mockResolvedValue({ id: "entry-1", no: 7 });
    const result = await postSimpleEntryAction(expense);
    expect(result).toEqual({ ok: true, data: { id: "entry-1", no: 7 } });
    expect(db.postSimpleEntry).toHaveBeenCalledWith({}, expense, { actor: EMAIL });
  });
});

describe("an account that is not a user", () => {
  beforeEach(() => as({ state: "unregistered" }));

  it("is refused with the 未登録 message", async () => {
    const result = await postSimpleEntryAction(expense);
    expect(result).toMatchObject({ ok: false, error: UNREGISTERED_USER_MESSAGE });
    for (const spy of writes()) expect(spy).not.toHaveBeenCalled();
  });

  it("gets 403 for the exports of the books too", async () => {
    const response = await downloadExport(
      new Request("http://localhost/settings/export/download?kind=freee"),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(UNREGISTERED_USER_MESSAGE);
  });
});

describe("the first user of a book without users", () => {
  beforeEach(() => as({ state: "first_owner" }));

  it("is registered as 管理者 by the first authorized write, then the write runs", async () => {
    db.registerFirstOwner.mockResolvedValue({ created: true, user: registered("owner") });
    db.postSimpleEntry.mockResolvedValue({ id: "entry-2", no: 1 });
    const result = await postSimpleEntryAction(expense);
    expect(result).toMatchObject({ ok: true });
    expect(db.registerFirstOwner).toHaveBeenCalledWith({}, EMAIL, { actor: EMAIL });
    expect(db.registerFirstOwner.mock.invocationCallOrder[0]).toBeLessThan(
      db.postSimpleEntry.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("is refused when someone else became the first user meanwhile", async () => {
    const { SettingsError } = await vi.importActual<typeof Db>("@niho-finance/db");
    db.registerFirstOwner.mockRejectedValue(new SettingsError(UNREGISTERED_USER_MESSAGE));
    const result = await postSimpleEntryAction(expense);
    expect(result).toMatchObject({ ok: false, error: UNREGISTERED_USER_MESSAGE });
    expect(db.postSimpleEntry).not.toHaveBeenCalled();
  });
});
