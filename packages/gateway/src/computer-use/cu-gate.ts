import type { Database } from "bun:sqlite";
import type { NimbusComputerUseToml } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { performActuation } from "./cu-actuate.ts";
import type { BrowserActionInput } from "./cu-classify.ts";
import { classifyBrowserAction } from "./cu-classify.ts";
import type { CuActionApprovalInput, CuEnvelopeApprovalInput } from "./cu-consent-broker.ts";
import { normalizeOrigin, originOf } from "./cu-request-policy.ts";
import { CuSession, CuSessionError } from "./cu-session.ts";
import { insertAction, insertSession, updateSessionState } from "./cu-store.ts";
import type {
  BrowserLane,
  CuActionClass,
  CuEnvelope,
  CuOutcome,
  OpenBrowserLaneOptions,
} from "./cu-types.ts";

export class CuGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CuGateError";
  }
}

export interface OpenSessionRequest {
  readonly lane: "browser";
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
  readonly maxActions?: number;
  readonly maxWallClockMs?: number;
}

/**
 * Discriminated union (ruling B): the plan's own tests read both `out.sessionId` and `out.code`,
 * which no single shape can provide. Callers narrow on `status`.
 */
export type OpenSessionResult =
  | { readonly status: "open"; readonly sessionId: string }
  | { readonly status: "denied" }
  | { readonly status: "refused"; readonly code: string };

const ACTION_KINDS = ["click", "type", "navigate", "read", "screenshot", "download"] as const;
export type CuActionKind = (typeof ACTION_KINDS)[number];

/**
 * Runtime guard over `CuActionKind` (fix round 1, M-14). `RunActionRequest.kind` is typed, but a
 * TS type is erased at the JSON-RPC boundary Task 11 builds on top of this gate — an
 * externally-supplied `kind` reaches this module as `unknown` in practice, and without a runtime
 * check an unrecognised value would ride all the way to `buildBrowserActionInput`'s `never`
 * default branch, which throws (safely, now that every post-`seq` throw is captured by
 * `runAction`'s `finally` — see the C-1 fix). Task 11 should call this BEFORE constructing a
 * `RunActionRequest`, so a malformed `kind` is rejected at the transport boundary rather than by
 * consuming a budget slot first.
 */
export function isCuActionKind(v: unknown): v is CuActionKind {
  return typeof v === "string" && (ACTION_KINDS as readonly string[]).includes(v);
}

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

export interface CuGateDeps {
  readonly config: NimbusComputerUseToml;
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
  readonly runner: Pick<SandboxRunner, "canConfine">;
  readonly requestApproval: (
    input: CuEnvelopeApprovalInput | CuActionApprovalInput,
  ) => Promise<boolean>;
  /**
   * Injected seams (ruling C amendment / spec § 3.3 step 4 and the exec `requireInstalled`
   * analogue), rather than a direct import of the driver — this is what lets these tests run with
   * no browser installed, and what keeps this file clear of the D26(b) driver-import confinement.
   */
  readonly resolveBrowserPath: () => string | null;
  readonly openLane: (opts: OpenBrowserLaneOptions) => Promise<BrowserLane>;
  readonly db: Database;
  readonly now: () => number;
  readonly newId: () => string;
}

const CAPABILITY = "computer_use";

