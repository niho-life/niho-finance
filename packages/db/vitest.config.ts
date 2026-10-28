import { defineConfig } from "vitest/config";

// Unit tests only. Database tests (*.db.test.ts) run with `npm run test:db` (vitest.db.config.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.db.test.ts", "**/node_modules/**"],
  },
});
