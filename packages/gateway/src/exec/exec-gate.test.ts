import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NimbusCodeExecutionToml } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { ExecApprovalInput } from "./exec-consent-broker.ts";
import { type ExecGateDeps, type RunExecutionRequest, runExecution } from "./exec-gate.ts";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return db;
}

const CONFIG: NimbusCodeExecutionToml = {
  enabled: true,
  maxWallClockMs: 1000,
  maxOutputBytes: 1024,
  allowedRuntimes: ["bun"],
};

/**
 * A runner that RECORDS whether it was ever asked to spawn, and throws if it was.
 *
 * The refusal tests assert on this spy rather than on an absent side effect: a test that passes
 * because nothing happened is the recurring failure shape in this repo, and it would pass just as
 * happily with the guard deleted.
 */
function spyRunner(active = true): { calls: string[]; runner: SandboxRunner } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      platform: process.platform as "linux" | "darwin" | "win32",
      spawn: (cmd: string) => {
        calls.push(cmd);
        throw new Error("spawn should not have been reached");
      },
      isFullyActive: () => active,
      // Non-null even when fully active -- exactly what the real Windows runner does.
      degradedReason: () => (active ? "windows per-host caveat" : "helper missing"),
      canConfine: () => (active ? null : "helper missing"),
    },
  };
}

function makeDeps(over: Partial<ExecGateDeps> = {}): { spy: string[]; deps: ExecGateDeps } {
  const spy = spyRunner();
  const deps: ExecGateDeps = {
    runner: spy.runner,
    config: CONFIG,
    enforced: { capabilitiesDisabled: new Set<string>() },
    requestApproval: async () => true,
    db: makeTestDb(),
    readFile: () => "console.log(1)",
    now: () => 1_700_000_000_000,
    newId: () => "e1",
    ...over,
  };
  return { spy: spy.calls, deps };
}

const CWD = process.platform === "win32" ? "C:\\tmp" : "/tmp";
const REQ: RunExecutionRequest = {
  code: "console.log(1)",
  fsRead: [],
  fsWrite: [],
  cwd: CWD,
};

function auditRows(db: Database): Array<{ hitl_status: string; action_json: string }> {
  return db
    .query(
      `SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'code.execute' ORDER BY id`,
    )
    .all() as Array<{ hitl_status: string; action_json: string }>;
}

