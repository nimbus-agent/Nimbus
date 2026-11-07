// packages/gateway/src/connectors/connector-writes/prepare-tools.test.ts
import { describe, expect, test } from "bun:test";
import { isConnectorWriteToolId } from "../connector-write-registry.ts";
import { isPrepareToolId, PREPARE_TOOL_IDS } from "./prepare-tools.ts";

describe("PREPARE_TOOL_IDS (D0b)", () => {
  test("is empty in D0b: no real row declares a bound write yet", () => {
    expect(PREPARE_TOOL_IDS.size).toBe(0);
    expect([...PREPARE_TOOL_IDS]).toEqual([]);
  });

  test("is immutable: add, delete and clear throw", () => {
    expect(() => (PREPARE_TOOL_IDS as unknown as Set<string>).add("x_plan")).toThrow(TypeError);
    expect(() => (PREPARE_TOOL_IDS as unknown as Set<string>).delete("x")).toThrow(TypeError);
    expect(() => (PREPARE_TOOL_IDS as unknown as Set<string>).clear()).toThrow(TypeError);
    expect(PREPARE_TOOL_IDS.size).toBe(0);
  });

  test("the set interface answers like an empty set", () => {
    let calls = 0;
    // biome-ignore lint/complexity/noForEach: the Set interface itself is under test
    PREPARE_TOOL_IDS.forEach(() => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect([...PREPARE_TOOL_IDS.entries()]).toEqual([]);
    expect([...PREPARE_TOOL_IDS.keys()]).toEqual([]);
    expect([...PREPARE_TOOL_IDS.values()]).toEqual([]);
    expect(PREPARE_TOOL_IDS.has("anything")).toBe(false);
  });

  test("every declared id is not a connector write id (vacuous while empty, pinned for later)", () => {
    for (const id of PREPARE_TOOL_IDS) expect(isConnectorWriteToolId(id)).toBe(false);
  });
});

describe("isPrepareToolId", () => {
  const ids = new Set(["svc_plan"]);
  test("matches the bare id and the mesh key tail, and nothing else", () => {
    expect(isPrepareToolId("svc_plan", ids)).toBe(true);
    expect(isPrepareToolId("srv_svc_plan", ids)).toBe(true);
    expect(isPrepareToolId("svc_planner", ids)).toBe(false);
    expect(isPrepareToolId("svc_plan", PREPARE_TOOL_IDS)).toBe(false);
  });

  test("a mixed set: the iteration reaches every member", () => {
    const set = new Set(["a_one", "b_two"]);
    expect(isPrepareToolId("x_b_two", set)).toBe(true);
  });
});
