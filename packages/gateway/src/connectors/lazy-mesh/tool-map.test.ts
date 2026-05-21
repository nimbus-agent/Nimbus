import { describe, expect, it } from "bun:test";

import { type LazyMeshToolMap, listLazyMeshClientTools, mergeToolMapsOrThrow } from "./tool-map.ts";

describe("mergeToolMapsOrThrow", () => {
  it("merges two disjoint tool maps", () => {
    const a: LazyMeshToolMap = { tool_a: { execute: async () => "a" } };
    const b: LazyMeshToolMap = { tool_b: { execute: async () => "b" } };
    const merged = mergeToolMapsOrThrow([
      { map: a, name: "server_a" },
      { map: b, name: "server_b" },
    ]);
    expect(Object.keys(merged).sort()).toEqual(["tool_a", "tool_b"]);
  });

  it("throws with owner names on a collision", () => {
    const a: LazyMeshToolMap = { dup: { execute: async () => 1 } };
    const b: LazyMeshToolMap = { dup: { execute: async () => 2 } };
    expect(() =>
      mergeToolMapsOrThrow([
        { map: a, name: "first_server" },
        { map: b, name: "second_server" },
      ]),
    ).toThrow(/dup.*first_server.*second_server/);
  });

  it("returns an empty map when given no sources", () => {
    expect(mergeToolMapsOrThrow([])).toEqual({});
  });
});

describe("listLazyMeshClientTools", () => {
  it("returns empty map when client is undefined", async () => {
    const out = await listLazyMeshClientTools(undefined);
    expect(out).toEqual({});
  });

  it("delegates to client.listTools when client is provided", async () => {
    const fakeMap: LazyMeshToolMap = { foo: { execute: async () => "ok" } };
    // Minimal stub — only listTools is touched by the helper. Cast through
    // unknown so we satisfy the @mastra/mcp MCPClient surface without pulling
    // in its 100+-method type into a tiny test.
    const fakeClient = { listTools: async () => fakeMap } as unknown as Parameters<
      typeof listLazyMeshClientTools
    >[0];
    const out = await listLazyMeshClientTools(fakeClient);
    expect(out).toBe(fakeMap);
  });
});
