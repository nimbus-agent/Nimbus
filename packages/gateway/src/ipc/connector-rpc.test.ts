import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ProbeVerdict } from "../connectors/credential-probe.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchConnectorRpc } from "./connector-rpc.ts";
import { handleConnectorAuth } from "./connector-rpc-handlers/auth.ts";
import type { ConnectorRpcHandlerContext } from "./connector-rpc-handlers/context.ts";
import { ConnectorRpcError } from "./connector-rpc-shared.ts";

function makeIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  db.run(
    `INSERT INTO scheduler_state
       (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
     VALUES ('github', NULL, 60000, NULL, ?, 'ok', NULL, 0, 0)`,
    [Date.now()],
  );
  return idx;
}

/** A minimal `ConnectorRpcHandlerContext`, overridable per test. */
function baseCtx(overrides: Partial<ConnectorRpcHandlerContext> = {}): ConnectorRpcHandlerContext {
  return {
    rec: undefined,
    vault: {} as unknown as NimbusVault,
    localIndex: makeIndex(),
    openUrl: async (_url: string): Promise<void> => {},
    syncScheduler: undefined,
    connectorMesh: undefined,
    ...overrides,
  };
}

function fakeLocalIndex(opts: { onReauth?: (id: string) => void } = {}): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return {
    ensureConnectorSchedulerRegistration: () => {},
    markConnectorReauthenticated: (id: string) => opts.onReauth?.(id),
    getDatabase: () => db,
  } as unknown as LocalIndex;
}

/** A vault whose `set` calls are recorded by key, so a test can assert what was stored. */
function recordingVault(writes: string[]): NimbusVault {
  return {
    set: async (k: string) => {
      writes.push(k);
    },
    get: async () => null,
    delete: async () => {},
    listKeys: async () => [],
  } as unknown as NimbusVault;
}

/** Records probe and vault events into one ordered log. */
function seqHarness() {
  const seq: string[] = [];
  return {
    seq,
    vault: {
      set: async (k: string) => {
        seq.push(`write:${k}`);
      },
      get: async () => null,
      delete: async (k: string) => {
        seq.push(`delete:${k}`);
      },
    } as unknown as NimbusVault,
    probe: (verdict: ProbeVerdict) => async () => {
      seq.push("probe");
      return verdict;
    },
  };
}

const baseOpts = {
  vault: {} as unknown as NimbusVault,
  openUrl: async (_url: string): Promise<void> => {},
  syncScheduler: undefined,
} as const;

describe("connector.setConfig", () => {
  test("returns miss for unknown method", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.unknown",
      params: {},
    });
    expect(r.kind).toBe("miss");
  });

  test("sets intervalMs only", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 120000 },
    });
    expect(r.kind).toBe("hit");
    const v = (
      r as {
        kind: "hit";
        value: { service: string; intervalMs: number | null; enabled: boolean | null };
      }
    ).value;
    expect(v.service).toBe("github");
    expect(v.intervalMs).toBe(120000);
    expect(v.enabled).toBeNull();
  });

  test("sets enabled=false only (pause)", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", enabled: false },
    });
    expect(r.kind).toBe("hit");
    const v = (
      r as {
        kind: "hit";
        value: { service: string; intervalMs: number | null; enabled: boolean | null };
      }
    ).value;
    expect(v.service).toBe("github");
    expect(v.intervalMs).toBeNull();
    expect(v.enabled).toBe(false);
  });

  test("sets intervalMs and enabled=true together", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 120000, enabled: true },
    });
    expect(r.kind).toBe("hit");
    const v = (
      r as {
        kind: "hit";
        value: { service: string; intervalMs: number | null; enabled: boolean | null };
      }
    ).value;
    expect(v.service).toBe("github");
    expect(v.intervalMs).toBe(120000);
    expect(v.enabled).toBe(true);
  });

  test("rejects missing serviceId", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: {},
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("rejects unregistered serviceId", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: { serviceId: "slack" },
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("rejects invalid intervalMs (zero)", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: { serviceId: "github", intervalMs: 0 },
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("rejects invalid intervalMs (non-finite)", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: { serviceId: "github", intervalMs: Number.POSITIVE_INFINITY },
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("floors fractional intervalMs", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 90000.9 },
    });
    expect(r.kind).toBe("hit");
    const v = (r as { kind: "hit"; value: { intervalMs: number | null } }).value;
    expect(v.intervalMs).toBe(90000);
  });

  test("delegates to syncScheduler.setInterval and resume when provided", async () => {
    const calls: string[] = [];
    const syncScheduler = {
      setInterval: (id: string, ms: number) => {
        calls.push(`setInterval:${id}:${ms}`);
      },
      pause: (id: string) => {
        calls.push(`pause:${id}`);
      },
      resume: (id: string) => {
        calls.push(`resume:${id}`);
      },
    } as never;
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      syncScheduler,
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 60000, enabled: true },
    });
    expect(r.kind).toBe("hit");
    expect(calls).toContain("setInterval:github:60000");
    expect(calls).toContain("resume:github");
  });

  test("delegates to syncScheduler.pause when enabled=false", async () => {
    const calls: string[] = [];
    const syncScheduler = {
      setInterval: (_id: string, _ms: number) => {},
      pause: (id: string) => {
        calls.push(`pause:${id}`);
      },
      resume: (_id: string) => {},
    } as never;
    await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      syncScheduler,
      method: "connector.setConfig",
      params: { serviceId: "github", enabled: false },
    });
    expect(calls).toContain("pause:github");
  });
});

