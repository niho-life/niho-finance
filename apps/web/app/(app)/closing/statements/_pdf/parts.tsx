import { Text, View } from "@react-pdf/renderer";
import {
  balanceSheetSides,
  formatStatementAmount,
  japaneseDate,
  type BusinessReport,
  type EquityStatement,
  type EtaxEdition,
  type FinancialBalanceSheet,
  type FinancialIncomeStatement,
  type StatementLine,
  type StatementNotes,
  type SupplementarySchedules,
} from "@niho-finance/reports";
import { PDF_COLORS, PDF_FONT_SIZES, pdfStyles } from "@/lib/pdf/styles";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";

/**
 * The 計算書類 on A4 portrait (17 §4.2–§4.7): the same lines as the screen and the HOT010 CSV, the
 * unit 「（単位：円）」 at the top right of each table, negatives with 「△」.
 */

const AMOUNT_WIDTH = 74;
const NBSP = " ";

function amountText(amount: bigint | null): string {
  return amount === null ? "" : formatStatementAmount(amount);
}

/** The heading of one statement: its title, the date or period, and the unit. */
export function StatementTitle({
  title,
  sub,
  breakBefore = false,
  unit = true,
}: {
  title: string;
  sub?: string;
  /** Start on a new page (the documents after the first in 計算書類). */
  breakBefore?: boolean;
  unit?: boolean;
}) {
  return (
    <View break={breakBefore} wrap={false} style={{ marginBottom: 6 }} minPresenceAhead={60}>
      <Text style={{ fontSize: 13, fontWeight: 700, textAlign: "center" }}>{title}</Text>
      {sub ? (
        <Text
          style={{
            fontSize: PDF_FONT_SIZES.body,
            color: PDF_COLORS.muted,
            textAlign: "center",
            marginTop: 2,
          }}
        >
          {sub}
        </Text>
      ) : null}
      {unit ? (
        <Text style={[pdfStyles.small, { textAlign: "right", marginTop: 6 }]}>（単位：円）</Text>
      ) : null}
    </View>
  );
}

/** 「（単位：円）」 at the top right (a document whose header already has the title). */
export function UnitLine() {
  return (
    <Text style={[pdfStyles.small, { textAlign: "right", marginBottom: 4 }]}>（単位：円）</Text>
  );
}

function SideHeader() {
  return (
    <PdfRow variant="header">
      <PdfCell flex={1}>科目</PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        金額
      </PdfCell>
    </PdfRow>
  );
}

function SideLine({ line }: { line: StatementLine | null }) {
  if (!line) {
    return (
      <PdfRow>
        <PdfCell flex={1}>{NBSP}</PdfCell>
      </PdfRow>
    );
  }
  if (line.kind === "title") {
    return (
      <PdfRow>
        <PdfCell flex={1} indent={line.indent} bold>
          {line.label}
        </PdfCell>
      </PdfRow>
    );
  }
  return (
    <PdfRow variant={line.kind === "total" ? "subtotal" : "body"}>
      <PdfCell flex={1} indent={line.indent}>
        {line.label}
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        {amountText(line.amount)}
      </PdfCell>
    </PdfRow>
  );
}

function SideTotal({ line, label }: { line: StatementLine | null; label: string }) {
  return (
    <PdfRow variant="total">
      <PdfCell flex={1}>{line?.label ?? label}</PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        {amountText(line?.amount ?? 0n)}
      </PdfCell>
    </PdfRow>
  );
}

/**
 * 貸借対照表 in 勘定式: 資産の部 on the left, 負債の部・純資産の部 on the right; the shorter side is padded
 * so that 資産合計 and 負債純資産合計 share the bottom row.
 */
export function BalanceSheetPdf({
  sheet,
  edition,
}: {
  sheet: FinancialBalanceSheet;
  edition: EtaxEdition;
}) {
  const sides = balanceSheetSides(sheet, edition);
  const rows = Math.max(sides.assets.length, sides.liabilitiesAndNetAssets.length);
  const padded = (lines: readonly StatementLine[]): (StatementLine | null)[] => [
    ...lines,
    ...Array.from({ length: rows - lines.length }, () => null),
  ];
  return (
    <View style={{ flexDirection: "row" }}>
      <View style={{ flex: 1, marginRight: 6 }}>
        <PdfTable>
          <SideHeader />
          {padded(sides.assets).map((line, index) => (
            <SideLine key={line?.code ?? `pad-${index}`} line={line} />
          ))}
          <SideTotal line={sides.assetsTotal} label="資産合計" />
        </PdfTable>
      </View>
      <View style={{ flex: 1, marginLeft: 6 }}>
        <PdfTable>
          <SideHeader />
          {padded(sides.liabilitiesAndNetAssets).map((line, index) => (
            <SideLine key={line?.code ?? `pad-${index}`} line={line} />
          ))}
          <SideTotal line={sides.liabilitiesAndNetAssetsTotal} label="負債純資産合計" />
        </PdfTable>
      </View>
    </View>
  );
}

