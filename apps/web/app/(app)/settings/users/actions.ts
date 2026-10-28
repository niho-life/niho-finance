"use server";

import {
  createUser,
  getPrismaClient,
  setUserActive,
  updateUser,
  type UserCreateInput,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, inlinePatch, parseBoolean, parseId } from "@/lib/action-result";
import type { ActionResult, RowValues } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Actions of 設定 › 利用者 (23-users-and-expenses §4). Every one is 管理者 only. The repository
 * keeps one active 管理者, refuses deactivating oneself and writes the audit log (`user.*`) as the
 * signed-in user; expected failures come back as `{ ok: false }` with the field of each problem.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Form values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list, the settings index (有効 n 人) and the navigation of the user whose role changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

/** 管理者として登録 (23 §2, §4): `authorizeAction` registers the first 管理者 on a book without users. */
export async function registerFirstOwnerAction(): Promise<ActionResult> {
  const denied = await authorizeAction("owner");
  if (denied) return denied;
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** 追加: メール・名前・役割 (default 閲覧). */
export async function createUserAction(values: unknown): Promise<ActionResult<{ email: string }>> {
  const denied = await authorizeAction("owner");
  if (denied) return denied;
  return write(
    async () => createUser(prisma(), valuesSchema.parse(values) as UserCreateInput, await by()),
    (user) => ({ email: user.email }),
  );
}

/** 名前 (blur / Enter) or 役割 (change) of a row. */
export async function updateUserAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  const denied = await authorizeAction("owner");
  if (denied) return denied;
  return write(
    async () => updateUser(prisma(), inlinePatch(id, patch, ["name", "role"]), await by()),
    (user) => ({ name: user.name ?? "", role: user.role }),
  );
}

/** 無効にする / 有効にする. */
export async function setUserActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  const denied = await authorizeAction("owner");
  if (denied) return denied;
  return write(
    async () =>
      setUserActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, await by()),
    () => null,
  );
}
