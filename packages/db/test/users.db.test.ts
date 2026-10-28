import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  countUsers,
  createUser,
  describeAuditTargets,
  listUsers,
  registerFirstOwner,
  resolveUserAccess,
  roleAtLeast,
  setUserActive,
  SettingsError,
  TRANSACTION_OPTIONS,
  UNREGISTERED_USER_MESSAGE,
  updateUser,
  USER_ROLE_LABELS,
  type Tx,
  type UserRecord,
} from "../src";
import { newId } from "../src/ids";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { emptyTestPrisma, testPrisma } from "./support/prisma";

const actor = "users-admin@example.com";
const LAST_OWNER = "管理者がいなくなるため変えられません。先にほかの人を管理者にしてください";

/** A fictional address no other test uses. */
function address(label: string): string {
  return `${label}-${newId().toLowerCase()}@example.com`;
}

function settingsError(error: unknown) {
  expect(error).toBeInstanceOf(SettingsError);
  const { message, field } = error as SettingsError;
  return { message, field };
}

const ROLLBACK = new Error("rolled back on purpose");

/**
 * Runs `fn` in a transaction that is always rolled back: the states these tests need (no user at
 * all, a single 管理者) would otherwise disturb the other files sharing the database.
 */
async function rolledBack(client: PrismaClient, fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await client.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (error !== ROLLBACK) throw error;
    return;
  }
  throw new Error("the transaction was expected to roll back");
}

/**
 * 利用者 (23-users-and-expenses §1–§4) on the seeded book (one 管理者 owner@example.com). Each test adds
 * users of its own; states that need a book without users, or a single 管理者, are rolled back.
 */
