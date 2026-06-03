import { describe, expect, test } from "bun:test";

import { filterFirebaseReleases } from "../src/search-filter.ts";

function release(fields: {
  name?: string;
  displayVersion?: string;
  buildVersion?: string;
  notes?: string;
}): Record<string, unknown> {
  return {
    name: fields.name ?? "projects/1/apps/a/releases/r",
    displayVersion: fields.displayVersion ?? "1.0.0",
    buildVersion: fields.buildVersion ?? "100",
    releaseNotes: { text: fields.notes ?? "Initial release" },
  };
}

describe("filterFirebaseReleases", () => {
  test("matches against displayVersion", () => {
    const out = filterFirebaseReleases([release({ displayVersion: "2.4.1" })], { query: "2.4.1" });
    expect(out).toHaveLength(1);
  });

  test("matches against buildVersion", () => {
    const out = filterFirebaseReleases([release({ buildVersion: "4242" })], { query: "4242" });
    expect(out).toHaveLength(1);
  });

  test("matches against release notes (case-insensitive)", () => {
    const out = filterFirebaseReleases(
      [
        release({ name: "r1", notes: "Fixes the login crash" }),
        release({ name: "r2", notes: "Adds dark mode" }),
      ],
      { query: "CRASH" },
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { name: string }).name).toBe("r1");
  });

  test("matches against the resource name", () => {
    const out = filterFirebaseReleases([release({ name: "projects/1/apps/a/releases/ZZZ" })], {
      query: "zzz",
    });
    expect(out).toHaveLength(1);
  });

  test("tolerates a missing releaseNotes object", () => {
    const out = filterFirebaseReleases(
      [{ name: "no-notes", displayVersion: "match-me" }, release({ displayVersion: "x" })],
      { query: "match" },
    );
    expect(out).toHaveLength(1);
  });

  test("skips non-object entries", () => {
    const out = filterFirebaseReleases([42, null, "string", release({ buildVersion: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches truncated in encounter order", () => {
    const releases = Array.from({ length: 10 }, (_, i) =>
      release({ name: `r-${i}`, buildVersion: "9" }),
    );
    const out = filterFirebaseReleases(releases, { query: "9", limit: 3 });
    expect(out).toHaveLength(3);
    expect(out.map((it) => (it as { name: string }).name)).toEqual(["r-0", "r-1", "r-2"]);
  });

  test("empty list returns empty", () => {
    expect(filterFirebaseReleases([], { query: "anything" })).toEqual([]);
  });
});
