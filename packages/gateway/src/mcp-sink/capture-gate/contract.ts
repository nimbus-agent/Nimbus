import type { Database } from "bun:sqlite";

import type { ClientKind } from "../../ipc/server/client-kind.ts";
import type { CaptureCapability } from "../capture-capability.ts";
import type { NativeStatus } from "../capture-native.ts";
import type { CaptureAttemptLimiter, CaptureRefusalCounter } from "../capture-rate-limit.ts";
import type { CaptureStore } from "../capture-store.ts";
import type {
  ActionBasis,
  ActionVerdict,
  CaptureKind,
  CaptureState,
  LabelSource,
} from "../capture-types.ts";

export const CAPTURE_ITEM_SERVICE = "nimbus";
export const CAPTURE_ITEM_TYPE = "capture";
export const HOUR_MS = 3_600_000;

export interface CaptureGateDeps {
  readonly db: Database;
  readonly store: CaptureStore;
  capability(): CaptureCapability;
  readonly limiter: CaptureAttemptLimiter;
  readonly refusals: CaptureRefusalCounter;
  newId(): string;
  now(): number;
  scheduleEmbedding?(itemId: string): void;
  /** The act door's proposability verdict (spec § 7 step 5a). Absent → every action refuses. */
  classifyAction?(actionType: string): ActionVerdict;
  /** Whether the action's connector is configured on this machine (step 5b). Absent → refuses. */
  isServiceConfigured?(service: string): Promise<boolean>;
  /** The action types `capture.status` advertises as proposable now. */
  listProposableActionTypes?(): Promise<readonly string[]>;
  /**
   * The act door's destination refusal (owner rulings OR1/OR2): a fixed reason when the proposed
   * action posts to a channel ChatOps listens on, carries a broadcast mention or a GitLab quick
   * action, else `undefined`. The SAME check the model door runs, injected by `ipc/capture-rpc.ts`
   * (this module imports nothing from `connectors/`, D32(f)). Required, so a construction site
   * that forgets it fails typecheck. Called at submit (step 5a) and again at accept.
   */
  actionDestinationRefusal(
    actionType: string,
    input: Readonly<Record<string, unknown>>,
    basis: ActionBasis | undefined,
  ): string | undefined;
  /**
   * The agent door's definition check (AD3a-2a, D-3): lists the action's connector ONCE and compares
   * the approved tool's definition with the owner's approved hash. Called for an `approved` basis
   * ONLY, and LAST (step 5c), so every other refusal is free of connector I/O. Absent: every
   * `approved` proposal is refused (fail closed). Injected (this module imports nothing from
   * `connectors/`, D32(f)).
   */
  verifyActionDefinition?(actionType: string, proposedAt?: number): Promise<ActionDefinitionCheck>;
  /**
   * Called once after an ACTION proposal is queued, with the number now waiting. A number and
   * nothing else, so no request-derived string can reach the owner's toast. A throw is swallowed.
   */
  onActionProposed?(pending: number): void;
}

/** The answer of {@link CaptureGateDeps.verifyActionDefinition}. */
export type ActionDefinitionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "ERR_AGENT_TOOL_SUSPENDED" | "ERR_CAPTURE_ACTION_NOT_PROPOSABLE";
      readonly detail: string;
    };

export interface CaptureCaller {
  readonly clientId: string;
  readonly kind: ClientKind;
}

export interface CaptureSummary {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly title: string;
  readonly clientLabel: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly expiresAt: number | null;
}

export type CaptureDetail = CaptureSummary & {
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly itemId: string | null;
  readonly nativeRef: string | null;
  readonly nativeStatus: NativeStatus | null;
  readonly outcomeRef: string | null;
  readonly errorCode: string | null;
};

export interface CaptureStatus {
  readonly enabled: boolean;
  readonly kinds: readonly CaptureKind[];
  readonly pending: number;
  readonly maxPending: number;
  readonly maxPerHour: number;
  readonly refusedSinceStart: Readonly<Record<string, number>>;
  readonly actionEnabled: boolean;
  readonly proposableActionTypes: readonly string[];
  readonly actionPending: number;
  readonly actionMaxPending: number;
  readonly actionTtlHours: number;
  readonly actionExpiringWithinHour: number;
  readonly disabledReason?: string;
}

/** One of the caller's own captures (`capture.mine`): ids and states only, never a payload. */
export interface CaptureMineView {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly outcomeRef?: string;
  readonly errorCode?: string;
}

/** A waiting action proposal as the gate stores it; the RPC layer escapes the strings (once). */
export interface ActionProposalRow {
  readonly id: string;
  readonly actionType: string;
  readonly summary: string;
  readonly clientLabel: string | null;
  readonly labelSource: LabelSource;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CaptureStateView {
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly expiresAt?: number;
  readonly outcomeRef?: string;
  readonly errorCode?: string;
}