describe.skipIf(!hasTestDatabase)("users (利用者)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
  });

  async function auditOf(db: PrismaClient | Tx, entityId: string) {
    const rows = await db.auditLog.findMany({
      where: { entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    return rows.map(({ actor: by, action, entity, before, after, reason }) => ({
      actor: by,
      action,
      entity,
      before,
      after,
      reason,
    }));
  }

  it("orders the roles 管理者 > 経理 > 閲覧", () => {
    expect(USER_ROLE_LABELS).toEqual({ owner: "管理者", accountant: "経理", viewer: "閲覧" });
    expect(roleAtLeast("owner", "owner")).toBe(true);
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("accountant", "accountant")).toBe(true);
    expect(roleAtLeast("accountant", "owner")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "accountant")).toBe(false);
  });

  it("adds a user (email trimmed and lower-cased, 閲覧 by default) with user.create", async () => {
    const email = address("viewer");
    const user = await createUser(
      prisma,
      { email: `  ${email.toUpperCase()}  `, name: " 架空 花子 " },
      { actor },
    );
    expect(user).toMatchObject({ email, name: "架空 花子", role: "viewer", isActive: true });
    expect(await auditOf(prisma, user.id)).toEqual([
      {
        actor,
        action: "user.create",
        entity: "user",
        before: null,
        after: { email, name: "架空 花子", role: "viewer", isActive: true },
        reason: null,
      },
    ]);
    const names = await describeAuditTargets(prisma, [{ entity: "user", entityId: user.id }]);
    expect(names.get(`user:${user.id}`)).toBe("利用者 架空 花子");

    const unnamed = await createUser(
      prisma,
      { email: address("unnamed"), role: "accountant" },
      {
        actor,
      },
    );
    const unnamedNames = await describeAuditTargets(prisma, [
      { entity: "user", entityId: unnamed.id },
    ]);
    expect(unnamedNames.get(`user:${unnamed.id}`)).toBe(`利用者 ${unnamed.email}`);
  });

  it("changes the name and the role with user.update; a save that changes nothing writes nothing", async () => {
    const email = address("accountant");
    const user = await createUser(prisma, { email, role: "accountant" }, { actor });

    const renamed = await updateUser(prisma, { id: user.id, name: "架空 次郎" }, { actor });
    expect(renamed).toMatchObject({ name: "架空 次郎", role: "accountant" });
    const promoted = await updateUser(prisma, { id: user.id, role: "owner" }, { actor });
    expect(promoted).toMatchObject({ name: "架空 次郎", role: "owner" });

    const audit = await auditOf(prisma, user.id);
    expect(audit.map((row) => row.action)).toEqual(["user.create", "user.update", "user.update"]);
    expect(audit[1]).toMatchObject({
      before: { email, name: null, role: "accountant", isActive: true },
      after: { email, name: "架空 次郎", role: "accountant", isActive: true },
    });
    expect(audit[2]).toMatchObject({
      before: { email, name: "架空 次郎", role: "accountant", isActive: true },
      after: { email, name: "架空 次郎", role: "owner", isActive: true },
    });

    const unchanged = await updateUser(
      prisma,
      { id: user.id, name: "架空 次郎", role: "owner" },
      { actor },
    );
    expect(unchanged.updatedAt).toEqual(promoted.updatedAt);
    const same = await setUserActive(prisma, { id: user.id, isActive: true }, { actor });
    expect(same.updatedAt).toEqual(promoted.updatedAt);
    expect(await auditOf(prisma, user.id)).toHaveLength(3);

    // An empty name clears it.
    const cleared = await updateUser(prisma, { id: user.id, name: "" }, { actor });
    expect(cleared.name).toBeNull();
  });

  it("deactivates and reactivates with user.deactivate / user.reactivate", async () => {
    const email = address("leaver");
    const user = await createUser(prisma, { email, name: "架空 三郎", role: "viewer" }, { actor });

    const inactive = await setUserActive(prisma, { id: user.id, isActive: false }, { actor });
    expect(inactive.isActive).toBe(false);
    expect(await resolveUserAccess(prisma, email)).toEqual({ state: "unregistered" });

    const active = await setUserActive(prisma, { id: user.id, isActive: "true" }, { actor });
    expect(active.isActive).toBe(true);
    expect(await resolveUserAccess(prisma, email)).toMatchObject({
      state: "registered",
      user: { id: user.id, role: "viewer" },
    });

    const audit = await auditOf(prisma, user.id);
    expect(audit.map((row) => row.action)).toEqual([
      "user.create",
      "user.deactivate",
      "user.reactivate",
    ]);
    expect(audit[1]).toMatchObject({
      actor,
      before: { email, name: "架空 三郎", role: "viewer", isActive: true },
      after: { email, name: "架空 三郎", role: "viewer", isActive: false },
    });
    expect(audit[2]).toMatchObject({
      before: { isActive: false },
      after: { isActive: true },
    });
  });

  it("refuses a registered email, and points to the inactive list for an inactive one", async () => {
    const email = address("twice");
    const user = await createUser(prisma, { email }, { actor });
    expect(settingsError(await rejectionOf(createUser(prisma, { email }, { actor })))).toEqual({
      message: "このメールはすでに登録されています",
      field: "email",
    });
    await setUserActive(prisma, { id: user.id, isActive: false }, { actor });
    expect(
      settingsError(
        await rejectionOf(createUser(prisma, { email: email.toUpperCase() }, { actor })),
      ),
    ).toEqual({
      message: "このメールはすでに登録されています。無効の一覧から有効にしてください",
      field: "email",
    });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("checks the email and the name", async () => {
    for (const email of ["", "no-at-sign.example.com", "two@@example.com", "name@example"]) {
      const error = await rejectionOf(createUser(prisma, { email }, { actor }));
      expect(error, email).toBeInstanceOf(ZodError);
    }
    const long = await rejectionOf(
      createUser(prisma, { email: address("long"), name: "あ".repeat(41) }, { actor }),
    );
    expect(long).toBeInstanceOf(ZodError);
    expect((long as ZodError).issues[0]?.message).toBe("名前は 40 文字以内にしてください");
  });

  it("keeps one active 管理者: the last one is neither demoted nor deactivated", async () => {
    await rolledBack(prisma, async (tx) => {
      const last = await createUser(tx, { email: address("last-owner"), role: "owner" }, { actor });
      // Leave `last` as the only active 管理者 (inside this rolled-back transaction).
      await tx.user.updateMany({
        where: { role: "owner", isActive: true, NOT: { id: last.id } },
        data: { role: "accountant" },
      });

      expect(
        settingsError(
          await rejectionOf(updateUser(tx, { id: last.id, role: "accountant" }, { actor })),
        ),
      ).toEqual({ message: LAST_OWNER, field: "role" });
      expect(
        settingsError(
          await rejectionOf(setUserActive(tx, { id: last.id, isActive: false }, { actor })),
        ),
      ).toEqual({ message: LAST_OWNER, field: undefined });
      expect(await auditOf(tx, last.id)).toHaveLength(1);

      // With another 管理者, one's own role can change.
      await createUser(tx, { email: address("next-owner"), role: "owner" }, { actor });
      const demoted = await updateUser(tx, { id: last.id, role: "viewer" }, { actor: last.email });
      expect(demoted.role).toBe("viewer");
    });
  });

  it("refuses to deactivate oneself", async () => {
    const self = await createUser(prisma, { email: address("self"), role: "owner" }, { actor });
    const other = await createUser(prisma, { email: address("other"), role: "owner" }, { actor });
    expect(
      settingsError(
        await rejectionOf(
          setUserActive(
            prisma,
            { id: self.id, isActive: false },
            { actor: ` ${self.email.toUpperCase()} ` },
          ),
        ),
      ),
    ).toEqual({
      message: "自分は無効にできません。ほかの管理者に頼んでください",
      field: undefined,
    });
    expect(await auditOf(prisma, self.id)).toHaveLength(1);

    const deactivated = await setUserActive(
      prisma,
      { id: self.id, isActive: false },
      { actor: other.email },
    );
    expect(deactivated.isActive).toBe(false);
    expect((await auditOf(prisma, self.id)).at(-1)).toMatchObject({
      actor: other.email,
      action: "user.deactivate",
    });
  });

  it("resolves the actor: registered, unregistered (unknown or inactive), first_owner without users", async () => {
    expect(await resolveUserAccess(prisma, " Owner@Example.com ")).toMatchObject({
      state: "registered",
      user: { email: "owner@example.com", role: "owner", isActive: true },
    });
    expect(await resolveUserAccess(prisma, address("unknown"))).toEqual({
      state: "unregistered",
    });
    expect(await resolveUserAccess(prisma, "")).toEqual({ state: "unregistered" });

    // The empty test database has no user at all (rolled back: the setup test owns it).
    await rolledBack(emptyTestPrisma(), async (tx) => {
      expect(await tx.user.count()).toBe(0);
      expect(await resolveUserAccess(tx, "first@example.com")).toEqual({ state: "first_owner" });
    });
  });

  it("registers the first 管理者 on a book without users, once; afterwards returns the active row", async () => {
    await rolledBack(emptyTestPrisma(), async (tx) => {
      // A non-管理者 cannot be the first user: the book would have no 管理者.
      expect(
        settingsError(
          await rejectionOf(
            createUser(tx, { email: "viewer@example.com", role: "viewer" }, { actor }),
          ),
        ).field,
      ).toBe("role");

      const first = await registerFirstOwner(tx, " First@Example.com ", {
        actor: "first@example.com",
      });
      expect(first).toMatchObject({
        created: true,
        user: { email: "first@example.com", name: null, role: "owner", isActive: true },
      });
      expect(await auditOf(tx, first.user.id)).toEqual([
        {
          actor: "first@example.com",
          action: "user.create",
          entity: "user",
          before: null,
          after: { email: "first@example.com", name: null, role: "owner", isActive: true },
          reason: "最初の利用者を管理者として登録",
        },
      ]);

      const again = await registerFirstOwner(tx, "first@example.com", {
        actor: "first@example.com",
      });
      expect(again).toEqual({ created: false, user: first.user });
      expect(await tx.user.count()).toBe(1);
      expect(await tx.auditLog.count({ where: { entity: "user" } })).toBe(1);
      expect(await resolveUserAccess(tx, "first@example.com")).toMatchObject({
        state: "registered",
        user: { id: first.user.id },
      });

      expect(await resolveUserAccess(tx, "second@example.com")).toEqual({
        state: "unregistered",
      });
      expect(
        settingsError(
          await rejectionOf(
            registerFirstOwner(tx, "second@example.com", { actor: "second@example.com" }),
          ),
        ),
      ).toEqual({ message: UNREGISTERED_USER_MESSAGE, field: undefined });
    });

    // On the seeded book the 管理者 is already there: nothing is written.
    const audit = await prisma.auditLog.count();
    const seeded = await registerFirstOwner(prisma, "owner@example.com", {
      actor: "owner@example.com",
    });
    expect(seeded).toMatchObject({ created: false, user: { email: "owner@example.com" } });
    expect(await prisma.auditLog.count()).toBe(audit);
  });

  it("lists users 管理者 → 経理 → 閲覧, then by email, and counts them", async () => {
    const before = await countUsers(prisma);
    await createUser(prisma, { email: address("zz-viewer"), role: "viewer" }, { actor });
    const inactive = await createUser(
      prisma,
      { email: address("aa-accountant"), role: "accountant" },
      { actor },
    );
    await setUserActive(prisma, { id: inactive.id, isActive: false }, { actor });

    const users = await listUsers(prisma);
    const rank = { owner: 0, accountant: 1, viewer: 2 } as const;
    const sorted = [...users].sort(
      (a: UserRecord, b: UserRecord) =>
        rank[a.role] - rank[b.role] || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0),
    );
    expect(users.map((user) => user.id)).toEqual(sorted.map((user) => user.id));
    expect(users.some((user) => user.id === inactive.id && !user.isActive)).toBe(true);
    expect(await countUsers(prisma)).toEqual({
      active: before.active + 1,
      inactive: before.inactive + 1,
    });
  });
});
