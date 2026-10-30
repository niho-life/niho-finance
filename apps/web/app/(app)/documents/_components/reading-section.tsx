import {
  READING_PROPOSAL_FIELD_LABELS,
  type ProposalRate,
  type ProposalRow,
  type ReadingProposal,
  type ReadingProposalField,
} from "@niho-finance/db";
import { addDays, getTaxCategory, isValidInvoiceRegistrationNumber } from "@niho-finance/ledger";
import {
  isReadableMime,
  READER_ERROR_MESSAGES,
  type ReadingIssue,
  type ReadingIssueField,
} from "@niho-finance/reader";
import { formatAmountDisplay, formatDate, formatDateTime, formatYenDisplay } from "@/lib/format";
import type { ReaderStatus } from "@/lib/reader/config";
import {
  ReadingProposalPanel,
  type ReadingRateView,
  type ReadingRowView,
  type ReadingView,
} from "./reading-proposal";

const DESCRIPTION = "日付・金額・発行者・登録番号を読み取り、提案として入れます";

const ROW_LABELS: Readonly<Record<ReadingProposalField, string>> = {
  ...READING_PROPOSAL_FIELD_LABELS,
  amount: "金額（円）",
};

const NUMERIC_FIELDS: ReadonlySet<ReadingProposalField> = new Set([
  "txnDate",
  "amount",
  "invoiceRegistrationNumber",
]);

/** The item a warning of the reading blocks (the same mapping as the repository's). */
const FIELD_OF_ISSUE: Readonly<Record<ReadingIssueField, ReadingProposalField | null>> = {
  documentType: "kind",
  transactionDate: "txnDate",
  totalAmount: "amount",
  currency: "amount",
  rates: null,
  registrationNumber: "invoiceRegistrationNumber",
  issuerName: "partner",
};

const MATCH_NOTES = {
  registration_number: "（登録番号が一致）",
  name: "（名前が一致）",
} as const;

function rowView(
  row: ProposalRow,
  issues: readonly ReadingIssue[],
  voided: boolean,
): ReadingRowView {
  const match = row.partnerMatch === null ? "" : MATCH_NOTES[row.partnerMatch];
  let note: string | null = null;
  if (!voided && !row.selectable) {
    const blocking = issues.find(
      (issue) =>
        issue.severity === "error" &&
        issue.field !== null &&
        FIELD_OF_ISSUE[issue.field] === row.field,
    );
    note = row.same ? "保存済み" : (blocking?.message ?? "保存できません");
  }
  return {
    field: row.field,
    label: ROW_LABELS[row.field],
    value: `${row.proposedLabel ?? row.proposed ?? ""}${match}`,
    numeric: NUMERIC_FIELDS.has(row.field),
    current: !row.same && row.currentLabel ? row.currentLabel : null,
    selectable: row.selectable,
    defaultChecked: row.defaultChecked,
    note,
  };
}

/** 「課税仕入 10%（インボイスなし・控除 70%）」: the deductible ratio of the transitional categories. */
function categoryName(rate: ProposalRate): string {
  if (rate.estimatedTaxCategory === null) return "—";
  const name = getTaxCategory(rate.estimatedTaxCategory)?.name ?? "—";
  const percent = rate.deductiblePercent;
  if (percent === null || percent >= 100 || !name.endsWith("）")) return name;
  return `${name.slice(0, -1)}・控除 ${percent}%）`;
}

function rateView(rate: ProposalRate): ReadingRateView {
  return {
    rate: `${rate.ratePercent}%`,
    amount: formatYenDisplay(rate.inclusiveAmount),
    tax: formatAmountDisplay(rate.taxAmount),
    category: categoryName(rate),
  };
}

/** 「（経過措置: インボイスなし 70%）」 from the estimate of a rate line, when there is one. */
function transitionalNote(rates: readonly ProposalRate[]): string {
  const transitional = rates.find(
    (rate) => rate.estimatedTaxCategory?.endsWith("_ni") && rate.deductiblePercent !== null,
  );
  return transitional ? `（経過措置: インボイスなし ${transitional.deductiblePercent}%）` : "";
}

