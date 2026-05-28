import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 10_000,
    reporters: ci
      ? ["default", ["junit", { outputFile: "../../junit-reports/junit-vitest.xml" }]]
      : ["default"],
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "**/*.vitest.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: ["src/test-setup.ts", "**/*.d.ts", "dist/**", "**/test/e2e/**"],
    },
  },
});
