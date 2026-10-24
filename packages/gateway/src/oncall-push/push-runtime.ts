import type { Database } from "bun:sqlite";
import { resolveSelfPerson } from "../agents/_lib/self-person.ts";
import {
  assertLayersReadable,
  getLayeredConfig,
  layerReadError,
} from "../config/layered-config.ts";
import {
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusUserFromConfigDir,
} from "../config/nimbus-toml.ts";
import {
  loadNimbusOncallPushFromConfigDir,
  type NimbusOncallPushToml,
} from "../config/oncall-push-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { emitGatewayEvent } from "../ipc/gateway-events.ts";
import { createLiveEnabled } from "./push-live-enabled.ts";
import { createOncallPushRunner, type PushRunSummary } from "./push-runner.ts";
import { type ChatopsPoster, createPushDeliverer } from "./push-sinks.ts";
import { type PushedBriefRow, PushStore } from "./push-store.ts";

const DAY_MS = 86_400_000;

export interface OncallPushRuntime {
  /**
   * The boot-time read of every key but `enabled`, which is live (role-packs spec § 5.9) and read
   * only through `isEnabled()`. Omitting it makes a stale boot-time reader a compile error.
   */
  readonly config: Omit<NimbusOncallPushToml, "enabled">;
  /** Live `[oncall.push] enabled`: re-read when the layered config's version moves. */
  isEnabled(): boolean;
  /**
   * Stops the live reader's timer and freezes `isEnabled()` at its last value (no further
   * reloads). Idempotent; `platform/assemble.ts` calls it at shutdown.
   */
  stop(): void;
  readonly store: PushStore;
  run(serviceId: string): Promise<PushRunSummary>;
  /** Fire-and-forget for the sync hook; never throws. */
  trigger(serviceId: string): void;
  retry(incidentId: string): Promise<PushedBriefRow>;
  identityResolved(): Promise<boolean>;
  /**
   * Design § 4 (2026-10-02-oncall-push-chatops-design.md) (boot race): bind the ChatOps poster, or record that there is none, and release every
   * run held since boot. `platform/assemble.ts` calls it exactly once, right after ChatOps boots, on
   * the enabled AND the disabled branch. A second call throws.
   */
  settleChatopsPoster(post: ChatopsPoster | undefined): void;
  /** `pending` until settled, then `bound` (a poster) or `none`. */
  chatopsSinkState(): "pending" | "bound" | "none";
}

export interface OncallPushBootDeps {
  readonly db: Database;
  readonly configDir: string;
  readonly localIndex?: LocalIndex;
  /**
   * Structurally `NotificationService`: `delivers: false` makes every toast record `skipped`. Read
   * at delivery time — pass the service itself (whose `delivers` may be a getter), never a copy.
   */
  readonly notifications: {
    show(title: string, body: string): void | Promise<void>;
    readonly delivers?: boolean;
  };
  /** `warn` is optional so test loggers need not supply it; production passes the pino logger. */
  readonly logger: {
    error(obj: Record<string, unknown>, msg: string): void;
    warn?(obj: Record<string, unknown>, msg: string): void;
  };
  /**
   * Start settled with no poster. For tests and any caller with no ChatOps phase. Production
   * leaves it unset so no run starts before `assemble.ts` has decided whether ChatOps exists.
   */
  readonly settleImmediately?: boolean;
  readonly now?: () => number;
  /** The layered snapshot's version. Defaults to `getLayeredConfig(configDir)`'s. */
  readonly version?: () => number;
  /** How often the live `enabled` reader polls. Defaults to `ONCALL_PUSH_RELOAD_CHECK_MS`. */
  readonly checkMs?: number;
}

