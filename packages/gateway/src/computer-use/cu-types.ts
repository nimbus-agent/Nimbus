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
  /**
   * True when the node sits inside any <form>, password or not — the keypress-submission rule
   * (`submitsForm` in `cu-classify.ts`; the `I7` there is a review-finding id, not invariant I7).
   */
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
 * `cu-lanes/browser.ts`'s raw-CDP driver IMPLEMENTS this interface rather than declaring it.
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
  /**
   * Is the driven target still the one this session opened? `false` once the browser process has
   * exited, the CDP transport has closed, or the attached page target is gone.
   *
   * This is what makes `CuOutcome`'s `terminated_target_lost` an OUTCOME THE GATE CAN ACTUALLY
   * ASSIGN rather than a declared-and-handled string nothing ever produces. The gate consults it
   * before it spends a budget slot and again after every `await` inside an action (a click that
   * navigates away is the single most common way a CDP execution context dies mid-action), so a
   * dead lane terminates the session instead of surfacing as a generic
   * `failed_after_approval` whose message happens to mention a socket.
   */
  isAlive(): boolean;
  close(): Promise<void>;
}

/**
 * The EXACT launch parameters the browser lane spawns with — the object the gate asserts over
 * BEFORE consent and then hands, unchanged, to `openLane`.
 *
 * It replaces `cu-gate.ts`'s former `browserLanePolicy()`, a `SandboxPolicy` that was asserted
 * against `SandboxRunner.canConfine` and then never used to launch anything. That was, by its own
 * in-file disclosure, a statement about the wrong object; worse, the placeholder it asserted
 * carried `permissions.network: []`, which `linux.ts`'s `decideNetworkMode` reads as `no-net` →
 * `--unshare-net`, so had it ever reached a real spawn the browser would have had no network at
 * all — and the gateway could not have reached its CDP endpoint either.
 *
 * Routing the browser through `SandboxRunner` was the design's intent (spec § 3.5) and is NOT what
 * ships, for a reason recorded here rather than discovered later: none of the three PAL runners can
 * carry a CDP control channel. A loopback debugging port needs `network-bind`, which macOS's
 * `(deny default)` SBPL profile denies (it emits only `(remote …)` filters); an fd pipe needs
 * descriptors 3/4 forwarded, which the Windows AppContainer helper does not do; and both Linux and
 * Windows additionally require `nimbus-sandbox-helper` for any network-bearing policy, a binary CI
 * does not install. Making it work would mean widening the PAL's profile for EVERY sandboxed
 * connector, or passing Chromium `--no-sandbox` — disabling the renderer sandbox of the one
 * process in this codebase that renders attacker-controlled content. Both are worse than the lane
 * being confined by Chromium's own sandbox, a Nimbus-owned profile directory, and the § 3.5.1 CDP
 * request policy. See invariant I35's scope bound.
 *
 * `argv` is spawned VERBATIM — the driver appends nothing — which is what makes the pre-consent
 * assertion (`assertBrowserLaunchPolicy`) a statement about the process that actually starts.
 */
export interface CuBrowserLaunchPolicy {
  /**
   * The ONLY directory Chromium may treat as a profile: `--user-data-dir`. This is what enforces
   * "no shared cookies, no shared history, no access to the user's real browser profile" (spec
   * § 3.5). Absolute, and asserted to be so before consent.
   */
  readonly profileDir: string;
  /** Every flag, in order, minus the executable itself. Spawned verbatim. */
  readonly argv: readonly string[];
}

/**
 * What `cu-gate.ts` passes to the injected `CuGateDeps.openLane` seam (Task 9's real
 * implementation) to launch a browser lane AFTER the owner has approved the envelope.
 */
export interface OpenBrowserLaneOptions {
  /** The same object `assertBrowserLaunchPolicy` cleared before the owner was prompted. */
  readonly launch: CuBrowserLaunchPolicy;
  readonly executablePath: string;
  readonly db: Database;
  readonly sessionId: string;
  readonly target: CuBrowserTarget;
}
