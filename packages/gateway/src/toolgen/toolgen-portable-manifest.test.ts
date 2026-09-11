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

  // The four tests below each isolate ONE refusal branch that the three tests above never
  // reach — `assertConcreteManifestMatches` short-circuits on its first mismatch, so a single
  // "everything is tampered" fixture could never exercise more than the first check it hits.
  test("refuses an id mismatch between the rebuilt and signed manifest", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    const portable = { ...toPortableManifest(m), id: "toolgen.a-different-tool" };
    try {
      assertConcreteManifestMatches(m, portable, ["/cfg/saved/t1", ...RUNTIME]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });

  test("refuses a version mismatch", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    const portable = { ...toPortableManifest(m), version: "9.9.9" };
    try {
      assertConcreteManifestMatches(m, portable, ["/cfg/saved/t1", ...RUNTIME]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });

  test("refuses an updateChannel mismatch", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    const portable = { ...toPortableManifest(m), updateChannel: "beta" };
    try {
      assertConcreteManifestMatches(m, portable, ["/cfg/saved/t1", ...RUNTIME]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });

  test("refuses a non-empty filesystem-write grant on the REBUILT (concrete) manifest", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    const tampered = {
      ...m,
      permissions: {
        ...m.permissions,
        filesystem: { ...m.permissions.filesystem, write: ["/tmp/x"] },
      },
    };
    try {
      assertConcreteManifestMatches(tampered, toPortableManifest(m), ["/cfg/saved/t1", ...RUNTIME]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });

  test("refuses a non-empty filesystem-write grant on the SIGNED (portable) manifest", () => {
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    const portable = { ...toPortableManifest(m), filesystemWrite: ["/tmp/x"] };
    try {
      assertConcreteManifestMatches(m, portable, ["/cfg/saved/t1", ...RUNTIME]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });

  test("refuses a read set that is the RIGHT SIZE but names a path the manifest never grants", () => {
    // Distinct from "refuses an extra read path" above (a SIZE mismatch): same cardinality here,
    // one element swapped, so the failure comes from the per-path membership check rather than
    // the size check that already-passing check runs first.
    const m = buildGeneratedManifest("t1", {
      scriptDir: "/cfg/saved/t1",
      runtimeReadPaths: RUNTIME,
    });
    try {
      assertConcreteManifestMatches(m, toPortableManifest(m), [
        "/cfg/saved/t1",
        "/some/other/path",
      ]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID);
    }
  });
});
