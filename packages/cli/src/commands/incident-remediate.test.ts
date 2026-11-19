import { describe, expect, test } from "bun:test";

import { type IncidentIpc, runIncidentWith } from "./incident.ts";
import { INCIDENT_USAGE, parseIncidentArgs } from "./incident-format.ts";
import {
  formatProposals,
  type ProposalLike,
  type ProposalsReply,
  parseRemediationArgs,
  runRemediation,
  TTY_REFUSAL,
} from "./incident-remediate.ts";

const REC = "inc_0123456789abcdef";
const PRP = "prp_0123456789abcdef";
const ACT = "act_0123456789abcdef";
const TTY = { stdin: true, stdout: true };
const NO_TTY = { stdin: false, stdout: false };

function proposal(over: Partial<ProposalLike> = {}): ProposalLike {
  return {
    id: PRP,
    kind: "rollback_deploy",
    toolId: "argocd_app_rollback",
    input: { name: "pay-app", id: 6 },
    evidence: {
      rule: "deploy_before_open:argocd_history",
      items: ["deployment:d1", "argocd:pay-app"],
      blast: {
        service: "payments",
        environment: "prod",
        dependents: ["checkout", "web"],
        dependentsTruncated: false,
      },
      confidence: {
        terms: [
          { name: "deploy_in_window", weight: 40, met: true },
          { name: "deploy_env_bound", weight: 20, met: true },
          { name: "prior_success", weight: 25, met: false },
          { name: "recency", weight: 15, met: true },
        ],
        total: 75,
      },
      dryRun: "no dry run available; the preview shows the target's current state",
      target: "pay-app",
    },
    confidence: 75,
    reversibility: "reversible",
    irreversibleReason: null,
    status: "proposed",
    actionId: null,
    undoStatus: null,
    undoable: false,
    expiresAtMs: 1,
    ...over,
  };
}

function reply(over: Partial<ProposalsReply> = {}): ProposalsReply {
  return {
    recordId: REC,
    version: 3,
    advisory: false,
    proposals: [proposal()],
    unavailable: [{ kind: "flag_revert", code: "flag_no_history", reason: "no flag history" }],
    ...over,
  };
}

