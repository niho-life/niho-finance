import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyEnvFile,
  assertNihoFinanceDatabase,
  describeDatabaseUrl,
  findRepoRoot,
} from "../src/env";
import { deriveTestDatabaseUrl } from "./support/database";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("environment helpers", () => {
  it("finds the workspace root from a package directory", () => {
    expect(findRepoRoot(here)).toBe(path.resolve(here, "../../.."));
  });

  it("describes a URL without its credentials", () => {
    expect(
      describeDatabaseUrl("postgresql://user:secret@db.example:5433/niho_finance?schema=public"),
    ).toEqual({
      host: "db.example",
      port: "5433",
      database: "niho_finance",
    });
    expect(describeDatabaseUrl("postgresql://user@localhost/niho_finance").port).toBe("5432");
  });

  it("only accepts niho_finance databases", () => {
    expect(() =>
      assertNihoFinanceDatabase("postgresql://u:p@localhost:5433/niho_finance"),
    ).not.toThrow();
    expect(() =>
      assertNihoFinanceDatabase("postgresql://u:p@localhost:5433/niho_finance_test"),
    ).not.toThrow();
    expect(() => assertNihoFinanceDatabase("postgresql://u:p@localhost:5440/niho")).toThrow(
      /Refusing to use database "niho"/,
    );
    expect(() => assertNihoFinanceDatabase("postgresql://u:p@localhost:5432/postgres")).toThrow(
      /Refusing/,
    );
    expect(() =>
      assertNihoFinanceDatabase("postgresql://u:secret@localhost:5440/niho"),
    ).not.toThrow(/secret/);
  });

  it("derives the test database next to the main one", () => {
    expect(
      deriveTestDatabaseUrl("postgresql://u:p@localhost:5433/niho_finance?schema=public"),
    ).toBe("postgresql://u:p@localhost:5433/niho_finance_test?schema=public");
  });

  describe("applyEnvFile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "niho-finance-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(
      file,
      'DATABASE_URL="postgresql://niho:pw@localhost:5433/niho_finance?schema=public"\nNIHO_FINANCE_ENV=local\n',
    );
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("fills variables that are not set", () => {
      const env: NodeJS.ProcessEnv = {};
      expect(applyEnvFile(file, env)).toEqual([]);
      expect(env).toEqual({
        DATABASE_URL: "postgresql://niho:pw@localhost:5433/niho_finance?schema=public",
        NIHO_FINANCE_ENV: "local",
      });
    });

    it("keeps variables that are already set, including another niho_finance database", () => {
      const env: NodeJS.ProcessEnv = {
        DATABASE_URL: "postgresql://ci:pw@localhost:5432/niho_finance_test",
        NIHO_FINANCE_ENV: "prod",
      };
      expect(applyEnvFile(file, env)).toEqual([]);
      expect(env.DATABASE_URL).toBe("postgresql://ci:pw@localhost:5432/niho_finance_test");
      expect(env.NIHO_FINANCE_ENV).toBe("prod");
    });

    it("replaces a DATABASE_URL inherited for another project's database", () => {
      const env: NodeJS.ProcessEnv = { DATABASE_URL: "postgresql://other:pw@localhost:5440/niho" };
      expect(applyEnvFile(file, env)).toEqual(["DATABASE_URL"]);
      expect(env.DATABASE_URL).toBe(
        "postgresql://niho:pw@localhost:5433/niho_finance?schema=public",
      );
    });
  });
});
