import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { BACKUP_TABLES, backupTableSpecs } from "../src/backup";

describe("BACKUP_TABLES", () => {
  it("lists every Prisma model once, under its table name", () => {
    const models = Prisma.dmmf.datamodel.models;
    expect(BACKUP_TABLES.map((entry) => entry.model).sort()).toEqual(
      models.map((model) => model.name).sort(),
    );
    for (const model of models) {
      const entry = BACKUP_TABLES.find((item) => item.model === model.name);
      expect(entry?.table, model.name).toBe(model.dbName ?? model.name);
    }
  });

  it("is in foreign-key order (a table only references tables above it or itself)", () => {
    const position = new Map<string, number>(
      BACKUP_TABLES.map((entry, index) => [entry.model, index]),
    );
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields) {
        if (field.kind !== "object" || (field.relationFromFields ?? []).length === 0) continue;
        expect(
          position.get(field.type) ?? Infinity,
          `${model.name}.${field.name} → ${field.type}`,
        ).toBeLessThanOrEqual(position.get(model.name) ?? -1);
      }
    }
  });

  it("knows the columns, primary keys and self references from the schema", () => {
    const specs = new Map(backupTableSpecs().map((spec) => [spec.table, spec]));
    const entries = specs.get("journal_entry");
    expect(entries?.primaryKey).toEqual(["id"]);
    expect(entries?.byColumn.get("fiscal_year_id")).toEqual({
      field: "fiscalYearId",
      column: "fiscal_year_id",
      type: "String",
    });
    expect(entries?.selfReferences.sort()).toEqual(["replacedById", "reversalOfId"]);
    expect(specs.get("journal_line_memo_tag")?.primaryKey).toEqual(["journalLineId", "memoTagId"]);
    expect(specs.get("document")?.selfReferences).toEqual(["supersedesId"]);
    expect(specs.get("calendar_item")?.byColumn.get("last_notified_on")?.type).toBe("DateTime");
  });
});
