import { describe, expect, test } from "bun:test";

import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import type { DeploymentView, IncidentRecordV1 } from "../incident/incident-record-types.ts";
import {
  interpolateParams,
  placeholderValue,
  RUNBOOK_PLACEHOLDERS,
  untypedPlaceholder,
} from "./runbook-interpolate.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const DEPLOY: DeploymentView = {
  id: "deployment:d1",
  title: "Deploy",
  url: null,
  provider: "github_actions",
  environment: "prod",
  sha: SHA,
  ref: "main",
  startedAtMs: 1,
  finishedAtMs: null,
  conclusion: "success",
  minutesBeforeOpen: 1,
  rule: "last_deployment_before_open",
};

function record(over: { bound?: string | null; opened?: number | null; deploy?: boolean } = {}) {
  const base = buildRecord({
    boundService: over.bound === undefined ? "payments" : over.bound,
    openedAtMs: over.opened === undefined ? Date.UTC(2026, 10, 18, 9, 0, 0) : over.opened,
    itemId: "pagerduty:PDX1",
  });
  return over.deploy === true ? { ...base, change: { ...base.change, deployment: DEPLOY } } : base;
}

const BINDINGS = { argocdApps: ["pay-app"], deployEnvironments: ["prod"] };

describe("untypedPlaceholder (load time)", () => {
  test("every typed placeholder passes, nested in lists and tables", () => {
    const params = {
      a: RUNBOOK_PLACEHOLDERS.map((n) => `{${n}}`),
      b: { c: "prefix-{service}-suffix", d: 3, e: true },
    };
    expect(untypedPlaceholder(params)).toBeNull();
  });

  test("a provider free-text field, an unknown name and a stray brace are refused", () => {
    expect(untypedPlaceholder({ t: "{trigger.title}" })).toContain("{trigger.title} is not a typed");
    expect(untypedPlaceholder({ t: ["ok", { x: "{chat}" }] })).toContain("{chat}");
    expect(untypedPlaceholder({ t: "a { b" })).toBe("a parameter has an unmatched brace");
    expect(untypedPlaceholder({ t: "a } b" })).toBe("a parameter has an unmatched brace");
    expect(untypedPlaceholder({ t: "{}" })).toContain("{} is not a typed");
  });
});

describe("placeholderValue", () => {
  test("each field reads the typed record value", () => {
    const r = record({ deploy: true });
    expect(placeholderValue("service", r, BINDINGS)).toBe("payments");
    expect(placeholderValue("trigger.source", r, BINDINGS)).toBe("pagerduty");
    expect(placeholderValue("trigger.provider_id", r, BINDINGS)).toBe("PDX1");
    expect(placeholderValue("opened_at", r, BINDINGS)).toBe("2026-11-18T09:00:00.000Z");
    expect(placeholderValue("opened_at_ms", r, BINDINGS)).toBe(String(Date.UTC(2026, 10, 18, 9)));
    expect(placeholderValue("deploy.sha", r, BINDINGS)).toBe(SHA);
    expect(placeholderValue("binding.argocd_app", r, BINDINGS)).toBe("pay-app");
    expect(placeholderValue("binding.deploy_environment", r, BINDINGS)).toBe("prod");
  });

  test("an absent value is a stated refusal, never an empty string", () => {
    const r = record({ bound: null, opened: null });
    expect(placeholderValue("service", r, BINDINGS)).toEqual({
      refused: "the incident is not bound to a service",
    });
    expect(placeholderValue("opened_at", r, BINDINGS)).toEqual({ refused: "the incident has no open time" });
    expect(placeholderValue("opened_at_ms", r, BINDINGS)).toEqual({
      refused: "the incident has no open time",
    });
    expect(placeholderValue("deploy.sha", r, BINDINGS)).toEqual({
      refused: "the incident has no correlated deployment",
    });
    expect(placeholderValue("binding.argocd_app", r, undefined)).toEqual({
      refused: "the service has no configuration",
    });
    expect(placeholderValue("binding.deploy_environment", r, undefined)).toEqual({
      refused: "the service has no configuration",
    });
    expect(placeholderValue("binding.argocd_app", r, { argocdApps: [], deployEnvironments: [] })).toEqual({
      refused: "the service declares no Argo CD application",
    });
    expect(
      placeholderValue("binding.deploy_environment", r, {
        argocdApps: [],
        deployEnvironments: ["a", "b"],
      }),
    ).toEqual({ refused: "the service declares 2 deploy environments, so {binding.*} is ambiguous" });
  });
});

describe("interpolateParams (run time)", () => {
  test("substitutes inside text, keeps numbers and booleans, and walks lists and tables", () => {
    const out = interpolateParams(
      { name: "{binding.argocd_app}", id: 6, dry: false, tags: ["svc:{service}"], nested: { sha: "{deploy.sha}" } },
      record({ deploy: true }),
      BINDINGS,
    );
    expect(out).toEqual({
      ok: true,
      params: { name: "pay-app", id: 6, dry: false, tags: ["svc:payments"], nested: { sha: SHA } },
    });
  });

  test("a missing value refuses the whole step with its reason", () => {
    expect(interpolateParams({ a: "{deploy.sha}", b: "{service}" }, record(), BINDINGS)).toEqual({
      ok: false,
      reason: "{deploy.sha}: the incident has no correlated deployment",
    });
  });

  test("an untyped name that slipped past the loader is refused", () => {
    expect(interpolateParams({ a: "{trigger.title}" }, record(), BINDINGS)).toEqual({
      ok: false,
      reason: "{trigger.title} is not a typed record field",
    });
  });

  test("a typed value holding a space, a control or a bidirectional character is refused (I57 (c))", () => {
    for (const providerId of ["PD 1", "PD\u0007", "PD‮1", ""]) {
      const base = record();
      const r: IncidentRecordV1 = { ...base, trigger: { ...base.trigger, providerId } };
      expect(interpolateParams({ id: "{trigger.provider_id}" }, r, BINDINGS)).toEqual({
        ok: false,
        reason: "{trigger.provider_id} holds characters a runbook parameter may not carry",
      });
    }
  });
});