/**
 * A representative `SandboxPolicy` for the PRE-LAUNCH confinement check ONLY (spec § 3.3 step 4:
 * `SandboxRunner.canConfine(policy)`, asked BEFORE consent so the owner is never asked to approve
 * a session the sandbox could not confine anyway).
 *
 * `permissions.network` is a HOST LIST consulted by the PAL runners (fix round 1, I-5) — NOT a
 * wildcard mode. An empty list is the correct value here: per spec § 3.5.1 the origin-level
 * restriction that keeps the browser's network grant from meaning "any destination" is enforced
 * by `decideRequest` at the CDP layer, not by OS-level per-host filtering, so this lane does not
 * want `linux.ts`'s "per-host" network mode at all — which additionally requires
 * `nimbus-sandbox-helper`, a binary CI does not install, so a non-empty (and in particular a
 * literal `"*"` hostname, which is not a wildcard to any of the three PAL runners) list made
 * `canConfine` refuse on Linux unconditionally. `decideNetworkMode` in `linux.ts` returns
 * `"no-net"` only for an EMPTY set, so this is also the closest available approximation of "grant
 * network, but restrict it at the CDP layer" that today's per-host permission model can express.
 *
 * KNOWN LIMIT, disclosed rather than glossed over: this object is a PLACEHOLDER. It is asserted
 * against `canConfine` before consent, but it is never the object an actual browser spawns with —
 * Task 9's re-planned CDP driver builds its own policy at spawn time. That is a real gap: the
 * pre-consent assertion and the eventual spawn are not provably the same policy yet. Task 9 must
 * either construct its real launch policy here (so this function becomes the single source) or
 * otherwise guarantee the two agree — until then, a `canConfine` pass is a statement about this
 * placeholder, not a proof about what actually launches.
 */
function browserLanePolicy(sessionId: string, profileDir: string): SandboxPolicy {
  return {
    id: `computer-use-browser-${sessionId}`,
    permissions: {
      network: [],
      filesystem: { read: [], write: profileDir === "" ? [] : [profileDir] },
    },
  };
}

/**
 * Resolve the browser lane's profile directory from config.
 *
 * `browserProfileDir === ""` is the config default meaning "use `<configDir>/computer-use/profile`"
 * (spec § 9). Resolving THAT default needs `configDir`, which is not part of `CuGateDeps` — the
 * wiring layer that constructs this config (which already has `configDir`) is expected to have
 * filled the default in before `CuGateDeps` is built, exactly as it already must for every other
 * `[computer_use]` value. Left as an empty string here rather than guessed at, since inventing a
 * different fallback location would contradict the spec's stated default.
 */
function resolveProfileDir(config: NimbusComputerUseToml): string {
  return config.browserProfileDir;
}

const CU_OUTCOMES: ReadonlySet<string> = new Set<CuOutcome>([
  "refused_before_consent",
  "denied_by_owner",
  "actuated",
  "failed_after_approval",
  "refused_out_of_envelope",
  "terminated_budget",
  "terminated_wall_clock",
  "terminated_target_lost",
  "terminated_policy",
]);

function isCuOutcome(v: string | undefined): v is CuOutcome {
  return v !== undefined && CU_OUTCOMES.has(v);
}

/**
 * `audit_log.hitl_status` is CHECK-constrained to `approved` / `rejected` / `not_required`
 * (schema-sql.ts), so the real per-action outcomes do not map one-to-one onto it. `not_required`
 * is NEVER used here (spec § 8.2): on a `computer.action` row it would read as "this actuated
 * without needing approval", the most dangerous thing an auditor could wrongly conclude — even
 * for an `observing` action that legitimately never sought per-action consent, since the SESSION
 * envelope is what covers reads structurally. `approved` therefore means "this action ran, or the
 * owner's approval for it was genuinely obtained" and `rejected` means "it did not, or nothing was
 * ever offered for approval" — exhaustive over `CuOutcome`, so a value added to that union without
 * a case here is a compile error rather than a silent fall-through.
 */
