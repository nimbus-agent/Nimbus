import type { CuLane, NimbusComputerUseToml } from "../config/nimbus-toml.ts";
import { performActuation } from "./cu-actuate.ts";
import { classifyBrowserAction, classifyTerminalAction } from "./cu-classify.ts";
import type { CuEnvelopeApprovalInput } from "./cu-consent-broker.ts";
import {
  type ActionArmContext,
  type ActionAuditState,
  terminationForRefusedVerdict,
  writeActionAudit,
} from "./cu-gate/action-audit.ts";
import {
  browserActuationInput,
  buildBrowserActionInput,
  describeObservedTarget,
} from "./cu-gate/browser-input.ts";
import { kindBelongsToLane } from "./cu-gate/kinds.ts";
import {
  appendSessionAudit,
  evictExistingSession,
  finalizeSession,
  type LiveSession,
  laneBase,
  safeAppendSessionAudit,
} from "./cu-gate/live-sessions.ts";
import { type PreparedLane, prepareLane } from "./cu-gate/prepare-lane.ts";
import {
  type CloseSessionResult,
  type CuGateDeps,
  CuGateError,
  type CuRunDeps,
  type OpenSessionRequest,
  type OpenSessionResult,
  type RunActionOutput,
  type RunActionRequest,
} from "./cu-gate/types.ts";
import { originOf } from "./cu-request-policy.ts";
import { CuSession, CuSessionError } from "./cu-session.ts";
import { insertSession } from "./cu-store.ts";
import { TerminalLineBuffer } from "./cu-terminal-buffer.ts";
import type { CuActionClass, CuEnvelope, CuLaneHandle, CuOutcome } from "./cu-types.ts";

// Public surface lives in `cu-gate/`; the two ordered gates and every `performActuation` call stay here.
export type { CuActionKind } from "./cu-gate/kinds.ts";
export { isCuActionKind } from "./cu-gate/kinds.ts";
export type {
  CloseSessionResult,
  CuBrowserSeams,
  CuGateDeps,
  CuRunDeps,
  CuTerminalSeams,
  OpenBrowserSessionRequest,
  OpenSessionRequest,
  OpenSessionResult,
  OpenTerminalSessionRequest,
  RunActionOutput,
  RunActionRequest,
} from "./cu-gate/types.ts";
export { CuGateError } from "./cu-gate/types.ts";

const CAPABILITY = "computer_use";

// Every session this gate has opened and not closed, evicted on every terminal outcome. PRIVATE to
// this file on purpose (I35, D26(c)): its entries hold a lane handle that actuates with no gate.
const liveSessions = new Map<string, LiveSession>();

/**
 * The lane KIND of a session THIS process holds open, or `undefined`. The model's binding (I35,
 * OR-MCU-1) is built only for such a session; every action still goes through `runAction`'s checks.
 */
export function liveSessionLane(sessionId: string): CuLane | undefined {
  return liveSessions.get(sessionId)?.lane.kind;
}

/**
 * Steps 1-3 of `openSession`: the three refusals decidable with NO input from the owner, in that
 * order — local kill-switch, org policy (I22), lane allow-list.
 *
 * Extracted as a unit, and only as a unit: all three must run BEFORE `requestApproval`, and
 * keeping them in one named function is what makes "these are the pre-consent refusals" a thing a
 * reader sees at the call site rather than reconstructs by scanning for the first `await`.
 */
function assertOpenAllowedBeforeConsent(req: OpenSessionRequest, deps: CuGateDeps): void {
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
}

/**
 * Clamp the requested budgets to the configured ceilings, then VALIDATE THEM BEFORE THE PROMPT
 * (fix round 1, I-2) — not inside `CuSession`'s constructor after approval.
 *
 * `Math.min(0, 50) === 0` and `Math.min(NaN, 50) === NaN` both survive the clamp unchanged, so
 * without this check a zero or NaN budget reached `requestApproval` (showing the owner a budget
 * line reading `0` or `NaN`), and only THEN failed inside `new CuSession(...)` — after the owner
 * had already said yes. Same code (`ERR_CU_BAD_BOUNDS`) `CuSessionError` uses, so a caller sees
 * one code either way.
 */
