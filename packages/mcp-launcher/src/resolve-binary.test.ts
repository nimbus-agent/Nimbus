import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    exists: (p) => p === "/home/u/.local/bin/nimbus",
  });
  expect(got).toEqual({ kind: "found", path: "/home/u/.local/bin/nimbus", via: "install-dir" });
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

/**
 * The drift guard the module comment on `CANDIDATE_DIRS` promises.
 *
 * `packages/mcp-launcher` is MIT and must not import from the AGPL sources, and `scripts/` is not a
 * dependency of it either — so the installer's directories are read as TEXT out of
 * `scripts/install/lib/paths.ts`. A text read creates neither a package dependency nor a licence
 * problem, and it fails the moment either side moves: the previous `length > 0` assertion would
 * have passed against `[""]`, and did pass while every non-Linux candidate was wrong.
 *
 * Resolved from `import.meta.dir`, never the CWD — a CWD-relative source read ENOENTs under a
 * sharded test runner, which is how a guard silently stops guarding.
 */
const INSTALLER_PATHS_SRC = readFileSync(
  resolve(import.meta.dir, "../../../scripts/install/lib/paths.ts"),
  "utf8",
);

/** The suffix `resolveInstallDir` appends to `%LOCALAPPDATA%` on Windows, e.g. `\Programs\Nimbus\bin`. */
function installerWin32Suffix(): string {
  const m = /String\.raw`\$\{localAppData\}([^`]*)`/.exec(INSTALLER_PATHS_SRC);
  expect({ matchedWin32InstallDir: m !== null }).toEqual({ matchedWin32InstallDir: true });
  return m?.[1] ?? "";
}

/** The suffix `resolveInstallDir` appends to `$HOME` on macOS and Linux, e.g. `/.local/bin`. */
function installerPosixSuffix(): string {
  const m = /return `\$\{home\}([^`]*)`/.exec(INSTALLER_PATHS_SRC);
  expect({ matchedPosixInstallDir: m !== null }).toEqual({ matchedPosixInstallDir: true });
  return m?.[1] ?? "";
}

test("the FIRST candidate on every platform is the installer's own output directory", () => {
  expect(INSTALLER_PATHS_SRC.length).toBeGreaterThan(0);

  // cross-platform-ok: the Windows separators here come from the installer source itself, read
  // above — this assertion is the drift check, not a host-path assumption.
  const localAppData = "C:\\Users\\u\\AppData\\Local";
  expect(CANDIDATE_DIRS("win32", "C:\\Users\\u", { LOCALAPPDATA: localAppData })[0]).toBe(
    `${localAppData}${installerWin32Suffix()}`,
  );

  const posixSuffix = installerPosixSuffix();
  expect(CANDIDATE_DIRS("darwin", "/Users/u", {})[0]).toBe(`/Users/u${posixSuffix}`);
  expect(CANDIDATE_DIRS("linux", "/home/u", {})[0]).toBe(`/home/u${posixSuffix}`);
});

test("no candidate directory is a location no installer or distribution channel writes to", () => {
  // `~/.nimbus/bin` was invented by the plan and appears nowhere else in the repo. Naming it here
  // keeps it from drifting back in as a plausible-looking guess.
  for (const p of ["win32", "darwin", "linux"] as const) {
    for (const dir of CANDIDATE_DIRS(p, "/home/u", { LOCALAPPDATA: "C:\\L" })) {
      expect(dir).not.toContain(".nimbus");
    }
  }
});
