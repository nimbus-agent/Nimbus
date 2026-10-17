// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { ServerSpec } from "./slot.ts";

export interface PreparedExtensionSpawn {
  readonly extensionId: string;
  readonly serviceId: string;
  readonly spec: ServerSpec;
  /**
   * Deletes the staged copy this preparation made. Called when the spawn is abandoned after the
   * preparation resolved (withdrawn or stopped meanwhile): no later spawn sweeps the stage of an
   * extension that was removed or revoked, so without it a copy of that code outlives it (I43).
   */
  discard(): void;
}

/**
 * What the lazy mesh knows about installed extensions. An interface so the mesh never imports the
 * runtime module that assembles a child launch (I43 / D33(a)).
 */
export interface ExtensionSlotSource {
  /** Grant service ids of enabled extensions. Never verifies. */
  listServiceIds(): readonly string[];
  /**
   * Whether the resolved org policy (I22) allows this service id right now. Read on EVERY listing,
   * including one that reuses a live client, so a tightened allowlist stops a running extension.
   */
  isAllowed(serviceId: string): boolean;
  /** The extension id when `serviceId` is approved but its extension is disabled; else undefined. */
  disabledExtensionIdFor(serviceId: string): string | undefined;
  /** Full re-verification + spec build. Throws ExtensionRunGrantError on any refusal. */
  prepareSpawn(serviceId: string): Promise<PreparedExtensionSpawn>;
}
