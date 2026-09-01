/**
 * DECLARATION-ONLY. Do not add runtime logic to this file.
 *
 * Coverage-exempt by exact path, for the reason `exec/exec-result.ts` is: a file with no executable
 * statement emits no lcov record, reads as 0%, and can never rejoin the floor. The moment a function
 * or constant lands here that exemption becomes a hole rather than an accounting fact — put such
 * code in `cu-session.ts` or `cu-gate.ts`, which are gated normally.
 */
import type { Database } from "bun:sqlite";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import type { TerminalLineBuffer } from "./cu-terminal-buffer.ts";

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

/**
 * Terminal lane target. No origins — the envelope names WHICH shell and WHERE it runs, both fixed
 * at approval and neither widenable afterwards.
 */
export interface CuTerminalTarget {
  /** A registry id (`cu-lanes/terminal-shells.ts`), never an argv. Resolved gateway-side. */
  readonly shellId: string;
  /** Absolute. The shell's working directory AND its only filesystem grant. */
  readonly cwd: string;
}

export type CuTarget = CuBrowserTarget | CuTerminalTarget;

interface CuEnvelopeCommon {
  readonly sessionId: string;
  readonly maxActions: number;
  readonly maxWallClockMs: number;
  readonly approvedAt: number;
}

export interface CuBrowserEnvelope extends CuEnvelopeCommon {
  readonly lane: "browser";
  readonly target: CuBrowserTarget;
}

export interface CuTerminalEnvelope extends CuEnvelopeCommon {
  readonly lane: "terminal";
  readonly target: CuTerminalTarget;
}

/**
 * Immutable once approved. Frozen at construction — widening is unrepresentable, not discouraged.
 *
 * A DISCRIMINATED UNION on `lane` rather than a common shape with a per-lane optional target. The
 * discriminant is what lets `envelope.lane === "terminal"` narrow `envelope.target` to the type
 * that lane actually has; an optional-field shape would compile everywhere and silently hand a
 * browser code path an envelope with no origins in it.
 */
export type CuEnvelope = CuBrowserEnvelope | CuTerminalEnvelope;

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
  | "terminated_policy"
  /**
   * TERMINAL LANE ONLY. Model-supplied bytes were accepted into the gateway-side line buffer and
   * NOTHING reached the shell: no submit character had arrived yet (spec § 4.3.1). Distinct from
   * every other outcome because nothing was classified, nothing was prompted and nothing actuated —
   * and it is a real, recorded outcome rather than a silent no-op precisely so an auditor can see
   * how a command was composed before it was approved.
   */
  | "buffered";

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
export interface BrowserLane extends CuLaneBase {
  observe(selector: string): Promise<ObservedNode | null>;
  currentOrigin(): string | null;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  navigate(url: string): Promise<void>;
  readText(): Promise<string>;
  domSnapshot(): Promise<string>;
  screenshot(): Promise<Uint8Array>;
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

/**
 * The EXACT launch parameters the TERMINAL lane spawns with — built once, asserted before consent,
 * then handed UNCHANGED to `openTerminalLane`, which spawns `shellPath` + `argv` verbatim. That
 * identity is what makes the pre-consent assertion a statement about the process that actually
 * starts, and it is the same discipline `CuBrowserLaunchPolicy` describes for the browser.
 *
 * Unlike the browser, this lane DOES route through `SandboxRunner`, so its `policy` is asserted
 * with `canConfine` and then used to spawn — the browser's PAL objection (no runner can carry a
 * CDP control channel) does not apply to a lane whose only channel is stdio. See invariant I35.
 */
export interface CuTerminalLaunchPolicy {
  readonly shellId: string;
  readonly shellPath: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly envOverlay: Readonly<Record<string, string>>;
  /** Handed to `SandboxRunner.spawn` verbatim. `permissions.network` is `[]` by construction. */
  readonly policy: SandboxPolicy;
}

/**
 * What EVERY lane offers the gate, independent of what it drives.
 *
 * `finalizeSession`, `bestEffortCloseLane` and the gate's post-`await` liveness re-checks are
 * written against this and this alone, which is why adding a second lane did not have to touch any
 * of them.
 */
export interface CuLaneBase {
  /**
   * Is the driven target still the one this session opened? `false` once the child process has
   * exited or its transport has closed.
   *
   * This is what makes `CuOutcome`'s `terminated_target_lost` an OUTCOME THE GATE CAN ACTUALLY
   * ASSIGN rather than a declared-and-handled string nothing ever produces.
   */
  isAlive(): boolean;
  close(): Promise<void>;
}

export interface TerminalWriteResult {
  readonly output: string;
  /**
   * WHICH bound ended collection. Disclosed rather than inferred — a reader must be able to tell
   * "the command finished" from "we stopped waiting", and those are genuinely different facts.
   *
   * `no_output` is the one that earns its place: it says nothing arrived within
   * `TERMINAL_FIRST_BYTE_MS`, which is what a silent command (`mkdir`) and a slow-starting one
   * (`python x.py`) both look like from here. Reporting it as `quiet` would assert the command
   * finished, which is exactly the claim this driver cannot make.
   */
  readonly settled: "quiet" | "no_output" | "settle_cap" | "output_cap" | "exited";
  readonly truncated: boolean;
}

/**
 * The terminal lane's contract with the gate. `cu-lanes/terminal.ts` IMPLEMENTS this rather than
 * declaring it, so `cu-gate.ts` imports NOTHING from `cu-lanes/` (D26(b)/(c)) — the same shape
 * `BrowserLane` above uses.
 */
export interface TerminalLane extends CuLaneBase {
  /**
   * Write `bytes` plus ONE newline, and nothing else.
   *
   * The caller has already obtained the owner's approval for exactly these bytes. This method
   * appends no sentinel, no prelude and no echo — which is why command completion is detected by
   * output quiescence rather than by anything written here (invariant I35's terminal clause).
   */
  write(bytes: string): Promise<TerminalWriteResult>;
}

/**
 * What `cu-gate.ts` passes to the injected `CuGateDeps.lanes.terminal.openLane` seam to launch a
 * terminal lane AFTER the owner has approved the envelope.
 */
export interface OpenTerminalLaneOptions {
  /** The same object `assertTerminalLaunchable` cleared before the owner was prompted. */
  readonly launch: CuTerminalLaunchPolicy;
  readonly sessionId: string;
}

/**
 * A live lane, tagged. The gate holds ONE of these per session and narrows on `kind`.
 *
 * The terminal arm carries its line buffer BESIDE the driver rather than inside it: the buffer is
 * the unit of consent and must be readable by the gate before any byte is written, while the driver
 * must not be able to see or alter what is pending approval.
 */
export type CuLaneHandle =
  | { readonly kind: "browser"; readonly browser: BrowserLane }
  | {
      readonly kind: "terminal";
      readonly terminal: TerminalLane;
      readonly buffer: TerminalLineBuffer;
    };
