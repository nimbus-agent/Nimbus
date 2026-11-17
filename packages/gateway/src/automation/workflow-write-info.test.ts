import { describe, expect, test } from "bun:test";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { writeToolInfo } from "./workflow-write-info.ts";

describe("writeToolInfo", () => {
  test("a known write tool reports its own row's wave and action type", () => {
    const row = CONNECTOR_WRITE_ROWS[0];
    if (row === undefined) throw new Error("the write table is empty");
    expect(writeToolInfo(row.toolId)).toEqual({ wave: row.wave, actionType: row.actionType });
  });

  test("an unknown tool id reports nothing", () => {
    expect(writeToolInfo("not_a_write_tool")).toBeUndefined();
  });
});
