// Phase 10 IC5b: `nimbus oncall pushed <id> --remediate` runs the proposal a push carried through the SAME
// `incident.remediate` path as `nimbus incident remediate --pick`, on this connection, at a terminal only.
import { describe, expect, test } from "bun:test";
import {
  type OncallPushedIpc,
  parseOncallPushedArgs,
  runOncallPushedWith,
} from "./oncall-pushed.ts";

const TTY = { stdin: true, stdout: true };
const PROPOSAL = {
  recordId: "inc_0123456789abcdef",
  proposalId: "prp_0123456789abcdef",
  kind: "rollback_deploy",
  toolId: "argocd_app_rollback",
  reversibility: "reversible",
  confidence: 75,
  expiresAtMs: 2,
};
const brief = (proposal: unknown) => ({
  brief: {
    incidentId: "pagerduty:A",
    status: "ok",
    createdAt: 1,
    retriedAt: null,
    title: "t",
    briefMarkdown: "# A",
    failureCode: null,
    delivery: {},
    proposal,
  },
});

function fake(
  responses: Record<string, unknown>,
): OncallPushedIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      const r = responses[method];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
function sink() {
  const s = { out: "", err: "" };
  return {
    s,
    sink: {
      out: (x: string) => {
        s.out += x;
      },
      err: (x: string) => {
        s.err += x;
      },
    },
  };
}
const ARGS = {
  mode: "one",
  incidentId: "pagerduty:A",
  retry: false,
  json: false,
  remediate: true,
} as const;

describe("parse", () => {
  test("--remediate names one push and has no --retry, --json, list or newest form", () => {
    expect(parseOncallPushedArgs(["pagerduty:A", "--remediate"])).toEqual(ARGS);
    expect(parseOncallPushedArgs(["--remediate", "pagerduty:A"])).toEqual(ARGS);
    for (const bad of [
      ["--remediate"],
      ["list", "--remediate"],
      ["pagerduty:A", "--remediate", "--retry"],
      ["pagerduty:A", "--remediate", "--json"],
      ["pagerduty:A", "--remediate", "--yes"],
    ]) {
      expect(parseOncallPushedArgs(bad)).toBeUndefined();
    }
  });
});

describe("run", () => {
  test("not at a terminal: exit 2 and the gateway is not called", async () => {
    const c = fake({});
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(c, ARGS, k, false, { stdin: false, stdout: true })).toBe(2);
    expect(c.calls).toEqual([]);
    expect(s.err).toContain("terminal");
  });

  test("the pushed ids go to incident.remediate on this connection after declaring the cli kind", async () => {
    const c = fake({
      "oncall.pushedGet": brief(PROPOSAL),
      "session.declareKind": {},
      "incident.remediate": {
        proposalId: PROPOSAL.proposalId,
        actionId: "act_0000000000000001",
        status: "executed",
        nonHuman: false,
        undoable: true,
      },
    });
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(c, ARGS, k, false, TTY)).toBe(0);
    expect(c.calls).toEqual([
      ["oncall.pushedGet", { incidentId: "pagerduty:A" }],
      ["session.declareKind", { kind: "cli" }],
      ["incident.remediate", { id: PROPOSAL.recordId, proposalId: PROPOSAL.proposalId }],
    ]);
    expect(s.out).toContain("[reversible] rollback_deploy - argocd_app_rollback");
    expect(s.out).toContain("nimbus incident undo act_0000000000000001");
  });

  test("an irreversible proposal is labelled first", async () => {
    const c = fake({
      "oncall.pushedGet": brief({ ...PROPOSAL, reversibility: "irreversible" }),
      "incident.remediate": {
        proposalId: "x",
        actionId: "y",
        status: "denied",
        nonHuman: false,
        undoable: false,
      },
    });
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(c, ARGS, k, false, TTY)).toBe(1);
    expect(s.out).toContain("[IRREVERSIBLE]");
  });

  test("no push, or a push with no proposal (or an older gateway): exit 1, nothing is run", async () => {
    for (const reply of [{ brief: null }, brief(null), brief(undefined)]) {
      const c = fake({ "oncall.pushedGet": reply });
      const { s, sink: k } = sink();
      expect(await runOncallPushedWith(c, ARGS, k, false, TTY)).toBe(1);
      expect(c.calls.map((x) => x[0])).toEqual(["oncall.pushedGet"]);
      expect(s.err.length).toBeGreaterThan(0);
    }
  });

  test("a stale or expired proposal is refused by the gateway; the owner is told how to list again", async () => {
    const c = fake({
      "oncall.pushedGet": brief(PROPOSAL),
      "incident.remediate": new Error(
        "ERR_PROPOSAL_EXPIRED: that proposal expired; list the proposals again",
      ),
    });
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(c, ARGS, k, false, TTY)).toBe(1);
    expect(s.err).toContain("ERR_PROPOSAL_EXPIRED");
    expect(s.err).toContain(`nimbus incident remediate ${PROPOSAL.recordId}`);
  });

  test("a run the gateway could not record says so and still exits 0", async () => {
    const c = fake({
      "oncall.pushedGet": brief(PROPOSAL),
      "incident.remediate": {
        proposalId: "x",
        actionId: "act_0000000000000002",
        status: "executed",
        reason: "the action ran, but it cannot be undone with nimbus incident undo",
        nonHuman: false,
        undoable: false,
      },
    });
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(c, ARGS, k, false, TTY)).toBe(0);
    expect(s.out).not.toContain("Undo with");
    expect(s.err).toContain("Note: the action ran");
  });

  test("a decline that did not come from a person says so", async () => {
    const c = fake({
      "oncall.pushedGet": brief(PROPOSAL),
      "incident.remediate": {
        proposalId: "x",
        actionId: "y",
        status: "denied",
        nonHuman: true,
        undoable: false,
      },
    });
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(c, ARGS, k, false, TTY)).toBe(1);
    expect(s.err).toContain("did not come from a person");
  });
});