function resolveSessionBounds(
  req: OpenSessionRequest,
  config: Pick<NimbusComputerUseToml, "maxActions" | "maxWallClockMs">,
): { maxActions: number; maxWallClockMs: number } {
  const maxActions =
    req.maxActions !== undefined ? Math.min(req.maxActions, config.maxActions) : config.maxActions;
  const maxWallClockMs =
    req.maxWallClockMs !== undefined
      ? Math.min(req.maxWallClockMs, config.maxWallClockMs)
      : config.maxWallClockMs;

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
  return { maxActions, maxWallClockMs };
}

/**
 * The envelope the owner is about to be shown, and the one the session is then frozen with — ONE
 * construction, so the thing approved and the thing enforced cannot differ.
 *
 * Written per lane rather than as a common shape with an optional target, mirroring `CuEnvelope`'s
 * own discriminated union: a terminal envelope carrying `navigateOrigins` must be unrepresentable.
 */
function buildEnvelope(
  prepared: PreparedLane,
  sessionId: string,
  bounds: { maxActions: number; maxWallClockMs: number; approvedAt: number },
): CuEnvelope {
  return prepared.lane === "browser"
    ? { sessionId, lane: "browser", target: prepared.target, ...bounds }
    : { sessionId, lane: "terminal", target: prepared.target, ...bounds };
}

/**
 * The envelope consent prompt — verbatim lane, target, full origin list, budgets.
 *
 * Built from `prepared` (what the gate resolved), never from `req` (what the caller asked for):
 * the owner must approve the target that will actually be launched.
 */
