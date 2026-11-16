import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFLIGHT_RISK_CONFIG,
  type NimbusPreflightRiskToml,
  parseNimbusTomlPreflightRisk,
} from "../config/preflight-risk-toml.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { githubActionsRunMetadata } from "../connectors/github-actions-sync.ts";
import { mapJsmAlertToItem } from "../connectors/jsm-alert-mapping.ts";
import { type OncallShiftInput, upsertOncallShift } from "../connectors/oncall-shift-items.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { annotateDeployment } from "../deployment/annotate.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { NO_INCIDENT_BINDINGS } from "../metrics/dora-config.ts";
import {
  changeVelocityFactor,
  combineRisk,
  computeDeployRisk,
  oncallCoverageFactor,
  RISK_BASELINE_MIN_SAMPLE,
  RISK_INDEX_FRESH_MS,
  RISK_SCORING,
  type RiskFactor,
  type RiskInputs,
  reachesFailAt,
  systemStateFactor,
  timeOfWeekFactor,
} from "./deploy-risk.ts";
import { computeDeployPreflight } from "./preflight.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 2026-11-18 10:00 UTC. */
const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);

let db: Database;
beforeEach(() => {
  db = createMemoryIndexDb();
});
afterEach(() => {
  db.close();
});

function cfgOf(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "svc",
    repos: [{ provider: "github", providerId: "org/repo" }],
    pagerdutyServices: ["PD1"],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...NO_INCIDENT_BINDINGS,
    ...over,
  };
}

const UTC_CONFIG: NimbusPreflightRiskToml = { ...DEFAULT_PREFLIGHT_RISK_CONFIG, tz: "UTC" };

function inputs(
  over: {
    cfg?: ServiceConfig;
    configs?: ReadonlyMap<string, ServiceConfig>;
    risk?: NimbusPreflightRiskToml;
    nowMs?: number;
  } = {},
): RiskInputs {
  const cfg = over.cfg ?? cfgOf();
  return {
    db,
    cfg,
    configs: over.configs ?? new Map([[cfg.serviceId, cfg]]),
    riskConfig: over.risk ?? UTC_CONFIG,
    nowMs: over.nowMs ?? NOW,
  };
}

let shaSeq = 0;
function deploy(
  status: "success" | "failure",
  startedAtMs: number,
  service = "svc",
  environment = "prod",
): void {
  shaSeq += 1;
  annotateDeployment(
    db,
    {
      service,
      provider: "github-actions",
      environment,
      sha: shaSeq.toString(16).padStart(40, "a"),
      ref: "main",
      status,
      started_at_ms: startedAtMs,
      finished_at_ms: startedAtMs,
    },
    NOW,
    { deployEnvironments: ["prod"] },
  );
}

/** 27 successful deploys spread over days 8..34 before NOW: a baseline of about one a day. */
function seedBaseline(count = 27): void {
  for (let i = 0; i < count; i += 1) deploy("success", NOW - (8 + i) * DAY - HOUR);
}

function pdIncident(
  id: string,
  status: string,
  priority: string | null,
  serviceId = "PD1",
): Record<string, unknown> {
  return {
    id,
    title: `Incident ${id}`,
    status,
    urgency: "high",
    created_at: new Date(NOW - 2 * HOUR).toISOString(),
    updated_at: new Date(NOW - HOUR).toISOString(),
    last_status_change_at: new Date(NOW - HOUR).toISOString(),
    service: { id: serviceId },
    ...(priority === null ? {} : { priority: { name: priority } }),
  };
}

function seedIncident(raw: Record<string, unknown>): void {
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "pagerduty");
  syncPagerdutyIncidentItems(ctx, [raw], "", NOW, new Map());
}

function seedSync(connectorId: string, lastSyncAt: number): void {
  db.run("INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?)", [
    connectorId,
    lastSyncAt,
  ]);
}

function seedAlert(id: string, priority: string, tags: string[]): void {
  const row = mapJsmAlertToItem(
    {
      id,
      message: `Alert ${id}`,
      status: "open",
      priority,
      tags,
      createdAt: new Date(NOW - 2 * HOUR).toISOString(),
      updatedAt: new Date(NOW - HOUR).toISOString(),
    },
    { syncedAt: NOW },
  );
  if (row === null) throw new Error("alert fixture did not map");
  syncTestContext(db, EMPTY_NIMBUS_VAULT, "jira").upsertItem(row);
}