/** 登録番号の照合 (20-reader §10.1): a failed or missing lookup is muted, never 要確認. */
function registryLine(
  proposal: ReadingProposal,
  number: string | null,
  ntaEnabled: boolean,
): ReadingView["registry"] {
  const { registry } = proposal;
  if (registry) {
    const name = registry.name ?? null;
    if (registry.status === "registered") {
      const until = registry.endedOn === null ? "" : formatDate(addDays(registry.endedOn, -1));
      const since =
        registry.registeredOn === null ? null : `${formatDate(registry.registeredOn)}〜${until}`;
      return { text: ["登録あり", name, since].filter(Boolean).join(" · "), muted: false };
    }
    if (!registry.found) {
      return {
        text: `公表サイトにこの登録番号がありません${transitionalNote(proposal.rates)}`,
        muted: false,
      };
    }
    const ended =
      registry.endedOn === null
        ? registry.registeredOn === null
          ? null
          : `登録 ${formatDate(registry.registeredOn)}〜`
        : `${registry.endReason === "revoked" ? "取消" : "失効"} ${formatDate(registry.endedOn)}`;
    return {
      text: [`取引年月日には未登録${transitionalNote(proposal.rates)}`, name, ended]
        .filter(Boolean)
        .join(" · "),
      muted: false,
    };
  }
  if (proposal.registryError) {
    return { text: `照合できませんでした（${proposal.registryError}）`, muted: true };
  }
  // The estimate used the matched partner's stored lookup.
  if (proposal.registrationStatus === "registered") {
    return { text: "取引先の照合結果では、取引年月日に登録あり", muted: false };
  }
  if (proposal.registrationStatus === "not_registered") {
    return {
      text: `取引先の照合結果では、取引年月日には未登録${transitionalNote(proposal.rates)}`,
      muted: false,
    };
  }
  if (number === null) return { text: "登録番号の記載がないため、照合していません", muted: true };
  if (!ntaEnabled) return { text: "照合していません（アプリケーション ID の設定後）", muted: true };
  if (!isValidInvoiceRegistrationNumber(number)) {
    return { text: "登録番号が正しくないため、照合していません", muted: true };
  }
  return { text: "照合していません（読み取り直すと照合します）", muted: true };
}

function emptyView(documentId: string): Omit<ReadingView, "state" | "message"> {
  return {
    documentId,
    heading: null,
    rows: [],
    allSaved: false,
    rates: [],
    registry: null,
    issues: [],
    canRead: false,
    canSave: false,
    notice: null,
  };
}

/** What the section shows, or `null` when it shows nothing (20-reader §10.1's table of states). */
export function readingView(input: {
  documentId: string;
  mime: string;
  voided: boolean;
  proposal: ReadingProposal | null;
  reader: ReaderStatus;
  ntaEnabled: boolean;
}): ReadingView | null {
  const { documentId, mime, voided, proposal, reader, ntaEnabled } = input;
  const readable = isReadableMime(mime);
  const canRead = reader.enabled && !voided && readable;

  if (!proposal) {
    if (voided) return null;
    if (reader.invalidReason) {
      return { ...emptyView(documentId), state: "notice", message: reader.invalidReason };
    }
    if (!reader.enabled) return null;
    if (!readable) {
      return {
        ...emptyView(documentId),
        state: "notice",
        message: READER_ERROR_MESSAGES.unsupported_mime,
      };
    }
    return { ...emptyView(documentId), state: "empty", message: DESCRIPTION, canRead };
  }

  const heading = `${formatDateTime(proposal.readAt)} · ${proposal.model}`;
  const notice = reader.invalidReason;
  if (proposal.status === "failed") {
    return {
      ...emptyView(documentId),
      state: "failed",
      heading,
      message: `読み取れませんでした（${proposal.error ?? "理由は記録されていません"}）`,
      canRead,
      notice,
    };
  }

  const shown = proposal.rows.filter((row) => row.proposed !== null);
  const number =
    proposal.rows.find((row) => row.field === "invoiceRegistrationNumber")?.proposed ?? null;
  return {
    documentId,
    state: "proposed",
    heading,
    message: null,
    rows: shown.map((row) => rowView(row, proposal.issues, proposal.voided)),
    allSaved: proposal.allSaved,
    rates: proposal.rates.map(rateView),
    registry: registryLine(proposal, number, ntaEnabled),
    issues: proposal.issues.map((issue) => issue.message),
    canRead,
    canSave: !proposal.voided,
    notice,
  };
}

/**
 * 読み取り of the detail, above 項目 (20-reader §10.1). Nothing without a provider and a stored
 * reading. A new reading starts the checks over (the key is the time it was read).
 */
export function ReadingSection(props: Parameters<typeof readingView>[0]) {
  const view = readingView(props);
  if (!view) return null;
  return (
    <ReadingProposalPanel key={props.proposal?.readAt.toISOString() ?? "unread"} view={view} />
  );
}
