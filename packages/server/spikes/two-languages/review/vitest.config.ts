import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["spikes/two-languages/review/*.test.ts"] },
});
