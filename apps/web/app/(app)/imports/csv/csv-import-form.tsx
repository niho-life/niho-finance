"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type DragEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, FormField, Select } from "@/components/ui/form";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";
import { formatAmountDisplay, formatDate, formatDateTime } from "@/lib/format";
import { importCsvAction, previewCsvImportAction } from "../actions";
import { columnsOfTable, MappingFields } from "../_components/mapping-fields";
import { FailuresTable, WarningsList } from "../_components/results";
import { formatBytes } from "../_lib/format";
import {
  emptyMappingDraft,
  MAPPING_COLUMNS,
  mappingDraftOf,
  mappingPayload,
  type MappingDraft,
} from "../_lib/mapping";
import type {
  CsvFormatOption,
  CsvPreviewView,
  CsvWalletOption,
  PreviewRowView,
} from "../_lib/types";

/** What the file input offers; the check below also accepts any `.csv` / `.txt` by its name. */
const ACCEPT = ".csv,.txt,text/csv,text/plain";
const TEXT_TYPES: ReadonlySet<string> = new Set(["", "text/csv", "text/plain"]);
/** Failed rows listed in the preview (the rest are counted). */
const FAILURES_SHOWN = 20;
const SEND_FAILED =
  "送信できませんでした。ファイルの大きさ（10 MB まで）と通信を確かめて、もう一度試してください";

type Mapping = ReturnType<typeof mappingPayload>;

/** The fields of the mapping editor, as the preview's errors name them. */
const MAPPING_FIELDS: ReadonlySet<string> = new Set([
  ...MAPPING_COLUMNS.map((column) => `config.columns.${column}`),
  "config.headerRows",
  "config.order",
  "config.invertSign",
]);

interface PreviewRequest {
  walletId: string;
  file: File;
  /** "" lets the server use the wallet's saved format or detect one. */
  format: string;
  /** The mapping of 汎用; `null` lets the server use the saved one. */
  config: Mapping | null;
}

function fileProblem(file: File, maxBytes: number): string | null {
  const byName = /\.(csv|txt)$/i.test(file.name);
  if (!byName && !TEXT_TYPES.has(file.type)) {
    return "CSV ファイル（.csv・.txt）を選んでください";
  }
  if (file.size === 0) return "ファイルが空です。別のファイルを選んでください";
  if (file.size > maxBytes) return "ファイルが大きすぎます（10 MB まで）";
  return null;
}

/** Calls a Server Action; a request that never got an answer becomes an owner-facing error. */
async function send<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch {
    return { ok: false, error: SEND_FAILED, fieldErrors: {} };
  }
}

function Alerts({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}

/**
 * The drop zone (a label around a visually hidden file input: click, keyboard or drop). With a
 * file it shrinks to the file's name and size and 「別のファイルを選ぶ」.
 */
function DropZone({
  id,
  file,
  onFile,
  error,
  status,
}: {
  id: string;
  file: File | null;
  onFile: (file: File) => void;
  error: string | null;
  status: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);

  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) onFile(dropped);
  }

  const frame = [
    "flex cursor-pointer rounded-card border border-dashed transition-colors",
    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
    dragging ? "border-primary bg-primary-soft" : "border-border-2 hover:bg-black/[0.02]",
    error ? "border-danger" : "",
  ].join(" ");

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={
          file
            ? `${frame} min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5`
            : `${frame} min-h-36 flex-col items-center justify-center gap-1.5 px-4 py-6 text-center`
        }
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(event) => {
          // Moving over the label's own text is not leaving it.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={drop}
      >
        <input
          id={id}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-describedby={error ? `${id}-error` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0];
            // Choosing the same file again must fire a change too.
            event.currentTarget.value = "";
            if (chosen) onFile(chosen);
          }}
        />
        {file ? (
          <>
            <span className="min-w-0 flex-1 truncate font-bold" title={file.name}>
              {file.name}
            </span>
            <span className="num text-[13px] text-muted">{formatBytes(file.size)}</span>
            <span className="text-[13px] font-bold text-primary-ink underline underline-offset-4">
              別のファイルを選ぶ
            </span>
          </>
        ) : (
          <>
            <span className="text-[15px] font-bold">CSV ファイルをここにドロップ</span>
            <span className="text-[13px] text-muted">
              またはクリックして選ぶ（.csv・.txt、10 MB まで）
            </span>
          </>
        )}
      </label>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12px] font-bold text-danger">
          {error}
        </p>
      ) : null}
      {status}
    </div>
  );
}

