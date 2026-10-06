import { describe, expect, test } from "bun:test";
import { isAbsolute, join, relative } from "node:path";

import { deriveDemoPaths } from "./demo-root.ts";
import type { PlatformPaths } from "./paths.ts";

/** true when `child` is `parent` or lies inside it. */
function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPlacement(p: PlatformPaths): void {
  for (const other of [p.dataDir, p.configDir]) {
    expect(isSameOrInside(p.sandboxDir, other)).toBe(false);
    expect(isSameOrInside(other, p.sandboxDir)).toBe(false);
  }
}

const root = join("/", "home", "u");
const realLinux: PlatformPaths = {
  configDir: join(root, ".config", "nimbus"),
  dataDir: join(root, ".local", "share", "nimbus"),
  logDir: join(root, ".local", "share", "nimbus", "logs"),
  socketPath: join("/", "run", "user", "1", "nimbus-gateway.sock"),
  extensionsDir: join(root, ".local", "share", "nimbus", "extensions"),
  tempDir: join("/", "tmp", "nimbus"),
  sandboxDir: join(root, ".cache", "nimbus", "sandbox"),
};
const realDarwin: PlatformPaths = {
  ...realLinux,
  configDir: join(root, "Library", "Application Support", "Nimbus"),
  dataDir: join(root, "Library", "Application Support", "Nimbus"),
  sandboxDir: join(root, "Library", "Caches", "Nimbus", "sandbox"),
};

describe("sandboxDir placement", () => {
  test("linux layout keeps sandboxDir out of data/config", () => assertPlacement(realLinux));
  test("darwin layout keeps sandboxDir out of data/config (configDir === dataDir)", () =>
    assertPlacement(realDarwin));
  test("demo layout keeps sandboxDir inside the demo root and out of data/config", () => {
    const demo = deriveDemoPaths(realLinux);
    assertPlacement(demo);
    expect(isSameOrInside(demo.sandboxDir, join(realLinux.dataDir, "demo"))).toBe(true);
  });
});
