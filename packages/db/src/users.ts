/**
 * 利用者 (23-users-and-expenses §1–§4): who can use the books and with which role. The actor of a
 * request (the IAP-verified email, or `NIHO_FINANCE_ACTOR` locally) is matched with `User.email`;
 * on a book without users the first writer is registered as 管理者. Every write runs in one
 * transaction under the `users` advisory lock, keeps one active 管理者 at least and is in the audit
 * log (entity `user`). Rows are never deleted (無効にする) and an email never changes.
 */
import type { User } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import type { ActorOptions } from "./journal";
import {
  normalizeUserEmail,
  userActiveSchema,
  userCreateSchema,
  userUpdateSchema,
  type USER_ROLES,
  type UserActiveInput,
  type UserCreateInput,
  type UserUpdateInput,
} from "./schemas";
import { lockSettings, runInTransaction, type Tx } from "./transaction";

// ---------------------------------------------------------------------------
// Roles (pure: the authorization of apps/web and its proxy use these)
// ---------------------------------------------------------------------------

/** 管理者 / 経理 / 閲覧 (`User.role`, the enum `user_role`). */
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  owner: "管理者",
  accountant: "経理",
  viewer: "閲覧",
};

/** owner > accountant > viewer (23 §3.1). */
export const USER_ROLE_RANK: Readonly<Record<UserRole, number>> = {
  owner: 3,
  accountant: 2,
  viewer: 1,
};

/** True when `role` may do what needs `minimum`. */
export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return USER_ROLE_RANK[role] >= USER_ROLE_RANK[minimum];
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && Object.hasOwn(USER_ROLE_RANK, value);
}

/** The refusals of 23 §3.1 (owner-facing). */
export const UNREGISTERED_USER_MESSAGE =
  "このアカウントは利用者に登録されていません。管理者に追加を頼んでください";
export const VIEWER_CANNOT_WRITE_MESSAGE =
  "閲覧の役割では保存できません。必要なら管理者に役割の変更を頼んでください";
export const OWNER_ONLY_MESSAGE =
  "この操作は管理者だけができます（締め・事業所・会計期間・証憑の規程・利用者）";

const LAST_OWNER_MESSAGE =
  "管理者がいなくなるため変えられません。先にほかの人を管理者にしてください";
const SELF_DEACTIVATE_MESSAGE = "自分は無効にできません。ほかの管理者に頼んでください";
const NO_OWNER_YET_MESSAGE =
  "まだ管理者がいません。先にいま使っているアカウントを管理者として登録してください";
const NOT_FOUND = "利用者が見つかりません。画面を読み込み直してください";
const DUPLICATE_MESSAGE = "このメールはすでに登録されています";
const DUPLICATE_INACTIVE_MESSAGE =
  "このメールはすでに登録されています。無効の一覧から有効にしてください";
const FIRST_OWNER_REASON = "最初の利用者を管理者として登録";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  /** Lower case; matched with the actor. */
  email: string;
  name: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The name, or the email when there is none (「利用者 <名前（なければメール）>」). */
export function userDisplayName(user: { name: string | null; email: string }): string {
  return user.name ?? user.email;
}

function toRecord(row: User): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `before` / `after` of the audit log (23 §4). */
function auditSnapshot(row: Pick<User, "email" | "name" | "role" | "isActive">) {
  return { email: row.email, name: row.name, role: row.role, isActive: row.isActive };
}

