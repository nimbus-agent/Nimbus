import { describe, expect, test } from "bun:test";

import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { beforeReaderMissing, prepareToolMissing, templateKeysInSchema } from "./listed-support.ts";
import { previewTemplateKeys } from "./preview.ts";
import type { ConnectorWriteRow } from "./types.ts";

const ROW = (toolId: string): ConnectorWriteRow => {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
};

function listing(service: string, tools: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(tools.map((t) => [mcpClientToolKey(service, t), { description: "d" }]));
}

describe("templateKeysInSchema", () => {
  const row = ROW("github_pr_merge");
  const keys = [...previewTemplateKeys(row.preview as NonNullable<typeof row.preview>)];
  test("true only when every template key is a top-level property", () => {
    expect(keys.length).toBeGreaterThan(0);
    const all = Object.fromEntries(keys.map((k) => [k, {}]));
    expect(templateKeysInSchema(row, { type: "object", properties: all })).toBe(true);
    const lacking = { ...all };
    delete lacking[keys[0] as string];
    expect(templateKeysInSchema(row, { type: "object", properties: lacking })).toBe(false);
    expect(templateKeysInSchema(row, { type: "object" })).toBe(false);
    expect(templateKeysInSchema(row, { type: "object", properties: [] })).toBe(false);
  });
  test("a row with no template fails", () => {
    const { preview: _drop, ...rest } = row;
    const bare: ConnectorWriteRow = rest;
    expect(templateKeysInSchema(bare, { properties: {} })).toBe(false);
  });
});

describe("beforeReaderMissing", () => {
  test("a row with no reader is never missing one", () => {
    const noReader = CONNECTOR_WRITE_ROWS.find((r) => r.before === undefined) as ConnectorWriteRow;
    expect(beforeReaderMissing(noReader, "x", {})).toBe(false);
  });
  test("the first tool and the second read (also) must both be listed", () => {
    const r = CONNECTOR_WRITE_ROWS.find((x) => x.before?.also !== undefined) as ConnectorWriteRow;
    const service = r.actionType.split(".")[0] as string;
    const first = r.before?.tool as string;
    const second = r.before?.also?.tool as string;
    expect(beforeReaderMissing(r, service, listing(service, [first, second]))).toBe(false);
    expect(beforeReaderMissing(r, service, listing(service, [first]))).toBe(true);
    expect(beforeReaderMissing(r, service, listing(service, [second]))).toBe(true);
  });
  test("a listed entry that is not an object counts as missing", () => {
    const r = ROW("github_pr_merge");
    const tool = r.before?.tool as string;
    expect(beforeReaderMissing(r, "github", { [mcpClientToolKey("github", tool)]: "nope" })).toBe(
      true,
    );
  });
});

describe("prepareToolMissing", () => {
  test("a row that is not bound is never missing a prepare tool", () => {
    expect(prepareToolMissing(ROW("github_pr_merge"), "github", {})).toBe(false);
  });
  test("a bound row needs its prepare tool, and its settle tool when it has one", () => {
    const plain = CONNECTOR_WRITE_ROWS.find(
      (r) => r.bound !== undefined && r.bound.prepare.settleTool === undefined,
    ) as ConnectorWriteRow;
    const svc = plain.actionType.split(".")[0] as string;
    const tool = plain.bound?.prepare.tool as string;
    expect(prepareToolMissing(plain, svc, listing(svc, [tool]))).toBe(false);
    expect(prepareToolMissing(plain, svc, {})).toBe(true);
    const settled = CONNECTOR_WRITE_ROWS.find(
      (r) => r.bound?.prepare.settleTool !== undefined,
    ) as ConnectorWriteRow;
    const s2 = settled.actionType.split(".")[0] as string;
    const t1 = settled.bound?.prepare.tool as string;
    const t2 = settled.bound?.prepare.settleTool as string;
    expect(prepareToolMissing(settled, s2, listing(s2, [t1, t2]))).toBe(false);
    expect(prepareToolMissing(settled, s2, listing(s2, [t1]))).toBe(true);
  });
});
