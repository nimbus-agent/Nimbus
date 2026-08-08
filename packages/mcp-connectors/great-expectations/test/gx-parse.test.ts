import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  assertWithinResultsDir,
  FORBIDDEN_RESULT_KEYS,
  listAllExpectations,
  parseValidationResult,
} from "../src/gx-parse.ts";

describe("FORBIDDEN_RESULT_KEYS", () => {
  it("contains the exact set of keys that must be stripped to prevent row-data leaks", () => {
    expect([...FORBIDDEN_RESULT_KEYS]).toEqual([
      "unexpected_list",
      "partial_unexpected_list",
      "partial_unexpected_index_list",
      "unexpected_index_list",
      "partial_unexpected_counts",
    ]);
  });
});

/**
 * Unit coverage for the pure parser surface in gx-parse.ts. The no-row-data
 * stripping contract is the load-bearing assertion (a planted PII value in a
 * forbidden sample list must NEVER appear in the serialized output), alongside
 * the batch-id / run-id / run-time derivation fallbacks, the scalar
 * observed-value guard, the composite-id clamp, the path-traversal guard, and
 * the filesystem walk in `listAllExpectations`.
 */

describe("parseValidationResult — no-row-data stripping", () => {
  const PII = "secret-pii@example.com";

  it("never leaks any forbidden sample-list value, keeps aggregate scalars", () => {
    const doc = {
      meta: {
        expectation_suite_name: "customers.warning",
        batch_id: "batch-abc",
        run_id: { run_name: "ci-42", run_time: "2026-05-31T10:00:00.000Z" },
      },
      statistics: { success_percent: 75 },
      results: [
        {
          success: false,
          expectation_config: {
            expectation_type: "expect_column_values_to_be_unique",
            kwargs: { column: "email" },
          },
          result: {
            observed_value: 0.25,
            element_count: 4,
            unexpected_count: 1,
            unexpected_percent: 25,
            // Forbidden sample lists carrying real PII row data — must be dropped.
            unexpected_list: [PII, "another-pii@example.com"],
            partial_unexpected_list: [PII],
            partial_unexpected_index_list: [3],
            unexpected_index_list: [3],
            partial_unexpected_counts: [{ value: PII, count: 1 }],
          },
        },
      ],
    };

    const rows = parseValidationResult(doc, "validations/customers.json");
    expect(rows).toHaveLength(1);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PII);
    expect(serialized).not.toContain("another-pii@example.com");

    const row = rows[0];
    expect(row?.suiteName).toBe("customers.warning");
    expect(row?.batchId).toBe("batch-abc");
    expect(row?.runId).toBe("ci-42");
    expect(row?.runTime).toBe("2026-05-31T10:00:00.000Z");
    expect(row?.expectationType).toBe("expect_column_values_to_be_unique");
    expect(row?.column).toBe("email");
    expect(row?.success).toBe(false);
    // Aggregate scalars ARE captured.
    expect(row?.observedValue).toBe(0.25);
    expect(row?.elementCount).toBe(4);
    expect(row?.unexpectedCount).toBe(1);
    expect(row?.unexpectedPercent).toBe(25);
    expect(row?.successPercent).toBe(75);
    expect(row?.sourceFile).toBe("validations/customers.json");
  });

  it("drops an array observed_value to null without leaking samples", () => {
    const doc = {
      meta: { expectation_suite_name: "s", batch_id: "b" },
      results: [
        {
          success: true,
          expectation_config: { expectation_type: "expect_x", kwargs: {} },
          result: { observed_value: ["sampled-a", "sampled-b"] },
        },
      ],
    };
    const [row] = parseValidationResult(doc, "x.json");
    expect(row?.observedValue).toBeNull();
    expect(JSON.stringify(row)).not.toContain("sampled-a");
  });

  it("drops an object observed_value to null", () => {
    const doc = {
      meta: { expectation_suite_name: "s" },
      results: [
        {
          success: true,
          expectation_config: { expectation_type: "expect_x", kwargs: {} },
          result: { observed_value: { distinct: 7 } },
        },
      ],
    };
    const [row] = parseValidationResult(doc, "x.json");
    expect(row?.observedValue).toBeNull();
  });

  it("captures a string observed_value and a boolean observed_value", () => {
    const doc = {
      meta: {},
      results: [
        {
          success: true,
          expectation_config: { expectation_type: "expect_str", kwargs: {} },
          result: { observed_value: "VARCHAR" },
        },
        {
          success: true,
          expectation_config: { expectation_type: "expect_bool", kwargs: {} },
          result: { observed_value: false },
        },
      ],
    };
    const rows = parseValidationResult(doc, "x.json");
    expect(rows[0]?.observedValue).toBe("VARCHAR");
    expect(rows[1]?.observedValue).toBe(false);
  });

  it("returns [] for a non-object document, and skips non-object result entries", () => {
    expect(parseValidationResult(null, "x.json")).toEqual([]);
    expect(parseValidationResult("nope", "x.json")).toEqual([]);
    expect(parseValidationResult(42, "x.json")).toEqual([]);

    const doc = {
      meta: {},
      results: ["not-an-object", { success: true, expectation_config: {} }],
    };
    const rows = parseValidationResult(doc, "x.json");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expectationType).toBe("unknown");
    expect(rows[0]?.column).toBeNull();
    expect(rows[0]?.observedValue).toBeNull();
  });

  it("defaults suite/expectation type and column when meta/config are absent", () => {
    const doc = { results: [{ success: false, result: {} }] };
    const [row] = parseValidationResult(doc, "x.json");
    expect(row?.suiteName).toBe("_");
    expect(row?.batchId).toBe("_");
    expect(row?.runId).toBeNull();
    expect(row?.runTime).toBeNull();
    expect(row?.expectationType).toBe("unknown");
    expect(row?.column).toBeNull();
    expect(row?.externalId).toBe("_::_::unknown::_");
  });
});

