import type { Database } from "bun:sqlite";
import type { NimbusComputerUseToml } from "../../config/nimbus-toml.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import type { CuActionApprovalInput, CuEnvelopeApprovalInput } from "../cu-consent-broker.ts";
import type {
  BrowserLane,
  CuBrowserLaunchPolicy,
  CuOutcome,
  CuTerminalLaunchPolicy,
  OpenBrowserLaneOptions,
  OpenTerminalLaneOptions,
  TerminalLane,
} from "../cu-types.ts";
import type { CuActionKind } from "./kinds.ts";

export class CuGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CuGateError";
  }
}

interface OpenSessionBounds {
  readonly maxActions?: number;
  readonly maxWallClockMs?: number;
}

export interface OpenBrowserSessionRequest extends OpenSessionBounds {
  readonly lane: "browser";
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
}

export interface OpenTerminalSessionRequest extends OpenSessionBounds {
  readonly lane: "terminal";
  /** Absolute. The shell's working directory AND its only filesystem grant. */
  readonly cwd: string;
  /** A registry SHELL ID, never an argv. Omitted means the platform default. */
  readonly shellId?: string;
}

/** Discriminated on `lane`, so a request carrying one lane's fields cannot name the other. */
export type OpenSessionRequest = OpenBrowserSessionRequest | OpenTerminalSessionRequest;

/**
 * Discriminated union (ruling B): the plan's own tests read both `out.sessionId` and `out.code`,
 * which no single shape can provide. Callers narrow on `status`.
 */
export type OpenSessionResult =
  | { readonly status: "open"; readonly sessionId: string }
  | { readonly status: "denied" }
  | { readonly status: "refused"; readonly code: string };

export type CloseSessionResult = { readonly status: "closed" } | { readonly status: "not_found" };

export interface RunActionRequest {
  readonly sessionId: string;
  readonly kind: CuActionKind;
  readonly selector?: string;
  readonly text?: string;
  readonly url?: string;
  /** What the MODEL says it is doing. UNTRUSTED — recorded for forensics, never for classification. */
  readonly modelDescription?: string | null;
}

export interface RunActionOutput {
  readonly outcome: CuOutcome;
  readonly result?: string | null;
}

/**
 * What DRIVING an already-open session needs — and deliberately NOT what OPENING one needs.
 *
 * This split exists because the full `CuGateDeps` is handed to the model-facing tool layer
 * (`cu-tools.ts`) and, through it, to `engine/agent.ts`. That object carried `openLane`, so any
 * file in that layer — including one written later — could call `deps.openLane(...)`, receive a
 * live `BrowserLane` and call `lane.click()` on it: no envelope, no classification, no consent, no
 * audit row. **Neither D26 rule would have seen it**: there is no `performActuation(` call to catch
 * (D26(a)) and no driver import to catch (D26(b)), because the capability arrived as a function
 * value on a deps object rather than as an import.
 *
 * Removing the capability is the fix, not a third static rule over it. A layer that cannot name a
 * lane constructor cannot construct a lane, and that holds for code nobody has written yet — the
 * same reasoning D22(d) applies to the agent emitters, and the same reasoning I33's scope bound
 * relies on for `exec`.
 */
export interface CuRunDeps {
  readonly config: NimbusComputerUseToml;
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
  readonly requestApproval: (
    input: CuEnvelopeApprovalInput | CuActionApprovalInput,
  ) => Promise<boolean>;
  readonly db: Database;
}

/** What a browser-lane session needs, injected rather than imported. */
export interface CuBrowserSeams {
  /**
   * Injected seams (ruling C amendment / spec § 3.3 step 4 and the exec `requireInstalled`
   * analogue), rather than a direct import of the driver — this is what lets these tests run with
   * no browser installed, and what keeps this file clear of the D26(b) driver-import confinement.
   */
  readonly resolveBrowserPath: () => string | null;
  /**
   * Build the EXACT launch parameters for this session, and assert them. Two seams rather than one
   * because the gate must hold the built object between the two calls: it asserts the object, then
   * hands the SAME object to `openLane`, which spawns its `argv` verbatim. That identity is the
   * whole point (see {@link CuBrowserLaunchPolicy}) — it is what replaced a `canConfine` assertion
   * over a `SandboxPolicy` that nothing ever launched with.
   */
  readonly buildLaunchPolicy: (opts: { readonly profileDir: string }) => CuBrowserLaunchPolicy;
  /** `null` when the policy is safe to launch, else the reason it is not. Checked BEFORE consent. */
  readonly assertLaunchable: (policy: CuBrowserLaunchPolicy) => string | null;
  readonly openLane: (opts: OpenBrowserLaneOptions) => Promise<BrowserLane>;
}

/** What a terminal-lane session needs. The same shape as {@link CuBrowserSeams}, per lane. */
export interface CuTerminalSeams {
  /**
   * The shell id used when a request names none. INJECTED rather than imported: `DEFAULT_SHELL_ID`
   * lives in `cu-lanes/terminal-shells.ts`, and `cu-gate.ts` imports NOTHING from `cu-lanes/` —
   * that is what keeps the driver-capability confinement (D26(b)/(c)) resting on a structural fact
   * rather than on the gate's import of the driver happening to be type-only.
   */
  readonly defaultShellId: string;
  /**
   * Resolve a registry SHELL ID to an absolute path plus its argv/env. The gate never sees an argv
   * the caller composed.
   *
   * A THREE-WAY result rather than `... | null`: "not a registered id" and "registered but not
   * installed" are different conditions with different remedies — fix the argument, versus install
   * something — and a nullable return forces the gate to guess which one happened.
   */
  readonly resolveShellPath: (shellId: string) =>
    | {
        readonly status: "ok";
        readonly shellPath: string;
        readonly argv: readonly string[];
        readonly envOverlay: Readonly<Record<string, string>>;
      }
    | { readonly status: "unknown_shell" }
    | { readonly status: "not_installed" };
  readonly buildLaunchPolicy: (opts: {
    readonly sessionId: string;
    readonly shellId: string;
    readonly shellPath: string;
    readonly cwd: string;
  }) => CuTerminalLaunchPolicy;
  /** `null` when the policy is safe to launch, else the reason it is not. Checked BEFORE consent. */
  readonly assertLaunchable: (policy: CuTerminalLaunchPolicy) => string | null;
  readonly openLane: (opts: OpenTerminalLaneOptions) => Promise<TerminalLane>;
}

/**
 * Everything {@link openSession} needs. A SUPERSET of {@link CuRunDeps}: only the transport that
 * actually opens sessions (`ipc/computer-rpc.ts`) is given this, never the tool layer.
 */
export interface CuGateDeps extends CuRunDeps {
  /**
   * BOTH lanes' seams, BOTH REQUIRED. Not `terminal?:` — an optional seam group means a gate that
   * cannot confine a shell can still be constructed, and the failure then surfaces at the moment a
   * session opens rather than at the moment the gate is wired. Requiring it makes "a gate that
   * could not drive a lane cannot exist" a type-system fact, the same reasoning that made
   * `LlmRegistryOptions.db` required under I29. The LANE ALLOW-LIST, not the presence of a seam, is
   * what decides whether a lane may be used.
   */
  readonly lanes: { readonly browser: CuBrowserSeams; readonly terminal: CuTerminalSeams };
  readonly now: () => number;
  readonly newId: () => string;
}
