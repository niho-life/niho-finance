import { listUsers, USER_ROLE_LABELS, USER_ROLES } from "@niho-finance/db";
import type { Metadata } from "next";
import { ActionButton } from "@/components/settings/action-button";
import { PageHeader } from "@/components/ui/page-header";
import { currentUser } from "@/lib/authz";
import { db } from "@/lib/data";
import { registerFirstOwnerAction } from "./actions";
import { UsersTable } from "./users-table";

export const metadata: Metadata = { title: "利用者" };

/**
 * 設定 › 利用者 (23-users-and-expenses §4): who can open the books and with which role. 管理者 adds
 * users and changes roles in the list; 経理 only reads it. A book without users offers to register
 * the account in use as 管理者 first.
 */
export default async function UsersPage() {
  const user = await currentUser();
  const prisma = await db();
  const users = await listUsers(prisma);

  if (user.state === "first_owner") {
    return (
      <>
        <PageHeader title="利用者" back={{ href: "/settings", label: "設定" }} />
        <div className="flex flex-col items-start gap-3 rounded-card border border-dashed border-border-2 bg-surface px-5 py-6">
          <p className="text-[15px] font-bold">まだ利用者が登録されていません</p>
          <p className="text-[13px] text-muted">
            いま使っているアカウント（{user.email}）を管理者として登録します
          </p>
          <ActionButton action={registerFirstOwnerAction} label="管理者として登録" />
        </div>
      </>
    );
  }

  const isOwner = user.state === "registered" && user.role === "owner";
  return (
    <UsersTable
      users={users.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        isActive: row.isActive,
      }))}
      roleOptions={USER_ROLES.map((role) => ({ value: role, label: USER_ROLE_LABELS[role] }))}
      currentEmail={user.email}
      canEdit={isOwner}
    />
  );
}
