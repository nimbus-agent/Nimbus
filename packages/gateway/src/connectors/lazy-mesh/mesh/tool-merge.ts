import type { LazyDrainTracker } from "../drain.ts";
import { EXT_MESH_PREFIX, USER_MESH_PREFIX } from "../keys.ts";
import type { LazyMcpSlot } from "../slot.ts";
import { type LazyMeshToolMap, listLazyMeshClientTools, serviceIdForToolKey } from "../tool-map.ts";

// The merged dispatcher listing's building blocks, moved verbatim out of `LazyConnectorMesh`: each
// takes what it reads (the slot map, the allowlist) instead of `this`.

// `mesh:user:` slots only, here and in `ensureUserMcpConnectorsRunning`: extension (`mesh:ext:`)
// tools are not offered to the model until a later PR, so they never enter the merged dispatcher
// map, and `buildSlotForToolMap` never lists an extension slot either.

/**
 * Lists the user slots one at a time, in slot order, so a later slot still wins a shared tool
 * name. Unlike the refcount listing below, this walk stays sequential: a user slot's first
 * listing connects its `MCPClient`, which spawns the user-configured server through the sandbox
 * wrapper, and nothing caps how many user MCPs are registered. Listing them together would start
 * every one of those servers at once, and on Windows each confined spawn's helper rewrites the
 * DACL of the one shared sandbox cwd with an unlocked read-modify-write.
 */
export async function collectUserMcpToolMap(
  lazySlots: ReadonlyMap<string, LazyMcpSlot>,
): Promise<LazyMeshToolMap> {
  let merged: LazyMeshToolMap = {};
  for (const [meshKey, slot] of lazySlots) {
    if (!meshKey.startsWith(USER_MESH_PREFIX) || slot.client === undefined) {
      continue;
    }
    const tools = await listLazyMeshClientTools(slot.client); // NOSONAR S9382: a user slot's first listing spawns its user-configured server; the user-MCP count is uncapped, so they start one at a time, not as a burst of sandboxed spawns
    merged = { ...merged, ...tools };
  }
  return merged;
}

/**
 * Lists every live slot concurrently, then maps each tool to the FIRST slot (in slot order)
 * that lists it — the same first-wins answer the one-slot-at-a-time walk gave. A slot whose
 * listing fails is skipped, as before.
 */
export async function buildSlotForToolMap(
  lazySlots: ReadonlyMap<string, LazyMcpSlot>,
): Promise<Map<string, LazyDrainTracker>> {
  // `mesh:ext:` slots are skipped: their tools are never in the merged map, and a first-party
  // dispatch must not contact an extension's process.
  const liveSlots = Array.from(lazySlots.entries()).flatMap(([key, slot]) =>
    slot.client === undefined || key.startsWith(EXT_MESH_PREFIX)
      ? []
      : [{ client: slot.client, drain: slot.drain }],
  );
  const listings = await Promise.all(
    liveSlots.map(async ({ client, drain }) => {
      try {
        const tools = (await client.listTools()) as LazyMeshToolMap;
        return { drain, toolKeys: Object.keys(tools) };
      } catch {
        return undefined; // slot disappearing — skip
      }
    }),
  );
  const slotForTool = new Map<string, LazyDrainTracker>();
  for (const listing of listings) {
    if (listing === undefined) continue;
    for (const k of listing.toolKeys) {
      if (!slotForTool.has(k)) slotForTool.set(k, listing.drain);
    }
  }
  return slotForTool;
}

export function wrapMergedToolsWithRefcount(
  merged: LazyMeshToolMap,
  slotForTool: ReadonlyMap<string, LazyDrainTracker>,
): void {
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    const original = value?.execute;
    const drain = slotForTool.get(key);
    if (value === undefined || original === undefined || drain === undefined) continue;
    merged[key] = {
      execute: async (input: unknown, ctx?: unknown): Promise<unknown> => {
        drain.bump();
        try {
          return await original(input, ctx);
        } finally {
          drain.drop();
        }
      },
    };
  }
}

/**
 * Org-policy connector allowlist enforcement (I22). Removes from the dispatcher tool map every
 * tool whose owning connector service id is not permitted by policy. Tools that do not map to a
 * known connector service (filesystem, user-MCP/extension tools) are left untouched — the policy
 * allowlist governs first-party cloud connectors only.
 */
export function dropDisallowedConnectorTools(
  merged: LazyMeshToolMap,
  isConnectorAllowed: (serviceId: string) => boolean,
): void {
  for (const key of Object.keys(merged)) {
    const serviceId = serviceIdForToolKey(key);
    if (serviceId !== undefined && !isConnectorAllowed(serviceId)) {
      delete merged[key];
    }
  }
}
