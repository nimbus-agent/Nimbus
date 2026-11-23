/**
 * Direct tests of the ops dispatch wiring in `ops-rpcs.ts` (oncall, statuspage, cost, postmortem, incident
 * update, notifications). Each `tryDispatch*` is called with a hand-built `ServerCtx`, so every arm of the
 * wiring is reached: the skip conditions, the optional context fields, the domain-error remap to
 * `RpcMethodError` and the re-throw of any other error. The briefing, incident, oncall push and iac arms are
 * covered by the `dispatchers-*.test.ts` files beside `dispatchers.ts`.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryIndexDb } from "../../../connectors/connector-sync-test-helpers.ts";
import { NO_POLICY_OVERLAY } from "../../../engine/executor.ts";
import type { PlannedAction } from "../../../engine/types.ts";
import { seedPostmortemRecord } from "../../../incident/__fixtures__/postmortem-seed.ts";
import { createMockVault } from "../../../vault/mock.ts";
import type { ConsentCoordinator } from "../../consent.ts";
import { createStreamRegistry } from "../../engine-ask-stream.ts";
import type { ClientKind } from "../client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";
import {
  tryDispatchCostRpc,
  tryDispatchIncidentUpdateRpc,
  tryDispatchNotificationsRpc,
  tryDispatchOncallNowRpc,
  tryDispatchPostmortemRpc,
  tryDispatchStatuspageRpc,
} from "./ops-rpcs.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

/** A config dir that does not exist: every reader falls back to its defaults. */
const MISSING_CONFIG_DIR = join(tmpdir(), "nimbus-ops-rpcs-test-no-such-config-dir");

const approving = (): ConsentCoordinator => ({
  requestConsent: async () => ({ approved: true, answerSource: "human" }),
  requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
  rejectAllPending: () => {},
  pendingCount: () => 0,
});

type Over = {
  readonly db?: Database | (() => Database);
  readonly noIndex?: boolean;
  readonly kind?: ClientKind | (() => ClientKind);
  readonly options?: Record<string, unknown>;
  readonly consent?: ConsentCoordinator;
};

function ctxOf(over: Over = {}): ServerCtx {
  let getDatabase: (() => Database) | undefined;
  if (over.noIndex !== true) {
    if (typeof over.db === "function") {
      getDatabase = over.db;
    } else {
      const db = over.db ?? createMemoryIndexDb();
      if (over.db === undefined) dbs.push(db);
      getDatabase = () => db;
    }
  }
  const kind = over.kind ?? "cli";
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(getDatabase === undefined ? {} : { localIndex: { getDatabase } }),
      ...over.options,
    },
    consentImpl: over.consent ?? approving(),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: typeof kind === "function" ? kind : () => kind,
  } as unknown as ServerCtx;
}

const boom = (): never => {
  throw new Error("boom");
};

async function rpcError(p: Promise<unknown>): Promise<RpcMethodError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RpcMethodError);
  return e as RpcMethodError;
}

function actWiring(dispatched: PlannedAction[], withPreview: boolean): Record<string, unknown> {
  return {
    dispatcher: {
      dispatch: async (a: PlannedAction) => {
        dispatched.push(a);
        return { content: [{ type: "text", text: JSON.stringify({ id: "424242", ok: true }) }] };
      },
    },
    egressSink: { append: () => {} },
    audit: { recordAudit: () => {} },
    policyHitl: NO_POLICY_OVERLAY,
    getTribalKbConfig: () => undefined,
    ...(withPreview ? { previewCredentialFor: () => undefined } : {}),
  };
}

async function seeded(resolved = true) {
  const s = await seedPostmortemRecord({ resolved });
  dbs.push(s.db);
  return s;
}

