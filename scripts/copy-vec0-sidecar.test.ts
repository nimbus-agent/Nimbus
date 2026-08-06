import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  copyVec0Sidecar,
  npmOsSegment,
  resolveVec0SourceOrThrow,
  vec0Filename,
} from "./copy-vec0-sidecar.ts";

const TMP = mkdtempSync(join(tmpdir(), "nimbus-vec0-"));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("vec0Filename", () => {
  test("maps every platform to its loadable-extension suffix", () => {
    expect(vec0Filename("win32")).toBe("vec0.dll");
    expect(vec0Filename("darwin")).toBe("vec0.dylib");
    expect(vec0Filename("linux")).toBe("vec0.so");
    expect(vec0Filename("freebsd")).toBe("vec0.so");
  });
});

describe("npmOsSegment", () => {
  test("maps platforms to the sqlite-vec npm package segment", () => {
    expect(npmOsSegment("win32")).toBe("windows");
    expect(npmOsSegment("darwin")).toBe("darwin");
    expect(npmOsSegment("linux")).toBe("linux");
    expect(npmOsSegment("freebsd")).toBe("linux");
  });
});

describe("resolveVec0SourceOrThrow", () => {
  test("resolves the host platform's binary from node_modules", () => {
    expect(existsSync(resolveVec0SourceOrThrow())).toBe(true);
  });

  test("names the missing package when a platform/arch is not installed", () => {
    expect(() => resolveVec0SourceOrThrow("linux", "s390x")).toThrow(/sqlite-vec-linux-s390x/);
  });
});

describe("copyVec0Sidecar", () => {
  test("creates the destination and copies the host sidecar into it", () => {
    const dest = join(TMP, "nested", "dist");
    const written = copyVec0Sidecar(dest);
    expect(written).toBe(join(dest, vec0Filename(process.platform)));
    expect(existsSync(written)).toBe(true);
  });
});