function buildEnvelopePrompt(
  prepared: PreparedLane,
  sessionId: string,
  bounds: { maxActions: number; maxWallClockMs: number },
): CuEnvelopeApprovalInput {
  return prepared.lane === "browser"
    ? {
        promptKind: "envelope",
        lane: "browser",
        sessionId,
        navigateOrigins: prepared.target.navigateOrigins,
        scriptOrigins: prepared.target.scriptOrigins,
        ...bounds,
      }
    : {
        promptKind: "envelope",
        lane: "terminal",
        sessionId,
        shellId: prepared.target.shellId,
        cwd: prepared.target.cwd,
        ...bounds,
      };
}

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
    // 1-3. Local kill-switch, org policy (I22), lane allow-list — every refusal decidable
    // WITHOUT the owner, so a disabled capability never advertises itself by prompting.
    assertOpenAllowedBeforeConsent(req, deps);

    // 4. PER-LANE PREPARATION — everything decidable WITHOUT the owner: the launch policy and its
    // confinement assertion, the presence check for whatever this lane needs installed, and the
    // envelope target the prompt will display. All of it BEFORE consent, so a disabled,
    // unconfinable or uninstallable lane never advertises its own existence by prompting.
    const prepared = prepareLane(req, sessionId, deps);

    // 5. BOUNDS, resolved and validated BEFORE the prompt — see `resolveSessionBounds`.
    const { maxActions, maxWallClockMs } = resolveSessionBounds(req, deps.config);

    const envelope = buildEnvelope(prepared, sessionId, {
      maxActions,
      maxWallClockMs,
      approvedAt: deps.now(),
    });

    // (c) Owner approves the envelope — verbatim lane, target, full origin list, budgets.
    const approved = await deps.requestApproval(
      buildEnvelopePrompt(prepared, sessionId, { maxActions, maxWallClockMs }),
    );
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
    let lane: CuLaneHandle;
    try {
      lane =
        prepared.lane === "browser"
          ? {
              kind: "browser",
              browser: await deps.lanes.browser.openLane({
                // The very object `assertLaunchable` cleared above, not a rebuild of it.
                launch: prepared.launch,
                executablePath: prepared.executablePath,
                db: deps.db,
                sessionId,
                target: prepared.target,
              }),
            }
          : {
              kind: "terminal",
              terminal: await deps.lanes.terminal.openLane({
                launch: prepared.launch,
                sessionId,
              }),
              // The buffer is created HERE, with the session, and dies with it. A buffer that
              // outlived a session would carry one envelope's half-composed command into the next.
              buffer: new TerminalLineBuffer(),
            };
    } catch (e) {
      // The owner DID approve, so this is `approved`/`failed_after_approval` — never
      // `refused_before_consent`. A partially-constructed persistent context holds a LOCK on the
      // profile directory; leaving it would make every subsequent session fail too, with an error
      // about the profile rather than about this failure. No lane exists to close: `openLane`
      // itself is what threw, and no `cu_session` row exists yet either (that only happens in
      // the registration step below) — nothing for `finalizeSession` to sync or evict.
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
    //
    // TWO flags, not one (fix round 4, item 4): `rowInserted` is set immediately after
    // `insertSession` succeeds; `registeredInMap` is set two statements later, after
    // `evictExistingSession` and `liveSessions.set` both ran. `registeredInMap` was the WRONG
    // flag for `finalizeSession`'s `syncRow` — if `evictExistingSession` itself throws (a
    // DIFFERENT, unrelated session's own teardown failing) BETWEEN `insertSession` succeeding and
    // `liveSessions.set` ever running, `registeredInMap` stays `false` even though THIS attempt's
    // own `cu_session` row genuinely exists, so gating the sync on it left OUR OWN row's
    // `closed_at` `NULL` forever. `rowInserted` tracks exactly "does a row exist for THIS attempt
    // to sync" — nothing more, nothing less. `registeredInMap` remains the right flag for
    // `evictMap`: only a `liveSessions.set` that actually ran created a map entry to evict, and
    // evicting or syncing `sessionId` when NEITHER flag is set would corrupt or remove a
    // DIFFERENT, unrelated, still-valid session that happens to share the key (a PK collision,
    // where `insertSession` itself throws before `rowInserted` is ever set). `lane` is passed
    // UNCONDITIONALLY regardless of either flag — the browser process itself started either way.
    let rowInserted = false;
    let registeredInMap = false;
    try {
      insertSession(deps.db, {
        id: sessionId,
        lane: req.lane,
        envelopeJson: JSON.stringify(envelope),
        openedAt: envelope.approvedAt,
      });
      rowInserted = true;
      await evictExistingSession(liveSessions, sessionId);
      liveSessions.set(sessionId, {
        session,
        lane,
        openDeps: deps,
        queue: Promise.resolve(),
      });
      registeredInMap = true;
      // Deliberately a normal (throwing) append, not `safeAppendSessionAudit`: a failure
      // recording the "opened" decision is treated as a REGISTRATION failure (routed to this
      // catch, same as `insertSession` throwing), not silently ignored — losing the first
      // permanent decision row for a whole session is serious enough to refuse the open outright.
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "opened",
        sessionId,
        lane: req.lane,
      });
    } catch (e) {
      session.close("failed_after_approval", deps.now());
      await finalizeSession({
        deps,
        sessionId,
        session,
        lane: laneBase(lane),
        syncRow: rowInserted,
        evictMap: registeredInMap ? liveSessions : null,
        // Deliberately a normal (throwing) append here too — if it ALSO fails (same root cause
        // as the one above), the throw propagates to the OUTER catch below, whose OWN append IS
        // safe and is the true last line of defense, guaranteeing `openSession` still returns.
        writeAudit: () =>
          appendSessionAudit(deps, sessionId, "approved", {
            outcome: "failed_after_approval",
            sessionId,
            lane: req.lane,
            stage: "register_session",
            error: e instanceof Error ? e.message : String(e),
          }),
      });
      return { status: "refused", code: "ERR_CU_LAUNCH_FAILED" };
    }

    return { status: "open", sessionId };
  } catch (e) {
    const code = e instanceof CuGateError || e instanceof CuSessionError ? e.code : "ERR_CU_FAILED";
    if (approvedEnvelope === undefined) {
      safeAppendSessionAudit(deps, sessionId, "rejected", {
        outcome: "refused_before_consent",
        code,
        sessionId,
      });
    } else {
      // Fail-closed backstop: reachable only if something threw between approval and the
      // `openLane` try/catch above (e.g. `new CuSession(envelope)` rejecting a malformed
      // envelope) — both inner try/catch blocks above already return directly on their own
      // failures.
      safeAppendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        code,
        sessionId,
      });
    }
    return { status: "refused", code };
  }
}

/**
 * Explicitly close a live session (fix round 2, the coordinator's "ALSO" request). There was no
 * way to close a session at all before this: one opened and then abandoned — never driven to its
 * budget or wall-clock ceiling — leaked its browser process indefinitely. Task 11 wires this to
 * `computer.sessionClose`. `deps` is intentionally UNUSED today — mirroring `runAction`, a close
 * always writes through the session's own `openDeps` (never a caller-supplied database), so
 * closing is never a way to divert the forensic trail. Kept for signature symmetry with
 * `openSession`/`runAction` and so Task 11 can pass whatever `CuGateDeps` it already has to hand
 * without a special case; a leading underscore silences `noUnusedParameters`.
 */
