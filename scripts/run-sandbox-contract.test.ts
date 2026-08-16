import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSandboxTests } from "./run-sandbox-contract.ts";

describe("findSandboxTests", () => {
  test("finds every connector's sandbox test in the real tree", async () => {
    const files = await findSandboxTests();
    // The point of the runner is that it discovers the set rather than carrying a list that
    // goes stale as connectors are added, so this asserts the shape, not a count.
    expect(files.length).toBeGreaterThan(50);
    expect(files.every((f) => f.endsWith("/test/sandbox.test.ts"))).toBe(true);
    expect(files.every((f) => f.startsWith("packages/mcp-connectors/"))).toBe(true);
    // Sorted, so a failing run is diffable against a previous one.
    expect(files).toEqual([...files].sort());
  });

  test("returns forward slashes on every platform", async () => {
    // The paths are handed to `bun test` as argv. A Windows-separator path would still work
    // there, but the assertions above and any caller filtering on "/test/" would not
    // (Non-Negotiable 5: platform equality).
    const files = await findSandboxTests();
    expect(files.some((f) => f.includes("\\"))).toBe(false);
  });

  test("finds nothing in a tree with no connectors, rather than throwing", async () => {
    // The runner treats empty as a hard error and exits 1; that only reads correctly if the
    // discovery itself returns [] instead of blowing up.
    const root = mkdtempSync(join(tmpdir(), "nimbus-sandbox-scan-"));
    mkdirSync(join(root, "packages"), { recursive: true });
    expect(await findSandboxTests(root)).toEqual([]);
  });

  test("matches only the sandbox test, not a connector's other tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-sandbox-scan-"));
    const testDir = join(root, "packages", "mcp-connectors", "demo", "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "sandbox.test.ts"), "");
    writeFileSync(join(testDir, "server.test.ts"), "");
    writeFileSync(join(testDir, "sandbox-helpers.test.ts"), "");
    expect(await findSandboxTests(root)).toEqual([
      "packages/mcp-connectors/demo/test/sandbox.test.ts",
    ]);
  });
});
