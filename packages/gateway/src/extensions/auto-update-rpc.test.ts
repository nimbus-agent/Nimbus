import { beforeEach, describe, expect, it, mock } from "bun:test";

import { RegistryError } from "@nimbus-dev/registry-format";
import { AutoUpdateCache } from "./auto-update-cache.ts";
import { _resetAutoUpdateMutexForTests, dispatchAutoUpdateRpc } from "./auto-update-rpc.ts";
import type { AddedPackage, AvailableUpdate, UpdatePlan } from "./auto-update-types.ts";
import type { ConnectorRequirementStatus } from "./connector-requirements.ts";
import { DependencyConflictError } from "./dependency-errors.ts";
import type { ExtensionManifest } from "./manifest.ts";
import type {
  RegistryDependencyResolver,
  VerifiedDependency,
} from "./registry/registry-dependency-fetcher.ts";

/**
 * A plan as `planUpdate` returns it: the root at its new version plus `added`, each verified with
 * `manifests[id]` (a dependency without one has no verified manifest).
 */
function fakePlan(
  added: readonly AddedPackage[] = [],
  manifests: Readonly<Record<string, Partial<ExtensionManifest>>> = {},
): UpdatePlan {
  const verified = (id: string, version: string): VerifiedDependency | undefined => {
    const m = manifests[id];
    if (m === undefined) return undefined;
    return {
      id,
      version,
      reg: { name: "main", rootFingerprint: "c".repeat(32) },
      manifest: {
        id,
        version,
        permissions: { network: [], filesystem: { read: [], write: [] } },
        ...m,
      },
      publisherKey: "AAAA",
      publisherChange: null,
      verifiedPublisher: null,
    } as unknown as VerifiedDependency;
  };
  const resolver = { verified } as unknown as RegistryDependencyResolver;
  const root = {
    id: "com.example.a",
    version: "1.1.0",
    source: null,
    newlyInstalled: true,
    deps: added.map((a) => ({ id: a.id, range: "^1.0.0" })),
  };
  const nodes = [
    ...added.map((a) => ({
      id: a.id,
      version: a.version,
      source: null,
      newlyInstalled: true,
      deps: [],
    })),
    root,
  ];
  return { resolver, plan: { nodes } as unknown as UpdatePlan["plan"], addedPackages: added };
}

function mkCache(): AutoUpdateCache {
  const c = new AutoUpdateCache();
  const u: AvailableUpdate = {
    id: "com.example.a",
    displayName: "A",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    changelog: "fixes",
    publisherStatus: "verified",
    manifestHash: "d".repeat(64),
    signatureB64: "AA==",
    entryHash: "e".repeat(64),
    packageSha256: "f".repeat(64),
    packageSizeBytes: 100,
    sourceRegistry: "main",
    rootFingerprint: "c".repeat(32),
    packagePath: "extensions/com.example.a/1.1.0/package.tgz",
    permissionDiff: {
      network: { added: ["b.com"], removed: [] },
      filesystem: {
        read: { added: [], removed: [] },
        write: { added: [], removed: [] },
      },
    },
    verificationStatus: "verified",
    detectedAt: 1,
  };
  c.upsert(u);
  return c;
}

type Deps = Parameters<typeof dispatchAutoUpdateRpc>[2];

function baseDeps(): Deps {
  return {
    cache: mkCache(),
    forcePoll: async () => {},
    gate: async () => "proceed" as const,
    performUpgrade: mock(async () => ({ orphanedDependencies: [] })),
    performDowngrade: mock(async () => ({ orphanedDependencies: [] })),
    appendAudit: async () => {},
    getInstalledVersion: async () => "1.0.0",
    hasPrevVersion: async () => false,
    planUpdate: async () => fakePlan(),
  };
}

beforeEach(() => {
  _resetAutoUpdateMutexForTests();
});

describe("dispatchAutoUpdateRpc extension.checkForUpdates", () => {
  it("returns cache list when force is absent or false", async () => {
    const deps = baseDeps();
    const res = (await dispatchAutoUpdateRpc(
      "extension.checkForUpdates",
      {},
      deps,
    )) as AvailableUpdate[];
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe("com.example.a");
  });

  it("triggers force poll when force=true", async () => {
    const deps = baseDeps();
    const forcePoll = mock(async () => {});
    deps.forcePoll = forcePoll;
    await dispatchAutoUpdateRpc("extension.checkForUpdates", { force: true }, deps);
    expect(forcePoll).toHaveBeenCalled();
  });
});

