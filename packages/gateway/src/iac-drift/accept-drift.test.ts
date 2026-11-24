// packages/gateway/src/iac-drift/accept-drift.test.ts
// OR-S4-ACCEPT-DRIFT: the owner's accept-drift run. The REAL write row and the REAL `buildIacAcceptExecutor`
// on a human-only consent channel (`humanOnlyConsent`), with fake bound-write capabilities and a fake
// dispatcher: what is proven is who may approve, what the owner is asked to type, and that nothing is
// dispatched without a person's exact answer.
import { describe, expect, test } from "bun:test";
import type { BoundWriteCapabilities, SettledWrite } from "../engine/bound-write-capabilities.ts";
import { buildIacAcceptExecutor } from "../engine/run-ask.ts";
import type { AnswerSource, PlannedAction } from "../engine/types.ts";
import { humanOnlyConsent } from "../ipc/consent.ts";
import { ACCEPT_FAILED_REASON, AcceptNotApprovedError, acceptDrift } from "./accept-drift.ts";

const WD = "/srv/infra/prod";
const PLAN_FILE = "/runs/approved/r1/p1/refresh.tfplan";
const PLAN_HASH = "a".repeat(64);
const PLAN = {
  lines: [
    "Deletes: 0, Replaces: 0, Creates: 0, Updates: 0",
    "Drift: 1 objects changed outside Terraform (they differ from the last saved state):",
    "  [changed outside Terraform] aws_instance.web (aws_instance, registry.terraform.io/hashicorp/aws)",
    "    changed: ami",
  ],
  text: "Drift: 1 objects",
  bytes: 1,
  sha256: "b".repeat(64),
  changeCount: 0,
  deleteCount: 0,
  driftCount: 1,
  driftLines: ["Drift: 1 objects", "  [x] a"],
} as const;

interface Answer {
  readonly approved: boolean;
  readonly typed?: string | undefined;
  readonly answerSource: AnswerSource;
}

function world(answer: (confirmText: string) => Answer, o: { throwOnDispatch?: boolean } = {}) {
  const dispatched: PlannedAction[] = [];
  const asked: Array<{ clientId: string; confirmText: string; prompt: string }> = [];
  let plainAsked = 0;
  const caps: BoundWriteCapabilities = {
    preflight: async () => ({ ok: true, release: () => undefined }),
    settle: async (_id, ctx): Promise<SettledWrite> => {
      await ctx.showPlan?.({ workingDirectory: WD, planFile: PLAN_FILE });
      return {
        values: { planFile: PLAN_FILE, planSha256: PLAN_HASH },
        fields: [{ label: "Plan SHA-256", value: PLAN_HASH }],
        plan: PLAN,
        cleanup: async () => undefined,
      };
    },
  };
  const inner = {
    requestConsent: async () => {
      plainAsked += 1;
      return { approved: true, answerSource: "human" as const };
    },
    requestConfirmedConsent: async (
      clientId: string,
      p: { prompt: string; confirmText: string },
    ) => {
      asked.push({ clientId, confirmText: p.confirmText, prompt: p.prompt });
      const a = answer(p.confirmText);
      return { approved: a.approved, typed: a.typed ?? "", answerSource: a.answerSource };
    },
    rejectAllPending: () => undefined,
    pendingCount: () => 0,
  };
  const audits: string[] = [];
  const makeExecutor = (m: { clientId: string; onNonHuman: () => void }) =>
    buildIacAcceptExecutor({
      clientId: m.clientId,
      consentCoordinator: humanOnlyConsent(inner as never, m.onNonHuman),
      localIndex: {
        recordAudit: (e: { actionType: string }) => audits.push(e.actionType),
      } as never,
      dispatcher: {
        dispatch: async (a: PlannedAction) => {
          dispatched.push(a);
          if (o.throwOnDispatch === true && !a.type.endsWith(".write.prepare")) {
            throw new Error("secret connector text");
          }
          if (a.type.endsWith(".write.prepare")) {
            return {
              planId: "p".repeat(32),
              planFile: "/staging/forged.tfplan",
              planSha256: "f".repeat(64),
              hasChanges: true,
              planJson: "{}",
            };
          }
          return { ok: true, status: "applied" };
        },
        boundWriteCapabilities: caps,
      } as never,
      egressSink: { append: () => undefined },
    });
  const run = (workdir = WD, clientId = "conn-1") =>
    acceptDrift({ approvedWorkdirs: () => [WD], makeExecutor }, { workdir, clientId });
  const writes = () => dispatched.filter((a) => !a.type.endsWith(".write.prepare"));
  return { run, dispatched, writes, asked, audits, plain: () => plainAsked };
}

describe("acceptDrift (the owner's CLI path)", () => {
  test("a person who types the exact text accepts: plan, show, then the write with the gateway's own file and hash", async () => {
    const w = world((t) => ({ approved: true, typed: t, answerSource: "human" }));
    expect(await w.run()).toEqual({ status: "accepted" });
    expect(w.dispatched.map((a) => String(a.payload?.["mcpToolId"]))).toEqual([
      "iac_iac_terraform_plan_refresh_only",
      "iac_iac_terraform_show_json",
      "iac_iac_terraform_apply_refresh_only",
    ]);
    expect(w.writes()[0]?.payload?.["input"]).toEqual({
      workingDirectory: WD,
      planFile: PLAN_FILE,
      planSha256: PLAN_HASH,
    });
    expect(JSON.stringify(w.writes())).not.toContain("forged");
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]?.clientId).toBe("conn-1");
    expect(w.asked[0]?.confirmText).toBe(`iac/accept-drift ${WD}`);
    expect(w.asked[0]?.prompt).toContain("changed: ami");
    expect(w.plain()).toBe(0);
  });

  test.each(["auto", "script", "unknown"] as const)(
    "an approval whose source is %s is declined as not from a person, and nothing is written",
    async (source) => {
      const w = world((t) => ({ approved: true, typed: t, answerSource: source }));
      const out = await w.run();
      expect(out.status).toBe("declined");
      expect(out.status === "declined" ? out.nonHuman : false).toBe(true);
      expect(w.writes()).toEqual([]);
    },
  );

  test("a person's typed text that is not the exact text declines, and nothing is written", async () => {
    const w = world(() => ({
      approved: true,
      typed: `iac/accept-drift ${WD}/`,
      answerSource: "human",
    }));
    const out = await w.run();
    expect(out.status).toBe("declined");
    expect(out.status === "declined" ? out.nonHuman : true).toBe(false);
    expect(w.writes()).toEqual([]);
  });

  test("a person who says no declines", async () => {
    const w = world((t) => ({ approved: false, typed: t, answerSource: "human" }));
    expect((await w.run()).status).toBe("declined");
    expect(w.writes()).toEqual([]);
  });

  test("a directory that is not approved is refused before any executor exists", async () => {
    const w = world((t) => ({ approved: true, typed: t, answerSource: "human" }));
    await expect(w.run("/srv/other")).rejects.toBeInstanceOf(AcceptNotApprovedError);
    expect(w.dispatched).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  test("a failure reads as the fixed text, never the connector's", async () => {
    const w = world((t) => ({ approved: true, typed: t, answerSource: "human" }), {
      throwOnDispatch: true,
    });
    const out = await w.run();
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out).toEqual({ status: "failed", reason: ACCEPT_FAILED_REASON, nonHuman: false });
  });
});