/** 損益計算書 in 報告式: accounts in the inner column, totals and profits in the outer one. */
export function IncomeStatementPdf({ statement }: { statement: FinancialIncomeStatement }) {
  const visible = statement.lines.filter((line) => line.visible);
  const last = visible[visible.length - 1];
  return (
    <PdfTable>
      <PdfRow variant="header" fixed>
        <PdfCell flex={1}>科目</PdfCell>
        <PdfCell width={AMOUNT_WIDTH} align="right">
          金額
        </PdfCell>
        <PdfCell width={AMOUNT_WIDTH} align="right">
          金額
        </PdfCell>
      </PdfRow>
      {visible.map((line) => {
        if (line.kind === "title") {
          return (
            <PdfRow key={line.code}>
              <PdfCell flex={1} indent={line.indent} bold>
                {line.label}
              </PdfCell>
            </PdfRow>
          );
        }
        const total = line.kind === "total";
        return (
          <PdfRow key={line.code} variant={total ? (line === last ? "total" : "subtotal") : "body"}>
            <PdfCell flex={1} indent={line.indent}>
              {line.label}
            </PdfCell>
            <PdfCell width={AMOUNT_WIDTH} align="right">
              {total ? "" : amountText(line.amount)}
            </PdfCell>
            <PdfCell width={AMOUNT_WIDTH} align="right">
              {total ? amountText(line.amount) : ""}
            </PdfCell>
          </PdfRow>
        );
      })}
    </PdfTable>
  );
}

/** 株主資本等変動計算書 in the vertical form. */
export function EquityStatementPdf({ statement }: { statement: EquityStatement }) {
  const minDepth = Math.min(...statement.lines.map((line) => line.depth));
  return (
    <PdfTable>
      <PdfRow variant="header" fixed>
        <PdfCell flex={1}>科目</PdfCell>
        <PdfCell width={AMOUNT_WIDTH} align="right">
          金額
        </PdfCell>
      </PdfRow>
      {statement.lines.map((line) => {
        const indent = Math.max(0, line.depth - minDepth);
        return line.kind === "title" ? (
          <PdfRow key={line.code}>
            <PdfCell flex={1} indent={indent} bold>
              {line.label}
            </PdfCell>
          </PdfRow>
        ) : (
          <PdfRow key={line.code}>
            <PdfCell flex={1} indent={indent}>
              {line.label}
            </PdfCell>
            <PdfCell width={AMOUNT_WIDTH} align="right">
              {amountText(line.amount)}
            </PdfCell>
          </PdfRow>
        );
      })}
    </PdfTable>
  );
}

const paragraph = { marginTop: 2, lineHeight: 1.5 } as const;

