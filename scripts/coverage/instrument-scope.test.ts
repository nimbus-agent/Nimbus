import { describe, expect, test } from "bun:test";

import { shouldInstrument } from "./instrument-scope.ts";

describe("shouldInstrument", () => {
  test("instruments first-party package src", () => {
    expect(shouldInstrument("/repo/packages/gateway/src/engine/executor.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/cli/src/index.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/jira/src/tools.ts")).toBe(true);
  });
  test("skips node_modules, test/spec files, and non-src", () => {
    expect(shouldInstrument("/repo/node_modules/@babel/core/lib/index.js")).toBe(false);
    expect(shouldInstrument("/repo/packages/gateway/src/engine/executor.test.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/gateway/src/engine/foo.spec.ts")).toBe(false);
    expect(shouldInstrument("/repo/scripts/coverage/merge-coverage.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/ui/src/App.tsx")).toBe(false);
  });
  test("normalizes Windows backslashes", () => {
    expect(shouldInstrument(String.raw`C:\repo\packages\gateway\src\a.ts`)).toBe(true);
  });
});