export async function closeSession(
  sessionId: string,
  _deps: CuRunDeps,
): Promise<CloseSessionResult> {
  const live = liveSessions.get(sessionId);
  if (live === undefined) {
    return { status: "not_found" };
  }
  const { session, lane, openDeps } = live;
  session.close("owner", openDeps.now());
  await finalizeSession({
    deps: openDeps,
    sessionId,
    session,
    lane: laneBase(lane),
    syncRow: true,
    evictMap: liveSessions,
    writeAudit: () =>
      safeAppendSessionAudit(openDeps, sessionId, "approved", {
        outcome: "closed_by_owner",
        sessionId,
      }),
  });
  return { status: "closed" };
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
/**
 * Why a live session is being terminated mid-flight, in the order the gate checks them.
 *
 * Named rather than inlined as a ternary chain because this string is what the audit row and
 * the owner both see: "disabled by local config" and "disabled by org policy" are different
 * events with different remediations, and the lane case is neither — the capability is still
 * on, this session's lane simply stopped being allowed. Reading that off a three-arm
 * conditional at the call site made the ordering, which is the part that matters, easy to miss.
 *
 * Takes CuRunDeps, not CuGateDeps: the I35 split deliberately keeps lane construction out of
 * the deps the model-facing tool layer holds, and this decision needs neither.
 */
/**
 * May this LIVE session still act? The local kill-switch, org policy (I22) and the lane
 * allow-list, all re-read from THIS call's deps.
 *
 * The mirror image of `policyRefusalReason` below — that one names WHICH of the three stopped it,
 * this one answers whether any did. Both read the same three sources in the same order, and both
 * are consulted on EVERY action rather than only at open: a tightening org policy, the local
 * config flipping to disabled, or the owner removing this session's lane from `allowed_lanes`
 * must stop a live session, not merely refuse a new one.
 */
function stillAllowedByPolicy(deps: CuRunDeps, lane: CuLane): boolean {
  return (
    deps.config.enabled &&
    !deps.enforced.capabilitiesDisabled.has(CAPABILITY) &&
    deps.config.allowedLanes.includes(lane)
  );
}

function policyRefusalReason(deps: CuRunDeps, lane: CuLane): string {
  if (!deps.config.enabled) return "disabled by local config";
  if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) return "disabled by org policy";
  return `lane no longer allowed: ${lane}`;
}

export async function runAction(req: RunActionRequest, deps: CuRunDeps): Promise<RunActionOutput> {
  const live = liveSessions.get(req.sessionId);
  if (live === undefined) {
    throw new CuGateError("ERR_CU_NO_SESSION", `no live session: ${req.sessionId}`);
  }
  // Claim this lane before doing anything else (see `LiveSession.queue`). The slot is published
  // SYNCHRONOUSLY — `live.queue` is replaced before the first `await` — so a second concurrent
  // call entering this function cannot observe the old queue and run alongside us.
  const predecessor = live.queue;
  let releaseLane: () => void = () => {};
  live.queue = new Promise<void>((resolve) => {
    releaseLane = resolve;
  });
  try {
    await predecessor;
    return await runActionExclusive(req, deps, live);
  } finally {
    releaseLane();
  }
}

