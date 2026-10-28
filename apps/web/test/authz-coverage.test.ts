import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
 * Every Server Action and every route checks the role first (23-users-and-expenses §3.1, §3.2): the
 * first statements of each exported function are
 *   const denied = await authorizeAction("<role>"); if (denied) return denied;
 * (routes: `authorizeRoute(…)`). A lane that adds a Server Action or a route without it fails here.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");

/** The 管理者-only operations of 23 §1 (締め・事業所・会計期間・証憑の規程・銀行 API の接続・利用者・初期設定). */
const OWNER_ACTIONS: Readonly<Record<string, readonly string[] | "all">> = {
  "(app)/settings/actions.ts": [
    "saveCompanyAction",
    "updateFiscalYearAction",
    "createNextFiscalYearAction",
    "previewFiscalYearCloseAction",
    "closeFiscalYearAction",
  ],
  "(app)/closing/actions.ts": [
    "startYearEndAction",
    "cancelYearEndAction",
    "closeYearAction",
    "reopenYearAction",
  ],
  "(app)/settings/documents-policy/actions.ts": ["saveRecordsPolicyAction"],
  // 銀行 API の接続・口座の選択・切断: the bank's authorization of the company's account.
  "(app)/settings/wallets/[walletId]/bank/actions.ts": [
    "connectBankAction",
    "chooseBankAccountAction",
    "disconnectBankAction",
  ],
  "(app)/settings/users/actions.ts": "all",
  "setup/actions.ts": "all",
};

/** The argument of `authorizeRoute` per route (23 §3.2); `/api/health` and `/api/jobs/*` are not users'. */
const ROUTE_GUARDS: Readonly<Record<string, string>> = {
  "(app)/closing/statements/export/route.ts": '"accountant"',
  "(app)/invoices/[id]/pdf/route.ts": '"accountant"',
  "(app)/payroll/bonus/[id]/payslips/[employeeId]/pdf/route.ts": '"accountant"',
  "(app)/payroll/runs/[id]/payslips/[employeeId]/pdf/route.ts": '"accountant"',
  "(app)/payroll/year-end/[year]/[employeeId]/ledger/pdf/route.ts": '"accountant"',
  "(app)/reports/export/route.ts": '"viewer"',
  "(app)/settings/export/download/route.ts": "downloadMinimum(request)",
  "api/bank/gmo-aozora/authorize/route.ts": '"owner"',
  "api/bank/gmo-aozora/callback/route.ts": '"owner"',
  "api/documents/[id]/file/route.ts": '"accountant"',
  "api/documents/complete/route.ts": '"accountant", { json: true }',
  "api/documents/index.csv/route.ts": '"accountant"',
  "api/documents/prepare/route.ts": '"accountant", { json: true }',
  "api/documents/upload/route.ts": '"accountant", { json: true }',
};
const UNGUARDED_ROUTES = /^api\/(health|jobs)\//;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const relative = (file: string) => path.relative(appDir, file).split(path.sep).join("/");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function isUseServer(source: ts.SourceFile): boolean {
  const [first] = source.statements;
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  );
}

function exportedFunctions(source: ts.SourceFile): ts.FunctionDeclaration[] {
  return source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false),
  );
}

/** `const denied = await <guard>(<args>); if (denied) return denied;` → the args' text, else null. */
function guardArguments(
  fn: ts.FunctionDeclaration,
  source: ts.SourceFile,
  guard: string,
): string | null {
  const [first, second] = fn.body?.statements ?? [];
  if (!first || !second || !ts.isVariableStatement(first) || !ts.isIfStatement(second)) return null;
  const [declaration] = first.declarationList.declarations;
  if (
    first.declarationList.declarations.length !== 1 ||
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isAwaitExpression(declaration.initializer)
  ) {
    return null;
  }
  const call = declaration.initializer.expression;
  if (!ts.isCallExpression(call) || call.expression.getText(source) !== guard) return null;
  const name = declaration.name.text;
  const returns =
    second.expression.getText(source) === name &&
    !second.elseStatement &&
    (ts.isReturnStatement(second.thenStatement)
      ? second.thenStatement.expression?.getText(source) === name
      : false);
  if (!returns) return null;
  return call.arguments.map((argument) => argument.getText(source)).join(", ");
}

const actionFiles = filesUnder(appDir)
  .map((file) => ({ file, source: parse(file) }))
  .filter(({ source }) => isUseServer(source));

describe("Server Actions authorize first (23 §3.1)", () => {
  it("finds the Server Action files", () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(15);
    for (const name of Object.keys(OWNER_ACTIONS)) {
      expect(actionFiles.map(({ file }) => relative(file))).toContain(name);
    }
  });

  for (const { file, source } of actionFiles) {
    const name = relative(file);
    describe(name, () => {
      const owners = OWNER_ACTIONS[name];
      const functions = exportedFunctions(source);

      it("exports async functions only, each starting with authorizeAction", () => {
        expect(functions.length).toBeGreaterThan(0);
        for (const fn of functions) {
          const label = fn.name?.text ?? "(anonymous)";
          const isAsync =
            fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
          expect(isAsync, label).toBe(true);
          const expected = owners === "all" || owners?.includes(label) ? '"owner"' : '"accountant"';
          expect(guardArguments(fn, source, "authorizeAction"), label).toBe(expected);
        }
      });

      if (owners !== undefined && owners !== "all") {
        it("has every 管理者-only action of the table", () => {
          const names = functions.map((fn) => fn.name?.text);
          for (const owner of owners) expect(names, owner).toContain(owner);
        });
      }
    });
  }
});

describe("routes authorize first (23 §3.2)", () => {
  const routes = filesUnder(appDir).filter((file) => path.basename(file) === "route.ts");

  it("has a guard in the table for every route of the users", () => {
    const guarded = routes.map(relative).filter((name) => !UNGUARDED_ROUTES.test(name));
    expect(guarded.sort()).toEqual(Object.keys(ROUTE_GUARDS).sort());
  });

  for (const file of routes) {
    const name = relative(file);
    const expected = ROUTE_GUARDS[name];
    if (expected === undefined) continue;
    it(`${name} starts each handler with authorizeRoute(${expected})`, () => {
      const source = parse(file);
      const handlers = exportedFunctions(source).filter((fn) =>
        HTTP_METHODS.has(fn.name?.text ?? ""),
      );
      expect(handlers.length).toBeGreaterThan(0);
      for (const fn of handlers) {
        expect(guardArguments(fn, source, "authorizeRoute"), fn.name?.text).toBe(expected);
      }
    });
  }
});