function shift(over: Partial<OncallShiftInput> = {}): OncallShiftInput {
  return {
    source: "pagerduty",
    userId: "U1",
    userName: "Alice",
    userEmail: null,
    policyId: "EP1",
    policyName: "policy",
    level: 1,
    scheduleId: "S1",
    scheduleName: "primary",
    startMs: NOW - HOUR,
    endMs: NOW + HOUR,
    serviceIds: ["PD1"],
    serviceNames: ["svc"],
    serviceMapComplete: true,
    isMe: false,
    url: null,
    ...over,
  };
}

function seedShifts(shifts: OncallShiftInput[], fetchedAt = NOW - 3 * 60_000): void {
  for (const s of shifts) {
    const svc = s.source === "jsm" ? "jira" : "pagerduty";
    upsertOncallShift(syncTestContext(db, EMPTY_NIMBUS_VAULT, svc), s, fetchedAt);
  }
}

// ---------------------------------------------------------------------------
describe("time_of_week", () => {
  test("a Wednesday morning is normal and known", () => {
    const f = timeOfWeekFactor(inputs());
    expect(f).toMatchObject({ id: "time_of_week", level: "low", known: true });
    expect(f.evidence).toContain("wed 10:00 in UTC");
  });

  test("Friday after 15:00 is inside the default quiet window; 14:59 is not; 23:59 still is", () => {
    const at = (h: number, m: number) =>
      timeOfWeekFactor(inputs({ nowMs: Date.UTC(2026, 10, 20, h, m) }));
    expect(at(14, 59).level).toBe("low");
    expect(at(15, 0)).toMatchObject({ level: "elevated", known: true });
    expect(at(15, 0).evidence).toContain("fri 15:00-24:00");
    expect(at(23, 59).level).toBe("elevated");
  });

  test("weekends are quiet days; Monday is not", () => {
    expect(timeOfWeekFactor(inputs({ nowMs: Date.UTC(2026, 10, 21, 12) })).level).toBe("elevated");
    expect(timeOfWeekFactor(inputs({ nowMs: Date.UTC(2026, 10, 22, 12) })).evidence).toContain(
      "quiet day (sun)",
    );
    expect(timeOfWeekFactor(inputs({ nowMs: Date.UTC(2026, 10, 16, 12) })).level).toBe("low");
  });

  test("the quiet window is read in the configured zone across a DST change", () => {
    const berlin: NimbusPreflightRiskToml = {
      ...DEFAULT_PREFLIGHT_RISK_CONFIG,
      tz: "Europe/Berlin",
    };
    // Europe/Berlin moves from UTC+1 to UTC+2 on Sunday 2026-03-29. 13:30Z on a Friday is 14:30 local
    // before the change and 15:30 local after it, so the same UTC time flips across the boundary.
    const beforeDst = timeOfWeekFactor(
      inputs({ risk: berlin, nowMs: Date.UTC(2026, 2, 27, 13, 30) }),
    );
    const afterDst = timeOfWeekFactor(
      inputs({ risk: berlin, nowMs: Date.UTC(2026, 3, 3, 13, 30) }),
    );
    expect(beforeDst.level).toBe("low");
    expect(beforeDst.evidence).toContain("fri 14:30 in Europe/Berlin");
    expect(afterDst.level).toBe("elevated");
    expect(afterDst.evidence).toContain("fri 15:30 in Europe/Berlin");
    // And 14:30Z is 15:30 local BEFORE the change: quiet.
    expect(
      timeOfWeekFactor(inputs({ risk: berlin, nowMs: Date.UTC(2026, 2, 27, 14, 30) })).level,
    ).toBe("elevated");
  });

  test("a zone the runtime cannot resolve is unknown, not low", () => {
    const f = timeOfWeekFactor(inputs({ risk: { ...UTC_CONFIG, tz: "Not/AZone" } }));
    expect(f).toMatchObject({ level: "unknown", known: false });
  });

  test("empty quiet lists mean nothing is quiet", () => {
    const none = parseNimbusTomlPreflightRisk(
      '[preflight.risk]\nquiet_days = []\nquiet_hours = []\ntz = "UTC"\n',
    );
    expect(timeOfWeekFactor(inputs({ risk: none, nowMs: Date.UTC(2026, 10, 21, 12) })).level).toBe(
      "low",
    );
  });
});

