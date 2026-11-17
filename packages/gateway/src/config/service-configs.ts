import type { ServiceConfig } from "../metrics/dora-config.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "./nimbus-toml.ts";

/**
 * The `[metrics.dora.*]` / `[ci.service.*]` service configs, or `[]` when there is no config dir or the
 * blocks are malformed (`loadNimbusServiceConfigsFromConfigDir` THROWS on a malformed block). Read per
 * call so an edit applies without a restart. A read that only uses the configs to RESOLVE a name
 * (on-call lookup) degrades instead of aborting, and says so through `warn`.
 */
export function loadServiceConfigsOrEmpty(
  configDir: string | undefined,
  warn: (message: string) => void,
): ServiceConfig[] {
  if (configDir === undefined) return [];
  try {
    return [...loadNimbusServiceConfigsFromConfigDir(configDir).values()];
  } catch (err) {
    warn(
      `failed to load [metrics.dora.*]/[ci.service.*] from nimbus.toml ` +
        `(${String(err)}); service names will not resolve through bindings.`,
    );
    return [];
  }
}

/**
 * The declared `depends_on` map (service id to its dependencies), read fresh. Unlike
 * {@link loadServiceConfigsOrEmpty} a malformed `[ci.service.*]` block THROWS: the cascade ranks open records
 * from this map, and a map read as empty would rank them as if no dependency were declared. The cascade's
 * callers catch the throw and say the ranking is unavailable.
 */
export function loadDependsOnMap(configDir: string | undefined): Map<string, readonly string[]> {
  if (configDir === undefined) return new Map();
  return new Map(
    [...loadNimbusServiceConfigsFromConfigDir(configDir).values()].map((c) => [
      c.serviceId,
      c.dependsOn,
    ]),
  );
}

/**
 * The two bindings the remediation proposals read for one service (Phase 10 IC5a): its Argo CD applications and its
 * deploy environments. `undefined` for an unbound service, an unreadable config or a missing directory: the
 * proposals then say the application is not bound, never fail.
 */
export function loadServiceBindings(
  configDir: string | undefined,
  service: string | null,
):
  | { readonly argocdApps: readonly string[]; readonly deployEnvironments: readonly string[] }
  | undefined {
  if (configDir === undefined || service === null) return undefined;
  try {
    const cfg = loadNimbusServiceConfigsFromConfigDir(configDir).get(service);
    return cfg === undefined
      ? undefined
      : { argocdApps: cfg.argocdApps, deployEnvironments: cfg.deployEnvironments };
  } catch {
    return undefined;
  }
}
