import { describe, expect, test } from "bun:test";

import { filterMutableFiles } from "./run-mutation.ts";

describe("filterMutableFiles", () => {
  test("keeps non-test gateway src .ts files", () => {
    expect(filterMutableFiles(["packages/gateway/src/engine/executor.ts"])).toEqual([
      "packages/gateway/src/engine/executor.ts",
    ]);
  });

  test("drops test/spec files", () => {
    expect(
      filterMutableFiles([
        "packages/gateway/src/engine/executor.ts",
        "packages/gateway/src/engine/executor.test.ts",
        "packages/gateway/src/engine/executor.spec.ts",
      ]),
    ).toEqual(["packages/gateway/src/engine/executor.ts"]);
  });

  test("drops non-gateway-src and non-ts paths", () => {
    expect(
      filterMutableFiles([
        "packages/cli/src/index.ts",
        "packages/gateway/test/unit/foo.ts",
        "docs/x.md",
        "packages/gateway/src/engine/executor.ts",
        "scripts/mutation/run-mutation.ts",
      ]),
    ).toEqual(["packages/gateway/src/engine/executor.ts"]);
  });

  test("normalizes Windows backslash paths", () => {
    expect(filterMutableFiles(["packages\\gateway\\src\\engine\\executor.ts"])).toEqual([
      "packages/gateway/src/engine/executor.ts",
    ]);
  });

  test("returns [] for an empty diff", () => {
    expect(filterMutableFiles([])).toEqual([]);
  });
});
