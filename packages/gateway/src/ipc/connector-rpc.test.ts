import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ProbeVerdict } from "../connectors/credential-probe.ts";
import { LocalIndex } from "../index/local-index.ts";
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
  return {
    ensureConnectorSchedulerRegistration: () => {},
    markConnectorReauthenticated: (id: string) => opts.onReauth?.(id),
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

describe("connector.startAuth deprecated alias (S4-F2)", () => {
  test("connector.startAuth dispatches to the same handler as connector.auth", async () => {
    const baseLocalIndex = makeIndex();
    const start = dispatchConnectorRpc({
      ...baseOpts,
      localIndex: baseLocalIndex,
      method: "connector.startAuth",
      params: { service: "totally-not-a-real-connector" },
    });
    const auth = dispatchConnectorRpc({
      ...baseOpts,
      localIndex: baseLocalIndex,
      method: "connector.auth",
      params: { service: "totally-not-a-real-connector" },
    });
    let startErr: unknown;
    let authErr: unknown;
    try {
      await start;
    } catch (e) {
      startErr = e;
    }
    try {
      await auth;
    } catch (e) {
      authErr = e;
    }
    expect(startErr).toBeDefined();
    expect(authErr).toBeDefined();
    expect((startErr as Error).constructor.name).toBe((authErr as Error).constructor.name);
    expect((startErr as Error).message).toBe((authErr as Error).message);
  });

  test("connector.unknown returns miss; connector.startAuth does not", async () => {
    const idx = makeIndex();
    const miss = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: idx,
      method: "connector.unknownMethod",
      params: {},
    });
    expect(miss.kind).toBe("miss");
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: idx,
        method: "connector.startAuth",
        params: {},
      }),
    ).rejects.toBeDefined();
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
