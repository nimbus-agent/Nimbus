import { describe, expect, test } from "vitest";
import type { ConnectorStatus } from "../../../src/ipc/types";

/**
 * Lives under `packages/ui/test/`, never `packages/ui/src/`: every UI test in this repo does
 * (`packages/ui/test/components/dashboard/ConnectorGrid.test.tsx` is its neighbour), and a test
 * file under `src/` risks landing in the Vite production bundle.
 *
 * `packages/ui`'s real runner is vitest (`bunx vitest run`), not `bun test` — this file must
 * import from `"vitest"`, not `"bun:test"`, or `vitest run` fails to collect it.
 *
 * NOT a drift guard. `GATEWAY_PAYLOAD` below is a hand-typed literal, not something imported
 * from the gateway — `packages/ui` may not import gateway source at all (the IPC-only dependency
 * rule), so no file in this package can bind to the emitter and catch a real rename. This is a
 * MANUALLY VERIFIED SNAPSHOT of the payload `emitConnectorHealthChanged` broadcast when this file
 * was written (`packages/gateway/src/connectors/health.ts`, read at the time), pinning only the
 * DESKTOP half: that `ConnectorGrid`'s reads (`payload.name`, `payload.health`) are satisfiable
 * against this shape and that the health value is legal for `ConnectorStatus["health"]`. The
 * GATEWAY half — that the emitter actually sends these field names — is pinned separately by
 * `health-events.test.ts`'s "emits the DESKTOP's field names, so ConnectorGrid can patch a row"
 * test in the gateway package. The only real end-to-end binding across the two packages is the
 * integration test added in Task 9 of this plan.
 */
interface HealthChangedPayload {
  readonly name: string;
  readonly health: ConnectorStatus["health"];
  readonly degradationReason?: string;
}

/**
 * A manually verified snapshot of the object `emitConnectorHealthChanged` broadcast at the time
 * this file was written — not a live value, and not proof that the two sides still agree today.
 */
const GATEWAY_PAYLOAD = {
  name: "github",
  health: "error",
  degradationReason: "sync failed after repeated attempts",
  fromState: "degraded",
  reason: "sync failed after repeated attempts",
  occurredAt: 1_789_300_000_000,
} as const;

describe("connector.healthChanged desktop contract", () => {
  test("the documented gateway payload is one ConnectorGrid can read", () => {
    const payload = GATEWAY_PAYLOAD as unknown as HealthChangedPayload;
    // `patchConnector(payload.name, { health: payload.health })` — both must be defined, or the
    // patch matches no row and the panel silently does not update.
    expect(payload.name).toBe("github");
    expect(payload.health).toBe("error");
    expect(payload.name).not.toBeUndefined();
    expect(payload.health).not.toBeUndefined();
  });

  test("the documented health value is one of the seven ConnectorGrid renders", () => {
    // Exhaustive over what the gateway can emit: `ConnectorHealthState` (gateway) and
    // `ConnectorStatus["health"]` (desktop) now agree on all seven members, `not_configured`
    // included (`buildSnapshot` genuinely returns it, `health.ts`, and the `not_configured`
    // transition arm can emit it) — closing the gap this test used to document, where the desktop
    // folded an unconfigured connector into "healthy" and rendered it as a green tile.
    const valid: ReadonlyArray<ConnectorStatus["health"]> = [
      "healthy",
      "degraded",
      "error",
      "rate_limited",
      "unauthenticated",
      "paused",
      "not_configured",
    ];
    expect(valid).toContain(GATEWAY_PAYLOAD.health);
    expect(GATEWAY_PAYLOAD.health).not.toBe("persistent_error");
  });

  test("the extra gateway fields do not collide with what the desktop reads", () => {
    // `fromState`/`reason`/`occurredAt` are for `nimbus tail`. The desktop ignores them; this
    // pins that they are ADDITIONS, not renames of the fields it needs, in this snapshot.
    const keys = Object.keys(GATEWAY_PAYLOAD);
    expect(keys).toContain("name");
    expect(keys).toContain("health");
    expect(keys).not.toContain("connectorId");
    expect(keys).not.toContain("toState");
  });
});