describe("dispatchAutoUpdateRpc extension.update", () => {
  it("rejects cache_miss when no entry exists", async () => {
    const deps = baseDeps();
    deps.cache = new AutoUpdateCache();
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.nope", toVersion: "1.0.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "cache_miss" });
  });

  it("rejects cache_miss when id/toVersion mismatch", async () => {
    const deps = baseDeps();
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "9.9.9" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res.reason).toBe("cache_miss");
  });

  it("rejects publisher_key_conflict, naming the source registry", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, verificationStatus: "publisher_key_conflict" });
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string; hint?: string };
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("publisher_key_conflict");
    expect(res.hint).toContain("registry main");
    expect(res.hint).not.toMatch(/extension sync/);
  });

  it("--accept-publisher-key with the update's exact fingerprint proceeds, stating the change", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({
      ...cur,
      verificationStatus: "publisher_key_conflict",
      publisherKeyFingerprint: "b".repeat(32),
      publisherKeyChange: { from: ["a".repeat(32)], to: "b".repeat(32) },
    });
    const prompts: Array<Record<string, unknown>> = [];
    deps.gate = async (a) => {
      prompts.push(a.payload);
      return "proceed" as const;
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0", acceptPublisherKey: "b".repeat(32) },
      deps,
    )) as { applied: boolean };
    expect(res.applied).toBe(true);
    expect(prompts[0]?.["publisherChange"]).toEqual({
      from: ["a".repeat(32)],
      to: "b".repeat(32),
      via: "owner",
    });
    expect(prompts[0]?.["publisherChangeNote"]).toContain(
      "not vouched for by any rotation or by Nimbus",
    );
    // The apply carries the accepted fingerprint, so its re-verification decides with it.
    const applied = (deps.performUpgrade as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      acceptedPublisherKey?: string;
    };
    expect(applied.acceptedPublisherKey).toBe("b".repeat(32));
  });

  it("--accept-publisher-key naming another fingerprint is refused, not treated as acceptance", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({
      ...cur,
      verificationStatus: "publisher_key_conflict",
      publisherKeyFingerprint: "b".repeat(32),
    });
    await expect(
      dispatchAutoUpdateRpc(
        "extension.update",
        { id: "com.example.a", toVersion: "1.1.0", acceptPublisherKey: "0".repeat(32) },
        deps,
      ),
    ).rejects.toThrow(/must name the key this update is signed with/);
    expect(deps.performUpgrade).not.toHaveBeenCalled();
  });

  it("an acceptance on an already-vouched update keeps saying what vouched for it", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({
      ...cur,
      publisherKeyFingerprint: "b".repeat(32),
      publisherKeyChange: { from: ["a".repeat(32)], to: "b".repeat(32), via: "rotation" },
    });
    const prompts: Array<Record<string, unknown>> = [];
    deps.gate = async (a) => {
      prompts.push(a.payload);
      return "proceed" as const;
    };
    await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0", acceptPublisherKey: "b".repeat(32) },
      deps,
    );
    expect(prompts[0]?.["publisherChange"]).toMatchObject({ via: "rotation" });
    const applied = (deps.performUpgrade as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      acceptedPublisherKey?: string;
    };
    expect(applied.acceptedPublisherKey).toBeUndefined();
  });

  it("a rotation-vouched change is stated in the prompt without any flag", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({
      ...cur,
      publisherKeyFingerprint: "b".repeat(32),
      publisherKeyChange: { from: ["a".repeat(32)], to: "b".repeat(32), via: "nimbus" },
    });
    const prompts: Array<Record<string, unknown>> = [];
    deps.gate = async (a) => {
      prompts.push(a.payload);
      return "proceed" as const;
    };
    await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    expect(prompts[0]?.["publisherChangeNote"]).toContain("vouched for by Nimbus");
  });

  it("rejects signature_failed", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, verificationStatus: "signature_failed" });
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res.reason).toBe("signature_failed");
  });

  it("rejects same_version", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res.reason).toBe("same_version");
  });

  it("rejects downgrade_unavailable", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "0.9.0", fromVersion: "1.1.0" });
    deps.hasPrevVersion = async () => false;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "0.9.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res.reason).toBe("downgrade_unavailable");
  });

  it("gates upgrade through extension.autoUpdate", async () => {
    const deps = baseDeps();
    const gate = mock(async () => "proceed" as const);
    deps.gate = gate;
    await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    const calls = (gate as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
    const action = calls[0]?.[0] as { type: string; payload: Record<string, unknown> } | undefined;
    expect(action?.type).toBe("extension.autoUpdate");
    // The prompt names where the update comes from; no field is `*Key`-named (the executor
    // would redact it to [REDACTED]).
    expect(action?.payload).toMatchObject({
      sourceRegistry: "main",
      rootFingerprint: "c".repeat(32),
    });
    expect(Object.keys(action?.payload ?? {}).filter((k) => /key/i.test(k))).toEqual([]);
  });

  it("returns applied=false / reason=user_rejected when gate rejects", async () => {
    const deps = baseDeps();
    deps.gate = async () => ({ status: "rejected" as const });
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "user_rejected" });
  });

  it("calls performUpgrade on approval", async () => {
    const deps = baseDeps();
    const performUpgrade = mock(async () => ({ orphanedDependencies: [] }));
    deps.performUpgrade = performUpgrade;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean };
    expect(performUpgrade).toHaveBeenCalled();
    expect(res.applied).toBe(true);
  });

  it("calls performDowngrade on approval when toVersion < installed", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "1.0.0", fromVersion: "1.1.0" });
    deps.hasPrevVersion = async () => true;
    const performDowngrade = mock(async () => ({ orphanedDependencies: [] }));
    deps.performDowngrade = performDowngrade;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.0.0" },
      deps,
    )) as { applied: boolean };
    expect(performDowngrade).toHaveBeenCalled();
    expect(res.applied).toBe(true);
  });

  it("a downgrade result names the dependencies it left orphaned, and the gate shows no plan", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "1.0.0", fromVersion: "1.1.0" });
    deps.hasPrevVersion = async () => true;
    const gated: unknown[] = [];
    deps.gate = async (action) => {
      gated.push(action);
      return "proceed" as const;
    };
    deps.performDowngrade = async () => ({ orphanedDependencies: ["dep.new", "dep.child"] });
    const res = await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.0.0" },
      deps,
    );
    expect(res).toEqual({
      applied: true,
      jobId: "d".repeat(16),
      orphanedDependencies: ["dep.new", "dep.child"],
    });
    expect(JSON.stringify(gated)).not.toContain("planText");
  });

  it("a downgrade that orphans nothing carries no orphanedDependencies field", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "1.0.0", fromVersion: "1.1.0" });
    deps.hasPrevVersion = async () => true;
    const res = await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.0.0" },
      deps,
    );
    expect(res).toEqual({ applied: true, jobId: "d".repeat(16) });
  });

  it("refuses a forward update whose source registry is gone, before the gate", async () => {
    const deps = baseDeps();
    const gate = mock(async () => "proceed" as const);
    deps.gate = gate;
    deps.isSourceCurrent = async () => false;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string; hint?: string };
    expect(res).toMatchObject({ applied: false, reason: "source_registry_changed" });
    expect(res.hint).toContain("source registry main was removed or re-pinned");
    expect(gate).not.toHaveBeenCalled();
  });

  it("a downgrade from a cached _prev needs no source registry", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "1.0.0", fromVersion: "1.1.0" });
    deps.hasPrevVersion = async () => true;
    deps.isSourceCurrent = async () => false;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.0.0" },
      deps,
    )) as { applied: boolean };
    expect(res.applied).toBe(true);
  });

  it("a cached update to a prerelease reaches the gate (SemVer 2.0.0, not x.y.z only)", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "1.1.0-beta.1" });
    deps.getInstalledVersion = async () => "1.0.0";
    const gated: Array<{ type: string }> = [];
    deps.gate = async (action) => {
      gated.push(action);
      return "proceed";
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0-beta.1" },
      deps,
    )) as { applied: boolean };
    expect(gated.map((g) => g.type)).toEqual(["extension.autoUpdate"]);
    expect(res.applied).toBe(true);
  });

  it("an installed prerelease updates to its release: 1.1.0-beta.1 -> 1.1.0 is an upgrade", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, fromVersion: "1.1.0-beta.1", toVersion: "1.1.0" });
    deps.getInstalledVersion = async () => "1.1.0-beta.1";
    const gated: Array<{ type: string }> = [];
    deps.gate = async (action) => {
      gated.push(action);
      return "proceed";
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean };
    expect(gated.map((g) => g.type)).toEqual(["extension.autoUpdate"]);
    expect(res.applied).toBe(true);
  });

  it("a release -> its own prerelease is still a downgrade", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, fromVersion: "1.1.0", toVersion: "1.1.0-beta.1" });
    deps.getInstalledVersion = async () => "1.1.0";
    deps.hasPrevVersion = async () => false;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0-beta.1" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "downgrade_unavailable" });
  });

  it("a version that is not strict SemVer is refused via InvalidVersionFormat", async () => {
    const deps = baseDeps();
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "v1.1" });
    deps.getInstalledVersion = async () => "1.0.0";
    await expect(
      dispatchAutoUpdateRpc("extension.update", { id: "com.example.a", toVersion: "v1.1" }, deps),
    ).rejects.toThrow(/unsupported version format/i);
  });

  it("update_in_flight when mutex held", async () => {
    const deps = baseDeps();
    let release: () => void = () => {};
    deps.performUpgrade = async () => {
      await new Promise<void>((res) => {
        release = res;
      });
      return { orphanedDependencies: [] };
    };
    const first = dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    await new Promise((r) => setTimeout(r, 0));
    const second = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(second).toEqual({ applied: false, reason: "update_in_flight" });
    release();
    await first;
  });

  it("returns the failure phase and audits it when performUpgrade throws", async () => {
    const deps = baseDeps();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    deps.appendAudit = async (type, payload) => {
      audits.push({ type, payload });
    };
    deps.performUpgrade = async () => {
      throw new Error("sha256_mismatch");
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "sha256_mismatch" });
    expect(audits[0]?.type).toBe("extension.autoUpdate.failed");
    expect(audits[0]?.payload["phase"]).toBe("sha256_mismatch");
  });

  // lines 87-88: getInstalledVersion returns null → cache_miss
  it("returns cache_miss when getInstalledVersion returns null", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => null;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "cache_miss" });
  });

  // lines 66-68: id or toVersion empty string → cache_miss
  it("returns cache_miss when id is missing from params", async () => {
    const deps = baseDeps();
    const res = (await dispatchAutoUpdateRpc("extension.update", { toVersion: "1.1.0" }, deps)) as {
      applied: boolean;
      reason?: string;
    };
    expect(res).toEqual({ applied: false, reason: "cache_miss" });
  });

  it("returns cache_miss when toVersion is missing from params", async () => {
    const deps = baseDeps();
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "cache_miss" });
  });

  // lines 139-151: performDowngrade throws Error → extension.downgrade.failed audit
  it("returns the failure phase and audits extension.downgrade.failed when performDowngrade throws an Error", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "1.0.0", fromVersion: "1.1.0" });
    deps.hasPrevVersion = async () => true;
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    deps.appendAudit = async (type, payload) => {
      audits.push({ type, payload });
    };
    deps.performDowngrade = async () => {
      throw new Error("swap_failed during rollback");
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.0.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "swap_failed" });
    expect(audits[0]?.type).toBe("extension.downgrade.failed");
    expect(audits[0]?.payload["phase"]).toBe("swap_failed");
    expect(audits[0]?.payload["id"]).toBe("com.example.a");
  });

  it.each([
    ["an update", "1.1.0", "extension.autoUpdate.failed"],
    ["a downgrade", "1.0.0", "extension.downgrade.failed"],
  ])(
    "%s whose rollback failed is warned and shown to the owner as detail",
    async (_what, toVersion, auditType) => {
      const deps = baseDeps();
      if (toVersion === "1.0.0") {
        deps.getInstalledVersion = async () => "1.1.0";
        const cur = deps.cache.get("com.example.a")!;
        deps.cache.upsert({ ...cur, toVersion: "1.0.0", fromVersion: "1.1.0" });
        deps.hasPrevVersion = async () => true;
      }
      const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
      deps.appendAudit = async (type, payload) => {
        audits.push({ type, payload });
      };
      const warned: unknown[][] = [];
      deps.logger = { warn: (...args: unknown[]) => void warned.push(args) };
      const failed = () =>
        Object.assign(new Error("swap_failed: rename EBUSY"), {
          rollbackFailures: [
            {
              step: "removeDirectory",
              id: "acme.dep",
              dir: `/x/${String.fromCodePoint(0x202e)}acme.dep`,
              error: new Error("EBUSY"),
            },
          ],
        });
      deps.performUpgrade = async () => {
        throw failed();
      };
      deps.performDowngrade = async () => {
        throw failed();
      };
      const res = await dispatchAutoUpdateRpc(
        "extension.update",
        { id: "com.example.a", toVersion },
        deps,
      );
      expect(res).toEqual({
        applied: false,
        reason: "swap_failed",
        detail: "rollback incomplete: /x/acme.dep",
      });
      expect(audits[0]?.type).toBe(auditType);
      expect(audits[0]?.payload["message"]).toBe(
        "swap_failed: rename EBUSY (rollback incomplete: /x/acme.dep)",
      );
      expect(warned).toHaveLength(1);
      expect(warned[0]?.[0]).toMatchObject({ installing: "com.example.a" });
    },
  );

  it("a failure whose rollback completed carries no detail and warns nothing", async () => {
    const deps = baseDeps();
    const warned: unknown[][] = [];
    deps.logger = { warn: (...args: unknown[]) => void warned.push(args) };
    deps.performUpgrade = async () => {
      throw new Error("swap_failed: rename EBUSY");
    };
    const res = await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    expect(res).toEqual({ applied: false, reason: "swap_failed" });
    expect(warned).toHaveLength(0);
  });

  // line 140 non-Error throw: throw a non-Error value → phase = "internal_error"
  it("returns internal_error and uses phase=internal_error when performUpgrade throws a non-Error value", async () => {
    const deps = baseDeps();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    deps.appendAudit = async (type, payload) => {
      audits.push({ type, payload });
    };
    deps.performUpgrade = async () => {
      const bad: unknown = "boom string, not an Error";
      throw bad;
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; reason?: string };
    expect(res).toEqual({ applied: false, reason: "internal_error" });
    expect(audits[0]?.type).toBe("extension.autoUpdate.failed");
    expect(audits[0]?.payload["phase"]).toBe("internal_error");
    expect(audits[0]?.payload["message"]).toBe("boom string, not an Error");
  });

  // lines 222-229 extractPhase: one row per branch, keyed off a keyword in the Error message —
  // plus the fall-through row whose message matches no known keyword.
  it.each([
    ["package_hash_mismatch: entry", "package_hash_mismatch"],
    ["package_hash_unreadable: manifest missing", "package_hash_unreadable"],
    ["signature_failed verification", "signature_failed"],
    ["swap_failed on disk", "swap_failed"],
    ["downgrade_unavailable", "downgrade_unavailable"],
    ["download timeout exceeded", "download_failed"],
    ["extract tarball failed", "extract_failed"],
    ["something completely unexpected", "internal_error"],
  ])("an error reading '%s' records phase=%s", async (message, phase) => {
    const deps = baseDeps();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    deps.appendAudit = async (type, payload) => {
      audits.push({ type, payload });
    };
    deps.performUpgrade = async () => {
      throw new Error(message);
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { reason?: string };
    expect(audits[0]?.payload["phase"]).toBe(phase);
    // The owner is told the same phase the audit row records.
    expect(res.reason).toBe(phase);
  });

  // Happy path audit: upgrade applied emits extension.autoUpdate.applied
  it("appends extension.autoUpdate.applied audit on successful upgrade", async () => {
    const deps = baseDeps();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    deps.appendAudit = async (type, payload) => {
      audits.push({ type, payload });
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    )) as { applied: boolean; jobId?: string };
    expect(res.applied).toBe(true);
    expect(res.jobId).toBeDefined();
    expect(audits[0]?.type).toBe("extension.autoUpdate.applied");
    expect(audits[0]?.payload["id"]).toBe("com.example.a");
    expect(audits[0]?.payload["channel"]).toBe("stable");
  });

  // Happy path audit: downgrade applied emits extension.downgrade.applied
  it("appends extension.downgrade.applied audit on successful downgrade", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.1.0";
    const cur = deps.cache.get("com.example.a")!;
    deps.cache.upsert({ ...cur, toVersion: "1.0.0", fromVersion: "1.1.0" });
    deps.hasPrevVersion = async () => true;
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    deps.appendAudit = async (type, payload) => {
      audits.push({ type, payload });
    };
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.0.0" },
      deps,
    )) as { applied: boolean; jobId?: string };
    expect(res.applied).toBe(true);
    expect(audits[0]?.type).toBe("extension.downgrade.applied");
    expect(audits[0]?.payload["id"]).toBe("com.example.a");
    expect(audits[0]?.payload["toVersion"]).toBe("1.0.0");
  });
});

