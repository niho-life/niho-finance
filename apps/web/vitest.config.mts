import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests of the server-side code: no database and no Next.js runtime. Tests sit next to the
// helpers in lib/ or in test/.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".next/**"],
  },
});