/** 個別注記表: numbered sections with their sentence and items. */
export function NotesPdf({ notes }: { notes: StatementNotes }) {
  return (
    <View>
      {notes.sections.map((section, index) => (
        <View key={section.code} style={{ marginBottom: 10 }}>
          <Text style={{ fontWeight: 700 }} minPresenceAhead={30}>
            {index + 1}. {section.title}
          </Text>
          {section.body ? <Text style={paragraph}>{section.body}</Text> : null}
          {section.items.map((item, itemIndex) => (
            <View key={`${item.code}-${itemIndex}`} style={{ marginTop: 4, paddingLeft: 10 }}>
              <Text style={{ fontWeight: 700 }}>
                （{itemIndex + 1}）{item.title}
              </Text>
              <Text style={paragraph}>{item.body}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const SCHEDULE_WIDTH = 58;

function ScheduleHeading({ children }: { children: string }) {
  return (
    <Text style={pdfStyles.heading} minPresenceAhead={60}>
      {children}
    </Text>
  );
}

/** 附属明細書: 固定資産の明細, 引当金の明細, 販売費及び一般管理費の明細 (17 §4.7). */
export function SchedulesPdf({ schedules }: { schedules: SupplementarySchedules }) {
  const { fixedAssets, provisions, sga } = schedules;
  const fixedColumns = [
    "期首帳簿価額",
    "当期増加額",
    "当期減少額",
    "当期償却額",
    "期末帳簿価額",
    "減価償却累計額",
    "期末取得原価",
  ];
  return (
    <View>
      <ScheduleHeading>1. 有形固定資産及び無形固定資産の明細</ScheduleHeading>
      {fixedAssets.message ? (
        <Text style={pdfStyles.note}>{fixedAssets.message}</Text>
      ) : (
        <PdfTable>
          <PdfRow variant="header">
            <PdfCell flex={1}>資産の種類</PdfCell>
            {fixedColumns.map((label) => (
              <PdfCell key={label} width={SCHEDULE_WIDTH} align="right">
                {label}
              </PdfCell>
            ))}
          </PdfRow>
          {(["tangible", "intangible"] as const).map((kind) => {
            const rows = fixedAssets.rows.filter((row) => row.kind === kind);
            if (rows.length === 0) return null;
            const totals = fixedAssets[kind];
            const values = (row: typeof totals) => [
              row.openingBookValue,
              row.increase,
              row.decrease,
              row.depreciation,
              row.closingBookValue,
              row.accumulatedDepreciation,
              row.closingAcquisitionCost,
            ];
            return (
              <View key={kind}>
                {rows.map((row) => (
                  <PdfRow key={`${kind}-${row.assetType}`}>
                    <PdfCell flex={1}>{row.assetType}</PdfCell>
                    {values(row).map((value, index) => (
                      <PdfCell key={index} width={SCHEDULE_WIDTH} align="right">
                        {formatStatementAmount(value)}
                      </PdfCell>
                    ))}
                  </PdfRow>
                ))}
                <PdfRow variant="subtotal">
                  <PdfCell flex={1}>
                    {kind === "tangible" ? "有形固定資産計" : "無形固定資産計"}
                  </PdfCell>
                  {values(totals).map((value, index) => (
                    <PdfCell key={index} width={SCHEDULE_WIDTH} align="right">
                      {formatStatementAmount(value)}
                    </PdfCell>
                  ))}
                </PdfRow>
              </View>
            );
          })}
        </PdfTable>
      )}

      <ScheduleHeading>2. 引当金の明細</ScheduleHeading>
      {provisions.message ? (
        <Text style={pdfStyles.note}>{provisions.message}</Text>
      ) : (
        <PdfTable>
          <PdfRow variant="header">
            <PdfCell flex={1}>科目</PdfCell>
            <PdfCell width={66} align="right">
              期首残高
            </PdfCell>
            <PdfCell width={66} align="right">
              当期増加額
            </PdfCell>
            <PdfCell width={72} align="right">
              当期減少額（目的使用）
            </PdfCell>
            <PdfCell width={72} align="right">
              当期減少額（その他）
            </PdfCell>
            <PdfCell width={66} align="right">
              期末残高
            </PdfCell>
          </PdfRow>
          {provisions.rows.map((row) => (
            <PdfRow key={row.accountId}>
              <PdfCell flex={1}>{row.label}</PdfCell>
              <PdfCell width={66} align="right">
                {formatStatementAmount(row.opening)}
              </PdfCell>
              <PdfCell width={66} align="right">
                {formatStatementAmount(row.increase)}
              </PdfCell>
              <PdfCell width={72} align="right">
                {formatStatementAmount(row.usedForPurpose)}
              </PdfCell>
              <PdfCell width={72} align="right">
                {formatStatementAmount(row.otherDecrease)}
              </PdfCell>
              <PdfCell width={66} align="right">
                {formatStatementAmount(row.closing)}
              </PdfCell>
            </PdfRow>
          ))}
        </PdfTable>
      )}

      <ScheduleHeading>3. 販売費及び一般管理費の明細</ScheduleHeading>
      {sga.rows.length === 0 ? (
        <Text style={pdfStyles.note}>該当がありません</Text>
      ) : (
        <PdfTable>
          <PdfRow variant="header">
            <PdfCell flex={1}>科目</PdfCell>
            <PdfCell width={AMOUNT_WIDTH} align="right">
              金額
            </PdfCell>
          </PdfRow>
          {sga.rows.map((row) => (
            <PdfRow key={row.accountId}>
              <PdfCell flex={1}>{row.label}</PdfCell>
              <PdfCell width={AMOUNT_WIDTH} align="right">
                {formatStatementAmount(row.amount)}
              </PdfCell>
            </PdfRow>
          ))}
          <PdfRow variant="total">
            <PdfCell flex={1}>合計</PdfCell>
            <PdfCell width={AMOUNT_WIDTH} align="right">
              {formatStatementAmount(sga.total)}
            </PdfCell>
          </PdfRow>
        </PdfTable>
      )}
    </View>
  );
}

/** 事業報告 (17 §4.6): the sections, then 作成日 (or a blank), 会社名 and 代表取締役. */
export function BusinessReportPdf({ report }: { report: BusinessReport }) {
  return (
    <View>
      {report.sections.map((section) => (
        <View key={section.heading} style={{ marginBottom: 10 }}>
          <Text style={pdfStyles.heading} minPresenceAhead={30}>
            {section.heading}
          </Text>
          {section.items.map((item, index) => (
            <View key={`${section.heading}-${index}`} style={{ marginTop: 3, paddingLeft: 10 }}>
              {item.label ? <Text style={{ fontWeight: 700 }}>{item.label}</Text> : null}
              <Text style={paragraph}>{item.body}</Text>
            </View>
          ))}
        </View>
      ))}
      <View style={{ marginTop: 18, alignItems: "flex-end" }} wrap={false}>
        <Text>{report.createdOn ? japaneseDate(report.createdOn) : "　　　　年　　月　　日"}</Text>
        <Text style={{ marginTop: 4 }}>{report.companyName}</Text>
        <Text style={{ marginTop: 2 }}>
          代表取締役{"　"}
          {report.representative ?? "　　　　　　"}
        </Text>
      </View>
    </View>
  );
}
