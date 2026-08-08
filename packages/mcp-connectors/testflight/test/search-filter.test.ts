import { describe, expect, test } from "bun:test";

import { filterTestflightBuilds } from "../src/search-filter.ts";

function build(fields: {
  id?: string;
  version?: string;
  processingState?: string;
  minOsVersion?: string;
}): Record<string, unknown> {
  return {
    type: "builds",
    id: fields.id ?? "1001",
    attributes: {
      version: fields.version ?? "42",
      processingState: fields.processingState ?? "VALID",
      minOsVersion: fields.minOsVersion ?? "16.0",
    },
  };
}

describe("filterTestflightBuilds", () => {
  test("matches against version", () => {
    const out = filterTestflightBuilds([build({ version: "1.2.3" })], { query: "1.2.3" });
    expect(out).toHaveLength(1);
  });

  test("matches against processingState (case-insensitive)", () => {
    const out = filterTestflightBuilds(
      [
        build({ id: "a", processingState: "VALID" }),
        build({ id: "b", processingState: "PROCESSING" }),
      ],
      { query: "processing" },
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { id: string }).id).toBe("b");
  });

  test("matches against minOsVersion", () => {
    const out = filterTestflightBuilds([build({ minOsVersion: "17.4" })], { query: "17.4" });
    expect(out).toHaveLength(1);
  });

  test("matches against the build id", () => {
    const out = filterTestflightBuilds([build({ id: "BUILD-ZZZ" })], { query: "zzz" });
    expect(out).toHaveLength(1);
  });

  test("skips non-object entries (numbers, nulls, strings)", () => {
    const out = filterTestflightBuilds([42, null, "string", build({ version: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("tolerates a missing attributes object", () => {
    const out = filterTestflightBuilds([{ id: "no-attrs" }, build({ version: "match-me" })], {
      query: "match",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches truncated in encounter order", () => {
    const builds = Array.from({ length: 10 }, (_, i) => build({ id: `id-${i}`, version: "9" }));
    const out = filterTestflightBuilds(builds, { query: "9", limit: 3 });
    expect(out).toHaveLength(3);
    expect(out.map((it) => (it as { id: string }).id)).toEqual(["id-0", "id-1", "id-2"]);
  });

  test("default limit is 50", () => {
    const builds = Array.from({ length: 100 }, (_, i) =>
      build({ id: `s-${i}`, processingState: "VALID" }),
    );
    const out = filterTestflightBuilds(builds, { query: "valid" });
    expect(out).toHaveLength(50);
  });

  test("empty list returns empty", () => {
    expect(filterTestflightBuilds([], { query: "anything" })).toEqual([]);
  });

  test("empty query returns all (up to limit)", () => {
    const builds = Array.from({ length: 10 }, (_, i) =>
      build({ id: `s-${i}`, processingState: "VALID" }),
    );
    const out = filterTestflightBuilds(builds, { query: "" });
    expect(out).toHaveLength(10);
  });
});
