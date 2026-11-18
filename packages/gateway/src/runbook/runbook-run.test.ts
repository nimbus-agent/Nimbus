// Phase 10 IC6: running an owner-authored runbook over the REAL ToolExecutor (`buildRemediationExecutor`), real
// SQLite and a fake dispatcher. Each read and action step is one execute(); the owner approves an action through the
// real gate (a typed confirmation for a Wave 4 row) and the audit row carries the incident link and the runbook step.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EgressEntry } from "../egress/egress-record.ts";
import { buildRemediationExecutor } from "../engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import type { DeploymentView } from "../incident/incident-record-types.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import { setAdvisory } from "../incident/proposal-store.ts";
import type { MakeExecutor } from "../incident/remediation.ts";
import { listRunbookSteps } from "../incident/runbook-step-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { createRunbooks, RUNBOOK_READ_RESULT_MAX, RunbookError } from "./runbook-run.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NOW = 5_000_000;

const DEPLOYMENT: DeploymentView = {
  id: "deployment:d1",
  title: "Deploy",
  url: null,
  provider: "github_actions",
  environment: "prod",
  sha: SHA,
  ref: "main",
  startedAtMs: NOW - 2000,
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
    ],
  },
};

const PAY = `
name = "pay-rollback"
[match]
services = ["payments"]
title = "latency"

[[steps]]
kind = "check"
text = "Open the dashboard"

[[steps]]
kind = "read"
service = "argocd"
tool = "argocd_get"
params = { name = "{binding.argocd_app}" }

[[steps]]
kind = "action"
tool = "argocd_app_rollback"
params = { name = "{binding.argocd_app}", id = 6 }

[[steps]]
kind = "action"
tool = "argocd_app_rollback"
params = { name = "{binding.argocd_app}", id = 6, sha = "{deploy.sha}" }
`;

const OTHER = `
name = "checkout-only"
[match]
services = ["checkout"]
[[steps]]
kind = "check"
text = "x"
`;

let db: Database;
let localIndex: LocalIndex;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-rb-run-"));
  mkdirSync(join(dir, "runbooks"));
  writeFileSync(join(dir, "runbooks", "pay.toml"), PAY);
  writeFileSync(join(dir, "runbooks", "other.toml"), OTHER);
  writeFileSync(join(dir, "runbooks", "broken.toml"), "= =");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Harness = {
  readonly svc: ReturnType<typeof createRunbooks>;
  readonly prompts: string[];
  readonly confirms: string[];
  readonly dispatched: PlannedAction[];
  readonly egress: EgressEntry[];
  readonly recordId: string;
  makes(): number;
  setAnswer(a: { approved: boolean; source?: string }): void;
};

function harness(
  opts: {
    deployment?: boolean;
    readReply?: unknown;
    throwOn?: string;
    ready?: () => boolean;
    configDir?: string | undefined;
    onPrompt?: () => Promise<void>;
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
      await opts.onPrompt?.();
      return { approved: answer.approved, answerSource: answer.source as "human" };
    },
    requestConfirmedConsent: async (_c, p) => {
      prompts.push(p.prompt);
      confirms.push(p.confirmText);
      await opts.onPrompt?.();
      return { approved: answer.approved, typed: p.confirmText, answerSource: answer.source as "human" };
    },
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      if (opts.throwOn === action.type) throw new Error("connector\u0007 exploded");
      if (action.type === "argocd.before.read") return ARGO_REPLY;
      if (action.type === "argocd.runbook.read") return opts.readReply ?? ARGO_REPLY;
      return { status: "requested" };
    },
  };
  const makeExecutor: MakeExecutor = ({ clientId, onCaptured, onNonHuman }) => {
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
    });
  };
  const base = buildRecord({ boundService: "payments", openedAtMs: NOW - 60_000 });
  const record =
    opts.deployment === true ? { ...base, change: { ...base.change, deployment: DEPLOYMENT } } : base;
  const up = upsertIncidentRecord(db, { record, markdown: "m", recordSha256: "h", citedServices: [], nowMs: 1 });
  let n = 0;
  const svc = createRunbooks({
    db,
    makeExecutor,
    configDir: () => ("configDir" in opts ? opts.configDir : dir),
    bindingsFor: () => ({ argocdApps: ["pay-app"], deployEnvironments: ["prod"] }),
    ...(opts.ready === undefined ? {} : { ready: opts.ready }),
    now: () => NOW,
    newActionId: () => `act_${String(++n).padStart(16, "0")}`,
  });
  return {
    svc,
    prompts,
    confirms,
    dispatched,
    egress,
    recordId: up.recordId,
    makes: () => makes,
    setAnswer: (a) => {
      answer = { approved: a.approved, source: a.source ?? "human" };
    },
  };
}

async function rejection(p: Promise<unknown> | (() => unknown)): Promise<RunbookError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof RunbookError) return e;
    throw e;
  }
  throw new Error("expected a RunbookError");
}

