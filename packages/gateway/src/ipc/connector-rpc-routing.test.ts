import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolExecutor } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { ConnectorRpcError, dispatchConnectorRpc } from "./connector-rpc.ts";

let db: Database;
let localIndex: LocalIndex;
let vault: NimbusVault;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  localIndex.ensureConnectorSchedulerRegistration("github", 60_000, 1_700_000_000_000);
  vault = createMockVault();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

type GateResult =
  | "proceed"
  | { status: "rejected"; reason: string }
  | { status: "deferred"; reason: string };

/**
 * Records the FULL gate action, payload included.
 *
 * This stub used to keep only `{ type }`, which is exactly how #808 survived:
 * both gated methods built their payload from parameter keys no caller sends,
 * and every assertion here looked past the field that was empty. The payload is
 * not decoration — `executor.gate()` feeds the same object to the consent
 * prompt, the audit row (`auditPayload`) and the I29 egress-ledger row, so an
 * empty payload means the owner authorizes, and the ledger attests to, nothing
 * identifiable.
 */
function makeStubExecutor(gateResult: GateResult): {
  exec: ToolExecutor;
  calls: Array<{ type: string; payload: unknown }>;
} {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const exec = {
    async gate(args: { type: string; payload?: unknown }): Promise<GateResult> {
      calls.push({ type: args.type, payload: args.payload });
      return gateResult;
    },
  } as unknown as ToolExecutor;
  return { exec, calls };
}

function baseOpts(extras: {
  toolExecutor?: ToolExecutor;
  syncScheduler?: { register: (s: { serviceId: string }) => void } | undefined;
  connectorMesh?: {
    ensureUserMcpRunning: (id: string) => Promise<void>;
    userMcpProtectedRoots?: () => readonly string[];
  };
}) {
  return {
    vault,
    localIndex,
    openUrl: async (_u: string): Promise<void> => {},
    syncScheduler: extras.syncScheduler as never,
    ...(extras.connectorMesh === undefined ? {} : { connectorMesh: extras.connectorMesh as never }),
    ...(extras.toolExecutor === undefined ? {} : { toolExecutor: extras.toolExecutor }),
  };
}

describe("dispatchConnectorRpc — addMcp gate", () => {
  /** Fake PATH/filesystem: nothing real is consulted. Full resolution coverage: connector-rpc-addmcp.test.ts. */
  const seams = {
    resolveCommand: (c: string) => `/opt/bin/${c}`,
    realpath: (p: string) => p,
  };
  const wired = () => ({
    syncScheduler: { register: () => {} },
    connectorMesh: { ensureUserMcpRunning: async () => {}, userMcpProtectedRoots: () => [] },
  });

  test("addMcp without toolExecutor -> -32603", async () => {
    try {
      await dispatchConnectorRpc({
        ...baseOpts({}),
        method: "connector.addMcp",
        params: { serviceId: "mcp_x", commandLine: "echo" },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorRpcError);
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
    }
  });

  test("addMcp with rejected gate returns the gate result without dispatching", async () => {
    const { exec, calls } = makeStubExecutor({ status: "rejected", reason: "user declined" });
    const r = await dispatchConnectorRpc({
      ...baseOpts({ toolExecutor: exec, ...wired() }),
      ...seams,
      method: "connector.addMcp",
      params: { serviceId: "mcp_blocked", commandLine: "echo hi" },
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ status: "rejected", reason: "user declined" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("connector.addMcp");
    const row = db
      .query("SELECT service_id FROM user_mcp_connector WHERE service_id = ?")
      .get("mcp_blocked");
    expect(row).toBeNull();
  });

  test("addMcp with proceed dispatches to handleConnectorAddMcp", async () => {
    const { exec } = makeStubExecutor("proceed");
    const r = await dispatchConnectorRpc({
      ...baseOpts({ toolExecutor: exec, ...wired() }),
      ...seams,
      method: "connector.addMcp",
      params: { serviceId: "mcp_ok", commandLine: "echo hi" },
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ ok: true, serviceId: "mcp_ok" });
  });

  test("the gated payload names the resolved values the handler stores", async () => {
    // The regression guard for #808: the gate once read `command`/`args` straight off the
    // params, which are never sent, leaving `"payload":{}` in the prompt, the audit row and the
    // egress ledger. The payload is now the resolved registration the handler writes.
    const { exec, calls } = makeStubExecutor("proceed");
    await dispatchConnectorRpc({
      ...baseOpts({ toolExecutor: exec, ...wired() }),
      ...seams,
      method: "connector.addMcp",
      params: { serviceId: "mcp_probe", commandLine: "npx -y @evil/pkg" },
    });

    const payload = calls[0]?.payload as Record<string, unknown>;
    // Asserted through a JSON round-trip because that is the transform the audit
    // and egress sinks apply: a payload of all-`undefined` fields survives a
    // naive toEqual against `{}` but is exactly the bug.
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      serviceId: "mcp_probe",
      command: "/opt/bin/npx",
      args: ["-y", "@evil/pkg"],
      readPaths: process.platform === "win32" ? [] : ["/opt/bin"],
      netHosts: [],
      modelAccess: false,
    });
  });
});

describe("dispatchConnectorRpc — remove gate", () => {
  test("remove without toolExecutor -> -32603", async () => {
    try {
      await dispatchConnectorRpc({
        ...baseOpts({}),
        method: "connector.remove",
        params: { serviceId: "github" },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
    }
  });

  test("remove with rejected gate returns the gate result", async () => {
    const { exec } = makeStubExecutor({ status: "deferred", reason: "later" });
    const r = await dispatchConnectorRpc({
      ...baseOpts({ toolExecutor: exec }),
      method: "connector.remove",
      params: { serviceId: "github" },
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ status: "deferred", reason: "later" });
  });

  test("the gated payload names the service the handler will actually remove", async () => {
    // Same defect as addMcp: the gate read `service` while
    // `requireRegisteredSchedulerServiceId` reads `serviceId`, so the prompt for
    // a destructive action (index entries deleted, Vault keys cleared) was blank.
    const { exec, calls } = makeStubExecutor({ status: "rejected", reason: "no" });
    await dispatchConnectorRpc({
      ...baseOpts({ toolExecutor: exec }),
      method: "connector.remove",
      params: { serviceId: "github" },
    });

    expect(JSON.parse(JSON.stringify(calls[0]?.payload))).toEqual({ serviceId: "github" });
  });
});

describe("dispatchConnectorRpc — simple routings", () => {
  test("connector.listStatus dispatches to handleConnectorListStatus", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts({}),
      method: "connector.listStatus",
      params: {},
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(Array.isArray(r.value)).toBe(true);
  });

  test("connector.pause routes through handleConnectorPause", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts({}),
      method: "connector.pause",
      params: { serviceId: "github" },
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ ok: true });
  });

  test("connector.resume routes through handleConnectorResume", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts({}),
      method: "connector.resume",
      params: { serviceId: "github" },
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ ok: true });
  });

  test("connector.setInterval routes through handleConnectorSetInterval", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts({}),
      method: "connector.setInterval",
      params: { serviceId: "github", intervalMs: 90_000 },
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ ok: true });
  });

  test("connector.status routes through handleConnectorStatus", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts({}),
      method: "connector.status",
      params: { serviceId: "github" },
    });
    expect(r.kind).toBe("hit");
  });

  test("connector.healthHistory routes through handleConnectorHealthHistory", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts({}),
      method: "connector.healthHistory",
      params: { service: "github" },
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(Array.isArray(r.value)).toBe(true);
  });

  test("connector.sync without scheduler -> -32603 via handleConnectorSync", async () => {
    try {
      await dispatchConnectorRpc({
        ...baseOpts({}),
        method: "connector.sync",
        params: { serviceId: "github" },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
    }
  });
});

