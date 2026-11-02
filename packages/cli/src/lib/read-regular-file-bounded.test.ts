import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegularFileBounded } from "./read-regular-file-bounded.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-read-bounded-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("readRegularFileBounded", () => {
  test("reads a file within the cap, including one exactly at it", () => {
    writeFileSync(join(dir, "a"), "abcd");
    const r = readRegularFileBounded(join(dir, "a"), 4);
    expect(r.ok && r.bytes.toString()).toBe("abcd");
  });
  test("refuses a file over the cap", () => {
    writeFileSync(join(dir, "a"), "abcde");
    expect(readRegularFileBounded(join(dir, "a"), 4)).toEqual({ ok: false, why: "too large" });
  });
  test("refuses a missing path and a directory without copying OS text", () => {
    expect(readRegularFileBounded(join(dir, "nope"), 4)).toEqual({
      ok: false,
      why: "could not be opened",
    });
    mkdirSync(join(dir, "d"));
    const r = readRegularFileBounded(join(dir, "d"), 4);
    expect(r.ok).toBe(false);
  });
});