// ---------------------------------------------------------------------------
describe("change_velocity", () => {
  test("a service with no deployment history is unknown", () => {
    const f = changeVelocityFactor(inputs());
    expect(f).toMatchObject({ id: "change_velocity", level: "unknown", known: false });
    expect(f.evidence).toContain("no deployment history");
  });

  test("a service with no repos bound is unknown", () => {
    const f = changeVelocityFactor(inputs({ cfg: cfgOf({ repos: [] }) }));
    expect(f.level).toBe("unknown");
    expect(f.evidence).toContain("no_repos");
  });

  test("too little history for a baseline is unknown, and says how little", () => {
    for (let i = 0; i < RISK_BASELINE_MIN_SAMPLE - 1; i += 1) {
      deploy("success", NOW - (10 + i) * DAY);
    }
    deploy("success", NOW - HOUR);
    const f = changeVelocityFactor(inputs());
    expect(f.level).toBe("unknown");
    expect(f.evidence).toContain("not enough history");
  });

  test("a steady cadence is low", () => {
    seedBaseline();
    deploy("success", NOW - 3 * HOUR);
    const f = changeVelocityFactor(inputs());
    expect(f).toMatchObject({ level: "low", known: true });
    expect(f.evidence).toContain("1 in 24h");
  });

  test("two deploys in a day against a one-a-day baseline is elevated", () => {
    seedBaseline();
    deploy("success", NOW - 2 * HOUR);
    deploy("success", NOW - 3 * HOUR);
    expect(changeVelocityFactor(inputs())).toMatchObject({ level: "elevated", known: true });
  });

  test("four deploys in a day against a one-a-day baseline is high", () => {
    seedBaseline();
    for (let i = 1; i <= 4; i += 1) deploy("success", NOW - i * HOUR);
    expect(changeVelocityFactor(inputs())).toMatchObject({ level: "high", known: true });
  });

  test("a busy week against a quiet baseline is elevated even with nothing in the last day", () => {
    for (const d of [10, 15, 20]) deploy("success", NOW - d * DAY);
    for (let i = 0; i < 8; i += 1) deploy("success", NOW - (2 + (i % 5)) * DAY - i * 1000);
    const f = changeVelocityFactor(inputs());
    expect(f).toMatchObject({ level: "elevated", known: true });
    expect(f.evidence).toContain("0 in 24h and 8 in 7d");
  });

  test("failed deployments are not counted as change velocity", () => {
    seedBaseline();
    for (let i = 1; i <= 4; i += 1) deploy("failure", NOW - i * HOUR);
    expect(changeVelocityFactor(inputs()).level).toBe("low");
  });

  test("a normal count with a CI provider the index cannot judge is unknown, not low", () => {
    const cfg = cfgOf({
      repos: [
        { provider: "github", providerId: "org/repo" },
        { provider: "bitbucket", providerId: "org/bb" },
      ],
    });
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "github_actions");
    for (const d of [10, 15, 20]) {
      const at = NOW - d * DAY;
      ctx.upsertItem({
        service: "github_actions",
        type: "ci_run",
        externalId: `org/repo#run-${String(d)}`,
        title: "Deploy prod",
        bodyPreview: "",
        url: null,
        canonicalUrl: null,
        modifiedAt: at,
        authorId: null,
        metadata: githubActionsRunMetadata(
          "org/repo",
          {
            id: d,
            name: "Deploy prod",
            status: "completed",
            conclusion: "success",
            head_branch: "main",
            created_at: new Date(at).toISOString(),
          },
          NOW,
        ),
        pinned: false,
        syncedAt: NOW,
      });
    }
    const f = changeVelocityFactor(inputs({ cfg }));
    expect(f).toMatchObject({ level: "unknown", known: false });
    expect(f.evidence).toContain("cannot be judged");
  });
});

