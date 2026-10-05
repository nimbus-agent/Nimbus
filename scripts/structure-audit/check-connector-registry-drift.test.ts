import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorRegistryDrift, registryIds } from "./check-connector-registry-drift.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-registry-drift-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// The entry shape `gen-bundled-connector-registry.ts` emits.
function entry(id: string): string {
  return `  ${JSON.stringify(id)}: () => import("@nimbus-dev/connectors/${id}"),`;
}

function registry(ids: readonly string[]): string {
  const path = join(ROOT, `registry-${ids.join("-") || "empty"}.ts`);
  writeFileSync(path, `export const BUNDLED_CONNECTORS = {\n${ids.map(entry).join("\n")}\n};\n`);
  return path;
}

// The ids the installed connector package would export. Plain data: the check is a comparison,
// and discovery is the caller's job.
const CONNECTORS = ["airflow", "monte-carlo"];
const EMPTY_CONNECTORS: readonly string[] = [];

describe("checkConnectorRegistryDrift", () => {
  test("passes when the registry lists exactly the exported connectors", () => {
    expect(checkConnectorRegistryDrift(CONNECTORS, registry(["airflow", "monte-carlo"]))).toEqual({
      status: "ok",
    });
  });

  test("reads each id from its import specifier", () => {
    expect(registryIds(registry(["airflow", "monte-carlo"]))).toEqual(["airflow", "monte-carlo"]);
  });

  test("flags an exported connector that the registry omits", () => {
    const result = checkConnectorRegistryDrift(CONNECTORS, registry(["airflow"]));
    expect(result.status).toBe("drift");
    if (result.status !== "drift") throw new Error("expected drift");
    expect(result.violations.map((e) => e.connector)).toEqual(["monte-carlo"]);
    expect(result.violations[0]?.reason).toContain("gen:connector-registry");
  });

  test("flags a registry entry the package no longer exports", () => {
    const result = checkConnectorRegistryDrift(
      CONNECTORS,
      registry(["airflow", "monte-carlo", "ghost"]),
    );
    expect(result.status).toBe("drift");
    if (result.status !== "drift") throw new Error("expected drift");
    expect(result.violations.map((e) => e.connector)).toEqual(["ghost"]);
    expect(result.violations[0]?.reason).toContain("no longer exports");
  });

  test("reads ids from the import path, not the object key", () => {
    // Biome strips unnecessary quotes from keys, so an unquoted key must still be found.
    const path = join(ROOT, "registry-unquoted.ts");
    writeFileSync(
      path,
      `export const BUNDLED_CONNECTORS = {\n  airflow: () => import("@nimbus-dev/connectors/airflow"),\n  "monte-carlo": () => import("@nimbus-dev/connectors/monte-carlo"),\n};\n`,
    );
    expect(checkConnectorRegistryDrift(CONNECTORS, path)).toEqual({ status: "ok" });
  });

  test("a missing registry file is still a real drift finding, not indeterminate", () => {
    const missing = join(ROOT, "does-not-exist.ts");
    const result = checkConnectorRegistryDrift(CONNECTORS, missing);
    expect(result.status).toBe("drift");
    if (result.status !== "drift") throw new Error("expected drift");
    expect(result.violations.map((e) => e.connector)).toEqual(["airflow", "monte-carlo"]);
  });

  test("a registry that exists but parses to zero entries while the package exports connectors is indeterminate, not a wall of violations", () => {
    // Simulates the generator's emitted import format changing out from under ENTRY_RE: the file
    // exists and plainly registers two connectors, but not in the shape the regex looks for.
    const path = join(ROOT, "registry-reformatted.ts");
    writeFileSync(
      path,
      [
        "export const BUNDLED_CONNECTORS = {",
        '  airflow: () => import("@nimbus-connectors/airflow"),',
        '  "monte-carlo": () => import("@nimbus-connectors/monte-carlo"),',
        "};",
        "",
      ].join("\n"),
    );

    const result = checkConnectorRegistryDrift(CONNECTORS, path);

    expect(result.status).toBe("indeterminate");
    if (result.status !== "indeterminate") throw new Error("expected indeterminate");
    expect(result.indeterminate.reason).toContain("emitted import format changed");
    // The printed remedy must NOT be "run gen:connector-registry" — that fixes real drift, not a
    // stale parser, and would be actively misleading here.
    expect(result.indeterminate.reason).not.toContain("gen:connector-registry");
  });

  test("a package that exports no connectors does not trip the indeterminate path", () => {
    // Registry parses to zero entries too — but nothing is exported to compare against, so this
    // is a clean pass, not an unparseable-input signal.
    const path = join(ROOT, "registry-truly-empty.ts");
    writeFileSync(path, "export const BUNDLED_CONNECTORS = {};\n");

    expect(checkConnectorRegistryDrift(EMPTY_CONNECTORS, path)).toEqual({ status: "ok" });
  });
});

describe("an entry in the relative form the generator used to emit", () => {
  // `NIMBUS_CONNECTOR_SPECIFIER=workspace` made the generator import each connector from the
  // in-repo copy, until #1347 deleted `packages/mcp-connectors` and the form with it. An entry
  // still written that way imports a file that does not exist, so it must not count as
  // registering its connector — the shipped binary could not start it.
  function relativeEntry(id: string): string {
    return `  ${JSON.stringify(id)}: () => import("../../../mcp-connectors/${id}/src/server.ts"),`;
  }

  test("is not parsed as a registered connector", () => {
    const path = join(ROOT, "registry-relative-only.ts");
    writeFileSync(path, `export const BUNDLED_CONNECTORS = {\n${relativeEntry("airflow")}\n};\n`);
    expect(registryIds(path)).toEqual([]);
  });

  test("mixed into a current registry, reports its connector as missing", () => {
    const path = join(ROOT, "registry-mixed.ts");
    writeFileSync(
      path,
      `export const BUNDLED_CONNECTORS = {\n${entry("airflow")}\n${relativeEntry("monte-carlo")}\n};\n`,
    );
    const result = checkConnectorRegistryDrift(CONNECTORS, path);
    expect(result.status).toBe("drift");
    if (result.status !== "drift") throw new Error("expected drift");
    expect(result.violations.map((e) => e.connector)).toEqual(["monte-carlo"]);
  });
});
