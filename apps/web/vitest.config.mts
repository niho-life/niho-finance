import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const appDir = path.dirname(fileURLToPath(import.meta.url));

// Unit tests of server-side helpers (lib/**, test/**): no database and no Next.js runtime.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: `${appDir}/` }] },
  test: {
    include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