describe("dispatchConnectorRpc — connector.startAuth alias removed", () => {
  test("dispatching the removed alias writes nothing to stderr and returns a miss", async () => {
    // The alias used to emit a one-time deprecation warning here. With the case gone there is no
    // warning to emit and no module-level flag to reset — which is the assertion: a `miss` that
    // still printed "deprecated" would mean the case had been half-removed.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await dispatchConnectorRpc({
        ...baseOpts({}),
        method: "connector.startAuth",
        params: { serviceId: "github" },
      });
      expect(result.kind).toBe("miss");
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(written.some((m) => m.includes("deprecated"))).toBe(false);
  });
});

describe("dispatchConnectorRpc — connector.auth ignores a caller-supplied probe", () => {
  // A caller must never be able to supply its own probe through the RPC params.
  // Production builds the context as a fixed object literal whose only
  // caller-derived member is `rec` (connector-rpc.ts:48-56) — `rec` is a sibling
  // field, never spread. If a future refactor "simplified" that to `{...rec, …}`,
  // any caller could inject `{kind:"valid"}` and bypass validation entirely. This
  // pins it. Route through the real dispatcher, NOT handleConnectorAuth directly.
  test("a probe function supplied in RPC params is ignored", async () => {
    const seq: string[] = [];
    const probeVault = {
      set: async (k: string) => {
        seq.push(`write:${k}`);
      },
      get: async () => null,
      delete: async (k: string) => {
        seq.push(`delete:${k}`);
      },
    } as unknown as NimbusVault;
    let injectedRan = false;
    const realFetch = globalThis.fetch;
    // The REAL probe runs here (no seam injected), so bound its network call.
    globalThis.fetch = (async () =>
      new Response("Bad credentials", { status: 401 })) as unknown as typeof fetch;
    try {
      await expect(
        dispatchConnectorRpc({
          ...baseOpts({}),
          vault: probeVault,
          method: "connector.auth",
          params: {
            service: "github",
            token: "dead-pat",
            // A caller-supplied lookalike. It lands in `rec`, never on the context.
            runCredentialProbe: async () => {
              injectedRan = true;
              return { kind: "valid" };
            },
          },
        }),
      ).rejects.toThrow(/rejected the credential \(HTTP 401\)/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(injectedRan).toBe(false);
    expect(seq).toEqual([]); // the real probe rejected; nothing was written
  });
});
