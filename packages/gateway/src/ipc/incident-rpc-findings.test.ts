import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { clearFinding, openFinding } from "../incident/finding-store.ts";
import { dispatchIncidentRpc, type IncidentRpcCtx, IncidentRpcError } from "./incident-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

/** `incident.findings` (IC8): owner kinds only, strict params, read only. */

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function ctx(): IncidentRpcCtx {
  const db = createMemoryIndexDb();
  dbs.push(db);
  return {
    db,
    engine: { assembleNow: () => Promise.reject(new Error("unused")) },
    dependsOn: () => new Map(),
  };
}

async function call(
  c: IncidentRpcCtx,
  params: unknown,
  kind: ClientKind = "cli",
): Promise<unknown> {
  const out = await dispatchIncidentRpc("incident.findings", params, c, { kind });
  if (out.kind === "miss") throw new Error("miss");
  return out.value;
}

async function rpcError(p: Promise<unknown>): Promise<IncidentRpcError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof IncidentRpcError))
    throw new Error(`expected IncidentRpcError, got ${String(e)}`);
  return e;
}

describe("incident.findings", () => {
  test("lists open findings, and with all the cleared ones too", async () => {
    const c = ctx();
    openFinding(c.db, {
      kind: "radar",
      key: "sync:github",
      service: "github",
      detail: { maxGapMs: 1 },
      nowMs: 5,
    });
    openFinding(c.db, {
      kind: "anomaly",
      key: "index:errors:a",
      service: "a",
      detail: {},
      nowMs: 6,
    });
    clearFinding(c.db, "anomaly", "index:errors:a", 7);
    const open = (await call(c, {})) as { findings: Record<string, unknown>[] };
    expect(open.findings).toHaveLength(1);
    expect(open.findings[0]).toMatchObject({
      kind: "radar",
      key: "sync:github",
      service: "github",
      detail: { maxGapMs: 1 },
      openedAtMs: 5,
      clearedAtMs: null,
    });
    const all = (await call(c, { all: true, limit: 10 })) as { findings: unknown[] };
    expect(all.findings).toHaveLength(2);
  });

  test("refuses a non-owner kind, an unknown key and bad values", async () => {
    const c = ctx();
    for (const kind of ["mcp", "unknown"] as ClientKind[]) {
      expect((await rpcError(call(c, {}, kind))).rpcCode).toBeLessThan(0);
    }
    for (const p of [{ all: "yes" }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { other: 1 }]) {
      expect((await rpcError(call(c, p))).rpcCode).toBe(-32602);
    }
  });
});
