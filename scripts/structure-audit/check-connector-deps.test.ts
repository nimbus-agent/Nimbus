import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWED_CONNECTOR_DEPS, checkConnectorDeps } from "./check-connector-deps.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-connector-deps-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(name: string, dependencies: Record<string, string>): void {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "server.ts"), "// entry\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies }));
}

fixture("clean", { zod: "^4.0.0", "@nimbus-dev/sdk": "^1.8.1" });
fixture("native", { "better-sqlite3": "^11.0.0" });

describe("checkConnectorDeps", () => {
  test("flags a dependency outside the allowlist", () => {
    const v = checkConnectorDeps(ROOT);
    expect(v).toEqual([{ connector: "native", dependency: "better-sqlite3" }]);
  });

  test("accepts allowlisted dependencies", () => {
    expect(checkConnectorDeps(ROOT).map((e) => e.connector)).not.toContain("clean");
  });

  test("the real connector tree is clean", () => {
    expect(checkConnectorDeps()).toEqual([]);
  });

  test("the allowlist stays small and deliberate", () => {
    expect(ALLOWED_CONNECTOR_DEPS.length).toBeLessThanOrEqual(10);
  });
});