describe("connector.startAuth deprecated alias — REMOVED (2026-09-10)", () => {
  // The alias shipped in S4-F2 with a note that it would be deleted "in Phase 5 once the desktop
  // UI has migrated entirely to connector.auth". Phases 5 and 6 both closed with it still routing.
  // It is gone now, and gone means it dispatches like any other unknown method: a `miss`, which
  // the server turns into -32601. Asserting `miss` rather than `rejects` is the point — an alias
  // that threw a connector-shaped error would be indistinguishable from one still wired up.
  test("connector.startAuth is no longer routed and returns a miss", async () => {
    const idx = makeIndex();
    const gone = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: idx,
      method: "connector.startAuth",
      params: { service: "totally-not-a-real-connector" },
    });
    expect(gone.kind).toBe("miss");
  });

  test("connector.auth itself still routes to the auth handler", async () => {
    const idx = makeIndex();
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: idx,
        method: "connector.auth",
        params: { service: "totally-not-a-real-connector" },
      }),
    ).rejects.toBeDefined();
  });

  test("an unknown connector method returns a miss too", async () => {
    const idx = makeIndex();
    const miss = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: idx,
      method: "connector.unknownMethod",
      params: {},
    });
    expect(miss.kind).toBe("miss");
  });
});

describe("connector.auth — credential probe runs before any Vault write", () => {
  test("a rejected credential writes NOTHING to the vault and throws", async () => {
    const h = seqHarness();
    await expect(
      handleConnectorAuth({
        ...baseCtx({ vault: h.vault }),
        rec: { service: "github", token: "dead-pat" },
        runCredentialProbe: h.probe({ kind: "rejected", httpStatus: 401 }),
      }),
    ).rejects.toThrow(/github/);
    // The point of probing BEFORE writing: a typo'd token must not clobber a
    // working stored credential on the way to being rejected.
    expect(h.seq).toEqual(["probe"]);
  });

  test("gitlab: a rejected credential writes NOTHING — including no api_base delete", async () => {
    const h = seqHarness();
    await expect(
      handleConnectorAuth({
        ...baseCtx({ vault: h.vault }),
        rec: { service: "gitlab", token: "x" },
        runCredentialProbe: h.probe({ kind: "rejected", httpStatus: 401 }),
      }),
    ).rejects.toThrow(/gitlab/);
    // Proves neither writeConnectorSecret(pat) NOR the api_base
    // delete/write branch ran ahead of a non-rejecting verdict.
    expect(h.seq).toEqual(["probe"]);
  });

  test("jenkins: a rejected credential writes NOTHING to the vault", async () => {
    const h = seqHarness();
    await expect(
      handleConnectorAuth({
        ...baseCtx({ vault: h.vault }),
        rec: {
          service: "jenkins",
          token: "x",
          username: "u",
          apiBaseUrl: "https://ci.example.com",
        },
        runCredentialProbe: h.probe({ kind: "rejected", httpStatus: 401 }),
      }),
    ).rejects.toThrow(/jenkins/);
    // Three writes (base_url, username, api_token) all guarded by the same
    // pre-write probe.
    expect(h.seq).toEqual(["probe"]);
  });

  test("bitbucket: a rejected credential writes NOTHING to the vault", async () => {
    const h = seqHarness();
    await expect(
      handleConnectorAuth({
        ...baseCtx({ vault: h.vault }),
        rec: {
          service: "bitbucket",
          bitbucketUsername: "u",
          token: "x",
        },
        runCredentialProbe: h.probe({ kind: "rejected", httpStatus: 401 }),
      }),
    ).rejects.toThrow(/bitbucket/);
    // Two writes (username, app_password) both guarded by the same pre-write probe.
    expect(h.seq).toEqual(["probe"]);
  });

  test("jira: a rejected credential writes NOTHING to the vault", async () => {
    const h = seqHarness();
    await expect(
      handleConnectorAuth({
        ...baseCtx({ vault: h.vault }),
        rec: {
          service: "jira",
          atlassianEmail: "e@example.com",
          token: "x",
          apiBaseUrl: "https://jira.example.com",
        },
        runCredentialProbe: h.probe({ kind: "rejected", httpStatus: 401 }),
      }),
    ).rejects.toThrow(/jira/);
    // jira's writes go through registerAtlassianApiConnectorAuth (email, api_token,
    // base_url) rather than inline writeConnectorSecret calls — proves the probe
    // guard holds even through that different write path.
    expect(h.seq).toEqual(["probe"]);
  });

  test("on the VALID path the probe still runs before any write", async () => {
    const h = seqHarness();
    const reauthed: string[] = [];
    const hit = await handleConnectorAuth({
      ...baseCtx({
        vault: h.vault,
        localIndex: fakeLocalIndex({ onReauth: (id) => reauthed.push(id) }),
      }),
      rec: { service: "github", token: "good-pat" },
      runCredentialProbe: h.probe({ kind: "valid" }),
    });
    // Ordering, not just presence: an empty-writes assertion cannot cover this
    // path, because here the writes are supposed to happen.
    expect(h.seq[0]).toBe("probe");
    expect(h.seq).toContain("write:github.pat");
    expect(reauthed).toEqual(["github"]);
    expect((hit.value as { verified: string }).verified).toBe("verified");
  });

  test("an unconfirmed provider stores but does NOT clear health", async () => {
    const writes: string[] = [];
    const reauthed: string[] = [];
    const hit = await handleConnectorAuth({
      ...baseCtx({
        vault: recordingVault(writes),
        localIndex: fakeLocalIndex({ onReauth: (id) => reauthed.push(id) }),
      }),
      rec: { service: "github", token: "maybe-good" },
      runCredentialProbe: async () => ({ kind: "unconfirmed" }),
    });
    expect(writes).toContain("github.pat");
    // No evidence the credential works — inventing some is the defect being fixed.
    expect(reauthed).toEqual([]);
    expect((hit.value as { verified: string }).verified).toBe("unverified");
  });

  test("a service with no probe stores and reports verified: null", async () => {
    const writes: string[] = [];
    const hit = await handleConnectorAuth({
      ...baseCtx({ vault: recordingVault(writes) }),
      rec: { service: "pagerduty", token: "tok" },
    });
    expect(writes).toContain("pagerduty.api_token");
    expect((hit.value as { verified: string | null }).verified).toBeNull();
  });
});

