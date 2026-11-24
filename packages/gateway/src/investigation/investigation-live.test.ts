// Owner ruling 9, `nimbus incident investigate --live`: the live Sentry read over the REAL ToolExecutor
// (`buildRemediationExecutor`), real SQLite and a fake dispatcher. Every read is one `execute()` of a
// `sentry.investigate.read` action: gated, audited, I29-ledgered, carrying the incident link; only the issues
// correlated with the record (bound project, inside the window) reach the result; a failure is a named Gap.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { EgressEntry } from "../egress/egress-record.ts";
import { buildRemediationExecutor } from "../engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import type { DeploymentView } from "../incident/incident-record-types.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import { type Investigation, investigateRecord } from "../incident/investigate.ts";
import type { MakeExecutor } from "../incident/remediation.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import {
  createLiveInvestigator,
  LIVE_MAX_PROJECTS,
  LIVE_ROW_CAP,
  LiveInvestigateError,
} from "./investigation-live.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const DEPLOYMENT: DeploymentView = {
  id: "deployment:d1",
  title: "Deploy",
  url: null,
  provider: "github_actions",
  environment: "prod",
  sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  ref: "main",
  startedAtMs: NOW - 30 * MIN,
  finishedAtMs: null,
  conclusion: "success",
  minutesBeforeOpen: 20,
  rule: "last_deployment_before_open",
};

function issue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1001",
    shortId: "PAY-1",
    title: "TypeError in charge()",
    permalink: "https://sentry.example/issues/1001/",
    level: "error",
    status: "unresolved",
    count: "120",
    userCount: 9,
    firstSeen: iso(NOW - 5 * MIN),
    lastSeen: iso(NOW - MIN),
    project: { slug: "payments-api" },
    ...over,
  };
}

const mcp = (body: unknown): unknown => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
});

let db: Database;
const opened: Database[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
});

type Opts = {
  readonly projects?: readonly string[];
  readonly connected?: boolean;
  readonly deployment?: boolean;
  readonly replies?: Record<string, unknown>;
  readonly throwFor?: string;
  readonly delayMs?: number;
  readonly delayFor?: string;
  readonly orgPolicyAsks?: boolean;
  readonly decline?: boolean;
};

function setup(opts: Opts = {}) {
  db = new Database(":memory:");
  opened.push(db);
  LocalIndex.ensureSchema(db);
  const localIndex = new LocalIndex(db);
  const prompts: string[] = [];
  const dispatched: PlannedAction[] = [];
  const egress: EgressEntry[] = [];
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      prompts.push(p.prompt);
      return { approved: opts.decline !== true, answerSource: "human" };
    },
    requestConfirmedConsent: async (_c, p) => {
      prompts.push(p.prompt);
      return { approved: true, typed: p.confirmText, answerSource: "human" };
    },
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      const input = (action.payload?.["input"] ?? {}) as { projectSlug?: string };
      const slug = input.projectSlug ?? "";
      if (opts.throwFor === slug) throw new Error("boom\u001b[31m token=sk-live-123");
      if (opts.delayFor === undefined || opts.delayFor === slug) {
        if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return opts.replies?.[slug] ?? mcp([issue()]);
    },
  };
  let makes = 0;
  const makeExecutor: MakeExecutor = ({ clientId, onCaptured }) => {
    makes += 1;
    return buildRemediationExecutor({
      clientId,
      consentCoordinator: coordinator,
      localIndex,
      dispatcher,
      egressSink: { append: (e) => egress.push(e) },
      policyHitl: {
        isHitlRequiredByPolicy: (t) =>
          opts.orgPolicyAsks === true && t.endsWith(".investigate.read"),
      },
      getTribalKbConfig: () => undefined,
      onCaptured,
    });
  };
  const base = buildRecord({ boundService: "payments", openedAtMs: NOW - 20 * MIN });
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
  if (opts.connected !== false) {
    db.run("INSERT INTO sync_state (connector_id, last_sync_at) VALUES ('sentry', ?)", [NOW - MIN]);
  }
  const cfg = {
    serviceId: "payments",
    sentryProjects: opts.projects ?? ["payments-api"],
  } as unknown as ServiceConfig;
  const inv = investigateRecord(db, {
    recordId: up.recordId,
    nowMs: NOW,
    serviceConfigs: new Map([["payments", cfg]]),
  }) as Investigation;
  const svc = createLiveInvestigator({ db, makeExecutor });
  return { svc, inv, prompts, dispatched, egress, makes: () => makes, recordId: up.recordId };
}

