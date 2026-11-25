import { describe, expect, test } from "bun:test";

import { buildRecord } from "../../incident/__fixtures__/record-builder.ts";
import type {
  CiView,
  DeploymentView,
  IncidentRecordV1,
} from "../../incident/incident-record-types.ts";
import { renderIncidentUpdate } from "./incident-update-render.ts";

/**
 * The branches of the update render the main suite does not reach: an unknown status, a link that is not a
 * safe https URL, and the deployment and CI lines of the change lane.
 */

const OPEN = Date.parse("2026-11-17T10:00:00Z");
const NOW = Date.parse("2026-11-17T11:30:00Z");

function render(record: IncidentRecordV1, audience: "stakeholders" | "engineers"): string {
  return renderIncidentUpdate({
    recordId: "inc_0123456789abcdef",
    record,
    version: 1,
    timeline: { events: [], notes: [] },
    audience,
    nowMs: NOW,
  });
}

function withUrl(url: string | null): IncidentRecordV1 {
  const base = buildRecord({ openedAtMs: OPEN });
  return { ...base, trigger: { ...base.trigger, url } };
}

const DEPLOYMENT: DeploymentView = {
  id: "dep-1",
  title: "deploy payments",
  url: null,
  provider: "argocd",
  environment: "production",
  sha: "0123456789abcdef0123",
  ref: "main",
  startedAtMs: OPEN - 20 * 60_000,
  finishedAtMs: OPEN - 15 * 60_000,
  conclusion: "success",
  minutesBeforeOpen: 15,
  rule: "last_deployment_before_open",
};

function ciRun(conclusion: string | null): CiView {
  return {
    id: "ci-1",
    title: "build <main>",
    url: null,
    service: "github_actions",
    conclusion,
    atMs: OPEN - 30 * 60_000,
    rule: "ci_run_external_id",
  };
}

function withChange(change: Partial<IncidentRecordV1["change"]>): IncidentRecordV1 {
  const base = buildRecord({ openedAtMs: OPEN });
  return { ...base, change: { ...base.change, ...change } };
}

describe("renderIncidentUpdate, the remaining branches", () => {
  test("a trigger whose status is unknown says so", () => {
    const text = render(buildRecord({ openedAtMs: OPEN, status: "unknown" }), "stakeholders");
    expect(text).toContain("Status: Status not known");
  });

  test("an https link is shown to engineers", () => {
    expect(render(withUrl("https://acme.pagerduty.com/incidents/P1"), "engineers")).toContain(
      "Link: https://acme.pagerduty.com/incidents/P1",
    );
  });

  test("a link that is not https, or not a URL at all, is left out", () => {
    expect(render(withUrl("http://acme.pagerduty.com/incidents/P1"), "engineers")).not.toContain(
      "Link:",
    );
    expect(render(withUrl("not a url"), "engineers")).not.toContain("Link:");
  });

  test("a deployment before the alert is named as timing only, and in full for engineers", () => {
    const r = withChange({ deployment: DEPLOYMENT });
    const stakeholders = render(r, "stakeholders");
    expect(stakeholders).toContain(
      "A deployment finished 15 min before the alert (timing only, not a proven cause).",
    );
    expect(stakeholders).not.toContain("Last deployment before the alert");
    expect(render(r, "engineers")).toContain(
      "Last deployment before the alert: argocd 0123456789ab to production (success)",
    );
  });

  test("a CI run is shown with its conclusion, or without one when none was recorded", () => {
    expect(render(withChange({ ci: ciRun("failure") }), "engineers")).toContain(
      "CI run: build ‹main› (failure)",
    );
    const none = render(withChange({ ci: ciRun(null) }), "engineers");
    expect(none).toContain("CI run: build ‹main›\n");
  });
});
