import { beforeEach, describe, expect, it, mock } from "bun:test";

import { AutoUpdateCache } from "./auto-update-cache.ts";
import { _resetAutoUpdateMutexForTests, dispatchAutoUpdateRpc } from "./auto-update-rpc.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";

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
    performUpgrade: mock(async () => {}),
    performDowngrade: mock(async () => {}),
    appendAudit: async () => {},
    getInstalledVersion: async () => "1.0.0",
    hasPrevVersion: async () => false,
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
    const performUpgrade = mock(async () => {});
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
    const performDowngrade = mock(async () => {});
    deps.performDowngrade = performDowngrade;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: "com.example.a", toVersion: "1.0.0" },
      deps,
    )) as { applied: boolean };
    expect(performDowngrade).toHaveBeenCalled();
    expect(res.applied).toBe(true);
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

  it("omits the note when there is no run grant, or no way to ask", async () => {
    expect("runGrantNote" in (await askedPayload(async () => false))).toBe(false);
    expect("runGrantNote" in (await askedPayload())).toBe(false);
  });
});
