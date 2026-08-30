/**
 * DECLARATION-ONLY. Do not add runtime logic to this file.
 *
 * Coverage-exempt by exact path, for the reason `exec/exec-result.ts` is: a file with no executable
 * statement emits no lcov record, reads as 0%, and can never rejoin the floor. The moment a function
 * or constant lands here that exemption becomes a hole rather than an accounting fact — put such
 * code in `cu-session.ts` or `cu-gate.ts`, which are gated normally.
 */
import type { Database } from "bun:sqlite";
import type { CuLane } from "../config/nimbus-toml.ts";

/**
 * What the GATEWAY observed about the target node, derived from the DOM via CDP.
 *
 * Every field here is a fact the gateway computed. There is deliberately no field carrying the
 * model's description, intent, or rationale — see the header on `classifyBrowserAction` in
 * `cu-classify.ts`, which imports this type back from here (re-exported there for backward
 * compatibility with its existing test's import path).
 */
export interface ObservedNode {
  readonly tagName: string;
  readonly type: string | null;
  /** True when the node sits inside a <form> that contains an <input type="password">. */
  readonly inFormWithPassword: boolean;
  /** True when the node sits inside any <form>, password or not (I7: keypress submission). */
  readonly inForm: boolean;
  /**
   * True when the node IS a submit control, OR IS A DESCENDANT of one (the producer resolves this
   * with `closest()`). `<button type=submit><span>Pay</span></button>` is the most common submit
   * button markup on the web: the model's selector commonly resolves to the inner `<span>`, the
   * click bubbles, and the form submits — so "is a submit control" alone is the wrong contract.
   */
  readonly isSubmitControl: boolean;
  /**
   * Lowercased scheme of the node's href (e.g. "https", "javascript"), or null when it has no
   * href. Supplied by the producer.
   */
  readonly hrefScheme: string | null;
  /** Origin the node's href points to, or null when it has no href / the href is unparseable. */
  readonly hrefOrigin: string | null;
  /** Shown to the human in the prompt. NEVER read by the classifier. */
  readonly accessibleName: string | null;
}

/** Browser lane target. TWO origin sets (spec § 3.5.1), both approved up front, neither widenable. */
export interface CuBrowserTarget {
  /** Where the agent may navigate (`document` / `sub_frame` resource types). */
  readonly navigateOrigins: readonly string[];
  /** Additionally reachable by script-initiated requests (`fetch`/XHR/`eventsource`/`websocket`). */
  readonly scriptOrigins: readonly string[];
}

export type CuTarget = CuBrowserTarget;

/** Immutable once approved. Frozen at construction — widening is unrepresentable, not discouraged. */
export interface CuEnvelope {
  readonly sessionId: string;
  readonly lane: CuLane;
  readonly target: CuTarget;
  readonly maxActions: number;
  readonly maxWallClockMs: number;
  readonly approvedAt: number;
}

/** `observing` never prompts; `actuating` ALWAYS prompts, and its approval is single-use. */
export type CuActionClass = "observing" | "actuating";

export type CuOutcome =
  | "refused_before_consent"
  | "denied_by_owner"
  | "actuated"
  | "failed_after_approval"
  | "refused_out_of_envelope"
  | "terminated_budget"
  | "terminated_wall_clock"
  | "terminated_target_lost"
  /**
   * A LIVE session was stopped mid-run because the local kill-switch or a tightening org policy
   * (I22) now forbids the capability -- checked on EVERY runAction, not only at open time, so a
   * policy change actually stops a running session rather than letting it coast to its budget/
   * wall-clock ceiling. Distinct from every other terminated_* tag: nothing about THIS action was
   * wrong, the capability itself was withdrawn out from under it.
   */
  | "terminated_policy";

export type CuBudgetVerdict =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: "budget" | "wall_clock" | "closed" };

/**
 * The browser lane's contract with the gate (ruling R28 / amendment A: moved here from the
 * deferred Task 9's `cu-lanes/browser.ts` so that `cu-gate.ts` imports NOTHING from `cu-lanes/`,
 * which strengthens the static rule confining driver imports to that directory (D26(b)) instead
 * of relying on the gate's import of the driver module being type-only).
 *
 * Task 9, when re-planned against raw CDP, IMPLEMENTS this interface rather than declaring it.
 */
export interface BrowserLane {
  observe(selector: string): Promise<ObservedNode | null>;
  currentOrigin(): string | null;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  navigate(url: string): Promise<void>;
  readText(): Promise<string>;
  domSnapshot(): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * What `cu-gate.ts` passes to the injected `CuGateDeps.openLane` seam (Task 9's real
 * implementation) to launch a browser lane AFTER the owner has approved the envelope.
 */
export interface OpenBrowserLaneOptions {
  readonly profileDir: string;
  readonly executablePath: string;
  readonly db: Database;
  readonly sessionId: string;
  readonly target: CuBrowserTarget;
}