// lines 188-192: extension.update branch + unknown method throw
describe("dispatchAutoUpdateRpc unknown method", () => {
  it("throws an error containing 'unknown method:' for an unrecognized method", async () => {
    const deps = baseDeps();
    await expect(dispatchAutoUpdateRpc("extension.bogus", {}, deps)).rejects.toThrow(
      /unknown method:/,
    );
  });
});

// extension.checkForUpdates with force=false (explicit false, not just absent)
describe("dispatchAutoUpdateRpc extension.checkForUpdates force=false", () => {
  it("does not call forcePoll when force is explicitly false", async () => {
    let pollCalled = false;
    const deps = baseDeps();
    deps.forcePoll = async () => {
      pollCalled = true;
    };
    await dispatchAutoUpdateRpc("extension.checkForUpdates", { force: false }, deps);
    expect(pollCalled).toBe(false);
  });
});

describe("dispatchAutoUpdateRpc extension.update — runGrantNote (extension runtime PR 3)", () => {
  async function askedPayload(hasRunGrant?: (id: string) => Promise<boolean>) {
    const deps = baseDeps();
    const asked: Array<Record<string, unknown>> = [];
    deps.gate = async (a) => {
      asked.push(a.payload);
      return { status: "rejected" };
    };
    if (hasRunGrant !== undefined) deps.hasRunGrant = hasRunGrant;
    await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    expect(asked).toHaveLength(1);
    return asked[0] ?? {};
  }

  it("carries the re-approve note when the extension holds a run grant", async () => {
    const p = await askedPayload(async (id) => id === "com.example.a");
    expect(p["runGrantNote"]).toBe(
      "Running the new version will need a new `nimbus extension approve com.example.a`.",
    );
  });

  it("an update that turns the extension into a starter pack says so, not approve", async () => {
    const deps = baseDeps();
    const cached = deps.cache.get("com.example.a");
    if (cached === undefined) throw new Error("fixture missing");
    deps.cache.upsert({ ...cached, toStarterPack: true });
    const asked: Array<Record<string, unknown>> = [];
    deps.gate = async (a) => {
      asked.push(a.payload);
      return { status: "rejected" };
    };
    deps.hasRunGrant = async () => true;
    await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    expect(asked[0]?.["runGrantNote"]).toBe(
      "The new version is a starter pack: it has no code to run, and its approval to run is removed.",
    );
  });

  it("the applied result says the grant was dropped, and the pack case says rootKind", async () => {
    const run = async (grant: boolean, pack: boolean) => {
      const deps = baseDeps();
      const cached = deps.cache.get("com.example.a");
      if (cached === undefined) throw new Error("fixture missing");
      if (pack) deps.cache.upsert({ ...cached, toStarterPack: true });
      deps.hasRunGrant = async () => grant;
      return (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: "com.example.a", toVersion: "1.1.0" },
        deps,
      )) as Record<string, unknown>;
    };
    const dropped = await run(true, false);
    expect(dropped["applied"]).toBe(true);
    expect(dropped["grantDropped"]).toBe(true);
    expect("rootKind" in dropped).toBe(false);
    const none = await run(false, false);
    expect("grantDropped" in none).toBe(false);
    const pack = await run(true, true);
    expect(pack["grantDropped"]).toBe(true);
    expect(pack["rootKind"]).toBe("starter-pack");
  });

  it("omits the note when there is no run grant, or no way to ask", async () => {
    expect("runGrantNote" in (await askedPayload(async () => false))).toBe(false);
    expect("runGrantNote" in (await askedPayload())).toBe(false);
  });
});

