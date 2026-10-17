import { describe, expect, test } from "bun:test";

import { doctorExtensionsLines } from "./extension-doctor-format.ts";

const ext = (id: string, runState: string) => ({ id, runState });

describe("doctorExtensionsLines", () => {
  test("runtime off: silent, even with an unapproved extension", () => {
    expect(
      doctorExtensionsLines({ runtimeEnabled: false, extensions: [ext("a", "no_grant")] }),
    ).toEqual({ lines: [], exit: 0 });
  });

  test("an older gateway without runtimeEnabled is treated as enabled", () => {
    const r = doctorExtensionsLines({ extensions: [ext("a", "no_grant")] });
    expect(r.exit).toBe(1);
    expect(r.lines).toHaveLength(1);
  });

  test("a non-boolean runtimeEnabled is treated as enabled", () => {
    expect(
      doctorExtensionsLines({ runtimeEnabled: "no", extensions: [ext("a", "no_grant")] }).exit,
    ).toBe(1);
  });

  test("nothing to report: silent; disabled, ready and running extensions are not counted", () => {
    expect(
      doctorExtensionsLines({
        runtimeEnabled: true,
        extensions: [ext("a", "disabled"), ext("b", "ready"), ext("c", "running")],
      }),
    ).toEqual({ lines: [], exit: 0 });
  });

  test("no_grant and grant_stale are reported together, with the remedy", () => {
    expect(
      doctorExtensionsLines({
        runtimeEnabled: true,
        extensions: [ext("a", "no_grant"), ext("b", "grant_stale")],
      }),
    ).toEqual({
      lines: [
        "[warn] Extensions: 2 installed extension(s) not approved to run, or approved for an older version (a, b) — nimbus extension approve <id>",
      ],
      exit: 1,
    });
  });

  test("a stale grant that had model access says to re-approve WITH --model", () => {
    // Every approval states the whole grant: following a bare `approve <id>` hint after an update
    // would silently turn model access off.
    const r = doctorExtensionsLines({
      runtimeEnabled: true,
      extensions: [
        { id: "a", runState: "no_grant", runGrant: null },
        { id: "b", runState: "grant_stale", runGrant: { modelAccess: true } },
        { id: "c", runState: "grant_stale", runGrant: { modelAccess: false } },
      ],
    });
    expect(r.lines).toEqual([
      "[warn] Extensions: 3 installed extension(s) not approved to run, or approved for an older version (a, b, c) — nimbus extension approve <id>; add --model to keep model access for: b",
    ]);
  });

  test("more than five are capped with a count of the rest", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const r = doctorExtensionsLines({
      runtimeEnabled: true,
      extensions: ids.map((id) => ext(id, "no_grant")),
    });
    expect(r.lines[0]).toContain("7 installed extension(s)");
    expect(r.lines[0]).toContain("(a, b, c, d, e, +2 more)");
  });

  test("control characters in an id never reach the terminal", () => {
    const r = doctorExtensionsLines({
      runtimeEnabled: true,
      extensions: [ext("evil\u001b[31m", "no_grant")],
    });
    expect(r.lines[0]).not.toContain("\u001b");
    expect(r.lines[0]).toContain("evil[31m");
  });

  test("elements that are not extension records are ignored", () => {
    const r = doctorExtensionsLines({
      runtimeEnabled: true,
      extensions: [42, null, { id: 7, runState: "no_grant" }, ext("a", "no_grant")],
    });
    expect(r.lines[0]).toContain("1 installed extension(s)");
  });

  test("a malformed response throws", () => {
    for (const raw of [null, [], {}, { extensions: "x" }]) {
      expect(() => doctorExtensionsLines(raw)).toThrow(
        "malformed extension.list response from the gateway",
      );
    }
  });
});