// ---------------------------------------------------------------------------
describe("oncall_coverage", () => {
  test("no PagerDuty binding is unknown", () => {
    const f = oncallCoverageFactor(inputs({ cfg: cfgOf({ pagerdutyServices: [] }) }));
    expect(f).toMatchObject({ id: "oncall_coverage", level: "unknown", known: false });
  });

  test("no shift data at all is unknown, never uncovered", () => {
    const f = oncallCoverageFactor(inputs());
    expect(f.level).toBe("unknown");
    expect(f.evidence).toContain("not the same as uncovered");
  });

  test("someone on call now is low", () => {
    seedShifts([shift()]);
    expect(oncallCoverageFactor(inputs())).toMatchObject({ level: "low", known: true });
  });

  test("fresh shift data showing nobody now is elevated and names the service", () => {
    seedShifts([shift({ startMs: NOW - 5 * HOUR, endMs: NOW - HOUR })]);
    const f = oncallCoverageFactor(inputs());
    expect(f).toMatchObject({ level: "elevated", known: true });
    expect(f.evidence).toContain("nobody on call");
    expect(f.evidence).toContain("PD1");
  });

  test("stale shift data is unknown in both directions", () => {
    seedShifts([shift({ startMs: NOW - 5 * HOUR, endMs: NOW - HOUR })], NOW - 3 * HOUR);
    expect(oncallCoverageFactor(inputs()).level).toBe("unknown");
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    seedShifts([shift()], NOW - 3 * HOUR);
    expect(oncallCoverageFactor(inputs()).level).toBe("unknown");
  });

  test("an incomplete service map is unknown", () => {
    seedShifts([shift({ startMs: NOW - 5 * HOUR, endMs: NOW - HOUR, serviceMapComplete: false })]);
    expect(oncallCoverageFactor(inputs()).level).toBe("unknown");
  });

  test("shifts for other services only are unknown (no match is not uncovered)", () => {
    seedShifts([shift({ serviceIds: ["PD9"] })]);
    expect(oncallCoverageFactor(inputs()).level).toBe("unknown");
  });

  test("one covered PagerDuty service among two uncovered ones is low", () => {
    seedShifts([
      shift({ serviceIds: ["PD2"] }),
      shift({ userId: "U2", serviceIds: ["PD1"], startMs: NOW - 5 * HOUR, endMs: NOW - HOUR }),
    ]);
    expect(
      oncallCoverageFactor(inputs({ cfg: cfgOf({ pagerdutyServices: ["PD1", "PD2"] }) })).level,
    ).toBe("low");
  });
});