export function assembleOncallPushRuntime(deps: OncallPushBootDeps): OncallPushRuntime {
  const now = deps.now ?? Date.now;
  const version = deps.version ?? (() => getLayeredConfig(deps.configDir).snapshot().version);
  // Read BEFORE the config: a change landing between the two reads then shows as a newer version
  // on the first refresh and is re-read, rather than being stamped as already seen.
  const bootVersion = version();
  const loaded = loadNimbusOncallPushFromConfigDir(deps.configDir);
  // The layered snapshot treats a layer it could not read as ABSENT, so an unreadable owner file
  // (`enabled = false`) would let a pack's `enabled = true` win. A partial config therefore reads
  // as disabled at boot, and the live reader below refuses it, keeping its last value.
  const bootReadError = layerReadError(deps.configDir);
  if (bootReadError !== undefined) {
    deps.logger.warn?.({ err: bootReadError }, "[oncall.push] config layer unreadable; disabled");
  }
  const config: NimbusOncallPushToml =
    bootReadError === undefined ? loaded : { ...loaded, enabled: false };
  const store = new PushStore(deps.db);
  // Spec § 4.1: reconciled at BOOT, never on the first run, so the first sync's incidents are
  // never older than enabled_at and a disable→enable cycle never backfills the gap.
  store.reconcileEnabledState(config.enabled, now());
  // Retention is enforced at boot REGARDLESS of `enabled`: the per-run prune only runs on a
  // PagerDuty-triggered run past its early returns, so a disabled push, an unresolved identity or
  // a connector that stopped syncing would otherwise keep rows past `retention_days` forever.
  store.pruneOlderThan(now() - config.retentionDays * DAY_MS);

  // Built AFTER the boot reconcile, from the same read, so the live value and the row agree. From
  // here on `enabled` is live (role-packs spec § 5.9): a later change is reconciled before the
  // runner can see it, so the runner never sees "enabled" without its `enabled_at` row.
  const live = createLiveEnabled(
    {
      version,
      load: () => {
        // Refuse a partial config (the throw keeps the last value and logs once per version).
        assertLayersReadable(deps.configDir);
        return loadNimbusOncallPushFromConfigDir(deps.configDir).enabled;
      },
      reconcile: (e, t) => store.reconcileEnabledState(e, t),
      now,
      logger: deps.logger,
      ...(deps.checkMs === undefined ? {} : { checkMs: deps.checkMs }),
    },
    { version: bootVersion, enabled: config.enabled },
  );
  live.start();
  const isEnabled = (): boolean => live.isEnabled();
  const { enabled: _bootEnabled, ...bootConfig } = config;

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

  // Design § 4 (2026-10-02-oncall-push-chatops-design.md): the sync scheduler can complete a PagerDuty sync before ChatOps has booted. A run
  // that delivered then would record "ChatOps not running", and dedup would never reselect it.
  // So nothing starts until the poster is settled; early runs wait rather than drop.
  let settled = deps.settleImmediately === true;
  let chatopsPoster: ChatopsPoster | undefined;
  let release: () => void = () => {};
  const gate: Promise<void> = settled
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        release = resolve;
      });
  const run = async (serviceId: string): Promise<PushRunSummary> => {
    await gate;
    return runner.run(serviceId);
  };

  const runner = createOncallPushRunner({
    db: deps.db,
    store,
    config: bootConfig,
    isEnabled,
    pagerdutyAliases: loadNimbusPagerdutyFromConfigDir(deps.configDir).severityP1Aliases,
    configDir: deps.configDir,
    ...(deps.localIndex === undefined ? {} : { index: deps.localIndex }),
    resolveSelf,
    deliver: createPushDeliverer({
      store,
      notify: (title, body) => deps.notifications.show(title, body),
      // LIVE: read on every delivery, so a probe that resolves (or fails) after boot is honoured.
      notifyDelivers: () => deps.notifications.delivers !== false,
      emit: (p) =>
        emitGatewayEvent("oncall.briefPushed", { incidentId: p.incidentId, status: p.status }),
      now,
      chatops: { namespace: config.chatopsNamespace, post: () => chatopsPoster },
      warn: (msg, fields) => deps.logger.warn?.(fields, msg),
    }),
    now,
  });

  return {
    config: bootConfig,
    isEnabled,
    stop: () => live.stop(),
    store,
    run,
    trigger(serviceId) {
      run(serviceId).catch((err: unknown) => {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[oncall.push] run failed",
        );
      });
    },
    retry: async (incidentId) => {
      await gate;
      return runner.retry(incidentId);
    },
    identityResolved: async () => (await resolveSelf()) !== null,
    settleChatopsPoster(post) {
      if (settled) throw new Error("[oncall.push] settleChatopsPoster: already settled");
      settled = true;
      chatopsPoster = post;
      release();
    },
    chatopsSinkState() {
      if (!settled) return "pending";
      return chatopsPoster === undefined ? "none" : "bound";
    },
  };
}
