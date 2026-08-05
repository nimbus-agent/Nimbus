import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorEntrypoints } from "./check-connector-entrypoints.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-entrypoint-audit-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(name: string, serverSource: string): void {
  const dir = join(ROOT, name, "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.ts"), serverSource);
}

fixture(
  "good-guarded",
  `export async function startConnector(): Promise<void> {}\nif (import.meta.main) await startConnector();\n`,
);
fixture("good-unguarded", `await server.connect(transport);\n`);
fixture("bad-guarded", `if (import.meta.main) {\n  await runReadOnlyMcpConnector("x", reg);\n}\n`);

describe("checkConnectorEntrypoints", () => {
  test("flags a guarded entrypoint that does not export startConnector", () => {
    const v = checkConnectorEntrypoints(ROOT);
    expect(v.map((e) => e.connector)).toEqual(["bad-guarded"]);
    expect(v[0]?.reason).toContain("startConnector");
  });

  test("accepts a guarded entrypoint that exports startConnector", () => {
    expect(checkConnectorEntrypoints(ROOT).map((e) => e.connector)).not.toContain("good-guarded");
  });

  test("ignores an unguarded entrypoint entirely", () => {
    expect(checkConnectorEntrypoints(ROOT).map((e) => e.connector)).not.toContain("good-unguarded");
  });

  test("the real connector tree is clean", () => {
    expect(checkConnectorEntrypoints()).toEqual([]);
  });
});