/** 役割 (管理者 → 経理 → 閲覧), then the email. */
function compareUsers(a: UserRecord, b: UserRecord): number {
  const byRole = USER_ROLE_RANK[b.role] - USER_ROLE_RANK[a.role];
  if (byRole !== 0) return byRole;
  return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every user (inactive ones too), 管理者 → 経理 → 閲覧, then by email (23 §4). */
export async function listUsers(db: Db): Promise<UserRecord[]> {
  const rows = await db.user.findMany();
  return rows.map(toRecord).sort(compareUsers);
}

export interface UserCounts {
  active: number;
  inactive: number;
}

/** 「有効 n 人」 of the settings index. */
export async function countUsers(db: Db): Promise<UserCounts> {
  const active = await db.user.count({ where: { isActive: true } });
  const inactive = await db.user.count({ where: { isActive: false } });
  return { active, inactive };
}

/** Who the actor is (23 §2). */
export type UserAccess =
  /** An active row with the same email: its role. */
  | { state: "registered"; user: UserRecord }
  /** No row at all (a new book): treated as 管理者 until `registerFirstOwner`. */
  | { state: "first_owner" }
  /** Rows exist, none active for this email: refused. */
  | { state: "unregistered" };

interface AccessRow {
  hasUsers: boolean;
  id: string | null;
  email: string | null;
  name: string | null;
  role: UserRole | null;
  isActive: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Resolves the actor's email (trimmed, lower case) in one query: the proxy calls it on every
 * request. Reading never writes.
 */
export async function resolveUserAccess(db: Db, email: string): Promise<UserAccess> {
  const normalized = normalizeUserEmail(email);
  const [row] = await db.$queryRaw<AccessRow[]>`
    SELECT EXISTS (SELECT 1 FROM "app_user") AS "hasUsers",
           u."id", u."email", u."name", u."role"::text AS "role", u."is_active" AS "isActive",
           u."created_at" AS "createdAt", u."updated_at" AS "updatedAt"
    FROM (SELECT 1) AS "one"
    LEFT JOIN "app_user" AS u ON u."email" = ${normalized} AND u."is_active"`;
  if (!row?.hasUsers) return { state: "first_owner" };
  if (
    row.id === null ||
    row.email === null ||
    row.role === null ||
    row.createdAt === null ||
    row.updatedAt === null
  ) {
    return { state: "unregistered" };
  }
  return {
    state: "registered",
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      isActive: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function activeOwnerCount(tx: Tx): Promise<number> {
  return tx.user.count({ where: { role: "owner", isActive: true } });
}

async function requireUser(tx: Tx, id: string): Promise<User> {
  const row = await tx.user.findUnique({ where: { id } });
  if (!row) throw new SettingsError(NOT_FOUND);
  return row;
}

export interface RegisterFirstOwnerResult {
  user: UserRecord;
  /** True when this call made the row (and its `user.create`). */
  created: boolean;
}

/**
 * 最初の管理者 (23 §2): on a book without users, `email` becomes 管理者 (`user.create` with the
 * reason 「最初の利用者を管理者として登録」). Once there are users, the email's active row is returned,
 * or the write is refused as 未登録. Under the `users` lock, so two first writers never make two rows.
 * The email is the actor as it is (locally `NIHO_FINANCE_ACTOR`, not always an address).
 */
export async function registerFirstOwner(
  db: Db,
  email: string,
  options: ActorOptions,
): Promise<RegisterFirstOwnerResult> {
  const normalized = normalizeUserEmail(email);
  if (normalized === "") throw new SettingsError(UNREGISTERED_USER_MESSAGE);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "users");
    if ((await tx.user.count()) === 0) {
      const row = await tx.user.create({
        data: { id: newId(), email: normalized, role: "owner" },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "user.create",
        entity: "user",
        entityId: row.id,
        after: auditSnapshot(row),
        reason: FIRST_OWNER_REASON,
      });
      return { user: toRecord(row), created: true };
    }
    const existing = await tx.user.findUnique({ where: { email: normalized } });
    if (!existing?.isActive) throw new SettingsError(UNREGISTERED_USER_MESSAGE);
    return { user: toRecord(existing), created: false };
  });
}

/**
 * 追加 (23 §4): the email is trimmed, lower-cased and checked; the name is optional (40 characters);
 * the role defaults to 閲覧. A registered email (active or not) is refused with its way back.
 */
export async function createUser(
  db: Db,
  input: UserCreateInput,
  options: ActorOptions,
): Promise<UserRecord> {
  const data = userCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "users");
    const duplicate = await tx.user.findUnique({ where: { email: data.email } });
    if (duplicate) {
      throw new SettingsError(duplicate.isActive ? DUPLICATE_MESSAGE : DUPLICATE_INACTIVE_MESSAGE, {
        field: "email",
      });
    }
    // Never leave a book whose users have no 管理者 (the first one is registered first, §2).
    if (data.role !== "owner" && (await activeOwnerCount(tx)) === 0) {
      throw new SettingsError(NO_OWNER_YET_MESSAGE, { field: "role" });
    }
    const row = await tx.user
      .create({ data: { id: newId(), email: data.email, name: data.name, role: data.role } })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new SettingsError(DUPLICATE_MESSAGE, { field: "email" });
        }
        throw error;
      });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "user.create",
      entity: "user",
      entityId: row.id,
      after: auditSnapshot(row),
    });
    return toRecord(row);
  });
}

/**
 * 名前 / 役割 of a row (23 §4). A save that changes nothing writes nothing. The last active 管理者
 * keeps the role; one's own role can change while another active 管理者 remains.
 */
export async function updateUser(
  db: Db,
  input: UserUpdateInput,
  options: ActorOptions,
): Promise<UserRecord> {
  const data = userUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "users");
    const current = await requireUser(tx, data.id);
    const name = data.name === undefined ? current.name : data.name;
    const role = data.role ?? current.role;
    if (name === current.name && role === current.role) return toRecord(current);
    if (current.isActive && current.role === "owner" && role !== "owner") {
      if ((await activeOwnerCount(tx)) <= 1) {
        throw new SettingsError(LAST_OWNER_MESSAGE, { field: "role" });
      }
    }
    const row = await tx.user.update({ where: { id: current.id }, data: { name, role } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "user.update",
      entity: "user",
      entityId: row.id,
      before: auditSnapshot(current),
      after: auditSnapshot(row),
    });
    return toRecord(row);
  });
}

/**
 * 無効にする / 有効にする (23 §4): `user.deactivate` / `user.reactivate`. A deactivated user is
 * 未登録 from the next request. Nobody deactivates themselves (the actor's email) nor the last
 * active 管理者. Setting the state it already has writes nothing.
 */
export async function setUserActive(
  db: Db,
  input: UserActiveInput,
  options: ActorOptions,
): Promise<UserRecord> {
  const data = userActiveSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "users");
    const current = await requireUser(tx, data.id);
    if (current.isActive === data.isActive) return toRecord(current);
    if (!data.isActive) {
      if (current.role === "owner" && (await activeOwnerCount(tx)) <= 1) {
        throw new SettingsError(LAST_OWNER_MESSAGE);
      }
      if (normalizeUserEmail(options.actor) === current.email) {
        throw new SettingsError(SELF_DEACTIVATE_MESSAGE);
      }
    }
    const row = await tx.user.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: data.isActive ? "user.reactivate" : "user.deactivate",
      entity: "user",
      entityId: row.id,
      before: auditSnapshot(current),
      after: auditSnapshot(row),
    });
    return toRecord(row);
  });
}
