import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { BUNDLED_SQLITE_FILENAME } from "../packages/gateway/src/platform/sqlite-runtime.ts";
import {
  amalgamationNumericVersion,
  amalgamationUrl,
  assertDownloadMatchesPin,
  clangArgs,
  OUTPUT_FILENAME,
  SQLITE_PIN,
} from "./build-sqlite-darwin.ts";

/**
 * The compile itself is macOS-only; everything decided BEFORE the compile is not, and that is what
 * these cover. The flag set and the download pin are the two places a mistake ships silently — a
 * missing `SQLITE_ENABLE_FTS5` would break keyword search on every macOS install while vector
 * search started working, and a wrong pin would compile whatever the mirror served.
 *
 * The end-to-end proof that the resulting library actually loads sqlite-vec and speaks FTS5 lives
 * in `test/integration/platform/bundled-sqlite.test.ts`, which runs on the macOS leg only.
 */

describe("amalgamationNumericVersion", () => {
  test("encodes major, minor, patch and a trailing build field, each zero-padded", () => {
    expect(amalgamationNumericVersion("3.53.4")).toBe("3530400");
    expect(amalgamationNumericVersion("3.50.0")).toBe("3500000");
    expect(amalgamationNumericVersion("3.9.2")).toBe("3090200");
  });

  test("refuses a version that is not three dotted numbers", () => {
    for (const bad of ["3.53", "3.53.4.1", "3.53.x", "", "353400"]) {
      expect(() => amalgamationNumericVersion(bad)).toThrow(/version/i);
    }
  });

  test("the pinned version encodes to the pinned zip name", () => {
    expect(SQLITE_PIN.zip).toBe(
      `sqlite-amalgamation-${amalgamationNumericVersion(SQLITE_PIN.version)}.zip`,
    );
  });
});

describe("OUTPUT_FILENAME", () => {
  test("is the same name the gateway resolves beside its executable", () => {
    // TWO definitions on purpose, pinned by this one assertion rather than merged. The build script
    // runs in CI BEFORE `bun install`, so it cannot import the gateway module — that module's first
    // line pulls in `bun:sqlite` and `sqlite-vec`, neither of which exists yet at that point. This
    // test runs after install, where importing both is free, so the drift the duplication invites
    // is caught here instead of in a release that packages a file nothing looks for.
    expect(OUTPUT_FILENAME).toBe(BUNDLED_SQLITE_FILENAME);
  });
});

describe("amalgamationUrl", () => {
  test("is an https sqlite.org URL carrying the pinned year and zip", () => {
    const url = amalgamationUrl(SQLITE_PIN);
    expect(url).toBe(`https://sqlite.org/${SQLITE_PIN.year}/${SQLITE_PIN.zip}`);
    expect(new URL(url).protocol).toBe("https:");
  });
});

describe("assertDownloadMatchesPin", () => {
  const pinFor = (bytes: Uint8Array) => ({
    ...SQLITE_PIN,
    sizeBytes: bytes.byteLength,
    sha3_256: createHash("sha3-256").update(bytes).digest("hex"),
  });

  test("accepts bytes whose size and SHA3-256 both match", () => {
    const bytes = new TextEncoder().encode("pretend amalgamation");
    expect(() => assertDownloadMatchesPin(bytes, pinFor(bytes))).not.toThrow();
  });

  test("refuses a hash mismatch, naming both hashes so the reader can compare", () => {
    const bytes = new TextEncoder().encode("tampered");
    const pin = { ...pinFor(bytes), sha3_256: "0".repeat(64) };
    expect(() => assertDownloadMatchesPin(bytes, pin)).toThrow(/0{64}/);
    expect(() => assertDownloadMatchesPin(bytes, pin)).toThrow(
      new RegExp(createHash("sha3-256").update(bytes).digest("hex")),
    );
  });

  test("refuses a size mismatch before hashing, so a truncated download says so plainly", () => {
    const bytes = new TextEncoder().encode("short");
    expect(() => assertDownloadMatchesPin(bytes, { ...pinFor(bytes), sizeBytes: 999999 })).toThrow(
      /999999/,
    );
  });
});

describe("clangArgs", () => {
  const args = clangArgs({
    sourceC: "/w/sqlite3.c",
    outDylib: "/w/libsqlite3.dylib",
    arch: "arm64",
    minMacos: "11.0",
  });

  test("builds a dynamic library at the requested path from the requested source", () => {
    expect(args).toContain("-dynamiclib");
    expect(args).toContain("/w/sqlite3.c");
    expect(args.join(" ")).toContain("-o /w/libsqlite3.dylib");
  });

  test("enables FTS5, which keyword search already depends on", () => {
    // setCustomSQLite repoints the WHOLE process. A build without FTS5 would take away something
    // that works on macOS today in the act of fixing something that does not.
    expect(args).toContain("-DSQLITE_ENABLE_FTS5");
  });

  test("never compiles out extension loading, which is the entire point of the library", () => {
    expect(args.join(" ")).not.toContain("SQLITE_OMIT_LOAD_EXTENSION");
  });

  test("enables the other features a Homebrew build would have had", () => {
    // Our library is now preferred OVER Homebrew's, including for users who have one. It must not
    // be less capable than the build it displaces.
    for (const flag of [
      "-DSQLITE_ENABLE_RTREE",
      "-DSQLITE_ENABLE_GEOPOLY",
      "-DSQLITE_ENABLE_DBSTAT_VTAB",
      "-DSQLITE_ENABLE_COLUMN_METADATA",
      "-DSQLITE_ENABLE_MATH_FUNCTIONS",
      "-DSQLITE_MAX_VARIABLE_NUMBER=250000",
    ]) {
      expect(args).toContain(flag);
    }
  });

  test("is threadsafe, because the gateway opens databases from several Worker realms", () => {
    expect(args).toContain("-DSQLITE_THREADSAFE=1");
  });

  test("pins the architecture and the deployment target rather than inheriting the runner's", () => {
    expect(args.join(" ")).toContain("-arch arm64");
    expect(args).toContain("-mmacosx-version-min=11.0");
    expect(
      clangArgs({
        sourceC: "/w/sqlite3.c",
        outDylib: "/w/libsqlite3.dylib",
        arch: "x64",
        minMacos: "11.0",
      }).join(" "),
    ).toContain("-arch x86_64");
  });

  test("refuses an architecture it has no macOS name for", () => {
    expect(() =>
      clangArgs({
        sourceC: "/w/sqlite3.c",
        outDylib: "/w/libsqlite3.dylib",
        arch: "riscv64",
        minMacos: "11.0",
      }),
    ).toThrow(/riscv64/);
  });
});