async function runActionExclusive(
  req: RunActionRequest,
  deps: CuRunDeps,
  live: LiveSession,
): Promise<RunActionOutput> {
  const { session, lane, openDeps } = live;
  const modelDescription = req.modelDescription ?? null;

  // 0. (fix round 1, I-3.1; lane re-check added per review finding) Re-check the local
  // kill-switch, org policy, AND the lane allow-list on EVERY action, using THIS call's deps — a
  // tightening org policy (I22), the local config flipping to disabled, OR the owner removing
  // this session's lane from `allowed_lanes` must stop a LIVE session, not merely refuse a NEW
  // one; checking only `enabled`/`capabilitiesDisabled` here (and lane membership only in
  // `openSession`) let a live session coast to its full budget/wall-clock ceiling even after the
  // owner revoked its lane — `openSession` refusing a NEW session for the same configuration
  // while the live-session path stayed silent about it. No `seq` is consumed: this is decided
  // before `consumeAction`, same as every other pre-budget refusal.
  if (!stillAllowedByPolicy(deps, session.envelope.lane)) {
    const reason = policyRefusalReason(deps, session.envelope.lane);
    session.close("terminated_policy", openDeps.now());
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      lane: laneBase(lane),
      syncRow: true,
      evictMap: liveSessions,
      writeAudit: () =>
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
        }),
    });
    return { outcome: "terminated_policy" };
  }

  // 0b. LANE/KIND AGREEMENT. A `click` on a terminal session, or a `terminal_write` on a browser
  // one, is an action outside this envelope: the envelope named the lane, and the lane is what
  // decides which kinds exist. REFUSED, never prompted (spec § 4.2), and never at the cost of a
  // budget slot — decided HERE, before `consumeAction`, exactly like every other pre-budget
  // refusal.
  //
  // Without it the request would reach `buildBrowserActionInput` holding a terminal handle and
  // throw — safely, but recorded as a generic failure rather than as the refusal it is. And
  // `refused_out_of_envelope` is the tag whose CLUSTER is the highest-value alert this feature
  // emits: a model steered toward a lane it was not granted is exactly what it exists to surface.
  if (!kindBelongsToLane(req.kind, session.envelope.lane)) {
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      // The session STAYS live: this one action was simply not for it.
      lane: null,
      syncRow: false,
      evictMap: null,
      writeAudit: () =>
        writeActionAudit(openDeps, {
          sessionId: req.sessionId,
          seq: null,
          kind: req.kind,
          classification: null,
          observedTarget: `${req.kind} is not an action of the ${session.envelope.lane} lane`,
          modelDescription,
          outcome: "refused_out_of_envelope",
          snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
        }),
    });
    return { outcome: "refused_out_of_envelope" };
  }

  // 1. Session live? Budget/wall-clock remaining? A refusal here TERMINATES the session rather
  // than prompting to extend (spec § 4.1) — prompting to extend is how an unbounded sequence
  // launders itself through a bounded one. No `seq` is ever granted for this attempt. Uses the
  // session's OWN clock (`openDeps.now`), not this call's, so wall-clock math stays intrinsic to
  // the session rather than depending on whichever deps happened to invoke it.
  const verdict = session.consumeAction(openDeps.now());
  if (!verdict.ok) {
    const { outcome, terminationReason } = terminationForRefusedVerdict(verdict.reason, session);
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      lane: laneBase(lane),
      syncRow: true,
      evictMap: liveSessions,
      writeAudit: () =>
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
        }),
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
  //
  // (fix round 3) `consentGranted`/`actuationAttempted` — NOT the `stage` string — decide the
  // outcome in the catch below. This mirrors `openSession`'s own `approvedEnvelope` sentinel two
  // hundred lines above: the file had already solved "was this actually approved before it broke"
  // once, correctly, and then solved the SAME question a second, worse way here. Inferring intent
  // from a mutable forensic label is what let round 2's instruction reclassify `dom_before` — a
  // stage that runs AFTER consent — as `refused_before_consent` (NB-1): an approved actuating
  // click whose pre-actuation snapshot throws recorded NO approval at all, despite two real ones
  // having been granted (the envelope, and this action). Two explicit booleans cannot drift that
  // way: `consentGranted` is set at the ONE site `requestApproval` returns `true`;
  // `actuationAttempted` is set immediately before `performActuation` is called. `stage` still
  // exists and is still recorded, purely as forensics — it no longer decides anything.
  const audit: ActionAuditState = {
    outcome: "failed_after_approval",
    classification: null,
    observedTarget: `${req.kind} (attempt did not reach classification)`,
    domBefore: null,
    domAfter: null,
    screenshotDigest: null,
    stage: "envelope_check",
    consentGranted: false,
    actuationAttempted: false,
    laneLost: false,
  };

  /**
   * Re-check liveness after an `await`. The TOCTOU this closes: every check above happens once, and
   * an action then awaits an observation, an approval prompt (unbounded — a human is answering it)
   * and a DOM snapshot before it actuates. A `closeSession` arriving in any of those windows used
   * to leave the actuation to proceed against a lane that had already been closed and evicted.
   */
  const stillLive = (): boolean => session.isOpen() && laneBase(lane).isAlive();

  const arm: ActionArmContext = {
    req,
    deps,
    session,
    openDeps,
    seq,
    modelDescription,
    audit,
    stillLive,
  };

  try {
    return lane.kind === "terminal"
      ? await runTerminalActionArm(lane, arm)
      : await runBrowserActionArm(lane, arm);
  } catch (e) {
    // (fix round 3) Derived from the two explicit booleans, never from `stage`. `actuationAttempted`
    // covers the one case where the throw happened AFTER a successful `performActuation` (the
    // `dom_after` snapshot failing — the reviewer's own C-1 headline scenario: the click DID
    // happen). `consentGranted` alone (actuation never attempted) is NB-1's fix: the owner
    // approved this exact action and `dom_before` then threw before any actuation was tried —
    // that is still `failed_after_approval`, because the record must say the owner said yes, not
    // pretend nothing was ever offered for approval. Neither flag set means no consent was ever
    // sought (an `observing` candidate that never reached the point of needing any) OR the
    // consent broker itself threw (NEW-2) — either way, `refused_before_consent`.
    audit.outcome =
      audit.consentGranted || audit.actuationAttempted
        ? "failed_after_approval"
        : "refused_before_consent";
    return { outcome: audit.outcome, result: e instanceof Error ? e.message : String(e) };
  } finally {
    // A lost lane TERMINATES the session, exactly as a budget or wall-clock ceiling does: the
    // browser it was driving is gone (or the owner closed it), so leaving the entry live would let
    // every subsequent action re-discover the same corpse, each one spending a budget slot to do
    // it. `session.close` is idempotent, so closing here after `closeSession` already did is a
    // no-op that preserves the ORIGINAL reason and timestamp.
    if (audit.laneLost) session.close("terminated_target_lost", openDeps.now());
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      // Normally the session STAYS live for further actions and only a termination closes it —
      // hence `null`. When the lane is lost there is a lane to tear down and an entry to evict.
      lane: audit.laneLost ? laneBase(lane) : null,
      syncRow: true,
      evictMap: audit.laneLost ? liveSessions : null,
      writeAudit: () =>
        writeActionAudit(openDeps, {
          sessionId: req.sessionId,
          seq,
          kind: req.kind,
          classification: audit.classification,
          observedTarget: audit.observedTarget,
          modelDescription,
          outcome: audit.outcome,
          domBefore: audit.domBefore,
          domAfter: audit.domAfter,
          screenshotDigest: audit.screenshotDigest,
          snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
          stage: audit.stage,
          ...(audit.laneLost
            ? { terminationReason: "the browser target this session was driving is gone" }
            : {}),
        }),
    });
  }
}