describe("the verified-publisher badge on updates (R6, trust layer PR 3c)", () => {
  const BADGE = { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" };

  async function askedPayload(deps: Deps): Promise<Record<string, unknown>> {
    const asked: Array<Record<string, unknown>> = [];
    deps.gate = async (a) => {
      asked.push(a.payload);
      return { status: "rejected" };
    };
    await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    return asked[0] ?? {};
  }

  it("the listing and the prompt carry the badge, computed at read time — never cached", async () => {
    const deps = baseDeps();
    let current: typeof BADGE | null = BADGE;
    deps.verifiedPublisherOf = () => current;
    const list = (await dispatchAutoUpdateRpc("extension.checkForUpdates", {}, deps)) as Array<{
      verifiedPublisher: unknown;
    }>;
    expect(list[0]?.verifiedPublisher).toEqual(BADGE);
    const p = await askedPayload(deps);
    expect(p["verifiedPublisher"]).toEqual(BADGE);
    expect(p["publisherBadge"]).toBe("Verified publisher: @acme-dev (verified 2026-10-20)");
    // The verification is replaced (or the key revoked) after detection: no re-detection needed.
    current = null;
    const after = (await dispatchAutoUpdateRpc("extension.checkForUpdates", {}, deps)) as Array<{
      verifiedPublisher: unknown;
    }>;
    expect(after[0]?.verifiedPublisher).toBeNull();
    expect((await askedPayload(deps))["publisherBadge"]).toBe("Unverified publisher");
    expect("verifiedPublisher" in (deps.cache.get("com.example.a") ?? {})).toBe(false);
  });

  it("no badge unless the update's signature verified", async () => {
    for (const status of ["signature_failed", "publisher_key_conflict"] as const) {
      const deps = baseDeps();
      const u = deps.cache.get("com.example.a");
      if (u === undefined) throw new Error("fixture");
      deps.cache.upsert({ ...u, verificationStatus: status, publisherStatus: "unverified" });
      deps.verifiedPublisherOf = () => BADGE;
      const list = (await dispatchAutoUpdateRpc("extension.checkForUpdates", {}, deps)) as Array<{
        verifiedPublisher: unknown;
      }>;
      expect(list[0]?.verifiedPublisher).toBeNull();
    }
  });

  it("the prompt carries the signature status, so the desktop labels the signature, not the publisher", async () => {
    expect((await askedPayload(baseDeps()))["verificationStatus"]).toBe("verified");
  });

  it("without a way to ask, an update is shown as from an unverified publisher", async () => {
    const p = await askedPayload(baseDeps());
    expect(p["verifiedPublisher"]).toBeNull();
    expect(p["publisherBadge"]).toBe("Unverified publisher");
  });
});

describe("the update approval lists what the update adds (extension dependencies PR 5)", () => {
  const DEP: AddedPackage = {
    id: "com.example.dep",
    version: "1.2.0",
    registry: "main",
    registryUrl: "https://main.test/",
  };
  const DEP_MANIFEST: Partial<ExtensionManifest> = {
    publisher: { id: "acme", key: "AAAA" },
    permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
    requires: { connectors: ["github"] },
  };
  const GITHUB: ConnectorRequirementStatus = {
    connector: "github",
    state: "not_connected",
    owner: { kind: "bundled" },
    fix: ["nimbus connector auth github"],
    interactive: true,
    requiredBy: ["com.example.dep"],
  };
  const NEEDS = "Needs:\n  github: not connected — run: nimbus connector auth github";

  /** A bag whose only installed extension is the root at 1.0.0; `asked` records each approval. */
  function depsAdding(plan: UpdatePlan): Deps & { asked: Array<Record<string, unknown>> } {
    const asked: Array<Record<string, unknown>> = [];
    return {
      ...baseDeps(),
      getInstalledVersion: async (id: string) => (id === "com.example.a" ? "1.0.0" : null),
      planUpdate: async () => plan,
      gate: async (a) => {
        asked.push(a.payload);
        return "proceed" as const;
      },
      asked,
    };
  }

  function update(deps: Deps): Promise<Record<string, unknown>> {
    return dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    ) as Promise<Record<string, unknown>>;
  }

  it("an update adding packages shows them in the approval before anything is fetched", async () => {
    const plan = fakePlan([DEP], { [DEP.id]: DEP_MANIFEST });
    const deps = depsAdding(plan);
    const performUpgrade = mock(async (_u: AvailableUpdate, _p: UpdatePlan) => ({
      orphanedDependencies: [],
    }));
    deps.performUpgrade = performUpgrade;
    deps.gate = async (a) => {
      deps.asked.push(a.payload);
      // Asked first: nothing of the update has been fetched or applied yet.
      expect(performUpgrade).not.toHaveBeenCalled();
      return "proceed" as const;
    };
    const res = await update(deps);
    const p = deps.asked[0] ?? {};
    expect(p["addedPackages"]).toEqual([
      {
        id: DEP.id,
        version: "1.2.0",
        requiredBy: [{ from: "com.example.a", range: "^1.0.0" }],
        registry: "main",
        registryUrl: "https://main.test/",
        publisher: { id: "acme", fingerprint: expect.any(String) },
        permissions: DEP_MANIFEST.permissions,
        newlyInstalled: true,
        kind: "extension",
      },
    ]);
    expect(p["planPermissions"]).toEqual({
      network: ["api.example.com"],
      filesystem: { read: [], write: [] },
    });
    expect(String(p["planText"])).toStartWith("This update adds 1 package(s):\n");
    expect(String(p["planText"])).toContain("com.example.dep@1.2.0");
    // The plan the owner approved is the one the apply gets.
    expect(performUpgrade.mock.calls[0]?.[1]).toBe(plan);
    expect(res).toMatchObject({
      applied: true,
      addedPackages: [{ id: DEP.id, version: "1.2.0", registry: "main", kind: "extension" }],
    });
  });

  it("the update approval shows the new connector requirement", async () => {
    const plan = fakePlan([DEP], { [DEP.id]: DEP_MANIFEST });
    const deps = depsAdding(plan);
    const seen: UpdatePlan[] = [];
    deps.updateRequirements = async (_cached, p) => {
      seen.push(p);
      return [GITHUB];
    };
    const res = await update(deps);
    const p = deps.asked[0] ?? {};
    expect(seen).toEqual([plan]);
    expect(p["connectorRequirements"]).toEqual([GITHUB]);
    expect(String(p["planText"])).toEndWith(NEEDS);
    expect(res["connectorRequirements"]).toEqual([GITHUB]);
  });

  it("a new requirement on the root alone is a Needs block with no package list", async () => {
    const deps = depsAdding(fakePlan());
    deps.updateRequirements = async () => [{ ...GITHUB, requiredBy: ["com.example.a"] }];
    await update(deps);
    const p = deps.asked[0] ?? {};
    expect("addedPackages" in p).toBe(false);
    expect(p["planText"]).toBe(NEEDS);
  });

  it("requirement status that cannot be computed never refuses the update", async () => {
    const deps = depsAdding(fakePlan([DEP], { [DEP.id]: DEP_MANIFEST }));
    deps.updateRequirements = async () => {
      throw new Error("vault locked");
    };
    const res = await update(deps);
    expect(res["applied"]).toBe(true);
    expect("connectorRequirements" in (deps.asked[0] ?? {})).toBe(false);
  });

  it("an update that adds nothing asks exactly as before", async () => {
    const deps = depsAdding(fakePlan());
    deps.updateRequirements = async () => [];
    const res = await update(deps);
    const p = deps.asked[0] ?? {};
    for (const k of ["addedPackages", "planPermissions", "planText", "connectorRequirements"]) {
      expect(k in p).toBe(false);
    }
    expect(res).toEqual({ applied: true, jobId: "d".repeat(16) });
  });

  it("a planning conflict refuses before the gate with update_conflicts", async () => {
    const deps = depsAdding(fakePlan());
    deps.planUpdate = async () => {
      throw new DependencyConflictError({
        kind: "unsatisfiable",
        id: "com.example.dep",
        constraints: [{ from: "com.example.user", range: "~1.0.0" }],
        availableVersions: ["2.0.0"],
      });
    };
    const performUpgrade = mock(async () => ({ orphanedDependencies: [] }));
    deps.performUpgrade = performUpgrade;
    const res = await update(deps);
    expect(res["applied"]).toBe(false);
    expect(res["reason"]).toBe("update_conflicts");
    expect(String(res["hint"])).toStartWith("update_conflicts: ");
    expect(String(res["hint"])).toContain("~1.0.0");
    expect(String(res["hint"])).not.toContain("\n");
    expect(deps.asked).toHaveLength(0);
    expect(performUpgrade).not.toHaveBeenCalled();
  });

  it("a dependency naming an unadded registry refuses with its code", async () => {
    const deps = depsAdding(fakePlan());
    deps.planUpdate = async () => {
      throw new RegistryError(
        "ERR_DEPENDENCY_REGISTRY_NOT_ADDED",
        "com.example.dep names https://elsewhere.test/, which is not added; run: nimbus registry add",
      );
    };
    const res = await update(deps);
    expect(res["reason"]).toBe("update_conflicts");
    expect(String(res["hint"])).toContain("ERR_DEPENDENCY_REGISTRY_NOT_ADDED");
    expect(deps.asked).toHaveLength(0);
  });

  it("a package the plan adds without a verified manifest refuses: the approval never understates", async () => {
    const deps = depsAdding(fakePlan([DEP]));
    const res = await update(deps);
    expect(res["reason"]).toBe("update_conflicts");
    expect(String(res["hint"])).toContain("com.example.dep@1.2.0");
    expect(deps.asked).toHaveLength(0);
  });

  it("a starter pack the update adds is shown with its kind", async () => {
    const pack = { ...DEP_MANIFEST, kind: "starter-pack" } as Partial<ExtensionManifest>;
    const deps = depsAdding(fakePlan([DEP], { [DEP.id]: pack }));
    const res = await update(deps);
    const shown = deps.asked[0]?.["addedPackages"] as Array<{ kind: string }>;
    expect(shown[0]?.kind).toBe("starter-pack");
    expect(res["addedPackages"]).toEqual([
      { id: DEP.id, version: "1.2.0", registry: "main", kind: "starter-pack" },
    ]);
  });

  it("no approval field name is one the consent redactor hides", async () => {
    const deps = depsAdding(fakePlan([DEP], { [DEP.id]: DEP_MANIFEST }));
    deps.updateRequirements = async () => [GITHUB];
    await update(deps);
    const names: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
      } else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          names.push(k);
          walk(x);
        }
      }
    };
    const p = deps.asked[0] ?? {};
    walk({
      addedPackages: p["addedPackages"],
      planPermissions: p["planPermissions"],
      connectorRequirements: p["connectorRequirements"],
    });
    expect(names.length).toBeGreaterThan(5);
    const redacted = names.filter((n) =>
      /(token|key|secret|password|credential|bearer|auth)/i.test(n),
    );
    expect(redacted).toEqual([]);
  });

  it("a downgrade is never planned", async () => {
    const deps = depsAdding(fakePlan());
    const planUpdate = mock(async () => fakePlan());
    deps.planUpdate = planUpdate;
    deps.getInstalledVersion = async () => "1.2.0";
    deps.hasPrevVersion = async () => true;
    await update(deps);
    expect(planUpdate).not.toHaveBeenCalled();
    expect("planText" in (deps.asked[0] ?? {})).toBe(false);
  });

  it("the installed version moved between the gate and the apply: cache_miss, nothing applied", async () => {
    const deps = depsAdding(fakePlan([DEP], { [DEP.id]: DEP_MANIFEST }));
    deps.gate = async () => {
      deps.getInstalledVersion = async (id: string) => (id === "com.example.a" ? "1.0.5" : null);
      return "proceed" as const;
    };
    const performUpgrade = mock(async () => ({ orphanedDependencies: [] }));
    deps.performUpgrade = performUpgrade;
    expect(await update(deps)).toEqual({ applied: false, reason: "cache_miss" });
    expect(performUpgrade).not.toHaveBeenCalled();
  });

  it("an added package installed since the gate: cache_miss, nothing applied", async () => {
    const deps = depsAdding(fakePlan([DEP], { [DEP.id]: DEP_MANIFEST }));
    deps.gate = async () => {
      deps.getInstalledVersion = async (id: string) => {
        if (id === "com.example.a") return "1.0.0";
        return id === DEP.id ? "1.2.0" : null;
      };
      return "proceed" as const;
    };
    const performUpgrade = mock(async () => ({ orphanedDependencies: [] }));
    deps.performUpgrade = performUpgrade;
    expect(await update(deps)).toEqual({ applied: false, reason: "cache_miss" });
    expect(performUpgrade).not.toHaveBeenCalled();
  });

  it("the installed version is no longer the update's fromVersion: cache_miss before the prompt", async () => {
    const deps = depsAdding(fakePlan([DEP], { [DEP.id]: DEP_MANIFEST }));
    // Not the version the update was detected from: its rollback target (`prev/<fromVersion>`)
    // would name the wrong version, so the owner is never asked about it.
    deps.getInstalledVersion = async (id: string) => (id === "com.example.a" ? "1.0.5" : null);
    let gated = 0;
    deps.gate = async () => {
      gated++;
      return "proceed" as const;
    };
    const performUpgrade = mock(async () => ({ orphanedDependencies: [] }));
    deps.performUpgrade = performUpgrade;
    expect(await update(deps)).toEqual({ applied: false, reason: "cache_miss" });
    expect(gated).toBe(0);
    expect(performUpgrade).not.toHaveBeenCalled();
  });

  describe("an installed package the plan relies on", () => {
    const LIB = { id: "com.example.lib", version: "2.0.0" };
    /** A plan that adds DEP and relies on LIB, installed at 2.0.0 when it was solved. */
    function planRelyingOnLib(): UpdatePlan {
      const base = fakePlan([DEP], { [DEP.id]: DEP_MANIFEST });
      const lib = { ...LIB, source: null, newlyInstalled: false, deps: [] };
      return {
        ...base,
        plan: { ...base.plan, nodes: [lib, ...base.plan.nodes] } as UpdatePlan["plan"],
      };
    }
    function relyingDeps(libAfterGate: string | null) {
      const deps = depsAdding(planRelyingOnLib());
      const at = (lib: string | null) => async (id: string) => {
        if (id === "com.example.a") return "1.0.0";
        return id === LIB.id ? lib : null;
      };
      deps.getInstalledVersion = at(LIB.version);
      deps.gate = async () => {
        deps.getInstalledVersion = at(libAfterGate);
        return "proceed" as const;
      };
      return deps;
    }

    it("still installed at the planned version: applied", async () => {
      const deps = relyingDeps(LIB.version);
      expect(await update(deps)).toMatchObject({ applied: true });
      expect(deps.performUpgrade).toHaveBeenCalled();
    });

    for (const [label, after] of [
      ["removed", null],
      ["moved to another version", "2.1.0"],
    ] as const) {
      it(`${label} since the gate: cache_miss, nothing applied`, async () => {
        const deps = relyingDeps(after);
        const performUpgrade = mock(async () => ({ orphanedDependencies: [] }));
        deps.performUpgrade = performUpgrade;
        expect(await update(deps)).toEqual({ applied: false, reason: "cache_miss" });
        expect(performUpgrade).not.toHaveBeenCalled();
      });
    }
  });

  it("an update that dropped a dependency reports the orphan it left", async () => {
    const deps = depsAdding(fakePlan());
    deps.performUpgrade = async () => ({ orphanedDependencies: ["dep.old", "dep.old.child"] });
    expect(await update(deps)).toMatchObject({
      applied: true,
      orphanedDependencies: ["dep.old", "dep.old.child"],
    });
  });
});

