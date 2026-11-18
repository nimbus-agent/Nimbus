// packages/gateway/src/engine/executor-iac-drift.test.ts
// Phase 10 IaC drift D2 (owner ruling OR-DRIFT-1; I54's one other caller of a prepare step, static D42(h)):
// `ToolExecutor.checkTerraformDrift`. The REAL Terraform apply row, a fake `boundWriteCapabilities` on the
// dispatcher. Every branch it adds to `executor.ts` (pinned at 100%) is covered here.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IAC_PREFLIGHT_REFUSALS } from "../connectors/connector-writes/iac-limits.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import type {
  BoundWriteCapabilities,
  PreflightOutcome,
  SettleContext,
  SettledWrite,
} from "./bound-write-capabilities.ts";
import {
  DRIFT_CHECK_NOT_BUILT_REASON,
  NO_POLICY_OVERLAY,
  PREFLIGHT_FAILED_REASON,
  ToolExecutor,
} from "./executor.ts";
import { PREPARE_REFUSALS, PrepareRefusedError } from "./prepare-step.ts";
import type { PlannedAction } from "./types.ts";

const DIR = join(tmpdir(), "nimbus-drift-test-infra");
const PINNED = join(tmpdir(), "nimbus-drift-test-real");
const PLAN = {
  lines: ["Deletes: 0, Replaces: 0, Creates: 0, Updates: 0", "Drift: none reported by terraform"],
  text: "x",
  bytes: 1,
  sha256: "c".repeat(64),
  changeCount: 0,
  deleteCount: 0,
  driftCount: 2,
  driftLines: [
    "Drift: 2 objects changed outside Terraform (they differ from the last saved state):",
  ],
};
const PLAN_REPLY = {
  planId: "a".repeat(32),
  planFile: join(DIR, "plan.tfplan"),
  planSha256: "b".repeat(64),
  hasChanges: false,
};

interface Opts {
  readonly driftCheck?: boolean;
  readonly caps?: "none";
  readonly preflight?: () => Promise<PreflightOutcome>;
  readonly settle?: (ctx: SettleContext) => Promise<SettledWrite>;
  readonly rows?: "none";
}

function harness(o: Opts = {}) {
  const log: string[] = [];
  const dispatched: PlannedAction[] = [];
  const audits: Array<{ actionType: string; hitlStatus: string }> = [];
  const egress: EgressEntry[] = [];
  const settles: SettleContext[] = [];
  const asked: string[] = [];
  const capabilities: BoundWriteCapabilities = {
    preflight: async (id) => {
      log.push(`preflight:${id}`);
      if (o.preflight !== undefined) return o.preflight();
      return { ok: true, release: () => log.push("release") };
    },
    settle: async (id, ctx) => {
      log.push(`settle:${id}`);
      settles.push(ctx);
      if (o.settle !== undefined) return o.settle(ctx);
      await ctx.showPlan?.({ workingDirectory: ctx.workingDirectory ?? "", planFile: "p" });
      return {
        values: { planFile: "/approved/plan.tfplan", planSha256: "d".repeat(64) },
        fields: [{ label: "Workdir", value: ctx.workingDirectory ?? "" }],
        plan: PLAN,
        cleanup: async () => {
          log.push("cleanup");
        },
      };
    },
  };
  const exec = new ToolExecutor(
    {
      requestApproval: async (p) => {
        asked.push(p);
        return { approved: true, answerSource: "human" as const };
      },
    },
    {
      recordAudit: (e) => {
        audits.push({ actionType: e.actionType, hitlStatus: e.hitlStatus });
      },
    },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        log.push(`dispatch:${a.type}`);
        return a.payload?.["mcpToolId"] === "iac_iac_terraform_show_json"
          ? { planJson: "{}", planSha256: "d".repeat(64) }
          : PLAN_REPLY;
      },
      ...(o.caps === "none" ? {} : { boundWriteCapabilities: capabilities }),
    },
    undefined,
    { append: (e) => egress.push(e) },
    NO_POLICY_OVERLAY,
    undefined,
    o.driftCheck === false ? {} : { driftCheck: true },
    o.rows === "none" ? { rows: [], prepareToolIds: new Set<string>() } : undefined,
  );
  return { exec, log, dispatched, audits, egress, settles, asked };
}

