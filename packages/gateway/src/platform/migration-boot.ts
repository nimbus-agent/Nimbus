/**
 * The connector migration engine's place in gateway composition (connector-unbundling spec § 7.2).
 *
 * Ruling B1: the built-in official registry and the continuity table reach a real gateway ONLY as
 * composition options a test runner passes to `assemblePlatformServices` — never an environment
 * variable, a config file or an IPC parameter. Production passes none, so both stay at their baked
 * defaults (the baked `BUILTIN_REGISTRY`, and `CONTINUITY_TABLE` with its Readwise entry), so boot
 * `evaluate()` acts on Readwise. Whatever is resolved here is ONE value, handed to every consumer that binds through it: the
 * engine, the extension sync registrar, the spawn verifier, the scheduler's credential resolver,
 * `extension remove`'s purge, and the registry fetch deps (`RegistryFetchDeps.builtin`). Two tables
 * would let the engine approve a binding the registrar or the verifier then refuses.
 */
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import {
  CONTINUITY_TABLE,
  type ContinuityEntry,
} from "../extensions/continuity/continuity-table.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import {
  createMigrationEngine,
  type MigrationEngine,
  type MigrationEngineDeps,
} from "../extensions/migration/migration-engine.ts";
import {
  BUILTIN_REGISTRY,
  type BuiltinRegistryConfig,
} from "../extensions/registry/builtin-registry.ts";
import type { RegistryFetchDeps } from "../extensions/registry/registry-fetch.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Composition-only options for `assemblePlatformServices`. Absent in every production caller
 * (`platform/{win32,darwin,linux}.ts` pass the paths alone); an E2E runner passes a fixture.
 */
export interface AssembleCompositionOptions {
  readonly migration?: {
    /** Absent means the baked `BUILTIN_REGISTRY`; `null` means none. */
    readonly builtin?: BuiltinRegistryConfig | null;
    /** Absent means the production `CONTINUITY_TABLE`. */
    readonly continuityTable?: readonly ContinuityEntry[];
  };
}

/** The one resolved value every migration-aware consumer is handed. */
export interface MigrationComposition {
  readonly builtin: BuiltinRegistryConfig | null;
  readonly continuityTable: readonly ContinuityEntry[];
}

export function resolveMigrationComposition(
  opts: AssembleCompositionOptions | undefined,
): MigrationComposition {
  const builtin = opts?.migration?.builtin;
  return {
    builtin: builtin === undefined ? BUILTIN_REGISTRY : builtin,
    continuityTable: opts?.migration?.continuityTable ?? CONTINUITY_TABLE,
  };
}

export interface MigrationEngineBootDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly dataDir: string;
  readonly extensionsDir: string;
  /** The SAME fetch bag the `registry.*` methods get; its `builtin` is ignored (the engine's wins). */
  readonly registryFetch: Omit<RegistryFetchDeps, "db">;
  readonly composition: MigrationComposition;
  readonly env: ExtensionRunGrantEnv;
  readonly runtimeEnabled: boolean;
  readonly sandbox: MigrationEngineDeps["sandbox"];
  readonly extensionSync: MigrationEngineDeps["extensionSync"];
  readonly scheduler: MigrationEngineDeps["scheduler"];
  readonly logger: Pick<Logger, "info" | "warn">;
}

/**
 * The production engine. Builds the deps field by field, so no test seam of the engine
 * (`installVerified`, `removeInstallTree`, `isBundledConnector`, `newId`) can reach production.
 */
export function createMigrationEngineForBoot(d: MigrationEngineBootDeps): MigrationEngine {
  return createMigrationEngine({
    db: d.db,
    vault: d.vault,
    dataDir: d.dataDir,
    extensionsDir: d.extensionsDir,
    fetch: {
      fetchFn: d.registryFetch.fetchFn,
      enforceAirGap: d.registryFetch.enforceAirGap,
      now: d.registryFetch.now,
      production: d.registryFetch.production,
    },
    builtin: d.composition.builtin,
    continuityTable: d.composition.continuityTable,
    env: d.env,
    runtimeEnabled: d.runtimeEnabled,
    sandbox: d.sandbox,
    extensionSync: d.extensionSync,
    scheduler: d.scheduler,
    now: Date.now,
    logger: d.logger,
  });
}

/**
 * Boot: `evaluate()` once the extension boot gate has run, unless the gateway is demo-rooted (I41).
 * Never awaited on the boot path — it can fetch — and never fatal: a rejection is logged and the
 * gateway carries on. Returns the settled promise, or `undefined` when skipped.
 */
export function startMigrationBootEvaluation(
  engine: Pick<MigrationEngine, "evaluate">,
  demo: boolean,
  logger: Pick<Logger, "warn">,
): Promise<void> | undefined {
  if (demo) return undefined;
  const warn = (e: unknown): void => {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "connector migration boot evaluation failed; the gateway continues",
    );
  };
  // An async wrapper keeps a SYNCHRONOUS throw from `evaluate` in the promise chain, so it reaches
  // `warn` too; `evaluate` itself still starts running before this returns.
  return (async () => engine.evaluate())().catch(warn);
}
