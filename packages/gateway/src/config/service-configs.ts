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