describe("the update approval states reach and the file outcome", () => {
  const evidence = (text: string) => ({
    networkReach: text,
    fileAccess: "reads none · writes none",
    canRunHere: true,
    checked: true,
  });

  async function ask(
    deps: Deps,
    params: Record<string, unknown> = { id: "com.example.a", toVersion: "1.1.0" },
  ): Promise<Record<string, unknown> | undefined> {
    let payload: Record<string, unknown> | undefined;
    const gate = deps.gate;
    deps.gate = async (a) => {
      payload = a.payload;
      return gate(a);
    };
    await dispatchAutoUpdateRpc("extension.update", params, deps);
    return payload;
  }

  it("the reach covers the version after the diff, and the plan's added permissions", async () => {
    const deps = baseDeps();
    const seen: Array<[AvailableUpdate, unknown]> = [];
    deps.updateAccess = (cached, added) => {
      seen.push([cached, added]);
      return evidence("network access to b.com");
    };
    const payload = await ask(deps);
    expect(payload?.["networkReach"]).toBe("network access to b.com");
    expect(payload?.["fileAccess"]).toBe("reads none · writes none");
    expect(seen[0]?.[1]).toBeUndefined();
  });

  it("the payload's field set is the one the desktop preview fixture is built from", async () => {
    const deps = baseDeps();
    deps.updateAccess = () => evidence("network access to b.com");
    const payload = await ask(deps);
    // `packages/ui/test/components/hitl/StructuredPreview.test.tsx` builds its update fixture
    // from these keys: a change here means that fixture must change with it.
    expect(Object.keys(payload ?? {}).sort()).toEqual(
      [
        "addedPermissions",
        "changelog",
        "channel",
        "displayName",
        "fileAccess",
        "fromVersion",
        "id",
        "manifestHash",
        "networkReach",
        "publisherBadge",
        "publisherStatus",
        "removedPermissions",
        "rootFingerprint",
        "signatureB64",
        "sourceRegistry",
        "toVersion",
        "verificationStatus",
        "verifiedPublisher",
      ].sort(),
    );
  });

  it("an update that adds packages hands their union to updateAccess", async () => {
    const deps = baseDeps();
    deps.planUpdate = async () =>
      fakePlan(
        [
          {
            id: "com.example.dep",
            version: "1.0.0",
            registry: "main",
            registryUrl: "u",
          } as AddedPackage,
        ],
        {
          "com.example.dep": {
            permissions: { network: ["dep.com"], filesystem: { read: [], write: [] } },
          },
        },
      );
    let added: unknown;
    deps.updateAccess = (_c, a) => {
      added = a;
      return evidence("x");
    };
    await ask(deps);
    expect(added).toEqual({ network: ["dep.com"], filesystem: { read: [], write: [] } });
  });

  it("downgrade carries it too", async () => {
    const deps = baseDeps();
    deps.getInstalledVersion = async () => "1.2.0";
    deps.hasPrevVersion = async () => true;
    let type: string | undefined;
    const gate = deps.gate;
    deps.gate = async (a) => {
      type = a.type;
      expect(a.payload["networkReach"]).toBe("network access to b.com");
      return gate(a);
    };
    deps.updateAccess = () => evidence("network access to b.com");
    await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.1.0" },
      deps,
    );
    expect(type).toBe("extension.downgrade");
  });

  it("an unreadable installed manifest states so and never fails the approval", async () => {
    const deps = baseDeps();
    deps.updateAccess = () => undefined;
    const payload = await ask(deps);
    expect(payload?.["networkReach"]).toBe(
      "not known here (the installed manifest could not be read)",
    );
    expect(payload?.["fileAccess"]).toBe(
      "not known here (the installed manifest could not be read)",
    );
  });

  it("a throwing updateAccess is the same as an unreadable manifest", async () => {
    const deps = baseDeps();
    deps.updateAccess = () => {
      throw new Error("boom");
    };
    const payload = await ask(deps);
    expect(String(payload?.["networkReach"])).toContain("could not be read");
  });
});
