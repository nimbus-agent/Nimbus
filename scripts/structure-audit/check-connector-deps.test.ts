import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWED_CONNECTOR_DEPS, checkConnectorDeps } from "./check-connector-deps.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-connector-deps-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(name: string, manifest: Record<string, unknown>): void {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "server.ts"), "// entry\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
}

fixture("clean", { dependencies: { zod: "^4.0.0", "@nimbus-dev/sdk": "^1.8.1" } });
fixture("native", { dependencies: { "better-sqlite3": "^11.0.0" } });
fixture("optional-native", { optionalDependencies: { keytar: "^7.9.0" } });
fixture("peer-native", { peerDependencies: { "node-gyp": "^10.0.0" } });

describe("checkConnectorDeps", () => {
  test("flags a dependency outside the allowlist", () => {
    expect(checkConnectorDeps(ROOT)).toContainEqual({
      connector: "native",
      dependency: "better-sqlite3",
    });
  });

  test("also inspects optionalDependencies and peerDependencies", () => {
    const v = checkConnectorDeps(ROOT);
    expect(v).toContainEqual({ connector: "optional-native", dependency: "keytar" });
    expect(v).toContainEqual({ connector: "peer-native", dependency: "node-gyp" });
  });

  test("a malformed manifest is an observation failure, never a dependency violation", () => {
    const dir = join(ROOT, "malformed");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "server.ts"), "// entry\n");
    writeFileSync(join(dir, "package.json"), "{ not json");
    try {
      expect(() => checkConnectorDeps(ROOT)).toThrow(/cannot read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts allowlisted dependencies", () => {
    expect(checkConnectorDeps(ROOT).map((e) => e.connector)).not.toContain("clean");
  });

  test("the real connector tree is clean", () => {
    expect(checkConnectorDeps()).toEqual([]);
  });

  test("the allowlist stays small and deliberate", () => {
    expect(ALLOWED_CONNECTOR_DEPS.length).toBeLessThanOrEqual(10);
  });
});
