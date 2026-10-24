import { describe, expect, test } from "bun:test";
import { CONNECTOR_SERVICE_IDS, UNBUNDLED_CONNECTOR_IDS } from "../connectors/connector-catalog.ts";
import { GATEWAY_SYNCABLE_SERVICE_IDS } from "../connectors/gateway-syncable-ids.ts";
import { CONNECTOR_CATALOG_META } from "./connector-catalog-meta.ts";

describe("CONNECTOR_CATALOG_META", () => {
  test("covers every bundled catalog id and gateway-syncable id, with no extras", () => {
    const unbundled: ReadonlySet<string> = new Set(UNBUNDLED_CONNECTOR_IDS);
    const expected = [
      ...CONNECTOR_SERVICE_IDS.filter((id) => !unbundled.has(id)),
      ...GATEWAY_SYNCABLE_SERVICE_IDS,
    ].sort();
    expect(Object.keys(CONNECTOR_CATALOG_META).sort()).toEqual(expected);
  });

  test("no unbundled connector id is a key", () => {
    expect(UNBUNDLED_CONNECTOR_IDS.length).toBeGreaterThan(0);
    for (const id of UNBUNDLED_CONNECTOR_IDS) {
      expect(Object.hasOwn(CONNECTOR_CATALOG_META, id), id).toBe(false);
    }
  });

  test("descriptions are single-line and at most 100 chars; display names at most 40", () => {
    for (const [id, meta] of Object.entries(CONNECTOR_CATALOG_META)) {
      expect(meta.description.length, id).toBeGreaterThan(0);
      expect(meta.description.length, id).toBeLessThanOrEqual(100);
      expect(meta.description, id).not.toMatch(/[\r\n]/);
      expect(meta.displayName.length, id).toBeGreaterThan(0);
      expect(meta.displayName.length, id).toBeLessThanOrEqual(40);
    }
  });
});
