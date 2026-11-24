import { describe, expect, test } from "bun:test";
import { type AcceptDriftOutcome, AcceptNotApprovedError } from "../iac-drift/accept-drift.ts";
import type { DriftFinding } from "../iac-drift/drift-findings.ts";
import { IacDriftNotApprovedError, type IacDriftRunner } from "../iac-drift/drift-runner.ts";
import {
  dispatchIacDriftRpc,
  IAC_ACCEPT_BAD_PARAMS,
  IAC_DRIFT_BAD_PARAMS,
  IAC_DRIFT_CLI_ONLY,
  IAC_DRIFT_OWNER_ONLY,
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

function runner(o: { throws?: Error; accept?: AcceptDriftOutcome | Error } = {}) {
  const calls: unknown[] = [];
  const r: IacDriftRunner = {
    check: async (opts) => {
      calls.push(opts);
      if (o.throws !== undefined) throw o.throws;
      return [F];
    },
    accept: async (opts) => {
      calls.push(opts);
      if (o.accept instanceof Error) throw o.accept;
      return o.accept ?? { status: "accepted" };
    },
    latest: () => [F],
    running: () => false,
    wasRunningAt: () => false,
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
    expect(
      await dispatchIacDriftRpc("iac.driftCheck", {}, ctx, { kind: "cli", clientId: "c1" }),
    ).toEqual({
      kind: "hit",
      value: { findings: [F] },
    });
    await dispatchIacDriftRpc("iac.driftCheck", { workdir: "/a" }, ctx, {
      kind: "cli",
      clientId: "c1",
    });
    await dispatchIacDriftRpc("iac.driftCheck", null, ctx, { kind: "cli", clientId: "c1" });
    expect(h.calls).toEqual([
      { startedBy: "owner_cli" },
      { workdir: "/a", startedBy: "owner_cli" },
      { startedBy: "owner_cli" },
    ]);
    const latest = await dispatchIacDriftRpc("iac.driftLatest", {}, ctx, {
      kind: "cli",
      clientId: "c1",
    });
    expect(latest).toEqual({ kind: "hit", value: { findings: [F] } });
  });

  test("every other kind is refused before the runner is even looked up", async () => {
    const h = runner();
    let lookups = 0;
    const ctx = {
      runner: () => {
        lookups += 1;
        return h.r;
      },
    };
    for (const kind of ["ui", "mcp", "chatops", "http", "fleet", "push", "unknown"] as const) {
      for (const m of ["iac.driftCheck", "iac.acceptDrift"]) {
        const e = await err(dispatchIacDriftRpc(m, {}, ctx, { kind, clientId: "c1" }));
        expect(e.message).toBe(IAC_DRIFT_CLI_ONLY);
      }
    }
    for (const kind of ["mcp", "chatops", "http", "fleet", "push", "unknown"] as const) {
      const e = await err(
        dispatchIacDriftRpc("iac.driftLatest", {}, ctx, { kind, clientId: "c1" }),
      );
      expect(e.message).toBe(IAC_DRIFT_OWNER_ONLY);
    }
    expect(lookups).toBe(0);
    expect(h.calls).toEqual([]);
  });

  test("the desktop (ui) reads the latest findings and is still refused the check", async () => {
    const h = runner();
    const ctx = { runner: () => h.r };
    const latest = await dispatchIacDriftRpc("iac.driftLatest", {}, ctx, { kind: "ui", clientId: "c1" });
    expect(latest).toEqual({ kind: "hit", value: { findings: [F] } });
    expect(h.calls).toEqual([]);
  });

  test("no runner (a demo gateway) is unavailable", async () => {
    const e = await err(
      dispatchIacDriftRpc(
        "iac.driftLatest",
        {},
        { runner: () => undefined },
        { kind: "cli", clientId: "c1" },
      ),
    );
    expect(e.message).toBe(IAC_DRIFT_UNAVAILABLE);
  });

  test("bad params are refused; an unapproved workdir is a domain error; others propagate", async () => {
    const ctx = { runner: () => runner().r };
    for (const p of [[], "x", { workdir: "" }, { workdir: 5 }]) {
      const e = await err(
        dispatchIacDriftRpc("iac.driftCheck", p, ctx, { kind: "cli", clientId: "c1" }),
      );
      expect(e.message).toBe(IAC_DRIFT_BAD_PARAMS);
      expect(e.rpcCode).toBe(-32602);
    }
    const na = runner({ throws: new IacDriftNotApprovedError() });
    const e = await err(
      dispatchIacDriftRpc(
        "iac.driftCheck",
        { workdir: "/x" },
        { runner: () => na.r },
        { kind: "cli", clientId: "c1" },
      ),
    );
    expect(e.rpcCode).toBe(-32000);
    const other = runner({ throws: new Error("io") });
    await expect(
      dispatchIacDriftRpc(
        "iac.driftCheck",
        {},
        { runner: () => other.r },
        { kind: "cli", clientId: "c1" },
      ),
    ).rejects.toThrow("io");
  });

  test("iac.acceptDrift runs the accept on THIS connection and returns its outcome", async () => {
    const h = runner({ accept: { status: "declined", reason: "denied", nonHuman: true } });
    const out = await dispatchIacDriftRpc(
      "iac.acceptDrift",
      { workdir: "/a" },
      { runner: () => h.r },
      { kind: "cli", clientId: "conn-7" },
    );
    expect(out).toEqual({
      kind: "hit",
      value: { outcome: { status: "declined", reason: "denied", nonHuman: true } },
    });
    expect(h.calls).toEqual([{ workdir: "/a", clientId: "conn-7" }]);
  });

  test("iac.acceptDrift is CLI only, needs a workdir, and maps a not-approved one to a refusal", async () => {
    const h = runner();
    const ctx = { runner: () => h.r };
    for (const kind of ["ui", "mcp", "chatops", "http", "fleet", "push", "unknown"] as const) {
      const e = await err(
        dispatchIacDriftRpc("iac.acceptDrift", { workdir: "/a" }, ctx, { kind, clientId: "c" }),
      );
      expect(e.message).toBe(IAC_DRIFT_CLI_ONLY);
    }
    for (const p of [undefined, {}, { workdir: "" }, { workdir: 3 }]) {
      const e = await err(
        dispatchIacDriftRpc("iac.acceptDrift", p, ctx, { kind: "cli", clientId: "c" }),
      );
      expect(e.rpcCode).toBe(-32602);
      expect([IAC_ACCEPT_BAD_PARAMS, IAC_DRIFT_BAD_PARAMS]).toContain(e.message);
    }
    const bad = runner({ accept: new AcceptNotApprovedError() });
    const e = await err(
      dispatchIacDriftRpc(
        "iac.acceptDrift",
        { workdir: "/x" },
        { runner: () => bad.r },
        { kind: "cli", clientId: "c" },
      ),
    );
    expect(e.rpcCode).toBe(-32000);
    expect(h.calls).toEqual([]);
    const none = await err(
      dispatchIacDriftRpc(
        "iac.acceptDrift",
        { workdir: "/a" },
        { runner: () => undefined },
        { kind: "cli", clientId: "c" },
      ),
    );
    expect(none.message).toBe(IAC_DRIFT_UNAVAILABLE);
  });

  test("an unknown iac method is a miss", async () => {
    const out = await dispatchIacDriftRpc(
      "iac.other",
      {},
      { runner: () => undefined },
      { kind: "cli", clientId: "c1" },
    );
    expect(out.kind).toBe("miss");
  });
});