/**
 * Step 4, shared by both lanes: the owner's SINGLE-USE approval for this exact action, then the
 * liveness re-check across the consent round-trip.
 *
 * That round-trip is the longest await in the gate — a human is answering it — so an approval can
 * arrive for a session the owner has since closed, or for a lane that died while they read it.
 * Recorded as `terminated_target_lost` rather than `failed_after_approval`, because nothing was
 * attempted. ONE implementation for both lanes: two copies of "approve, then re-check" is two
 * places for the re-check to go missing.
 *
 * Returns the outcome to record when the action must STOP, or null to continue.
 */
async function approveThisAction(
  ctx: ActionArmContext,
  verdict: { cls: CuActionClass; why: string },
): Promise<CuOutcome | null> {
  const { audit, req, session } = ctx;
  audit.stage = "consent";
  // I35 (OR-MCU-2): the prompt goes to the connection that OPENED the session (its open-time
  // channel), never to whoever is acting now: a caller that can reach `computer.act` (or a model
  // turn bound to the session) cannot receive, and so cannot answer, its own prompt.
  const approved = await ctx.openDeps.requestApproval({
    promptKind: "action",
    sessionId: req.sessionId,
    seq: ctx.seq,
    kind: req.kind,
    observedTarget: audit.observedTarget,
    classification: verdict.cls,
    why: verdict.why,
    actionsUsed: session.actionsUsed,
    maxActions: session.envelope.maxActions,
    modelDescription: ctx.modelDescription,
  });
  if (!approved) {
    audit.stage = "done";
    return "denied_by_owner";
  }
  audit.consentGranted = true;
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.stage = "done";
    return "terminated_target_lost";
  }
  return null;
}

