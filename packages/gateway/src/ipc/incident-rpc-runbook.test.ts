import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { RunbookError, type Runbooks } from "../runbook/runbook-run.ts";
import { dispatchIncidentRpc, type IncidentRpcCtx, IncidentRpcError } from "./incident-rpc.ts";

/** `incident.runbooks`, `incident.runbookRun`, `incident.runbookDone` (IC6): strict params, refusals as codes. */

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

type Calls = { method: string; args: unknown }[];

function fakeRunbooks(calls: Calls, fail?: RunbookError | Error): Runbooks {
  const answer = <T>(method: string, args: unknown, value: T): T => {
    calls.push({ method, args });
    if (fail !== undefined) throw fail;
    return value;
  };
  return {
    list: (ref, only) =>
      answer(
        "list",
        { ref, only },
        { recordId: "r", version: 1, advisory: false, runbooks: [], errors: [] },
      ),
    done: (p) => answer("done", p, { runbook: p.runbook, step: p.step, status: "done" as const }),
    run: async (p) =>
      answer("run", p, {
        runbook: p.runbook,
        step: p.step,
        kind: "read" as const,
        actionId: "act_0000000000000001",
        status: "ok" as const,
        nonHuman: false,
      }),
  };
}

function ctx(runbooks?: Runbooks): IncidentRpcCtx {
  const db = createMemoryIndexDb();
  dbs.push(db);
  return {
    db,
    engine: { assembleNow: () => Promise.reject(new Error("unused")) },
    dependsOn: () => new Map(),
    ...(runbooks === undefined ? {} : { runbooks }),
  };
}

async function call(
  c: IncidentRpcCtx,
  method: string,
  params: unknown,
  clientId = "cli-1",
): Promise<unknown> {
  const out = await dispatchIncidentRpc(method, params, c, { kind: "cli", clientId });
  if (out.kind === "miss") throw new Error("miss");
  return out.value;
}

async function rpcError(p: Promise<unknown>): Promise<IncidentRpcError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof IncidentRpcError)) throw new Error("expected an IncidentRpcError");
  return e;
}

describe("the runbook methods", () => {
  test("each reaches the service with the parsed params and the asking connection", async () => {
    const calls: Calls = [];
    const c = ctx(fakeRunbooks(calls));
    await call(c, "incident.runbooks", { id: " inc_1 " });
    await call(c, "incident.runbooks", { id: "inc_1", runbook: "pay" });
    await call(c, "incident.runbookRun", { id: "inc_1", runbook: "pay", step: 2 });
    await call(c, "incident.runbookDone", { id: "inc_1", runbook: "pay", step: 1 });
    expect(calls).toEqual([
      { method: "list", args: { ref: "inc_1", only: undefined } },
      { method: "list", args: { ref: "inc_1", only: "pay" } },
      { method: "run", args: { ref: "inc_1", runbook: "pay", step: 2, clientId: "cli-1" } },
      { method: "done", args: { ref: "inc_1", runbook: "pay", step: 1 } },
    ]);
  });

  test("bad params are refused before the service is reached", async () => {
    const calls: Calls = [];
    const c = ctx(fakeRunbooks(calls));
    const cases: [string, unknown, RegExp][] = [
      ["incident.runbooks", { id: "a", extra: 1 }, /unknown parameter "extra"/],
      ["incident.runbooks", { id: "a", runbook: "" }, /runbook must be a non-empty string/],
      ["incident.runbookRun", { id: "a", runbook: "x".repeat(65), step: 1 }, /runbook must be/],
      ["incident.runbookRun", { id: "a", runbook: "r", step: 0 }, /step must be an integer 1..50/],
      ["incident.runbookRun", { id: "a", runbook: "r", step: 51 }, /step must be an integer/],
      ["incident.runbookDone", { id: "a", runbook: "r", step: "1" }, /step must be an integer/],
      ["incident.runbookDone", { runbook: "r", step: 1 }, /id must be a non-empty string/],
    ];
    for (const [method, params, re] of cases) {
      const e = await rpcError(call(c, method, params));
      expect(e.rpcCode, method).toBe(-32602);
      expect(e.message).toMatch(re);
    }
    expect(calls).toEqual([]);
  });

  test("a run needs a connection to ask on", async () => {
    const e = await rpcError(
      call(ctx(fakeRunbooks([])), "incident.runbookRun", { id: "a", runbook: "r", step: 1 }, ""),
    );
    expect(e.message).toContain("no connection to ask the owner on");
  });

  test("a gateway with no runbook service refuses; a refusal is its code; anything else propagates", async () => {
    const none = await rpcError(call(ctx(), "incident.runbooks", { id: "a" }));
    expect(none.rpcCode).toBe(-32000);
    expect(none.message).toContain("ERR_RUNBOOK_UNAVAILABLE");
    const refused = await rpcError(
      call(
        ctx(fakeRunbooks([], new RunbookError("ERR_ADVISORY_MODE", "advisory"))),
        "incident.runbookRun",
        {
          id: "a",
          runbook: "r",
          step: 1,
        },
      ),
    );
    expect(refused.rpcCode).toBe(-32602);
    expect(refused.message).toBe("ERR_ADVISORY_MODE: advisory");
    await expect(
      call(ctx(fakeRunbooks([], new Error("boom"))), "incident.runbookDone", {
        id: "a",
        runbook: "r",
        step: 1,
      }),
    ).rejects.toThrow("boom");
  });
});
