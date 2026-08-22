import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { NimbusCodeExecutionToml } from "../config/nimbus-toml.ts";
import { ExecConsentBroker } from "../exec/exec-consent-broker.ts";
import type { ExecGateDeps } from "../exec/exec-gate.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { dispatchExecRpc, type ExecRpcCtx } from "./exec-rpc.ts";

const CONFIG: NimbusCodeExecutionToml = {
  enabled: true,
  maxWallClockMs: 1000,
  maxOutputBytes: 1024,
  allowedRuntimes: ["bun"],
};

const brokers: ExecConsentBroker[] = [];
// Pending approvals hold live TTL timers; without this, a test that leaves one pending hangs
// `bun test` teardown on Windows.
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
});

const inertRunner: SandboxRunner = {
  platform: process.platform as "linux" | "darwin" | "win32",
  spawn: () => {
    throw new Error("spawn should not be reached in these tests");
  },
  isFullyActive: () => true,
  degradedReason: () => null,
  canConfine: () => null,
};

interface TestCtx extends ExecRpcCtx {
  broadcasts: Array<Record<string, unknown>>;
}

function makeCtx(over: Partial<ExecGateDeps> = {}): TestCtx {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  const consent = new ExecConsentBroker();
  brokers.push(consent);
  const broadcasts: Array<Record<string, unknown>> = [];
  consent.setBroadcast((_m, params) => {
    broadcasts.push(params as Record<string, unknown>);
  });
  return {
    consent,
    broadcasts,
    gateDeps: {
      runner: inertRunner,
      config: CONFIG,
      enforced: { capabilitiesDisabled: new Set<string>() },
      // Route through the broker so the RPC pair is exercised end to end, not stubbed out.
      requestApproval: (input) => consent.request(input, 5_000),
      db,
      readFile: () => "console.log(1)",
      now: () => 1_700_000_000_000,
      newId: () => "e1",
      ...over,
    },
  };
}

const CWD = process.platform === "win32" ? "C:\\tmp" : "/tmp";

describe("exec RPC", () => {
  test("an unknown exec.* method MISSES rather than throwing", async () => {
    const out = await dispatchExecRpc("exec.nope", {}, makeCtx());
    expect(out.kind).toBe("miss");
  });

  test("exec.run reaches the gate and returns its outcome", async () => {
    const ctx = makeCtx({ config: { ...CONFIG, enabled: false } });
    const out = await dispatchExecRpc("exec.run", { code: "1", cwd: CWD }, ctx);
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("refused");
  });

  test("exec.run without cwd is an invalid-params error, not a silent default", async () => {
    // Defaulting cwd gateway-side would run the child somewhere the caller never named.
    await expect(dispatchExecRpc("exec.run", { code: "1" }, makeCtx())).rejects.toThrow();
  });

  test("exec.approvalRespond resolves the pending approval the broker broadcast", async () => {
    const ctx = makeCtx();
    const run = dispatchExecRpc("exec.run", { code: "1", cwd: CWD }, ctx);
    // Let the gate reach the consent step and broadcast.
    await Bun.sleep(1);
    const requestId = ctx.broadcasts[0]?.["requestId"] as string;
    expect(typeof requestId).toBe("string");

    const resp = await dispatchExecRpc("exec.approvalRespond", { requestId, approved: false }, ctx);
    if (resp.kind !== "hit") throw new Error("unreachable");
    expect((resp.value as { matched: boolean }).matched).toBe(true);

    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("exec.approvalRespond reports no match for an unknown requestId", async () => {
    const out = await dispatchExecRpc(
      "exec.approvalRespond",
      { requestId: "nope", approved: true },
      makeCtx(),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { matched: boolean }).matched).toBe(false);
  });

  test("approved defaults to FALSE when the field is absent or non-boolean", async () => {
    // Fail-closed: a malformed respond payload must never read as approval.
    const ctx = makeCtx();
    const run = dispatchExecRpc("exec.run", { code: "1", cwd: CWD }, ctx);
    await Bun.sleep(1);
    const requestId = ctx.broadcasts[0]?.["requestId"] as string;
    await dispatchExecRpc("exec.approvalRespond", { requestId, approved: "yes" }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("a malformed fsRead array yields an EMPTY grant, never a partial one", async () => {
    // A half-parsed grant list is a grant the caller did not ask for.
    const ctx = makeCtx();
    const run = dispatchExecRpc("exec.run", { code: "1", cwd: CWD, fsRead: [CWD, 42] }, ctx);
    await Bun.sleep(1);
    const grants = ctx.broadcasts[0]?.["grants"] as { fsRead: string[] } | undefined;
    // Only the scratch dir the gate itself adds — nothing from the malformed caller array.
    expect(grants?.fsRead.includes(CWD)).toBe(false);
    await dispatchExecRpc(
      "exec.approvalRespond",
      { requestId: ctx.broadcasts[0]?.["requestId"] as string, approved: false },
      ctx,
    );
    await run;
  });
});
