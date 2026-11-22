// Phase 10 IC5a: the remediation service over the REAL ToolExecutor (`buildRemediationExecutor`), real SQLite
// and a fake dispatcher. The owner approves through the real gate; the audit rows carry the incident link;
// `audit replay` reads them back. Advisory mode refuses before any claim, read or prompt.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { chainVerifiers, replayIncident } from "../audit/incident-replay.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { buildRemediationExecutor } from "../engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { buildRecord } from "./__fixtures__/record-builder.ts";
import type { DeploymentView } from "./incident-record-types.ts";
import { upsertIncidentRecord } from "./incident-store.ts";
import { getProposal, getProposalByAction, setAdvisory } from "./proposal-store.ts";
import {
  blastForPrompt,
  createRemediation,
  type MakeExecutor,
  RemediationError,
} from "./remediation.ts";

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("expected a value");
  return x;
}

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NOW = 5_000_000;
const OPENED = NOW - 60_000;

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

const DEPLOYMENT: DeploymentView = {
  id: "deployment:d1",
  title: "Deploy",
  url: null,
  provider: "github_actions",
  environment: "prod",
  sha: SHA,
  ref: "main",
  startedAtMs: OPENED - 1000,
  finishedAtMs: null,
  conclusion: "success",
  minutesBeforeOpen: 1,
  rule: "last_deployment_before_open",
};

const ARGO_REPLY = {
  metadata: { name: "pay-app" },
  spec: { destination: { server: "https://k", namespace: "pay" } },
  status: {
    sync: { status: "Synced", revision: SHA },
    health: { status: "Healthy" },
    history: [
      { id: 7, revision: SHA, deployedAt: "2026-11-10T10:00:00Z" },
      { id: 6, revision: "b".repeat(40), deployedAt: "2026-11-09T10:00:00Z" },
      { id: 5, revision: "c".repeat(40) },
    ],
  },
};

type Harness = {
  readonly svc: ReturnType<typeof createRemediation>;
  readonly prompts: string[];
  readonly confirms: string[];
  readonly dispatched: PlannedAction[];
  readonly egress: EgressEntry[];
  readonly recordId: string;
  setAnswer(a: { approved: boolean; source?: string }): void;
  makeCalls(): number;
};

