import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeConnectorServiceId } from "./connector-catalog.ts";
import {
  GATEWAY_SYNCABLE_SERVICE_IDS,
  isGatewaySyncableServiceId,
} from "./gateway-syncable-ids.ts";

describe("gateway syncable service ids", () => {
  test("recognises each listed id", () => {
    for (const id of GATEWAY_SYNCABLE_SERVICE_IDS) {
      expect(isGatewaySyncableServiceId(id)).toBe(true);
    }
  });

  test("rejects a catalog connector, a user-MCP id, and junk", () => {
    expect(isGatewaySyncableServiceId("github")).toBe(false);
    expect(isGatewaySyncableServiceId("mcp_custom")).toBe(false);
    expect(isGatewaySyncableServiceId("")).toBe(false);
    expect(isGatewaySyncableServiceId("../filesystem")).toBe(false);
  });

  test("is disjoint from the connector catalog", () => {
    // If an id ever became a real catalog connector, it would resolve through
    // normalizeConnectorServiceId and this list would be a second, conflicting
    // source of truth for the same name.
    for (const id of GATEWAY_SYNCABLE_SERVICE_IDS) {
      expect(normalizeConnectorServiceId(id)).toBeNull();
    }
  });

  test("every listed id is actually registered with the scheduler by assemble.ts", () => {
    // The whole point of the list is that these two sites agree. A drift here
    // means either an unreachable id in the validator, or a registered
    // syncable that `connector.sync` still rejects — which is the bug this
    // module was added to fix.
    const assemble = readFileSync(join(import.meta.dir, "..", "platform", "assemble.ts"), "utf8");
    for (const id of GATEWAY_SYNCABLE_SERVICE_IDS) {
      expect(assemble).toContain(`ensureConnectorSchedulerRegistration("${id}"`);
    }
  });

  test("assemble.ts registers no non-catalog id that is missing from this list", () => {
    const assemble = readFileSync(join(import.meta.dir, "..", "platform", "assemble.ts"), "utf8");
    const registered = [
      ...assemble.matchAll(/ensureConnectorSchedulerRegistration\("([a-z_]+)"/g),
    ].map((m) => m[1] ?? "");
    const missing = registered.filter(
      (id) => normalizeConnectorServiceId(id) === null && !isGatewaySyncableServiceId(id),
    );
    expect(missing).toEqual([]);
  });
});
