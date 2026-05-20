import { describe, expect, it } from "bun:test";
import {
  isDependencyConflictError,
  isOfflineDependencyResolutionError,
} from "./dependency-errors.ts";
import { resolveClosure } from "./dependency-graph.ts";
import type { ExtensionManifestForSolver, RegistryFetcher } from "./dependency-types.ts";

function makeFetcher(
  registry: Record<string, Record<string, ExtensionManifestForSolver>>,
): RegistryFetcher {
  return {
    listVersions: async (id) => {
      const versions = registry[id];
      if (!versions) throw new Error(`unknown_id:${id}`);
      return Object.keys(versions);
    },
    fetchManifest: async (id, version) => {
      const m = registry[id]?.[version];
      if (!m) throw new Error(`unknown_id_version:${id}@${version}`);
      return m;
    },
  };
}

describe("resolveClosure", () => {
  it("happy path — single dep, installs leaf-first", async () => {
    const fetcher = makeFetcher({
      "com.shared.utils": { "1.5.0": { id: "com.shared.utils", version: "1.5.0" } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0" },
    };
    const plan = await resolveClosure(root, fetcher, {
      installed: new Map(),
      activeConstraints: new Map(),
    });
    expect(plan.nodes.map((n) => n.id)).toEqual(["com.shared.utils", "com.example.foo"]);
    expect(plan.nodes[0]?.newlyInstalled).toBe(true);
    expect(plan.nodes[1]?.deps[0]?.resolvedVersion).toBe("1.5.0");
  });

  it("diamond DAG resolves without false-positive cycle", async () => {
    const fetcher = makeFetcher({
      "com.shared.d": { "1.0.0": { id: "com.shared.d", version: "1.0.0" } },
      "com.shared.b": {
        "1.0.0": { id: "com.shared.b", version: "1.0.0", dependsOn: { "com.shared.d": "^1.0.0" } },
      },
      "com.shared.c": {
        "1.0.0": { id: "com.shared.c", version: "1.0.0", dependsOn: { "com.shared.d": "^1.0.0" } },
      },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.a",
      version: "1.0.0",
      dependsOn: { "com.shared.b": "^1.0.0", "com.shared.c": "^1.0.0" },
    };
    const plan = await resolveClosure(root, fetcher, {
      installed: new Map(),
      activeConstraints: new Map(),
    });
    expect(plan.nodes.map((n) => n.id).sort()).toEqual([
      "com.example.a",
      "com.shared.b",
      "com.shared.c",
      "com.shared.d",
    ]);
  });

  it("true cycle returns DependencyConflictError(kind=cycle) with chain", async () => {
    const fetcher = makeFetcher({
      "com.x.a": {
        "1.0.0": { id: "com.x.a", version: "1.0.0", dependsOn: { "com.x.b": "^1.0.0" } },
      },
      "com.x.b": {
        "1.0.0": { id: "com.x.b", version: "1.0.0", dependsOn: { "com.x.a": "^1.0.0" } },
      },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.x.a",
      version: "1.0.0",
      dependsOn: { "com.x.b": "^1.0.0" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("cycle");
        expect(e.conflict.chain?.[0]).toBe("com.x.a");
        expect(e.conflict.chain?.at(-1)).toBe("com.x.a");
      }
    }
  });

  it("unsatisfiable range across closure returns kind=unsatisfiable + named constraints + availableVersions", async () => {
    const fetcher = makeFetcher({
      "com.shared.utils": { "1.5.0": { id: "com.shared.utils", version: "1.5.0" } },
      "com.example.c": {
        "1.0.0": {
          id: "com.example.c",
          version: "1.0.0",
          dependsOn: { "com.shared.utils": "^2.0.0" },
        },
      },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.b",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0", "com.example.c": "^1.0.0" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("unsatisfiable");
        expect(e.conflict.id).toBe("com.shared.utils");
        expect(e.conflict.constraints?.length).toBeGreaterThanOrEqual(2);
        // Review-fix: error carries the registry's listed versions so CLI can print
        // "available: 1.5.0" alongside the conflicting ranges.
        expect(e.conflict.availableVersions).toEqual(["1.5.0"]);
      }
    }
  });

  it("activeConstraints from outside-closure extension blocks the bump", async () => {
    // Spec §2.3 / §6 — auto-update bump A introduces B@^2; installed C wants B@^1.
    const fetcher = makeFetcher({
      "com.shared.b": {
        "1.0.0": { id: "com.shared.b", version: "1.0.0" },
        "2.0.0": { id: "com.shared.b", version: "2.0.0" },
      },
    });
    const newAManifest: ExtensionManifestForSolver = {
      id: "com.example.a",
      version: "2.0.0",
      dependsOn: { "com.shared.b": "^2.0.0" },
    };
    try {
      await resolveClosure(newAManifest, fetcher, {
        installed: new Map([
          ["com.shared.b", "1.0.0"],
          ["com.example.c", "1.0.0"],
        ]),
        activeConstraints: new Map([["com.example.c", new Map([["com.shared.b", "^1.0.0"]])]]),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("unsatisfiable");
        expect(e.conflict.id).toBe("com.shared.b");
        expect(e.conflict.constraints?.some((c) => c.from === "com.example.c")).toBe(true);
      }
    }
  });

  it("installed version that satisfies all ranges is reused (newlyInstalled=false)", async () => {
    const fetcher = makeFetcher({
      "com.shared.utils": { "1.5.0": { id: "com.shared.utils", version: "1.5.0" } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0" },
    };
    const plan = await resolveClosure(root, fetcher, {
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      activeConstraints: new Map(),
    });
    const utils = plan.nodes.find((n) => n.id === "com.shared.utils");
    expect(utils?.newlyInstalled).toBe(false);
  });

  it("invalid semver range surfaces kind=range_invalid", async () => {
    const fetcher = makeFetcher({});
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "not-a-range" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("range_invalid");
      }
    }
  });

  it("network error wraps as OfflineDependencyResolutionError", async () => {
    const fetcher: RegistryFetcher = {
      listVersions: async () => {
        throw new Error("network_down");
      },
      fetchManifest: async () => {
        throw new Error("network_down");
      },
    };
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isOfflineDependencyResolutionError(e)).toBe(true);
      if (isOfflineDependencyResolutionError(e)) {
        expect(e.missingId).toBe("com.shared.utils");
        expect(e.parent).toBe("com.example.foo");
      }
    }
  });
});
