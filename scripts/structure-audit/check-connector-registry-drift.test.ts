import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorRegistryDrift, registryIds } from "./check-connector-registry-drift.ts";

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
const EMPTY_CONNECTORS = join(ROOT, "connectors-empty");
mkdirSync(EMPTY_CONNECTORS, { recursive: true });

describe("checkConnectorRegistryDrift", () => {
  test("passes when the registry lists exactly the connectors on disk", () => {
    expect(checkConnectorRegistryDrift(CONNECTORS, registry(["airflow", "monte-carlo"]))).toEqual({
      status: "ok",
    });
  });

  test("flags a connector on disk that the registry omits", () => {
    const result = checkConnectorRegistryDrift(CONNECTORS, registry(["airflow"]));
    expect(result.status).toBe("drift");
    if (result.status !== "drift") throw new Error("expected drift");
    expect(result.violations.map((e) => e.connector)).toEqual(["monte-carlo"]);
    expect(result.violations[0]?.reason).toContain("gen:connector-registry");
  });

  test("flags a registry entry with no connector on disk", () => {
    const result = checkConnectorRegistryDrift(
      CONNECTORS,
      registry(["airflow", "monte-carlo", "ghost"]),
    );
    expect(result.status).toBe("drift");
    if (result.status !== "drift") throw new Error("expected drift");
    expect(result.violations.map((e) => e.connector)).toEqual(["ghost"]);
    expect(result.violations[0]?.reason).toContain("no longer exists");
  });

  test("reads ids from the import path, not the object key", () => {
    // Biome strips unnecessary quotes from keys, so an unquoted key must still be found.
    const path = join(ROOT, "registry-unquoted.ts");
    writeFileSync(
      path,
      `export const BUNDLED_CONNECTORS = {\n  airflow: () => import("../../../mcp-connectors/airflow/src/server.ts"),\n  "monte-carlo": () => import("../../../mcp-connectors/monte-carlo/src/server.ts"),\n};\n`,
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

  test("a registry that exists but parses to zero entries while connectors exist on disk is indeterminate, not a wall of violations", () => {
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
    expect(result.indeterminate.reason).not.toContain("gen:connector-registry");
  });

  test("a genuinely empty connectors directory does not trip the indeterminate path", () => {
    // Registry parses to zero entries too — but there is nothing on disk to compare against, so
    // this is a clean pass, not an unparseable-input signal.
    const path = join(ROOT, "registry-truly-empty.ts");
    writeFileSync(path, "export const BUNDLED_CONNECTORS = {};\n");

    expect(checkConnectorRegistryDrift(EMPTY_CONNECTORS, path)).toEqual({ status: "ok" });
  });
});

describe("both specifier forms the generator can emit are parsed", () => {
  // `specifierFor` in gen-bundled-connector-registry.ts emits a relative path today and
  // `@nimbus-dev/connectors/<id>` after the extraction. A parser that knows only one form does not
  // fail loudly: registryIds() returns [], the check reports "indeterminate", and indeterminate is
  // a WARNING — so the drift gate goes quietly inert exactly when the extraction makes it matter.
  function packageRegistry(ids: readonly string[]): string {
    const path = join(ROOT, `pkg-registry-${ids.join("-") || "empty"}.ts`);
    const entries = ids
      .map((id) => `  ${JSON.stringify(id)}: () => import("@nimbus-dev/connectors/${id}"),`)
      .join("\n");
    writeFileSync(path, `export const BUNDLED_CONNECTORS = {\n${entries}\n};\n`);
    return path;
  }

  test("a package-mode registry parses its ids", () => {
    expect(registryIds(packageRegistry(["airflow", "monte-carlo"]))).toEqual([
      "airflow",
      "monte-carlo",
    ]);
  });

  test("a package-mode registry still DETECTS drift rather than reporting indeterminate", () => {
    // The regression that matters: a missing connector must be found, not masked by an
    // unparseable registry.
    const v = checkConnectorRegistryDrift(join(ROOT, "connectors"), packageRegistry(["airflow"]));
    expect(JSON.stringify(v)).toMatch(/monte-carlo/);
    expect(JSON.stringify(v)).not.toMatch(/indeterminate/i);
  });

  test("relative-mode parsing is unchanged", () => {
    expect(registryIds(registry(["airflow", "monte-carlo"]))).toEqual(["airflow", "monte-carlo"]);
  });
});
