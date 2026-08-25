import { describe, expect, test } from "bun:test";

import { runQuietly } from "./harness-teardown.ts";

describe("runQuietly", () => {
  test("runs every step in order", () => {
    const seen: string[] = [];
    runQuietly([() => seen.push("a"), () => seen.push("b"), () => seen.push("c")]);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  // The property the four inlined copies encoded: a server that failed to stop
  // must not strand the database handle or the temp directory behind it. On
  // Windows an unclosed SQLite handle also blocks the directory removal, so the
  // first failure would otherwise cost two more.
  test("still runs the later steps after an earlier one throws", () => {
    const seen: string[] = [];
    runQuietly([
      () => {
        throw new Error("server stop failed");
      },
      () => seen.push("db.close"),
      () => seen.push("rmSync"),
    ]);
    expect(seen).toEqual(["db.close", "rmSync"]);
  });

  test("swallows a throw from the last step too", () => {
    expect(() =>
      runQuietly([
        () => {},
        () => {
          throw new Error("rmSync failed");
        },
      ]),
    ).not.toThrow();
  });

  test("swallows a thrown non-Error value", () => {
    const seen: string[] = [];
    expect(() =>
      runQuietly([
        () => {
          throw "not an error";
        },
        () => seen.push("after"),
      ]),
    ).not.toThrow();
    expect(seen).toEqual(["after"]);
  });

  test("accepts an empty step list", () => {
    expect(() => runQuietly([])).not.toThrow();
  });
});
