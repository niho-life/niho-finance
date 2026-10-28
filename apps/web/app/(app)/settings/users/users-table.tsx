"use client";

import type { UserRole } from "@niho-finance/db";
import { useId, useState, useTransition } from "react";
import {
  SaveStatus,
  SelectCell,
  TextCell,
  useFormSubmit,
  useRowSave,
} from "@/components/settings/inline";
import { FormError } from "@/components/settings/row-parts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createUserAction, setUserActiveAction, updateUserAction } from "./actions";

export interface UserRowView {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  isActive: boolean;
}

const COLUMNS = {
  columns: "minmax(140px,1fr) minmax(180px,1.4fr) 120px 120px minmax(64px,140px)",
  mobileColumns: "minmax(0,1fr) auto",
};

/** 管理者 / 経理 / 閲覧, strongest first (`USER_ROLES` and `USER_ROLE_LABELS`, given by the page). */
export interface RoleOption {
  value: UserRole;
  label: string;
}

const IAP_NOTICE =
  "このメールで画面を開くには、Google Cloud の IAP の許可リストにも足してください（運用の手順 deploy.md §5）";

function displayName(user: UserRowView): string {
  return user.name ?? user.email;
}

/** One user: 名前 and 役割 saved in place (管理者), 無効にする / 有効にする with a confirmation. */
function UserRow({
  user,
  isSelf,
  canEdit,
  roleOptions,
  onConfirmRole,
}: {
  user: UserRowView;
  isSelf: boolean;
  canEdit: boolean;
  roleOptions: readonly RoleOption[];
  /** Asks before 管理者 changes their own role (23 §4). */
  onConfirmRole: () => Promise<boolean>;
}) {
  const toast = useToast();
  const row = useRowSave((patch) => updateUserAction(user.id, patch));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      const result = await setUserActiveAction(user.id, !user.isActive);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      setError(null);
      toast(user.isActive ? `${user.email} を無効にしました` : `${user.email} を有効にしました`);
    });
  }

  const self = isSelf ? <span className="ml-1 text-[12px] text-muted">（あなた）</span> : null;
  return (
    <TableRow {...COLUMNS} muted={!user.isActive}>
      <Td>
        {canEdit ? (
          <TextCell
            label={`${user.email} の名前`}
            value={user.name ?? ""}
            placeholder="名前（任意）"
            maxLength={40}
            onCommit={(value) => row.commit("name", value)}
          />
        ) : (
          <span className="font-semibold">{displayName(user)}</span>
        )}
        <span className="block truncate text-[12px] text-muted md:hidden">
          {user.email}
          {self}
        </span>
      </Td>
      <Td sm="hide" className="truncate">
        {user.email}
        {self}
      </Td>
      <Td>
        {canEdit ? (
          <SelectCell
            label={`${user.email} の役割`}
            value={user.role}
            options={roleOptions}
            confirm={
              isSelf
                ? (next) => (next === "owner" ? Promise.resolve(true) : onConfirmRole())
                : undefined
            }
            onCommit={(value) => row.commit("role", value)}
          />
        ) : (
          (roleOptions.find((option) => option.value === user.role)?.label ?? "")
        )}
      </Td>
      <Td sm="full">
        {canEdit && !(isSelf && user.isActive) ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => (user.isActive ? setConfirming(true) : toggle())}
          >
            {user.isActive ? "無効にする" : "有効にする"}
          </Button>
        ) : null}
        {error && !confirming ? (
          <span role="alert" className="block text-[12px] font-bold text-danger">
            {error}
          </span>
        ) : null}
      </Td>
      <SaveStatus status={row.status} />
      <ConfirmDialog
        open={confirming}
        title={`${user.email} を無効にしますか`}
        confirmLabel="無効にする"
        variant="danger"
        pending={pending}
        error={error}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={toggle}
      >
        <p>次に画面を開いたときから使えなくなります。</p>
      </ConfirmDialog>
    </TableRow>
  );
}

