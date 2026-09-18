import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}", "extensions/*/tests/*.{test,spec}.{js,ts}"],
    environment: "node",
    testTimeout: 15_000,
  },
});
