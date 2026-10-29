import { formatYen } from "@niho-finance/ledger";
import {
  propertyTaxAssetTypeText,
  slashPeriod,
  warekiDate,
  type DepreciableAssetsReturn,
  type DepreciableAssetsReturnRow,
  type DepreciableAssetsReturnTotal,
} from "@niho-finance/reports";
import { Text, View } from "@react-pdf/renderer";
import { ReportDocument } from "@/lib/pdf/document";
import { pdfStyles } from "@/lib/pdf/styles";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";

/*
 * 償却資産申告の元データ (16 §14.4): A4 landscape, the two tables of the 種類別明細書 of 第二十六号様式
 * — (増加資産・全資産用) and (減少資産用) — with their totals. 減価残存率・価額・課税標準額 are the
 * municipality's (一般方式) and stay empty, as on the form.
 */

const W = {
  type: 104,
  quantity: 30,
  acquired: 84,
  cost: 74,
  life: 44,
  rate: 46,
  value: 54,
  base: 60,
  increase: 50,
  decrease: 54,
  scope: 36,
} as const;

function typeText(row: DepreciableAssetsReturnRow): string {
  return row.assetType === null ? "（未選択）" : propertyTaxAssetTypeText(row.assetType);
}

function Leading({ row }: { row: DepreciableAssetsReturnRow }) {
  return (
    <>
      <PdfCell width={W.type}>{typeText(row)}</PdfCell>
      <PdfCell flex={2}>{row.name}</PdfCell>
      <PdfCell width={W.quantity} align="right">
        {row.quantity}
      </PdfCell>
      <PdfCell width={W.acquired}>{row.acquisitionWareki}</PdfCell>
      <PdfCell width={W.cost} align="right">
        {formatYen(row.cost)}
      </PdfCell>
      <PdfCell width={W.life} align="right">
        {row.usefulLifeYears === null ? "" : row.usefulLifeYears}
      </PdfCell>
    </>
  );
}

function LeadingHeader() {
  return (
    <>
      <PdfCell width={W.type}>資産の種類</PdfCell>
      <PdfCell flex={2}>資産の名称等</PdfCell>
      <PdfCell width={W.quantity} align="right">
        数量
      </PdfCell>
      <PdfCell width={W.acquired}>取得年月</PdfCell>
      <PdfCell width={W.cost} align="right">
        取得価額
      </PdfCell>
      <PdfCell width={W.life} align="right">
        耐用年数
      </PdfCell>
    </>
  );
}

/** 合計 rows: the count in 数量, the cost in 取得価額. */
function TotalRow({
  label,
  total,
  variant,
  rest,
}: {
  label: string;
  total: DepreciableAssetsReturnTotal;
  variant: "subtotal" | "total";
  rest: number[];
}) {
  return (
    <PdfRow variant={variant}>
      <PdfCell width={W.type}>{label}</PdfCell>
      <PdfCell flex={2} />
      <PdfCell width={W.quantity} align="right">
        {total.count}
      </PdfCell>
      <PdfCell width={W.acquired} />
      <PdfCell width={W.cost} align="right">
        {formatYen(total.cost)}
      </PdfCell>
      <PdfCell width={W.life} />
      {rest.map((width, index) => (
        <PdfCell key={index} width={width} />
      ))}
      <PdfCell flex={1.6} />
    </PdfRow>
  );
}

function EmptyRow() {
  return (
    <PdfRow>
      <PdfCell muted>該当する資産はありません</PdfCell>
    </PdfRow>
  );
}

export function DepreciableAssetsReturnPdf({
  data,
  exportedAt,
}: {
  data: DepreciableAssetsReturn & { companyName: string | null; municipality: string | null };
  exportedAt?: Date;
}) {
  const period = slashPeriod(data.window.from, data.window.to);
  const increaseRest = [W.rate, W.value, W.base, W.increase];
  const decreaseRest = [W.decrease, W.scope];
  return (
    <ReportDocument
      title="償却資産申告の元データ"
      company={data.companyName ?? ""}
      periodLabel={`${warekiDate(data.assessmentDate)}現在`}
      subtitle={data.municipality ? `申告先 ${data.municipality}` : undefined}
      orientation="landscape"
      exportedAt={exportedAt}
    >
      <Text style={pdfStyles.heading}>種類別明細書（増加資産・全資産用）</Text>
      <Text style={pdfStyles.note}>
        {`${data.year} 年 1 月 1 日に持っている対象の資産（全資産）。増加事由のある行は ${period} に取得した増加資産です。金額の単位は円。`}
      </Text>
      <PdfTable>
        <PdfRow variant="header" fixed>
          <LeadingHeader />
          <PdfCell width={W.rate} align="right">
            減価残存率
          </PdfCell>
          <PdfCell width={W.value} align="right">
            価額
          </PdfCell>
          <PdfCell width={W.base} align="right">
            課税標準額
          </PdfCell>
          <PdfCell width={W.increase}>増加事由</PdfCell>
          <PdfCell flex={1.6}>摘要</PdfCell>
        </PdfRow>
        {data.all.length === 0 ? <EmptyRow /> : null}
        {data.all.map((row) => (
          <PdfRow key={row.assetId}>
            <Leading row={row} />
            <PdfCell width={W.rate} />
            <PdfCell width={W.value} />
            <PdfCell width={W.base} />
            <PdfCell width={W.increase}>{row.increaseReason ?? ""}</PdfCell>
            <PdfCell flex={1.6}>{row.note ?? ""}</PdfCell>
          </PdfRow>
        ))}
        <TotalRow
          label="うち増加資産"
          total={data.totals.increased}
          variant="subtotal"
          rest={increaseRest}
        />
        <TotalRow label="合計" total={data.totals.all} variant="total" rest={increaseRest} />
      </PdfTable>

      <View break>
        <Text style={pdfStyles.heading}>種類別明細書（減少資産用）</Text>
        <Text style={pdfStyles.note}>
          {`${period} に除却・売却した、前年の申告の対象の資産。除却は「滅失」としています。金額の単位は円。`}
        </Text>
        <PdfTable>
          <PdfRow variant="header" fixed>
            <LeadingHeader />
            <PdfCell width={W.decrease}>減少の事由</PdfCell>
            <PdfCell width={W.scope}>区分</PdfCell>
            <PdfCell flex={1.6}>摘要</PdfCell>
          </PdfRow>
          {data.decreased.length === 0 ? <EmptyRow /> : null}
          {data.decreased.map((row) => (
            <PdfRow key={row.assetId}>
              <Leading row={row} />
              <PdfCell width={W.decrease}>{row.decrease?.reason ?? ""}</PdfCell>
              <PdfCell width={W.scope}>{row.decrease?.scope ?? ""}</PdfCell>
              <PdfCell flex={1.6}>{row.note ?? ""}</PdfCell>
            </PdfRow>
          ))}
          <TotalRow
            label="合計"
            total={data.totals.decreased}
            variant="total"
            rest={decreaseRest}
          />
        </PdfTable>
        <Text style={pdfStyles.note}>
          減価残存率・価額・課税標準額は市町村が計算します（一般方式）。免税点（課税標準額の合計 150
          万円未満）も市町村が判定します。
        </Text>
        {data.warnings.length > 0 ? (
          <Text style={pdfStyles.note}>
            {`資産の種類が未選択・耐用年数が未入力の資産が ${new Set(data.warnings.map((warning) => warning.assetId)).size} 件あります。固定資産の詳細で入れてから申告します。`}
          </Text>
        ) : null}
      </View>
    </ReportDocument>
  );
}
