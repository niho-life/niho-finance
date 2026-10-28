import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const appDir = path.dirname(fileURLToPath(import.meta.url));

// Unit tests of the server-side libraries (storage, policy). Pages are not rendered here.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: `${appDir}/` }] },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