describe("listing", () => {
  test("shows the runbooks that match, each step with its state, and the files it refused", () => {
    const h = harness();
    const out = h.svc.list(h.recordId);
    expect(out.runbooks.map((r) => r.name)).toEqual(["pay-rollback"]);
    expect(out.errors).toEqual([{ file: "broken.toml", reason: "the file is not valid TOML" }]);
    expect(out.advisory).toBe(false);
    const steps = out.runbooks[0]?.steps ?? [];
    expect(steps[0]).toEqual({ n: 1, kind: "check", text: "Open the dashboard", status: null });
    expect(steps[1]).toMatchObject({ n: 2, kind: "read", service: "argocd", tool: "argocd_get", status: null });
    expect(steps[2]).toMatchObject({
      n: 3,
      kind: "action",
      tool: "argocd_app_rollback",
      wave: 4,
      reversibility: "reversible",
      params: { name: "{binding.argocd_app}", id: 6 },
    });
  });

  test("a named runbook is shown even when it does not match, marked so", () => {
    const h = harness();
    const out = h.svc.list(h.recordId, "checkout-only");
    expect(out.runbooks.map((r) => [r.name, r.matched])).toEqual([["checkout-only", false]]);
  });

  test("no config directory means no runbooks; an unknown record or runbook is refused", async () => {
    const h = harness({ configDir: undefined });
    expect(h.svc.list(h.recordId).runbooks).toEqual([]);
    expect((await rejection(() => h.svc.list("inc_ffffffffffffffff"))).code).toBe("ERR_INCIDENT_NOT_FOUND");
    expect((await rejection(() => harness().svc.list(h.recordId, "nope"))).code).toBe("ERR_RUNBOOK_NOT_FOUND");
    expect((await rejection(() => harness().svc.list(h.recordId, "Bad Name"))).code).toBe(
      "ERR_RUNBOOK_NOT_FOUND",
    );
  });
});

describe("an action step, end to end through the real gate", () => {
  test("interpolates typed values, shows the runbook proposer line, types the confirm text and dispatches once", async () => {
    const h = harness();
    const out = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "cli-1" });
    expect(out).toEqual({
      runbook: "pay-rollback",
      step: 3,
      kind: "action",
      actionId: "act_0000000000000001",
      status: "ok",
      nonHuman: false,
    });
    expect(h.confirms).toEqual(["argocd/rollback pay-app@6"]);
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain("Proposed by: runbook pay-rollback, step 3");
    expect(prompt).toContain(
      "Reversibility: reversible (declared); nimbus incident undo does not reverse a runbook step",
    );
    expect(prompt).not.toContain("Proposed by: the incident engine");
    expect(h.dispatched.map((a) => a.type)).toEqual(["argocd.before.read", "argocd.app.rollback"]);
    expect(h.dispatched[1]?.payload).toEqual({
      mcpToolId: "argocd_argocd_app_rollback",
      input: { name: "pay-app", id: 6 },
    });
    const row = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'argocd.app.rollback'")
      .get() as { action_json: string };
    expect(row.action_json.startsWith(`{"incident":{"id":"${h.recordId}","version":1}`)).toBe(true);
    expect(row.action_json).toContain(
      '"runbookStep":{"runbook":"pay-rollback","step":3,"kind":"action","reversibility":"reversible"}',
    );
    expect(row.action_json).not.toContain('"origin"');
    expect(h.egress.length).toBeGreaterThanOrEqual(2);
    const state = listRunbookSteps(db, h.recordId, "pay-rollback", storedSha());
    expect(state.map((s) => [s.step, s.status, s.action_id])).toEqual([[3, "ok", "act_0000000000000001"]]);
  });

  test("a denial is recorded denied; an approval that did not come from a person is flagged", async () => {
    const h = harness();
    h.setAnswer({ approved: false });
    const denied = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "cli-1" });
    expect(denied.status).toBe("denied");
    expect(h.dispatched.map((a) => a.type)).toEqual(["argocd.before.read"]);
    h.setAnswer({ approved: true, source: "auto" });
    const auto = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "cli-1" });
    expect(auto).toMatchObject({ status: "denied", nonHuman: true });
    expect(h.svc.list(h.recordId).runbooks[0]?.steps[2]?.status).toBe("denied");
  });

  test("a connector failure is recorded failed with its text flattened", async () => {
    const h = harness({ throwOn: "argocd.app.rollback" });
    const out = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "cli-1" });
    expect(out.status).toBe("failed");
    expect(out.reason).not.toContain("\u0007");
    expect(h.svc.list(h.recordId).runbooks[0]?.steps[2]?.status).toBe("failed");
  });

  test("a parameter with no typed value refuses before any executor is built", async () => {
    const h = harness();
    const e = await rejection(h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 4, clientId: "c" }));
    expect(e.code).toBe("ERR_RUNBOOK_PARAM_REFUSED");
    expect(e.message).toBe("{deploy.sha}: the incident has no correlated deployment");
    expect(h.makes()).toBe(0);
  });

  test("the same step runs once the record has the typed value", async () => {
    const ok = harness({ deployment: true });
    const out = await ok.svc.run({ ref: ok.recordId, runbook: "pay-rollback", step: 4, clientId: "c" });
    expect(out.status).toBe("ok");
    expect(ok.dispatched[1]?.payload).toMatchObject({ input: { sha: SHA } });
  });

  test("advisory mode refuses an action step before anything; a read still runs", async () => {
    const h = harness();
    setAdvisory(db, true, NOW);
    const e = await rejection(h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "c" }));
    expect(e.code).toBe("ERR_ADVISORY_MODE");
    expect(h.makes()).toBe(0);
    expect(h.dispatched).toEqual([]);
    expect(h.svc.list(h.recordId).advisory).toBe(true);
    const read = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 2, clientId: "c" });
    expect(read.status).toBe("ok");
  });

  test("a step already running is busy; once it ends it can run again", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({ onPrompt: () => gate });
    const first = h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "c" });
    await new Promise((r) => setTimeout(r, 10));
    const e = await rejection(h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "c" }));
    expect(e.code).toBe("ERR_RUNBOOK_STEP_BUSY");
    release();
    expect((await first).status).toBe("ok");
    const again = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 3, clientId: "c" });
    expect(again.status).toBe("ok");
  });

  test("a gateway that cannot build an executor refuses", async () => {
    const h = harness({ ready: () => false });
    const e = await rejection(h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 2, clientId: "c" }));
    expect(e.code).toBe("ERR_RUNBOOK_UNAVAILABLE");
  });
});

