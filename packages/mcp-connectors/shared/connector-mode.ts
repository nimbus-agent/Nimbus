/**
 * Which entrypoint started this connector process, and therefore whether the connector's own
 * consent gate is in force.
 *
 * `"gateway"` — started by `run-bundled-connector.ts` as the gateway's `__nimbus-connector` role.
 * The gateway's executor provides HITL (I2), so the connector registers its full tool surface.
 *
 * `"standalone"` — anything else. The connector hardens itself: write tools register only behind a
 * client that can prompt a human, and every mutation is scope-checked, budgeted and audited.
 *
 * Standalone is the DEFAULT deliberately. If the gateway's one wiring line is ever lost, the
 * gateway degrades to read-only — loud and safe — rather than the standalone build silently
 * ungating. The failure mode must point that way.
 *
 * The mode is derived from which entrypoint ran, never from an env var: Non-Negotiable #2 forbids a
 * consent gate that can be "configured away", and an env var in a client's JSON config is exactly
 * that.
 */
export type ConnectorMode = "gateway" | "standalone";

let current: ConnectorMode | undefined;

/**
 * Lock the mode for this process.
 *
 * Set-once: re-asserting the same value is a no-op, but a CONFLICTING change throws. Reading via
 * `getConnectorMode` also locks, so a gateway wire that runs too late — after a connector module
 * has already registered tools against the default — fails loudly instead of leaving a surface that
 * half-registered under one mode and half under another.
 */
export function setConnectorMode(mode: ConnectorMode): void {
  if (current !== undefined && current !== mode) {
    throw new Error(
      `connector mode already locked to "${current}"; refusing to change it to "${mode}"`,
    );
  }
  current = mode;
}

/** The active mode, locking in the standalone default on first read. */
export function getConnectorMode(): ConnectorMode {
  current ??= "standalone";
  return current;
}

/**
 * TEST-ONLY: clear the lock between cases. Never called from production code — the
 * `audit:connector-consent` gate permits `setConnectorMode` only in the two sanctioned entrypoints,
 * and this function exists so tests never need to reach for it.
 *
 * This matters more than it looks. `bun test` runs MANY TEST FILES IN ONE PROCESS — verified: two
 * files sharing a module observed the same pid, and state set by the first was visible to the
 * second. So a file that locks the mode and does not clear it changes the behaviour of every file
 * that runs after it. Any test file that touches the mode must reset in BOTH `beforeEach` and
 * `afterEach`: `beforeEach` protects this file from its predecessors, `afterEach` protects the
 * suite from this one.
 */
export function resetConnectorModeForTests(): void {
  current = undefined;
}
