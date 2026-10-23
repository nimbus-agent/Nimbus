import { describe, expect, test } from "bun:test";
import {
  TEAM_CREDENTIAL_CONNECTORS,
  TEAM_CREDENTIAL_SYNC_CONNECTORS,
} from "../config/nimbus-toml-connectors.ts";
import { DEFAULT_NIMBUS_WORKDAY_TOML } from "../config/nimbus-toml-workday.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { isWarehouseListSyncable } from "../connectors/warehouse-sync-transport.ts";
import type { Syncable } from "../sync/types.ts";
import { registerConnectorMeshSyncables } from "./assemble-sync-registrations.ts";

/** Every syncable the production registration wires, against a mesh that is never called. */
function registeredSyncables(): Syncable[] {
  const out: Syncable[] = [];
  const mesh = new Proxy(
    {},
    {
      get: () => () => Promise.reject(new Error("the mesh is not used by this test")),
    },
  ) as unknown as LazyConnectorMesh;
  registerConnectorMeshSyncables({ register: (s) => void out.push(s) }, mesh, {
    pagerdutyMaxPagesPerSync: 1,
    workdayConfig: DEFAULT_NIMBUS_WORKDAY_TOML,
  });
  return out;
}

describe("TEAM_CREDENTIAL_SYNC_CONNECTORS", () => {
  // `isConnectorConfigured` judges a team-pinned id by its team entry only for these ids, because
  // only their sync drains through the team credential. If a connector moves onto (or off) the
  // warehouse transport without this set following, a team pin would skip a valid sync or
  // fabricate a `sync.run` row — so the set is checked against what is actually registered.
  test("equals the ids registered on the warehouse list transport", () => {
    const syncables = registeredSyncables();
    expect(syncables.length).toBeGreaterThan(80);
    const warehouseIds = syncables
      .filter(isWarehouseListSyncable)
      .map((s) => s.serviceId)
      .sort();
    expect(warehouseIds).toEqual([...TEAM_CREDENTIAL_SYNC_CONNECTORS].sort());
  });

  test("is a subset of the team-credential connectors", () => {
    for (const id of TEAM_CREDENTIAL_SYNC_CONNECTORS) {
      expect(TEAM_CREDENTIAL_CONNECTORS as readonly string[]).toContain(id);
    }
  });
});
