"use client";

import type { MemoTagSettings } from "@niho-finance/db";
import { useState } from "react";
import {
  activeToggledMessage,
  InactiveToggle,
  SaveStatus,
  TextCell,
  useFormSubmit,
  useRowSave,
} from "@/components/settings/inline";
import { ActiveToggleButton, FormError } from "@/components/settings/row-parts";
import { Button } from "@/components/ui/button";
import { gridStyle, Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createMemoTagAction, setMemoTagActiveAction, updateMemoTagAction } from "../actions";

const COLUMNS = {
  columns: "minmax(0,1fr) 110px minmax(72px,160px)",
  mobileColumns: "minmax(0,1fr) auto",
};

function MemoTagRow({ tag }: { tag: MemoTagSettings }) {
  const row = useRowSave((patch) => updateMemoTagAction(tag.id, patch));
  return (
    <TableRow {...COLUMNS} muted={!tag.isActive}>
      <Td>
        <TextCell
          label={`タグ「${tag.name}」の名前`}
          value={tag.name}
          maxLength={50}
          onCommit={(value) => row.commit("name", value)}
        />
      </Td>
      <Td>
        <ActiveToggleButton
          isActive={tag.isActive}
          disabled={row.pending}
          onToggle={() =>
            row.run(
              () => setMemoTagActiveAction(tag.id, !tag.isActive),
              activeToggledMessage(tag.name, tag.isActive),
            )
          }
        />
      </Td>
      <SaveStatus status={row.status} />
    </TableRow>
  );
}

function AddMemoTagRow() {
  const toast = useToast();
  const { onSubmit, pending, error } = useFormSubmit(createMemoTagAction, {
    onSuccess: () => toast("タグを追加しました"),
  });
  return (
    <form
      onSubmit={onSubmit}
      role="row"
      aria-label="タグの追加"
      className="data-row bg-surface-2"
      style={gridStyle({ columns: "minmax(0,1fr) auto", mobileColumns: "minmax(0,1fr) auto" })}
    >
      <input
        name="name"
        aria-label="タグの名前"
        placeholder="タグの名前（例: 出張）"
        maxLength={50}
        autoComplete="off"
        className="cell-input"
      />
      <Button type="submit" size="sm" variant="primary" disabled={pending}>
        追加
      </Button>
      <FormError error={error} className="col-span-full" />
    </form>
  );
}

export function MemoTagsTable({ tags }: { tags: MemoTagSettings[] }) {
  const [showInactive, setShowInactive] = useState(false);
  const shown = tags.filter((tag) => tag.isActive || showInactive);
  const inactiveCount = tags.filter((tag) => !tag.isActive).length;
  return (
    <>
      <Table label="タグ">
        <TableHead {...COLUMNS}>
          <Th>名前</Th>
          <Th>状態</Th>
          <Th />
        </TableHead>
        {shown.length === 0 ? (
          <p className="px-4 py-5 text-[14px] text-muted">
            タグはまだありません。仕訳の行に付けて、出張や改装などで横断して探せるようにします。
          </p>
        ) : null}
        {shown.map((tag) => (
          <MemoTagRow key={tag.id} tag={tag} />
        ))}
        <AddMemoTagRow />
      </Table>
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
    </>
  );
}