describe("connector.detectLocalAuth / connector.adoptLocalAuth routing", () => {
  test("adoptLocalAuth without a toolExecutor is an internal error, never an ungated write", async () => {
    await expect(
      dispatchConnectorRpc({
        method: "connector.adoptLocalAuth",
        params: { source: "aws", profile: "dev" },
        vault: createMockVault(),
        localIndex: makeIndex(),
        openUrl: async () => {},
        syncScheduler: undefined,
      }),
    ).rejects.toThrow(/requires a toolExecutor/);
  });

  test("detectLocalAuth rejects an unknown source before touching the host", async () => {
    await expect(
      dispatchConnectorRpc({
        method: "connector.detectLocalAuth",
        params: { sources: ["svn"] },
        vault: createMockVault(),
        localIndex: makeIndex(),
        openUrl: async () => {},
        syncScheduler: undefined,
      }),
    ).rejects.toThrow(/sources must be an array/);
  });

  test("detectLocalAuth with a valid source reaches the real detector and returns one finding", async () => {
    // No unit test elsewhere drives `detectLocalAuth` THROUGH the real dispatcher — every other
    // test either throws before this line (above) or exercises `detectLocalAuth` directly,
    // bypassing routing entirely. `detectAws` never throws (an absent/misconfigured CLI is a
    // valid `status`, not an error), so this is deterministic on every machine and OS regardless
    // of whether the aws CLI is actually installed here — only the finding's `status` varies,
    // which this test does not assert on.
    const hit = await dispatchConnectorRpc({
      method: "connector.detectLocalAuth",
      params: { sources: ["aws"] },
      vault: createMockVault(),
      localIndex: makeIndex(),
      openUrl: async () => {},
      syncScheduler: undefined,
    });
    expect(hit.kind).toBe("hit");
    const value = (hit as { kind: "hit"; value: unknown }).value;
    expect(Array.isArray(value)).toBe(true);
    const findings = value as Array<{ source: string }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.source).toBe("aws");
  });

  test("adoptLocalAuth with a toolExecutor reaches real target resolution and refuses cleanly", async () => {
    // Same gap as above, mirrored for adopt: no test reaches past the toolExecutor-undefined
    // check into the real `adoptLocalAuth` call. Forcing PATH empty makes every local CLI report
    // "not found" DETERMINISTICALLY — the same technique the CI-env isolation fix in
    // packages/cli/src/commands/init.test.ts uses — so this does not depend on whether THIS
    // machine (dev box or CI runner) happens to have a working aws/gh/kubectl login configured.
    const prevPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const toolExecutor = {
        gate: async () => "proceed" as const,
      } as unknown as ToolExecutor;
      await expect(
        dispatchConnectorRpc({
          method: "connector.adoptLocalAuth",
          params: { source: "aws" },
          vault: createMockVault(),
          localIndex: makeIndex(),
          openUrl: async () => {},
          syncScheduler: undefined,
          toolExecutor,
        }),
      ).rejects.toThrow(/ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE/);
    } finally {
      if (prevPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = prevPath;
    }
  });
});
