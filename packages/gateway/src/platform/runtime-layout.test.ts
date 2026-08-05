import { describe, expect, test } from "bun:test";

import {
  DEFAULT_RUNTIME_LAYOUT,
  isCompiledBinary,
  ROLE_SENTINELS,
  type RuntimeLayout,
  selfSpawn,
} from "./runtime-layout.ts";

/** A dev tree: the gateway runs under `bun packages/gateway/src/index.ts`. */
const DEV: RuntimeLayout = {
  execPath: "/usr/local/bin/bun",
  moduleDir: "/repo/packages/gateway/src/platform",
  gatewayEntry: "/repo/packages/gateway/src/index.ts",
};

/** Measured value of `import.meta.dir` inside a compiled binary on POSIX. */
const COMPILED_POSIX: RuntimeLayout = {
  execPath: "/opt/nimbus/nimbus-gateway",
  moduleDir: "/$bunfs/root",
  gatewayEntry: "/$bunfs/root/index.ts",
};

/** Measured value of `import.meta.dir` inside a compiled binary on Windows. */
const COMPILED_WIN: RuntimeLayout = {
  execPath: "C:\\Program Files\\Nimbus\\nimbus-gateway.exe",
  moduleDir: "B:\\~BUN\\root",
  gatewayEntry: "B:\\~BUN\\root\\index.ts",
};

describe("isCompiledBinary", () => {
  test("is false in a dev tree", () => {
    expect(isCompiledBinary(DEV)).toBe(false);
  });

  test("is true for the POSIX bunfs root", () => {
    expect(isCompiledBinary(COMPILED_POSIX)).toBe(true);
  });

  test("is true for the Windows bunfs root", () => {
    expect(isCompiledBinary(COMPILED_WIN)).toBe(true);
  });

  test("is false for a real directory that merely mentions bun", () => {
    expect(isCompiledBinary({ ...DEV, moduleDir: "/home/dev/bunfs/src" })).toBe(false);
  });
});

describe("selfSpawn", () => {
  test("compiled: the binary re-executes itself with the sentinel first", () => {
    const spawn = selfSpawn("connector", ["github"], COMPILED_POSIX);
    expect(spawn.command).toBe("/opt/nimbus/nimbus-gateway");
    expect(spawn.args).toEqual(["__nimbus-connector", "github"]);
  });

  test("dev: bun runs the gateway entry, then the sentinel", () => {
    const spawn = selfSpawn("connector", ["github"], DEV);
    expect(spawn.command).toBe("/usr/local/bin/bun");
    expect(spawn.args).toEqual([
      "/repo/packages/gateway/src/index.ts",
      "__nimbus-connector",
      "github",
    ]);
  });

  test("the child sees the same argv.slice(2) in both shapes", () => {
    const compiled = selfSpawn("sandbox", ["bun", "x.ts"], COMPILED_POSIX);
    const dev = selfSpawn("sandbox", ["bun", "x.ts"], DEV);
    // argv is [execPath-ish, entry..., ...args]; the child slices 2 off process.argv, and in the
    // compiled shape bun injects its own argv[0]/argv[1] pair. Both therefore start at the sentinel.
    expect(compiled.args).toEqual(["__nimbus-sandbox", "bun", "x.ts"]);
    expect(dev.args.slice(1)).toEqual(["__nimbus-sandbox", "bun", "x.ts"]);
  });

  test("defaults to no role arguments", () => {
    expect(selfSpawn("sandbox", undefined, COMPILED_POSIX).args).toEqual(["__nimbus-sandbox"]);
  });

  test("the two sentinels are distinct and namespaced", () => {
    expect(ROLE_SENTINELS.sandbox).not.toBe(ROLE_SENTINELS.connector);
    for (const s of Object.values(ROLE_SENTINELS)) {
      expect(s.startsWith("__nimbus-")).toBe(true);
    }
  });
});

describe("DEFAULT_RUNTIME_LAYOUT", () => {
  test("points gatewayEntry at the gateway's own index.ts", () => {
    expect(DEFAULT_RUNTIME_LAYOUT.gatewayEntry).toMatch(/index\.ts$/);
    expect(DEFAULT_RUNTIME_LAYOUT.execPath).toBe(process.execPath);
  });
});
