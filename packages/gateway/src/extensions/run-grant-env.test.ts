import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { resolveRuntimeById } from "../exec/exec-runtimes.ts";
import { buildExtensionRunGrantEnv, isExtensionRuntimeEnabled } from "./run-grant-env.ts";

describe("buildExtensionRunGrantEnv — the ONE env approve and spawn both resolve grants against", () => {
  test("mesh roots plus the extensions dir, the Bun runtime's read paths, the native realpath", () => {
    const roots = [join("/n", "data"), join("/n", "config"), join("/n", "sandbox")];
    const env = buildExtensionRunGrantEnv(roots, join("/n", "extensions"));
    expect(env.platform).toBe(process.platform);
    expect(env.protectedRoots).toEqual([...roots, join("/n", "extensions")]);
    expect(env.runtimeReadPaths).toEqual(resolveRuntimeById("bun").requiredReadPaths());
    expect(env.realpath).toBe(realpathSync.native);
  });

  test("no extensions dir adds nothing", () => {
    expect(buildExtensionRunGrantEnv(["/a"], undefined).protectedRoots).toEqual(["/a"]);
  });
});

describe("isExtensionRuntimeEnabled — the kill switch and the I41 demo bound", () => {
  test("on only when [extensions] runtime is true AND the gateway is not demo-rooted", () => {
    expect(isExtensionRuntimeEnabled({ runtime: true }, {})).toBe(true);
    expect(isExtensionRuntimeEnabled({ runtime: true }, { demo: false })).toBe(true);
    expect(isExtensionRuntimeEnabled({ runtime: false }, {})).toBe(false);
    expect(isExtensionRuntimeEnabled({ runtime: true }, { demo: true })).toBe(false);
    expect(isExtensionRuntimeEnabled({ runtime: false }, { demo: true })).toBe(false);
  });
});