/**
 * The TERMINAL lane's action body (spec § 4.3.1). Same order as the browser arm — envelope check,
 * classification, single-use consent, actuation — with the buffer standing in for the envelope
 * check, because on this lane the buffer IS what decides whether anything may reach the host.
 */
async function runTerminalActionArm(
  handle: Extract<CuLaneHandle, { kind: "terminal" }>,
  ctx: ActionArmContext,
): Promise<RunActionOutput> {
  const { audit, req, session, openDeps } = ctx;

  // 2. ENVELOPE + BUFFER. The buffer IS the envelope check on this lane: a control character, a
  //    bidirectional override, an over-long line or a second command after the submit is refused,
  //    never prompted, and leaves the buffer untouched.
  audit.stage = "buffer";
  const appended = handle.buffer.append(req.text ?? "");
  if (appended.status === "refused") {
    audit.outcome = "refused_out_of_envelope";
    audit.observedTarget = `terminal_write refused: ${appended.reason}`;
    audit.stage = "done";
    // The REASON travels back to the caller, not just the outcome. Without it the model sees a
    // bare `refused_out_of_envelope` for four distinct conditions and can only retry blindly —
    // which spends the owner's budget on attempts nobody can learn from.
    return { outcome: audit.outcome, result: appended.reason };
  }
  if (appended.status === "buffered") {
    // NOTHING reached the shell and NOTHING was classified. A real, recorded outcome rather than
    // a silent no-op: an auditor can see how a command was composed before it was approved.
    // `classification` stays null, so `hitlStatusForOutcome` writes `not_required` — accurate
    // here, and forbidden only as the PAIR with `actuating`.
    audit.outcome = "buffered";
    audit.observedTarget = `terminal buffer now holds ${appended.pending.length} characters`;
    audit.stage = "done";
    // The PENDING TEXT goes back to the caller. It is the caller's own bytes — nothing from the
    // host, nothing untrusted — and without it a model composing across several calls cannot see
    // what it has actually built, so it cannot tell a fresh start from an append onto a stale
    // fragment (appending "ls" onto a pending "rm -rf" submits "rm -rfls").
    return { outcome: audit.outcome, result: appended.pending };
  }

  // 3. CLASSIFY — from the COMPLETE line the gateway assembled, never from the model's
  //    description. Always `actuating` on this lane; there is no branch that returns otherwise.
  const line = appended.line;
  const verdict = classifyTerminalAction(line);
  audit.classification = verdict.cls;
  audit.observedTarget = line; // the VERBATIM line, which is what the owner reads and approves

  // 4. Single-use consent for the whole line, plus the post-consent liveness re-check.
  const stop = await approveThisAction(ctx, verdict);
  if (stop !== null) {
    audit.outcome = stop;
    return { outcome: stop };
  }

  // 6. TAINT before the write, not after. A command's output is untrusted content entering the
  //    model's context, and it enters whether or not the write later fails.
  session.taint(openDeps.now());
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.outcome = "terminated_target_lost";
    audit.stage = "done";
    return { outcome: audit.outcome };
  }

  audit.stage = "performActuation";
  audit.actuationAttempted = true;
  let result: string | null;
  try {
    // The bytes the owner approved are the bytes written: `line` was read ONCE, above, and is
    // NOT re-derived from the buffer here. Re-reading at write time would be the TOCTOU that
    // defeats the whole gate, since the human IS the boundary on this lane.
    result = await performActuation(handle, { kind: "terminal_write", text: line });
  } catch (e) {
    audit.outcome = "failed_after_approval";
    audit.laneLost = !handle.terminal.isAlive();
    return { outcome: audit.outcome, result: e instanceof Error ? e.message : String(e) };
  }
  // The replay body of a terminal action IS its output — see `cu-store.ts` on the `dom_after`
  // column name. `domBefore` stays null: there is no "before" state to snapshot on this lane.
  audit.domAfter = result;
  audit.outcome = "actuated";
  audit.stage = "done";
  return { outcome: audit.outcome, result };
}

