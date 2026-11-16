import { describe, expect, test } from "bun:test";

import { NO_INCIDENT_BINDINGS } from "../../metrics/dora-config.ts";
import { configMap, resolverFor, serviceConfig } from "../__fixtures__/index-writers.ts";
import { bindTrigger } from "./binding.ts";

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const configs = configMap(cfg);

describe("lane 1, binding", () => {
  test("each source binds through its own key and the record says which", () => {
    const cases: [Parameters<typeof bindTrigger>[2], string][] = [
      [
        { service: "pagerduty", type: "incident", metadata: { pagerduty_service_id: "PSVC1" } },
        "pagerduty_service",
      ],
      [{ service: "jira", type: "alert", metadata: { tags: ["PAYMENTS", "x"] } }, "jsm_alert_tag"],
      [
        { service: "sentry", type: "error_issue", metadata: { project: "payments-api" } },
        "sentry_project",
      ],
      [
        {
          service: "montecarlo",
          type: "data_quality_test",
          metadata: { monitoredDataModelKeys: ["analytics.payments.orders"] },
        },
        "data_model",
      ],
      [
        {
          service: "bigeye",
          type: "data_quality_test",
          metadata: { monitoredDataModelKeys: ["analytics.payments.refunds"] },
        },
        "data_model",
      ],
      [
        {
          service: "pagerduty",
          type: "incident",
          metadata: { nimbus_service_id: "payment-service" },
        },
        "nimbus_service_id",
      ],
      [
        { service: "pagerduty", type: "incident", metadata: { repo: "acme/payment-service" } },
        "repo",
      ],
    ];
    for (const [item, via] of cases) {
      const r = bindTrigger(resolver, configs, item);
      expect(r.block, JSON.stringify(item)).toMatchObject({
        bound: true,
        service: "payment-service",
        via,
      });
      expect(r.config?.serviceId).toBe("payment-service");
      expect(r.gaps).toEqual([]);
    }
  });

  test("unbound items name the key their source needs; excluded and unknown read unbound", () => {
    const r = bindTrigger(resolver, configs, {
      service: "jira",
      type: "alert",
      metadata: { tags: ["unrelated"] },
    });
    expect(r.block).toEqual({ bound: false, service: null, via: null, unboundReason: "unknown" });
    expect(r.config).toBeNull();
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]?.remediation).toContain("jsm_alert_tags");
    for (const [service, key] of [
      ["pagerduty", "pagerduty_services"],
      ["sentry", "sentry_projects"],
      ["montecarlo", "data_models"],
      ["bigeye", "data_models"],
    ] as const) {
      const u = bindTrigger(resolver, configs, { service, type: "x", metadata: {} });
      expect(u.gaps[0]?.remediation).toContain(key);
    }
  });

  test("unreadable metadata is unbound with a distinct reason, never a throw", () => {
    const r = bindTrigger(resolver, configs, {
      service: "sentry",
      type: "error_issue",
      metadata: null,
    });
    expect(r.block.unboundReason).toBe("metadata_unreadable");
    expect(r.gaps[0]?.detail).toContain("could not be read");
  });

  test("a resolver answer that names no known config reads unbound", () => {
    const ghost = (() => ({ kind: "bound", serviceId: "ghost" }) as const) as never;
    const r = bindTrigger(ghost, configs, { service: "jira", type: "alert", metadata: {} });
    expect(r.block.bound).toBe(false);
    expect(NO_INCIDENT_BINDINGS.chatAliases).toEqual([]);
  });
});
