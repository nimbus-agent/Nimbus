import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import { createIncidentScribe } from "../incident-update/scribe.ts";
import type { ConsentCoordinator } from "./consent.ts";
import { IncidentRpcError } from "./incident-rpc.ts";
import { dispatchIncidentUpdateRpc, type IncidentUpdateRpcCtx } from "./incident-update-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const dbs: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Rig = {
  readonly db: Database;
  readonly recordId: string;
  readonly ctx: IncidentUpdateRpcCtx;
  readonly dispatched: PlannedAction[];
  readonly queries: { n: number };
};

function rig(o: { act?: boolean } = {}): Rig {
  const db = createMemoryIndexDb();
  dbs.push(db);
  const stored = upsertIncidentRecord(db, {
    record: buildRecord({ itemId: "pagerduty:PDR", title: "Checkout errors" }),
    markdown: "# x",
    recordSha256: "c".repeat(64),
    citedServices: ["pagerduty"],
    nowMs: 1,
  });
  const dataDir = mkdtempSync(join(tmpdir(), "nimbus-update-rpc-"));
  dirs.push(dataDir);
  const dispatched: PlannedAction[] = [];
  // Count every statement the handler prepares, to prove the kind check runs before any query.
  const queries = { n: 0 };
  const counted = new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === "query" || prop === "prepare") {
        return (...args: unknown[]) => {
          queries.n += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const ctx: IncidentUpdateRpcCtx = {
    db: counted,
    now: () => Date.parse("2026-11-17T12:00:00Z"),
    dataDir,
    chatops: () => ({ channels: new Map(), ownership: new Map() }),
    ...(o.act === false
      ? {}
      : {
          act: {
            dispatcher: {
              dispatch: async (a) => {
                dispatched.push(a);
                return { content: [{ type: "text", text: "{}" }] };
              },
            },
            egressSink: { append: () => {} },
            audit: { recordAudit: () => {} },
            policyHitl: NO_POLICY_OVERLAY,
          },
        }),
  };
  return { db, recordId: stored.recordId, ctx, dispatched, queries };
}

const consent: ConsentCoordinator = {
  requestConsent: async () => ({ approved: true, answerSource: "human" }),
  requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
  rejectAllPending: () => {},
  pendingCount: () => 0,
};

async function call(
  r: Rig,
  method: string,
  params: unknown,
  kind: ClientKind = "cli",
): Promise<unknown> {
  const out = await dispatchIncidentUpdateRpc(
    method,
    params,
    r.ctx,
    { clientId: "c1", kind },
    consent,
  );
  if (out.kind !== "hit") throw new Error("miss");
  return out.value;
}

describe("incident.update / updateSend / updateQueue", () => {
  test("every method refuses a non-owner kind before any query", async () => {
    for (const method of ["incident.update", "incident.updateSend", "incident.updateQueue"]) {
      for (const kind of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
        const r = rig();
        const before = r.queries.n;
        await expect(call(r, method, { id: r.recordId }, kind)).rejects.toThrow(
          /ERR_INCIDENT_FORBIDDEN_CLIENT/,
        );
        expect(r.queries.n).toBe(before);
      }
    }
  });

  test("incident.update drafts the record for the desktop too", async () => {
    const r = rig();
    const out = (await call(r, "incident.update", { id: r.recordId }, "ui")) as { text: string };
    expect(out.text).toContain("Incident update: Checkout errors");
  });

  test("bad parameters are -32602", async () => {
    const r = rig();
    for (const params of [
      { id: r.recordId, audience: "everyone" },
      { id: r.recordId, version: 0 },
      { id: r.recordId, extra: 1 },
      {},
      { id: "inc_ffffffffffffffff" },
    ]) {
      try {
        await call(r, "incident.update", params);
        throw new Error("expected a throw");
      } catch (e) {
        expect(e).toBeInstanceOf(IncidentRpcError);
        expect((e as IncidentRpcError).rpcCode).toBe(-32602);
      }
    }
    for (const params of [
      { id: r.recordId, platform: "slack", channel: "#general", text: "x" },
      { id: r.recordId, platform: "slack", channel: "C0X", teamId: "t", text: "x" },
      { id: r.recordId, platform: "teams", teamId: "t", channelId: "not-a-thread", text: "x" },
      { id: r.recordId, platform: "email", text: "x" },
      { id: r.recordId, platform: "slack", channel: "C0X" },
    ]) {
      await expect(call(r, "incident.updateSend", params)).rejects.toThrow(IncidentRpcError);
    }
  });

  test("a send posts once through the owner's executor", async () => {
    const r = rig();
    const out = await call(r, "incident.updateSend", {
      id: r.recordId,
      platform: "slack",
      channel: "C0STATUS",
      text: "hello",
    });
    expect(out).toEqual({ outcome: "sent" });
    expect(r.dispatched).toHaveLength(1);
    expect(r.dispatched[0]?.incident?.id).toBe(r.recordId);
  });

  test("a send with no act wiring is unavailable (fail closed)", async () => {
    const r = rig({ act: false });
    await expect(
      call(r, "incident.updateSend", {
        id: r.recordId,
        platform: "slack",
        channel: "C0STATUS",
        text: "hello",
      }),
    ).rejects.toThrow(/ERR_INCIDENT_UPDATE_UNAVAILABLE/);
  });

  test("the queue lists what the scribe queued", async () => {
    const r = rig();
    const scribe = createIncidentScribe({
      dataDir: r.ctx.dataDir as string,
      enabled: () => true,
      now: () => 5,
      emit: () => {},
      notify: async () => {},
      logger: { warn: () => {} },
    });
    scribe.onAssembled({ recordId: r.recordId, version: 1 });
    expect(await call(r, "incident.updateQueue", {})).toEqual({
      entries: [{ recordId: r.recordId, version: 1, queuedAtMs: 5 }],
    });
    await expect(call(r, "incident.updateQueue", { x: 1 })).rejects.toThrow(IncidentRpcError);
  });

  test("an unrelated method is a miss", async () => {
    const r = rig();
    const out = await dispatchIncidentUpdateRpc("incident.list", {}, r.ctx, {
      clientId: "c",
      kind: "cli",
    });
    expect(out.kind).toBe("miss");
  });
});

describe("incident update RPC edges", () => {
  test("a non-object payload is -32602; an absent one is an empty one", async () => {
    const r = rig();
    for (const params of [null, [], "x", 3]) {
      await expect(call(r, "incident.update", params)).rejects.toThrow(/object payload/);
    }
    expect(await call(r, "incident.updateQueue", undefined)).toEqual({ entries: [] });
  });

  test("with no data directory the queue lists nothing", async () => {
    const r = rig();
    const ctx: IncidentUpdateRpcCtx = { ...r.ctx, dataDir: undefined };
    const out = await dispatchIncidentUpdateRpc(
      "incident.updateQueue",
      {},
      ctx,
      { clientId: "c1", kind: "cli" },
      consent,
    );
    expect(out).toEqual({ kind: "hit", value: { entries: [] } });
  });

  test("a Teams send posts a text body; an older version and the engineer audience draft", async () => {
    const r = rig();
    expect(
      await call(r, "incident.updateSend", {
        id: r.recordId,
        platform: "teams",
        teamId: "team-1",
        channelId: "19:abc@thread.tacv2",
        text: "hello",
      }),
    ).toEqual({ outcome: "sent" });
    expect(r.dispatched[0]?.type).toBe("teams.message.post");
    const out = (await call(r, "incident.update", {
      id: r.recordId,
      audience: "engineers",
      version: 1,
    })) as { audience: string; version: number };
    expect(out).toMatchObject({ audience: "engineers", version: 1 });
    await expect(call(r, "incident.update", { id: r.recordId, version: 7 })).rejects.toThrow(
      /ERR_INCIDENT_VERSION_NOT_FOUND/,
    );
  });

  test("a send whose text is too long by one is refused as a value; longer is -32602", async () => {
    const r = rig();
    const out = await call(r, "incident.updateSend", {
      id: r.recordId,
      platform: "slack",
      channel: "C0STATUS",
      text: "x".repeat(12_001),
    });
    expect(out).toMatchObject({ outcome: "refused", code: "ERR_INCIDENT_UPDATE_TOO_LONG" });
    await expect(
      call(r, "incident.updateSend", {
        id: r.recordId,
        platform: "slack",
        channel: "C0STATUS",
        text: "x".repeat(12_002),
      }),
    ).rejects.toThrow(IncidentRpcError);
    expect(r.dispatched).toHaveLength(0);
  });

  test("an id that is an indexed item but not an incident source is refused", async () => {
    const r = rig();
    r.db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('github:pr:1','github','pr','1','x',1,1)",
    );
    await expect(call(r, "incident.update", { id: "github:pr:1" })).rejects.toThrow(
      /ERR_INCIDENT_NOT_A_TRIGGER|ERR_INCIDENT_NOT_FOUND/,
    );
  });
});

describe("incident.updateSend: Slack destinations", () => {
  test("a DM (D) or user (U) id is refused; a channel (C) or private channel (G) id is accepted", async () => {
    const r = rig();
    for (const channel of ["D0123ABC", "U0123ABC", "W0123ABC"]) {
      await expect(
        call(r, "incident.updateSend", { id: r.recordId, platform: "slack", channel, text: "x" }),
      ).rejects.toThrow(/channel id/);
    }
    expect(r.dispatched).toHaveLength(0);
    for (const channel of ["C0123ABC", "G0123ABC"]) {
      expect(
        await call(r, "incident.updateSend", {
          id: r.recordId,
          platform: "slack",
          channel,
          text: "x",
        }),
      ).toEqual({ outcome: "sent" });
    }
  });
});
