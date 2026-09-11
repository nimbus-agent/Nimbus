import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeToolId,
  removeAllToolScripts,
  removeToolScript,
  toolScriptDir,
  writeToolScript,
} from "./toolgen-script-store.ts";

function cfg(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-toolgen-"));
}

describe("assertSafeToolId", () => {
  test("accepts a valid id", () => {
    expect(() => assertSafeToolId("tg_a-1")).not.toThrow();
  });

  test("rejects a traversal attempt", () => {
    expect(() => assertSafeToolId("../../etc")).toThrow();
  });

  test("rejects a forward-slash-bearing id", () => {
    expect(() => assertSafeToolId("a/b")).toThrow();
  });

  test("rejects a backslash-bearing id", () => {
    expect(() => assertSafeToolId("a\\b")).toThrow();
  });

  test("rejects an empty string", () => {
    expect(() => assertSafeToolId("")).toThrow();
  });

  test("rejects an id over 64 characters", () => {
    expect(() => assertSafeToolId("a".repeat(65))).toThrow();
  });

  test("rejects an id containing a newline", () => {
    expect(() => assertSafeToolId("tg_a\nrogue comment")).toThrow();
  });
});

describe("toolScriptDir", () => {
  test("is a pure function of configDir and toolId — derivable before anything is written", () => {
    const c = cfg();
    expect(toolScriptDir(c, "tg_a")).toBe(toolScriptDir(c, "tg_a"));
    expect(toolScriptDir(c, "tg_a")).not.toBe(toolScriptDir(c, "tg_b"));
  });

  test("refuses a tool id containing a path separator — no traversal out of the store", () => {
    expect(() => toolScriptDir(cfg(), "../../etc")).toThrow();
    expect(() => toolScriptDir(cfg(), "a/b")).toThrow();
  });
});

describe("writeToolScript", () => {
  test("writes the source and returns the file path inside the tool's dir", async () => {
    const c = cfg();
    const p = await writeToolScript(c, "tg_a", "export const x = 1;");
    expect(p.startsWith(toolScriptDir(c, "tg_a"))).toBe(true);
    expect(await readFile(p, "utf8")).toBe("export const x = 1;");
  });

  // ACLs are asserted by the Windows integration leg, so this one is SKIPPED there rather than
  // returning early — an early return reports a pass for a test that made no assertion.
  test.skipIf(process.platform === "win32")("the file is owner-only on POSIX", async () => {
    const c = cfg();
    const p = await writeToolScript(c, "tg_a", "x");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("rewriting replaces rather than appending", async () => {
    const c = cfg();
    await writeToolScript(c, "tg_a", "first");
    const p = await writeToolScript(c, "tg_a", "second");
    expect(await readFile(p, "utf8")).toBe("second");
  });
});

describe("removal", () => {
  test("removeToolScript drops the tool directory", async () => {
    const c = cfg();
    await writeToolScript(c, "tg_a", "x");
    await removeToolScript(c, "tg_a");
    expect(existsSync(toolScriptDir(c, "tg_a"))).toBe(false);
  });

  test("removing a tool that was never written is a no-op, not a throw", async () => {
    await expect(removeToolScript(cfg(), "tg_missing")).resolves.toBeUndefined();
  });

  test("removeAllToolScripts drains the store — the shutdown path", async () => {
    const c = cfg();
    await writeToolScript(c, "tg_a", "x");
    await writeToolScript(c, "tg_b", "y");
    await removeAllToolScripts(c);
    expect(existsSync(toolScriptDir(c, "tg_a"))).toBe(false);
    expect(existsSync(toolScriptDir(c, "tg_b"))).toBe(false);
  });
});