function harness(
  opts: {
    deployment?: boolean;
    now?: () => number;
    onPrompt?: () => void;
    dependsOn?: () => ReadonlyMap<string, readonly string[]>;
  } = {},
): Harness {
  const prompts: string[] = [];
  const confirms: string[] = [];
  const dispatched: PlannedAction[] = [];
  const egress: EgressEntry[] = [];
  let answer: { approved: boolean; source: string } = { approved: true, source: "human" };
  let makes = 0;
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      prompts.push(p.prompt);
      opts.onPrompt?.();
      return { approved: answer.approved, answerSource: answer.source as "human" };
    },
    requestConfirmedConsent: async (_c, p) => {
      prompts.push(p.prompt);
      confirms.push(p.confirmText);
      opts.onPrompt?.();
      return {
        approved: answer.approved,
        typed: p.confirmText,
        answerSource: answer.source as "human",
      };
    },
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      if (action.type === "argocd.before.read") return ARGO_REPLY;
      return { status: "requested" };
    },
  };
  const makeExecutor: MakeExecutor = ({ clientId, onCaptured, onNonHuman, dryRun }) => {
    makes += 1;
    const wrapped: ConsentCoordinator = {
      ...coordinator,
      requestConsent: async (c, p) => {
        const a = await coordinator.requestConsent(c, p);
        if (a.approved && a.answerSource !== "human") {
          onNonHuman();
          return { approved: false, answerSource: a.answerSource };
        }
        return a;
      },
      requestConfirmedConsent: async (c, p) => {
        const a = await coordinator.requestConfirmedConsent(c, p);
        if (a.approved && a.answerSource !== "human") {
          onNonHuman();
          return { approved: false, typed: "", answerSource: a.answerSource };
        }
        return a;
      },
    };
    return buildRemediationExecutor({
      clientId,
      consentCoordinator: wrapped,
      localIndex,
      dispatcher,
      egressSink: { append: (e) => egress.push(e) },
      getTribalKbConfig: () => undefined,
      onCaptured,
      dryRun: dryRun === true,
    });
  };
  const base = buildRecord({ boundService: "payments", openedAtMs: OPENED });
  const record =
    opts.deployment === false
      ? base
      : { ...base, change: { ...base.change, deployment: DEPLOYMENT } };
  const up = upsertIncidentRecord(db, {
    record,
    markdown: "m",
    recordSha256: "h",
    citedServices: [],
    nowMs: 1,
  });
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES ('argocd:pay-app', 'argocd', 'application', 'pay-app', 'pay-app', 1, ?, 1)`,
    [
      JSON.stringify({
        history: ARGO_REPLY.status.history.map((h) => ({ id: h.id, revision: h.revision })),
      }),
    ],
  );
  const svc = createRemediation({
    db,
    makeExecutor,
    bindingsFor: () => ({ argocdApps: ["pay-app"], deployEnvironments: ["prod"] }),
    dependsOn: opts.dependsOn ?? (() => new Map([["checkout", ["payments"]]])),
    now: opts.now ?? (() => NOW),
    newActionId: (() => {
      let n = 0;
      return () => `act_${String(++n).padStart(16, "0")}`;
    })(),
  });
  return {
    svc,
    prompts,
    confirms,
    dispatched,
    egress,
    recordId: up.recordId,
    setAnswer: (a) => {
      answer = { approved: a.approved, source: a.source ?? "human" };
    },
    makeCalls: () => makes,
  };
}

const pick = (h: Harness, kind: string): string => {
  const p = h.svc.proposals(h.recordId).proposals.find((x) => x.kind === kind);
  if (p === undefined) throw new Error(`no ${kind} proposal`);
  return p.id;
};

describe("the bad-deploy rollback, end to end through the real gate", () => {
  test("lists the rollback with its label, confidence and the fixed dry-run line", () => {
    const h = harness();
    const view = h.svc.proposals(h.recordId);
    const rb = view.proposals.find((p) => p.kind === "rollback_deploy");
    expect(rb).toMatchObject({
      toolId: "argocd_app_rollback",
      input: { name: "pay-app", id: 6 },
      reversibility: "reversible",
      status: "proposed",
      confidence: 75,
      undoable: false,
    });
    expect(rb?.evidence?.dryRun).toBe(
      "--dry-run reads the target's current state and, where its reader captures it, predicts the outcome; nothing is run",
    );
    expect(view.advisory).toBe(false);
    expect(view.proposals.map((p) => p.kind)).toEqual(["rollback_deploy", "acknowledge", "close"]);
  });

  test("approving runs the before-state read, shows the proposer and label, types the confirm text and dispatches once", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    const out = await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    expect(out).toMatchObject({
      proposalId: id,
      status: "executed",
      nonHuman: false,
      undoable: true,
    });
    expect(h.confirms).toEqual(["argocd/rollback pay-app@6"]);
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain("Proposed by: the incident engine");
    expect(prompt).toContain("Reversibility: reversible - nimbus incident undo can reverse it");
    expect(h.dispatched.map((a) => a.type)).toEqual(["argocd.before.read", "argocd.app.rollback"]);
    expect(h.dispatched[1]?.payload).toMatchObject({ input: { name: "pay-app", id: 6 } });
    const stored = getProposal(db, id);
    expect(stored?.status).toBe("executed");
    expect(JSON.parse(stored?.captured_json ?? "")).toEqual({
      currentHistoryId: "7",
      autoSync: "off",
      historyIds: "7,6,5",
    });
    expect(stored?.action_id).toBe(out.actionId);
    // The write carries no origin and no caller-chosen tool: built from the stored row.
    const writeRow = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'argocd.app.rollback'")
      .get() as { action_json: string };
    expect(writeRow.action_json.startsWith(`{"incident":{"id":"${h.recordId}","version":1}`)).toBe(
      true,
    );
    expect(writeRow.action_json).toContain(
      `"engineProposal":{"proposalId":"${id}","reversibility":"reversible","blast":{`,
    );
    expect(writeRow.action_json).not.toContain('"origin"');
    expect(h.egress.length).toBeGreaterThanOrEqual(2);
  });

  test("undo builds the inverse from the recorded before-state, asks again, rolls back to the current id", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    const out = await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    const undone = await h.svc.undo({ actionId: out.actionId, clientId: "cli-1" });
    expect(undone).toEqual({ actionId: out.actionId, status: "undone", nonHuman: false });
    expect(h.confirms).toEqual(["argocd/rollback pay-app@6", "argocd/rollback pay-app@7"]);
    const writes = h.dispatched.filter((a) => a.type === "argocd.app.rollback");
    expect(writes.map((a) => (a.payload as { input: unknown }).input)).toEqual([
      { name: "pay-app", id: 6 },
      { name: "pay-app", id: 7 },
    ]);
    expect(getProposalByAction(db, out.actionId)).toMatchObject({ undo_status: "undone" });
    // Undone once: a second undo is refused and dispatches nothing more.
    const before = h.dispatched.length;
    await expect(h.svc.undo({ actionId: out.actionId, clientId: "cli-1" })).rejects.toMatchObject({
      code: "ERR_UNDO_REFUSED",
      message: "that action was already undone",
    });
    expect(h.dispatched).toHaveLength(before);
  });

  test("audit replay reads the proposal, the prompts, the decisions and the undo, byte-identical twice", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    const out = await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    await h.svc.undo({ actionId: out.actionId, clientId: "cli-1" });
    const a = JSON.stringify(replayIncident(db, h.recordId, chainVerifiers(localIndex)));
    const b = JSON.stringify(replayIncident(db, h.recordId, chainVerifiers(localIndex)));
    expect(a).toBe(b);
    const replay = JSON.parse(a) as {
      proposals: {
        items: Array<{ id: string; status: string; kind: string; undoStatus: string | null }>;
      };
      actions: unknown[];
    };
    const mine = replay.proposals.items.find((p) => p.id === id);
    expect(mine).toMatchObject({
      kind: "rollback_deploy",
      status: "executed",
      undoStatus: "undone",
    });
    expect(a).toContain("Proposed by: the incident engine");
  });
});

describe("denial, failure, busy, stale, expired", () => {
  test("the owner declining marks it denied and dispatches no write", async () => {
    const h = harness();
    h.setAnswer({ approved: false });
    const id = pick(h, "acknowledge");
    const out = await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    expect(out.status).toBe("denied");
    expect(h.dispatched.some((a) => a.type === "pagerduty.incident.acknowledge")).toBe(false);
    expect(getProposal(db, id)?.status).toBe("denied");
    expect(out.undoable).toBe(false);
  });

  test("an approval that did not come from a person is a decline, flagged nonHuman", async () => {
    const h = harness();
    h.setAnswer({ approved: true, source: "auto" });
    const out = await h.svc.remediate({
      ref: h.recordId,
      proposalId: pick(h, "acknowledge"),
      clientId: "cli-1",
    });
    expect(out).toMatchObject({ status: "denied", nonHuman: true });
  });

  test("a throwing executor marks the proposal failed and reports a bounded, control-free reason", async () => {
    const h = harness();
    const throwing = createRemediation({
      db,
      makeExecutor: () => ({
        execute: async () => {
          throw new Error(`boom\n${"x".repeat(500)}`);
        },
      }),
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
    });
    const id =
      throwing.proposals(h.recordId).proposals.find((p) => p.kind === "acknowledge")?.id ?? "";
    const out = await throwing.remediate({ ref: h.recordId, proposalId: id, clientId: "c" });
    expect(out.status).toBe("failed");
    expect(out.reason?.length).toBe(200);
    expect(out.reason).not.toContain("\n");
    expect(getProposal(db, id)?.status).toBe("failed");
    expect(typeof new RemediationError("ERR_ADVISORY_MODE", "x").code).toBe("string");
  });

  test("a non-Error throw is reported as text", async () => {
    const h = harness();
    const svc = createRemediation({
      db,
      makeExecutor: () => ({
        execute: async () => {
          throw "plain";
        },
      }),
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
    });
    const id = svc.proposals(h.recordId).proposals.find((p) => p.kind === "close")?.id ?? "";
    expect((await svc.remediate({ ref: h.recordId, proposalId: id, clientId: "c" })).reason).toBe(
      "plain",
    );
  });

  test("two concurrent remediations of one proposal: exactly one runs, the other is ERR_PROPOSAL_BUSY", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    const settled = await Promise.allSettled([
      h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" }),
      h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "b" }),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((must(rejected[0]).reason as RemediationError).code).toBe("ERR_PROPOSAL_BUSY");
    expect(h.dispatched.filter((a) => a.type === "pagerduty.incident.acknowledge")).toHaveLength(1);
  });

  test("an executed proposal cannot run again (stale), and nothing is dispatched", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" });
    const n = h.dispatched.length;
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_PROPOSAL_STALE",
    });
    expect(h.dispatched).toHaveLength(n);
  });

  test("a proposal the record no longer offers is ERR_PROPOSAL_STALE and is marked superseded", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    db.run("DELETE FROM item WHERE id = 'argocd:pay-app'");
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_PROPOSAL_STALE",
    });
    expect(getProposal(db, id)?.status).toBe("superseded");
    expect(h.makeCalls()).toBe(0);
  });

  test("an expired proposal is ERR_PROPOSAL_EXPIRED until the owner lists again", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    db.run("UPDATE incident_proposal SET expires_at_ms = ? WHERE id = ?", [NOW + 1, id]);
    const later = createRemediation({
      db,
      makeExecutor: () => ({ execute: async () => ({ status: "ok", result: {} }) }),
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW + 10,
    });
    await expect(
      later.remediate({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_PROPOSAL_EXPIRED",
    });
    expect(getProposal(db, id)?.status).toBe("expired");
    // An explicit listing revives it with a fresh TTL.
    expect(later.proposals(h.recordId).proposals.find((p) => p.id === id)?.status).toBe("proposed");
    const out = await later.remediate({ ref: h.recordId, proposalId: id, clientId: "a" });
    expect(out.status).toBe("executed");
  });

  test("unknown ids, another record's proposal and a malformed id are refused before any claim", async () => {
    const h = harness();
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: "prp_x", clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_PROPOSAL_NOT_FOUND",
    });
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: "prp_0000000000000000", clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_PROPOSAL_NOT_FOUND" });
    await expect(
      h.svc.remediate({
        ref: "inc_ffffffffffffffff",
        proposalId: "prp_0000000000000000",
        clientId: "a",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INCIDENT_NOT_FOUND",
    });
    const id = pick(h, "acknowledge");
    const other = upsertIncidentRecord(db, {
      record: buildRecord({
        itemId: "pagerduty:OTHER",
        boundService: "payments",
        openedAtMs: OPENED,
      }),
      markdown: "m",
      recordSha256: "h2",
      citedServices: [],
      nowMs: 1,
    });
    await expect(
      h.svc.remediate({ ref: other.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_PROPOSAL_NOT_FOUND",
    });
    expect(h.makeCalls()).toBe(0);
  });

  test("a record that is gone before the call is ERR_INCIDENT_NOT_FOUND and the proposal is untouched", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    db.run("DELETE FROM incident_record_version");
    db.run("DELETE FROM incident_record");
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_INCIDENT_NOT_FOUND" });
    expect(getProposal(db, id)?.status).toBe("proposed");
    expect(h.makeCalls()).toBe(0);
  });

  test("a record that vanishes AFTER the claim fails the claimed proposal and builds no executor", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    // The action id is minted right before the claim: the record disappears in that breath, so the claim
    // (a write to the proposal table alone) succeeds and the link mint, after it, finds no record.
    const svc = createRemediation({
      db,
      makeExecutor: () => {
        throw new Error("never built");
      },
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
      newActionId: () => {
        db.run("DELETE FROM incident_record_version");
        db.run("DELETE FROM incident_record");
        return "act_0000000000000001";
      },
    });
    const out = await svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" });
    expect(out).toMatchObject({ status: "failed", nonHuman: false, undoable: false });
    expect(out.reason).toContain("no incident record has that id");
    expect(getProposal(db, id)?.status).toBe("failed");
    expect(h.makeCalls()).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  test("an executor that cannot be built fails the claimed proposal and dispatches nothing", async () => {
    const h = harness();
    const svc = createRemediation({
      db,
      makeExecutor: () => {
        throw new Error("no executor");
      },
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
    });
    const id = svc.proposals(h.recordId).proposals.find((p) => p.kind === "acknowledge")?.id ?? "";
    const out = await svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" });
    expect(out).toMatchObject({ status: "failed", reason: "no executor" });
    expect(getProposal(db, id)?.status).toBe("failed");
    expect(h.dispatched).toEqual([]);
  });

  test("a gateway that cannot run remediations (ready() false) refuses after the advisory check and before any claim", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    const svc = createRemediation({
      db,
      makeExecutor: () => {
        throw new Error("never");
      },
      ready: () => false,
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
    });
    await expect(
      svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_REMEDIATION_UNAVAILABLE" });
    await expect(
      svc.undo({ actionId: "act_0123456789abcdef", clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_REMEDIATION_UNAVAILABLE" });
    expect(getProposal(db, id)?.status).toBe("proposed");
    // Listing needs no executor.
    expect(svc.proposals(h.recordId).proposals.length).toBeGreaterThan(0);
  });
});

describe("advisory mode refuses BEFORE anything (I57 (b))", () => {
  test("remediate: no record read, no derivation, no claim, no executor, no audit row, no prompt", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    setAdvisory(db, true, NOW);
    const auditBefore = (db.query("SELECT count(*) AS n FROM audit_log").get() as { n: number }).n;
    await expect(
      h.svc.remediate({ ref: "no-such-record", proposalId: "garbage", clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_ADVISORY_MODE",
    });
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_ADVISORY_MODE",
    });
    expect(h.makeCalls()).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect((db.query("SELECT count(*) AS n FROM audit_log").get() as { n: number }).n).toBe(
      auditBefore,
    );
    expect(getProposal(db, id)?.status).toBe("proposed");
    // Proposals are still listed, and say so.
    expect(h.svc.proposals(h.recordId).advisory).toBe(true);
    expect(h.svc.advisory()).toBe(true);
  });

  test("undo is refused the same way, and advisory off restores both", async () => {
    const h = harness();
    const out = await h.svc.remediate({
      ref: h.recordId,
      proposalId: pick(h, "rollback_deploy"),
      clientId: "a",
    });
    expect(h.svc.setAdvisory(true)).toBe(true);
    const before = h.dispatched.length;
    await expect(h.svc.undo({ actionId: out.actionId, clientId: "a" })).rejects.toMatchObject({
      code: "ERR_ADVISORY_MODE",
    });
    expect(h.dispatched).toHaveLength(before);
    expect(h.svc.setAdvisory(false)).toBe(false);
    expect((await h.svc.undo({ actionId: out.actionId, clientId: "a" })).status).toBe("undone");
  });
});

describe("undo refusals carry the label", () => {
  test("an irreversible action names its reason; nothing is claimed or dispatched", async () => {
    const h = harness();
    const out = await h.svc.remediate({
      ref: h.recordId,
      proposalId: pick(h, "close"),
      clientId: "a",
    });
    expect(out.status).toBe("executed");
    expect(out.undoable).toBe(false);
    const before = h.dispatched.length;
    await expect(h.svc.undo({ actionId: out.actionId, clientId: "a" })).rejects.toMatchObject({
      code: "ERR_UNDO_REFUSED",
      message: "irreversible: a PagerDuty incident cannot be reopened through Nimbus",
    });
    expect(h.dispatched).toHaveLength(before);
    expect(getProposalByAction(db, out.actionId)?.undo_status).toBeNull();
  });

  test("not found, malformed, not executed, unknown class, no capture, nothing to undo", async () => {
    const h = harness();
    await expect(h.svc.undo({ actionId: "nope", clientId: "a" })).rejects.toMatchObject({
      code: "ERR_PROPOSAL_NOT_FOUND",
    });
    await expect(
      h.svc.undo({ actionId: "act_00000000000000ff", clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_PROPOSAL_NOT_FOUND" });
    const id = pick(h, "rollback_deploy");
    db.run("UPDATE incident_proposal SET action_id = 'act_00000000000000aa' WHERE id = ?", [id]);
    await expect(
      h.svc.undo({ actionId: "act_00000000000000aa", clientId: "a" }),
    ).rejects.toMatchObject({
      code: "ERR_UNDO_REFUSED",
      message: "that action did not run (it is proposed)",
    });
    db.run(
      "UPDATE incident_proposal SET status = 'executed', tool_id = 'github_pr_comment_x' WHERE id = ?",
      [id],
    );
    await expect(
      h.svc.undo({ actionId: "act_00000000000000aa", clientId: "a" }),
    ).rejects.toMatchObject({
      message: "unknown: Nimbus does not know whether this can be undone",
    });
    db.run("UPDATE incident_proposal SET tool_id = 'argocd_app_rollback' WHERE id = ?", [id]);
    await expect(
      h.svc.undo({ actionId: "act_00000000000000aa", clientId: "a" }),
    ).rejects.toMatchObject({
      message: "no before-state was recorded for it, so the inverse cannot be built",
    });
    db.run("UPDATE incident_proposal SET captured_json = ? WHERE id = ?", [
      '{"currentHistoryId":"6"}',
      id,
    ]);
    await expect(
      h.svc.undo({ actionId: "act_00000000000000aa", clientId: "a" }),
    ).rejects.toMatchObject({
      message: "that call changed nothing, or cannot be reversed from what was recorded",
    });
    db.run("UPDATE incident_proposal SET undo_status = 'undoing' WHERE id = ?", [id]);
    await expect(
      h.svc.undo({ actionId: "act_00000000000000aa", clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_PROPOSAL_BUSY" });
    expect(h.makeCalls()).toBe(0);
  });

  test("a denied undo is retryable; a failed one too", async () => {
    const h = harness();
    const out = await h.svc.remediate({
      ref: h.recordId,
      proposalId: pick(h, "rollback_deploy"),
      clientId: "a",
    });
    h.setAnswer({ approved: false });
    const denied = await h.svc.undo({ actionId: out.actionId, clientId: "a" });
    expect(denied.status).toBe("denied");
    expect(getProposalByAction(db, out.actionId)?.undo_status).toBeNull();
    const failing = createRemediation({
      db,
      makeExecutor: () => ({
        execute: async () => {
          throw new Error("down");
        },
      }),
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
    });
    expect(await failing.undo({ actionId: out.actionId, clientId: "a" })).toMatchObject({
      status: "failed",
      reason: "down",
    });
    expect(getProposalByAction(db, out.actionId)?.undo_status).toBeNull();
    h.setAnswer({ approved: true });
    expect((await h.svc.undo({ actionId: out.actionId, clientId: "a" })).status).toBe("undone");
  });

  test("an undo whose approval came from a script is declined and flagged", async () => {
    const h = harness();
    const out = await h.svc.remediate({
      ref: h.recordId,
      proposalId: pick(h, "rollback_deploy"),
      clientId: "a",
    });
    h.setAnswer({ approved: true, source: "script" });
    expect(await h.svc.undo({ actionId: out.actionId, clientId: "a" })).toMatchObject({
      status: "denied",
      nonHuman: true,
    });
  });
});

describe("the action is built from the stored row, never from the caller", () => {
  test("the tool and input in the audit row are the stored ones whatever the proposal id names", async () => {
    const h = harness();
    const id = pick(h, "close");
    await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" });
    const types = h.dispatched.map((a) => a.type);
    expect(types).toContain("pagerduty.incident.resolve");
    expect(types).not.toContain("pagerduty.incident.acknowledge");
    const w = h.dispatched.find((a) => a.type === "pagerduty.incident.resolve");
    expect((must(w).payload as { input: unknown }).input).toEqual({ incidentId: "PD1" });
    expect(w).not.toHaveProperty("origin");
  });
});

describe("the proposal a push carries (IC5b)", () => {
  test("topProposal is the open proposal with the highest confidence, labels and ids only", () => {
    const h = harness();
    const top = h.svc.topProposal(h.recordId);
    expect(top).toMatchObject({
      recordId: h.recordId,
      kind: "rollback_deploy",
      toolId: "argocd_app_rollback",
      reversibility: "reversible",
      confidence: 75,
    });
    expect(top?.id).toMatch(/^prp_[0-9a-f]{16}$/);
    expect(Object.keys(top ?? {})).not.toContain("input");
    // Naming the top proposal runs nothing: no executor, no prompt, the proposal stays open.
    expect(h.makeCalls()).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(getProposal(db, top?.id ?? "")?.status).toBe("proposed");
  });

  test("a proposal that is no longer open is skipped; none open is null", async () => {
    const h = harness();
    const first = h.svc.topProposal(h.recordId);
    db.run("UPDATE incident_proposal SET status = 'executed' WHERE id = ?", [first?.id ?? ""]);
    const second = h.svc.topProposal(h.recordId);
    expect(second?.id).not.toBe(first?.id);
    db.run("UPDATE incident_proposal SET status = 'executed' WHERE record_id = ?", [h.recordId]);
    expect(h.svc.topProposal(h.recordId)).toBeNull();
  });

  test("a push never revives: a denied or expired proposal stays refused until the owner lists again", async () => {
    const h = harness();
    const ackId = pick(h, "acknowledge");
    const rbId = pick(h, "rollback_deploy");
    db.run("UPDATE incident_proposal SET status = 'denied' WHERE id = ?", [rbId]);
    db.run("UPDATE incident_proposal SET expires_at_ms = ? WHERE id = ?", [NOW - 1, ackId]);
    const top = h.svc.topProposal(h.recordId);
    // The denied rollback and the expired acknowledge are not revived by the push-time derivation.
    expect(getProposal(db, rbId)?.status).toBe("denied");
    expect(getProposal(db, ackId)?.status).toBe("expired");
    expect([rbId, ackId]).not.toContain(top?.id);
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: rbId, clientId: "a" }),
    ).rejects.toBeInstanceOf(RemediationError);
    await expect(
      h.svc.remediate({ ref: h.recordId, proposalId: ackId, clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_PROPOSAL_EXPIRED" });
    expect(h.prompts).toEqual([]);
    // Only the owner's explicit listing revives them.
    h.svc.proposals(h.recordId);
    expect(getProposal(db, rbId)?.status).toBe("proposed");
    expect(getProposal(db, ackId)?.status).toBe("proposed");
  });

  test("a desktop read (revive false) stores but revives nothing; the terminal listing still revives (IC10b)", () => {
    const h = harness();
    const ackId = pick(h, "acknowledge");
    const rbId = pick(h, "rollback_deploy");
    db.run("UPDATE incident_proposal SET status = 'denied' WHERE id = ?", [rbId]);
    db.run("UPDATE incident_proposal SET expires_at_ms = ? WHERE id = ?", [NOW - 1, ackId]);
    const read = h.svc.proposals(h.recordId, { revive: false });
    expect(read.proposals.find((p) => p.id === rbId)?.status).toBe("denied");
    expect(getProposal(db, rbId)?.status).toBe("denied");
    expect(getProposal(db, ackId)?.status).toBe("expired");
    h.svc.proposals(h.recordId);
    expect(getProposal(db, rbId)?.status).toBe("proposed");
    expect(getProposal(db, ackId)?.status).toBe("proposed");
  });

  test("the pushed id goes through the same remediate path: claim, prompt, dispatch", async () => {
    const h = harness();
    const top = h.svc.topProposal(h.recordId);
    const out = await h.svc.remediate({
      ref: top?.recordId ?? "",
      proposalId: top?.id ?? "",
      clientId: "cli-1",
    });
    expect(out.status).toBe("executed");
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Proposed by: the incident engine");
  });
});

describe("a remediation waiting for the owner is never swept as stale (IC5b review)", () => {
  const LATER = NOW + 31 * 60 * 1000;

  test("a push and a listing past the 30-minute bound, while the prompt is open, leave it executing; it records and can be undone", async () => {
    let t = NOW;
    let sawDuringPrompt: string | undefined;
    let id = "";
    const h = harness({
      now: () => t,
      onPrompt: () => {
        t = LATER;
        h.svc.topProposal(h.recordId);
        h.svc.proposals(h.recordId);
        sawDuringPrompt = getProposal(db, id)?.status;
      },
    });
    id = pick(h, "rollback_deploy");
    const out = await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "c" });
    expect(sawDuringPrompt).toBe("executing");
    expect(out).toMatchObject({ status: "executed", undoable: true });
    expect(out.reason).toBeUndefined();
    expect(getProposal(db, id)?.status).toBe("executed");
  });

  test("a row left executing by an earlier process (not in flight here) is still failed by the sweep", () => {
    const h = harness({ now: () => LATER });
    const id = pick(h, "acknowledge");
    db.run("UPDATE incident_proposal SET status = 'executing', updated_at_ms = ? WHERE id = ?", [
      NOW - 1,
      id,
    ]);
    h.svc.proposals(h.recordId);
    expect(getProposal(db, id)?.status).not.toBe("executing");
  });

  test("a write that ran but could not be recorded is reported as executed, not undoable, with the reason", async () => {
    let id = "";
    const h = harness({
      onPrompt: () => {
        db.run("UPDATE incident_proposal SET status = 'failed' WHERE id = ?", [id]);
      },
    });
    id = pick(h, "rollback_deploy");
    const out = await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "c" });
    expect(out.status).toBe("executed");
    expect(out.undoable).toBe(false);
    expect(out.reason).toContain("cannot be undone");
  });
});

describe("the dry run (Phase 17): the before-state reads only, never the write", () => {
  test("a rollback dry run reads once, predicts the move, prompts for nothing and leaves the proposal open", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    const out = await h.svc.dryRun({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    expect(out.proposalId).toBe(id);
    expect(out.toolId).toBe("argocd_app_rollback");
    expect(out.before.status).toBe("ok");
    expect(out.prediction).toEqual({
      verdict: "would_change",
      text: "the application moves from history 7 back to the revision of history 6",
    });
    expect(out.label).toContain("not asked to simulate");
    expect(h.prompts).toEqual([]);
    expect(h.confirms).toEqual([]);
    expect(h.dispatched.map((a) => a.type)).toEqual(["argocd.before.read"]);
    const stored = getProposal(db, id);
    expect(stored?.status).toBe("proposed");
    expect(stored?.action_id).toBeNull();
    expect(stored?.captured_json).toBeNull();
    // The read is audited with the incident link; the write is not audited at all.
    const rows = db.query("SELECT action_type, action_json FROM audit_log").all() as Array<{
      action_type: string;
      action_json: string;
    }>;
    expect(rows.map((r) => r.action_type)).toEqual(["argocd.before.read"]);
    expect(rows[0]?.action_json).toContain(`"incident":{"id":"${h.recordId}"`);
    expect(h.egress.length).toBe(1);
  });

  test("the listing says what --dry-run can do for each proposal", () => {
    const h = harness();
    const view = h.svc.proposals(h.recordId).proposals;
    expect(view.find((p) => p.kind === "rollback_deploy")?.dryRun).toBe("predicted");
    expect(view.find((p) => p.kind === "acknowledge")?.dryRun).toBe("current_state");
  });

  test("an alert proposal shows the current state and predicts nothing", async () => {
    const h = harness();
    const id = pick(h, "acknowledge");
    const out = await h.svc.dryRun({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    expect(out.prediction.verdict).toBe("none");
    expect(h.prompts).toEqual([]);
    expect(h.dispatched.every((a) => a.type.endsWith(".before.read"))).toBe(true);
  });

  test("advisory mode refuses a dry run before any read or executor, like remediate (I57 (b))", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    setAdvisory(db, true, NOW);
    await expect(
      h.svc.dryRun({ ref: h.recordId, proposalId: id, clientId: "cli-1" }),
    ).rejects.toMatchObject({ code: "ERR_ADVISORY_MODE" });
    expect(h.makeCalls()).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  test("a real run's executor is never built for a dry run; a dry run's always is", async () => {
    const seen: (boolean | undefined)[] = [];
    const h = harness();
    const id = pick(h, "acknowledge");
    const svc = createRemediation({
      db,
      makeExecutor: (o) => {
        seen.push(o.dryRun);
        return {
          execute: async () => ({ status: "ok", result: {} }),
          readBeforeOnly: async () => ({ status: "no_reader" }),
        };
      },
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
    });
    await svc.dryRun({ ref: h.recordId, proposalId: id, clientId: "a" });
    await svc.remediate({ ref: h.recordId, proposalId: id, clientId: "a" });
    expect(seen).toEqual([true, undefined]);
  });

  test("a running proposal is ERR_PROPOSAL_BUSY, an expired-status one ERR_PROPOSAL_EXPIRED", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    db.run("UPDATE incident_proposal SET status = 'executing' WHERE id = ?", [id]);
    await expect(
      h.svc.dryRun({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_PROPOSAL_BUSY" });
    db.run("UPDATE incident_proposal SET status = 'expired' WHERE id = ?", [id]);
    await expect(
      h.svc.dryRun({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_PROPOSAL_EXPIRED" });
    expect(h.dispatched).toEqual([]);
  });

  test("an executor without a dry run reads nothing and predicts nothing", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    const svc = createRemediation({
      db,
      makeExecutor: () => ({ execute: async () => ({ status: "ok", result: {} }) }),
      bindingsFor: () => ({ argocdApps: ["pay-app"], deployEnvironments: ["prod"] }),
      dependsOn: () => new Map([["checkout", ["payments"]]]),
      now: () => NOW,
    });
    const out = await svc.dryRun({ ref: h.recordId, proposalId: id, clientId: "a" });
    expect(out.before).toEqual({ status: "no_reader" });
    expect(out.prediction.verdict).toBe("none");
  });

  test("refusals: a malformed id, another record's or a missing proposal, one not open, an expired one, a stale one, not ready", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    const call = (proposalId: string) =>
      h.svc.dryRun({ ref: h.recordId, proposalId, clientId: "a" });
    await expect(call("nope")).rejects.toMatchObject({ code: "ERR_PROPOSAL_NOT_FOUND" });
    await expect(call("prp_0000000000000000")).rejects.toMatchObject({
      code: "ERR_PROPOSAL_NOT_FOUND",
    });
    db.run("UPDATE incident_proposal SET status = 'denied' WHERE id = ?", [id]);
    await expect(call(id)).rejects.toMatchObject({ code: "ERR_PROPOSAL_STALE" });
    db.run("UPDATE incident_proposal SET status = 'proposed', expires_at_ms = ? WHERE id = ?", [
      NOW,
      id,
    ]);
    await expect(call(id)).rejects.toMatchObject({ code: "ERR_PROPOSAL_EXPIRED" });
    db.run("UPDATE incident_proposal SET expires_at_ms = ?, input_json = ? WHERE id = ?", [
      NOW + 60_000,
      JSON.stringify({ name: "pay-app", id: 5 }),
      id,
    ]);
    await expect(call(id)).rejects.toMatchObject({ code: "ERR_PROPOSAL_STALE" });
    expect(getProposal(db, id)?.status).toBe("proposed");
    const notReady = createRemediation({
      db,
      makeExecutor: () => {
        throw new Error("never");
      },
      ready: () => false,
      bindingsFor: () => undefined,
      dependsOn: () => new Map(),
      now: () => NOW,
    });
    await expect(
      notReady.dryRun({ ref: h.recordId, proposalId: id, clientId: "a" }),
    ).rejects.toMatchObject({ code: "ERR_REMEDIATION_UNAVAILABLE" });
    expect(h.dispatched).toEqual([]);
  });
});

describe("Phase 17 one-tap rollback: the blast radius in the prompt", () => {
  test("remediate shows the blast radius derived NOW: the bound service, its environment and its dependents", async () => {
    const h = harness();
    const id = pick(h, "rollback_deploy");
    await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain(
      `Blast radius: service payments, environment ${DEPLOYMENT.environment ?? "unknown"}`,
    );
    expect(prompt).toContain("Depends on it: checkout");
    expect(prompt).not.toContain("as recorded");
  });

  test("a depends_on change between listing and running shows the new dependents (the run re-derives before it claims)", async () => {
    let graph = new Map<string, readonly string[]>([["checkout", ["payments"]]]);
    const h = harness({ dependsOn: () => graph });
    const id = pick(h, "rollback_deploy");
    graph = new Map([
      ["checkout", ["payments"]],
      ["ledger", ["payments"]],
    ]);
    await h.svc.remediate({ ref: h.recordId, proposalId: id, clientId: "cli-1" });
    expect(h.prompts[0]).toContain("Depends on it: checkout, ledger");
  });

  test("a configured name that is not a plain id reaches the prompt only as the unverified line", async () => {
    const h = harness({ dependsOn: () => new Map([["web\u202Echeckout", ["payments"]]]) });
    await h.svc.remediate({
      ref: h.recordId,
      proposalId: pick(h, "rollback_deploy"),
      clientId: "cli-1",
    });
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain(
      "Blast radius: not shown - a name in it is not a plain configuration id; check depends_on before approving",
    );
    expect(prompt).not.toContain("\u202E");
  });

  test("undo shows the blast radius as recorded when the action ran", async () => {
    const h = harness();
    const out = await h.svc.remediate({
      ref: h.recordId,
      proposalId: pick(h, "rollback_deploy"),
      clientId: "cli-1",
    });
    await h.svc.undo({ actionId: out.actionId, clientId: "cli-1" });
    expect(h.prompts[1]).toContain(
      "Blast radius (as recorded when the action ran): service payments",
    );
  });
});

describe("blastForPrompt (the names a prompt may carry)", () => {
  const ok = {
    blast: {
      service: "payments",
      environment: "prod",
      dependents: ["a"],
      dependentsTruncated: false,
    },
  };
  test("a well-formed evidence blast passes through, with the recorded flag", () => {
    expect(blastForPrompt(ok, true)).toEqual({
      service: "payments",
      environment: "prod",
      dependents: ["a"],
      dependentsTruncated: false,
      recorded: true,
    });
  });
  test("no blast in the evidence gives undefined (the prompt says not recorded)", () => {
    for (const e of [null, "x", {}]) expect(blastForPrompt(e, false)).toBeUndefined();
  });
  test("a blast that is not all configuration ids gives the unverified form, never a silent omission", () => {
    const bad: unknown[] = [
      { blast: null },
      { blast: { ...ok.blast, service: "payments" } },
      { blast: { ...ok.blast, environment: "prod\u202E" } },
      { blast: { ...ok.blast, dependents: "a" } },
      { blast: { ...ok.blast, dependents: ["bad name"] } },
      { blast: { ...ok.blast, dependents: Array.from({ length: 21 }, (_, i) => `s${String(i)}`) } },
      { blast: { ...ok.blast, dependentsTruncated: 1 } },
    ];
    for (const b of bad) {
      expect(blastForPrompt(b, false)).toEqual({ unverified: true, recorded: false });
    }
  });
});
