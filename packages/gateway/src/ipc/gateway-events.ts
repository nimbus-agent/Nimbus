// packages/gateway/src/ipc/gateway-events.ts
import type { ConnectorHealthState } from "../connectors/health.ts";

/**
 * The operational event stream `nimbus tail` follows.
 *
 * TWO methods, and that count is meant to be final. `connector.healthChanged` is named because it
 * has a SECOND consumer — `ui/src-tauri/src/gateway_bridge.rs`'s `classify_notification` matches on
 * the method name and cannot cheaply match a `kind` inside a payload. Everything else rides one
 * envelope, because `@nimbus-dev/client`'s `onNotification` is named-only (no wildcard) and lives
 * in another repository: without an envelope the CLI would need a hand-maintained method list, the
 * defect shape this repo has hit three times.
 */
export type GatewayEventKind =
  | "watcher.fired"
  | "sync.completed"
  | "extension.stateChanged"
  | "hitl.requested"
  | "hitl.resolved";

export interface GatewayEventNotification<P = Record<string, unknown>> {
  readonly kind: GatewayEventKind;
  readonly ts: number;
  readonly payload: P;
}

/**
 * Field names are the DESKTOP's (`ConnectorStatus.name` / `.health`), not the gateway's internal
 * vocabulary. `ConnectorGrid.tsx` reads `payload.name` and `payload.health`; a payload using
 * `connectorId`/`toState` would call `patchConnector(undefined, { health: undefined })`, match no
 * row, and leave the panel exactly as dead as it is today. `fromState`/`reason`/`occurredAt` are
 * added for `tail` and ignored by the desktop — one merged shape, never aliased pairs.
 */
export interface ConnectorHealthChangedPayload {
  readonly name: string;
  readonly health: ConnectorHealthState;
  readonly degradationReason?: string;
  readonly fromState: ConnectorHealthState | null;
  readonly reason: string | null;
  readonly occurredAt: number;
}

export interface WatcherFiredPayload {
  readonly watcherId: string;
  readonly name: string;
  readonly summary: string;
  readonly firedAt: number;
}

export interface SyncCompletedPayload {
  readonly serviceId: string;
  readonly itemsUpserted: number;
  readonly itemsDeleted: number;
  readonly durationMs: number;
  readonly bytesTransferred?: number;
  readonly hasMore: boolean;
}

export interface ExtensionStateChangedPayload {
  readonly extensionId: string;
  readonly action: "install" | "enable" | "disable" | "remove" | "update";
  readonly ok: boolean;
  readonly version?: string;
  readonly error?: string;
}

/** `details` is deliberately ABSENT — see `emitHitlRequested`'s caller in `ipc/consent.ts`. */
export interface HitlRequestedPayload {
  readonly requestId: string;
  readonly prompt: string;
}

export interface HitlResolvedPayload {
  readonly requestId: string;
  readonly approved: boolean;
  readonly reason?: string;
}

export type GatewayEventBroadcast = (method: string, params: Record<string, unknown>) => void;

/**
 * Module-level, late-bound, exactly as `identity-boot.ts`'s `bindLoginNotify` is.
 *
 * Emitters are constructed during `assemblePlatformServices`, which runs BEFORE `createIpcServer`
 * exists, so there is nothing to inject at construction time. `platform/assemble.ts` binds the live
 * broadcast after the server is up (the same line that calls `bindLoginNotify`). Until then — and
 * in every unit test that never binds — emits are dropped harmlessly.
 */
let broadcast: GatewayEventBroadcast | undefined;

export function setGatewayEventBroadcast(b: GatewayEventBroadcast | undefined): void {
  broadcast = b;
}

/**
 * Never throws. Every call site sits inside something that must not fail because an observer did:
 * a health transition, a sync completion, a watcher fire, a consent prompt.
 */
function safeBroadcast(method: string, params: Record<string, unknown>): void {
  if (broadcast === undefined) return;
  try {
    broadcast(method, params);
  } catch {
    // Intentionally swallowed. This is an observability stream, not a ledger: unlike the I29
    // appenders, a failed emit must NOT abort the operation being observed.
  }
}

export function emitGatewayEvent<P extends Record<string, unknown>>(
  kind: GatewayEventKind,
  payload: P,
): void {
  safeBroadcast("gateway.event", { kind, ts: Date.now(), payload });
}

export function emitConnectorHealthChanged(payload: ConnectorHealthChangedPayload): void {
  safeBroadcast("connector.healthChanged", { ...payload });
}
