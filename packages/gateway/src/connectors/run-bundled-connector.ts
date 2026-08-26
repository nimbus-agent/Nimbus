import { setConnectorMode } from "@nimbus-dev/connectors/shared/connector-mode.ts";
import { BUNDLED_CONNECTORS } from "./bundled-connector-registry.ts";

/**
 * The two shapes a connector entrypoint can take: 84 connect their stdio transport at module scope,
 * so importing them starts them; ten guard that behind `import.meta.main` — false under an import —
 * and export `startConnector()` instead. `check-connector-entrypoints.ts` enforces that a guarded
 * entrypoint always exports it.
 */
interface ConnectorModule {
  readonly startConnector?: () => Promise<void>;
}

export type ConnectorRegistry = Readonly<Record<string, () => Promise<unknown>>>;

/**
 * Run one bundled connector in-process, as the `__nimbus-connector` role of the gateway executable.
 *
 * Calling `startConnector` when present covers both entrypoint shapes without the caller knowing
 * which one it got.
 */
export async function runBundledConnector(
  id: string | undefined,
  registry: ConnectorRegistry = BUNDLED_CONNECTORS,
): Promise<void> {
  // I2 lives in the gateway's executor, so a gateway-spawned connector keeps its full tool surface
  // and does not gate itself. Set BEFORE the dynamic import below: connectors register tools at
  // module scope, so a mode set afterwards would be read too late. This is the ONLY production
  // caller that passes "gateway" — `audit:connector-consent` confines the setter to it.
  setConnectorMode("gateway");

  const load = id === undefined ? undefined : registry[id];
  if (load === undefined) {
    const known = Object.keys(registry)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    throw new Error(`unknown connector id ${JSON.stringify(id ?? "")}; known ids: ${known}`);
  }
  const mod = (await load()) as ConnectorModule;
  if (typeof mod.startConnector === "function") {
    await mod.startConnector();
  }
}