function hitlStatusForOutcome(outcome: CuOutcome): "approved" | "rejected" {
  switch (outcome) {
    case "actuated":
    case "failed_after_approval":
      return "approved";
    case "denied_by_owner":
    case "refused_before_consent":
    case "refused_out_of_envelope":
    case "terminated_budget":
    case "terminated_wall_clock":
    case "terminated_target_lost":
    case "terminated_policy":
      return "rejected";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unrecognised CuOutcome: ${String(exhaustive)}`);
    }
  }
}

function normalizeOriginList(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of raw) {
    const n = normalizeOrigin(o);
    if (n === null) {
      throw new CuGateError("ERR_CU_BAD_ORIGIN", `not a bare origin: ${o}`);
    }
    out.push(n);
  }
  return out;
}

function appendSessionAudit(
  deps: Pick<CuGateDeps, "db" | "now">,
  sessionId: string,
  hitlStatus: "approved" | "rejected",
  payload: Record<string, unknown>,
): void {
  appendAuditEntry(deps.db, {
    actionType: "computer.session",
    hitlStatus,
    actionJson: JSON.stringify(payload),
    timestamp: deps.now(),
    sessionId,
  });
}

/**
 * Best-effort lane teardown. Used on every terminal path (fix round 1, I-4): a session that is
 * about to become unreachable (closed, evicted, or never successfully registered) must not leave
 * its browser process running with nothing left that can ever close it. A failure closing an
 * already-broken lane must not mask the ORIGINAL error/outcome that triggered the teardown.
 */
async function bestEffortCloseLane(lane: BrowserLane): Promise<void> {
  try {
    await lane.close();
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

interface LiveSession {
  readonly session: CuSession;
  readonly lane: BrowserLane;
  /**
   * The FULL `CuGateDeps` this session was OPENED with (fix round 1, I-3.2). Every DB write this
   * gate makes for this session — `appendAuditEntry`, `insertAction`, `updateSessionState`, and
   * the session's own wall-clock `now()` — uses THESE deps, never whatever `runAction`'s CALLER
   * happened to pass in. The forensic record must follow the session, not whoever calls next: two
   * `runAction` calls against the same session from two different `CuGateDeps` (Task 11 builds a
   * fresh one per request) must still land in ONE chain, in ONE database.
   *
   * The one thing `runAction` deliberately reads from the CALLER's `deps` instead of this stored
   * copy is `config.enabled` / `enforced.capabilitiesDisabled` (I-3.1) — the live per-action
   * policy re-check has to observe a CHANGE since open time, so it must not consult a frozen
   * snapshot — and `requestApproval`, which is a live broker channel, not session state.
   */
  readonly openDeps: CuGateDeps;
}

/**
 * One live computer-use session: the frozen envelope, the driver handle, and the deps it opened
 * with, held beside it. Module-private, holding every session this gate has opened and not yet
 * closed. An entry is evicted on every terminal outcome (fix round 1, I-4) — a session id that
 * has already terminated must never be found here again.
 */
const liveSessions = new Map<string, LiveSession>();

/**
 * Open a computer-use session (spec § 3.3 "session open"; invariant I35).
 *
 * The ORDER is load-bearing, matching I33's own "the order is the invariant" framing: every
 * refusal decidable WITHOUT the owner happens before the consent prompt, so a disabled capability
 * or an unconfinable sandbox never advertises its own existence by prompting.
 */
export async function openSession(
  req: OpenSessionRequest,
  deps: CuGateDeps,
): Promise<OpenSessionResult> {
  const sessionId = deps.newId();
  // The exec-gate `approvedAt` sentinel, by another name: whether the owner has said yes yet. A
  // failure AFTER that point must never be recorded as `refused_before_consent`, which would tell
  // an auditor nothing was approved when in fact the owner approved and a browser very nearly
  // started.
  let approvedEnvelope: CuEnvelope | undefined;

  try {
    // 1. Local kill-switch. Before consent, so a disabled capability never advertises itself.
    if (!deps.config.enabled) {
      throw new CuGateError("ERR_CU_DISABLED", "computer-use is disabled");
    }
    // 2. Org policy (I22). Also before consent.
    if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
      throw new CuGateError("ERR_CU_POLICY_DISABLED", "disabled by org policy");
    }
    // 3. Lane allowlist.
    if (!deps.config.allowedLanes.includes(req.lane)) {
      throw new CuGateError("ERR_CU_LANE_NOT_ALLOWED", `lane not allowed: ${req.lane}`);
    }
    // 4. Sandbox confinement — `canConfine(policy)`, NEVER `degradedReason()` (wrong on Windows)
    // or `isFullyActive()` (wrong on Linux); see exec-gate.ts's identical reasoning.
    const profileDir = resolveProfileDir(deps.config);
    const cannotConfine = deps.runner.canConfine(browserLanePolicy(sessionId, profileDir));
    if (cannotConfine !== null) {
      throw new CuGateError(
        "ERR_CU_SANDBOX_DEGRADED",
        `refusing to open unconfined: ${cannotConfine}`,
      );
    }

    // (a) NORMALISE ORIGINS BEFORE THE PROMPT, never after (ruling C.1). The owner must approve
    // the exact strings that will be enforced; a path-bearing origin is refused rather than
    // silently widened to the bare origin.
    const navigateOrigins = normalizeOriginList(req.navigateOrigins);
    const scriptOrigins = normalizeOriginList(req.scriptOrigins);

    // (b) BROWSER PRESENCE CHECK BEFORE CONSENT (ruling C.2) — the exec `requireInstalled`
    // analogue. The owner must never be asked to approve a session that could not start.
    const executablePath = deps.resolveBrowserPath();
    if (executablePath === null) {
      throw new CuGateError("ERR_CU_NO_BROWSER", "no Chromium-family browser found");
    }

    const maxActions =
      req.maxActions !== undefined
        ? Math.min(req.maxActions, deps.config.maxActions)
        : deps.config.maxActions;
    const maxWallClockMs =
      req.maxWallClockMs !== undefined
        ? Math.min(req.maxWallClockMs, deps.config.maxWallClockMs)
        : deps.config.maxWallClockMs;

    // (fix round 1, I-2) VALIDATE THE BOUNDS BEFORE THE PROMPT, not inside `CuSession`'s
    // constructor after approval. `Math.min(0, 50) === 0` and `Math.min(NaN, 50) === NaN` both
    // survive the clamp above unchanged, so without this check a zero or NaN budget reached
    // `requestApproval` (showing the owner a budget line reading `0` or `NaN`), and only THEN
    // failed inside `new CuSession(...)` — after the owner had already said yes. Same code
    // (`ERR_CU_BAD_BOUNDS`) `CuSessionError` uses, so a caller sees one code either way.
    if (!Number.isFinite(maxActions) || maxActions <= 0) {
      throw new CuGateError(
        "ERR_CU_BAD_BOUNDS",
        `maxActions must be a finite number > 0, got ${maxActions}`,
      );
    }
    if (!Number.isFinite(maxWallClockMs) || maxWallClockMs <= 0) {
      throw new CuGateError(
        "ERR_CU_BAD_BOUNDS",
        `maxWallClockMs must be a finite number > 0, got ${maxWallClockMs}`,
      );
    }

    const envelope: CuEnvelope = {
      sessionId,
      lane: req.lane,
      target: { navigateOrigins, scriptOrigins },
      maxActions,
      maxWallClockMs,
      approvedAt: deps.now(),
    };

    // (c) Owner approves the envelope — verbatim lane, target, full origin list, budgets.
    const approved = await deps.requestApproval({
      sessionId,
      lane: req.lane,
      navigateOrigins,
      scriptOrigins,
      maxActions,
      maxWallClockMs,
    });
    if (!approved) {
      appendSessionAudit(deps, sessionId, "rejected", {
        outcome: "denied_by_owner",
        sessionId,
        lane: req.lane,
      });
      return { status: "denied" };
    }

    approvedEnvelope = envelope;
    const session = new CuSession(envelope);

    // (d) LAUNCH AFTER CONSENT, fail-closed. Launching BEFORE would start a browser and create a
    // profile-directory lock for a session the owner may deny.
    let lane: BrowserLane;
    try {
      lane = await deps.openLane({
        profileDir,
        executablePath,
        db: deps.db,
        sessionId,
        target: envelope.target,
      });
    } catch (e) {
      // The owner DID approve, so this is `approved`/`failed_after_approval` — never
      // `refused_before_consent`. A partially-constructed persistent context holds a LOCK on the
      // profile directory; leaving it would make every subsequent session fail too, with an error
      // about the profile rather than about this failure. The close is best-effort.
      session.close("failed_after_approval", deps.now());
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        sessionId,
        lane: req.lane,
        error: e instanceof Error ? e.message : String(e),
      });
      return { status: "refused", code: "ERR_CU_LAUNCH_FAILED" };
    }

    // (fix round 1, I-4a) The lane DID start at this point. If registering the session fails
    // (e.g. `insertSession`'s PRIMARY KEY collision), nothing else will EVER be able to close this
    // browser — it is not yet in `liveSessions`, so no future `runAction`/close path can find it.
    // Close it here, on this exact failure, rather than leaking it.
    try {
      insertSession(deps.db, {
        id: sessionId,
        lane: req.lane,
        envelopeJson: JSON.stringify(envelope),
        openedAt: envelope.approvedAt,
      });
      liveSessions.set(sessionId, { session, lane, openDeps: deps });
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "opened",
        sessionId,
        lane: req.lane,
      });
    } catch (e) {
      await bestEffortCloseLane(lane);
      session.close("failed_after_approval", deps.now());
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        sessionId,
        lane: req.lane,
        stage: "register_session",
        error: e instanceof Error ? e.message : String(e),
      });
      return { status: "refused", code: "ERR_CU_LAUNCH_FAILED" };
    }

    return { status: "open", sessionId };
  } catch (e) {
    const code = e instanceof CuGateError || e instanceof CuSessionError ? e.code : "ERR_CU_FAILED";
    if (approvedEnvelope === undefined) {
      appendSessionAudit(deps, sessionId, "rejected", {
        outcome: "refused_before_consent",
        code,
        sessionId,
      });
    } else {
      // Fail-closed backstop: reachable only if something threw between approval and the
      // `openLane` try/catch above (e.g. `new CuSession(envelope)` rejecting a malformed
      // envelope) — both inner try/catch blocks above already return directly on their own
      // failures.
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        code,
        sessionId,
      });
    }
    return { status: "refused", code };
  }
}

/** Every `ActuationRequest.kind` value maps to a `BrowserActionInput` the classifier reads. */
async function buildBrowserActionInput(
  lane: BrowserLane,
  req: RunActionRequest,
): Promise<BrowserActionInput> {
  const currentOrigin = lane.currentOrigin();
  switch (req.kind) {
    case "read":
    case "screenshot":
    case "download":
      return { kind: req.kind, node: null, currentOrigin, targetOrigin: null };
    case "navigate":
      return {
        kind: req.kind,
        node: null,
        currentOrigin,
        targetOrigin: originOf(req.url ?? ""),
      };
    case "click":
    case "type":
      return {
        kind: req.kind,
        node: await lane.observe(req.selector ?? ""),
        currentOrigin,
        targetOrigin: null,
      };
    default: {
      // Exhaustiveness (ruling D): a Task 5+6 review flagged that an unrecognised kind fell
      // through to the click/type node path with no rule of its own. A kind this switch was never
      // told to handle is now a COMPILE ERROR, matching I29's total `ClientKind` map precedent.
      const exhaustive: never = req.kind;
      throw new Error(`unrecognised action kind: ${String(exhaustive)}`);
    }
  }
}

function describeObservedTarget(kind: CuActionKind, input: BrowserActionInput): string {
  if (input.node !== null) {
    const parts = [kind, input.node.tagName.toLowerCase()];
    if (input.node.type !== null) parts.push(`type=${input.node.type}`);
    if (input.node.accessibleName !== null) parts.push(`"${input.node.accessibleName}"`);
    return parts.join(" ");
  }
  if (kind === "navigate") {
    return `navigate ${input.currentOrigin ?? "?"} -> ${input.targetOrigin ?? "unknown"}`;
  }
  return kind;
}

interface ActionAuditFields {
  readonly sessionId: string;
  readonly seq: number | null;
  readonly kind: CuActionKind;
  /**
   * `null` when this attempt exited BEFORE the classifier ever ran (fix round 1, M-9): a
   * termination, a policy revocation, or an out-of-envelope refusal was never classified, and
   * hardcoding `"actuating"` there would fabricate a field this audit surface promises is a
   * derived fact. `insertAction`'s V57 replay-body row is skipped whenever this is `null` — there
   * is no classification, and no DOM snapshot, to attach to it.
   */
  readonly classification: CuActionClass | null;
  readonly observedTarget: string;
  readonly modelDescription: string | null;
  readonly outcome: CuOutcome;
  readonly domBefore?: string | null;
  readonly domAfter?: string | null;
  readonly screenshotDigest?: string | null;
  readonly snapshotMaxBytes: number;
  /**
   * The RAW reason a session was already closed, when it does not map onto a known `CuOutcome`
   * (fix round 1, M-10) — recorded VERBATIM rather than guessed at. `null` when not applicable.
   */
  readonly terminationReason?: string | null;
  /** Which stage of the pipeline a post-`seq` throw occurred at (fix round 1, C-1). */
  readonly stage?: string;
}

/**
 * Append the ONE chained `audit_log` row every outcome owes (I35), and — only when this attempt
 * actually reached classification (`f.classification !== null`, which also implies a real `seq`)
 * — the V57 replay-body row alongside it. A termination, a policy revocation, or an
 * out-of-envelope refusal never reaches classification, so it gets the permanent decision row and
 * no replay body to invent fields for.
 */
function writeActionAudit(deps: Pick<CuGateDeps, "db" | "now">, f: ActionAuditFields): void {
  const now = deps.now();
  const hitlStatus = hitlStatusForOutcome(f.outcome);
  appendAuditEntry(deps.db, {
    actionType: "computer.action",
    hitlStatus,
    actionJson: JSON.stringify({
      outcome: f.outcome,
      sessionId: f.sessionId,
      seq: f.seq,
      kind: f.kind,
      classification: f.classification,
      observedTarget: f.observedTarget,
      modelDescription: f.modelDescription,
      terminationReason: f.terminationReason ?? null,
      stage: f.stage ?? null,
    }),
    timestamp: now,
    sessionId: f.sessionId,
  });

  if (f.classification === null || f.seq === null) return;
  insertAction(
    deps.db,
    {
      id: `${f.sessionId}:${f.seq}`,
      sessionId: f.sessionId,
      seq: f.seq,
      kind: f.kind,
      classification: f.classification,
      observedTarget: f.observedTarget,
      modelDescription: f.modelDescription,
      hitlStatus,
      outcome: f.outcome,
      domBefore: f.domBefore ?? null,
      domAfter: f.domAfter ?? null,
      screenshotDigest: f.screenshotDigest ?? null,
      timestamp: now,
    },
    f.snapshotMaxBytes,
  );
}

/**
 * Run one action inside a live session's envelope (spec § 3.3 "per action"; invariant I35).
 *
 * The order matches the spec exactly: local policy re-check (fix round 1, I-3.1) -> budget/
 * wall-clock (terminate, never prompt to extend) -> envelope membership (refuse, never prompt) ->
 * structural classification -> single-use consent for an `actuating` verdict -> `performActuation`
 * -> audit with before/after digests -> taint.
 *
 * ALL writes for this session — the audit row, the V57 replay body, `cu_session`'s own state —
 * use the session's OPEN-TIME deps (`openDeps`, fix round 1, I-3.2), never the `deps` this
 * particular call was invoked with: the forensic record must follow the session, not whoever
 * calls next. The one thing read from THIS call's `deps` is the live policy re-check and the
 * consent broker, both of which must reflect the CURRENT world, not a frozen one.
 */
export async function runAction(req: RunActionRequest, deps: CuGateDeps): Promise<RunActionOutput> {
  const live = liveSessions.get(req.sessionId);
  if (live === undefined) {
    throw new CuGateError("ERR_CU_NO_SESSION", `no live session: ${req.sessionId}`);
  }
  const { session, lane, openDeps } = live;
  const modelDescription = req.modelDescription ?? null;

  // 0. (fix round 1, I-3.1) Re-check the local kill-switch and org policy on EVERY action, using
  // THIS call's deps — a tightening org policy (I22) or the local config flipping to disabled
  // must stop a LIVE session, not merely refuse a NEW one; checking only at open time let a
  // session already running coast to its full budget/wall-clock ceiling regardless. No `seq` is
  // consumed: this is decided before `consumeAction`, same as every other pre-budget refusal.
  if (!deps.config.enabled || deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
    const reason = !deps.config.enabled ? "disabled by local config" : "disabled by org policy";
    session.close("terminated_policy", openDeps.now());
    await bestEffortCloseLane(lane);
    liveSessions.delete(req.sessionId);
    writeActionAudit(openDeps, {
      sessionId: req.sessionId,
      seq: null,
      kind: req.kind,
      classification: null,
      observedTarget: `session terminated: ${reason}`,
      modelDescription,
      outcome: "terminated_policy",
      snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
      terminationReason: reason,
    });
    return { outcome: "terminated_policy" };
  }

  // 1. Session live? Budget/wall-clock remaining? A refusal here TERMINATES the session rather
  // than prompting to extend (spec § 4.1) — prompting to extend is how an unbounded sequence
  // launders itself through a bounded one. No `seq` is ever granted for this attempt. Uses the
  // session's OWN clock (`openDeps.now`), not this call's, so wall-clock math stays intrinsic to
  // the session rather than depending on whichever deps happened to invoke it.
  const verdict = session.consumeAction(openDeps.now());
  if (!verdict.ok) {
    let outcome: CuOutcome;
    let terminationReason: string | null;
    if (verdict.reason === "budget") {
      outcome = "terminated_budget";
      terminationReason = "budget";
    } else if (verdict.reason === "wall_clock") {
      outcome = "terminated_wall_clock";
      terminationReason = "wall_clock";
    } else {
      // "closed": the session was ALREADY closed by an earlier call. In practice this is now
      // unreachable within a single gate process — every OTHER termination path below evicts the
      // session from `liveSessions`, so a subsequent call instead hits `ERR_CU_NO_SESSION` above —
      // kept as a defensive fallback, not a live path. (fix round 1, M-10) Record the REAL reason
      // rather than guessing: use `session.reason` verbatim when it is a recognised `CuOutcome`;
      // otherwise record the raw value honestly and fall back to the most conservative rejection
      // tag for the typed `outcome` alone.
      terminationReason = session.reason ?? null;
      outcome = isCuOutcome(session.reason) ? session.reason : "terminated_budget";
    }
    await bestEffortCloseLane(lane);
    liveSessions.delete(req.sessionId);
    writeActionAudit(openDeps, {
      sessionId: req.sessionId,
      seq: null,
      kind: req.kind,
      classification: null,
      observedTarget: `session terminated before this action ran (${outcome})`,
      modelDescription,
      outcome,
      snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
      terminationReason,
    });
    return { outcome };
  }
  const seq = verdict.seq;

  // (fix round 1, C-1) From here on, a `seq` has been granted, so this attempt has consumed part
  // of the session's budget and is owed EXACTLY ONE audit row on every exit — success, denial,
  // refusal, or ANY throw out of the lane. A click that triggers navigation destroying its own CDP
  // execution context is the single most common post-click driver failure, and it must not
  // silently consume a budget slot with nothing recorded. `outcome`/`classification`/the DOM
  // digests accumulate as the function progresses; the `finally` below writes them
  // UNCONDITIONALLY, so a thrown error changes WHAT gets recorded, never WHETHER something is.
  let outcome: CuOutcome = "failed_after_approval";
  let classification: CuActionClass | null = null;
  let observedTarget = `${req.kind} (attempt did not reach classification)`;
  let domBefore: string | null = null;
  let domAfter: string | null = null;
  let screenshotDigest: string | null = null;
  let stage = "envelope_check";

  try {
    // 2. Target inside the envelope? Refused, never prompted (spec § 4.2). Only `navigate` names
    // a bare destination to check here — a cross-origin click is instead routed through the
    // classifier (I4) to per-action consent, since its target is a DOM element the human sees
    // described, not a bare string. Never classified (M-9): `classification` stays `null`.
    if (req.kind === "navigate") {
      const targetOrigin = originOf(req.url ?? "");
      if (
        targetOrigin === null ||
        !session.envelope.target.navigateOrigins.includes(targetOrigin)
      ) {
        outcome = "refused_out_of_envelope";
        observedTarget = `navigate -> ${targetOrigin ?? req.url ?? "unknown"}`;
        stage = "done";
        return { outcome };
      }
    }

    // 3. Classify structurally from the OBSERVED target — never from the model's description (I3
    // transplanted; § 4.3).
    stage = "observe";
    const input = await buildBrowserActionInput(lane, req);
    const { cls, why } = classifyBrowserAction(input);
    classification = cls;
    observedTarget = describeObservedTarget(req.kind, input);

    // 4. `actuating` -> per-action HITL. Approval is single-use: this exact round-trip governs
    // only this one action, and an identical follow-up re-prompts.
    if (cls === "actuating") {
      stage = "consent";
      const approved = await deps.requestApproval({
        sessionId: req.sessionId,
        seq,
        kind: req.kind,
        observedTarget,
        classification: cls,
        why,
        actionsUsed: session.actionsUsed,
        maxActions: session.envelope.maxActions,
        modelDescription,
      });
      if (!approved) {
        outcome = "denied_by_owner";
        stage = "done";
        return { outcome };
      }
    }

    // 5. (Egress row / marker before actuation.) Handled transparently by the browser lane's own
    // wrapped CDP request routing (`wrapLedgeredBrowserContext`, Task 8), set up once when
    // `deps.openLane` constructed this context — not a call this gate makes per action.

    // 6. domBefore, THEN taint (fix round 1, M-11). A DOM read is ITSELF an observation of
    // untrusted content, independent of whether the actuation that follows succeeds — spec § 5:
    // "a capture taints on its own, independently of any text it returns". Tainting here, rather
    // than only after a successful `performActuation`, means a capture that reads content and
    // then fails still latches the envelope's one-way narrowing.
    stage = "dom_before";
    domBefore = await lane.domSnapshot();
    session.taint(openDeps.now());

    stage = "performActuation";
    let result: string | null;
    try {
      result = await performActuation(lane, {
        kind: req.kind,
        // `exactOptionalPropertyTypes` forbids handing an optional `string | undefined` prop
        // straight through to a target whose optional prop is typed as bare `string` — so an
        // absent field is OMITTED here rather than explicitly set to `undefined`.
        ...(req.selector !== undefined ? { selector: req.selector } : {}),
        ...(req.text !== undefined ? { text: req.text } : {}),
        ...(req.url !== undefined ? { url: req.url } : {}),
      });
    } catch (e) {
      outcome = "failed_after_approval";
      stage = "performActuation";
      return { outcome, result: e instanceof Error ? e.message : String(e) };
    }

    stage = "dom_after";
    domAfter = await lane.domSnapshot();

    // 7-8. Success: persist the final state, taint (already set above), return.
    outcome = "actuated";
    screenshotDigest = req.kind === "screenshot" ? result : null;
    stage = "done";
    // The observation crosses back to the caller as plain text; wrapping it through
    // `wrapToolOutput`/`writeToolCallLog` happens at the `engine/agent.ts` tool-call seam
    // (Task 12+), not here — this gate has no model-facing surface of its own (spec § 5).
    return { outcome, result: req.kind === "screenshot" ? null : result };
  } catch (e) {
    // (fix round 1, C-1) ANY OTHER throw from the lane after a `seq` was granted —
    // `buildBrowserActionInput`'s `lane.observe`, or the pre-actuation `lane.domSnapshot` — is
    // recorded as `failed_after_approval` / `hitl_status='approved'`, matching the reviewer's
    // explicit instruction. DISCLOSED TENSION, not silently smoothed over: for a throw at the
    // `observe`/`dom_before` stage, no per-action consent had actually been sought yet (this
    // action might have turned out to be `observing`, needing none at all), so `approved` is a
    // simplification rather than a literal fact for those two stages specifically — `stage` below
    // records exactly where it broke so an auditor is never left guessing which case applies.
    outcome = "failed_after_approval";
    return { outcome, result: e instanceof Error ? e.message : String(e) };
  } finally {
    // Sync `cu_session`'s own DB row on every exit past this point, not only on success — an
    // action that failed or was denied still consumed a budget slot and (per the M-11 fix above)
    // may still have tainted the session, and the DB row must not lag behind the in-memory state.
    updateSessionState(openDeps.db, req.sessionId, {
      actionsUsed: session.actionsUsed,
      taintedAt: session.taintedAt ?? null,
    });
    writeActionAudit(openDeps, {
      sessionId: req.sessionId,
      seq,
      kind: req.kind,
      classification,
      observedTarget,
      modelDescription,
      outcome,
      domBefore,
      domAfter,
      screenshotDigest,
      snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
      stage,
    });
  }
}
