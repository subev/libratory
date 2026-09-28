import { defineConfig } from "vitest/config";

// Export packaging is filesystem-only; it does not need the server suite's database setup.
export default defineConfig({
  test: { include: ["src/lib/readaloud-epub.test.ts"] },
});