const run = (h: ReturnType<typeof setup>, budgetMs?: number): Promise<Investigation> =>
  h.svc.run({
    investigation: h.inv,
    clientId: "c1",
    ...(budgetMs === undefined ? {} : { budgetMs }),
  });

describe("a live read of the bound project", () => {
  test("is one gated, ledgered sentry.investigate.read per project, with no prompt, linked to the record", async () => {
    const h = setup();
    const out = await run(h);
    expect(h.dispatched).toHaveLength(1);
    const a = h.dispatched[0] as PlannedAction;
    expect(a.type).toBe("sentry.investigate.read");
    expect(a.payload).toEqual({
      mcpToolId: "sentry_sentry_issue_list",
      input: { projectSlug: "payments-api", limit: 50 },
    });
    expect(a.incident).toEqual({ id: h.recordId, version: 1 });
    expect(a.origin).toBeUndefined();
    expect(h.prompts).toEqual([]);
    // The I29 row is appended before the call, to the connector's own destination.
    expect(h.egress).toHaveLength(1);
    expect(h.egress[0]?.destination).toBe("sentry");
    const audit = db
      .query("SELECT action_type, hitl_status FROM audit_log WHERE action_type = ?")
      .get("sentry.investigate.read") as { action_type: string; hitl_status: string } | null;
    expect(audit?.hitl_status).toBe("not_required");
    expect(out.live?.status).toBe("ok");
    expect(out.live?.rows.map((r) => r.issueId)).toEqual(["1001"]);
    expect(out.live?.rows[0]).toMatchObject({
      title: "TypeError in charge()",
      count: 120,
      newSinceDeploy: true,
    });
  });

  test("keeps only issues of the asked project that were active inside the window", async () => {
    const h = setup({
      replies: {
        "payments-api": mcp([
          issue({ id: "1" }),
          issue({ id: "2", lastSeen: iso(NOW - 12 * 3_600_000) }),
          issue({ id: "3", lastSeen: iso(Date.now() + 3_600_000) }),
          issue({ id: "4", project: { slug: "other-project" } }),
          issue({ id: "" }),
          issue({ id: "5", lastSeen: "not a date" }),
          "not an object",
          issue({ id: "6", lastSeen: iso(NOW - 3 * MIN) }),
        ]),
      },
    });
    const out = await run(h);
    expect(out.live?.rows.map((r) => r.issueId)).toEqual(["1", "6"]);
    expect(out.live?.projects).toEqual([
      { project: "payments-api", outcome: "read", scanned: 8, matched: 2 },
    ]);
  });

  test("is returned once and never stored: the record and the index are untouched", async () => {
    const h = setup();
    const before = db.query("SELECT version, record_json FROM incident_record").all();
    const items = db.query("SELECT count(*) AS n FROM item").get();
    await run(h);
    expect(db.query("SELECT version, record_json FROM incident_record").all()).toEqual(before);
    expect(db.query("SELECT count(*) AS n FROM item").get()).toEqual(items as { n: number });
  });

  test("caps the rows, sorts newest first and says how many matched", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      issue({ id: String(2000 + i), lastSeen: iso(NOW - (i + 1) * 1000) }),
    );
    const h = setup({ replies: { "payments-api": mcp(many) } });
    const out = await run(h);
    expect(out.live?.rows).toHaveLength(LIVE_ROW_CAP);
    expect(out.live?.total).toBe(40);
    expect(out.live?.rows[0]?.issueId).toBe("2000");
    expect(out.gaps.map((g) => g.code)).toContain("live_sentry_rows_capped");
  });

  test("adds a lead for an issue first seen after the deployment, labelled timing only", async () => {
    const h = setup();
    const out = await run(h);
    const lead = out.leads.find((l) => l.refId === "1001");
    expect(lead?.kind).toBe("sentry_issue");
    expect(lead?.text).toContain("timing only, not a proven cause");
    const noDeploy = await run(setup({ deployment: false }));
    expect(noDeploy.leads.find((l) => l.refId === "1001")).toBeUndefined();
  });

  test("provider text is one line and a non-http link is dropped", async () => {
    const h = setup({
      replies: {
        "payments-api": mcp([
          issue({
            id: "7",
            title: "line1\nline2\u202eevil",
            permalink: "javascript:alert(1)",
            level: "err\u0007or",
          }),
        ]),
      },
    });
    const row = (await run(h)).live?.rows[0];
    expect(row?.title).toBe("line1 line2evil");
    expect(row?.url).toBeNull();
    expect(row?.level).toBe("err or");
  });
});

