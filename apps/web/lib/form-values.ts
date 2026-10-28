import type { CompanySettings } from "@niho-finance/db";
import type { CompanyFormValues } from "@/components/settings/company-form";

/** The stored company as the text the form fields start with. */
export function toCompanyFormValues(company: CompanySettings | null): CompanyFormValues {
  return {
    name: company?.name ?? "",
    nameKana: company?.nameKana ?? "",
    representative: company?.representative ?? "",
    address: company?.address ?? "",
    foundedOn: company?.foundedOn ?? "",
    fiscalYearEndMonth: String(company?.fiscalYearEndMonth ?? 3),
    corporateNumber: company?.corporateNumber ?? "",
    invoiceRegistrationNumber: company?.invoiceRegistrationNumber ?? "",
    invoiceRegisteredOn: company?.invoiceRegisteredOn ?? "",
  };
}
