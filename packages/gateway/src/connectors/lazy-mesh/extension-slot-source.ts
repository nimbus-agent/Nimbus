import type { ServerSpec } from "./slot.ts";

export interface PreparedExtensionSpawn {
  readonly extensionId: string;
  readonly serviceId: string;
  readonly spec: ServerSpec;
}

/**
 * What the lazy mesh knows about installed extensions. An interface so the mesh never imports the
 * runtime module that assembles a child launch (I43 / D33(a)).
 */
export interface ExtensionSlotSource {
  /** Grant service ids of enabled extensions. Never verifies. */
  listServiceIds(): readonly string[];
  /** Full re-verification + spec build. Throws ExtensionRunGrantError on any refusal. */
  prepareSpawn(serviceId: string): Promise<PreparedExtensionSpawn>;
}