describe("checkTerraformDrift: refusals before any child exists", () => {
  test("an executor not built for drift checks refuses and dispatches nothing", async () => {
    const h = harness({ driftCheck: false });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: DRIFT_CHECK_NOT_BUILT_REASON,
    });
    expect(h.log).toEqual([]);
  });

  test("a table with no Terraform apply row refuses", async () => {
    const h = harness({ rows: "none" });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: PREPARE_REFUSALS.toolNotAllowed,
    });
    expect(h.log).toEqual([]);
  });

  test("a relative workdir is refused by the row's own shape rule, before the preflight", async () => {
    const h = harness();
    const r = await h.exec.checkTerraformDrift("infra");
    expect(r.ok).toBe(false);
    expect(h.log).toEqual([]);
  });

  test("a dispatcher with no capabilities refuses", async () => {
    const h = harness({ caps: "none" });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: PREPARE_REFUSALS.capabilityMissing,
    });
    expect(h.dispatched).toEqual([]);
  });

  test("a preflight that throws is the fixed preflight reason", async () => {
    const h = harness({
      preflight: async () => {
        throw new Error("boom");
      },
    });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: PREFLIGHT_FAILED_REASON,
    });
    expect(h.dispatched).toEqual([]);
  });

  test("a preflight refusal (a busy workdir) is returned as is, with no read", async () => {
    const h = harness({
      preflight: async () => ({ ok: false, reason: IAC_PREFLIGHT_REFUSALS.busy }),
    });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: IAC_PREFLIGHT_REFUSALS.busy,
    });
    expect(h.dispatched).toEqual([]);
  });

  test("a pinned path the shape rule refuses is refused, and the mutex is released", async () => {
    const h = harness({
      preflight: async () => ({
        ok: true,
        workingDirectory: "relative",
        release: () => h.log.push("release"),
      }),
    });
    const r = await h.exec.checkTerraformDrift(DIR);
    expect(r.ok).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.log.at(-1)).toBe("release");
  });
});

describe("checkTerraformDrift: the plan and show reads, never the apply, never a prompt", () => {
  test("runs the plan read, a settle with driftCheck, the show read; returns the plan; cleans up and releases", async () => {
    const h = harness({
      preflight: async () => ({
        ok: true,
        workingDirectory: PINNED,
        release: () => h.log.push("release"),
      }),
    });
    const r = await h.exec.checkTerraformDrift(DIR);
    expect(r).toEqual({ ok: true, workingDirectory: PINNED, plan: PLAN });
    expect(h.dispatched.map((a) => a.type)).toEqual(["iac.write.prepare", "iac.write.prepare"]);
    expect(h.dispatched.map((a) => a.payload?.["mcpToolId"])).toEqual([
      "iac_iac_terraform_plan",
      "iac_iac_terraform_show_json",
    ]);
    expect(h.dispatched[0]?.payload?.["input"]).toEqual({ workingDirectory: PINNED });
    expect(h.settles).toHaveLength(1);
    expect(h.settles[0]?.driftCheck).toBe(true);
    expect(h.settles[0]?.workingDirectory).toBe(PINNED);
    // Every read audited and ledgered; nothing asked; the apply never dispatched.
    expect(h.audits.map((a) => a.actionType)).toEqual(["iac.write.prepare", "iac.write.prepare"]);
    expect(h.egress).toHaveLength(2);
    expect(h.asked).toEqual([]);
    expect(h.dispatched.some((a) => a.type === "iac.terraform.apply")).toBe(false);
    expect(h.log.slice(-2)).toEqual(["cleanup", "release"]);
  });

  test("with no pinned path the caller's workdir is used", async () => {
    const h = harness();
    const r = await h.exec.checkTerraformDrift(DIR);
    expect(r.ok && r.workingDirectory).toBe(DIR);
  });

  test("a settle refusal is its fixed reason, and the mutex is released", async () => {
    const h = harness({
      settle: async () => {
        throw new PrepareRefusedError(PREPARE_REFUSALS.unshowable);
      },
    });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: PREPARE_REFUSALS.unshowable,
    });
    expect(h.log.at(-1)).toBe("release");
  });

  test("a settle that fails some other way is the fixed failed reason, never its text", async () => {
    const h = harness({
      settle: async () => {
        throw new Error("secret path /home/x");
      },
    });
    const r = await h.exec.checkTerraformDrift(DIR);
    expect(r).toEqual({ ok: false, reason: PREPARE_REFUSALS.settleFailed });
  });

  test("an error that is not a refusal at all is the fixed failed reason", async () => {
    // A settle that resolves nothing makes the step throw a TypeError, not a PrepareRefusedError.
    const h = harness({ settle: async () => undefined as unknown as SettledWrite });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: PREPARE_REFUSALS.failed,
    });
    expect(h.log.at(-1)).toBe("release");
  });

  test("a cleanup that throws still releases the mutex and keeps the outcome", async () => {
    const h = harness({
      settle: async () => ({
        values: { planFile: "/approved/plan.tfplan", planSha256: "d".repeat(64) },
        fields: [{ label: "Workdir", value: DIR }],
        plan: PLAN,
        cleanup: async () => {
          throw new Error("rm failed");
        },
      }),
    });
    const r = await h.exec.checkTerraformDrift(DIR);
    expect(r.ok).toBe(true);
    expect(h.log.at(-1)).toBe("release");
  });

  test("a settled write with no plan is unshowable, and is still cleaned up", async () => {
    const h = harness({
      settle: async () => ({
        values: { planFile: "/approved/plan.tfplan", planSha256: "d".repeat(64) },
        fields: [{ label: "Workdir", value: DIR }],
        cleanup: async () => {
          h.log.push("cleanup");
        },
      }),
    });
    expect(await h.exec.checkTerraformDrift(DIR)).toEqual({
      ok: false,
      reason: PREPARE_REFUSALS.unshowable,
    });
    expect(h.log.slice(-2)).toEqual(["cleanup", "release"]);
  });
});
