"use client";

import type { SegmentSettings } from "@niho-finance/db";
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
import { createSegmentAction, setSegmentActiveAction, updateSegmentAction } from "../actions";

const COLUMNS = {
  columns: "160px minmax(0,1fr) 110px minmax(72px,160px)",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

function SegmentRow({ segment }: { segment: SegmentSettings }) {
  const row = useRowSave((patch) => updateSegmentAction(segment.id, patch));
  return (
    <TableRow {...COLUMNS} muted={!segment.isActive}>
      <Td>
        {segment.isStandard ? (
          <span className="num block px-[7px] text-muted">{segment.code}</span>
        ) : (
          <TextCell
            label={`${segment.name} のコード`}
            value={segment.code}
            maxLength={32}
            onCommit={(value) => row.commit("code", value)}
          />
        )}
      </Td>
      <Td>
        <TextCell
          label={`${segment.code} の名前`}
          value={segment.name}
          maxLength={100}
          onCommit={(value) => row.commit("name", value)}
        />
      </Td>
      <Td>
        <ActiveToggleButton
          isActive={segment.isActive}
          disabled={row.pending}
          lockedReason={segment.isStandard ? "標準" : undefined}
          onToggle={() =>
            row.run(
              () => setSegmentActiveAction(segment.id, !segment.isActive),
              activeToggledMessage(segment.name, segment.isActive),
            )
          }
        />
      </Td>
      <SaveStatus status={row.status} />
    </TableRow>
  );
}

function AddSegmentRow() {
  const toast = useToast();
  const { onSubmit, pending, error } = useFormSubmit(createSegmentAction, {
    onSuccess: () => toast("セグメントを追加しました"),
  });
  return (
    <form
      onSubmit={onSubmit}
      role="row"
      aria-label="セグメントの追加"
      className="data-row bg-surface-2"
      style={gridStyle({
        columns: "160px minmax(0,1fr) auto",
        mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
      })}
    >
      <input
        name="code"
        aria-label="コード（半角英小文字・数字）"
        placeholder="コード（例: hayama）"
        maxLength={32}
        autoComplete="off"
        className="cell-input"
      />
      <input
        name="name"
        aria-label="名前"
        placeholder="名前"
        maxLength={100}
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

export function SegmentsTable({ segments }: { segments: SegmentSettings[] }) {
  const [showInactive, setShowInactive] = useState(false);
  const shown = segments.filter((segment) => segment.isActive || showInactive);
  const inactiveCount = segments.filter((segment) => !segment.isActive).length;
  return (
    <>
      <Table label="セグメント">
        <TableHead {...COLUMNS}>
          <Th>コード</Th>
          <Th>名前</Th>
          <Th>状態</Th>
          <Th />
        </TableHead>
        {shown.map((segment) => (
          <SegmentRow key={segment.id} segment={segment} />
        ))}
        <AddSegmentRow />
      </Table>
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
      <p className="mt-2 text-[12px] text-muted">
        収益・費用の行はセグメントごとに集計します。拠点が増えたら追加します。標準の 4
        つはコードを変えられず、無効にもできません。
      </p>
    </>
  );
}
