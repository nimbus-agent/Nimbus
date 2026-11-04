import { describe, expect, test } from "bun:test";

import { extractToolInput as viaRegistry } from "../connectors/registry.ts";
import { extractToolInput } from "./tool-input.ts";

describe("extractToolInput", () => {
  test("extractToolInput still behaves as before", () => {
    expect(extractToolInput({ type: "x" })).toEqual({});
    expect(extractToolInput({ type: "x", payload: { mcpToolId: "t", input: { a: 1 } } })).toEqual({
      a: 1,
    });
    expect(extractToolInput({ type: "x", payload: { mcpToolId: "t", a: 1, b: 2 } })).toEqual({
      a: 1,
      b: 2,
    });
  });

  test("the registry re-exports the same function", () => {
    expect(viaRegistry).toBe(extractToolInput);
  });
});
