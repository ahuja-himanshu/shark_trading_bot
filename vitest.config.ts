import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 60,
        functions: 75,
        lines: 75,
        statements: 70,
      },
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