function batchIdFor(meta: Record<string, unknown>): string {
  const [row] = parseValidationResult(
    { meta, results: [{ success: true, expectation_config: {}, result: {} }] },
    "x.json",
  );
  return row?.batchId ?? "<none>";
}

describe("deriveBatchId — fallback ladder (via parseValidationResult)", () => {
  it("prefers batch_id", () => {
    expect(batchIdFor({ batch_id: "direct-batch" })).toBe("direct-batch");
  });

  it("falls back to active_batch_definition_id", () => {
    expect(batchIdFor({ active_batch_definition_id: "abd-id" })).toBe("abd-id");
  });

  it("falls back to active_batch_definition.batch_identifiers", () => {
    expect(batchIdFor({ active_batch_definition: { batch_identifiers: "bi-key" } })).toBe("bi-key");
  });

  it("falls back to active_batch_definition.data_asset_name", () => {
    expect(batchIdFor({ active_batch_definition: { data_asset_name: "asset" } })).toBe("asset");
  });

  it("falls back to active_batch_definition.datasource_name", () => {
    expect(batchIdFor({ active_batch_definition: { datasource_name: "ds" } })).toBe("ds");
  });

  it("falls back to batch_spec.path", () => {
    expect(batchIdFor({ batch_spec: { path: "/data/file.csv" } })).toBe("/data/file.csv");
  });

  it("falls back to batch_spec.table_name", () => {
    expect(batchIdFor({ batch_spec: { table_name: "public.orders" } })).toBe("public.orders");
  });

  it("defaults to '_' when nothing matches", () => {
    expect(batchIdFor({})).toBe("_");
    // Non-record active_batch_definition / batch_spec do not throw.
    expect(batchIdFor({ active_batch_definition: "nope", batch_spec: 7 })).toBe("_");
  });
});

function runFor(meta: Record<string, unknown>): { runId: string | null; runTime: string | null } {
  const [row] = parseValidationResult(
    { meta, results: [{ success: true, expectation_config: {}, result: {} }] },
    "x.json",
  );
  return { runId: row?.runId ?? null, runTime: row?.runTime ?? null };
}

describe("deriveRunId / deriveRunTime (via parseValidationResult)", () => {
  it("reads a string run_id directly; run_time falls back to meta.run_time", () => {
    const { runId, runTime } = runFor({ run_id: "run-string", run_time: "2026-01-01T00:00:00Z" });
    expect(runId).toBe("run-string");
    expect(runTime).toBe("2026-01-01T00:00:00Z");
  });

  it("reads an object run_id via run_name, run_time via run_id.run_time", () => {
    const { runId, runTime } = runFor({
      run_id: { run_name: "nightly", run_time: "2026-02-02T02:02:02Z" },
    });
    expect(runId).toBe("nightly");
    expect(runTime).toBe("2026-02-02T02:02:02Z");
  });

  it("object run_id with only run_time uses it as the id and the time", () => {
    const { runId, runTime } = runFor({ run_id: { run_time: "2026-03-03T03:03:03Z" } });
    expect(runId).toBe("2026-03-03T03:03:03Z");
    expect(runTime).toBe("2026-03-03T03:03:03Z");
  });

  it("run_time falls back to validation_time when no run_time anywhere", () => {
    const { runTime } = runFor({ validation_time: "2026-04-04T04:04:04Z" });
    expect(runTime).toBe("2026-04-04T04:04:04Z");
  });

  it("null run_id / no time → both null", () => {
    const { runId, runTime } = runFor({});
    expect(runId).toBeNull();
    expect(runTime).toBeNull();
  });
});

