import { describe, expect, test } from "bun:test";

import { shouldInstrument } from "./instrument-scope.ts";

describe("shouldInstrument", () => {
  test("instruments first-party package src", () => {
    expect(shouldInstrument("/repo/packages/gateway/src/engine/executor.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/cli/src/index.ts")).toBe(true);
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
  // The connectors moved to their own repository, so nothing under packages/mcp-connectors is
  // instrumented here any more — asserted as NOT instrumented rather than deleted, so a
  // reintroduced path is caught rather than silently measured against a tree that does not exist.
  test("does not instrument the departed connector tree", () => {
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/mcp-search-tool.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/mcp-connectors/jira/src/tools.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/widget.tsx")).toBe(false);
  });
  test("skips test files inside instrumented roots", () => {
    expect(shouldInstrument("/repo/packages/gateway/src/foo.test.ts")).toBe(false);
  });

  /**
   * `sdk`, `client` and `mcp-launcher` were extracted to their own repos
   * (nimbus-sdk / nimbus-client / nimbus-mcp); no
   * `packages/{sdk,client,mcp-launcher}/src/` path exists here any more. Pinned
   * so the dead alternations are not restored — a scope regex naming packages
   * that cannot match reads as coverage being collected somewhere that it is
   * not. `mcp-launcher` is the sharpest case: it was IN this scope until its
   * extraction, so a careless revert would silently re-add a package whose
   * source is no longer here.
   */
  test("does not claim scope over packages that left this monorepo", () => {
    expect(shouldInstrument("/repo/packages/sdk/src/index.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/client/src/index.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/mcp-launcher/src/resolve-binary.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/mcp-launcher/src/exit-status.ts")).toBe(false);
  });
});
