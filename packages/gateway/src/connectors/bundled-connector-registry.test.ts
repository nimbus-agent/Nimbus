import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

import { BUNDLED_CONNECTORS } from "./bundled-connector-registry.ts";

const CONNECTOR_PACKAGE = "@nimbus-dev/connectors";

/**
 * The connector ids the installed package actually EXPOSES.
 *
 * Derived here rather than imported from the generator, so this test can disagree with a stale
 * generated file — that is the whole point of it.
 *
 * It used to scan `packages/mcp-connectors` for directories with `src/server.ts`. The connectors
 * now ship as a package, and the question that matters became stricter: what the exports map
 * exposes, not what exists on disk. A connector packed but absent from the exports map is
 * unreachable to this registry, and version 0.1.0 shipped exactly that shape for
 * `shared/connector-mode.ts` — present in the tarball, missing from `exports`, unimportable.
 */
function exportedIds(): string[] {
  const require = createRequire(import.meta.url);
  const manifest = require(`${CONNECTOR_PACKAGE}/package.json`) as {
    exports?: Record<string, unknown>;
  };
  return Object.keys(manifest.exports ?? {})
    .filter((k) => k.startsWith("./") && !k.slice(2).includes("/"))
    .map((k) => k.slice(2))
    .sort((a, b) => a.localeCompare(b));
}

describe("BUNDLED_CONNECTORS", () => {
  test("contains exactly the connector packages that have an entrypoint", () => {
    const registered = Object.keys(BUNDLED_CONNECTORS).sort((a, b) => a.localeCompare(b));
    const exposed = exportedIds();
    const missing = exposed.filter((id) => !registered.includes(id));
    const extra = registered.filter((id) => !exposed.includes(id));
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
