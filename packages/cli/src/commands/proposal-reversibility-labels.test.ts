// The Unleash toggle in the remediation catalogue (owner ruling 2026-11-27): every CLI surface an incident proposal
// reaches (the `nimbus incident remediate` listing, its dry-run and running lines, `nimbus oncall pushed
// --remediate` and `nimbus audit replay`) names the condition its undo rests on, never plain "reversible".
// The gateway's own prompt is pinned in `remediation-flag-writes.test.ts`.
import { describe, expect, test } from "bun:test";

import {
  type DryRunReply,
  formatDryRun,
  formatProposals,
  type ProposalLike,
} from "./incident-remediate.ts";
import { type PushedProposal, pushedLabel } from "./oncall-pushed.ts";

const { formatReplay } = await import("./audit.ts");

const CONDITION = "the environment already has an active strategy";
const LABEL = `reversible only if ${CONDITION}; otherwise IRREVERSIBLE`;

function proposal(over: Partial<ProposalLike> = {}): ProposalLike {
  return {
    id: "prp_0123456789abcdef",
    kind: "repeat_last",
    toolId: "unleash_feature_toggle",
    input: { projectId: "web", featureName: "f", environment: "production", enabled: false },
    evidence: null,
    confidence: 40,
    reversibility: "reversible",
    reversibleIf: CONDITION,
    irreversibleReason: null,
    status: "proposed",
    actionId: null,
    undoStatus: null,
    undoable: false,
    expiresAtMs: 1,
    ...over,
  };
}

const listing = (p: ProposalLike): string =>
  formatProposals({
    recordId: "inc_0123456789abcdef",
    version: 1,
    advisory: false,
    proposals: [p],
    unavailable: [],
  });

describe("nimbus incident remediate", () => {
  test("the listing heads the Unleash toggle with its condition, and a Split kill with plain reversible", () => {
    expect(listing(proposal())).toContain(`1. [${LABEL}] repeat_last - unleash_feature_toggle`);
    const { reversibleIf: _none, ...plain } = proposal({ toolId: "split_kill", input: {} });
    const split = listing(plain);
    expect(split).toContain("1. [reversible] repeat_last - split_kill");
  });

  test("a condition sent with a class that is not reversible is not shown, and control text is stripped", () => {
    expect(listing(proposal({ reversibility: "unknown" }))).toContain(
      "1. [reversibility unknown] repeat_last",
    );
    const esc = String.fromCodePoint(0x1b);
    expect(listing(proposal({ reversibleIf: `x${esc}[31m` }))).not.toContain(esc);
  });

  test("the dry-run line carries the same label", () => {
    const reply: DryRunReply = {
      proposalId: "prp_0123456789abcdef",
      toolId: "unleash_feature_toggle",
      before: { status: "ok", fields: [] },
      prediction: { verdict: "none", text: "no outcome is predicted for this action" },
      label: "Predicted from a live read; the provider was not asked to simulate the change.",
    } as unknown as DryRunReply;
    expect(formatDryRun(proposal(), reply)).toContain(`Dry run of [${LABEL}] repeat_last`);
  });
});

describe("nimbus oncall pushed --remediate", () => {
  const pushed: PushedProposal = {
    recordId: "inc_0123456789abcdef",
    proposalId: "prp_0123456789abcdef",
    kind: "repeat_last",
    toolId: "unleash_feature_toggle",
    reversibility: "reversible",
    confidence: null,
    expiresAtMs: 1,
  };
  test("names the condition; an older gateway's proposal (none sent) keeps its class", () => {
    expect(pushedLabel({ ...pushed, reversibleIf: CONDITION })).toBe(LABEL);
    expect(pushedLabel(pushed)).toBe("reversible");
    expect(pushedLabel({ ...pushed, reversibility: "irreversible" })).toBe("IRREVERSIBLE");
    expect(pushedLabel({ ...pushed, reversibility: "unknown", reversibleIf: CONDITION })).toBe(
      "unknown",
    );
  });
});

describe("nimbus audit replay", () => {
  test("lists a conditionally reversible proposal with its condition", () => {
    const item = {
      id: "prp_0123456789abcdef",
      kind: "repeat_last",
      toolId: "unleash_feature_toggle",
      status: "executed",
      reversibility: "reversible",
      confidence: null,
      actionId: "act_0123456789abcdef",
      undoStatus: null,
    };
    const text = (items: unknown[]): string =>
      formatReplay({
        ok: true,
        record: {
          id: "inc_0123456789abcdef",
          triggerItemId: "pagerduty:PD1",
          service: "payments",
          currentVersion: 1,
          versions: [],
        },
        actions: [],
        proposals: { note: "listed", items },
        verification: { audit: null, egress: null },
        notes: [],
      } as never);
    expect(text([{ ...item, reversibleIf: CONDITION }])).toContain(
      `[executed]  ${LABEL}, not scored, action act_0123456789abcdef`,
    );
    expect(text([{ ...item, toolId: "split_kill" }])).toContain(
      "[executed]  reversible, not scored",
    );
  });
});
