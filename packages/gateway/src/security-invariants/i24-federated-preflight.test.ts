import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I24 — a federated preflight executes only behind the LOCAL owner's HITL gate", () => {
  test("federation.preflight routes through answerFederatedPreflight (sole inbound path)", async () => {
    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).toContain("answerFederatedPreflight");
  });

  test("the gate never spawns before approval, ignores a caller-supplied command, fails closed", async () => {
    const { answerFederatedPreflight } = await import("../federation/preflight-gate.ts");
    let ran = 0;
    let cmdSeen = "";
    const base = {
      isPeerGranted: () => true,
      resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/x", timeoutSeconds: 60 }),
      runCommand: async (cfg: { command: string }) => {
        ran += 1;
        cmdSeen = cfg.command;
        return { passed: true, summary: "", durationMs: 0 };
      },
      audit: () => {},
    };
    const req = { peerId: "p", namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" };
    // denied → zero run
    await answerFederatedPreflight({ ...base, requestApproval: async () => false }, req);
    expect(ran).toBe(0);
    // approved + a caller-supplied command field → only the configured command runs
    await answerFederatedPreflight({ ...base, requestApproval: async () => true }, {
      ...req,
      ...({ command: "rm -rf /" } as object),
    } as never);
    expect(cmdSeen).toBe("bun");
    // no local config → not_configured, fail-closed
    const r = await answerFederatedPreflight(
      { ...base, resolveCommand: () => undefined, requestApproval: async () => true },
      req,
    );
    expect(r).toEqual({ kind: "error", error: "not_configured" });
  });

  test("D18 confines runPreflightCommand to preflight-gate/preflight-runner", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D18-preflight-runner");
  });
});