function harness(replies: Record<string, unknown | ((p: unknown) => unknown)>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const ipc = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "session.declareKind") return {};
      const r = replies[method];
      if (r instanceof Error) throw r;
      return typeof r === "function" ? (r as (p: unknown) => unknown)(params) : r;
    },
  } as unknown as IncidentIpc;
  return {
    out,
    err,
    calls,
    ipc,
    sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

describe("parsing", () => {
  test("remediate: an id, optional --pick (number or proposal id) and --json, in any order", () => {
    expect(parseRemediationArgs("remediate", [REC])).toEqual({
      verb: "remediate",
      json: false,
      id: REC,
    });
    expect(parseRemediationArgs("remediate", [REC, "--json"])).toEqual({
      verb: "remediate",
      json: true,
      id: REC,
    });
    expect(parseRemediationArgs("remediate", ["--pick", "2", REC])).toEqual({
      verb: "remediate",
      json: false,
      id: REC,
      pick: "2",
    });
    expect(parseRemediationArgs("remediate", [REC, "--pick", PRP])).toMatchObject({ pick: PRP });
  });

  test("remediate: a missing id, a bad or repeated pick, a run with --json, a second id and unknown flags are usage errors", () => {
    for (const bad of [
      [],
      ["--pick", "1"],
      [REC, "--pick"],
      [REC, "--pick", "x"],
      [REC, "--pick", "1000"],
      [REC, "--pick", "prp_short"],
      [REC, "--pick", "1", "--pick", "2"],
      [REC, "--pick", "1", "--json"],
      [REC, "--json", "--json"],
      [REC, "other"],
      [REC, "--force"],
    ]) {
      expect(parseRemediationArgs("remediate", bad)).toBeUndefined();
    }
  });

  test("--yes, -y and every --script-consent-source spelling are usage errors on every verb", () => {
    for (const flag of ["--yes", "-y", "--script-consent-source", "--script-consent-source=ci"]) {
      expect(parseRemediationArgs("remediate", [REC, "--pick", "1", flag])).toBeUndefined();
      expect(parseRemediationArgs("undo", [ACT, flag])).toBeUndefined();
      expect(parseRemediationArgs("advisory", ["on", flag])).toBeUndefined();
    }
  });

  test("undo takes one act_ id or none (the latest); advisory takes on, off or status", () => {
    expect(parseRemediationArgs("undo", [ACT])).toEqual({ verb: "undo", actionId: ACT });
    expect(parseRemediationArgs("undo", [])).toEqual({ verb: "undo" });
    for (const bad of [["act_x"], [REC], [ACT, "x"], ["--act"]]) {
      expect(parseRemediationArgs("undo", bad)).toBeUndefined();
    }
    expect(parseRemediationArgs("advisory", ["on"])).toEqual({
      verb: "advisory",
      json: false,
      action: "on",
    });
    expect(parseRemediationArgs("advisory", ["status", "--json"])).toEqual({
      verb: "advisory",
      json: true,
      action: "status",
    });
    for (const bad of [[], ["maybe"], ["on", "off"], ["on", "--json", "--json"]]) {
      expect(parseRemediationArgs("advisory", bad)).toBeUndefined();
    }
    expect(parseRemediationArgs("list", [])).toBeUndefined();
    expect(parseRemediationArgs(undefined, [])).toBeUndefined();
  });

  test("parseIncidentArgs reaches them, and the usage text names them", () => {
    expect(parseIncidentArgs(["remediate", REC])).toMatchObject({ verb: "remediate" });
    expect(parseIncidentArgs(["undo", ACT])).toMatchObject({ verb: "undo" });
    expect(parseIncidentArgs(["advisory", "off"])).toMatchObject({ verb: "advisory" });
    expect(INCIDENT_USAGE).toContain("nimbus incident remediate");
    expect(INCIDENT_USAGE).toContain("nimbus incident undo");
    expect(INCIDENT_USAGE).toContain("nimbus incident advisory");
  });
});

describe("formatProposals", () => {
  test("the reversibility label is first on each entry; confidence arithmetic, evidence, blast radius and dry run follow", () => {
    const text = formatProposals(reply());
    expect(text).toContain(`Incident ${REC} (record version 3). Advisory mode: off.`);
    expect(text).toContain(
      `1. [reversible] rollback_deploy - argocd_app_rollback name=pay-app id=6  (${PRP})`,
    );
    expect(text).toContain(
      "confidence 75 of 100 = deploy_in_window 40 + deploy_env_bound 20 + recency 15 (not met: prior_success)",
    );
    expect(text).toContain(
      "evidence: deploy_before_open:argocd_history (deployment:d1, argocd:pay-app)",
    );
    expect(text).toContain(
      "blast radius: service payments, environment prod; checkout, web depend on it",
    );
    expect(text).toContain(
      "dry run: no dry run available; the preview shows the target's current state",
    );
    expect(text).toContain("Not available here:");
    expect(text).toContain("  - flag_revert: no flag history");
    expect(text).toContain(`nimbus incident remediate ${REC} --pick <n>`);
  });

  test("an irreversible proposal says so, with its reason, before anything else on its line", () => {
    const text = formatProposals(
      reply({
        proposals: [
          proposal({
            kind: "close",
            toolId: "pd_incident_resolve",
            input: { incidentId: "PD1" },
            reversibility: "irreversible",
            irreversibleReason: "a PagerDuty incident cannot be reopened through Nimbus",
            evidence: { rule: "trigger_open", items: [], confidence: null },
          }),
        ],
      }),
    );
    expect(text).toContain(
      "1. [IRREVERSIBLE: a PagerDuty incident cannot be reopened through Nimbus] close - pd_incident_resolve incidentId=PD1",
    );
    expect(text).toContain("confidence: not scored (this action does not depend on a diagnosis)");
  });

  test("unknown reversibility, no proposals, advisory on, past proposals with their action ids and undo state", () => {
    expect(
      formatProposals(
        reply({
          proposals: [proposal({ reversibility: "unknown", irreversibleReason: null })],
          unavailable: [],
        }),
      ),
    ).toContain("[reversibility unknown]");
    const none = formatProposals(reply({ proposals: [], advisory: true, unavailable: [] }));
    expect(none).toContain("Advisory mode: ON - nothing can be run");
    expect(none).toContain("No remediation is proposed for this record right now.");
    expect(none).not.toContain("Run one with");
    const past = formatProposals(
      reply({
        advisory: true,
        proposals: [
          proposal({ status: "executed", actionId: ACT, undoable: true }),
          proposal({
            id: "prp_1111111111111111",
            status: "executed",
            actionId: "act_1111111111111111",
            undoStatus: "undone",
          }),
          proposal({ id: "prp_2222222222222222", status: "denied" }),
        ],
      }),
    );
    expect(past).toContain(`[executed], action ${ACT}, can be undone: nimbus incident undo`);
    expect(past).toContain("[executed], action act_1111111111111111, undone");
    expect(past).toContain("[denied]");
  });

  test("provider text and control characters never reach the terminal raw", () => {
    const evil = `x\u001b[31m\nINJECT\u202e${"\u0007"}`;
    const text = formatProposals(
      reply({
        recordId: `inc_${evil}`,
        proposals: [
          proposal({
            kind: evil,
            input: { [evil]: evil, n: 5, o: { a: evil } },
            evidence: {
              rule: evil,
              items: [evil],
              blast: {
                service: evil,
                environment: evil,
                dependents: [evil],
                dependentsTruncated: true,
              },
              confidence: { terms: [{ name: evil, weight: 1, met: false }], total: 0 },
              dryRun: evil,
            },
          }),
        ],
        unavailable: [{ kind: evil, code: "x", reason: evil }],
      }),
    );
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
    expect(text).not.toContain("\u0007");
    expect(text.split("\n").some((l) => l.trim() === "INJECT")).toBe(false);
    expect(text).toContain("nothing met");
    expect(text).toContain("and more depend on it");
  });

  test("a proposal with no evidence and an odd input prints without throwing", () => {
    const text = formatProposals(
      reply({ proposals: [proposal({ evidence: null, input: "scalar" })] }),
    );
    expect(text).toContain("1. [reversible]");
    expect(text).toContain("confidence: not scored");
    const bare = formatProposals(
      reply({ proposals: [proposal({ evidence: { items: undefined } as never })] }),
    );
    expect(bare).toContain("1. [reversible]");
    const b2 = formatProposals(
      reply({
        proposals: [
          proposal({
            evidence: {
              rule: "r",
              blast: {
                service: null,
                environment: null,
                dependents: [],
                dependentsTruncated: false,
              },
            },
          }),
        ],
      }),
    );
    expect(b2).toContain("service unbound, environment unknown; no dependent service declared");
  });
});

describe("running", () => {
  test("remediate with no --pick only lists: one read, nothing is run, no terminal needed", async () => {
    const h = harness({ "incident.proposals": reply() });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "remediate", json: false, id: REC },
      h.sink,
      0,
      NO_TTY,
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.proposals"]);
    expect(h.out.join("")).toContain("1. [reversible]");
  });

  test("--json prints the reply as is", async () => {
    const h = harness({ "incident.proposals": reply() });
    await runIncidentWith(h.ipc, { verb: "remediate", json: true, id: REC }, h.sink, 0, NO_TTY);
    expect(JSON.parse(h.out.join("")).recordId).toBe(REC);
  });

  test("--pick without a terminal is refused before any call, exit 2", async () => {
    const h = harness({});
    const code = await runRemediation(
      h.ipc,
      { verb: "remediate", json: false, id: REC, pick: "1" },
      h.sink,
      NO_TTY,
    );
    expect(code).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain(TTY_REFUSAL);
    const half = await runRemediation(h.ipc, { verb: "undo", actionId: ACT }, h.sink, {
      stdin: true,
      stdout: false,
    });
    expect(half).toBe(2);
    expect(h.calls).toEqual([]);
  });

  test("--pick N runs the Nth OPEN proposal by its id, prints the action and the undo hint", async () => {
    const h = harness({
      "incident.proposals": reply({
        proposals: [proposal({ status: "denied", id: "prp_3333333333333333" }), proposal()],
      }),
      "incident.remediate": {
        proposalId: PRP,
        actionId: ACT,
        status: "executed",
        nonHuman: false,
        undoable: true,
      },
    });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "remediate", json: false, id: REC, pick: "1" },
      h.sink,
      0,
      TTY,
    );
    expect(code).toBe(0);
    expect(h.calls.at(-1)).toEqual({
      method: "incident.remediate",
      params: { id: REC, proposalId: PRP },
    });
    expect(h.out.join("")).toContain(
      `Done. Action ${ACT}. Undo with: nimbus incident undo (while it is the latest) or nimbus incident undo ${ACT}`,
    );
    expect(h.out.join("")).toContain("Running [reversible] rollback_deploy");
  });

  test("--pick prp_... picks by id; an unknown pick calls nothing and exits 1", async () => {
    const ok = harness({
      "incident.proposals": reply(),
      "incident.remediate": {
        proposalId: PRP,
        actionId: ACT,
        status: "executed",
        nonHuman: false,
        undoable: false,
      },
    });
    expect(
      await runRemediation(
        ok.ipc,
        { verb: "remediate", json: false, id: REC, pick: PRP },
        ok.sink,
        TTY,
      ),
    ).toBe(0);
    expect(ok.out.join("")).toContain(`Done. Action ${ACT}.`);
    expect(ok.out.join("")).not.toContain("Undo with");
    for (const pick of ["2", "prp_ffffffffffffffff"]) {
      const h = harness({ "incident.proposals": reply() });
      expect(
        await runRemediation(h.ipc, { verb: "remediate", json: false, id: REC, pick }, h.sink, TTY),
      ).toBe(1);
      expect(h.calls.map((c) => c.method)).toEqual(["incident.proposals"]);
      expect(h.err.join("")).toContain("No such proposal is open");
    }
  });

  test("a decline, a failure and a non-human approval exit 1 with their reason", async () => {
    for (const [status, reason, nonHuman, expected] of [
      ["denied", "the owner declined", false, "Not run: the owner declined"],
      ["failed", "boom", false, "Failed: boom"],
      ["denied", "x", true, "the approval did not come from a person"],
      ["failed", undefined, false, "Failed: no reason given"],
    ] as const) {
      const h = harness({
        "incident.proposals": reply(),
        "incident.remediate": {
          proposalId: PRP,
          actionId: ACT,
          status,
          reason,
          nonHuman,
          undoable: false,
        },
      });
      expect(
        await runRemediation(
          h.ipc,
          { verb: "remediate", json: false, id: REC, pick: "1" },
          h.sink,
          TTY,
        ),
      ).toBe(1);
      expect(h.err.join("")).toContain(expected);
    }
  });

  test("bare undo asks the gateway for the latest undoable action and says so first", async () => {
    const h = harness({ "incident.undo": { actionId: ACT, status: "undone", nonHuman: false } });
    expect(await runRemediation(h.ipc, { verb: "undo" }, h.sink, TTY)).toBe(0);
    expect(h.calls[0]).toEqual({ method: "incident.undo", params: { last: true } });
    expect(h.out.join("")).toContain("Undoing the most recent action the incident engine ran");
    expect(h.out.join("")).toContain(`Undone. Action ${ACT} was reversed.`);
    const noTty = harness({});
    expect(await runRemediation(noTty.ipc, { verb: "undo" }, noTty.sink, NO_TTY)).toBe(2);
    expect(noTty.calls).toHaveLength(0);
  });

  test("undo: done, declined, failed, non-human", async () => {
    const done = harness({ "incident.undo": { actionId: ACT, status: "undone", nonHuman: false } });
    expect(await runRemediation(done.ipc, { verb: "undo", actionId: ACT }, done.sink, TTY)).toBe(0);
    expect(done.out.join("")).toContain(`Undone. Action ${ACT} was reversed.`);
    expect(done.calls[0]).toEqual({ method: "incident.undo", params: { actionId: ACT } });
    for (const [status, reason, nonHuman, expected] of [
      ["denied", "no", false, "Not undone: no"],
      ["failed", "down", false, "Undo failed: down"],
      ["denied", "x", true, "the approval did not come from a person"],
      ["failed", undefined, false, "no reason given"],
    ] as const) {
      const h = harness({ "incident.undo": { actionId: ACT, status, reason, nonHuman } });
      expect(await runRemediation(h.ipc, { verb: "undo", actionId: ACT }, h.sink, TTY)).toBe(1);
      expect(h.err.join("")).toContain(expected);
    }
  });

  test("advisory: status reads, on and off set; --json prints the reply", async () => {
    const h = harness({
      "incident.advisory": { advisory: true },
      "incident.advisorySet": (p: unknown) => ({ advisory: (p as { on: boolean }).on }),
    });
    expect(
      await runRemediation(
        h.ipc,
        { verb: "advisory", json: false, action: "status" },
        h.sink,
        NO_TTY,
      ),
    ).toBe(0);
    expect(h.out.join("")).toContain("Advisory mode is ON");
    await runRemediation(h.ipc, { verb: "advisory", json: false, action: "off" }, h.sink, NO_TTY);
    expect(h.calls.at(-1)).toEqual({ method: "incident.advisorySet", params: { on: false } });
    expect(h.out.join("")).toContain("Advisory mode is off.");
    await runRemediation(h.ipc, { verb: "advisory", json: true, action: "on" }, h.sink, NO_TTY);
    expect(h.calls.at(-1)).toEqual({ method: "incident.advisorySet", params: { on: true } });
    expect(h.out.at(-1)).toBe('{"advisory":true}\n');
  });

  test("a gateway refusal is printed (stripped) and exits 1, as a JSON error with --json", async () => {
    const h = harness({
      "incident.remediate": new Error("ERR_ADVISORY_MODE: advisory mode is on\u001b[0m"),
      "incident.proposals": reply(),
    });
    expect(
      await runIncidentWith(
        h.ipc,
        { verb: "remediate", json: false, id: REC, pick: "1" },
        h.sink,
        0,
        TTY,
      ),
    ).toBe(1);
    expect(h.err.join("")).toContain("ERR_ADVISORY_MODE: advisory mode is on");
    expect(h.err.join("")).not.toContain("\u001b");
    const j = harness({ "incident.proposals": new Error("ERR_INCIDENT_NOT_FOUND: no") });
    expect(
      await runIncidentWith(j.ipc, { verb: "remediate", json: true, id: REC }, j.sink, 0, TTY),
    ).toBe(1);
    expect(JSON.parse(j.out.join(""))).toEqual({ error: "ERR_INCIDENT_NOT_FOUND: no" });
    const u = harness({ "incident.undo": new Error("ERR_UNDO_REFUSED: x") });
    expect(await runIncidentWith(u.ipc, { verb: "undo", actionId: ACT }, u.sink, 0, TTY)).toBe(1);
    expect(u.err.join("")).toContain("ERR_UNDO_REFUSED: x");
  });
});
