import { describe, expect, it } from "bun:test";
import {
  DependencyConflictError,
  isOfflineDependencyResolutionError,
  OfflineDependencyResolutionError,
} from "./dependency-errors.ts";
import { resolveClosure } from "./dependency-graph.ts";
import type {
  ExtensionManifestForSolver,
  RegistryFetcher,
  ResolveClosureOptions,
} from "./dependency-types.ts";

/**
 * Error-classification coverage for `resolveClosure`'s two registry calls. Each of
 * `listVersions` / `fetchManifest` maps a failure three ways: a registry outage
 * (`OfflineDependencyResolutionError`, or any plain `Error`) is re-raised as an offline error
 * naming THIS dependency and its parent; a `DependencyConflictError` and a non-`Error` throw
 * are passed through untouched, so a real conflict is never disguised as "you are offline".
 */

const ROOT: ExtensionManifestForSolver = {
  id: "com.example.root",
  version: "1.0.0",
  dependsOn: { "com.shared.dep": "^1.0.0" },
};

const OPTS: ResolveClosureOptions = { installed: new Map(), activeConstraints: new Map() };

function conflict(): DependencyConflictError {
  return new DependencyConflictError({ kind: "unsatisfiable", id: "com.other.thing" });
}

/** listVersions fails with `listErr`; fetchManifest is never reached. */
function failingList(listErr: unknown): RegistryFetcher {
  return {
    listVersions: async () => {
      throw listErr;
    },
    fetchManifest: async () => {
      throw new Error("fetchManifest must not be reached");
    },
  };
}

/** listVersions succeeds with 1.2.0; fetchManifest fails with `fetchErr`. */
function failingFetch(fetchErr: unknown): RegistryFetcher {
  return {
    listVersions: async () => ["1.2.0"],
    fetchManifest: async () => {
      throw fetchErr;
    },
  };
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected resolveClosure to reject");
}

describe("resolveClosure — listVersions failure classification", () => {
  it("re-raises an upstream offline error as one naming THIS dependency and parent", async () => {
    const upstream = new OfflineDependencyResolutionError({
      missingId: "com.deeper.dep",
      parent: "com.shared.dep",
    });
    const err = await rejectionOf(resolveClosure(ROOT, failingList(upstream), OPTS));
    expect(isOfflineDependencyResolutionError(err)).toBe(true);
    expect(err).not.toBe(upstream);
    if (isOfflineDependencyResolutionError(err)) {
      expect(err.missingId).toBe("com.shared.dep");
      expect(err.parent).toBe("com.example.root");
    }
  });

  it("passes a DependencyConflictError through unchanged (not disguised as offline)", async () => {
    const original = conflict();
    const err = await rejectionOf(resolveClosure(ROOT, failingList(original), OPTS));
    expect(err).toBe(original);
    expect(isOfflineDependencyResolutionError(err)).toBe(false);
  });

  it("passes a non-Error throw through unchanged", async () => {
    const err = await rejectionOf(resolveClosure(ROOT, failingList("registry exploded"), OPTS));
    expect(err).toBe("registry exploded");
  });
});

describe("resolveClosure — fetchManifest failure classification", () => {
  it("wraps a plain Error from fetchManifest as offline, naming the dependency and parent", async () => {
    const err = await rejectionOf(
      resolveClosure(ROOT, failingFetch(new Error("ECONNRESET")), OPTS),
    );
    expect(isOfflineDependencyResolutionError(err)).toBe(true);
    if (isOfflineDependencyResolutionError(err)) {
      expect(err.missingId).toBe("com.shared.dep");
      expect(err.parent).toBe("com.example.root");
    }
  });

  it("passes a DependencyConflictError from fetchManifest through unchanged", async () => {
    const original = conflict();
    const err = await rejectionOf(resolveClosure(ROOT, failingFetch(original), OPTS));
    expect(err).toBe(original);
  });

  it("passes a non-Error fetchManifest throw through unchanged", async () => {
    const thrown = { status: 500 };
    const err = await rejectionOf(resolveClosure(ROOT, failingFetch(thrown), OPTS));
    expect(err).toBe(thrown);
  });
});

describe("resolveClosure — manifest cache", () => {
  it("fetches a shared dependency's manifest once across a diamond", async () => {
    const calls: string[] = [];
    const registry: Record<string, Record<string, ExtensionManifestForSolver>> = {
      "com.shared.d": { "1.0.0": { id: "com.shared.d", version: "1.0.0" } },
      "com.shared.b": {
        "1.0.0": { id: "com.shared.b", version: "1.0.0", dependsOn: { "com.shared.d": "^1.0.0" } },
      },
      "com.shared.c": {
        "1.0.0": { id: "com.shared.c", version: "1.0.0", dependsOn: { "com.shared.d": "^1.0.0" } },
      },
    };
    const fetcher: RegistryFetcher = {
      listVersions: async (id) => Object.keys(registry[id] ?? {}),
      fetchManifest: async (id, version) => {
        calls.push(`${id}@${version}`);
        const m = registry[id]?.[version];
        if (!m) throw new Error(`missing ${id}@${version}`);
        return m;
      },
    };
    const plan = await resolveClosure(
      {
        id: "com.example.a",
        version: "1.0.0",
        dependsOn: { "com.shared.b": "^1.0.0", "com.shared.c": "^1.0.0" },
      },
      fetcher,
      OPTS,
    );
    expect(calls.filter((c) => c === "com.shared.d@1.0.0")).toHaveLength(1);
    expect(plan.nodes.map((n) => n.id)).toEqual([
      "com.shared.d",
      "com.shared.b",
      "com.shared.c",
      "com.example.a",
    ]);
  });
});
