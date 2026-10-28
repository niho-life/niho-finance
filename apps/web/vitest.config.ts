import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests of the server-side libraries (no database, no Next.js runtime).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".next/**"],
  },
});
