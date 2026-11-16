import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import {
  HOUR,
  resolverFor,
  SHA,
  serviceConfig,
  T0,
  writeCiRun,
  writeDeployment,
  writeMergedPr,
} from "../__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "../__fixtures__/trigger-writers.ts";
import { changeLane, skippedChange } from "./change.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const OPEN = T0 + HOUR / 2;

function input(triggerItemId: string, openedAtMs = OPEN, c = cfg) {
  return { cfg: c, triggerItemId, triggerService: "pagerduty", openedAtMs };
}

describe("lane 2, change", () => {
  test("the deployment inside the window, its PR (graph route) and CI run (graph route) with the rules", () => {
    const d = db();
    const dep = writeDeployment(d, resolver);
    writeMergedPr(d, resolver);
    writeCiRun(d, resolver);
    const trig = writePagerdutyIncident(
      d,
      { id: "PD1", openedAtMs: OPEN, priority: "P1" },
      resolver,
    );
    const r = changeLane(d, input(trig));
    expect(r.lane.deployment).toMatchObject({
      id: dep,
      sha: SHA,
      minutesBeforeOpen: 30,
      rule: "last_deployment_before_open",
    });
    expect(r.lane.pr).toMatchObject({
      rule: "graph:deployed+merged_as",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });
    expect(r.lane.ci).toMatchObject({ rule: "graph:built_by", conclusion: "success" });
    expect(r.lane.skipped).toBeNull();
    expect(r.gaps).toEqual([]);
  });

  test("graphCorrelated is true with the edge, false without it, null without a trigger entity", () => {
    const d = db();
    writeDeployment(d, resolver);
    const withEdge = writePagerdutyIncident(d, { id: "PD1", openedAtMs: OPEN }, resolver);
    expect(changeLane(d, input(withEdge)).lane.graphCorrelated).toBe(true);
    // written without a resolver: an entity exists but no edge
    const noEdge = writePagerdutyIncident(d, { id: "PD2", openedAtMs: OPEN });
    expect(changeLane(d, input(noEdge)).lane.graphCorrelated).toBe(false);
    expect(changeLane(d, input("pagerduty:never-indexed")).lane.graphCorrelated).toBeNull();
  });

  test("the SQL fallback finds the PR and the CI run when the graph has no edges", () => {
    const d = db();
    writeDeployment(d, resolver);
    writeMergedPr(d, resolver);
    writeCiRun(d, resolver);
    d.run("DELETE FROM graph_relation WHERE type IN ('deployed','built_by','merged_as')");
    // annotateDeployment never writes ci_run_external_id; a CI-synced deployment does.
    d.run(
      "UPDATE deployment_items SET ci_run_external_id = 'github_actions:acme/payment-service#run-7412'",
    );
    const r = changeLane(d, input("pagerduty:x"));
    expect(r.lane.pr?.rule).toBe("merge_commit_sha");
    expect(r.lane.ci?.rule).toBe("ci_run_external_id");
  });

  test("outside the window is not a candidate; the gap carries the distance", () => {
    const d = db();
    writeDeployment(d, resolver, { startedAtMs: T0 });
    const r = changeLane(d, input("pagerduty:x", T0 + 61 * 60_000));
    expect(r.lane.deployment).toBeNull();
    expect(r.gaps[0]?.detail).toContain("61 minutes before");
    expect(r.gaps[0]?.detail).toContain("window of 60 minutes");
    // at exactly the window it is a candidate
    expect(changeLane(d, input("pagerduty:x", T0 + 60 * 60_000)).lane.deployment).not.toBeNull();
  });

  test("a deployment at the open instant is excluded (strictly before)", () => {
    const d = db();
    writeDeployment(d, resolver, { startedAtMs: OPEN });
    const r = changeLane(d, input("pagerduty:x", OPEN));
    expect(r.lane.deployment).toBeNull();
    expect(r.gaps[0]?.detail).toContain("No deployment");
  });

  test("no deployment at all, and a non-prod deployment, give the specific gap", () => {
    const d = db();
    expect(changeLane(d, input("pagerduty:x")).gaps[0]?.category).toBe("missing_entity_type");
    writeDeployment(d, resolver, { environment: "staging" });
    expect(changeLane(d, input("pagerduty:x")).lane.deployment).toBeNull();
  });

  test("an annotated deployment with no run id has no CI link; the gap says so, not that no CI ran", () => {
    const d = db();
    writeDeployment(d, resolver, { runId: null });
    writeMergedPr(d, resolver);
    const r = changeLane(d, input("pagerduty:x"));
    expect(r.lane.ci).toBeNull();
    expect(r.lane.pr).not.toBeNull();
    expect(r.gaps.map((g) => g.detail).join(" ")).toContain("no CI run link");
  });

  test("a GitLab repository gets the forge gap and no PR", () => {
    const d = db();
    const gl = serviceConfig({
      repos: [{ provider: "gitlab", providerId: "acme/payment-service" }],
    });
    writeDeployment(d, resolverFor(gl));
    const r = changeLane(d, input("pagerduty:x", OPEN, gl));
    expect(r.lane.pr).toBeNull();
    expect(r.gaps.map((g) => g.detail).join(" ")).toContain("gitlab");
  });

  test("a CI run named by the deployment but absent from the index is a missing_connector gap", () => {
    const d = db();
    writeDeployment(d, resolver);
    d.run("UPDATE deployment_items SET ci_run_external_id = 'github_actions:acme/other#run-1'");
    const r = changeLane(d, input("pagerduty:x"));
    expect(r.lane.ci).toBeNull();
    expect(r.gaps.some((g) => g.category === "missing_connector")).toBe(true);
  });

  test("skippedChange carries the reason", () => {
    expect(skippedChange("unbound").lane).toMatchObject({ skipped: "unbound", deployment: null });
    expect(skippedChange("no_open_time").lane.skipped).toBe("no_open_time");
  });
});