// ---------------------------------------------------------------------------
describe("system_state", () => {
  test("no bound and fresh source and no failed deploy is unknown", () => {
    const f = systemStateFactor(inputs({ cfg: cfgOf({ pagerdutyServices: [] }) }));
    expect(f).toMatchObject({ id: "system_state", level: "unknown", known: false });
  });

  test("a bound PagerDuty with no sync record is unknown, not clear", () => {
    expect(systemStateFactor(inputs()).level).toBe("unknown");
  });

  test("a stale PagerDuty index is unknown", () => {
    seedSync("pagerduty", NOW - RISK_INDEX_FRESH_MS - 60_000);
    expect(systemStateFactor(inputs()).level).toBe("unknown");
  });

  test("a fresh index with nothing open is low and says what was checked", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("RES1", "resolved", "P1"));
    const f = systemStateFactor(inputs());
    expect(f).toMatchObject({ level: "low", known: true });
    expect(f.evidence).toContain("checked incidents");
    expect(f.evidence).toContain("alert source not bound");
  });

  test("an open P1 incident on the service is high", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("INC1", "triggered", "P1"));
    const f = systemStateFactor(inputs());
    expect(f).toMatchObject({ level: "high", known: true });
    expect(f.evidence).toContain("INC1");
  });

  test("a configured P1 alias counts as P1", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("INC2", "acknowledged", "SEV1"));
    expect(systemStateFactor(inputs({ cfg: cfgOf({ severityP1Aliases: ["sev1"] }) })).level).toBe(
      "high",
    );
  });

  test("a lower-severity open incident on the service is elevated", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("INC3", "triggered", "P3"));
    expect(systemStateFactor(inputs()).level).toBe("elevated");
  });

  test("an open incident on a depends_on service is elevated, even at P1", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("DEP1", "triggered", "P1", "PD2"));
    const dep = cfgOf({ serviceId: "dep", pagerdutyServices: ["PD2"], repos: [] });
    const cfg = cfgOf({ pagerdutyServices: [], dependsOn: ["dep", "ghost"] });
    const f = systemStateFactor(
      inputs({
        cfg,
        configs: new Map([
          ["svc", cfg],
          ["dep", dep],
        ]),
      }),
    );
    expect(f).toMatchObject({ level: "elevated", known: true });
    expect(f.evidence).toContain("DEP1");
    expect(f.evidence).toContain("dep");
  });

  test("an unconfigured dependency is named as not checked", () => {
    seedSync("pagerduty", NOW - HOUR);
    const f = systemStateFactor(inputs({ cfg: cfgOf({ dependsOn: ["ghost"] }) }));
    expect(f.level).toBe("low");
    expect(f.evidence).toContain("ghost has no configuration");
  });

  test("an incident on an unrelated PagerDuty service is not this service's", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("OTHER", "triggered", "P1", "PD9"));
    expect(systemStateFactor(inputs()).level).toBe("low");
  });

  test("an open P2 alert bound by tag is elevated; a P4 alert is listed but not scored", () => {
    seedSync("jira", NOW - HOUR);
    const cfg = cfgOf({ pagerdutyServices: [], jsmAlertTags: ["Payments"] });
    seedAlert("A4", "P4", ["payments"]);
    const quiet = systemStateFactor(inputs({ cfg }));
    expect(quiet).toMatchObject({ level: "low", known: true });
    expect(quiet.evidence).toContain("1 lower-priority alert open, not scored");
    seedAlert("A2", "P2", ["payments"]);
    const loud = systemStateFactor(inputs({ cfg }));
    expect(loud.level).toBe("elevated");
    expect(loud.evidence).toContain("A2");
  });

  test("a failed latest deployment in the last 24h is elevated even with no incident source", () => {
    deploy("failure", NOW - 3 * HOUR);
    const f = systemStateFactor(inputs({ cfg: cfgOf({ pagerdutyServices: [] }) }));
    expect(f).toMatchObject({ level: "elevated", known: true });
    expect(f.evidence).toContain("failed 3h ago");
  });

  test("a failure followed by a success, or an old failure, is not flagged", () => {
    const cfg = cfgOf({ pagerdutyServices: [] });
    deploy("failure", NOW - 5 * HOUR);
    deploy("success", NOW - 4 * HOUR);
    expect(systemStateFactor(inputs({ cfg })).level).toBe("unknown");
    db.run("DELETE FROM deployment_items");
    deploy("failure", NOW - 30 * HOUR);
    expect(systemStateFactor(inputs({ cfg })).level).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
describe("combination", () => {
  const f = (level: RiskFactor["level"], known = level !== "unknown"): RiskFactor => ({
    id: "system_state",
    level,
    evidence: "e",
    known,
  });

  test("all unknown is unknown, never low", () => {
    expect(combineRisk([f("unknown"), f("unknown")])).toBe("unknown");
    expect(combineRisk([])).toBe("unknown");
  });

  test("the maximum of the known factors wins", () => {
    expect(combineRisk([f("low"), f("unknown")])).toBe("low");
    expect(combineRisk([f("low"), f("elevated")])).toBe("elevated");
    expect(combineRisk([f("elevated"), f("high"), f("low")])).toBe("high");
  });

  test("a factor flagged unknown never counts, whatever level it carries", () => {
    expect(combineRisk([{ ...f("high"), known: false }, f("low")])).toBe("low");
  });

  test("fail_at is reached only by a known level at or above it", () => {
    expect(reachesFailAt("high", null)).toBe(false);
    expect(reachesFailAt("unknown", "elevated")).toBe(false);
    expect(reachesFailAt("low", "elevated")).toBe(false);
    expect(reachesFailAt("elevated", "elevated")).toBe(true);
    expect(reachesFailAt("elevated", "high")).toBe(false);
    expect(reachesFailAt("high", "high")).toBe(true);
  });

  test("the scoring table maps every row to a level and a factor, and none to unknown", () => {
    for (const [, row] of Object.entries(RISK_SCORING)) {
      expect(["low", "elevated", "high"]).toContain(row.level);
    }
    expect(RISK_SCORING.open_p1_incident_own.level).toBe("high");
    expect(RISK_SCORING.time_quiet.level).toBe("elevated");
  });

  test("an empty index gives unknown for the three data factors and a known time factor", () => {
    const risk = computeDeployRisk(inputs({ cfg: cfgOf({ pagerdutyServices: [] }) }), "ok");
    expect(risk.factors.map((x) => [x.id, x.known])).toEqual([
      ["system_state", false],
      ["change_velocity", false],
      ["oncall_coverage", false],
      ["time_of_week", true],
    ]);
    expect(risk.level).toBe("low");
    expect(risk.why).toContain("Not evaluated: system_state, change_velocity, oncall_coverage");
    expect(risk.advisory).toBe(true);
  });

  test("with every factor unknown the answer is unknown and the why says so", () => {
    const broken: NimbusPreflightRiskToml = { ...UTC_CONFIG, tz: "Not/AZone" };
    const risk = computeDeployRisk(
      inputs({ cfg: cfgOf({ pagerdutyServices: [] }), risk: broken }),
      "ok",
    );
    expect(risk.level).toBe("unknown");
    expect(risk.why).toContain("unknown (not low)");
  });

  test("a high factor makes the whole block high and names its driver", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("INC1", "triggered", "P1"));
    const risk = computeDeployRisk(inputs(), "ok");
    expect(risk.level).toBe("high");
    expect(risk.why).toContain("High risk, driven by system_state");
  });

  test("an all-low block says every evaluated factor is normal", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedShifts([shift()]);
    seedBaseline();
    deploy("success", NOW - 3 * HOUR);
    const risk = computeDeployRisk(inputs(), "ok");
    expect(risk.level).toBe("low");
    expect(risk.why).toContain("Low risk");
  });
});