describe("a failed, refused, late or unreadable read is a named Gap, never silence", () => {
  test("a throwing connector: fixed reason, no error text anywhere in the result", async () => {
    const h = setup({ throwFor: "payments-api" });
    const out = await run(h);
    expect(out.live).toMatchObject({ status: "not_read" });
    expect(out.live?.projects[0]?.outcome).toBe("failed");
    expect(out.gaps.map((g) => g.code)).toContain("live_sentry_failed");
    expect(JSON.stringify(out)).not.toContain("sk-live-123");
  });

  test("a reply that is not a list of issues is unreadable", async () => {
    const h = setup({ replies: { "payments-api": mcp({ detail: "nope" }) } });
    const out = await run(h);
    expect(out.live?.projects[0]?.outcome).toBe("unreadable");
    expect(out.gaps.map((g) => g.code)).toContain("live_sentry_unreadable");
  });

  test("a read that outlives the budget times out and its late reply is dropped", async () => {
    const h = setup({ delayMs: 200 });
    const out = await run(h, 40);
    expect(out.live?.projects[0]?.outcome).toBe("timeout");
    expect(out.live?.rows).toEqual([]);
    expect(out.gaps.map((g) => g.code)).toContain("live_sentry_timeout");
  });

  test("a read the org policy asks about is put to the person on the asking connection; a decline is a refused read", async () => {
    const declined = setup({ orgPolicyAsks: true, decline: true });
    const out = await run(declined);
    expect(declined.prompts).toHaveLength(1);
    expect(declined.dispatched).toEqual([]);
    expect(out.live?.projects[0]?.outcome).toBe("refused");
    expect(out.gaps.map((g) => g.code)).toContain("live_sentry_refused");
    const approved = setup({ orgPolicyAsks: true });
    expect((await run(approved)).live?.status).toBe("ok");
    expect(approved.prompts).toHaveLength(1);
  });

  test("a spent budget skips the remaining projects, named", async () => {
    const h = setup({
      projects: ["a", "b", "c"],
      delayMs: 60,
      replies: { a: mcp([]), b: mcp([]), c: mcp([]) },
    });
    const out = await run(h, 80);
    const outcomes = out.live?.projects.map((p) => `${p.project}:${p.outcome}`);
    expect(outcomes?.[0]).toBe("a:read");
    expect(
      outcomes?.slice(1).every((o) => o.endsWith("timeout") || o.endsWith("skipped_budget")),
    ).toBe(true);
    expect(out.live?.status).toBe("partial");
  });

  test("more than the project cap are named, not read", async () => {
    const projects = Array.from({ length: LIVE_MAX_PROJECTS + 2 }, (_, i) => `p${String(i)}`);
    const h = setup({ projects, replies: Object.fromEntries(projects.map((p) => [p, mcp([])])) });
    const out = await run(h);
    expect(h.dispatched).toHaveLength(LIVE_MAX_PROJECTS);
    expect(out.live?.projects.filter((p) => p.outcome === "skipped_cap")).toHaveLength(2);
    expect(out.gaps.map((g) => g.code)).toContain("live_sentry_skipped_cap");
  });
});

describe("what is never read", () => {
  test("Sentry not connected: no executor action, a Gap", async () => {
    const h = setup({ connected: false });
    const out = await run(h);
    expect(h.dispatched).toEqual([]);
    expect(out.live?.status).toBe("not_read");
    expect(out.gaps.find((g) => g.code === "live_sentry_not_read")?.detail).toContain(
      "not connected",
    );
  });

  test("a record with no declared Sentry project: no read, a Gap", async () => {
    const h = setup({ projects: [] });
    const out = await run(h);
    expect(h.dispatched).toEqual([]);
    expect(out.gaps.find((g) => g.code === "live_sentry_not_read")?.detail).toContain(
      "no Sentry project",
    );
  });

  test("the other backends keep a Gap that says no live read is built for them", async () => {
    const out = await run(setup());
    const dd = out.gaps.find((g) => g.code === "live_datadog");
    expect(dd?.detail).toContain("no live read is built for this backend yet");
    expect(dd?.detail).not.toContain("makes no live call");
  });

  test("an executor that cannot be built is ERR_INVESTIGATE_LIVE_UNAVAILABLE", async () => {
    const h = setup();
    const svc = createLiveInvestigator({
      db,
      makeExecutor: () => {
        throw new Error("no remediation executor");
      },
    });
    await expect(svc.run({ investigation: h.inv, clientId: "c1" })).rejects.toBeInstanceOf(
      LiveInvestigateError,
    );
  });

  test("the input investigation is not mutated", async () => {
    const h = setup();
    const snapshot = JSON.stringify(h.inv);
    await run(h);
    expect(JSON.stringify(h.inv)).toBe(snapshot);
    expect(h.inv.live).toBeUndefined();
  });
});
