// packages/gateway/src/engine/bound-write-capabilities.ts
// The runtime capabilities of a bound IaC row (Phase 9.7 D2, invariant I54), as TYPES. A leaf module
// (it imports only types) so `engine/types.ts` can name them on `ConnectorDispatcher` without a
// cycle with `engine/prepare-step.ts` or `engine/iac-settle.ts`. They reach the gate ONLY through
// that dispatcher's optional `boundWriteCapabilities` member (round-2 fix 1: the production
// `ToolExecutor` keeps its constructor); only the production dispatcher built in
// `connectors/registry.ts` sets it. The executor's preflight and prepare phases are the only callers.

import type { PreviewPlan } from "../connectors/connector-writes/preview.ts";
import type { BeforeStateField, PrepareSettle } from "../connectors/connector-writes/types.ts";

/** What a settler hands the gate: the values to inject, the facts to show, and the cleanup. */
export interface SettledWrite {
  /** One string per bound field, produced by the settler only. */
  readonly values: Readonly<Record<string, string>>;
  readonly fields: readonly BeforeStateField[];
  readonly notShown?: number;
  /** The change text the gateway rendered (the plan, or the change set). */
  readonly plan?: PreviewPlan;
  /** Removes what this settle left on disk. Idempotent; never throws. */
  cleanup(): Promise<void>;
}

/** What the gate hands a capability's `settle`: the row's tag, the caller's input and the reply. */
export interface SettleContext {
  readonly settle: PrepareSettle;
  readonly input: Readonly<Record<string, unknown>>;
  /** The gateway-resolved working directory the preflight pinned (absent for CloudFormation). */
  readonly workingDirectory?: string;
  readonly reply: unknown;
  /** The gate's own `iac_terraform_show_json` call (an `iac.write.prepare` action, audited and ledgered). */
  readonly showPlan?: (args: {
    readonly workingDirectory: string;
    readonly planFile: string;
  }) => Promise<unknown>;
}

export type PreflightOutcome =
  | {
      readonly ok: true;
      readonly release: () => void;
      /**
       * The real path the capability resolved the caller's working directory to (symlinks and
       * aliases followed, after the approved-directory check). When present the gate pins it: the
       * plan, show and apply children, the typed confirm text and the prompt all use THIS string, so
       * a link swapped in after the check is never re-resolved by a later child.
       */
      readonly workingDirectory?: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The runtime capabilities of a bound IaC row, carried by the `ConnectorDispatcher` the executor
 * already receives (round-2 fix 1: no new constructor parameter). Only the production dispatcher
 * built in `connectors/registry.ts` sets it. A bound row whose tag needs a capability the
 * dispatcher lacks is refused with a fixed reason before any child exists (fail closed).
 */
export interface BoundWriteCapabilities {
  /** The settle step of `rowToolId` (the Terraform move-hash-show, the CFN cross-check). */
  settle(rowToolId: string, ctx: SettleContext): Promise<SettledWrite>;
  /** The preflight of `rowToolId`: the workdir or cloud grant and the per-workdir mutex. */
  preflight(rowToolId: string, input: Readonly<Record<string, unknown>>): Promise<PreflightOutcome>;
}