describe("tryDispatchOncallNowRpc", () => {
  test("answers with and without a config dir, and records only for an owner kind", async () => {
    const plain = (await tryDispatchOncallNowRpc(ctxOf(), "oncall.now", {}, "c1")) as {
      status: string;
    };
    expect(typeof plain.status).toBe("string");
    const withDir = await tryDispatchOncallNowRpc(
      ctxOf({ options: { configDir: MISSING_CONFIG_DIR }, kind: "mcp" }),
      "oncall.handoff",
      {},
      "c1",
    );
    expect(withDir).not.toBe(phase4RpcSkipped);
    const noClient = await tryDispatchOncallNowRpc(ctxOf(), "oncall.now", {});
    expect(noClient).not.toBe(phase4RpcSkipped);
  });

  test("other methods and a missing index are skipped", async () => {
    expect(await tryDispatchOncallNowRpc(ctxOf(), "oncall.pushedList", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchOncallNowRpc(ctxOf({ noIndex: true }), "oncall.now", {})).toBe(
      phase4RpcSkipped,
    );
  });

  test("a domain error keeps its code; any other error is re-thrown as it is", async () => {
    const e = await rpcError(tryDispatchOncallNowRpc(ctxOf(), "oncall.now", "bad", "c1"));
    expect(e.rpcCode).toBe(-32602);
    await expect(tryDispatchOncallNowRpc(ctxOf({ db: boom }), "oncall.now", {})).rejects.toThrow(
      "boom",
    );
  });
});

describe("tryDispatchStatuspageRpc", () => {
  test("answers with and without a config dir", async () => {
    expect(await tryDispatchStatuspageRpc(ctxOf(), "statuspage.model", {})).not.toBe(
      phase4RpcSkipped,
    );
    expect(
      await tryDispatchStatuspageRpc(
        ctxOf({ options: { configDir: MISSING_CONFIG_DIR } }),
        "statuspage.model",
        {},
      ),
    ).not.toBe(phase4RpcSkipped);
  });

  test("other methods and a missing index are skipped", async () => {
    expect(await tryDispatchStatuspageRpc(ctxOf(), "statuspage.other", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchStatuspageRpc(ctxOf({ noIndex: true }), "statuspage.model", {})).toBe(
      phase4RpcSkipped,
    );
  });

  test("a domain error keeps its code; any other error is re-thrown as it is", async () => {
    const e = await rpcError(tryDispatchStatuspageRpc(ctxOf(), "statuspage.model", "bad"));
    expect(e.rpcCode).toBe(-32602);
    await expect(
      tryDispatchStatuspageRpc(ctxOf({ db: boom }), "statuspage.model", {}),
    ).rejects.toThrow("boom");
  });
});

describe("tryDispatchCostRpc", () => {
  test("a config dir is passed through", async () => {
    const out = (await tryDispatchCostRpc(
      ctxOf({ options: { configDir: MISSING_CONFIG_DIR } }),
      "cost.anomalies",
      {},
    )) as { status: string };
    expect(out.status).toBe("no_data");
  });

  test("an unknown cost method is a miss and a validation error keeps its code", async () => {
    expect(await tryDispatchCostRpc(ctxOf(), "cost.zzz", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchCostRpc(ctxOf({ noIndex: true }), "cost.waste", {})).toBe(
      phase4RpcSkipped,
    );
    const e = await rpcError(tryDispatchCostRpc(ctxOf(), "cost.waste", "bad"));
    expect(e.rpcCode).toBe(-32602);
  });

  test("an error that is not a cost error is re-thrown as it is", async () => {
    await expect(tryDispatchCostRpc(ctxOf({ db: boom }), "cost.anomalies", {})).rejects.toThrow(
      "boom",
    );
  });
});

describe("tryDispatchPostmortemRpc", () => {
  test("other methods and a missing index are skipped", async () => {
    expect(await tryDispatchPostmortemRpc(ctxOf(), "incident.list", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
    for (const m of ["incident.postmortem", "incident.postmortemPush"]) {
      expect(await tryDispatchPostmortemRpc(ctxOf({ noIndex: true }), m, {}, "c1")).toBe(
        phase4RpcSkipped,
      );
    }
  });

  test("drafts a resolved record, building the synthesis runner when asked", async () => {
    const { db, recordId } = await seeded();
    const out = (await tryDispatchPostmortemRpc(
      ctxOf({ db, options: { configDir: MISSING_CONFIG_DIR } }),
      "incident.postmortem",
      { id: recordId, synthesize: true },
      "c1",
    )) as { recordId: string; synthesis: { attempted: boolean; reason?: string } };
    expect(out.recordId).toBe(recordId);
    // No LLM registry on this gateway: the runner is undefined and the draft says so.
    expect(out.synthesis).toEqual({ attempted: false, reason: "disabled" });
  });

  test("pushes through the act wiring, with and without a preview credential", async () => {
    for (const withPreview of [true, false]) {
      const { db, recordId } = await seeded();
      const dispatched: PlannedAction[] = [];
      const out = await tryDispatchPostmortemRpc(
        ctxOf({ db, options: { captureRpcCtx: { act: actWiring(dispatched, withPreview) } } }),
        "incident.postmortemPush",
        { id: recordId, target: "confluence", space: "OPS", markdown: "# Post-mortem\n\nbody" },
        "c1",
      );
      expect(out).not.toBe(phase4RpcSkipped);
      expect(dispatched.length).toBeGreaterThan(0);
    }
  });

  test("a non-owner kind and a push with no act wiring are domain errors with their codes", async () => {
    const { db, recordId } = await seeded();
    const forbidden = await rpcError(
      tryDispatchPostmortemRpc(ctxOf({ db, kind: "mcp" }), "incident.postmortem", {}, "c1"),
    );
    expect(forbidden.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
    const unavailable = await rpcError(
      tryDispatchPostmortemRpc(
        ctxOf({ db }),
        "incident.postmortemPush",
        { id: recordId, target: "confluence", space: "OPS", markdown: "x" },
        "c1",
      ),
    );
    expect(unavailable.message).toContain("ERR_POSTMORTEM_PUSH_UNAVAILABLE");
  });

  test("any other error is re-thrown as it is", async () => {
    await expect(
      tryDispatchPostmortemRpc(ctxOf({ kind: boom }), "incident.postmortem", {}, "c1"),
    ).rejects.toThrow("boom");
  });
});

describe("tryDispatchIncidentUpdateRpc", () => {
  test("other methods and a missing index are skipped", async () => {
    expect(await tryDispatchIncidentUpdateRpc(ctxOf(), "incident.get", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
    for (const m of ["incident.update", "incident.updateSend", "incident.updateQueue"]) {
      expect(await tryDispatchIncidentUpdateRpc(ctxOf({ noIndex: true }), m, {}, "c1")).toBe(
        phase4RpcSkipped,
      );
    }
  });

  test("drafts an update and lists an empty queue", async () => {
    const { db, recordId } = await seeded();
    const draft = (await tryDispatchIncidentUpdateRpc(
      ctxOf({ db }),
      "incident.update",
      { id: recordId },
      "c1",
    )) as { text: string };
    expect(typeof draft.text).toBe("string");
    expect(
      await tryDispatchIncidentUpdateRpc(
        ctxOf({ db, options: { dataDir: MISSING_CONFIG_DIR } }),
        "incident.updateQueue",
        {},
        "c1",
      ),
    ).toEqual({ entries: [] });
  });

  test("sends through the act wiring when the live policy has ChatOps bindings", async () => {
    const chatops = { channels: new Map(), ownership: new Map() };
    for (const withPreview of [true, false]) {
      const { db, recordId } = await seeded();
      const dispatched: PlannedAction[] = [];
      const out = await tryDispatchIncidentUpdateRpc(
        ctxOf({
          db,
          options: {
            enforcedPolicy: () => ({ chatops }),
            captureRpcCtx: { act: actWiring(dispatched, withPreview) },
          },
        }),
        "incident.updateSend",
        { id: recordId, platform: "slack", channel: "C0STATUS", text: "hello" },
        "c1",
      );
      expect(out).toEqual({ outcome: "sent" });
      expect(dispatched).toHaveLength(1);
    }
  });

  test("a send with no readable ChatOps bindings is refused before any dispatch", async () => {
    const policies: ReadonlyArray<Record<string, unknown>> = [
      {},
      { enforcedPolicy: () => undefined },
    ];
    for (const policy of policies) {
      const { db, recordId } = await seeded();
      const dispatched: PlannedAction[] = [];
      const out = (await tryDispatchIncidentUpdateRpc(
        ctxOf({ db, options: { ...policy, captureRpcCtx: { act: actWiring(dispatched, true) } } }),
        "incident.updateSend",
        { id: recordId, platform: "slack", channel: "C0STATUS", text: "hello" },
        "c1",
      )) as { outcome: string; code?: string };
      expect(out.outcome).toBe("refused");
      expect(out.code).toBe("ERR_INCIDENT_UPDATE_REFUSED");
      expect(dispatched).toHaveLength(0);
    }
  });

  test("a domain error keeps its code; any other error is re-thrown as it is", async () => {
    const e = await rpcError(
      tryDispatchIncidentUpdateRpc(ctxOf({ kind: "http" }), "incident.update", {}, "c1"),
    );
    expect(e.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
    await expect(
      tryDispatchIncidentUpdateRpc(ctxOf({ kind: boom }), "incident.updateQueue", {}, "c1"),
    ).rejects.toThrow("boom");
  });
});

describe("tryDispatchNotificationsRpc", () => {
  const runtime = {
    ready: async () => ({ backend: "test" }),
    test: async () => ({ delivered: false, reason: "test" }),
  };

  test("answers both methods through the runtime", async () => {
    const ctx = ctxOf({ options: { notificationsRpcCtx: { runtime } } });
    expect(await tryDispatchNotificationsRpc(ctx, "notifications.status", {})).toEqual({
      backend: "test",
    });
    expect(await tryDispatchNotificationsRpc(ctx, "notifications.test", {})).toEqual({
      delivered: false,
      reason: "test",
    });
  });

  test("another namespace, an unknown method and a missing runtime are skipped", async () => {
    const ctx = ctxOf({ options: { notificationsRpcCtx: { runtime } } });
    expect(await tryDispatchNotificationsRpc(ctx, "oncall.now", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchNotificationsRpc(ctx, "notifications.zzz", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchNotificationsRpc(ctxOf(), "notifications.status", {})).toBe(
      phase4RpcSkipped,
    );
  });
});
