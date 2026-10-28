"use client";

import type { CsvFormatKey, GenericCsvConfig } from "@niho-finance/importers";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { updateWalletImporterAction } from "../../actions";
import { MappingFields, numberedColumns } from "../../_components/mapping-fields";
import {
  highestMappedColumn,
  MAPPING_COLUMNS,
  mappingDraftOf,
  mappingPayload,
  type MappingDraft,
} from "../../_lib/mapping";

/** Columns offered without a file (a saved mapping beyond them widens the list). */
const COLUMNS_WITHOUT_FILE = 30;

const SHOWN_FIELDS: ReadonlySet<string> = new Set([
  "importer",
  ...MAPPING_COLUMNS.map((column) => `importerConfig.columns.${column}`),
  "importerConfig.headerRows",
  "importerConfig.order",
  "importerConfig.invertSign",
]);

/**
 * 取込形式 of a bank / card / other wallet (12-imports §1.4): 自動判別, a format of the wallet's
 * kind, or 汎用 with its columns chosen by number (1-based here, 0-based in the mapping).
 */
export function ImporterForm({
  walletId,
  formats,
  importer,
  config,
}: {
  walletId: string;
  /** The formats fitting the wallet's kind, 汎用 last. */
  formats: readonly { key: CsvFormatKey; label: string }[];
  importer: CsvFormatKey | null;
  config: GenericCsvConfig | null;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [format, setFormat] = useState<string>(importer ?? "");
  const [draft, setDraft] = useState<MappingDraft>(() => mappingDraftOf(config));
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const columns = numberedColumns(Math.max(COLUMNS_WITHOUT_FILE, highestMappedColumn(config) + 1));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = {
      walletId,
      importer: format,
      importerConfig: format === "generic" ? mappingPayload(draft) : null,
    };
    startTransition(async () => {
      const result = await updateWalletImporterAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast("取込の設定を保存しました");
      router.refresh();
    });
  }

  const importerError = error?.fieldErrors.importer;
  const alerts = formLevelErrors(
    error,
    (field) => SHOWN_FIELDS.has(field) && (field === "importer" || format === "generic"),
  );

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      <div className="max-w-md">
        <FormField
          label="取込形式"
          htmlFor={`${id}-format`}
          error={importerError}
          help={
            format === ""
              ? "ファイルの先頭の行から形式を判別します。判別できないときは取込の画面で選びます"
              : format === "generic"
                ? "列を番号で選びます。ファイルを見ながら選ぶときは、CSV の取込で列を対応づけて口座に保存します"
                : undefined
          }
        >
          <Select
            id={`${id}-format`}
            value={format}
            onChange={(event) => setFormat(event.currentTarget.value)}
            {...describedBy(`${id}-format`, {
              help: format === "" || format === "generic",
              error: importerError,
            })}
          >
            <option value="">自動判別</option>
            {formats.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {format === "generic" ? (
        <fieldset className="flex min-w-0 flex-col gap-3 border-y border-border py-4">
          <legend className="sr-only">列の対応</legend>
          <h3 aria-hidden="true" className="text-[13px] font-bold text-muted">
            列の対応
          </h3>
          <MappingFields
            idPrefix={`${id}-mapping`}
            draft={draft}
            onChange={setDraft}
            columns={columns}
            errorOf={(path) => error?.fieldErrors[`importerConfig.${path}`]}
          />
        </fieldset>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}
