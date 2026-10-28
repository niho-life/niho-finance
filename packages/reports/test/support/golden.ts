import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const goldenDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../golden");

/**
 * Compares `actual` with `test/golden/<name>`. `UPDATE_GOLDEN=1` rewrites the file (review the
 * diff before committing). A missing file fails with the instruction.
 */
export function expectGolden(name: string, actual: string | Uint8Array): void {
  const file = path.join(goldenDir, name);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`golden file ${name} is missing: run UPDATE_GOLDEN=1 vitest run and review it`);
  }
  if (typeof actual === "string") {
    expect(actual).toBe(readFileSync(file, "utf8"));
  } else {
    expect(Buffer.from(actual).equals(readFileSync(file))).toBe(true);
  }
}

export function goldenPath(name: string): string {
  return path.join(goldenDir, name);
}
