import { describe, expect, test } from "bun:test";
import type { QuorumRule } from "../config/nimbus-toml.ts";
import { computeEnforced, type LocalBaseline } from "./policy-gate.ts";
import { parsePolicyToml } from "./policy-toml.ts";

const baseline: LocalBaseline = {
  retentionDays: 7,
  hitlRequired: new Set(["git.force_push_main"]),
  quorum: new Map<string, QuorumRule>([
    ["terraform.destroy", { approvers: 1, windowSeconds: 600 }],
  ]),
};

describe("computeEnforced — monotonic stricter", () => {
  test("retention floor raises but never lowers", () => {
    const e = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.retention]\nmin_days=30\n`),
      baseline,
    );
    expect(e.retentionDays).toBe(30);
    const e2 = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.retention]\nmin_days=3\n`),
      baseline,
    );
    expect(e2.retentionDays).toBe(7);
  });

  test("HITL required = union; policy cannot drop a local requirement", () => {
    const e = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.hitl]\nrequire=["db.drop"]\n`),
      baseline,
    );
    expect([...e.hitlRequired].sort()).toEqual(["db.drop", "git.force_push_main"]);
  });

  test("quorum approvers = max(local, policy); raise-then-lower toward baseline both apply (no high-water lock)", () => {
    const raise = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=3\nwindow_seconds=900\n`,
      ),
      baseline,
    );
    expect(raise.quorum.get("terraform.destroy")?.approvers).toBe(3);
    const lower = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=2\nwindow_seconds=900\n`,
      ),
      baseline,
    );
    expect(lower.quorum.get("terraform.destroy")?.approvers).toBe(2);
  });

  test("policy below baseline quorum cannot weaken it", () => {
    const e = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=1\nwindow_seconds=900\n`,
      ),
      {
        ...baseline,
        quorum: new Map<string, QuorumRule>([
          ["terraform.destroy", { approvers: 2, windowSeconds: 600 }],
        ]),
      },
    );
    expect(e.quorum.get("terraform.destroy")?.approvers).toBe(2);
  });

  test("connectors allow passes through (undefined = unrestricted)", () => {
    const e = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.connectors]\nallow=["github"]\n`),
      baseline,
    );
    expect(e.connectorAllow).toEqual(["github"]);
  });
});