describe("a read step", () => {
  test("is a <service>.runbook.read of the named tool, with no prompt, and its result is returned once", async () => {
    const h = harness();
    const out = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 2, clientId: "c" });
    expect(out).toMatchObject({ kind: "read", status: "ok", result: ARGO_REPLY });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      type: "argocd.runbook.read",
      payload: { mcpToolId: "argocd_argocd_get", input: { name: "pay-app" } },
      runbookStep: { runbook: "pay-rollback", step: 2, kind: "read" },
    });
    const row = db
      .query("SELECT hitl_status FROM audit_log WHERE action_type = 'argocd.runbook.read'")
      .get() as { hitl_status: string };
    expect(row.hitl_status).toBe("not_required");
  });

  test("a result over the cap is withheld from the reply", async () => {
    const h = harness({ readReply: { blob: "x".repeat(RUNBOOK_READ_RESULT_MAX + 1) } });
    const out = await h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 2, clientId: "c" });
    expect(out).toMatchObject({ status: "ok", resultWithheld: true });
    expect(out.result).toBeUndefined();
  });
});

describe("check steps, step numbers and matching", () => {
  test("a check is marked done, never run; a read or action cannot be marked done", async () => {
    const h = harness();
    expect(h.svc.done({ ref: h.recordId, runbook: "pay-rollback", step: 1 })).toEqual({
      runbook: "pay-rollback",
      step: 1,
      status: "done",
    });
    expect(h.svc.list(h.recordId).runbooks[0]?.steps[0]?.status).toBe("done");
    expect((await rejection(h.svc.run({ ref: h.recordId, runbook: "pay-rollback", step: 1, clientId: "c" }))).code).toBe(
      "ERR_RUNBOOK_STEP_KIND",
    );
    expect((await rejection(() => h.svc.done({ ref: h.recordId, runbook: "pay-rollback", step: 3 }))).code).toBe(
      "ERR_RUNBOOK_STEP_KIND",
    );
  });

  test("a step outside the runbook and a runbook that does not match are refused", async () => {
    const h = harness();
    for (const step of [0, 5, 1.5]) {
      expect((await rejection(() => h.svc.done({ ref: h.recordId, runbook: "pay-rollback", step }))).code).toBe(
        "ERR_RUNBOOK_STEP_NOT_FOUND",
      );
    }
    expect((await rejection(() => h.svc.done({ ref: h.recordId, runbook: "checkout-only", step: 1 }))).code).toBe(
      "ERR_RUNBOOK_NOT_MATCHED",
    );
    writeFileSync(
      join(dir, "runbooks", "other.toml"),
      OTHER.replace('services = ["checkout"]', 'sources = ["jira"]').replace('kind = "check"\ntext = "x"', 'kind = "read"\nservice = "argocd"\ntool = "argocd_get"'),
    );
    expect(
      (await rejection(h.svc.run({ ref: h.recordId, runbook: "checkout-only", step: 1, clientId: "c" }))).code,
    ).toBe("ERR_RUNBOOK_NOT_MATCHED");
  });

  test("editing a runbook starts its state fresh (the state is kept per content hash)", () => {
    const h = harness();
    h.svc.done({ ref: h.recordId, runbook: "pay-rollback", step: 1 });
    writeFileSync(join(dir, "runbooks", "pay.toml"), `${PAY}\n# edited\n`);
    expect(h.svc.list(h.recordId).runbooks[0]?.steps[0]?.status).toBeNull();
  });
});

function storedSha(): string {
  const row = db.query("SELECT runbook_sha256 FROM incident_runbook_step LIMIT 1").get() as {
    runbook_sha256: string;
  };
  return row.runbook_sha256;
}