/** The first rows of the file as they are, for the mapping (columns numbered like the selects). */
function RawTable({ table, columnCount }: { table: readonly string[][]; columnCount: number }) {
  if (table.length === 0 || columnCount === 0) return null;
  const columns = Array.from({ length: columnCount }, (_, index) => index);
  return (
    <div className="max-h-80 overflow-auto rounded-card border border-border">
      <table className="w-max min-w-full border-collapse text-[12px]">
        <caption className="sr-only">ファイルの先頭 {table.length} 行</caption>
        <thead className="sticky top-0 bg-surface-2 text-[11px] font-bold text-muted">
          <tr>
            <th scope="col" className="px-2 py-1.5 text-right font-bold">
              行
            </th>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-2 py-1.5 text-left font-bold">
                {column + 1} 列目
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border">
              <td className="num px-2 py-1 text-right text-muted">{rowIndex + 1}</td>
              {columns.map((column) => (
                <td
                  key={column}
                  className="max-w-[180px] truncate whitespace-nowrap px-2 py-1"
                  title={row[column] ?? ""}
                >
                  {row[column] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ROW_COLUMNS = {
  columns: "96px minmax(0,1.6fr) minmax(0,1fr) 112px 112px",
  mobileColumns: "minmax(0,1fr) auto",
};

/** The first lines as they will be stored: 日付・摘要・相手・金額・残高 (phones: 日付と金額 / 摘要). */
function PreviewRowsTable({ rows }: { rows: readonly PreviewRowView[] }) {
  return (
    <Table label="明細のプレビュー" minWidth={640}>
      <TableHead {...ROW_COLUMNS}>
        <Th>日付</Th>
        <Th>摘要</Th>
        <Th>相手</Th>
        <Th align="right">金額（円）</Th>
        <Th align="right">残高（円）</Th>
      </TableHead>
      {rows.map((row) => (
        <TableRow
          key={row.externalId}
          {...ROW_COLUMNS}
          muted={row.duplicate}
          className="max-md:grid-flow-row-dense"
        >
          <Td className="num text-[13px]">{formatDate(row.txnDate)}</Td>
          <Td sm="full" className="break-words">
            {row.descriptionRaw}
            {row.counterpartyRaw ? (
              <span className="ml-2 text-[12px] text-muted md:hidden">{row.counterpartyRaw}</span>
            ) : null}
            {row.duplicate ? (
              <span className="ml-2 whitespace-nowrap text-[11px] font-bold text-muted">
                取込済み
              </span>
            ) : null}
          </Td>
          <Td sm="hide" className="truncate text-[13px]">
            {row.counterpartyRaw ?? "—"}
          </Td>
          <Td align="right" className="font-bold">
            {formatAmountDisplay(BigInt(row.amount))}
          </Td>
          <Td align="right" sm="hide" className="text-muted">
            {row.balanceAfter === null ? "—" : formatAmountDisplay(BigInt(row.balanceAfter))}
          </Td>
        </TableRow>
      ))}
    </Table>
  );
}

function Count({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[11px] font-bold text-muted">{label}</dt>
      <dd className="num text-[15px] font-bold">{children}</dd>
    </div>
  );
}

/** 明細・失敗・取込済み・期間・文字コード, and 取引前後の残高 when the file has them. */
function Counts({ preview }: { preview: CsvPreviewView }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-3 border-y border-border py-3">
      <Count label="明細">{preview.rowCount.toLocaleString("ja-JP")} 行</Count>
      <Count label="失敗">{preview.failures.length.toLocaleString("ja-JP")} 行</Count>
      <Count label="取込済み">{preview.duplicateCount.toLocaleString("ja-JP")} 行</Count>
      <Count label="期間">
        {preview.period
          ? `${formatDate(preview.period.from)} – ${formatDate(preview.period.to)}`
          : "—"}
      </Count>
      <Count label="文字コード">{preview.encoding === "shift_jis" ? "Shift_JIS" : "UTF-8"}</Count>
      {preview.openingBalance !== null ? (
        <Count label="取引前の残高（円）">
          {formatAmountDisplay(BigInt(preview.openingBalance))}
        </Count>
      ) : null}
      {preview.closingBalance !== null ? (
        <Count label="取引後の残高（円）">
          {formatAmountDisplay(BigInt(preview.closingBalance))}
        </Count>
      ) : null}
    </dl>
  );
}

/**
 * CSV の取込 (12-imports §1.2). The state lives here; the file goes to the server with every
 * preview and with the import (nothing is kept on the server in between).
 */
export function CsvImportForm({
  wallets,
  formats,
  initialWalletId,
  maxBytes,
}: {
  wallets: CsvWalletOption[];
  formats: CsvFormatOption[];
  initialWalletId: string;
  maxBytes: number;
}) {
  const id = useId();
  const router = useRouter();
  /** Only the latest preview request may update the screen. */
  const latestRequest = useRef(0);
  const [walletId, setWalletId] = useState(initialWalletId);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<ActionError | null>(null);
  const [draft, setDraft] = useState<MappingDraft>(emptyMappingDraft);
  /** The last mapping read (sent again when 汎用 is chosen once more). */
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [remember, setRemember] = useState(true);
  const [importError, setImportError] = useState<ActionError | null>(null);
  const [previewing, startPreview] = useTransition();
  const [importing, startImport] = useTransition();

  const wallet = wallets.find((item) => item.id === walletId) ?? wallets[0];
  if (!wallet) return null;
  const walletFormats = formats.filter((format) => format.walletKinds.includes(wallet.kind));
  const formatLabel = (key: string | null) =>
    formats.find((format) => format.key === key)?.label ?? "自動判別";

  function runPreview(request: PreviewRequest) {
    latestRequest.current += 1;
    const ticket = latestRequest.current;
    const formData = new FormData();
    formData.set("walletId", request.walletId);
    formData.set("file", request.file);
    formData.set("format", request.format);
    formData.set("config", request.config === null ? "" : JSON.stringify(request.config));
    setImportError(null);
    startPreview(async () => {
      const result = await send(() => previewCsvImportAction(formData));
      if (ticket !== latestRequest.current) return;
      if (!result.ok) {
        setPreviewError(result);
        return;
      }
      setPreviewError(null);
      setPreview(result.data);
      if (result.data.config) {
        const read = mappingDraftOf(result.data.config);
        setDraft(read);
        setMapping(mappingPayload(read));
      }
    });
  }

  function reset() {
    latestRequest.current += 1;
    setPreview(null);
    setPreviewError(null);
    setImportError(null);
    setDraft(emptyMappingDraft());
    setMapping(null);
  }

  function chooseFile(next: File) {
    reset();
    const problem = fileProblem(next, maxBytes);
    setFileError(problem);
    if (problem) {
      setFile(null);
      return;
    }
    setFile(next);
    runPreview({ walletId, file: next, format: "", config: null });
  }

  function changeWallet(next: string) {
    setWalletId(next);
    // Keep the choice on reload and on 戻る (the page reads `?wallet=`).
    window.history.replaceState(null, "", `/imports/csv?wallet=${encodeURIComponent(next)}`);
    reset();
    if (file) runPreview({ walletId: next, file, format: "", config: null });
  }

  function changeFormat(format: string) {
    if (!file) return;
    runPreview({ walletId, file, format, config: format === "generic" ? mapping : null });
  }

  function readMapping() {
    if (!file) return;
    const payload = mappingPayload(draft);
    setMapping(payload);
    runPreview({ walletId, file, format: "generic", config: payload });
  }

  function importFile() {
    if (!file || !preview) return;
    const formData = new FormData();
    formData.set("walletId", walletId);
    formData.set("file", file);
    // Exactly what the preview read: its format and, for 汎用, its mapping.
    formData.set("format", preview.format ?? "");
    formData.set(
      "config",
      preview.format === "generic" && preview.config ? JSON.stringify(preview.config) : "",
    );
    formData.set("rememberFormat", remember ? "true" : "false");
    startImport(async () => {
      const result = await send(() => importCsvAction(formData));
      if (!result.ok) {
        setImportError(result);
        return;
      }
      setImportError(null);
      router.push(`/imports/${result.data.batchId}`);
    });
  }

  const generic = preview?.format === "generic";
  const configError = (path: string) => previewError?.fieldErrors[`config.${path}`];
  const previewAlerts = formLevelErrors(
    previewError,
    (field) => generic && MAPPING_FIELDS.has(field),
  );
  const importAlerts = formLevelErrors(importError, () => false);
  // The import reads the file with the mapping of the preview: an edited mapping is read first.
  const mappingEdited =
    generic &&
    preview.config !== null &&
    JSON.stringify(mappingPayload(draft)) !==
      JSON.stringify(mappingPayload(mappingDraftOf(preview.config)));
  const canImport =
    preview !== null &&
    preview.rowCount > 0 &&
    preview.alreadyImported === null &&
    !mappingEdited &&
    !previewing &&
    !importing;

  const status = previewing ? (
    <p role="status" className="text-[13px] text-muted">
      読み込み中…
    </p>
  ) : null;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <section aria-label="ファイル" className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label="口座"
            htmlFor={`${id}-wallet`}
            help={
              <>
                取込形式: {formatLabel(wallet.importer)}
                {wallet.importer ? "（口座に保存済み）" : ""} ·{" "}
                <Link
                  href={`/imports/wallets/${wallet.id}`}
                  className="font-bold underline underline-offset-4"
                >
                  取込の設定
                </Link>
              </>
            }
          >
            <Select
              id={`${id}-wallet`}
              value={walletId}
              onChange={(event) => changeWallet(event.currentTarget.value)}
              aria-describedby={`${id}-wallet-help`}
            >
              {wallets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.kindLabel}）
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <DropZone
          id={`${id}-file`}
          file={file}
          onFile={chooseFile}
          error={fileError}
          status={status}
        />
        <Alerts messages={previewAlerts} />
      </section>

      {preview && file ? (
        <section aria-labelledby={`${id}-preview`} className="flex min-w-0 flex-col gap-4">
          <h2 id={`${id}-preview`} className="text-[15px] font-extrabold">
            プレビュー
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField
              label="取込形式"
              htmlFor={`${id}-format`}
              help={
                preview.format !== null && preview.format === wallet.importer
                  ? "口座に保存した形式で読みました"
                  : preview.format !== null && preview.format === preview.detectedFormat
                    ? "ファイルから判別しました。違うときは選び直してください"
                    : undefined
              }
            >
              <Select
                id={`${id}-format`}
                value={preview.format ?? ""}
                disabled={previewing || importing}
                onChange={(event) => changeFormat(event.currentTarget.value)}
              >
                {preview.format === null ? <option value="">選んでください</option> : null}
                {walletFormats.map((format) => (
                  <option key={format.key} value={format.key}>
                    {format.label}
                    {format.key === preview.detectedFormat ? "（自動判別）" : ""}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          {preview.format === null ? (
            <p className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">
              形式を判別できません。汎用を選んで列を対応づける
            </p>
          ) : null}

          {generic || preview.format === null ? (
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-[13px] font-bold text-muted">
                ファイルの先頭 {preview.table.length} 行
              </h3>
              <RawTable table={preview.table} columnCount={preview.columnCount} />
            </div>
          ) : null}

          {generic ? (
            <fieldset className="flex min-w-0 flex-col gap-3 border-y border-border py-4">
              <legend className="sr-only">列の対応</legend>
              <h3 aria-hidden="true" className="text-[13px] font-bold text-muted">
                列の対応
              </h3>
              <MappingFields
                idPrefix={`${id}-mapping`}
                draft={draft}
                onChange={setDraft}
                columns={columnsOfTable(preview.table, preview.columnCount)}
                errorOf={configError}
              />
              <div>
                <Button onClick={readMapping} disabled={previewing || importing}>
                  この対応で読む
                </Button>
              </div>
              {mappingEdited ? (
                <p className="text-[13px] font-bold text-warn">
                  列の対応を変えました。「この対応で読む」で読み直してから取り込みます。
                </p>
              ) : null}
              {preview.config === null && preview.rowCount === 0 ? (
                <p className="text-[13px] text-muted">
                  日付・摘要と、金額（符号付き）か出金・入金の列を選んで「この対応で読む」を押します。
                </p>
              ) : null}
            </fieldset>
          ) : null}

          <Counts preview={preview} />

          {preview.alreadyImported ? (
            <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
              このファイルは {formatDateTime(preview.alreadyImported.executedAt)}{" "}
              に取り込み済みです。
              <Link
                href={`/imports/${preview.alreadyImported.batchId}`}
                className="ml-1 font-bold underline underline-offset-4"
              >
                取込の結果を見る
              </Link>
            </p>
          ) : null}

          {preview.rows.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-[13px] font-bold text-muted">
                明細
                {preview.rowCount > preview.rows.length
                  ? `（先頭 ${preview.rows.length} 行。全 ${preview.rowCount.toLocaleString("ja-JP")} 行）`
                  : ""}
              </h3>
              <PreviewRowsTable rows={preview.rows} />
            </div>
          ) : null}

          {preview.failures.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-[13px] font-bold text-muted">失敗した行（取り込まれません）</h3>
              {preview.failures.length > FAILURES_SHOWN ? (
                <p className="text-[12px] text-muted">
                  先頭 {FAILURES_SHOWN} 行を出しています。ほか{" "}
                  {(preview.failures.length - FAILURES_SHOWN).toLocaleString("ja-JP")}{" "}
                  行は取込の結果で見られます。
                </p>
              ) : null}
              <FailuresTable failures={preview.failures.slice(0, FAILURES_SHOWN)} />
            </div>
          ) : null}

          {preview.warnings.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-[13px] font-bold text-muted">警告（取込は止まりません）</h3>
              <WarningsList warnings={preview.warnings} />
            </div>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <Checkbox
              id={`${id}-remember`}
              label="この形式と列対応を口座に保存し、次回から使う"
              checked={remember}
              onChange={(event) => setRemember(event.currentTarget.checked)}
            />
            <Alerts messages={importAlerts} />
            <div className="flex flex-wrap items-center justify-end gap-3">
              {preview.rowCount === 0 && !preview.alreadyImported ? (
                <span className="text-[12px] text-muted">取り込める明細がありません</span>
              ) : null}
              <Button variant="primary" onClick={importFile} disabled={!canImport}>
                {importing ? "取り込み中…" : "取り込む"}
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
