import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import type { GitHistoryReader } from "../debt/git-history.ts";
import {
  DEBT_DAY,
  DEBT_NOW,
  DEBT_ROOT,
  incident,
  seedGraph,
} from "../incident/__fixtures__/debt-seed.ts";
import { dispatchIncidentRpc, type IncidentRpcCtx, IncidentRpcError } from "./incident-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

/** `incident.debt` (IC7b): owner kinds only, strict params, and no param ever reaches git. */

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function ctx(over: Partial<IncidentRpcCtx> = {}): IncidentRpcCtx {
  const db = createMemoryIndexDb();
  dbs.push(db);
  return {
    db,
    engine: { assembleNow: () => Promise.reject(new Error("unused")) },
    dependsOn: () => new Map(),
    ...over,
  };
}

async function call(
  c: IncidentRpcCtx,
  params: unknown,
  kind: ClientKind = "cli",
): Promise<unknown> {
  const out = await dispatchIncidentRpc("incident.debt", params, c, { kind });
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

describe("incident.debt", () => {
  test("every kind but cli and ui is refused before the roots or git are touched", async () => {
    let touched = 0;
    const c = ctx({
      debt: {
        roots: () => {
          touched += 1;
          return [];
        },
        git: async () => {
          touched += 1;
          return { ok: false, reason: "git_failed" };
        },
      },
    });
    for (const kind of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
      const e = await rpcError(call(c, {}, kind));
      expect(e.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
    }
    expect(touched).toBe(0);
    for (const kind of ["cli", "ui"] as const) {
      expect(await call(c, {}, kind)).toMatchObject({ status: "no_roots" });
    }
  });

  test("params are strict: unknown keys, non-integers and out-of-range values are -32602", async () => {
    const c = ctx({ debt: { roots: () => [] } });
    const bad: unknown[] = [
      { path: "/etc" },
      { since: "30d" },
      { since: 0 },
      { since: 3651 },
      { untouched: 1.5 },
      { minIncidents: 51 },
      { limit: 201 },
      { limit: -1 },
      [],
      "x",
    ];
    for (const p of bad) expect((await rpcError(call(c, p))).rpcCode).toBe(-32602);
  });

  test("validated integers and the defaults reach the scan; the injected reader is called with the configured root", async () => {
    const seen: string[] = [];
    const git: GitHistoryReader = async (root) => {
      seen.push(root);
      return {
        ok: true,
        history: {
          prefix: "",
          tracked: new Set(["src/pay.ts"]),
          lastTouchMs: new Map([["src/pay.ts", DEBT_NOW - 400 * DEBT_DAY]]),
          oldestCommitMs: DEBT_NOW - 900 * DEBT_DAY,
          complete: true,
        },
      };
    };
    const c = ctx({
      debt: { roots: () => [{ path: DEBT_ROOT, gitAware: true }], git, now: () => DEBT_NOW },
    });
    seedGraph(c.db, { files: { "src/pay.ts": ["charge", "refund"] } });
    incident(c.db, { pr: 1, files: ["src/pay.ts"] });
    incident(c.db, { pr: 2, files: ["src/pay.ts"] });

    const dflt = await call(c, undefined);
    expect(dflt).toMatchObject({
      status: "ok",
      windowDays: 365,
      untouchedDays: 180,
      minIncidents: 2,
      omitted: 0,
    });
    expect((dflt as { symbols: unknown[] }).symbols).toHaveLength(2);
    expect(seen).toEqual([DEBT_ROOT]);

    const narrowed = await call(c, { since: 365, untouched: 30, minIncidents: 3, limit: 1 });
    expect(narrowed).toMatchObject({ status: "none", untouchedDays: 30, minIncidents: 3 });
    const limited = await call(c, { limit: 1 });
    expect(limited).toMatchObject({ omitted: 1 });
    expect((limited as { symbols: unknown[] }).symbols).toHaveLength(1);
  });

  test("an unwired gateway answers ERR_DEBT_UNAVAILABLE", async () => {
    const e = await rpcError(call(ctx(), {}));
    expect(e.message).toContain("ERR_DEBT_UNAVAILABLE");
  });
});
