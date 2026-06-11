import { describe, expect, it } from "bun:test";
import {
  answerFederatedPreflight,
  type InboundPreflight,
  type PreflightGateCtx,
} from "./preflight-gate.ts";

function makeCtx(over: Partial<PreflightGateCtx> = {}): {
  audits: string[];
  ctx: PreflightGateCtx;
} {
  const audits: string[] = [];
  const ctx: PreflightGateCtx = {
    isPeerGranted: () => true,
    resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/srv/x", timeoutSeconds: 60 }),
    requestApproval: async () => true,
    runCommand: async () => ({ passed: true, summary: "42 passed", durationMs: 12 }),
    audit: (e) => audits.push(e.decision),
    ...over,
  };
  return { audits, ctx };
}

const req: InboundPreflight = {
  peerId: "peer:a",
  namespace: "project:zurich",
  ref: "HEAD~1..HEAD",
  changedSurface: ["api.ts"],
  purpose: "merge",
};

describe("answerFederatedPreflight (I24)", () => {
  it("runs the configured command after approval and returns leak-proof ok", async () => {
    const { ctx, audits } = makeCtx();
    const r = await answerFederatedPreflight(ctx, req);
    expect(r).toEqual({ kind: "ok", passed: true, summary: "42 passed" });
    expect(audits).toContain("answered");
  });

  it("never spawns before approval; a denied approval → denied, zero run", async () => {
    let ran = false;
    const { ctx } = makeCtx({
      requestApproval: async () => false,
      runCommand: async () => {
        ran = true;
        return { passed: true, summary: "", durationMs: 0 };
      },
    });
    const r = await answerFederatedPreflight(ctx, req);
    expect(r).toEqual({ kind: "error", error: "denied" });
    expect(ran).toBe(false);
  });

  it("IGNORES a caller-supplied command field — only the configured command runs", async () => {
    const seen: string[] = [];
    const { ctx } = makeCtx({
      runCommand: async (cfg) => {
        seen.push(cfg.command);
        return { passed: true, summary: "", durationMs: 0 };
      },
    });
    await answerFederatedPreflight(ctx, {
      ...req,
      ...({ command: "rm -rf /", cmd: "evil", args: ["x"] } as object),
    } as InboundPreflight);
    expect(seen).toEqual(["bun"]);
  });

  it("no configured command → not_configured, zero approval, zero run", async () => {
    let asked = false;
    const { ctx } = makeCtx({
      resolveCommand: () => undefined,
      requestApproval: async () => {
        asked = true;
        return true;
      },
    });
    const r = await answerFederatedPreflight(ctx, req);
    expect(r).toEqual({ kind: "error", error: "not_configured" });
    expect(asked).toBe(false);
  });

  it("ungranted peer → opaque no_grant, zero approval", async () => {
    let asked = false;
    const { ctx } = makeCtx({
      isPeerGranted: () => false,
      requestApproval: async () => {
        asked = true;
        return true;
      },
    });
    expect(await answerFederatedPreflight(ctx, req)).toEqual({ kind: "error", error: "no_grant" });
    expect(asked).toBe(false);
  });

  it("invalid ref / oversized surface → no_grant BEFORE approval", async () => {
    let asked = false;
    const { ctx } = makeCtx({
      requestApproval: async () => {
        asked = true;
        return true;
      },
    });
    expect((await answerFederatedPreflight(ctx, { ...req, ref: "bad ref;rm" })).kind).toBe("error");
    expect(
      (await answerFederatedPreflight(ctx, { ...req, changedSurface: Array(201).fill("a") })).kind,
    ).toBe("error");
    expect(asked).toBe(false);
  });

  it("identity-invalid → opaque no_grant", async () => {
    const { ctx } = makeCtx({ identity: { enabled: true, isOperatorValid: () => false } });
    expect(await answerFederatedPreflight(ctx, req)).toEqual({ kind: "error", error: "no_grant" });
  });
});
