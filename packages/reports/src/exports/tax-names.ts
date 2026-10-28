/**
 * The tax category names of freee and 弥生 (14-reports §11.4). Names change between versions;
 * this is the one place to correct them after a real import (04-integrations §9).
 */
export const FREEE_TAX_NAMES: Readonly<Record<string, string>> = {
  sales_10: "課税売上10%",
  sales_8r: "課税売上8%（軽減）",
  sales_exempt: "非課税売上",
  sales_out: "対象外",
  sales_export: "輸出売上",
  purchase_10: "課対仕入10%",
  purchase_8r: "課対仕入8%（軽減）",
  purchase_10_ni: "課対仕入（控除80%）10%",
  purchase_8r_ni: "課対仕入（控除80%）8%（軽減）",
  purchase_exempt: "非課税仕入",
  purchase_out: "対象外",
  na: "対象外",
};

export const YAYOI_TAX_NAMES: Readonly<Record<string, string>> = {
  sales_10: "課税売上10%",
  sales_8r: "課税売上8%(軽)",
  sales_exempt: "非課売上",
  sales_out: "対象外",
  sales_export: "輸出売上",
  purchase_10: "課対仕入10%",
  purchase_8r: "課対仕入8%(軽)",
  purchase_10_ni: "課対仕入10%",
  purchase_8r_ni: "課対仕入8%(軽)",
  purchase_exempt: "非課仕入",
  purchase_out: "対象外",
  na: "対象外",
};

export const TAX_NAME_OUT_OF_SCOPE = "対象外";

export function freeeTaxName(code: string): string {
  return FREEE_TAX_NAMES[code] ?? TAX_NAME_OUT_OF_SCOPE;
}

export function yayoiTaxName(code: string): string {
  return YAYOI_TAX_NAMES[code] ?? TAX_NAME_OUT_OF_SCOPE;
}

/** Purchases without a qualified invoice (経過措置): the ratio cannot be expressed in 弥生's name. */
export function isTransitionalPurchase(code: string): boolean {
  return code === "purchase_10_ni" || code === "purchase_8r_ni";
}
