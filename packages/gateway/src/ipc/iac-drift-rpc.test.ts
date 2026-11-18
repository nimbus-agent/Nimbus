import { describe, expect, test } from "bun:test";
import type { DriftFinding } from "../iac-drift/drift-findings.ts";
import { IacDriftNotApprovedError, type IacDriftRunner } from "../iac-drift/drift-runner.ts";
import {
  dispatchIacDriftRpc,
  IAC_DRIFT_BAD_PARAMS,
  IAC_DRIFT_CLI_ONLY,
  IAC_DRIFT_UNAVAILABLE,
  IacDriftRpcError,
} from "./iac-drift-rpc.ts";

const F: DriftFinding = {
  workdir: "/a",
  checkedAt: 1,
  startedBy: "owner_cli",
  status: "clean",
  driftCount: 0,
  plannedChanges: 0,
  lines: [],
};

function runner(o: { throws?: Error } = {}) {
  const calls: unknown[] = [];
  const r: IacDriftRunner = {
    check: async (opts) => {
      calls.push(opts);
      if (o.throws !== undefined) throw o.throws;
      return [F];
    },
    latest: () => [F],
    running: () => false,
  };
  return { r, calls };
}

async function err(p: Promise<unknown>): Promise<IacDriftRpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IacDriftRpcError) return e;
    throw e;
  }
  throw new Error("expected an error");
}

describe("iac.* (OR-DRIFT-1: the owner's CLI only)", () => {
  test("a cli connection runs a check (owner_cli) and reads the latest", async () => {
    const h = runner();
    const ctx = { runner: () => h.r };
    expect(await dispatchIacDriftRpc("iac.driftCheck", {}, ctx, { kind: "cli" })).toEqual({
      kind: "hit",
      value: { findings: [F] },
    });
    await dispatchIacDriftRpc("iac.driftCheck", { workdir: "/a" }, ctx, { kind: "cli" });
    await dispatchIacDriftRpc("iac.driftCheck", null, ctx, { kind: "cli" });
    expect(h.calls).toEqual([
      { startedBy: "owner_cli" },
      { workdir: "/a", startedBy: "owner_cli" },
      { startedBy: "owner_cli" },
    ]);
    const latest = await dispatchIacDriftRpc("iac.driftLatest", {}, ctx, { kind: "cli" });
    expect(latest).toEqual({ kind: "hit", value: { findings: [F] } });
  });

  test("every other kind is refused before the runner is touched", async () => {
    const h = runner();
    for (const kind of ["ui", "mcp", "chatops", "http", "fleet", "push", "unknown"] as const) {
      for (const m of ["iac.driftCheck", "iac.driftLatest"]) {
        const e = await err(dispatchIacDriftRpc(m, {}, { runner: () => h.r }, { kind }));
        expect(e.message).toBe(IAC_DRIFT_CLI_ONLY);
      }
    }
    expect(h.calls).toEqual([]);
  });

  test("no runner (a demo gateway) is unavailable", async () => {
    const e = await err(
      dispatchIacDriftRpc("iac.driftLatest", {}, { runner: () => undefined }, { kind: "cli" }),
    );
    expect(e.message).toBe(IAC_DRIFT_UNAVAILABLE);
  });

  test("bad params are refused; an unapproved workdir is a domain error; others propagate", async () => {
    const ctx = { runner: () => runner().r };
    for (const p of [[], "x", { workdir: "" }, { workdir: 5 }]) {
      const e = await err(dispatchIacDriftRpc("iac.driftCheck", p, ctx, { kind: "cli" }));
      expect(e.message).toBe(IAC_DRIFT_BAD_PARAMS);
      expect(e.rpcCode).toBe(-32602);
    }
    const na = runner({ throws: new IacDriftNotApprovedError() });
    const e = await err(
      dispatchIacDriftRpc(
        "iac.driftCheck",
        { workdir: "/x" },
        { runner: () => na.r },
        { kind: "cli" },
      ),
    );
    expect(e.rpcCode).toBe(-32000);
    const other = runner({ throws: new Error("io") });
    await expect(
      dispatchIacDriftRpc("iac.driftCheck", {}, { runner: () => other.r }, { kind: "cli" }),
    ).rejects.toThrow("io");
  });

  test("an unknown iac method is a miss", async () => {
    const out = await dispatchIacDriftRpc(
      "iac.other",
      {},
      { runner: () => undefined },
      { kind: "cli" },
    );
    expect(out.kind).toBe("miss");
  });
});
