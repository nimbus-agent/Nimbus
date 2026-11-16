import type { ServiceConfig } from "../../metrics/dora-config.ts";
import type { ServiceIdentityResolver } from "../../metrics/service-identity.ts";
import type { BindingBlock, BindingVia, GapNote } from "../incident-record-types.ts";
import type { TriggerService } from "../trigger-sources.ts";
import { gap } from "./caps.ts";

/**
 * Lane 1, service binding (Phase 10 IC3, design C step 3). Resolves the trigger item to a configured Nimbus
 * service through the IC2 resolver (the same one the graph populator uses), then says WHICH key bound it, so
 * the record shows why. An unbound trigger gets a gap naming the binding key its source needs, and lanes 2
 * to 5 are skipped by the assembler.
 */

export type BindingResult = {
  readonly block: BindingBlock;
  readonly config: ServiceConfig | null;
  readonly gaps: readonly GapNote[];
};

const KEY_FOR_SOURCE: Readonly<Record<TriggerService, string>> = {
  pagerduty: "pagerduty_services",
  jira: "jsm_alert_tags",
  sentry: "sentry_projects",
  montecarlo: "data_models",
  bigeye: "data_models",
};

const KEY_HINT: Readonly<Record<TriggerService, string>> = {
  pagerduty: "add this incident's PagerDuty service id to `pagerduty_services`",
  jira: "add one of this alert's tags to `jsm_alert_tags`",
  sentry: "add this issue's project slug to `sentry_projects`",
  montecarlo: "add a glob that matches the monitored table to `data_models`",
  bigeye: "add a glob that matches the monitored table to `data_models`",
};

function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** The binding path the resolver took, in its own order: nimbus id, PagerDuty id, repo, then the source's key. */
function viaOf(
  service: TriggerService,
  meta: Record<string, unknown>,
  cfg: ServiceConfig,
): BindingVia {
  if (str(meta, "nimbus_service_id") === cfg.serviceId) return "nimbus_service_id";
  const pd = str(meta, "pagerduty_service_id");
  if (pd !== null && cfg.pagerdutyServices.includes(pd)) return "pagerduty_service";
  const repo = str(meta, "repo");
  if (repo !== null && cfg.repos.some((r) => r.providerId === repo)) return "repo";
  if (service === "jira") return "jsm_alert_tag";
  if (service === "sentry") return "sentry_project";
  if (service === "montecarlo" || service === "bigeye") return "data_model";
  return "pagerduty_service";
}

function unbound(
  service: TriggerService,
  reason: "excluded" | "unknown" | "metadata_unreadable",
): BindingResult {
  const key = KEY_FOR_SOURCE[service];
  const detail =
    reason === "metadata_unreadable"
      ? "This item's metadata could not be read, so it was not bound to a service."
      : `This ${service} item is not bound to a configured service, so the change, chat, prior-incident and concurrent lanes were skipped.`;
  return {
    block: { bound: false, service: null, via: null, unboundReason: reason },
    config: null,
    gaps: [
      gap(
        "missing_relation_emit",
        detail,
        `In nimbus.toml, under a [ci.service.<id>] table, ${KEY_HINT[service]} (the \`${key}\` key).`,
      ),
    ],
  };
}

export function bindTrigger(
  resolver: ServiceIdentityResolver,
  configs: ReadonlyMap<string, ServiceConfig>,
  item: {
    readonly service: TriggerService;
    readonly type: string;
    readonly metadata: Record<string, unknown> | null;
  },
): BindingResult {
  if (item.metadata === null) return unbound(item.service, "metadata_unreadable");
  const resolution = resolver({
    service: item.service,
    type: item.type,
    metadata: item.metadata,
  });
  if (resolution.kind !== "bound") return unbound(item.service, resolution.kind);
  const cfg = configs.get(resolution.serviceId);
  if (cfg === undefined) return unbound(item.service, "unknown");
  return {
    block: {
      bound: true,
      service: cfg.serviceId,
      via: viaOf(item.service, item.metadata, cfg),
      unboundReason: null,
    },
    config: cfg,
    gaps: [],
  };
}
