import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { type GxExpectationMeta, listAllExpectations } from "./gx-parse.ts";

/**
 * Great Expectations (Tier-3, no-row-data) MCP tool surface. ALL tools index
 * validation-result METADATA only (suite name, batch id, expectation type,
 * column, success/failure, the aggregate observed value, element/unexpected
 * counts, run time). NONE return the failing-data SAMPLE lists (unexpected_list
 * / partial_unexpected_list / …) — those carry real data cell values (row data)
 * and are stripped by `gx-parse.ts` before they ever reach a tool result. The
 * names are introspected by the `assertNoRowDataTools` contract test, so they
 * must never contain a row-data segment (rows/records/sample/values/scan/…).
 */
export const GREAT_EXPECTATIONS_TOOL_NAMES = [
  "great_expectations_list",
  "great_expectations_get",
  "great_expectations_search",
] as const;

function toEnvelope(m: GxExpectationMeta): Record<string, unknown> {
  return {
    externalId: m.externalId,
    suiteName: m.suiteName,
    batchId: m.batchId,
    runId: m.runId,
    runTime: m.runTime,
    expectationType: m.expectationType,
    column: m.column,
    success: m.success,
    observedValue: m.observedValue,
    elementCount: m.elementCount,
    unexpectedCount: m.unexpectedCount,
    unexpectedPercent: m.unexpectedPercent,
    successPercent: m.successPercent,
    sourceFile: m.sourceFile,
  };
}

/**
 * Register the read-only, metadata-only Great Expectations tools onto the given
 * registrar. Shared between `server.ts` (live) and the contract test
 * (introspection).
 */
export function registerGreatExpectationsTools(reg: ZodToolRegistrar): void {
  reg(
    "great_expectations_list",
    "List recent Great Expectations validation results — METADATA ONLY. Reads the GX validation-result JSON artefacts under the configured results dir and returns one entry per (suite, batch, expectation) carrying suiteName, batchId, expectationType, column, success/failure, the aggregate observedValue, and element/unexpected counts. Never returns the failing-data sample lists (unexpected_list / partial_unexpected_list / …).",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const all = await listAllExpectations();
      const limit = p.limit ?? 100;
      return jsonResult({ results: all.slice(0, limit).map(toEnvelope) });
    },
  );

  reg(
    "great_expectations_get",
    "Fetch one Great Expectations validation result by its external id (`<suite>::<batch>::<expectationType>::<column>`) — METADATA ONLY. Returns the single expectation's metadata (success/failure, aggregate observedValue, element/unexpected counts). Never returns row/cell sample data.",
    z.object({
      externalId: z.string().min(1),
    }),
    async (p) => {
      const all = await listAllExpectations();
      const match = all.find((m) => m.externalId === p.externalId);
      return jsonResult(match === undefined ? { match: null } : { match: toEnvelope(match) });
    },
  );

  reg(
    "great_expectations_search",
    "Substring search over Great Expectations suite names and expectation types (case-insensitive) — METADATA ONLY. Returns a `{ matches: [...] }` envelope of metadata entries whose suiteName, expectationType, or column contains the query. Never returns row/cell sample data.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const all = await listAllExpectations();
      const q = p.query.toLowerCase();
      const matches = all.filter((m) => {
        const hay = `${m.suiteName} ${m.expectationType} ${m.column ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
      const limit = p.limit ?? 100;
      return jsonResult({ matches: matches.slice(0, limit).map(toEnvelope) });
    },
  );
}
