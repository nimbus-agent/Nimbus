import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteFileError, writeFileExclusive } from "./write-file-exclusive.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-write-exclusive-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("writeFileExclusive", () => {
  test("creates a new file", () => {
    const p = join(dir, "a.txt");
    writeFileExclusive(p, bytes("one"));
    expect(readFileSync(p, "utf8")).toBe("one");
  });

  test("refuses an existing file and leaves it untouched", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old");
    expect(() => writeFileExclusive(p, bytes("new"))).toThrow(/exists; refusing to overwrite it/);
    expect(readFileSync(p, "utf8")).toBe("old");
  });

  test("overwrite replaces an existing file", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "a much longer old body");
    writeFileExclusive(p, bytes("new"), { overwrite: true });
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  test("a missing parent directory is a could-not-create error", () => {
    const p = join(dir, "missing", "a.txt");
    expect(() => writeFileExclusive(p, bytes("x"))).toThrow(WriteFileError);
    expect(() => writeFileExclusive(p, bytes("x"))).toThrow(/could not create .*: ENOENT/);
  });

  test("a write that fails after the create removes the file", () => {
    const p = join(dir, "a.txt");
    const writeFd = (): void => {
      throw Object.assign(new Error("disk"), { code: "ENOSPC" });
    };
    expect(() => writeFileExclusive(p, bytes("x"), { writeFd })).toThrow(
      /could not write .*: ENOSPC/,
    );
    expect(existsSync(p)).toBe(false);
  });
});