describe("clampId (via externalId)", () => {
  it("leaves a short composite id unchanged", () => {
    const [row] = parseValidationResult(
      {
        meta: { expectation_suite_name: "suite", batch_id: "batch" },
        results: [
          {
            success: true,
            expectation_config: { expectation_type: "expect_x", kwargs: { column: "c" } },
            result: {},
          },
        ],
      },
      "x.json",
    );
    expect(row?.externalId).toBe("suite::batch::expect_x::c");
    expect(row?.externalId.length).toBeLessThanOrEqual(256);
  });

  it("hash-suffixes an over-256-char composite id", () => {
    const longSuite = "s".repeat(300);
    const [row] = parseValidationResult(
      {
        meta: { expectation_suite_name: longSuite, batch_id: "b" },
        results: [
          { success: true, expectation_config: { expectation_type: "t", kwargs: {} }, result: {} },
        ],
      },
      "x.json",
    );
    const id = row?.externalId ?? "";
    expect(id.length).toBeLessThanOrEqual(256);
    expect(id).toContain("#");
    expect(id.startsWith("s".repeat(240))).toBe(true);
  });
});

describe("assertWithinResultsDir", () => {
  const root = resolve(sep, "gx", "results");

  it("allows the dir itself", () => {
    expect(() => assertWithinResultsDir(root, root)).not.toThrow();
  });

  it("allows a descendant", () => {
    expect(() =>
      assertWithinResultsDir(join(root, "nested", "deep", "b.json"), root),
    ).not.toThrow();
  });

  it("rejects a ..-escaping path", () => {
    expect(() => assertWithinResultsDir(resolve(root, "..", "etc", "passwd"), root)).toThrow();
  });

  it("rejects an absolute path outside the dir", () => {
    expect(() => assertWithinResultsDir(resolve(sep, "etc", "passwd"), root)).toThrow();
  });
});

describe("listAllExpectations — filesystem walk", () => {
  const PII = "secret-pii@example.com";
  let dir: string;
  const prevEnv = process.env["GREAT_EXPECTATIONS_RESULTS_DIR"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gx-results-"));
    process.env["GREAT_EXPECTATIONS_RESULTS_DIR"] = dir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) {
      delete process.env["GREAT_EXPECTATIONS_RESULTS_DIR"];
    } else {
      process.env["GREAT_EXPECTATIONS_RESULTS_DIR"] = prevEnv;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("flattens rows from multiple GX artefacts and strips PII", async () => {
    const docA = {
      meta: { expectation_suite_name: "suiteA", batch_id: "batchA" },
      statistics: { success_percent: 100 },
      results: [
        {
          success: true,
          expectation_config: { expectation_type: "expect_a", kwargs: { column: "col1" } },
          result: { observed_value: 10, element_count: 10 },
        },
        {
          success: false,
          expectation_config: { expectation_type: "expect_b", kwargs: { column: "col2" } },
          result: {
            observed_value: 2,
            unexpected_count: 1,
            unexpected_list: [PII],
            partial_unexpected_list: [PII],
          },
        },
      ],
    };
    const docB = {
      meta: { expectation_suite_name: "suiteB", batch_id: "batchB" },
      results: [
        {
          success: true,
          expectation_config: { expectation_type: "expect_c", kwargs: {} },
          result: { observed_value: "TEXT" },
        },
      ],
    };
    await writeFile(join(dir, "a.json"), JSON.stringify(docA), "utf8");
    // nested artefact picked up by the recursive directory walk
    const sub = join(dir, "nested");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "b.json"), JSON.stringify(docB), "utf8");

    const rows = await listAllExpectations();
    expect(rows).toHaveLength(3);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PII);

    const suites = rows.map((r) => r.suiteName).sort((a, b) => a.localeCompare(b));
    expect(suites).toEqual(["suiteA", "suiteA", "suiteB"]);
  });

  it("skips a malformed JSON artefact", async () => {
    await writeFile(
      join(dir, "good.json"),
      JSON.stringify({
        meta: { expectation_suite_name: "ok" },
        results: [
          { success: true, expectation_config: { expectation_type: "t", kwargs: {} }, result: {} },
        ],
      }),
      "utf8",
    );
    await writeFile(join(dir, "broken.json"), "{ not valid json", "utf8");

    const rows = await listAllExpectations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suiteName).toBe("ok");
  });

  it("skips an oversized artefact (> 4 MiB)", async () => {
    // A > 4 MiB file is skipped by readArtefact's byte-length guard.
    const huge = `{"padding":"${"x".repeat(5 * 1024 * 1024)}"}`;
    await writeFile(join(dir, "huge.json"), huge, "utf8");
    await writeFile(
      join(dir, "small.json"),
      JSON.stringify({
        meta: { expectation_suite_name: "small" },
        results: [
          { success: true, expectation_config: { expectation_type: "t", kwargs: {} }, result: {} },
        ],
      }),
      "utf8",
    );

    const rows = await listAllExpectations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suiteName).toBe("small");
  });

  it("ignores non-json files", async () => {
    await writeFile(join(dir, "notes.txt"), "not an artefact", "utf8");
    const rows = await listAllExpectations();
    expect(rows).toEqual([]);
  });

  it("throws when GREAT_EXPECTATIONS_RESULTS_DIR is unset", async () => {
    delete process.env["GREAT_EXPECTATIONS_RESULTS_DIR"];
    await expect(listAllExpectations()).rejects.toThrow(/GREAT_EXPECTATIONS_RESULTS_DIR/);
  });
});
