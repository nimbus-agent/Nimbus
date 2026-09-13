import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  DEFAULT_DEPLOY_WORKFLOW_PATTERN,
  DEFAULT_EXCLUDE_PR_LABELS,
  DEFAULT_INCIDENT_WINDOW_MINUTES,
  type ServiceConfig,
} from "../metrics/dora-config.ts";
import type { OncallIncident } from "./_lib/oncall-types.ts";
import {
  buildOncallBrief,
  emitOncallBrief,
  ONCALL_PRIOR_INCIDENT_CAP,
  OncallIdentityUnresolvedError,
  OncallIncidentNotFoundError,
  OncallNoActiveIncidentError,
} from "./oncall.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ME = "person-me";
const PD_SVC = "PSERVICE1";

function db(): Database {
  return createMemoryIndexDb();
}

function cfg(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "checkout",
    repos: [],
    pagerdutyServices: [PD_SVC],
    deployWorkflowPattern: new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN),
    incidentWindowMinutes: DEFAULT_INCIDENT_WINDOW_MINUTES,
    excludePrLabels: [...DEFAULT_EXCLUDE_PR_LABELS],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...over,
  };
}

function incident(over: Partial<OncallIncident> = {}): OncallIncident {
  return {
    id: "pagerduty:inc-1",
    title: "Checkout 500s",
    url: null,
    status: "triggered",
    severity: "P1",
    urgency: "high",
    openedAtMs: NOW - 2 * HOUR,
    pagerdutyServiceId: PD_SVC,
    assigneeEmails: ["me@example.com"],
    ...over,
  };
}

function build(opts: {
  db?: Database;
  incident?: OncallIncident;
  serviceConfigs?: readonly ServiceConfig[];
}) {
  return buildOncallBrief({
    db: opts.db ?? db(),
    nowMs: NOW,
    chatLookbackMs: DAY,
    incident: opts.incident ?? incident(),
    selection: "auto_assigned",
    otherActiveIncidents: [],
    serviceConfigs: opts.serviceConfigs ?? [cfg()],
    // A `performance.now()` ORIGIN, not an elapsed duration: the builder measures against it
    // AFTER its lanes run. Passing a pre-computed elapsed time is the defect this shape exists
    // to make impossible — it shipped on `changelog` once.
    startedAtMs: performance.now(),
  });
}

function insertDeployment(
  d: Database,
  row: {
    id: string;
    sha: string;
    startedAtMs: number;
    serviceId?: string;
    ciRunExternalId?: string;
  },
): void {
  d.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, 'github_actions', 'ci_run', ?, ?, NULL, ?, NULL, NULL, ?)`,
    [row.id, row.id, `Deploy ${row.id}`, row.startedAtMs, NOW],
  );
  d.run(
    `INSERT INTO deployment_items
       (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
        conclusion, workflow_url, ci_run_external_id, created_at)
     VALUES (?, 'github-actions', ?, 'prod', ?, 'refs/heads/main', ?, ?, 'success', NULL, ?, ?)`,
    [
      row.id,
      row.serviceId ?? "checkout",
      row.sha,
      row.startedAtMs,
      row.startedAtMs + 60_000,
      row.ciRunExternalId ?? null,
      NOW,
    ],
  );
}

function insertPriorIncident(d: Database, id: string, openedAtMs: number): void {
  d.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, 'pagerduty', 'incident', ?, ?, NULL, ?, NULL, ?, ?)`,
    [
      id,
      id,
      id,
      openedAtMs + HOUR,
      JSON.stringify({
        status: "resolved",
        incidentId: id,
        assignee_emails: [],
        opened_at_ms: openedAtMs,
        pagerduty_service_id: PD_SVC,
      }),
      NOW,
    ],
  );
}

