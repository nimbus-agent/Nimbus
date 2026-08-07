// packages/gateway/src/egress/egress-bearing-kinds.test.ts
import { describe, expect, test } from "bun:test";
import {
  EGRESS_BEARING_CLIENT_KINDS,
  egressSourceTypeForClientKind,
} from "./egress-bearing-kinds.ts";

describe("egress-bearing client kinds", () => {
  test("the map is TOTAL over ClientKind", () => {
    // Totality is the whole point. A Partial map or a Map would make a future sixth kind an
    // undefined lookup — an agent brief served to it would append nothing, and nothing would fail.
    // As a total Record, adding a kind without deciding is a COMPILE error; this test pins the
    // runtime shape so the decision cannot be un-made by loosening the type alone.
    expect(Object.keys(EGRESS_BEARING_CLIENT_KINDS).sort()).toEqual([
      "cli",
      "http",
      "mcp",
      "ui",
      "unknown",
    ]);
  });

  test("exactly two kinds bear egress, each mapping to its own source type", () => {
    expect(egressSourceTypeForClientKind("mcp")).toBe("mcp");
    expect(egressSourceTypeForClientKind("http")).toBe("http");
  });

  test("cli, ui and unknown append nothing", () => {
    // #1059's false-positive guard, EXTENDED rather than replaced. A CLI-originated brief is the
    // owner reading their own index on their own machine; recording it as outbound egress would
    // make `nimbus prove` count the user against themselves.
    expect(egressSourceTypeForClientKind("cli")).toBeNull();
    expect(egressSourceTypeForClientKind("ui")).toBeNull();
    expect(egressSourceTypeForClientKind("unknown")).toBeNull();
  });

  test("an absent caller appends nothing", () => {
    // AgentsRpcContext.caller is optional (unit tests and in-process callers omit it). undefined
    // must reach the same answer as a non-bearing kind — not throw, and not default to a type.
    expect(egressSourceTypeForClientKind(undefined)).toBeNull();
  });

  test("every non-null value is a real egress source type, not a free string", () => {
    // Guards the direction the type system does not: a typo'd source type would still be a string.
    const values = Object.values(EGRESS_BEARING_CLIENT_KINDS).filter((v) => v !== null);
    expect(values.sort()).toEqual(["http", "mcp"]);
  });
});
