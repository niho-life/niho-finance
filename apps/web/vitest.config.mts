import { defineConfig } from "vitest/config";

// Unit tests of server-side helpers in lib/: no database and no Next.js runtime.
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
  },
});
