import { describe, expect, it } from "vitest";
import { documentStorageConfig } from "@/lib/storage/config";

describe("documentStorageConfig", () => {
  it("uses GCS when the documents bucket is set (what scripts/deploy.sh sets)", () => {
    expect(
      documentStorageConfig({
        NIHO_FINANCE_ENV: "prod",
        NIHO_FINANCE_DOCUMENTS_BUCKET: "example-finance-documents",
      }),
    ).toEqual({ kind: "gcs", bucket: "example-finance-documents" });
  });

  it("uses a local folder without a bucket, outside production", () => {
    expect(documentStorageConfig({})).toEqual({ kind: "local" });
    expect(documentStorageConfig({ NIHO_FINANCE_ENV: "local", NIHO_FINANCE_STORAGE: "" })).toEqual({
      kind: "local",
    });
  });

  it("follows NIHO_FINANCE_STORAGE when it is set", () => {
    expect(
      documentStorageConfig({
        NIHO_FINANCE_STORAGE: "local",
        NIHO_FINANCE_DOCUMENTS_BUCKET: "example-finance-documents",
      }),
    ).toEqual({ kind: "local" });
    expect(() => documentStorageConfig({ NIHO_FINANCE_STORAGE: "gcs" })).toThrow(
      /needs NIHO_FINANCE_DOCUMENTS_BUCKET/,
    );
  });

  it("never stores evidence on a local disk in production", () => {
    expect(() => documentStorageConfig({ NIHO_FINANCE_ENV: "prod" })).toThrow(/stores evidence/);
    expect(() =>
      documentStorageConfig({
        NIHO_FINANCE_ENV: "prod",
        NIHO_FINANCE_STORAGE: "local",
        NIHO_FINANCE_DOCUMENTS_BUCKET: "example-finance-documents",
      }),
    ).toThrow(/stores evidence/);
  });
});
