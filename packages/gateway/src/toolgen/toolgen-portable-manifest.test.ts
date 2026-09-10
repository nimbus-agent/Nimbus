import { describe, expect, test } from "bun:test";
import { assertConcreteManifestMatches, toPortableManifest } from "./toolgen-portable-manifest.ts";
import { buildGeneratedManifest } from "./toolgen-stub.ts";
import { ERR_TOOLGEN_MANIFEST_SHAPE_INVALID, type ToolgenError } from "./toolgen-types.ts";

const RUNTIME = ["/opt/bun/bin"];

describe("toPortableManifest", () => {
  test("two manifests differing ONLY in resolved read paths are portably identical", () => {
    const a = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/toolgen/ephemeral/t1",
      runtimeReadPaths: RUNTIME,
    });
    const b = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/toolgen/saved/t1",
      runtimeReadPaths: ["/usr/local/bun/bin", "/usr/local"],
    });
    expect(toPortableManifest(a)).toEqual(toPortableManifest(b));
  });
});

describe("assertConcreteManifestMatches", () => {
  test("accepts a manifest whose read set is exactly own-dir + runtime paths", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    expect(() =>
      assertConcreteManifestMatches(m, toPortableManifest(m), ["/cfg/saved/t1", ...RUNTIME]),
    ).not.toThrow();
  });

  test("refuses an extra read path that the expected set does not contain", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: [...RUNTIME, "/etc"],
    });
    try {
      assertConcreteManifestMatches(m, toPortableManifest(m), ["/cfg/saved/t1", ...RUNTIME]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });

  test("refuses a non-empty network grant even when the read set is correct", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    const tampered = { ...m, permissions: { ...m.permissions, network: ["api.example.com"] } };
    try {
      assertConcreteManifestMatches(tampered, toPortableManifest(m), ["/cfg/saved/t1", ...RUNTIME]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });
});
