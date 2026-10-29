import { describe, expect, it } from "bun:test";
import { type DependencySpec, RegistryError } from "@nimbus-dev/registry-format";
import fc from "fast-check";
import {
  conflictErrorsOf,
  DependencyConflictError,
  isDependencyConflictError,
  isDependencyConflictsError,
  isOfflineDependencyResolutionError,
} from "./dependency-errors.ts";
import { resolveClosure } from "./dependency-graph.ts";
import {
  type ExtensionManifestForSolver,
  type RegistryFetcher,
  registryNameOf,
  type SourceKey,
  sourceKey,
} from "./dependency-types.ts";

function makeFetcher(
  registry: Record<string, Record<string, ExtensionManifestForSolver>>,
): RegistryFetcher {
  return {
    targetSource: () => null,
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
      dependsOn: { "com.shared.utils": { range: "^1.0.0" } },
    };
    const plan = await resolveClosure(root, null, fetcher, {
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
        "1.0.0": {
          id: "com.shared.b",
          version: "1.0.0",
          dependsOn: { "com.shared.d": { range: "^1.0.0" } },
        },
      },
      "com.shared.c": {
        "1.0.0": {
          id: "com.shared.c",
          version: "1.0.0",
          dependsOn: { "com.shared.d": { range: "^1.0.0" } },
        },
      },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.a",
      version: "1.0.0",
      dependsOn: { "com.shared.b": { range: "^1.0.0" }, "com.shared.c": { range: "^1.0.0" } },
    };
    const plan = await resolveClosure(root, null, fetcher, {
      installed: new Map(),
      activeConstraints: new Map(),
    });
    expect(plan.nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b))).toEqual([
      "com.example.a",
      "com.shared.b",
      "com.shared.c",
      "com.shared.d",
    ]);
  });

  it("topo tiebreak is deterministic locale order among simultaneously-ready leaves (S2871)", async () => {
    const fetcher = makeFetcher({
      "com.shared.zebra": { "1.0.0": { id: "com.shared.zebra", version: "1.0.0" } },
      "com.shared.alpha": { "1.0.0": { id: "com.shared.alpha", version: "1.0.0" } },
      "com.shared.mango": { "1.0.0": { id: "com.shared.mango", version: "1.0.0" } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.app",
      version: "1.0.0",
      dependsOn: {
        "com.shared.zebra": { range: "^1.0.0" },
        "com.shared.alpha": { range: "^1.0.0" },
        "com.shared.mango": { range: "^1.0.0" },
      },
    };
    const plan = await resolveClosure(root, null, fetcher, {
      installed: new Map(),
      activeConstraints: new Map(),
    });
    expect(plan.nodes.map((n) => n.id)).toEqual([
      "com.shared.alpha",
      "com.shared.mango",
      "com.shared.zebra",
      "com.example.app",
    ]);
  });

  it("true cycle returns DependencyConflictError(kind=cycle) with chain", async () => {
    const fetcher = makeFetcher({
      "com.x.a": {
        "1.0.0": { id: "com.x.a", version: "1.0.0", dependsOn: { "com.x.b": { range: "^1.0.0" } } },
      },
      "com.x.b": {
        "1.0.0": { id: "com.x.b", version: "1.0.0", dependsOn: { "com.x.a": { range: "^1.0.0" } } },
      },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.x.a",
      version: "1.0.0",
      dependsOn: { "com.x.b": { range: "^1.0.0" } },
    };
    try {
      await resolveClosure(root, null, fetcher, {
        installed: new Map(),
        activeConstraints: new Map(),
      });
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
          dependsOn: { "com.shared.utils": { range: "^2.0.0" } },
        },
      },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.b",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": { range: "^1.0.0" }, "com.example.c": { range: "^1.0.0" } },
    };
    try {
      await resolveClosure(root, null, fetcher, {
        installed: new Map(),
        activeConstraints: new Map(),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("unsatisfiable");
        expect(e.conflict.id).toBe("com.shared.utils");
        expect(e.conflict.constraints?.length).toBeGreaterThanOrEqual(2);
        expect(e.conflict.availableVersions).toEqual(["1.5.0"]);
      }
    }
  });

  it("activeConstraints from outside-closure extension blocks the bump", async () => {
    const fetcher = makeFetcher({
      "com.shared.b": {
        "1.0.0": { id: "com.shared.b", version: "1.0.0" },
        "2.0.0": { id: "com.shared.b", version: "2.0.0" },
      },
    });
    const newAManifest: ExtensionManifestForSolver = {
      id: "com.example.a",
      version: "2.0.0",
      dependsOn: { "com.shared.b": { range: "^2.0.0" } },
    };
    try {
      await resolveClosure(newAManifest, null, fetcher, {
        installed: new Map([
          ["com.shared.b", { version: "1.0.0", source: null }],
          ["com.example.c", { version: "1.0.0", source: null }],
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
      dependsOn: { "com.shared.utils": { range: "^1.0.0" } },
    };
    const plan = await resolveClosure(root, null, fetcher, {
      installed: new Map([["com.shared.utils", { version: "1.5.0", source: null }]]),
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
      dependsOn: { "com.shared.utils": { range: "not-a-range" } },
    };
    try {
      await resolveClosure(root, null, fetcher, {
        installed: new Map(),
        activeConstraints: new Map(),
      });
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
      targetSource: () => null,
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
      dependsOn: { "com.shared.utils": { range: "^1.0.0" } },
    };
    try {
      await resolveClosure(root, null, fetcher, {
        installed: new Map(),
        activeConstraints: new Map(),
      });
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

interface DagFixture {
  rootId: string;
  registry: Record<string, Record<string, ExtensionManifestForSolver>>;
}

function dagArb(): fc.Arbitrary<DagFixture> {
  return fc.integer({ min: 2, max: 12 }).chain((n) => {
    const ids = Array.from({ length: n }, (_, i) => `com.test.n${i}`);
    return fc
      .array(fc.integer({ min: 0, max: 100 }), { minLength: n * n, maxLength: n * n })
      .map((flat) => {
        const registry: Record<string, Record<string, ExtensionManifestForSolver>> = {};
        for (let i = 0; i < n; i++) {
          const dependsOn: Record<string, DependencySpec> = {};
          for (let j = i + 1; j < n; j++) {
            const cell = flat[i * n + j];
            if ((cell ?? 0) > 70) dependsOn[ids[j] ?? "x"] = { range: "^1.0.0" };
          }
          const id = ids[i] ?? "x";
          registry[id] = { "1.0.0": { id, version: "1.0.0", dependsOn } };
        }
        return { rootId: ids[0] ?? "x", registry };
      });
  });
}

describe("resolveClosure — fast-check corpus", () => {
  it("if a solution exists, every pin satisfies every range", async () => {
    await fc.assert(
      fc.asyncProperty(dagArb(), async ({ rootId, registry }) => {
        const fetcher = makeFetcher(registry);
        const root = registry[rootId]?.["1.0.0"];
        if (!root) return;
        try {
          const plan = await resolveClosure(root, null, fetcher, {
            installed: new Map(),
            activeConstraints: new Map(),
          });
          for (const node of plan.nodes) {
            for (const dep of node.deps) {
              expect(registry[dep.id]?.[dep.resolvedVersion]).toBeDefined();
            }
          }
        } catch (e) {
          expect(isDependencyConflictError(e) || isOfflineDependencyResolutionError(e)).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("diamond never false-positives as cycle", async () => {
    await fc.assert(
      fc.asyncProperty(dagArb(), async ({ rootId, registry }) => {
        const fetcher = makeFetcher(registry);
        const root = registry[rootId]?.["1.0.0"];
        if (!root) return;
        try {
          await resolveClosure(root, null, fetcher, {
            installed: new Map(),
            activeConstraints: new Map(),
          });
        } catch (e) {
          if (isDependencyConflictError(e)) {
            expect(e.conflict.kind).not.toBe("cycle");
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});

type Catalog = Record<string, Record<string, ExtensionManifestForSolver>>;

/**
 * An in-memory fetcher keyed by `source|id`. `targetSource` sends a dependency with no `registry`
 * to its parent's source and maps a named registry through `registries`; every call is recorded.
 */
function makeSourcedFetcher(
  catalog: Record<string, Catalog>,
  registries: Record<string, SourceKey> = {},
): RegistryFetcher & {
  readonly listed: string[];
  readonly fetched: string[];
  readonly specs: DependencySpec[];
} {
  const listed: string[] = [];
  const fetched: string[] = [];
  const specs: DependencySpec[] = [];
  return {
    listed,
    fetched,
    specs,
    targetSource: (parentSource, _depId, spec) => {
      specs.push(spec);
      if (spec.registry === undefined) return parentSource;
      return registries[spec.registry] ?? null;
    },
    listVersions: async (id, source) => {
      listed.push(`${source}|${id}`);
      return Object.keys(catalog[String(source)]?.[id] ?? {});
    },
    fetchManifest: async (id, version, source) => {
      fetched.push(`${source}|${id}@${version}`);
      const m = catalog[String(source)]?.[id]?.[version];
      if (!m) throw new DependencyConflictError({ kind: "unsatisfiable", id });
      return m;
    },
  };
}

const S1 = sourceKey("r1", "a".repeat(32));
const S2 = sourceKey("r2", "b".repeat(32));
const NO_OPTS = { installed: new Map(), activeConstraints: new Map() } as const;

function leaf(id: string, version = "1.0.0"): Record<string, ExtensionManifestForSolver> {
  return { [version]: { id, version } };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected resolveClosure to reject");
}

describe("sourceKey", () => {
  it("joins name and fingerprint, and registryNameOf recovers the name", () => {
    expect(S1).toBe(`r1#${"a".repeat(32)}`);
    expect(registryNameOf(S1)).toBe("r1");
  });
});

describe("resolveClosure — sources", () => {
  it("a string dependency resolves in its parent's source", async () => {
    const fetcher = makeSourcedFetcher({
      [S1]: { b: leaf("b") },
      [S2]: { b: leaf("b", "1.9.0") },
    });
    const root = { id: "root", version: "1.0.0", dependsOn: { b: { range: "^1" } } };
    const plan = await resolveClosure(root, S1, fetcher, NO_OPTS);
    const b = plan.nodes.find((n) => n.id === "b");
    expect(b?.version).toBe("1.0.0");
    expect(b?.source).toBe(S1);
    expect(plan.nodes.find((n) => n.id === "root")?.source).toBe(S1);
    expect(plan.nodes.find((n) => n.id === "root")?.deps[0]?.registry).toBe("r1");
    expect([...fetcher.listed, ...fetcher.fetched].some((c) => c.startsWith(`${S2}|`))).toBe(false);
  });

  it("an object dependency resolves where targetSource says", async () => {
    const fetcher = makeSourcedFetcher(
      { [S1]: { b: leaf("b") }, [S2]: { b: leaf("b", "1.9.0") } },
      { "https://r2/": S2 },
    );
    const root = {
      id: "root",
      version: "1.0.0",
      dependsOn: { b: { range: "^1", registry: "https://r2/" } },
    };
    const plan = await resolveClosure(root, S1, fetcher, NO_OPTS);
    const b = plan.nodes.find((n) => n.id === "b");
    expect(b?.version).toBe("1.9.0");
    expect(b?.source).toBe(S2);
    expect(plan.nodes.find((n) => n.id === "root")?.deps[0]?.registry).toBe("r2");
  });

  it("an object dependency reaches targetSource with its registry", async () => {
    const fetcher = makeSourcedFetcher({ [S2]: { b: leaf("b") } }, { "https://r2/": S2 });
    const root = {
      id: "root",
      version: "1.0.0",
      dependsOn: { b: { range: "^1", registry: "https://r2/" } },
    };
    await resolveClosure(root, S1, fetcher, NO_OPTS);
    expect(fetcher.specs).toEqual([{ range: "^1", registry: "https://r2/" }]);
  });

  it("a locally installed copy does not satisfy a registry dependency", async () => {
    const fetcher = makeSourcedFetcher({ [S1]: { b: leaf("b") } });
    const root = { id: "root", version: "1.0.0", dependsOn: { b: { range: "^1" } } };
    const err = await rejection(
      resolveClosure(root, S1, fetcher, {
        installed: new Map([["b", { version: "1.0.0", source: null }]]),
        activeConstraints: new Map(),
      }),
    );
    expect(err).toBeInstanceOf(RegistryError);
    if (!(err instanceof RegistryError)) return;
    expect(err.code).toBe("ERR_DEPENDENCY_SOURCE_MISMATCH");
    expect(err.message).toContain("a local folder");
    expect(err.message).toContain("nimbus extension remove b");
    expect(err.message).toContain("root needs it from r1");
  });

  it("a copy installed from another registry does not satisfy", async () => {
    const fetcher = makeSourcedFetcher({ [S1]: { b: leaf("b") } });
    const root = { id: "root", version: "1.0.0", dependsOn: { b: { range: "^1" } } };
    const err = await rejection(
      resolveClosure(root, S1, fetcher, {
        installed: new Map([["b", { version: "1.0.0", source: S2 }]]),
        activeConstraints: new Map(),
      }),
    );
    expect(err).toBeInstanceOf(RegistryError);
    if (!(err instanceof RegistryError)) return;
    expect(err.code).toBe("ERR_DEPENDENCY_SOURCE_MISMATCH");
    expect(err.message).toContain("b is installed from r2");
  });

  it("the same id planned from two registries is refused", async () => {
    const fetcher = makeSourcedFetcher(
      {
        [S1]: {
          b: leaf("b"),
          c: {
            "1.0.0": {
              id: "c",
              version: "1.0.0",
              dependsOn: { b: { range: "^1", registry: "https://r2/" } },
            },
          },
        },
        [S2]: { b: leaf("b") },
      },
      { "https://r2/": S2 },
    );
    const root = {
      id: "root",
      version: "1.0.0",
      dependsOn: { b: { range: "^1" }, c: { range: "^1" } },
    };
    const err = await rejection(resolveClosure(root, S1, fetcher, NO_OPTS));
    expect(err).toBeInstanceOf(RegistryError);
    if (!(err instanceof RegistryError)) return;
    expect(err.code).toBe("ERR_DEPENDENCY_SOURCE_MISMATCH");
    expect(err.message).toContain("b is already planned from r1");
    expect(err.message).toContain("c needs it from r2");
  });

  it("a local solve still accepts any installed copy", async () => {
    const fetcher = makeSourcedFetcher({ [S2]: { b: leaf("b") } }, {});
    const local: RegistryFetcher = { ...fetcher, targetSource: () => null };
    const root = { id: "root", version: "1.0.0", dependsOn: { b: { range: "^1" } } };
    const plan = await resolveClosure(root, null, local, {
      installed: new Map([["b", { version: "1.0.0", source: S2 }]]),
      activeConstraints: new Map(),
    });
    const b = plan.nodes.find((n) => n.id === "b");
    expect(b?.newlyInstalled).toBe(false);
    expect(plan.nodes.find((n) => n.id === "root")?.deps[0]?.registry).toBeNull();
  });

  it("a diamond resolves its shared dependency once", async () => {
    const fetcher = makeSourcedFetcher({
      [S1]: {
        d: leaf("d"),
        b: { "1.0.0": { id: "b", version: "1.0.0", dependsOn: { d: { range: "^1" } } } },
        c: { "1.0.0": { id: "c", version: "1.0.0", dependsOn: { d: { range: "^1" } } } },
      },
    });
    const root = {
      id: "root",
      version: "1.0.0",
      dependsOn: { b: { range: "^1" }, c: { range: "^1" } },
    };
    const plan = await resolveClosure(root, S1, fetcher, NO_OPTS);
    expect(plan.nodes.filter((n) => n.id === "d")).toHaveLength(1);
    expect(fetcher.fetched.filter((c) => c === `${S1}|d@1.0.0`)).toHaveLength(1);
  });

  it("incompatible diamond ranges are unsatisfiable", async () => {
    const fetcher = makeSourcedFetcher({
      [S1]: {
        d: { ...leaf("d"), ...leaf("d", "2.0.0") },
        b: { "1.0.0": { id: "b", version: "1.0.0", dependsOn: { d: { range: "^1" } } } },
        c: { "1.0.0": { id: "c", version: "1.0.0", dependsOn: { d: { range: "^2" } } } },
      },
    });
    const root = {
      id: "root",
      version: "1.0.0",
      dependsOn: { b: { range: "^1" }, c: { range: "^1" } },
    };
    const err = await rejection(resolveClosure(root, S1, fetcher, NO_OPTS));
    expect(isDependencyConflictError(err)).toBe(true);
    if (!isDependencyConflictError(err)) return;
    expect(err.conflict.kind).toBe("unsatisfiable");
    expect(err.conflict.id).toBe("d");
  });

  it("a pinned id that no longer satisfies is refused, not re-chosen", async () => {
    const fetcher = makeSourcedFetcher({ [S1]: { b: { ...leaf("b"), ...leaf("b", "2.0.0") } } });
    const root = { id: "root", version: "1.0.0", dependsOn: { b: { range: "^2" } } };
    const err = await rejection(
      resolveClosure(root, S1, fetcher, {
        installed: new Map([["b", { version: "1.0.0", source: S1 }]]),
        activeConstraints: new Map(),
      }),
    );
    expect(isDependencyConflictError(err)).toBe(true);
    if (!isDependencyConflictError(err)) return;
    expect(err.conflict.kind).toBe("unsatisfiable");
    expect(err.conflict.availableVersions).toEqual(["1.0.0", "2.0.0"]);
    expect(fetcher.fetched).not.toContain(`${S1}|b@2.0.0`);
  });

  it("an installed same-version node is not newly installed", async () => {
    const fetcher = makeSourcedFetcher({ [S1]: { b: leaf("b") } });
    const root = { id: "root", version: "1.0.0", dependsOn: { b: { range: "^1" } } };
    const plan = await resolveClosure(root, S1, fetcher, {
      installed: new Map([["b", { version: "1.0.0", source: S1 }]]),
      activeConstraints: new Map(),
    });
    expect(plan.nodes.find((n) => n.id === "b")?.newlyInstalled).toBe(false);
    expect(plan.nodes.find((n) => n.id === "b")?.source).toBe(S1);
    expect(plan.nodes.find((n) => n.id === "root")?.newlyInstalled).toBe(true);
  });
});

describe("resolveClosure — collectConflicts", () => {
  const fetcher = makeFetcher({
    "com.a": { "1.0.0": { id: "com.a", version: "1.0.0" } },
    "com.b": { "1.0.0": { id: "com.b", version: "1.0.0" } },
    "com.ok": { "1.0.0": { id: "com.ok", version: "1.0.0" } },
  });
  const root: ExtensionManifestForSolver = {
    id: "com.root",
    version: "1.0.0",
    dependsOn: {
      "com.a": { range: "^2.0.0" },
      "com.ok": { range: "^1.0.0" },
      "com.b": { range: "^3.0.0" },
    },
  };
  const opts = { installed: new Map(), activeConstraints: new Map() };

  it("without it, the first refusal is thrown alone", async () => {
    const e = await resolveClosure(root, null, fetcher, opts).catch((x: unknown) => x);
    expect(isDependencyConflictError(e) && e.conflict.id).toBe("com.a");
  });

  it("with it, every refused sibling is reported, in declaration order", async () => {
    const e = await resolveClosure(root, null, fetcher, { ...opts, collectConflicts: true }).catch(
      (x: unknown) => x,
    );
    expect(isDependencyConflictsError(e)).toBe(true);
    const ids = conflictErrorsOf(e).map((x) => (isDependencyConflictError(x) ? x.conflict.id : x));
    expect(ids).toEqual(["com.a", "com.b"]);
  });

  it("with it, one refusal is still thrown as itself", async () => {
    const one = { ...root, dependsOn: { "com.a": { range: "^2.0.0" } } };
    const e = await resolveClosure(one, null, fetcher, { ...opts, collectConflicts: true }).catch(
      (x: unknown) => x,
    );
    expect(isDependencyConflictError(e)).toBe(true);
  });

  it("with it, a failure that is not a refusal still throws at once", async () => {
    // Naming a dependency's source contacts nothing, so a throw there is a bug, not a refusal.
    const broken: RegistryFetcher = {
      ...fetcher,
      targetSource: () => {
        throw new TypeError("a bug");
      },
    };
    const e = await resolveClosure(root, null, broken, { ...opts, collectConflicts: true }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TypeError);
  });
});
