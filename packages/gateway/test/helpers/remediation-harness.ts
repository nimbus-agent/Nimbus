// Test helpers for the remediation service tests: the harness over the REAL ToolExecutor
// (`buildRemediationExecutor`), real SQLite and a fake dispatcher. Moved out of `remediation.test.ts`, whose
// size is locked by `audit:file-size`; `argoReply` lets a test change what the before-state read returns.
import type { Database } from "bun:sqlite";

import type { EgressEntry } from "../../src/egress/egress-record.ts";
import { buildRemediationExecutor } from "../../src/engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../../src/engine/types.ts";
import { buildRecord } from "../../src/incident/__fixtures__/record-builder.ts";
import type { DeploymentView } from "../../src/incident/incident-record-types.ts";
import { upsertIncidentRecord } from "../../src/incident/incident-store.ts";
import { createRemediation, type MakeExecutor } from "../../src/incident/remediation.ts";
import type { LocalIndex } from "../../src/index/local-index.ts";
import type { ConsentCoordinator } from "../../src/ipc/consent.ts";

export const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const NOW = 5_000_000;
export const OPENED = NOW - 60_000;

export const DEPLOYMENT: DeploymentView = {
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

export const ARGO_REPLY = {
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

export type Harness = {
  readonly svc: ReturnType<typeof createRemediation>;
  readonly prompts: string[];
  readonly confirms: string[];
  readonly dispatched: PlannedAction[];
  readonly egress: EgressEntry[];
  readonly recordId: string;
  setAnswer(a: { approved: boolean; source?: string }): void;
  makeCalls(): number;
};

export function makeRemediationHarness(
  db: Database,
  localIndex: LocalIndex,
  opts: {
    argoReply?: unknown;
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
      if (action.type === "argocd.before.read") return opts.argoReply ?? ARGO_REPLY;
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

export const pick = (h: Harness, kind: string): string => {
  const p = h.svc.proposals(h.recordId).proposals.find((x) => x.kind === kind);
  if (p === undefined) throw new Error(`no ${kind} proposal`);
  return p.id;
};