/**
 * Step 2 of the BROWSER arm: is the target inside the envelope? REFUSED, never prompted
 * (spec § 4.2).
 *
 * Only `navigate` names a bare destination to check here — a cross-origin click is instead routed
 * through the classifier (I4) to per-action consent, since its target is a DOM element the human
 * sees described, not a bare string. Never classified (M-9): `classification` stays `null`.
 *
 * Returns true when the action was refused (and the audit state already says so).
 */
function refusedOutOfBrowserEnvelope(ctx: ActionArmContext): boolean {
  const { audit, req, session } = ctx;
  if (req.kind !== "navigate" || session.envelope.lane !== "browser") return false;
  const targetOrigin = originOf(req.url ?? "");
  if (targetOrigin !== null && session.envelope.target.navigateOrigins.includes(targetOrigin)) {
    return false;
  }
  audit.outcome = "refused_out_of_envelope";
  audit.observedTarget = `navigate -> ${targetOrigin ?? req.url ?? "unknown"}`;
  audit.stage = "done";
  return true;
}

/** The BROWSER lane's action body: envelope check, observe, classify, consent, taint, actuate. */
async function runBrowserActionArm(
  lane: Extract<CuLaneHandle, { kind: "browser" }>,
  ctx: ActionArmContext,
): Promise<RunActionOutput> {
  const { audit, req, session, openDeps } = ctx;
  const browser = lane.browser;

  // 2. Target inside the envelope? Refused, never prompted (spec § 4.2).
  if (refusedOutOfBrowserEnvelope(ctx)) return { outcome: audit.outcome };

  // 3. Classify structurally from the OBSERVED target — never from the model's description (I3
  // transplanted; § 4.3).
  audit.stage = "observe";
  const input = await buildBrowserActionInput(browser, req);
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.outcome = "terminated_target_lost";
    audit.observedTarget = `${req.kind}: target was lost while observing it`;
    audit.stage = "done";
    return { outcome: audit.outcome };
  }
  const verdict = classifyBrowserAction(input);
  audit.classification = verdict.cls;
  audit.observedTarget = describeObservedTarget(req.kind, input);

  // 4. `actuating` -> per-action HITL. Approval is single-use: this exact round-trip governs
  // only this one action, and an identical follow-up re-prompts.
  if (verdict.cls === "actuating") {
    const stop = await approveThisAction(ctx, verdict);
    if (stop !== null) {
      audit.outcome = stop;
      return { outcome: stop };
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
  audit.stage = "dom_before";
  audit.domBefore = await browser.domSnapshot();
  session.taint(openDeps.now());

  // The LAST check before the host is touched, and the one that matters most: everything above
  // is reversible bookkeeping, and everything below is not.
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.outcome = "terminated_target_lost";
    audit.stage = "done";
    return { outcome: audit.outcome };
  }

  audit.stage = "performActuation";
  audit.actuationAttempted = true;
  let result: string | null;
  try {
    result = await performActuation(lane, browserActuationInput(req));
  } catch (e) {
    // The actuation was ATTEMPTED with consent obtained (if it needed any) — this is genuinely
    // `failed_after_approval`, whatever `hitlStatus` that resolves to for this classification.
    // A click that navigates away destroys its own CDP execution context, which is the single
    // most common failure here and is NOT target loss; a browser that actually died is, and the
    // session must not stay live for a lane nothing can drive any more.
    audit.outcome = "failed_after_approval";
    audit.laneLost = !browser.isAlive();
    return { outcome: audit.outcome, result: e instanceof Error ? e.message : String(e) };
  }

  audit.stage = "dom_after";
  audit.domAfter = await browser.domSnapshot();

  // 7-8. Success: persist the final state, taint (already set above), return.
  audit.outcome = "actuated";
  audit.screenshotDigest = req.kind === "screenshot" ? result : null;
  audit.stage = "done";
  // The observation crosses back to the caller as plain text; wrapping it through
  // `wrapToolOutput`/`writeToolCallLog` happens at the `engine/agent.ts` tool-call seam
  // (Task 12+), not here — this gate has no model-facing surface of its own (spec § 5). A
  // screenshot's `result` is the BLAKE3 hex digest computed above (fix round 1, Task 12): it is
  // NOT nulled out here — a digest is not pixels, and `wrapToolOutput` is never applied to it
  // (I11 review round 1, finding 1): `cu-tools.ts`'s `browser_screenshot` tool reads it straight
  // from `result` into a non-textual return value, never through the textual envelope.
  return { outcome: audit.outcome, result };
}