describe("runExecution (I33)", () => {
  test("refuses when the capability is DISABLED BY CONFIG, before consent", async () => {
    let asked = false;
    const { spy, deps } = makeDeps({
      config: { ...CONFIG, enabled: false },
      requestApproval: async () => {
        asked = true;
        return true;
      },
    });
    const out = await runExecution(REQ, deps);
    expect(out.status).toBe("refused");
    // Never prompted: a disabled capability must not advertise its own existence.
    expect(asked).toBe(false);
    expect(spy).toEqual([]);
  });

  test("refuses when ORG POLICY disables code_execution", async () => {
    const { spy, deps } = makeDeps({
      enforced: { capabilitiesDisabled: new Set(["code_execution"]) },
    });
    const out = await runExecution(REQ, deps);
    expect(out.status).toBe("refused");
    expect(spy).toEqual([]);
  });

  test("a DENIED approval spawns NOTHING", async () => {
    const { spy, deps } = makeDeps({ requestApproval: async () => false });
    const out = await runExecution(REQ, deps);
    expect(out.status).toBe("denied");
    expect(spy).toEqual([]);
  });

  test("refuses when the runner is NOT fully active", async () => {
    const s = spyRunner(false);
    const { deps } = makeDeps({ runner: s.runner });
    const out = await runExecution(REQ, deps);
    expect(out.status).toBe("refused");
    expect(s.calls).toEqual([]);
  });

  test("does NOT refuse merely because degradedReason() is non-null (the Windows trap)", async () => {
    // isFullyActive() is true while degradedReason() returns the accepted per-host caveat. A gate
    // keyed on degradedReason() === null would refuse every Windows execution, forever.
    const { deps } = makeDeps({ requestApproval: async () => false });
    const out = await runExecution(REQ, deps);
    // "denied" means it reached consent -- i.e. it was NOT refused on sandbox posture.
    expect(out.status).toBe("denied");
  });

  test("a requested NETWORK grant is refused", async () => {
    const { spy, deps } = makeDeps();
    const out = await runExecution({ ...REQ, network: ["example.com"] }, deps);
    expect(out.status).toBe("refused");
    expect(spy).toEqual([]);
  });

  test("a RELATIVE fs grant is refused, not resolved", async () => {
    const { spy, deps } = makeDeps();
    const out = await runExecution({ ...REQ, fsRead: ["./src"] }, deps);
    expect(out.status).toBe("refused");
    expect(spy).toEqual([]);
  });

  test("an unknown runtime id is refused", async () => {
    const { spy, deps } = makeDeps();
    const out = await runExecution({ ...REQ, runtimeId: "cobol" }, deps);
    expect(out.status).toBe("refused");
    expect(spy).toEqual([]);
  });

  test("a runtime absent from allowed_runtimes is refused", async () => {
    const { spy, deps } = makeDeps({ config: { ...CONFIG, allowedRuntimes: [] } });
    const out = await runExecution(REQ, deps);
    expect(out.status).toBe("refused");
    expect(spy).toEqual([]);
  });

  test("supplying neither code nor filePath is refused", async () => {
    const { deps } = makeDeps();
    const out = await runExecution({ fsRead: [], fsWrite: [], cwd: CWD }, deps);
    expect(out.status).toBe("refused");
  });

  test("--file is read ONCE: bytes mutated after approval do not execute", async () => {
    let reads = 0;
    const bodies = ["APPROVED", "SWAPPED"];
    let approvedBody = "";
    const { deps } = makeDeps({
      readFile: () => bodies[Math.min(reads++, 1)] as string,
      requestApproval: async (input: ExecApprovalInput) => {
        approvedBody = input.codeBody;
        return false; // stop before spawn; we assert only on what was read and shown
      },
    });
    await runExecution({ fsRead: [], fsWrite: [], cwd: CWD, filePath: join(CWD, "s.ts") }, deps);
    expect(approvedBody).toBe("APPROVED");
    expect(reads).toBe(1);
  });

  test("the approval prompt carries the RESOLVED grants, including empty network", async () => {
    let seen: ExecApprovalInput | undefined;
    const { deps } = makeDeps({
      requestApproval: async (i: ExecApprovalInput) => {
        seen = i;
        return false;
      },
    });
    await runExecution({ ...REQ, fsRead: [CWD] }, deps);
    expect(seen?.grants.network).toEqual([]);
    expect(seen?.grants.fsRead).toContain(CWD);
    expect(seen?.codeBody).toBe("console.log(1)");
  });

  test("a DENIED inline execution leaves no scratch directory behind", async () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("nimbus-exec-"));
    const { deps } = makeDeps({ requestApproval: async () => false });
    await runExecution(REQ, deps);
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("nimbus-exec-"));
    expect(after.length).toBe(before.length);
  });

  test("appends exactly one code.execute audit row on denial", async () => {
    const { deps } = makeDeps({ requestApproval: async () => false });
    await runExecution(REQ, deps);
    const rows = auditRows(deps.db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.hitl_status).toBe("rejected");
    const payload = JSON.parse(rows[0]?.action_json ?? "{}") as Record<string, unknown>;
    expect(payload["outcome"]).toBe("denied_by_owner");
    // The body is recorded in full: it is what the owner was asked to approve.
    expect(payload["codeBody"]).toBe("console.log(1)");
  });

  test("appends exactly one code.execute audit row on refusal, naming the reason", async () => {
    const { deps } = makeDeps({ config: { ...CONFIG, enabled: false } });
    await runExecution(REQ, deps);
    const rows = auditRows(deps.db);
    expect(rows.length).toBe(1);
    // The schema CHECK allows only approved/rejected/not_required, so a refusal records `rejected`
    // and is distinguished by `outcome`. `not_required` would wrongly read as "ran without needing
    // approval" on a code.execute row.
    expect(rows[0]?.hitl_status).toBe("rejected");
    const payload = JSON.parse(rows[0]?.action_json ?? "{}") as Record<string, unknown>;
    expect(payload["outcome"]).toBe("refused_before_consent");
    expect(payload["code"]).toBe("ERR_EXEC_DISABLED");
  });

  test("a refusal is never recorded as not_required", async () => {
    // Guards the reasoning above: `not_required` on this action type is the one value an auditor
    // could read as "code ran and no approval was needed".
    for (const over of [
      { config: { ...CONFIG, enabled: false } },
      { enforced: { capabilitiesDisabled: new Set(["code_execution"]) } },
    ]) {
      const { deps } = makeDeps(over);
      await runExecution(REQ, deps);
      expect(auditRows(deps.db).every((r) => r.hitl_status !== "not_required")).toBe(true);
    }
  });

  test("an approved run spawns, captures output, and audits digests", async () => {
    // A real spawn is covered by the integration suite; here the runner is a stub that returns a
    // child which exits cleanly, so the gate's post-spawn bookkeeping is what is under test.
    const { deps } = makeDeps({ runner: stubRunnerThatExits(0, "hi") });
    const out = await runExecution(REQ, deps);
    expect(out.status).toBe("ran");
    if (out.status !== "ran") throw new Error("unreachable");
    expect(out.result.stdout).toBe("hi");
    const rows = auditRows(deps.db);
    expect(rows[0]?.hitl_status).toBe("approved");
    const payload = JSON.parse(rows[0]?.action_json ?? "{}") as Record<string, unknown>;
    expect(typeof payload["stdoutDigest"]).toBe("string");
    // BLAKE3 hex is 64 chars -- the same primitive db/audit-chain.ts uses.
    expect((payload["stdoutDigest"] as string).length).toBe(64);
    expect(payload["exitCode"]).toBe(0);
  });

  test("an APPROVED inline execution also cleans up its scratch directory", async () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("nimbus-exec-"));
    const { deps } = makeDeps({ runner: stubRunnerThatExits(0, "") });
    await runExecution(REQ, deps);
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("nimbus-exec-"));
    expect(after.length).toBe(before.length);
  });
});

