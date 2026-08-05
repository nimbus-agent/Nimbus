import { expect, test } from "bun:test";
import { CANDIDATE_DIRS, resolveNimbusBinary } from "./resolve-binary.ts";

test("an explicit NIMBUS_BIN wins over everything", () => {
  const got = resolveNimbusBinary({
    env: { NIMBUS_BIN: "/custom/nimbus" },
    platform: "linux",
    home: "/home/u",
    exists: (p) => p === "/custom/nimbus",
  });
  expect(got).toEqual({ kind: "found", path: "/custom/nimbus", via: "NIMBUS_BIN" });
});

test("a NIMBUS_BIN pointing at nothing is an explicit error, not a silent fallback", () => {
  const got = resolveNimbusBinary({
    env: { NIMBUS_BIN: "/missing/nimbus" },
    platform: "linux",
    home: "/home/u",
    exists: () => false,
  });
  expect(got.kind).toBe("bad-override");
});

test("PATH is used when NIMBUS_BIN is unset", () => {
  const got = resolveNimbusBinary({
    env: { PATH: "/usr/bin:/usr/local/bin" },
    platform: "linux",
    home: "/home/u",
    exists: (p) => p === "/usr/local/bin/nimbus",
  });
  expect(got).toEqual({ kind: "found", path: "/usr/local/bin/nimbus", via: "PATH" });
});

test("falls back to a known install directory", () => {
  const got = resolveNimbusBinary({
    env: {},
    platform: "linux",
    home: "/home/u",
    exists: (p) => p === "/home/u/.nimbus/bin/nimbus",
  });
  expect(got).toEqual({ kind: "found", path: "/home/u/.nimbus/bin/nimbus", via: "install-dir" });
});

test("windows looks for nimbus.exe", () => {
  const got = resolveNimbusBinary({
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32",
    home: "C:\\Users\\u",
    exists: (p) => p.endsWith("nimbus.exe"),
  });
  expect(got.kind).toBe("found");
  if (got.kind === "found") expect(got.path.endsWith("nimbus.exe")).toBe(true);
});

test("not found is reported, never thrown", () => {
  const got = resolveNimbusBinary({
    env: {},
    platform: "darwin",
    home: "/Users/u",
    exists: () => false,
  });
  expect(got.kind).toBe("not-found");
});

test("every platform has at least one candidate directory", () => {
  for (const p of ["win32", "darwin", "linux"] as const) {
    expect(CANDIDATE_DIRS(p, "/home/u", {}).length).toBeGreaterThan(0);
  }
});
