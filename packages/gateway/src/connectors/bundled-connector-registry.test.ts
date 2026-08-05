import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { BUNDLED_CONNECTORS } from "./bundled-connector-registry.ts";

const CONNECTORS_DIR = resolve(import.meta.dir, "..", "..", "..", "mcp-connectors");

/** Derived here rather than imported, so this test disagrees with a stale generated file. */
function idsOnDisk(): string[] {
  return readdirSync(CONNECTORS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(CONNECTORS_DIR, e.name, "src", "server.ts")))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

describe("BUNDLED_CONNECTORS", () => {
  test("contains exactly the connector packages that have an entrypoint", () => {
    const registered = Object.keys(BUNDLED_CONNECTORS).sort((a, b) => a.localeCompare(b));
    const onDisk = idsOnDisk();
    const missing = onDisk.filter((id) => !registered.includes(id));
    const extra = registered.filter((id) => !onDisk.includes(id));
    // Name the fix in the failure itself: this test fires when someone adds a connector, and the
    // remedy is one command they have no reason to know about.
    expect({ missing, extra }, "registry is stale — run `bun run gen:connector-registry`").toEqual({
      missing: [],
      extra: [],
    });
  });

  test("covers every connector — a shrinking registry is the drift this guards", () => {
    expect(Object.keys(BUNDLED_CONNECTORS).length).toBeGreaterThanOrEqual(94);
  });

  test("every entry is a lazy loader, not an eagerly evaluated module", () => {
    for (const [id, load] of Object.entries(BUNDLED_CONNECTORS)) {
      expect(typeof load, `${id} must be a function`).toBe("function");
    }
  });
});
