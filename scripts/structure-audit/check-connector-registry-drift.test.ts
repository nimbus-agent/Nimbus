import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorRegistryDrift } from "./check-connector-registry-drift.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-registry-drift-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function connector(name: string): void {
  mkdirSync(join(ROOT, "connectors", name, "src"), { recursive: true });
  writeFileSync(join(ROOT, "connectors", name, "src", "server.ts"), "export {};\n");
}

function registry(ids: readonly string[]): string {
  const path = join(ROOT, `registry-${ids.join("-") || "empty"}.ts`);
  const entries = ids
    .map(
      (id) =>
        `  ${JSON.stringify(id)}: () => import("../../../mcp-connectors/${id}/src/server.ts"),`,
    )
    .join("\n");
  writeFileSync(path, `export const BUNDLED_CONNECTORS = {\n${entries}\n};\n`);
  return path;
}

connector("airflow");
connector("monte-carlo");

const CONNECTORS = join(ROOT, "connectors");

describe("checkConnectorRegistryDrift", () => {
  test("passes when the registry lists exactly the connectors on disk", () => {
    expect(checkConnectorRegistryDrift(CONNECTORS, registry(["airflow", "monte-carlo"]))).toEqual(
      [],
    );
  });

  test("flags a connector on disk that the registry omits", () => {
    const v = checkConnectorRegistryDrift(CONNECTORS, registry(["airflow"]));
    expect(v.map((e) => e.connector)).toEqual(["monte-carlo"]);
    expect(v[0]?.reason).toContain("gen:connector-registry");
  });

  test("flags a registry entry with no connector on disk", () => {
    const v = checkConnectorRegistryDrift(
      CONNECTORS,
      registry(["airflow", "monte-carlo", "ghost"]),
    );
    expect(v.map((e) => e.connector)).toEqual(["ghost"]);
    expect(v[0]?.reason).toContain("no longer exists");
  });

  test("reads ids from the import path, not the object key", () => {
    // Biome strips unnecessary quotes from keys, so an unquoted key must still be found.
    const path = join(ROOT, "registry-unquoted.ts");
    writeFileSync(
      path,
      `export const BUNDLED_CONNECTORS = {\n  airflow: () => import("../../../mcp-connectors/airflow/src/server.ts"),\n  "monte-carlo": () => import("../../../mcp-connectors/monte-carlo/src/server.ts"),\n};\n`,
    );
    expect(checkConnectorRegistryDrift(CONNECTORS, path)).toEqual([]);
  });
});