// ---------------------------------------------------------------------------
describe("computeDeployPreflight: the risk block is additive and advisory", () => {
  const SATURDAY = Date.UTC(2026, 10, 21, 12, 0, 0);

  function run(riskConfig: NimbusPreflightRiskToml | undefined, nowMs = SATURDAY, cfg = cfgOf()) {
    return computeDeployPreflight(
      db,
      cfg,
      "main",
      nowMs,
      10,
      riskConfig === undefined
        ? undefined
        : { configs: new Map([[cfg.serviceId, cfg]]), riskConfig },
    );
  }

  test("without risk options the result has no risk member at all", () => {
    const out = run(undefined);
    expect("risk" in out).toBe(false);
    expect(out.verdict).toBe("ok");
  });

  test("by default a high-risk moment leaves the verdict exactly as the checks said", () => {
    const out = run({ ...UTC_CONFIG });
    expect(out.verdict).toBe("ok");
    expect(out.risk?.level).toBe("elevated");
    expect(out.risk?.fail_at).toBeNull();
    expect(out.risk?.verdict_escalated).toBe(false);
  });

  test("fail_at turns an ok verdict into warn only when the level reaches it", () => {
    expect(run({ ...UTC_CONFIG, failAt: "elevated" })).toMatchObject({
      verdict: "warn",
      risk: { verdict_escalated: true, fail_at: "elevated" },
    });
    expect(run({ ...UTC_CONFIG, failAt: "high" })).toMatchObject({
      verdict: "ok",
      risk: { verdict_escalated: false },
    });
  });

  test("an unknown risk never fails, even with fail_at set", () => {
    const out = run(
      { ...UTC_CONFIG, tz: "Not/AZone", failAt: "elevated" },
      SATURDAY,
      cfgOf({ pagerdutyServices: [] }),
    );
    expect(out.risk?.level).toBe("unknown");
    expect(out.verdict).toBe("ok");
  });

  test("a verdict the checks already made warn is not reported as escalated", () => {
    seedSync("pagerduty", NOW - HOUR);
    seedIncident(pdIncident("INC1", "triggered", "P1"));
    const out = run({ ...UTC_CONFIG, failAt: "high" }, NOW);
    expect(out.verdict).toBe("warn");
    expect(out.checks.active_p1_incidents.count).toBe(1);
    expect(out.risk?.verdict_escalated).toBe(false);
  });

  test("the envelope is still readable by a consumer that ignores risk", () => {
    const out = run({ ...UTC_CONFIG });
    const wire = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    const { risk: _ignored, ...legacy } = wire;
    expect(Object.keys(legacy).sort()).toEqual(
      ["checks", "computed_at", "service", "target_ref", "verdict"].sort(),
    );
    expect(legacy["verdict"]).toBe("ok");
  });
});