describe("buildOncallBrief", () => {
  test("an empty index still yields a brief about the selected incident, not an error", () => {
    const b = build({});
    expect(b.kind).toBe("oncall");
    expect(b.incident.id).toBe("pagerduty:inc-1");
    expect(b.deployment).toBeNull();
    expect(b.change).toBeNull();
    expect(b.counts).toEqual({ messages: 0, priorIncidents: 0 });
  });

  test("binds the incident's PagerDuty service to the configured Nimbus service", () => {
    const b = build({});
    expect(b.binding).toEqual({ nimbusServiceId: "checkout", pagerdutyServiceId: PD_SVC });
  });

  test("an UNMAPPED PagerDuty service is disclosed, not rendered as four quiet empties", () => {
    // The failure this prevents: deploy/change/CI/chat all empty, and a reader concluding
    // nothing happened when in fact nothing could be queried.
    const b = build({ serviceConfigs: [cfg({ pagerdutyServices: ["POTHER"] })] });
    expect(b.binding.nimbusServiceId).toBeNull();
    const detail = b.gaps.map((g) => g.detail).join("\n");
    expect(detail).toContain("No configured service claims");
    expect(detail).toContain(PD_SVC);
  });

  test("the deploy lane anchors on the incident's OPEN time, never on now", () => {
    // A deploy that shipped DURING the incident is quite possibly the fix; presenting it as the
    // last deploy "before the alert" would invert cause and remedy.
    const d = db();
    insertDeployment(d, { id: "dep-before", sha: "sha-before", startedAtMs: NOW - 3 * HOUR });
    insertDeployment(d, { id: "dep-during", sha: "sha-during", startedAtMs: NOW - 1 * HOUR });
    const b = build({ db: d });
    expect(b.deployment?.id).toBe("dep-before");
  });

  test("an incident with no recorded open time empties the anchored lanes and says so", () => {
    const d = db();
    insertDeployment(d, { id: "dep-1", sha: "s", startedAtMs: NOW - 3 * HOUR });
    insertPriorIncident(d, "inc-old", NOW - 10 * DAY);
    const b = build({ db: d, incident: incident({ openedAtMs: null }) });
    expect(b.deployment).toBeNull();
    expect(b.priorIncidents).toEqual([]);
    expect(b.gaps.map((g) => g.detail).join("\n")).toContain("no recorded open time");
  });

  test("the three substrate gaps are UNCONDITIONAL — present even on a fully populated brief", () => {
    // Unconditional follows `ownership`/`standup` precedent: a conditional note is absent exactly
    // when the reader needs it, and all three are properties of the INDEX, not of today.
    const detail = build({})
      .gaps.map((g) => g.detail)
      .join("\n");
    expect(detail).toContain("How any earlier incident was resolved");
    expect(detail).toContain("The contents of the change below are absent");
    expect(detail).toContain("Only PagerDuty incidents are covered");
  });

  test("every gap carries a legal SDK category", () => {
    // `GapCategory` is a closed five-member union owned by `@nimbus-dev/sdk`. Inventing a member
    // typechecks nowhere but is easy to reintroduce via a cast, and a bad category renders.
    const legal = new Set([
      "missing_entity_type",
      "missing_relation_emit",
      "missing_connector",
      "missing_user_identity",
      "empty_index",
    ]);
    for (const g of build({}).gaps) expect(legal.has(g.category)).toBe(true);
  });

  test("counts are PRE-cap while the lists are capped", () => {
    const d = db();
    for (let i = 0; i < ONCALL_PRIOR_INCIDENT_CAP + 3; i++) {
      insertPriorIncident(d, `inc-p${String(i)}`, NOW - (i + 3) * DAY);
    }
    const b = build({ db: d });
    expect(b.priorIncidents).toHaveLength(ONCALL_PRIOR_INCIDENT_CAP);
    // The over-fetch is CAP + 1, so the count saturates rather than reporting the true 13 — that
    // is a deliberate bound, and the truncation disclosure rather than the count is what tells
    // the reader there are more.
    expect(b.counts.priorIncidents).toBe(ONCALL_PRIOR_INCIDENT_CAP + 1);
    expect(b.truncatedCount).toBe(1);
  });

  test("the merge-metadata gap fires only when a deploy WAS found and its change was not", () => {
    // With no deploy there is no sha to match on, so naming the merge-metadata hole there would
    // blame the wrong absence.
    const withRepos = cfg({
      repos: [{ provider: "github", owner: "o", repo: "r" } as unknown as never],
    });
    const empty = build({ serviceConfigs: [withRepos] });
    expect(empty.gaps.map((g) => g.detail).join("\n")).not.toContain(
      "No pull request could be matched",
    );

    const d = db();
    insertDeployment(d, { id: "dep-1", sha: "unmatched-sha", startedAtMs: NOW - 3 * HOUR });
    const found = build({ db: d, serviceConfigs: [withRepos] });
    expect(found.deployment).not.toBeNull();
    expect(found.change).toBeNull();
    expect(found.gaps.map((g) => g.detail).join("\n")).toContain(
      "No pull request could be matched",
    );
  });

  test("latencyMs is measured, not taken as an input", () => {
    // `changelog` shipped a `latencyMs: Date.now() - started` written in the CALLER's object
    // literal, which is evaluated before the function body runs and published ~0 ms.
    expect(build({}).latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("emitOncallBrief selection", () => {
  const notify = () => {};

  test("refuses when no active incident is assigned, rather than emitting an empty brief", async () => {
    await expect(
      emitOncallBrief({
        db: db(),
        sessionId: "s1",
        serviceConfigs: [cfg()],
        mePersonIdOverride: ME,
        notify,
      }),
    ).rejects.toBeInstanceOf(OncallNoActiveIncidentError);
  });

  test("refuses with a DIFFERENT error when identity cannot be resolved", async () => {
    // "Nobody is paging you" and "I do not know who you are" have opposite fixes, and reporting
    // the first when the second is true tells an on-call engineer they are clear when nothing
    // was ever checked.
    await expect(
      emitOncallBrief({
        db: db(),
        sessionId: "s1",
        serviceConfigs: [cfg()],
        runGit: async () => "",
        osUsername: "",
        notify,
      }),
    ).rejects.toBeInstanceOf(OncallIdentityUnresolvedError);
  });

  test("--incident naming a non-incident refuses rather than falling back to auto-detect", async () => {
    await expect(
      emitOncallBrief({
        db: db(),
        sessionId: "s1",
        incidentId: "not-a-thing",
        serviceConfigs: [cfg()],
        notify,
      }),
    ).rejects.toBeInstanceOf(OncallIncidentNotFoundError);
  });

  test("--service needs no identity at all", async () => {
    // The shape an EXTERNAL caller is restricted to must not depend on who the gateway owner is.
    await expect(
      emitOncallBrief({
        db: db(),
        sessionId: "s1",
        serviceId: "checkout",
        serviceConfigs: [cfg()],
        runGit: async () => "",
        osUsername: "",
        notify,
      }),
    ).rejects.toBeInstanceOf(OncallNoActiveIncidentError);
  });
});

/**
 * Await the `oncall.briefReady` notification rather than the `emitOncallBrief` call.
 *
 * `emitBriefWithSynthesis` builds and notifies inside an un-awaited async IIFE and returns
 * `{ sessionId }` immediately, so asserting on the resolved call observes nothing. A
 * `briefError` rejects, so a refusal surfaces as a real failure instead of a timeout.
 */
function deferredBrief<T>(): {
  notify: (method: string, params: unknown) => void;
  promise: Promise<T>;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    notify: (method, params) => {
      if (method === "oncall.briefReady") resolve((params as { findings: T }).findings);
      if (method === "oncall.briefError") {
        reject(new Error(String((params as { error: unknown }).error)));
      }
    },
    promise,
  };
}

describe("the selection MODE travels from the selector to the brief (CodeRabbit #1509)", () => {
  /**
   * Asserted end to end rather than on each half, because the defect this fixes lived in the WIRE:
   * the selector knew which population it had queried and the renderer did not, so the brief said
   * "assigned to you" about incidents selected by service alone. Two passing per-side tests would
   * not have caught that.
   */
  function seedActiveIncident(d: Database, id: string, openedAtMs: number): void {
    d.run(
      `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
       VALUES (?, 'pagerduty', 'incident', ?, ?, NULL, ?, NULL, ?, ?)`,
      [
        id,
        id,
        id,
        openedAtMs,
        JSON.stringify({
          status: "triggered",
          incidentId: id,
          assignee_emails: [],
          opened_at_ms: openedAtMs,
          pagerduty_service_id: PD_SVC,
        }),
        NOW,
      ],
    );
  }

  test("--service yields auto_service, and names runner-ups it did NOT filter by assignee", async () => {
    const d = db();
    seedActiveIncident(d, "inc-newest", NOW - HOUR);
    seedActiveIncident(d, "inc-older", NOW - 5 * HOUR);

    // `emitBriefWithSynthesis` fires `briefReady` from an un-awaited async IIFE, so the call
    // resolves with only a sessionId — awaiting it alone would assert against an unbuilt brief.
    const ready = deferredBrief<{
      selection: string;
      otherActiveIncidents: readonly { id: string }[];
    }>();
    await emitOncallBrief({
      db: d,
      sessionId: "s1",
      serviceId: "checkout",
      serviceConfigs: [cfg()],
      notify: ready.notify,
    });
    const brief = await ready.promise;

    expect(brief.selection).toBe("auto_service");
    // Neither incident is assigned to anyone, which is exactly why the old unconditional
    // "assigned to you" label was false.
    expect(brief.otherActiveIncidents.map((o) => o.id)).toEqual(["inc-older"]);
  });

  test("--incident yields explicit and no runner-ups", async () => {
    const d = db();
    seedActiveIncident(d, "inc-named", NOW - HOUR);
    seedActiveIncident(d, "inc-other", NOW - 5 * HOUR);

    const ready = deferredBrief<{ selection: string; otherActiveIncidents: readonly unknown[] }>();
    await emitOncallBrief({
      db: d,
      sessionId: "s1",
      incidentId: "inc-named",
      serviceConfigs: [cfg()],
      notify: ready.notify,
    });
    const brief = await ready.promise;

    expect(brief.selection).toBe("explicit");
    expect(brief.otherActiveIncidents).toEqual([]);
  });
});
