import type { Database } from "bun:sqlite";
import { resolveSelfPerson } from "../agents/_lib/self-person.ts";
import {
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusUserFromConfigDir,
  resolveNimbusTomlForProfile,
} from "../config/nimbus-toml.ts";
import {
  loadNimbusOncallPushFromPath,
  type NimbusOncallPushToml,
} from "../config/oncall-push-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { emitGatewayEvent } from "../ipc/gateway-events.ts";
import { createOncallPushRunner, type PushRunSummary } from "./push-runner.ts";
import { createPushDeliverer } from "./push-sinks.ts";
import { type PushedBriefRow, PushStore } from "./push-store.ts";

export interface OncallPushRuntime {
  readonly config: NimbusOncallPushToml;
  readonly store: PushStore;
  run(serviceId: string): Promise<PushRunSummary>;
  /** Fire-and-forget for the sync hook; never throws. */
  trigger(serviceId: string): void;
  retry(incidentId: string): Promise<PushedBriefRow>;
  identityResolved(): Promise<boolean>;
}

export interface OncallPushBootDeps {
  readonly db: Database;
  readonly configDir: string;
  readonly localIndex?: LocalIndex;
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
  readonly now?: () => number;
}

export function assembleOncallPushRuntime(deps: OncallPushBootDeps): OncallPushRuntime {
  const now = deps.now ?? Date.now;
  const config = loadNimbusOncallPushFromPath(resolveNimbusTomlForProfile(deps.configDir));
  const store = new PushStore(deps.db);
  // Spec § 4.1: reconciled at BOOT, never on the first run, so the first sync's incidents are
  // never older than enabled_at and a disable→enable cycle never backfills the gap.
  store.reconcileEnabledState(config.enabled, now());

  // The SAME identity source `agents.oncall` uses (configDir `[user]` override, then
  // resolveSelfPerson's git fallback), so push and oncall agree on "me".
  const resolveSelf = async (): Promise<string | null> => {
    const user = loadNimbusUserFromConfigDir(deps.configDir);
    const r = await resolveSelfPerson(
      deps.db,
      user.mePersonId === undefined ? {} : { override: user.mePersonId },
    );
    return r.personId;
  };

  const runner = createOncallPushRunner({
    db: deps.db,
    store,
    config,
    pagerdutyAliases: loadNimbusPagerdutyFromConfigDir(deps.configDir).severityP1Aliases,
    configDir: deps.configDir,
    ...(deps.localIndex === undefined ? {} : { index: deps.localIndex }),
    resolveSelf,
    deliver: createPushDeliverer({
      store,
      notify: deps.notify,
      emit: (p) =>
        emitGatewayEvent("oncall.briefPushed", { incidentId: p.incidentId, status: p.status }),
      now,
    }),
    now,
  });

  return {
    config,
    store,
    run: (serviceId) => runner.run(serviceId),
    trigger(serviceId) {
      runner.run(serviceId).catch((err: unknown) => {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[oncall.push] run failed",
        );
      });
    },
    retry: (incidentId) => runner.retry(incidentId),
    identityResolved: async () => (await resolveSelf()) !== null,
  };
}
