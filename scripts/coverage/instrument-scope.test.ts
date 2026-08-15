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
  test("instruments mcp-connectors/shared helpers (flat, nested, tsx)", () => {
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/mcp-search-tool.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/sub/bar.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/widget.tsx")).toBe(true);
  });
  test("still instruments connector src and still skips shared test files", () => {
    expect(shouldInstrument("/repo/packages/mcp-connectors/zotero/src/server.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/mcp-search-tool.test.ts")).toBe(false);
  });

  /**
   * `build-lcov.sh` has run mcp-launcher's tests since #1047, and its comment
   * describes that as closing a "measurement gap". It did not: the package was
   * absent from this scope, so nothing it loaded was instrumented and it
   * emitted no coverage records — Sonar kept scoring both files at 0% while
   * their tests passed. Running a package's tests and MEASURING it are separate
   * switches, and only one of them was flipped.
   */
  test("instruments mcp-launcher src — its tests run, so its source must be measured", () => {
    expect(shouldInstrument("/repo/packages/mcp-launcher/src/resolve-binary.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-launcher/src/exit-status.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-launcher/src/resolve-binary.test.ts")).toBe(false);
  });

  /**
   * `sdk` and `client` were extracted to their own repos; no
   * `packages/{sdk,client}/src/` path exists here any more. Pinned so the dead
   * alternations are not restored — a scope regex naming packages that cannot
   * match reads as coverage being collected somewhere that it is not.
   */
  test("does not claim scope over packages that left this monorepo", () => {
    expect(shouldInstrument("/repo/packages/sdk/src/index.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/client/src/index.ts")).toBe(false);
  });
});