/** A runner whose child writes `out` then exits with `code`. */
function stubRunnerThatExits(code: number, out: string): SandboxRunner {
  return {
    platform: process.platform as "linux" | "darwin" | "win32",
    spawn: (_cmd, _args, opts) => {
      // The scratch script must still exist at spawn time -- cleanup racing the spawn would be a
      // real bug, and this assertion is what would catch it.
      const readable = opts.policy.permissions.filesystem.read;
      expect(readable.some((p) => existsSync(p))).toBe(true);
      const { EventEmitter } = require("node:events") as typeof import("node:events");
      const { PassThrough } = require("node:stream") as typeof import("node:stream");
      const child = new EventEmitter() as never as {
        stdout: InstanceType<typeof PassThrough>;
        stderr: InstanceType<typeof PassThrough>;
        kill: () => boolean;
        emit: (e: string, v?: unknown) => boolean;
        on: (e: string, f: (v: unknown) => void) => unknown;
      };
      (child as { stdout: unknown }).stdout = new PassThrough();
      (child as { stderr: unknown }).stderr = new PassThrough();
      (child as { kill: unknown }).kill = () => true;
      queueMicrotask(() => {
        if (out !== "") child.stdout.write(out);
        child.emit("close", code);
      });
      return child as never;
    },
    isFullyActive: () => true,
    degradedReason: () => null,
    canConfine: () => null,
  };
}
