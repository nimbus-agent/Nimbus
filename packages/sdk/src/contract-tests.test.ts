import { describe, expect, test } from "bun:test";

import {
  assertNoRowDataTools,
  ExtensionContractError,
  ROW_DATA_TOOL_SEGMENTS,
  runContractTests,
} from "./contract-tests.ts";
import type { ExtensionManifest } from "./types.ts";

const base = (): ExtensionManifest => ({
  id: "demo.ext",
  displayName: "Demo",
  version: "0.1.0",
  description: "Demo extension",
  author: "nimbus",
  entrypoint: "dist/index.js",
  runtime: "bun",
  permissions: ["read"],
  hitlRequired: [],
  minNimbusVersion: "0.1.0",
});

describe("runContractTests", () => {
  test("accepts a minimal valid manifest", async () => {
    await expect(runContractTests(base())).resolves.toBeUndefined();
  });

  test("rejects invalid permission", async () => {
    const m = base();
    m.permissions = ["read", "admin"] as ExtensionManifest["permissions"];
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });
});

describe("runContractTests — v1 additions", () => {
  test("v1 contract passes against a minimal extension manifest", async () => {
    await expect(
      runContractTests({
        id: "ext.v1-smoke",
        displayName: "V1 Smoke",
        version: "0.1.0",
        description: "Smoke test extension",
        author: "Nimbus",
        entrypoint: "index.ts",
        runtime: "bun",
        permissions: [],
        hitlRequired: [],
        minNimbusVersion: "0.1.0",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("runContractTests — missing required fields", () => {
  test("rejects manifest with empty id", async () => {
    const m = base();
    m.id = "";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });

  test("rejects manifest with empty displayName", async () => {
    const m = base();
    m.displayName = "";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });

  test("rejects manifest with empty version", async () => {
    const m = base();
    m.version = "";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });

  test("rejects manifest with empty description", async () => {
    const m = base();
    m.description = "";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });

  test("rejects manifest with empty author", async () => {
    const m = base();
    m.author = "";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });

  test("rejects manifest with empty entrypoint", async () => {
    const m = base();
    m.entrypoint = "";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });
});

describe("runContractTests — runtime validation", () => {
  test("rejects manifest with unsupported runtime", async () => {
    const m = base();
    m.runtime = "deno" as ExtensionManifest["runtime"];
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });
});

describe("runContractTests — permissions validation", () => {
  test("rejects manifest when permissions is not an array", async () => {
    const m = base();
    m.permissions = "read" as unknown as ExtensionManifest["permissions"];
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });
});

describe("runContractTests — hitlRequired validation", () => {
  test("rejects manifest when hitlRequired is not an array", async () => {
    const m = base();
    m.hitlRequired = "write" as unknown as ExtensionManifest["hitlRequired"];
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });

  test("rejects manifest with invalid hitlRequired entry", async () => {
    const m = base();
    m.hitlRequired = ["admin"] as unknown as ExtensionManifest["hitlRequired"];
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });
});

describe("runContractTests — minNimbusVersion validation", () => {
  test("rejects manifest with empty minNimbusVersion", async () => {
    const m = base();
    m.minNimbusVersion = "";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });

  test("rejects manifest with non-semver minNimbusVersion", async () => {
    const m = base();
    m.minNimbusVersion = "latest";
    await expect(runContractTests(m)).rejects.toBeInstanceOf(ExtensionContractError);
  });
});

describe("assertNoRowDataTools — Tier-3 no-row-data contract", () => {
  test("accepts a metadata-only warehouse surface", () => {
    expect(() =>
      assertNoRowDataTools([
        { name: "bigquery_list" },
        { name: "bigquery_get" },
        { name: "bigquery_search" },
        { name: "bigquery_list_datasets" },
        { name: "bigquery_get_table_schema" },
        { name: "athena_list_databases" },
        { name: "cloudwatch_list_log_groups" },
        { name: "vertexai_get_model" },
        { name: "great_expectations_list_suites" },
      ]),
    ).not.toThrow();
  });

  test("does NOT false-positive on the 'bigquery' service prefix (single token, not 'query')", () => {
    expect(() => assertNoRowDataTools([{ name: "bigquery_get" }])).not.toThrow();
    // The denylisted segment IS present as its own token, though:
    expect(ROW_DATA_TOOL_SEGMENTS.has("query")).toBe(true);
  });

  test("accepts an empty tool surface", () => {
    expect(() => assertNoRowDataTools([])).not.toThrow();
  });

  test.each([
    "bigquery_run_query",
    "bigquery_get_rows",
    "athena_query_results",
    "dynamodb_scan",
    "bigquery_head",
    "bigquery_preview_rows",
    "warehouse_sample",
    "table_select",
    "cloudwatch_get_log_records",
    "cloudwatch_get_log_events",
    "cloudwatch_filter_log_events",
    "bigquery_export_table",
    "snowflake_download",
    "sheet_get_cell",
  ])("rejects row/cell/result fetcher %p", (name) => {
    expect(() => assertNoRowDataTools([{ name }])).toThrow(ExtensionContractError);
  });

  test("error names every offending tool", () => {
    try {
      assertNoRowDataTools([
        { name: "bigquery_list" },
        { name: "bigquery_run_query" },
        { name: "bigquery_get_rows" },
      ]);
      throw new Error("expected assertNoRowDataTools to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionContractError);
      const msg = (err as ExtensionContractError).message;
      expect(msg).toContain("bigquery_run_query");
      expect(msg).toContain("bigquery_get_rows");
      expect(msg).not.toContain("bigquery_list (");
    }
  });

  test("ignores blank tool names", () => {
    expect(() => assertNoRowDataTools([{ name: "" }, { name: "   " }])).not.toThrow();
  });
});