/** 追加 (23 §4): メール・名前・役割 (default 閲覧). */
function AddUserSheet({
  roleOptions,
  onClose,
  onAdded,
}: {
  roleOptions: readonly RoleOption[];
  onClose: () => void;
  onAdded: (email: string) => void;
}) {
  const id = useId();
  const { onSubmit, pending, error } = useFormSubmit(
    (formData: FormData) => createUserAction(Object.fromEntries(formData)),
    { onSuccess: (data) => onAdded(data.email) },
  );
  return (
    <Sheet
      open
      onClose={onClose}
      title="利用者の追加"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            キャンセル
          </Button>
          <Button type="submit" form={`${id}-form`} variant="primary" disabled={pending}>
            {pending ? "追加中…" : "追加"}
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormField
          label="メール"
          htmlFor={`${id}-email`}
          required
          error={error?.fieldErrors.email}
          help="Google アカウントのメール。前後の空白を除き、小文字で登録します"
        >
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            autoComplete="off"
            maxLength={254}
            autoFocus
          />
        </FormField>
        <FormField label="名前" htmlFor={`${id}-name`} error={error?.fieldErrors.name}>
          <Input id={`${id}-name`} name="name" maxLength={40} autoComplete="off" />
        </FormField>
        <FormField label="役割" htmlFor={`${id}-role`} required error={error?.fieldErrors.role}>
          <Select id={`${id}-role`} name="role" defaultValue="viewer">
            {roleOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FormField>
        {error && Object.keys(error.fieldErrors).length === 0 ? <FormError error={error} /> : null}
      </form>
    </Sheet>
  );
}

/**
 * The list of 23 §4: 名前・メール・役割・操作, 管理者 → 経理 → 閲覧, the inactive ones folded. 管理者
 * edits in place; 経理 reads.
 */
export function UsersTable({
  users,
  roleOptions,
  currentEmail,
  canEdit,
}: {
  users: UserRowView[];
  roleOptions: readonly RoleOption[];
  currentEmail: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [roleConfirm, setRoleConfirm] = useState<((ok: boolean) => void) | null>(null);
  const active = users.filter((user) => user.isActive);
  const inactive = users.filter((user) => !user.isActive);
  const shown = showInactive ? [...active, ...inactive] : active;

  function confirmOwnRole(): Promise<boolean> {
    return new Promise((resolve) => setRoleConfirm(() => resolve));
  }

  function answerRole(ok: boolean) {
    roleConfirm?.(ok);
    setRoleConfirm(null);
  }

  return (
    <>
      <PageHeader
        title="利用者"
        back={{ href: "/settings", label: "設定" }}
        actions={
          canEdit ? (
            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              追加
            </Button>
          ) : null
        }
      />
      {canEdit ? null : (
        <p className="mb-3 rounded-lg bg-surface-2 px-3.5 py-2.5 text-[13px] text-muted">
          利用者の追加と役割の変更は管理者だけができます
        </p>
      )}
      {notice ? (
        <div
          role="status"
          className="mb-3 flex items-start gap-3 rounded-lg bg-primary-soft px-3.5 py-2.5 text-[13px] text-primary-ink"
        >
          <p className="min-w-0 flex-1">{IAP_NOTICE}</p>
          <button
            type="button"
            onClick={() => setNotice(false)}
            aria-label="案内を閉じる"
            className="font-bold"
          >
            ×
          </button>
        </div>
      ) : null}
      <Table label="利用者">
        <TableHead {...COLUMNS}>
          <Th>名前</Th>
          <Th sm="hide">メール</Th>
          <Th>役割</Th>
          <Th sm="hide">操作</Th>
          <Th />
        </TableHead>
        {shown.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            isSelf={user.email === currentEmail}
            canEdit={canEdit}
            roleOptions={roleOptions}
            onConfirmRole={confirmOwnRole}
          />
        ))}
      </Table>
      {inactive.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowInactive(!showInactive)}
          aria-expanded={showInactive}
          className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
        >
          <span aria-hidden="true">{showInactive ? "▾" : "▸"}</span>
          {showInactive ? `無効 ${inactive.length} 人を畳む` : `無効 ${inactive.length} 人を表示`}
        </button>
      ) : null}
      {adding ? (
        <AddUserSheet
          roleOptions={roleOptions}
          onClose={() => setAdding(false)}
          onAdded={(email) => {
            setAdding(false);
            setNotice(true);
            toast(`${email} を追加しました`);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={roleConfirm !== null}
        title="自分の役割を変えますか"
        confirmLabel="変える"
        onCancel={() => answerRole(false)}
        onConfirm={() => answerRole(true)}
      >
        <p>管理者でなくなると、利用者と締めの操作ができなくなります。</p>
      </ConfirmDialog>
    </>
  );
}
